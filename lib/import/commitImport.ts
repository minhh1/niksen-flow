// lib/import/commitImport.ts
import { supabase } from "@/lib/supabase";
import { resolvePropertyParent, resolveEntityParent } from "@/lib/import/parentResolver";
import type { ImportSection } from "@/lib/import/buildTemplate";
import type { ParsedRow } from "@/lib/import/parseImportFile";

export type RowAction = "include" | "skip" | "update";

export interface ImportRowResult {
  id: string;
  status: "new" | "updated" | "failed" | "reversed";
  identifier: string;
  message?: string;
  details?: any;
}

interface CommitContext {
  companyId: string;
  userId: string;
  batchId: string;
  baseMode: "properties" | "entities" | "projects";
  rowUpdateTarget: Map<number, string>;
}

export async function commitBaseRow(
  row: ParsedRow, action: RowAction, ctx: CommitContext
): Promise<ImportRowResult> {
  const { companyId, userId, batchId, baseMode } = ctx;
  const obj: any = { company_id: companyId, import_id: batchId };
  let eName = ""; let eType = "";

  Object.entries(row.parsed).forEach(([header, val]) => {
    if (header === 'full_address') return;
    if (header === 'entity_name') { eName = String(val ?? ''); return; }
    if (header === 'entity_type') { eType = String(val ?? ''); if (baseMode !== 'entities') return; }
    obj[header] = val;
  });

  if (baseMode === 'properties' && eName) {
    const { data: ent } = await supabase.from("entities")
      .upsert({ name: eName, entity_type: eType || 'Company', company_id: companyId }, { onConflict: 'company_id,name' })
      .select('id').single();
    if (ent) obj.holding_entity_id = ent.id;
  }
  if (baseMode === 'entities') { obj.name = eName || obj.name; obj.entity_type = eType || obj.entity_type; }

  const linkCol = baseMode === 'properties' ? 'property_id' : baseMode === 'entities' ? 'entity_id' : 'project_id';

  if (action === 'update') {
    const targetId = ctx.rowUpdateTarget.get(row.rowIndex);
    if (!targetId) {
      return { id: '', status: "failed", identifier: obj.street_address || obj.name || `Row ${row.rowIndex}`, message: "No existing record found to update against", details: obj };
    }
    const updatePayload: Record<string, any> = {};
    Object.entries(obj).forEach(([key, value]) => {
      if (key === 'company_id' || key === 'import_id') return;
      const isEmpty = value === null || value === undefined || value === '' || (key === 'purchase_price' && value === 0);
      if (!isEmpty) updatePayload[key] = value;
    });
    if (Object.keys(updatePayload).length === 0) {
      return { id: targetId, status: "updated", identifier: obj.street_address || obj.name || `Row ${row.rowIndex}`, message: "No non-empty fields to update", details: obj };
    }
    const { data: rec, error } = await supabase.from(baseMode).update(updatePayload).eq('id', targetId).select('id').single();
    if (error) {
      return { id: targetId, status: "failed", identifier: obj.street_address || obj.name || `Row ${row.rowIndex}`, message: error.message, details: updatePayload };
    }
    await supabase.from("audit_logs").insert([{ company_id: companyId, user_id: userId, [linkCol]: rec.id, action: `bulk import updated existing record`, details: updatePayload }]);
    return { id: rec.id, status: "updated", identifier: obj.street_address || obj.name, details: updatePayload };
  }

  const { data: rec, error } = await supabase.from(baseMode).insert(obj).select('id').single();
  if (error) {
    return { id: '', status: "failed", identifier: obj.street_address || obj.name || `Row ${row.rowIndex}`, message: error.message, details: obj };
  }
  await supabase.from("audit_logs").insert([{ company_id: companyId, user_id: userId, [linkCol]: rec.id, action: `bulk imported record`, details: obj }]);
  return { id: rec.id, status: "new", identifier: obj.street_address || obj.name, details: obj };
}

export async function commitChildRow(
  row: ParsedRow, section: ImportSection, action: RowAction, ctx: CommitContext
): Promise<ImportRowResult> {
  const { companyId, userId, rowUpdateTarget } = ctx;
  const refAddress = row.parsed.property_street_address;
  const refSuburb = row.parsed.property_suburb;

  let parentId: string | null = null;
  if (section.parentKey === 'property_id') {
    const res = await resolvePropertyParent(companyId, refAddress, refSuburb);
    if (res.error || !res.id) {
      return { id: '', status: "failed", identifier: refAddress || `Row ${row.rowIndex}`, message: res.error || "Could not resolve or create parent property", details: row.parsed };
    }
    parentId = res.id;
  }

  const obj: any = { ...section.fixedValues };
  Object.entries(row.parsed).forEach(([key, val]) => {
    if (key === 'property_street_address' || key === 'property_suburb' || key === 'provider_entity_name' || key === 'provider_entity_type') return;
    obj[key] = val;
  });
  obj[section.parentKey] = parentId;

  if (row.parsed.provider_entity_name) {
    const res = await resolveEntityParent(companyId, row.parsed.provider_entity_name, row.parsed.provider_entity_type);
    if (section.targetTable === 'property_credentials') {
      obj.entity_id = res.id;
    } else {
      obj.provider_entity_id = res.id;
    }
  }

  const targetId = rowUpdateTarget.get(row.rowIndex);

  // action === 'update' only means a genuine UPDATE when a real target
  // exists. "Update" with no target happens when the parent property
  // matched but no child row exists yet for this category — per the
  // simplified UI rule, that still shows "Update" to the user, but the
  // actual operation here is an INSERT under the matched parent.
  if (action === 'update' && targetId) {
    const updatePayload: Record<string, any> = {};
    Object.entries(obj).forEach(([key, value]) => {
      if (key === section.parentKey) return; // never reassign the parent link on update
      const isEmpty = value === null || value === undefined || value === '' || (typeof value === 'number' && value === 0);
      if (!isEmpty) updatePayload[key] = value;
    });

    if (Object.keys(updatePayload).length === 0) {
      return { id: targetId, status: "updated", identifier: refAddress || `Row ${row.rowIndex}`, message: "No non-empty fields to update", details: obj };
    }

    const { data: rec, error } = await supabase.from(section.targetTable).update(updatePayload).eq('id', targetId).select('id').single();
    if (error) {
      return { id: targetId, status: "failed", identifier: refAddress || `Row ${row.rowIndex}`, message: error.message, details: updatePayload };
    }
    await supabase.from("audit_logs").insert([{
      company_id: companyId, user_id: userId, property_id: parentId,
      action: `bulk import updated ${section.title.toLowerCase()}`, details: updatePayload,
    }]);
    return { id: rec.id, status: "updated", identifier: refAddress || `Row ${row.rowIndex}`, details: updatePayload };
  }

  // action === 'include', OR action === 'update' with no real target —
  // both insert a new child row under the (possibly just-created) parent.
  const { data: rec, error } = await supabase.from(section.targetTable).insert(obj).select('id').single();
  if (error) {
    return { id: '', status: "failed", identifier: refAddress || `Row ${row.rowIndex}`, message: error.message, details: obj };
  }
  await supabase.from("audit_logs").insert([{
    company_id: companyId, user_id: userId, property_id: parentId,
    action: `bulk imported ${section.title.toLowerCase()}`, details: obj,
  }]);
  return { id: rec.id, status: "new", identifier: refAddress || `Row ${row.rowIndex}`, details: obj };
}