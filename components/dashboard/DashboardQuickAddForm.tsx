"use client";

import { useState } from "react";
import { Plus, Loader2 } from "lucide-react";
import FieldValueInput from "./FieldValueInput";
import { createRecord } from "@/lib/services/customTableService";
import type { CustomTableField } from "@/lib/hooks/useCustomTable";

interface Props {
  tableId: string;
  companyId: string;
  userId: string;
  fields: CustomTableField[]; // full field list -- formula fields need their dependencies
  quickAddFieldIds: string[]; // ordered subset to show
  onAdded: () => void;
  // Extra field_key -> value pairs merged into every created record, invisible
  // to the form itself -- e.g. a record-scoped dashboard tab (see
  // RecordDashboardTab.tsx) stamping the link field back to its parent record.
  fixedValues?: Record<string, any>;
}

// Live-computes every formula field's preview value from the in-progress
// form state, mirroring lib/services/customTableService.ts's
// computeFormulaFields (kept in sync manually since this is a UI preview,
// not the source of truth -- the real save always goes through that shared
// function). Walks `fields` in order and accumulates into one working map so
// a computed field that depends on *another* computed field (e.g. GST is a
// percentage of Amount, which is itself Rate x Duration) resolves correctly,
// the same way the save-time version does.
function computeAllPreviews(fields: CustomTableField[], values: Record<string, any>): Record<string, any> {
  const byId = new Map(fields.map(f => [f.id, f]));
  const result = { ...values };
  for (const field of fields) {
    // sum_related aggregates OTHER rows -- nothing to preview from this form.
    if (!field.formula_type || field.formula_type === 'sum_related' || !field.formula_field_a_id) continue;
    const fieldA = byId.get(field.formula_field_a_id);
    const a = fieldA ? Number(result[fieldA.field_key]) : NaN;
    if (Number.isNaN(a)) continue;

    if (field.formula_type === 'multiply' || field.formula_type === 'add') {
      const fieldB = field.formula_field_b_id ? byId.get(field.formula_field_b_id) : null;
      const b = fieldB ? Number(result[fieldB.field_key]) : NaN;
      if (!Number.isNaN(b)) result[field.field_key] = field.formula_type === 'add' ? a + b : a * b;
    } else {
      result[field.field_key] = a * ((field.formula_percent ?? 0) / 100);
    }
  }
  return result;
}

// Date fields default to today rather than blank -- almost every quick-add
// use case (e.g. a time entry) is logged same-day, and re-picking the date
// for every row is friction. Boolean fields default to false, matching the
// checkbox's unchecked appearance -- otherwise an intentionally-unchecked
// (not billable) box leaves the key absent from `values`, and the required-
// field check in customTableService can't tell "left blank" from "the user
// picked No", blocking a legitimate submission. Recomputed after each
// successful add so the next entry starts from these same defaults again
// instead of resetting to blank/undefined.
function getDefaultValues(quickAddFields: CustomTableField[]): Record<string, any> {
  const defaults: Record<string, any> = {};
  for (const field of quickAddFields) {
    if (field.field_type === 'date' && !field.formula_type) {
      defaults[field.field_key] = new Date().toISOString().slice(0, 10);
    } else if (field.field_type === 'boolean' && !field.formula_type) {
      defaults[field.field_key] = false;
    }
  }
  return defaults;
}

function FieldSlot({ field, value, onCommit, wide }: { field: CustomTableField; value: any; onCommit: (v: any) => void; wide?: boolean }) {
  return (
    <div className={wide ? 'w-full' : 'flex-1 min-w-[110px]'}>
      <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block mb-1 px-1">
        {field.label}{field.is_required && <span className="text-red-400 ml-1">*</span>}
      </label>
      <FieldValueInput field={field} value={value} onCommit={onCommit} />
    </div>
  );
}

export default function DashboardQuickAddForm({ tableId, companyId, userId, fields, quickAddFieldIds, onAdded, fixedValues }: Props) {
  const quickAddFields = quickAddFieldIds
    .map(id => fields.find(f => f.id === id))
    .filter((f): f is CustomTableField => !!f);

  const [values, setValues] = useState<Record<string, any>>(() => getDefaultValues(quickAddFields));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (quickAddFields.length === 0) return null;

  // Text fields (e.g. Description) get their own full-width line; number/
  // currency fields (Rate, Duration, Amount, GST...) cluster together on
  // one line since they're usually read/entered as a group; everything
  // else (relations, date, select, boolean) sits in the top row.
  const textFields = quickAddFields.filter(f => f.field_type === 'text');
  const numericFields = quickAddFields.filter(f => ['number', 'currency'].includes(f.field_type));
  const otherFields = quickAddFields.filter(f => f.field_type !== 'text' && !['number', 'currency'].includes(f.field_type));

  const handleAdd = async () => {
    // An untouched form (values still exactly the prefilled defaults --
    // today's date, false booleans) would create a record with no real
    // content; refuse before hitting the service.
    if (JSON.stringify(values) === JSON.stringify(getDefaultValues(quickAddFields))) {
      setError('Fill in the form before adding a record.');
      return;
    }
    setSaving(true);
    setError(null);
    const record = await createRecord(tableId, companyId, userId, { ...values, ...fixedValues }, fields);
    setSaving(false);
    if (record && 'error' in record) {
      // e.g. a trust-ledger overdraw refusal -- see customTableService's
      // ledgerErrorMessage; the entry was NOT saved.
      setError(record.error);
      return;
    }
    if (record) {
      setValues(getDefaultValues(quickAddFields));
      onAdded();
    }
  };

  const previews = computeAllPreviews(fields, values);
  const valueFor = (field: CustomTableField) => field.formula_type ? previews[field.field_key] ?? null : values[field.field_key];
  const commitFor = (field: CustomTableField) => (v: any) => setValues(prev => ({ ...prev, [field.field_key]: v }));

  const AddButton = (
    <button
      onClick={handleAdd}
      disabled={saving}
      className="px-5 py-2.5 bg-indigo-600 text-white rounded-full text-[11px] font-bold hover:bg-indigo-700 transition-all disabled:opacity-50 flex items-center gap-2 shrink-0"
    >
      {saving ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} Add
    </button>
  );

  return (
    <div className="flex flex-col gap-3 p-4 bg-white border border-slate-200 rounded-2xl">
      {error && (
        <div className="text-[11px] font-semibold text-rose-600 bg-rose-50 border border-rose-200 rounded-xl px-3 py-2">
          {error}
        </div>
      )}
      {otherFields.length > 0 && (
        <div className="flex flex-wrap items-end gap-3">
          {otherFields.map(field => (
            <FieldSlot key={field.id} field={field} value={valueFor(field)} onCommit={commitFor(field)} />
          ))}
          {numericFields.length === 0 && AddButton}
        </div>
      )}
      {textFields.map(field => (
        <FieldSlot key={field.id} field={field} value={valueFor(field)} onCommit={commitFor(field)} wide />
      ))}
      {numericFields.length > 0 && (
        <div className="flex flex-wrap items-end gap-3">
          {numericFields.map(field => (
            <FieldSlot key={field.id} field={field} value={valueFor(field)} onCommit={commitFor(field)} />
          ))}
          {AddButton}
        </div>
      )}
      {otherFields.length === 0 && numericFields.length === 0 && (
        <div className="flex justify-end">{AddButton}</div>
      )}
    </div>
  );
}
