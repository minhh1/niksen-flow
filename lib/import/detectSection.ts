// lib/import/detectSection.ts

import type { ImportSection } from "./buildTemplate";

/**
 * Given a file's raw header line and the list of available sections,
 * returns the section whose header set best matches — or null if no
 * section matches well enough to auto-select with confidence.
 */
export function detectSectionFromHeaders(
  headerLine: string,
  sections: ImportSection[]
): { section: ImportSection; confidence: number } | null {
  const fileHeaders = new Set(
    headerLine.split(',').map(h => h.trim().toLowerCase().replace(/\s+/g, '_'))
  );

  let best: { section: ImportSection; confidence: number } | null = null;

  for (const section of sections) {
    // Child sections also expect property_street_address prepended —
    // include it in the comparison set so it counts toward the match.
    const expected = new Set(
      section.targetTable === section.key
        ? section.headers
        : ['property_street_address', ...section.headers]
    );

    const overlap = [...expected].filter(h => fileHeaders.has(h)).length;
    const confidence = overlap / expected.size;

    if (!best || confidence > best.confidence) {
      best = { section, confidence };
    }
  }

  // Require a strong majority match (at least 70% of expected headers
  // present) before auto-selecting — a weak/ambiguous match should fall
  // back to leaving the dropdown as-is rather than guessing wrong.
  if (best && best.confidence >= 0.7) return best;
  return null;
}