// components/gmail/SearchConfigPanel.tsx
"use client";

import { useState } from "react";
import { X, Check } from "lucide-react";
import type { SearchableField } from "@/lib/gmail/types";

interface Props {
  searchFields: string[];
  availableFields: SearchableField[];
  onChange: (fields: string[]) => void;
  onClose: () => void;
}

export default function SearchConfigPanel({
  searchFields, availableFields, onChange, onClose,
}: Props) {
  const [draft, setDraft] = useState<string[]>([...searchFields]);

  const toggle = (key: string) => {
    setDraft(prev =>
      prev.includes(key)
        ? prev.length > 1 ? prev.filter(k => k !== key) : prev
        : [...prev, key]
    );
  };

  return (
    <div className="absolute top-full right-0 mt-1 bg-white border border-slate-200 rounded-2xl shadow-xl z-30 w-64 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
        <p className="text-[10px] font-bold text-slate-600 uppercase tracking-widest">
          Search by
        </p>
        <button onClick={onClose} className="p-1 text-slate-300 hover:text-slate-600">
          <X size={12} />
        </button>
      </div>

      <div className="p-2 max-h-64 overflow-y-auto">
        {availableFields.map(f => {
          const selected = draft.includes(f.key);
          return (
            <button
              key={f.key}
              onClick={() => toggle(f.key)}
              className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl text-left transition-all ${
                selected
                  ? 'bg-indigo-50 border border-indigo-100'
                  : 'hover:bg-slate-50 border border-transparent'
              }`}
            >
              <div className={`h-4 w-4 rounded border-2 flex items-center justify-center shrink-0 ${
                selected ? 'bg-indigo-600 border-indigo-600' : 'border-slate-300'
              }`}>
                {selected && <Check size={10} className="text-white" />}
              </div>
              <span className="text-[12px] font-medium text-slate-700 flex-1 truncate">
                {f.label}
              </span>
              {f.key.startsWith('cf:') && (
                <span className="text-[9px] font-bold text-violet-400 uppercase shrink-0">
                  custom
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="px-3 pb-3 pt-2 flex gap-2 border-t border-slate-50">
        <button
          onClick={onClose}
          className="flex-1 py-2 bg-slate-50 text-slate-500 rounded-full text-[10px] font-bold"
        >
          Cancel
        </button>
        <button
          onClick={() => { onChange(draft); onClose(); }}
          className="flex-1 py-2 bg-slate-900 text-white rounded-full text-[10px] font-bold"
        >
          Apply
        </button>
      </div>
    </div>
  );
}
