// components/ColumnConfigDrawer.tsx
"use client";

import { useState, useEffect } from "react";
import { X, Save } from "lucide-react";
import FilterPanel from "@/components/FilterPanel";
import type { ActiveFilter } from "@/lib/types/filters";

interface Field {
  id: string;
  label: string;
  fieldType?: string;
}

interface Section {
  label: string;
  fields: Field[];
}

interface FilterableField {
  id: string;
  label: string;
  fieldType: string;
  options?: string[];
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  sections: Section[];
  tableCols: string[];
  expandCols: string[];
  activePresetName?: string;
  onToggle: (fieldId: string, target: 'table' | 'expand' | 'none') => void;
  filters?: ActiveFilter[];
  filterableFields?: FilterableField[];
  onFiltersChange?: (filters: ActiveFilter[]) => void;
}

type ActiveTab = 'columns' | 'filters';

export default function ColumnConfigDrawer({
  isOpen, onClose, sections, tableCols, expandCols,
  activePresetName, onToggle,
  filters = [], filterableFields = [], onFiltersChange,
}: Props) {
  const [activeTab, setActiveTab] = useState<ActiveTab>('columns');

  // Local draft for filters — only applied on Save
  const [draftFilters, setDraftFilters] = useState<ActiveFilter[]>(filters);
  const [filtersDirty, setFiltersDirty] = useState(false);

  // Sync draft when external filters change (e.g. preset switch)
  useEffect(() => {
    setDraftFilters(filters);
    setFiltersDirty(false);
  }, [filters]);

  const handleFilterChange = (f: ActiveFilter[]) => {
    setDraftFilters(f);
    setFiltersDirty(true);
  };

  const handleSaveFilters = () => {
    onFiltersChange?.(draftFilters);
    setFiltersDirty(false);
  };

  const handleClearFilters = () => {
    setDraftFilters([]);
    setFiltersDirty(true);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-40 flex">
      <div className="fixed inset-0 bg-slate-900/20 backdrop-blur-sm" onClick={onClose} />

      <div className="relative ml-auto w-96 bg-white h-full shadow-2xl flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-10 pb-4 border-b border-slate-100 shrink-0">
          <div>
            <h2 className="text-[13px] font-bold text-slate-800 uppercase tracking-wide">
              Column setup
            </h2>
            {activePresetName && (
              <p className="text-[10px] text-slate-400 mt-0.5">
                Preset: {activePresetName}
              </p>
            )}
          </div>
          <button onClick={onClose} className="p-1.5 text-slate-300 hover:text-slate-700 transition-colors">
            <X size={18} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-slate-100 px-6 shrink-0">
          <button
            onClick={() => setActiveTab('columns')}
            className={`pb-3 mr-6 text-[11px] font-bold uppercase tracking-widest transition-colors border-b-2 ${
              activeTab === 'columns' ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-slate-400 hover:text-slate-700'
            }`}
          >
            Columns
          </button>
          <button
            onClick={() => setActiveTab('filters')}
            className={`pb-3 text-[11px] font-bold uppercase tracking-widest transition-colors border-b-2 relative ${
              activeTab === 'filters' ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-slate-400 hover:text-slate-700'
            }`}
          >
            Filters
            {(draftFilters.length > 0 || filters.length > 0) && (
              <span className="ml-2 px-1.5 py-0.5 bg-indigo-600 text-white rounded-full text-[8px] font-bold align-middle">
                {draftFilters.length}
              </span>
            )}
          </button>
        </div>

        {/* ── Columns tab ── */}
        {activeTab === 'columns' && (
          <div className="flex-1 overflow-y-auto pt-4">
            {sections.map((section, si) => (
              <div key={si} className="px-6 py-4 border-b border-slate-50 last:border-0">
                <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-3">
                  {section.label}
                </p>
                <div className="grid grid-cols-1 gap-1.5">
                  {(section.fields || []).map((f: Field) => {
                    const inTable  = tableCols.includes(f.id);
                    const inExpand = expandCols.includes(f.id);

                    return (
                      <div key={f.id} className="flex items-center justify-between px-3 py-2.5 rounded-2xl hover:bg-slate-50 transition-all group">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <span className="text-[12px] font-medium text-slate-700 truncate">{f.label}</span>
                          {f.fieldType && (
                            <span className="text-[9px] text-slate-400 uppercase font-bold shrink-0">{f.fieldType}</span>
                          )}
                        </div>
                        <div className="flex items-center gap-1 shrink-0 ml-3">
                          <button
                            onClick={() => onToggle(f.id, inTable ? 'none' : 'table')}
                            title={inTable ? 'Remove from table' : 'Show in table'}
                            className={`px-2.5 py-1 rounded-full text-[9px] font-bold uppercase tracking-wide transition-all ${
                              inTable ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-400 hover:bg-slate-200 opacity-0 group-hover:opacity-100'
                            }`}
                          >
                            Table
                          </button>
                          <button
                            onClick={() => onToggle(f.id, inExpand ? 'none' : 'expand')}
                            title={inExpand ? 'Remove from expand' : 'Show in expand panel'}
                            className={`px-2.5 py-1 rounded-full text-[9px] font-bold uppercase tracking-wide transition-all ${
                              inExpand ? 'bg-slate-600 text-white' : 'bg-slate-100 text-slate-400 hover:bg-slate-200 opacity-0 group-hover:opacity-100'
                            }`}
                          >
                            Expand
                          </button>
                        </div>
                      </div>
                    );
                  })}
                  {(section.fields || []).length === 0 && (
                    <p className="text-[11px] text-slate-300 italic py-2">No fields in this section</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── Filters tab ── */}
        {activeTab === 'filters' && (
          <div className="flex-1 overflow-y-auto p-6 pt-6">
            {onFiltersChange ? (
              <FilterPanel
                fields={filterableFields}
                filters={draftFilters}
                onChange={handleFilterChange}
              />
            ) : (
              <p className="text-[11px] text-slate-300 italic">Filters not available</p>
            )}
          </div>
        )}

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-100 shrink-0 space-y-3">
          {/* Filter save button — only shown on filters tab */}
          {activeTab === 'filters' && (
            <div className="flex items-center gap-2">
              <button
                onClick={handleSaveFilters}
                disabled={!filtersDirty}
                className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-indigo-600 text-white text-[11px] font-bold rounded-full hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <Save size={13} />
                Save filters
              </button>
              {draftFilters.length > 0 && (
                <button
                  onClick={handleClearFilters}
                  className="px-4 py-2.5 text-[11px] font-bold text-red-400 hover:text-red-600 border border-red-200 hover:border-red-300 rounded-full transition-colors"
                >
                  Clear
                </button>
              )}
            </div>
          )}

          <div className="flex items-center justify-between text-[10px] text-slate-400">
            <span>{tableCols.length} in table · {expandCols.length} in expand</span>
            {activeTab === 'filters' && filtersDirty && (
              <span className="text-amber-500 font-bold">Unsaved changes</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}