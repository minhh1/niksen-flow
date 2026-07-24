"use client";

import { useState } from "react";
import { X, Loader2, Plus } from "lucide-react";
import FieldValueInput from "./FieldValueInput";
import type { CustomTableField } from "@/lib/hooks/useCustomTable";

// Picks the fields the create prompt asks for: the table's primary field
// (or first enterable field) plus every other required field, so a record
// created here already satisfies every is_required constraint up front
// instead of being left incomplete until someone finishes it off in the
// grid. Auto-numbered and formula fields are assigned by the system, so
// they never appear here. Empty means the table has no enterable field at
// all (records for it can't be created from the master view).
export function pickCreateFields(
  fields: CustomTableField[],
  primaryFieldKey: string | null | undefined
): CustomTableField[] {
  const enterable = fields.filter(f => f.auto_number_prefix == null && !f.formula_type);
  const primary = enterable.find(f => f.field_key === primaryFieldKey) || enterable[0] || null;
  if (!primary) return [];
  const required = enterable.filter(f => f.is_required && f.id !== primary.id);
  return [primary, ...required];
}

interface Props {
  tableName: string;
  fields: CustomTableField[];
  // Returns an error message to show, or null when the record was created
  // (the caller navigates away / closes the modal on success).
  onCreate: (values: Record<string, any>) => Promise<string | null>;
  onClose: () => void;
}

// Asks for the primary field plus every other required field before
// anything is persisted, so the "New record" flows can never leave empty OR
// incomplete-required rows behind (createRecord in
// lib/services/customTableService.ts refuses valueless/invalid creates
// outright — this just surfaces that requirement up front instead of after
// a failed submit).
export default function NewRecordModal({ tableName, fields, onCreate, onClose }: Props) {
  const [values, setValues] = useState<Record<string, any>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isEmpty = (v: any) => v === null || v === undefined || v === '';
  const missingCount = fields.filter(f => isEmpty(values[f.field_key])).length;

  const handleCreate = async () => {
    if (missingCount || saving) return;
    setSaving(true);
    setError(null);
    const err = await onCreate(values);
    setSaving(false);
    if (err) setError(err);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm">
      <div className="bg-white rounded-[32px] shadow-2xl w-full max-w-sm mx-4 p-8 max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-[13px] font-bold uppercase tracking-tight text-slate-800">
            New {tableName} record
          </h2>
          <button onClick={onClose} className="p-1.5 text-slate-300 hover:text-slate-600 transition-colors">
            <X size={16} />
          </button>
        </div>
        <div className="space-y-4">
          {fields.map(field => (
            <div key={field.id}>
              <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block mb-1.5">
                {field.label}{field.is_required && <span className="text-red-400 ml-1">*</span>}
              </label>
              <FieldValueInput
                field={field}
                value={values[field.field_key] ?? null}
                onCommit={v => setValues(p => ({ ...p, [field.field_key]: v }))}
              />
            </div>
          ))}
        </div>
        {error && <p className="text-[11px] text-red-500 mt-3 px-1">{error}</p>}
        <button
          onClick={handleCreate}
          disabled={!!missingCount || saving}
          className="w-full mt-6 py-3 bg-slate-900 text-white rounded-full text-[11px] font-bold disabled:opacity-40 flex items-center justify-center gap-2 hover:bg-slate-700 transition-colors"
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
          Create
        </button>
      </div>
    </div>
  );
}
