// components/gmail/LabelConflictModal.tsx
"use client";

import { AlertTriangle, X } from "lucide-react";

interface Props {
  existingLabel: string;
  proposedLabel: string;
  onReplace: () => void;    // remove existing + apply new
  onAddBoth: () => void;    // keep existing + add new
  onCancel: () => void;
}

export default function LabelConflictModal({
  existingLabel, proposedLabel, onReplace, onAddBoth, onCancel,
}: Props) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-md p-6">
      <div className="bg-white rounded-[40px] p-8 w-full max-w-md shadow-2xl">
        <div className="flex items-start gap-4 mb-5">
          <div className="h-10 w-10 rounded-2xl bg-amber-50 flex items-center justify-center shrink-0">
            <AlertTriangle size={20} className="text-amber-500" />
          </div>
          <div>
            <h3 className="text-[15px] font-bold text-slate-900 mb-1">
              Duplicate label detected
            </h3>
            <p className="text-[12px] text-slate-500 leading-relaxed">
              This email already has a project label applied.
            </p>
          </div>
          <button onClick={onCancel} className="p-1 text-slate-300 hover:text-black ml-auto shrink-0">
            <X size={16} />
          </button>
        </div>

        <div className="space-y-3 mb-6">
          <div className="p-3 bg-red-50 border border-red-100 rounded-2xl">
            <p className="text-[9px] font-bold text-red-400 uppercase tracking-widest mb-1">
              Existing label
            </p>
            <p className="text-[12px] font-bold text-red-700 font-mono">
              {existingLabel}
            </p>
          </div>
          <div className="p-3 bg-indigo-50 border border-indigo-100 rounded-2xl">
            <p className="text-[9px] font-bold text-indigo-400 uppercase tracking-widest mb-1">
              Proposed label
            </p>
            <p className="text-[12px] font-bold text-indigo-700 font-mono">
              {proposedLabel}
            </p>
          </div>
        </div>

        <div className="space-y-2">
          <button
            onClick={onReplace}
            className="w-full py-3 bg-slate-900 text-white rounded-full text-[11px] font-bold hover:bg-black transition-all"
          >
            Replace existing label with new one
          </button>
          <button
            onClick={onAddBoth}
            className="w-full py-3 bg-slate-50 text-slate-700 border border-slate-200 rounded-full text-[11px] font-bold hover:bg-slate-100 transition-all"
          >
            Keep both labels
          </button>
          <button
            onClick={onCancel}
            className="w-full py-3 text-slate-400 rounded-full text-[11px] font-bold hover:text-slate-600 transition-all"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}