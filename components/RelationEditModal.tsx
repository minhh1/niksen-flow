// components/RelationEditModal.tsx
"use client";

import { useState } from "react";
import { X, Loader2 } from "lucide-react";
import type { RelationDef } from "@/lib/relationDefinitions";

interface Props {
  relation: RelationDef;
  row: any;
  onClose: () => void;
  onSave: (changes: Record<string, any>) => Promise<void>;
}

export default function RelationEditModal({ relation, row, onClose, onSave }: Props) {
  const [values, setValues] = useState<Record<string, any>>(
    Object.fromEntries(relation.columns.filter(c => !c.id.includes('.')).map(c => [c.id, row[c.id] ?? '']))
  );
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    await onSave(values);
    setSaving(false);
  };

  return (
    <div className="fixed inset-0 z-[700] flex items-center justify-center p-6 bg-slate-900/40 backdrop-blur-md font-sans">
      <div className="bg-white w-full max-w-lg rounded-[40px] p-8 shadow-2xl">
        <div className="flex justify-between items-center mb-6">
          <h3 className="text-lg font-light uppercase tracking-wide text-slate-900">Edit {relation.label}</h3>
          <button onClick={onClose} className="p-2 text-slate-300 hover:text-black transition-colors"><X size={18}/></button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {relation.columns.filter(c => !c.id.includes('.')).map(col => (
            <div key={col.id}>
              <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest ml-4 mb-1 block">{col.label}</label>
              <input
                value={values[col.id] ?? ''}
                onChange={(e) => setValues(prev => ({ ...prev, [col.id]: e.target.value }))}
                className="w-full bg-slate-50 border border-slate-200 rounded-full py-3 px-5 text-sm font-medium outline-none focus:ring-4 focus:ring-indigo-100"
              />
            </div>
          ))}

          <button disabled={saving} className="w-full py-4 bg-slate-900 text-white rounded-full font-medium text-xs uppercase tracking-widest disabled:opacity-50 flex items-center justify-center gap-2 mt-6">
            {saving ? <Loader2 size={14} className="animate-spin" /> : 'Save changes'}
          </button>
        </form>
      </div>
    </div>
  );
}