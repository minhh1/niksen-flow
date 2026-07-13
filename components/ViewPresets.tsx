"use client";

import { useState } from "react";
import { Save, LayoutGrid, X, RotateCcw } from "lucide-react";

export default function ViewPresets({ presets, activePreset, onSelect, onSaveNew, onDelete, onClearView, isBusy }: any) {
  const [hovering, setHovering] = useState(false);

  return (
    <div className="flex items-center gap-3 mt-4 animate-in fade-in duration-500">
      <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-full">
        <LayoutGrid size={12} className="text-slate-400" />
        <span className="text-[10px] font-bold text-slate-400 uppercase tracking-tight">Saved views</span>
      </div>
      
      <div className="flex items-center gap-2 overflow-x-auto no-scrollbar">
        {presets.map((p: any) => {
          const isActive = activePreset === p.preset_name;
          return (
            <div
              key={p.preset_name}
              className={`flex items-center gap-1.5 rounded-full border transition-all whitespace-nowrap ${
                isActive
                  ? hovering
                    ? "bg-red-500 border-red-500 text-white shadow-md shadow-red-100"
                    : "bg-indigo-600 border-indigo-600 text-white shadow-md shadow-indigo-100"
                  : "bg-white border-slate-200 text-slate-500 hover:border-slate-400"
              }`}
            >
              <button
                disabled={isBusy}
                onClick={() => isActive && onClearView ? onClearView() : onSelect(p)}
                onMouseEnter={() => isActive && setHovering(true)}
                onMouseLeave={() => setHovering(false)}
                className="pl-4 py-1.5 text-[11px] font-medium disabled:opacity-50 flex items-center gap-1.5"
              >
                {isActive && hovering ? (
                  <><RotateCcw size={11} /> Reset view</>
                ) : (
                  p.preset_name
                )}
              </button>

              {/* Delete — only shown when not hovering active preset */}
              {presets.length > 1 && !(isActive && hovering) && (
                <button
                  disabled={isBusy}
                  onClick={(e) => { e.stopPropagation(); onDelete(p); }}
                  title={`Delete "${p.preset_name}"`}
                  className={`p-1.5 mr-1.5 rounded-full transition-all disabled:opacity-50 ${
                    isActive
                      ? "text-white/70 hover:text-white hover:bg-white/10"
                      : "text-slate-300 hover:text-red-500 hover:bg-red-50"
                  }`}
                >
                  <X size={11} strokeWidth={3} />
                </button>
              )}

              {/* Confirm reset — shown when hovering active preset */}
              {isActive && hovering && (
                <button
                  onMouseEnter={() => setHovering(true)}
                  onMouseLeave={() => setHovering(false)}
                  onClick={(e) => { e.stopPropagation(); setHovering(false); }}
                  className="p-1.5 mr-1.5 rounded-full text-white/70 hover:text-white"
                >
                  <X size={11} strokeWidth={3} />
                </button>
              )}
            </div>
          );
        })}
        
        <button 
          disabled={isBusy}
          onClick={onSaveNew}
          className="flex items-center gap-1.5 px-4 py-1.5 rounded-full border border-dashed border-slate-300 text-slate-400 hover:text-indigo-600 hover:border-indigo-600 transition-all text-[11px] font-medium whitespace-nowrap disabled:opacity-50"
        >
          <Save size={12} />
          Save current as new
        </button>
      </div>
    </div>
  );
}