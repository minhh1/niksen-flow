"use client";

import { ChevronDown, Loader2 } from "lucide-react";
import type { ImportSection } from "@/lib/import/buildTemplate";

interface Props {
  baseMode: "properties" | "entities" | "projects";
  onBaseModeChange: (mode: "properties" | "entities" | "projects") => void;
  sections: ImportSection[];
  sectionKey: string;
  onSectionChange: (key: string) => void;
  currentSection?: ImportSection;
  isBaseSection: boolean;
  loadingSections: boolean;
  detectedNotice: string | null;
}

export default function SectionPicker({
  baseMode, onBaseModeChange, sections, sectionKey, onSectionChange,
  currentSection, isBaseSection, loadingSections, detectedNotice,
}: Props) {
  return (
    <>
      <div className="flex bg-slate-50 p-1 rounded-2xl border border-slate-100">
        {(['projects', 'properties', 'entities'] as const).map((t) => (
          <button key={t} onClick={() => onBaseModeChange(t)} className={`flex-1 py-3 rounded-xl text-xs font-medium capitalize transition-all ${baseMode === t ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-400'}`}>{t}</button>
        ))}
      </div>

      {loadingSections ? (
        <div className="flex items-center gap-2 text-slate-400 text-[12px] py-4"><Loader2 size={14} className="animate-spin" /> Loading sections...</div>
      ) : (
        <div className="p-6 bg-slate-50 border border-slate-100 rounded-[32px] space-y-3">
          <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Which section are you importing?</p>
          <div className="relative">
            <select
              value={sectionKey}
              onChange={(e) => onSectionChange(e.target.value)}
              className="w-full bg-white border border-slate-200 rounded-full py-3 px-5 text-[13px] font-medium outline-none appearance-none cursor-pointer"
            >
              {sections.map(s => <option key={s.key} value={s.key}>{s.title}</option>)}
            </select>
            <ChevronDown size={14} className="absolute right-5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
          </div>

          {detectedNotice && (
            <p className="text-[10px] text-indigo-600 bg-indigo-50 border border-indigo-100 rounded-2xl px-4 py-3 leading-relaxed">
              {detectedNotice}
            </p>
          )}

          {!isBaseSection && (
            <p className="text-[10px] text-slate-400 leading-relaxed">
              Include a <code className="bg-white px-1.5 py-0.5 rounded border border-slate-200">property_street_address</code> column with the full address (street, suburb) to link each row back to its property. Unmatched properties will be created automatically with minimal details.
            </p>
          )}

          {currentSection && (
            <button
              onClick={() => {
                const blob = new Blob([[!isBaseSection ? 'property_street_address,' : '', currentSection.headers.join(',')].join('')], { type: 'text/csv' });
                const a = document.createElement('a');
                a.href = window.URL.createObjectURL(blob);
                a.download = `niksen_${currentSection.key}_template.csv`;
                a.click();
              }}
              className="text-[11px] font-bold text-indigo-600 hover:underline"
            >
              Download template for this section
            </button>
          )}

          <p className="text-[9px] text-slate-300">
            Importing into: <span className="font-bold text-slate-400">{currentSection?.title || '—'}</span>
          </p>
        </div>
      )}
    </>
  );
}