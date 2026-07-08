// components/gmail/ProjectSearch.tsx
"use client";

import { useState } from "react";
import { Search, Tag, X, Check, Loader2, Settings } from "lucide-react";
import SearchConfigPanel from "./SearchConfigPanel";
import type { GmailProject, SearchableField } from "@/lib/gmail/types";
import { getProjectLabel } from "@/lib/gmail/types";

interface Props {
  messageId: string;
  assignedProjectId: string | null;
  projects: GmailProject[];
  filteredProjects: GmailProject[];
  projectSearch: string;
  searchFields: string[];
  searchableFields: SearchableField[];
  projectCfValues: Record<string, Record<string, string>>;
  assigning: boolean;
  onSearchChange: (val: string) => void;
  onAssign: (projectId: string) => void;
  onUnassign: () => void;
  onSearchFieldsChange: (fields: string[]) => void;
}

export default function ProjectSearch({
  messageId, assignedProjectId, projects, filteredProjects,
  projectSearch, searchFields, searchableFields, projectCfValues,
  assigning, onSearchChange, onAssign, onUnassign, onSearchFieldsChange,
}: Props) {
  const [showDropdown, setShowDropdown] = useState(false);
  const [showConfig, setShowConfig] = useState(false);

  const assignedProject = assignedProjectId
    ? projects.find(p => p.id === assignedProjectId)
    : null;

  return (
    <div className="flex items-start gap-3">
      <Tag size={14} className="text-slate-400 shrink-0 mt-2.5" />
      <div className="flex-1 min-w-0">

        {/* Active search field chips */}
        {searchFields.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap mb-2">
            <span className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">
              Searching by:
            </span>
            {searchFields.map(f => {
              const field = searchableFields.find(sf => sf.key === f);
              return (
                <span
                  key={f}
                  className="px-2 py-0.5 bg-indigo-50 text-indigo-600 rounded-full text-[9px] font-bold"
                >
                  {field?.label || f}
                </span>
              );
            })}
          </div>
        )}

        <div className="relative">
          {assignedProject ? (
            <div className="flex items-center gap-2 px-4 py-2 bg-indigo-50 border border-indigo-200 rounded-full">
              <span className="text-[12px] font-bold text-indigo-700 flex-1 truncate">
                {getProjectLabel(assignedProject)}
              </span>
              <button
                onClick={onUnassign}
                className="text-indigo-300 hover:text-indigo-700 transition-colors"
              >
                <X size={12} />
              </button>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-full px-4 py-2">
                <Search size={12} className="text-slate-400 shrink-0" />
                <input
                  value={projectSearch}
                  onChange={e => { onSearchChange(e.target.value); setShowDropdown(true); }}
                  onFocus={() => setShowDropdown(true)}
                  placeholder={
                    searchFields.length > 0
                      ? `Search by ${searchFields.map(f => searchableFields.find(sf => sf.key === f)?.label || f).join(', ')}...`
                      : 'Search projects...'
                  }
                  className="flex-1 bg-transparent text-[12px] font-medium outline-none placeholder:text-slate-300"
                />
                {projectSearch && (
                  <button
                    onClick={() => { onSearchChange(''); setShowDropdown(false); }}
                    className="text-slate-300 hover:text-slate-600 transition-colors"
                  >
                    <X size={12} />
                  </button>
                )}
                <button
                  onClick={e => {
                    e.stopPropagation();
                    setShowConfig(p => !p);
                    setShowDropdown(false);
                  }}
                  className={`p-1 rounded-full transition-colors shrink-0 ${
                    showConfig ? 'text-indigo-600 bg-indigo-50' : 'text-slate-300 hover:text-slate-600'
                  }`}
                  title="Configure search fields"
                >
                  <Settings size={12} />
                </button>
              </div>

              {/* Search config panel */}
              {showConfig && (
                <SearchConfigPanel
                  searchFields={searchFields}
                  availableFields={searchableFields}
                  onChange={fields => { onSearchFieldsChange(fields); setShowConfig(false); }}
                  onClose={() => setShowConfig(false)}
                />
              )}

              {/* Results dropdown */}
              {showDropdown && !showConfig && (
                <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-slate-200 rounded-2xl shadow-xl z-20 max-h-56 overflow-y-auto">
                  {filteredProjects.length === 0 ? (
                    <p className="px-4 py-3 text-[11px] text-slate-300 italic">
                      No projects found
                    </p>
                  ) : (
                    filteredProjects.map(p => {
                      const secondaryValues = searchFields
                        .filter(f => f !== 'name')
                        .map(f => {
                          const field = searchableFields.find(sf => sf.key === f);
                          const val = f.startsWith('cf:')
                            ? projectCfValues[p.id]?.[f.replace('cf:', '')]
                            : (p as any)[f];
                          return val ? { label: field?.label || f, value: String(val) } : null;
                        })
                        .filter(Boolean) as { label: string; value: string }[];

                      return (
                        <button
                          key={p.id}
                          onClick={() => {
                            onAssign(p.id);
                            onSearchChange('');
                            setShowDropdown(false);
                          }}
                          className="w-full flex items-start gap-3 px-4 py-3 hover:bg-indigo-50 text-left transition-colors border-b border-slate-50 last:border-0"
                        >
                          <div className="h-6 w-6 rounded-full bg-indigo-100 flex items-center justify-center text-[9px] font-bold text-indigo-600 shrink-0 mt-0.5">
                            {p.name.charAt(0).toUpperCase()}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-[12px] font-medium text-slate-700 truncate">
                              {p.name}
                            </p>
                            {secondaryValues.length > 0 && (
                              <div className="flex items-center gap-2 flex-wrap mt-0.5">
                                {secondaryValues.map(mv => (
                                  <span key={mv.label} className="text-[9px] text-slate-400">
                                    <span className="font-bold">{mv.label}:</span> {mv.value}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        </button>
                      );
                    })
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {assigning && (
        <Loader2 size={14} className="animate-spin text-slate-400 shrink-0 mt-2.5" />
      )}
      {assignedProject && !assigning && (
        <div className="flex items-center gap-1.5 shrink-0 mt-2.5">
          <Check size={13} className="text-emerald-500" />
          <span className="text-[10px] font-bold text-emerald-600">Labelled</span>
        </div>
      )}

      {/* Close on outside click */}
      {(showDropdown || showConfig) && (
        <div
          className="fixed inset-0 z-10"
          onClick={() => { setShowDropdown(false); setShowConfig(false); }}
        />
      )}
    </div>
  );
}
