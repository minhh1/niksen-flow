import { supabase } from "@/lib/supabase";
import type { CustomTableField } from "@/lib/hooks/useCustomTable";
import { getValueColumn } from "@/lib/schema/fieldCapabilities";

// Ledger guard violations arrive as raw Postgres exception messages (see
// supabase/company_table_ledger.sql); translate the coded prefixes into
// something the grid/quick-add UI can show the user directly.
function ledgerErrorMessage(raw: string): string | null {
  if (raw.includes('LEDGER_OVERDRAW')) {
    return "This withdrawal would overdraw the matter's trust ledger — a trust ledger can never go into deficit. Check the matter's balance and the amount.";
  }
  if (raw.includes('LEDGER_APPEND_ONLY') || raw.includes('LEDGER_RPC_ONLY')) {
    return "Trust ledger entries are append-only and can't be edited or deleted — enter a reversing journal entry instead.";
  }
  if (raw.includes('LEDGER_NEGATIVE_AMOUNT')) {
    return "Ledger amounts must be entered as positive values — use Amount In for money received and Amount Out for money paid.";
  }
  return null;
}

async function isLedgerTable(tableId: string): Promise<boolean> {
  const { data } = await supabase.from('company_tables').select('is_ledger').eq('id', tableId).maybeSingle();
  return !!data?.is_ledger;
}

function isEmptyValue(v: any): boolean {
  if (Array.isArray(v)) return v.length === 0; // allow_multiple relation fields
  return v === undefined || v === null || v === '';
}

// Two-step alive-check, matching the pattern already used in
// recomputeRelatedRollups: look up which OTHER records currently hold this
// field/value pair, then confirm at least one of them is still live
// (soft-deleted rows never count as a conflict).
async function findConflictingUniqueValue(
  fieldId: string, valueCol: string, value: any, excludeRecordId: string | null
): Promise<boolean> {
  const { data: valueRows } = await supabase
    .from('company_table_values')
    .select('record_id')
    .eq('field_id', fieldId)
    .eq(valueCol, value);
  const candidateIds = (valueRows || []).map(r => r.record_id).filter(id => id !== excludeRecordId);
  if (!candidateIds.length) return false;
  const { data: alive } = await supabase
    .from('company_table_records')
    .select('id')
    .in('id', candidateIds)
    .is('deleted_at', null);
  return (alive || []).length > 0;
}

// Validates is_required/is_unique against the values a write is about to
// persist -- previously these flags were only ever read by the schema
// editor UI and never actually enforced at save time (a record could be
// created with a "required" field left blank, or two records could share
// the same "unique" field value, with no error). `touchedKeys` restricts
// the check to fields THIS write actually sets: null means check every
// field (create, where the whole record is new); on update, only fields
// present in this edit (plus any formula field recomputed alongside it) are
// re-validated, so editing one field on a record that already has
// unrelated legacy-incomplete data doesn't retroactively get blocked.
// Auto-numbered and rollup (sum_related) fields are exempt from the
// required check specifically -- both are populated automatically after
// this function runs, not by the caller, so they'd otherwise always look
// incorrectly "empty" here.
async function validateFieldConstraints(
  fields: CustomTableField[], finalValues: Record<string, any>,
  excludeRecordId: string | null, touchedKeys: Set<string> | null
): Promise<string | null> {
  for (const field of fields) {
    if (!field.is_required || field.auto_number_prefix != null || field.formula_type === 'sum_related') continue;
    if (touchedKeys && !touchedKeys.has(field.field_key)) continue;
    if (isEmptyValue(finalValues[field.field_key])) return `"${field.label}" is required.`;
  }
  for (const field of fields) {
    if (!field.is_unique) continue;
    if (touchedKeys && !touchedKeys.has(field.field_key)) continue;
    const value = finalValues[field.field_key];
    if (isEmptyValue(value)) continue;
    const hasConflict = await findConflictingUniqueValue(field.id, getValueColumn(field.field_type), value, excludeRecordId);
    if (hasConflict) return `"${field.label}" must be unique — this value is already used on another record.`;
  }
  return null;
}

export async function createRecord(
  tableId: string,
  companyId: string,
  userId: string,
  values: Record<string, any>,
  fields: CustomTableField[]
): Promise<{ id: string } | { error: string } | null> {
  // Ledger tables (see supabase/company_table_ledger.sql) can only be
  // written through insert_ledger_record -- it assigns the consecutive
  // receipt number, computes the matter's running balance and refuses
  // overdraws atomically. A direct insert would be rejected by trigger.
  if (await isLedgerTable(tableId)) {
    const payload: Record<string, any> = {};
    for (const field of fields) {
      const v = values[field.field_key];
      if (v !== undefined && v !== null && v !== '') payload[field.field_key] = v;
    }
    if (!Object.keys(payload).length) {
      return { error: 'Ledger entries cannot be created empty — fill in the entry details and add it in one step.' };
    }
    const { data, error } = await supabase.rpc('insert_ledger_record', { p_table_id: tableId, p_values: payload });
    if (error) {
      console.error('createRecord(ledger):', error);
      return { error: ledgerErrorMessage(error.message) || error.message };
    }
    return { id: data.id };
  }

  // Refuse valueless creates outright -- every "new record" surface (the
  // NewRecordModal prompt, quick-add forms, grid draft rows, AI actions)
  // must supply at least one real value. Auto-number and formula fields
  // don't count: both are derived, so they'd make an otherwise-empty
  // record look filled.
  const hasContent = fields.some(f =>
    f.auto_number_prefix == null && !f.formula_type && !isEmptyValue(values[f.field_key])
  );
  if (!hasContent) {
    return { error: 'Fill in at least one field before creating a record.' };
  }

  // Validate before assigning an auto-number or inserting the record row --
  // a failed validation shouldn't consume a sequence number or leave an
  // empty record behind. Checked against the formula-computed preview (not
  // raw `values`) so a required field that's actually a computed field
  // isn't flagged just because the user didn't type it directly.
  const preview = fields.some(f => f.formula_type) ? computeFormulaFields(fields, values) : values;
  const validationError = await validateFieldConstraints(fields, preview, null, null);
  if (validationError) return { error: validationError };

  // Auto-numbered fields (e.g. invoice numbers) are assigned server-side so
  // the sequence stays consecutive under concurrent writers -- see
  // supabase/company_table_field_sequences.sql.
  const withNumbers = { ...values };
  for (const field of fields) {
    // != null, not truthiness: '' is a valid prefix (bare numbers, e.g. lead numbers)
    if (field.auto_number_prefix != null && !withNumbers[field.field_key]) {
      const { data: num } = await supabase.rpc('next_field_sequence', { p_field_id: field.id });
      if (num) withNumbers[field.field_key] = num;
    }
  }

  const { data: record, error } = await supabase
    .from('company_table_records')
    .insert({ table_id: tableId, company_id: companyId, created_by: userId })
    .select('id')
    .single();

  if (error || !record) { console.error('createRecord:', error); return null; }

  const toSave = fields.some(f => f.formula_type) ? computeFormulaFields(fields, withNumbers) : withNumbers;

  // Authoritative uniqueness check: validateFieldConstraints's pre-check
  // above is optimistic (read, then decide) and races under concurrent
  // writers -- confirmed in testing, 8 parallel creates for the same
  // is_unique value all passed it. claimAllUniqueValues is atomic at the
  // DB level (see supabase/company_table_unique_locks.sql) and is the real
  // guarantee; the pre-check just avoids paying for this insert+rollback in
  // the common case where a value is obviously already taken.
  const uniqueError = await claimAllUniqueValues(fields, record.id, toSave, null);
  if (uniqueError) {
    await supabase.from('company_table_records').delete().eq('id', record.id);
    return { error: uniqueError };
  }

  const { error: valueError } = await saveValues(record.id, tableId, companyId, toSave, fields);
  if (valueError) {
    console.error('createRecord values:', valueError);
    // The record row exists but its field values failed to save -- a
    // caller (and the UI) treats a non-error return as "fully saved", so a
    // silent partial write would be worse than rolling the whole thing
    // back. Confirmed in testing: this was previously discarded entirely,
    // producing a record with no data and no indication anything went wrong.
    await supabase.from('company_table_records').delete().eq('id', record.id);
    return { error: ledgerErrorMessage(valueError.message) || 'Could not save this entry — please try again.' };
  }

  await recomputeRelatedRollups(companyId, fields, relationTouches(fields, toSave));
  return record;
}

export async function updateRecord(
  recordId: string,
  tableId: string,
  companyId: string,
  values: Record<string, any>,
  fields: CustomTableField[]
): Promise<{ error: string } | void> {
  const hasFormulas = fields.some(f => f.formula_type);
  const hasRelations = fields.some(f => f.field_type === 'table_relation');
  const hasConstraints = fields.some(f => f.is_required || f.is_unique);

  // Pull current values up front when needed: formula recomputes must merge
  // the incoming edit over the full row, rollup recomputes must also
  // refresh the OLD parent when a relation link is being moved/cleared, and
  // required/unique validation needs the full post-edit picture (a field
  // not touched by this edit still counts toward "is the record valid now").
  let current: Record<string, any> = {};
  if (hasFormulas || hasRelations || hasConstraints) {
    current = await getCurrentValues(recordId, fields);
  }

  let toSave = values;
  const touchedKeys = new Set(Object.keys(values));
  if (hasFormulas) {
    // Computed fields (e.g. Amount = Rate x Duration) must recompute correctly
    // even when this update only touches one dependency (e.g. an inline grid
    // edit to Duration alone) -- so merge the incoming edit on top of the
    // record's current values before evaluating formulas.
    const merged = { ...current, ...values };
    const computed = computeFormulaFields(fields, merged);
    toSave = { ...values };
    for (const field of fields) {
      if (field.formula_type && field.formula_type !== 'sum_related') {
        toSave[field.field_key] = computed[field.field_key];
        touchedKeys.add(field.field_key);
      }
    }
  }

  let finalValues: Record<string, any> = {};
  if (hasConstraints) {
    // Validate before touching the record row at all -- only re-checks
    // fields this edit actually changes (see validateFieldConstraints),
    // so resaving a record that already has unrelated legacy-incomplete
    // data doesn't retroactively get blocked.
    finalValues = { ...current, ...toSave };
    const validationError = await validateFieldConstraints(fields, finalValues, recordId, touchedKeys);
    if (validationError) return { error: validationError };

    // Authoritative uniqueness check -- see createRecord's identical
    // comment; validateFieldConstraints's check above is optimistic and
    // races under concurrent writers, this is the real guarantee.
    const uniqueError = await claimAllUniqueValues(fields, recordId, finalValues, touchedKeys);
    if (uniqueError) return { error: uniqueError };
  }

  const { error } = await supabase
    .from('company_table_records')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', recordId);
  if (error) {
    const msg = ledgerErrorMessage(error.message);
    if (msg) return { error: msg };
    console.error('updateRecord:', error);
  }

  const { error: valueError } = await saveValues(recordId, tableId, companyId, toSave, fields);
  if (valueError) {
    const msg = ledgerErrorMessage(valueError.message);
    if (msg) return { error: msg };
    console.error('updateRecord values:', valueError);
  }

  // A unique field whose value actually changed leaves its OLD value's lock
  // row still pointing at this record -- release it so that old value can
  // be claimed by someone else. Best-effort: a failure here doesn't fail
  // the edit, it just means the old value stays squatted (harmless, if rare).
  for (const field of fields) {
    if (!field.is_unique || !touchedKeys.has(field.field_key)) continue;
    const oldValue = current[field.field_key];
    const newValue = finalValues[field.field_key];
    if (!isEmptyValue(oldValue) && String(oldValue) !== String(newValue)) {
      await releaseUniqueValue(field.id, recordId, oldValue);
    }
  }

  await recomputeRelatedRollups(companyId, fields, [
    ...relationTouches(fields, current),
    ...relationTouches(fields, { ...current, ...toSave }),
  ]);
}

// Evaluates every formula-marked field in `fields` against `values` (a
// field_key -> value map), returning values with computed fields added/
// overwritten. sum_related is skipped here: it aggregates OTHER rows, so
// it's recomputed by recomputeRelatedRollups() whenever a related row
// changes -- see the supported formula_types in
// supabase/company_table_fields_formula.sql and _formula_extend.sql.
function computeFormulaFields(fields: CustomTableField[], values: Record<string, any>): Record<string, any> {
  const byId = new Map(fields.map(f => [f.id, f]));
  const result = { ...values };
  for (const field of fields) {
    if (!field.formula_type || field.formula_type === 'sum_related') continue;
    // Formula fields are always derived, never hand-entered (the UI renders
    // them read-only) -- clear whatever was passed in `values` up front so
    // an incomplete/invalid dependency resolves to null. Previously this
    // `continue`'d straight past a field with a missing dependency, leaving
    // it holding its raw input value untouched -- confirmed exploitable in
    // testing: a caller could set an arbitrary Amount when Duration was
    // blank, and it would save as-is instead of being blanked or rejected.
    result[field.field_key] = null;
    const fieldA = field.formula_field_a_id ? byId.get(field.formula_field_a_id) : null;
    const a = fieldA ? Number(result[fieldA.field_key]) : NaN;
    if (Number.isNaN(a)) continue;

    if (field.formula_type === 'multiply' || field.formula_type === 'add') {
      const fieldB = field.formula_field_b_id ? byId.get(field.formula_field_b_id) : null;
      const b = fieldB ? Number(result[fieldB.field_key]) : NaN;
      if (!Number.isNaN(b)) result[field.field_key] = field.formula_type === 'add' ? a + b : a * b;
    } else if (field.formula_type === 'percentage_of') {
      result[field.field_key] = a * ((field.formula_percent ?? 0) / 100);
    }
  }
  return result;
}

// Atomically claims `value` for `field` on `record` -- see
// supabase/company_table_unique_locks.sql. Returns true if claimed (either
// freshly, or it already belonged to this record), false if a different,
// still-live record holds it.
async function claimUniqueValue(fieldId: string, recordId: string, value: any): Promise<boolean> {
  const { data, error } = await supabase.rpc('claim_unique_value', { p_field_id: fieldId, p_record_id: recordId, p_value: String(value) });
  if (error) { console.error('claimUniqueValue:', error); return false; }
  return !!data;
}

async function releaseUniqueValue(fieldId: string, recordId: string, value: any): Promise<void> {
  const { error } = await supabase.rpc('release_unique_value', { p_field_id: fieldId, p_record_id: recordId, p_value: String(value) });
  if (error) console.error('releaseUniqueValue:', error);
}

// Atomically claims every is_unique field's value in `finalValues` for
// `recordId`. On the first failure, releases every lock already claimed by
// this same call (so a record that fails on its 2nd unique field doesn't
// end up squatting on its 1st) and returns the offending field's label.
async function claimAllUniqueValues(
  fields: CustomTableField[], recordId: string, finalValues: Record<string, any>, touchedKeys: Set<string> | null
): Promise<string | null> {
  const claimed: { fieldId: string; value: any }[] = [];
  for (const field of fields) {
    if (!field.is_unique) continue;
    if (touchedKeys && !touchedKeys.has(field.field_key)) continue;
    const value = finalValues[field.field_key];
    if (isEmptyValue(value)) continue;
    const ok = await claimUniqueValue(field.id, recordId, value);
    if (!ok) {
      await Promise.all(claimed.map(c => releaseUniqueValue(c.fieldId, recordId, c.value)));
      return `"${field.label}" must be unique — this value is already used on another record.`;
    }
    claimed.push({ fieldId: field.id, value });
  }
  return null;
}

// (relationFieldId, parentRecordId) pairs present in a value map -- the
// parents whose sum_related rollups a change to this row can affect. A
// multi-relation field can touch several parents from one row (one pair per
// linked id) instead of at most one.
function relationTouches(fields: CustomTableField[], values: Record<string, any>): { relationFieldId: string; parentId: string }[] {
  const touches: { relationFieldId: string; parentId: string }[] = [];
  for (const f of fields) {
    if (f.field_type !== 'table_relation') continue;
    const v = values[f.field_key];
    if (Array.isArray(v)) {
      for (const id of v) if (id) touches.push({ relationFieldId: f.id, parentId: String(id) });
    } else if (v) {
      touches.push({ relationFieldId: f.id, parentId: String(v) });
    }
  }
  return touches;
}

// Recomputes sum_related rollup fields (e.g. Invoice Fees = sum of linked
// Time & Fee Entries' Amount) on every parent record a change touched, then
// re-evaluates the parent's own downstream formulas (Subtotal -> GST ->
// Total) against the fresh sums.
async function recomputeRelatedRollups(
  companyId: string,
  childFields: CustomTableField[],
  touches: { relationFieldId: string; parentId: string }[]
): Promise<void> {
  const relFieldIds = [...new Set(touches.map(t => t.relationFieldId))];
  if (!relFieldIds.length) return;

  const { data: rollupFields } = await supabase
    .from('company_table_fields')
    .select('*')
    .eq('formula_type', 'sum_related')
    .in('formula_relation_field_id', relFieldIds)
    .is('deleted_at', null);
  if (!rollupFields?.length) return;

  const parentTableIds = [...new Set(rollupFields.map(rf => rf.table_id))];
  const parentFieldsByTable = new Map<string, CustomTableField[]>();
  for (const parentTableId of parentTableIds) {
    const { data } = await supabase
      .from('company_table_fields')
      .select('*')
      .eq('table_id', parentTableId)
      .is('deleted_at', null)
      .order('display_order');
    parentFieldsByTable.set(parentTableId, (data || []) as CustomTableField[]);
  }

  // parent record -> its recomputed rollup sums
  const parentUpdates = new Map<string, { tableId: string; sums: Record<string, number> }>();
  for (const rf of rollupFields) {
    const parentIds = [...new Set(touches.filter(t => t.relationFieldId === rf.formula_relation_field_id).map(t => t.parentId))];
    for (const parentId of parentIds) {
      // Queries both stores rather than checking the relation field's own
      // allow_multiple first -- a non-multi field never has rows in
      // company_table_value_links and a multi field never has rows in
      // company_table_values for it, so this is correct either way without
      // an extra lookup to find out which.
      const [{ data: scalarLinks }, { data: multiLinks }] = await Promise.all([
        supabase.from('company_table_values').select('record_id')
          .eq('field_id', rf.formula_relation_field_id).eq('value_record_id', parentId),
        supabase.from('company_table_value_links').select('record_id')
          .eq('field_id', rf.formula_relation_field_id).eq('value_record_id', parentId),
      ]);
      const childIds = [...new Set([...(scalarLinks || []), ...(multiLinks || [])].map(l => l.record_id))];

      let sum = 0;
      if (childIds.length) {
        const { data: alive } = await supabase
          .from('company_table_records')
          .select('id')
          .in('id', childIds)
          .is('deleted_at', null);
        const aliveIds = (alive || []).map(r => r.id);
        if (aliveIds.length) {
          const { data: vals } = await supabase
            .from('company_table_values')
            .select('value_number')
            .eq('field_id', rf.formula_field_a_id)
            .in('record_id', aliveIds);
          sum = (vals || []).reduce((s, v) => s + (Number(v.value_number) || 0), 0);
        }
      }

      const entry = parentUpdates.get(parentId) || { tableId: rf.table_id, sums: {} as Record<string, number> };
      entry.sums[rf.field_key] = sum;
      parentUpdates.set(parentId, entry);
    }
  }

  for (const [parentId, { tableId, sums }] of parentUpdates) {
    const parentFields = parentFieldsByTable.get(tableId) || [];
    const current = await getCurrentValues(parentId, parentFields);
    const computed = computeFormulaFields(parentFields, { ...current, ...sums });
    const toSave: Record<string, any> = { ...sums };
    for (const pf of parentFields) {
      if (pf.formula_type && pf.formula_type !== 'sum_related' && computed[pf.field_key] !== undefined) {
        toSave[pf.field_key] = computed[pf.field_key];
      }
    }
    await saveValues(parentId, tableId, companyId, toSave, parentFields);
  }
}

async function getCurrentValues(recordId: string, fields: CustomTableField[]): Promise<Record<string, any>> {
  const { data } = await supabase
    .from('company_table_values')
    .select('field_id, value_text, value_number, value_date, value_boolean, value_record_id')
    .eq('record_id', recordId);

  const fieldKeyById = new Map(fields.map(f => [f.id, f.field_key]));
  const result: Record<string, any> = {};
  (data || []).forEach(v => {
    const key = fieldKeyById.get(v.field_id);
    if (!key) return;
    result[key] = v.value_text ?? v.value_number ?? v.value_date ?? v.value_boolean ?? v.value_record_id ?? null;
  });

  // allow_multiple fields hold their links in a separate junction table --
  // without this, their "current" value would always look empty (nothing
  // for them is ever written to company_table_values), so a change that
  // REMOVES a link would never see the old parent as touched, and its
  // rollup would go stale. See relationTouches, which this feeds.
  const multiFields = fields.filter(f => f.allow_multiple);
  if (multiFields.length) {
    const { data: links } = await supabase
      .from('company_table_value_links')
      .select('field_id, value_record_id')
      .eq('record_id', recordId)
      .in('field_id', multiFields.map(f => f.id));
    for (const field of multiFields) result[field.field_key] = [];
    (links || []).forEach(l => {
      const key = fieldKeyById.get(l.field_id);
      if (key) result[key].push(l.value_record_id);
    });
  }

  return result;
}

export async function deleteRecord(recordId: string): Promise<{ error: string } | void> {
  // Look the record up first: rollup parents need refreshing after the row
  // disappears, and the values are gone from view once it's soft-deleted.
  const { data: record } = await supabase
    .from('company_table_records')
    .select('table_id, company_id')
    .eq('id', recordId)
    .maybeSingle();

  let fields: CustomTableField[] = [];
  let touches: { relationFieldId: string; parentId: string }[] = [];
  if (record) {
    const { data } = await supabase
      .from('company_table_fields')
      .select('*')
      .eq('table_id', record.table_id)
      .is('deleted_at', null);
    fields = (data || []) as CustomTableField[];
    if (fields.some(f => f.field_type === 'table_relation')) {
      touches = relationTouches(fields, await getCurrentValues(recordId, fields));
    }
  }

  const { error } = await supabase
    .from('company_table_records')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', recordId);
  if (error) {
    const msg = ledgerErrorMessage(error.message);
    if (msg) return { error: msg };
    console.error('deleteRecord:', error);
    return;
  }

  if (record) await recomputeRelatedRollups(record.company_id, fields, touches);
}

async function saveValues(
  recordId: string,
  tableId: string,
  companyId: string,
  values: Record<string, any>,
  fields: CustomTableField[]
): Promise<{ error: { message: string } | null }> {
    const fieldMap = new Map(fields.map(f => [f.field_key, f]));
    // allow_multiple fields hold a string[] of linked record ids -- they
    // can't go through the single-value_record_id upsert below, so they're
    // routed to company_table_value_links instead (see
    // supabase/company_table_field_allow_multiple.sql).
    const multiWrites: { field: CustomTableField; ids: string[] }[] = [];
    const upserts = Object.entries(values)
    .map(([key, value]) => {
        const field = fieldMap.get(key);
        if (!field) return null;
        if (field.allow_multiple) {
          if (Array.isArray(value)) multiWrites.push({ field, ids: value.filter(Boolean) });
          return null;
        }
        if (value === undefined || value === null || value === '') return null;
        const valueCol = getValueColumn(field.field_type);
        return {
        company_id: companyId,
        table_id: tableId,
        record_id: recordId,
        field_id: field.id,
        [valueCol]: value,
        };
    })
    .filter((u): u is NonNullable<typeof u> => u !== null);

  if (upserts.length) {
    const { error } = await supabase
      .from('company_table_values')
      .upsert(upserts, { onConflict: 'record_id,field_id' });
    if (error) return { error };
  }

  for (const { field, ids } of multiWrites) {
    // Replace-all (delete then insert) -- a multi-relation's link set is a
    // handful of records, not thousands, so diffing old vs new for a
    // minimal patch isn't worth the extra round-trip this avoids.
    const { error: delErr } = await supabase
      .from('company_table_value_links')
      .delete()
      .eq('record_id', recordId)
      .eq('field_id', field.id);
    if (delErr) return { error: delErr };
    if (ids.length) {
      const { error: insErr } = await supabase
        .from('company_table_value_links')
        .insert(ids.map(id => ({ company_id: companyId, record_id: recordId, field_id: field.id, value_record_id: id })));
      if (insErr) return { error: insErr };
    }
  }

  return { error: null };
}
