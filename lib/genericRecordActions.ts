import { supabase } from "@/lib/supabase";
import { logActivity, type LogParentType } from "@/lib/logging";

interface UpdateRecordParams {
  table: string;
  id: string;
  changes: Record<string, any>;
  parentType: LogParentType;
  parentId: string;
  companyId: string;
  recordLabel?: string; // human-readable identifier for the log message, e.g. the street address
}

/**
 * Updates a single record on any table, and logs exactly what changed
 * (old value -> new value, per field) to the resolved parent's activity
 * log. This is the one path every "edit" action in the app should use.
 */
export async function updateRecord({ table, id, changes, parentType, parentId, companyId, recordLabel }: UpdateRecordParams) {
  // Fetch current values first so the log can show old -> new, not just new.
  const fieldNames = Object.keys(changes);
  const { data: before } = await supabase.from(table).select(fieldNames.join(',')).eq('id', id).single();

  const { error } = await supabase.from(table).update(changes).eq('id', id);
  if (error) return { error };

  const changeSummary = fieldNames.map(f => ({
    field: f,
    old: (before as any)?.[f] ?? null,
    new: changes[f],
  }));

  await logActivity({
    parentType, parentId, companyId,
    action: `updated ${recordLabel ? recordLabel + ' — ' : ''}${fieldNames.join(', ').replace(/_/g, ' ')}`,
    details: { table, recordId: id, changes: changeSummary },
  });

  return { error: null };
}

interface SoftDeleteParams {
  table: string;
  id: string;
  parentType: LogParentType;
  parentId: string;
  companyId: string;
  recordLabel?: string;
}

/**
 * Soft-deletes a single record (sets deleted_at) on any table that has
 * that column, and logs the deletion. Always soft delete — never a real
 * DELETE — consistent with the rule established earlier in this project.
 */
export async function softDeleteRecord({ table, id, parentType, parentId, companyId, recordLabel }: SoftDeleteParams) {
  const { error } = await supabase.from(table).update({ deleted_at: new Date().toISOString() }).eq('id', id);
  if (error) return { error };

  await logActivity({
    parentType, parentId, companyId,
    action: `archived${recordLabel ? ' ' + recordLabel : ''}`,
    details: { table, recordId: id },
  });

  return { error: null };
}