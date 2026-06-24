"use client";

import { Save, LayoutGrid, Check } from "lucide-react";

export default function ViewPresets({ presets, activePreset, onSelect, onSaveNew }: any) {
  return (
    <div className="flex items-center gap-3 mt-4 animate-in fade-in duration-500">
      <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-full">
        <LayoutGrid size={12} className="text-slate-400" />
        <span className="text-[10px] font-bold text-slate-400 uppercase tracking-tight">Saved views</span>
      </div>
      
      <div className="flex items-center gap-2 overflow-x-auto no-scrollbar">
        {presets.map((p: any) => (
          <button
            key={p.preset_name}
            onClick={() => onSelect(p)}
            className={`px-4 py-1.5 rounded-full text-[11px] font-medium transition-all whitespace-nowrap border ${
              activePreset === p.preset_name 
              ? "bg-indigo-600 border-indigo-600 text-white shadow-md shadow-indigo-100" 
              : "bg-white border-slate-200 text-slate-500 hover:border-slate-400"
            }`}
          >
            {p.preset_name}
          </button>
        ))}
        
        <button 
          onClick={onSaveNew}
          className="flex items-center gap-1.5 px-4 py-1.5 rounded-full border border-dashed border-slate-300 text-slate-400 hover:text-indigo-600 hover:border-indigo-600 transition-all text-[11px] font-medium whitespace-nowrap"
        >
          <Save size={12} />
          Save current as new
        </button>
      </div>
    </div>
  );
}