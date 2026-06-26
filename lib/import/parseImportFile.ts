export interface ParsedRow {
  rowIndex: number;
  raw: Record<string, string>;
  parsed: Record<string, any>;
}

export interface ParseFileOptions {
  baseMode: "properties" | "entities" | "projects";
  sectionIsBase: boolean;
}

// --- ADDRESS PARSER ---
export function parseAUAddress(fullStr: string) {
  const res = { street_address: fullStr, suburb: "", state: "NSW", postcode: "" };
  if (!fullStr) return res;
  const ids = ["Street", "St", "Drive", "Dr", "Road", "Rd", "Avenue", "Ave", "Crescent", "Cres", "Parade", "Pde", "Close", "Cl", "Place", "Pl", "Court", "Ct", "Lane", "Ln"];
  try {
    const clean = fullStr.replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
    const words = clean.split(' ');
    let splitIdx = -1;
    for (let i = 0; i < words.length; i++) {
      if (ids.some(id => id.toLowerCase() === words[i].toLowerCase())) { splitIdx = i; break; }
    }
    if (splitIdx !== -1) {
      res.street_address = words.slice(0, splitIdx + 1).join(' ');
      const remainder = words.slice(splitIdx + 1);
      if (remainder.length > 0 && /^\d{4}$/.test(remainder[remainder.length - 1])) res.postcode = remainder.pop() || "";
      if (remainder.length > 0 && remainder[remainder.length - 1].length <= 3) res.state = remainder.pop()?.toUpperCase() || "NSW";
      res.suburb = remainder.join(' ');
    }
  } catch (e) { console.error("Address parse logic failed"); }
  return res;
}

// --- POSITIONAL CSV SPLITTER ---
export function splitCSVLine(text: string): string[] {
  const result: string[] = [];
  let cur = ""; let inQuotes = false;
  for (const char of text) {
    if (char === '"') inQuotes = !inQuotes;
    else if (char === ',' && !inQuotes) { result.push(cur.trim()); cur = ""; }
    else cur += char;
  }
  result.push(cur.trim());
  return result;
}

// --- DD/MM/YYYY-SAFE DATE PARSER ---
export function parseAUDate(val: string): string | null {
  const v = (val || '').trim();
  if (!v) return null;
  const iso = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return v;
  const dmy = v.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (dmy) {
    let [, d, m, y] = dmy;
    if (y.length === 2) y = `20${y}`;
    const day = d.padStart(2, '0'); const month = m.padStart(2, '0');
    if (Number(month) > 12) return null;
    return `${y}-${month}-${day}`;
  }
  return null;
}

/**
 * Parses raw CSV text into rows, applying all field-level transforms
 * (address splitting, date normalization, price cleanup, booleans).
 * Pure function — no React, no Supabase — so it can be unit tested or
 * debugged standalone (e.g. via a quick node script) without spinning up
 * the whole app, the way we had to do manually mid-session to verify
 * parseAUAddress was actually correct.
 */
export function parseImportFile(text: string, options: ParseFileOptions): { headers: string[]; rows: ParsedRow[] } {
  const lines = text.replace(/\r/g, '').split('\n').filter(r => r.trim());
  if (lines.length < 2) return { headers: [], rows: [] };

  const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/\s+/g, '_'));
  const { baseMode, sectionIsBase } = options;

  const rows: ParsedRow[] = lines.slice(1).map((line, idx) => {
    const values = splitCSVLine(line);
    const raw: Record<string, string> = {};
    headers.forEach((h, i) => { raw[h] = values[i] ?? ''; });
    const row: Record<string, any> = {};

    headers.forEach((header) => {
      const val = raw[header];
      if (header === 'full_address' && baseMode === 'properties' && sectionIsBase) {
        Object.assign(row, parseAUAddress(val));
      } else if (header === 'property_street_address' && !sectionIsBase) {
        const addr = parseAUAddress(val);
        row.property_street_address = addr.street_address;
        row.property_suburb = addr.suburb;
      } else if (header === 'purchase_price' || header === 'amount' || header === 'expected_amount') {
        row[header] = parseFloat(val.replace(/[$,\s]/g, '')) || 0;
      } else if (header.includes('date') || header.includes('expiry') || header === 'paid_up_to') {
        row[header] = parseAUDate(val);
      } else if (header === 'is_paid' || header === 'gst_registered') {
        row[header] = ['true', 'yes', '1'].includes(val.toLowerCase());
      } else {
        row[header] = val || null;
      }
    });

    return { rowIndex: idx + 1, raw, parsed: row };
  });

  return { headers, rows };
}