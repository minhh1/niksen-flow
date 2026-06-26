"use client";

import { useState, useEffect } from "react";
import { X, Loader2, AlertCircle } from "lucide-react";
import { updateRecord } from "@/lib/genericRecordActions";
import { ENTITY_FIELD_VALIDATORS } from "@/lib/validation/entityValidation";
import type { LogParentType } from "@/lib/logging";

export interface FieldConfig {
  id: string;
  label: string;
  type?: 'text' | 'date' | 'number' | 'checkbox' | 'select';
  options?: { value: string; label: string }[];
  fetchOptions?: () => Promise<{ value: string; label: string }[]>;
}

interface Props {
  title: string;
  table: string;
  recordId: string;
  fields: FieldConfig[];
  currentValues: Record<string, any>;
  parentType: LogParentType;
  companyId: string;
  recordLabel?: string;
  onClose: () => void;
  onSaved: () => void;
}

const VALIDATORS_BY_TABLE: Record<string, typeof ENTITY_FIELD_VALIDATORS> = {
  entities: ENTITY_FIELD_VALIDATORS,
};

export default function RecordEditModal({
  title, table, recordId, fields, currentValues,
  parentType, companyId, recordLabel, onClose, onSaved,
}: Props) {
  const [values, setValues] = useState<Record<string, any>>(
    Object.fromEntries(fields.map(f => [f.id, currentValues[f.id] ?? (f.type === 'checkbox' ? false : '')]))
  );
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [loadedOptions, setLoadedOptions] = useState<Record<string, { value: string; label: string }[]>>({});
  const [loadingOptions, setLoadingOptions] = useState<Record<string, boolean>>({});

  // Resolve any fetchOptions-based select fields once on mount.
  useEffect(() => {
    fields.forEach(f => {
      if (f.type === 'select' && f.fetchOptions) {
        setLoadingOptions(prev => ({ ...prev, [f.id]: true }));
        f.fetchOptions().then(opts => {
          setLoadedOptions(prev => ({ ...prev, [f.id]: opts }));
          setLoadingOptions(prev => ({ ...prev, [f.id]: false }));
        });
      }
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const validators = VALIDATORS_BY_TABLE[table] || {};

  const errors: Record<string, string | null> = {};
  fields.forEach(f => {
    const rule = validators[f.id];
    errors[f.id] = rule ? rule.validate(String(values[f.id] ?? '')) : null;
  });
  const hasErrors = Object.values(errors).some(e => e !== null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(Object.fromEntries(fields.map(f => [f.id, true])));
    if (hasErrors) return;

    setSaving(true);

    const changes: Record<string, any> = {};
    fields.forEach(f => {
      const original = currentValues[f.id] ?? (f.type === 'checkbox' ? false : '');
      if (String(original) !== String(values[f.id])) changes[f.id] = values[f.id];
    });

    if (Object.keys(changes).length > 0) {
      await updateRecord({
        table, id: recordId, changes,
        parentType, parentId: recordId, companyId, recordLabel,
      });
    }

    setSaving(false);
    onSaved();
  };

  return (
    <div className="fixed inset-0 z-[700] flex items-center justify-center p-6 bg-slate-900/40 backdrop-blur-md font-sans">
      <div className="bg-white w-full max-w-lg rounded-[40px] p-8 shadow-2xl">
        <div className="flex justify-between items-center mb-6">
          <h3 className="text-lg font-light uppercase tracking-wide text-slate-900">Edit {title}</h3>
          <button onClick={onClose} className="p-2 text-slate-300 hover:text-black transition-colors"><X size={18}/></button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {fields.map(field => {
            const error = touched[field.id] ? errors[field.id] : null;
            const options = field.options || loadedOptions[field.id] || [];

            return (
              <div key={field.id}>
                <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest ml-4 mb-1 block">{field.label}</label>

                {field.type === 'checkbox' ? (
                  <div className="flex items-center gap-3 px-5 py-3">
                    <input
                      type="checkbox"
                      checked={!!values[field.id]}
                      onChange={(e) => setValues(prev => ({ ...prev, [field.id]: e.target.checked }))}
                      className="w-5 h-5"
                    />
                  </div>
                ) : field.type === 'select' ? (
                  <div className="relative">
                    <select
                      value={values[field.id] ?? ''}
                      onChange={(e) => setValues(prev => ({ ...prev, [field.id]: e.target.value }))}
                      onBlur={() => setTouched(prev => ({ ...prev, [field.id]: true }))}
                      disabled={loadingOptions[field.id]}
                      className={`w-full bg-slate-50 border rounded-full py-3 px-5 text-sm font-medium outline-none focus:ring-4 transition-all appearance-none cursor-pointer ${
                        error ? 'border-red-300 focus:ring-red-100' : 'border-slate-200 focus:ring-indigo-100'
                      }`}
                    >
                      <option value="">{loadingOptions[field.id] ? 'Loading…' : 'Select…'}</option>
                      {options.map(opt => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <input
                    type={field.type === 'date' ? 'date' : field.type === 'number' ? 'number' : 'text'}
                    value={values[field.id] ?? ''}
                    onChange={(e) => setValues(prev => ({ ...prev, [field.id]: e.target.value }))}
                    onBlur={() => setTouched(prev => ({ ...prev, [field.id]: true }))}
                    className={`w-full bg-slate-50 border rounded-full py-3 px-5 text-sm font-medium outline-none focus:ring-4 transition-all ${
                      error ? 'border-red-300 focus:ring-red-100' : 'border-slate-200 focus:ring-indigo-100'
                    }`}
                  />
                )}

                {error && (
                  <p className="text-[10px] text-red-500 font-medium mt-1.5 ml-4 flex items-center gap-1">
                    <AlertCircle size={11} /> {error}
                  </p>
                )}
              </div>
            );
          })}

          <button disabled={saving || hasErrors} className="w-full py-4 bg-slate-900 text-white rounded-full font-medium text-xs uppercase tracking-widest disabled:opacity-50 flex items-center justify-center gap-2 mt-6">
            {saving ? <Loader2 size={14} className="animate-spin" /> : 'Save changes'}
          </button>
        </form>
      </div>
    </div>
  );
}