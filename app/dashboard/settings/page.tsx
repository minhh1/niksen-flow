"use client";

import React, { useState, useEffect } from "react";
import { supabase } from "@/lib/supabase";
import {
  Database, Clock, Copy, ArrowLeft, Loader2,
  CheckCircle2, ChevronRight, AlertCircle,
  Trash2, Building2, MapPin, LayoutGrid, Upload, Wand2, X, ChevronDown, ChevronUp, Share2
} from "lucide-react";
import ImportModal from "@/components/ImportModal";
import DataFormattingTool from "@/components/DataFormattingTool";
import SchemaVisualisation from "@/components/SchemaVisualisation";
import SpreadsheetEditor from "@/components/SpreadsheetEditor";
import CustomTableBuilder from "@/components/CustomTableBuilder";
import SchemaMap from "@/components/SchemaMap";
import PublicTaskPagesTab from "@/components/settings/PublicTaskPagesTab";


type SettingsView = "menu" | "history" | "schema" | "duplicates_menu" | "duplicates_view" | "public_pages";
type DupType = "properties" | "entities" | "projects";

export default function SettingsPage() {
  const [view, setView] = useState<SettingsView>("menu");
  const [activeDupType, setActiveDupType] = useState<DupType>("properties");
  const [items, setItems] = useState<any[]>([]);
  const [history, setHistory] = useState<any[]>([]);
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [isFormatterOpen, setIsFormatterOpen] = useState(false);
  const [isSpreadsheetOpen, setIsSpreadsheetOpen] = useState(false);

  useEffect(() => {
    if (view === "history") fetchHistory();
    if (view === "duplicates_view") fetchDuplicates();
  }, [view, activeDupType]);

  const fetchHistory = async () => {
    setLoading(true);
    const { data } = await supabase
      .from("import_history")
      .select(`*, profiles:user_id(full_name)`)
      .is("deleted_at", null)
      .order('created_at', { ascending: false });
    setHistory(data || []);
    setLoading(false);
  };

  const handleArchiveLog = async (id: string) => {
    if (!window.confirm("Archive this import log? It will be hidden but not permanently deleted.")) return;
    const { error } = await supabase.from("import_history").update({ deleted_at: new Date().toISOString() }).eq("id", id);
    if (!error) setHistory(prev => prev.filter(h => h.id !== id));
  };

  const fetchDuplicates = async () => {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    const { data: prof } = await supabase.from("profiles").select("active_company_id").eq("id", user?.id).single();
    const rpcName = activeDupType === 'properties' ? 'find_potential_duplicates'
      : activeDupType === 'entities' ? 'find_entity_duplicates'
      : 'find_project_duplicates';
    const { data } = await supabase.rpc(rpcName, { similarity_threshold: 0.4, target_company_id: prof?.active_company_id });
    setItems(data || []);
    setLoading(false);
  };

  const handleBulkDelete = async () => {
    if (!window.confirm(`Delete ${selected.length} records?`)) return;
    await supabase.from(activeDupType).update({ deleted_at: new Date().toISOString() }).in("id", selected);
    setSelected([]);
    fetchDuplicates();
  };

  const formatTargetTable = (table: string) =>
    (table || '').replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

  const headerTitle = () => {
    if (view === 'menu') return 'Settings';
    if (view === 'schema') return 'Schema configuration';
    if (view === 'history') return 'Import history';
    if (view === 'duplicates_menu') return 'Duplicates';
    if (view === 'duplicates_view') return `Duplicates — ${activeDupType}`;
    if (view === 'public_pages') return 'Public task pages';
    return 'Settings';
  };

  const handleBack = () => {
    if (view === 'duplicates_view') setView('duplicates_menu');
    else setView('menu');
  };

  return (
    <div className="flex flex-col h-screen bg-[#F9FAFB] font-sans antialiased text-slate-600 overflow-hidden">
      <header className="bg-white p-8 border-b border-slate-100 shrink-0 flex items-center gap-6">
        {view !== "menu" && (
          <button onClick={handleBack} className="p-2 hover:bg-slate-50 rounded-full transition-all text-slate-400">
            <ArrowLeft size={20}/>
          </button>
        )}
        <div>
          <h1 className="text-3xl font-light text-slate-900 tracking-tight capitalize">{headerTitle()}</h1>
          <p className="text-[11px] font-medium text-slate-400 uppercase tracking-widest mt-1">Management administration</p>
        </div>
        {view === 'duplicates_view' && selected.length > 0 && (
          <button
            onClick={handleBulkDelete}
            className="ml-auto px-5 py-2.5 bg-red-500 text-white rounded-full text-[11px] font-bold hover:bg-red-600 transition-all"
          >
            Archive {selected.length} selected
          </button>
        )}
      </header>

      <main className="flex-1 overflow-y-auto p-8 custom-scrollbar">
        <div className="max-w-5xl mx-auto space-y-4 pb-20">

          {/* ── MENU ── */}
          {view === "menu" && (
            <div className="grid grid-cols-1 gap-4">
              <button onClick={() => setIsImportOpen(true)} className="flex items-center justify-between p-6 bg-white border border-slate-200 rounded-[32px] hover:border-indigo-500 transition-all group shadow-sm">
                <div className="flex items-center gap-5">
                  <div className="p-3 bg-slate-50 rounded-2xl text-slate-400 group-hover:text-indigo-600 transition-colors"><Upload size={20} /></div>
                  <span className="text-[15px] font-medium text-slate-700">Mass data synchronization engine</span>
                </div>
                <ChevronRight size={18} className="text-slate-200 group-hover:text-indigo-600 transition-all"/>
              </button>

              <button onClick={() => setView("history")} className="flex items-center justify-between p-6 bg-white border border-slate-200 rounded-[32px] hover:border-indigo-500 transition-all group shadow-sm">
                <div className="flex items-center gap-5">
                  <div className="p-3 bg-slate-50 rounded-2xl text-slate-400 group-hover:text-indigo-600 transition-colors"><Clock size={20} /></div>
                  <span className="text-[15px] font-medium text-slate-700">Import history</span>
                </div>
                <ChevronRight size={18} className="text-slate-200 group-hover:text-indigo-600 transition-all"/>
              </button>

              <button onClick={() => setIsSpreadsheetOpen(true)} className="flex items-center justify-between p-6 bg-white border border-slate-200 rounded-[32px] hover:border-indigo-500 transition-all group shadow-sm">
              <div className="flex items-center gap-5">
                <div className="p-3 bg-slate-50 rounded-2xl text-slate-400 group-hover:text-indigo-600 transition-colors">
                  <LayoutGrid size={20} />
                </div>
                <span className="text-[15px] font-medium text-slate-700">Spreadsheet editor</span>
              </div>
              <ChevronRight size={18} className="text-slate-200 group-hover:text-indigo-600 transition-all"/>
            </button>

              <button onClick={() => setView("schema")} className="flex items-center justify-between p-6 bg-white border border-slate-200 rounded-[32px] hover:border-indigo-500 transition-all group shadow-sm">
                <div className="flex items-center gap-5">
                  <div className="p-3 bg-slate-50 rounded-2xl text-slate-400 group-hover:text-indigo-600 transition-colors"><Database size={20} /></div>
                  <span className="text-[15px] font-medium text-slate-700">Schema configuration</span>
                </div>
                <ChevronRight size={18} className="text-slate-200 group-hover:text-indigo-600 transition-all"/>
              </button>

              <button onClick={() => setIsFormatterOpen(true)} className="flex items-center justify-between p-6 bg-white border border-slate-200 rounded-[32px] hover:border-indigo-500 transition-all group shadow-sm">
                <div className="flex items-center gap-5">
                  <div className="p-3 bg-slate-50 rounded-2xl text-slate-400 group-hover:text-indigo-600 transition-colors"><Wand2 size={20} /></div>
                  <span className="text-[15px] font-medium text-slate-700">Database case standardizer</span>
                </div>
                <ChevronRight size={18} className="text-slate-200 group-hover:text-indigo-600 transition-all"/>
              </button>

              <button onClick={() => setView("duplicates_menu")} className="flex items-center justify-between p-6 bg-white border border-slate-200 rounded-[32px] hover:border-indigo-500 transition-all group shadow-sm">
                <div className="flex items-center gap-5">
                  <div className="p-3 bg-slate-50 rounded-2xl text-slate-400 group-hover:text-amber-600 transition-colors"><Copy size={20} /></div>
                  <span className="text-[15px] font-medium text-slate-700">Reconciliation tool (Duplicates)</span>
                </div>
                <ChevronRight size={18} className="text-slate-200 group-hover:text-indigo-600 transition-all"/>
              </button>

              <button onClick={() => setView("public_pages")} className="flex items-center justify-between p-6 bg-white border border-slate-200 rounded-[32px] hover:border-indigo-500 transition-all group shadow-sm">
                <div className="flex items-center gap-5">
                  <div className="p-3 bg-slate-50 rounded-2xl text-slate-400 group-hover:text-indigo-600 transition-colors"><Share2 size={20} /></div>
                  <span className="text-[15px] font-medium text-slate-700">Public task pages</span>
                </div>
                <ChevronRight size={18} className="text-slate-200 group-hover:text-indigo-600 transition-all"/>
              </button>
            </div>
          )}

          {/* ── IMPORT HISTORY ── */}
          {view === "history" && (
            <div className="space-y-3 animate-in fade-in">
              {loading ? (
                <div className="flex justify-center p-20"><Loader2 className="animate-spin text-slate-300" /></div>
              ) : history.length === 0 ? (
                <p className="text-center text-slate-300 text-[11px] uppercase font-bold tracking-widest p-20">No import history yet</p>
              ) : (
                history.map(log => {
                  const isExpanded = expandedLogId === log.id;
                  const results = log.results_json || [];
                  const successCount = log.success_count ?? results.filter((r: any) => r.status === 'new' || r.status === 'updated').length;
                  const failedCount = log.error_count ?? results.filter((r: any) => r.status === 'failed').length;
                  const totalRows = log.total_rows ?? results.length;

                  return (
                    <div key={log.id} className="bg-white border border-slate-200 rounded-[32px] overflow-hidden shadow-sm">
                      <div className="flex items-center justify-between p-6">
                        <button onClick={() => setExpandedLogId(isExpanded ? null : log.id)} className="flex items-center gap-5 flex-1 text-left">
                          <div className="p-3 bg-slate-50 rounded-2xl text-slate-400">
                            {isExpanded ? <ChevronUp size={18}/> : <ChevronDown size={18}/>}
                          </div>
                          <div>
                            <p className="text-[15px] font-medium text-slate-900">{log.filename || 'Unnamed import'}</p>
                            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1">
                              {formatTargetTable(log.target_table)} · {new Date(log.created_at).toLocaleString('en-AU')} · by {log.profiles?.full_name || 'Unknown'} · {totalRows} rows · <span className="text-emerald-600">{successCount} ok</span> · <span className="text-red-500">{failedCount} failed</span>
                            </p>
                          </div>
                        </button>
                        <button onClick={() => handleArchiveLog(log.id)} className="p-3 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-full transition-all" title="Archive this log">
                          <Trash2 size={16}/>
                        </button>
                      </div>

                      {isExpanded && (
                        <div className="border-t border-slate-100 p-6 bg-slate-50/50 overflow-x-auto">
                          {results.length === 0 ? (
                            <p className="text-[11px] text-slate-300 italic py-4">No row-level details stored for this import.</p>
                          ) : (
                            <table className="w-full text-left text-[11px] min-w-max">
                              <thead className="text-slate-400">
                                <tr>
                                  <th className="p-2 font-bold uppercase text-[9px]">Status</th>
                                  <th className="p-2 font-bold uppercase text-[9px]">Identifier</th>
                                  <th className="p-2 font-bold uppercase text-[9px]">Message</th>
                                </tr>
                              </thead>
                              <tbody>
                                {results.map((r: any, i: number) => (
                                  <tr key={i} className="border-t border-slate-100">
                                    <td className="p-2">
                                      <span className={`px-2 py-0.5 rounded text-[9px] font-bold uppercase ${r.status === 'failed' ? 'bg-red-50 text-red-600' : r.status === 'updated' ? 'bg-blue-50 text-blue-600' : 'bg-emerald-50 text-emerald-600'}`}>
                                        {r.status}
                                      </span>
                                    </td>
                                    <td className="p-2 font-bold text-slate-700">{r.identifier}</td>
                                    <td className="p-2 text-slate-500">{r.message || '—'}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          )}

          {/* ── PUBLIC TASK PAGES ── */}
          {view === 'public_pages' && <PublicTaskPagesTab />}

          {/* ── SCHEMA VISUALISATION ── */}

          {view === 'schema' && (
            <div className="space-y-8">
              <CustomTableBuilder />
              <SchemaMap />
              <SchemaVisualisation />
            </div>
          )}
          

          {/* ── DUPLICATES MENU ── */}
          {view === "duplicates_menu" && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 animate-in fade-in">
              {[{ id: 'properties', label: 'Assets', icon: MapPin }, { id: 'entities', label: 'Entities', icon: Building2 }, { id: 'projects', label: 'Projects', icon: LayoutGrid }].map((cat) => (
                <button key={cat.id} onClick={() => { setActiveDupType(cat.id as DupType); setView("duplicates_view"); }} className="p-10 bg-white border border-slate-200 rounded-[48px] flex flex-col items-center gap-5 hover:border-indigo-500 hover:shadow-xl transition-all group">
                  <div className="p-5 bg-slate-50 rounded-[24px] text-slate-400 group-hover:text-indigo-600 transition-all"><cat.icon size={40} /></div>
                  <span className="font-medium text-slate-700 uppercase text-[11px] tracking-widest">{cat.label}</span>
                </button>
              ))}
            </div>
          )}

          {/* ── DUPLICATES VIEW ── */}
          {view === "duplicates_view" && (
            <div className="space-y-8 animate-in fade-in">
              {loading ? (
                <div className="flex justify-center p-20"><Loader2 className="animate-spin text-slate-300" /></div>
              ) : items.length === 0 ? (
                <p className="text-center text-slate-300 text-[11px] uppercase font-bold tracking-widest p-20">No duplicates found</p>
              ) : (
                items.map((pair, idx) => (
                  <div key={idx} className="bg-white border border-slate-200 rounded-[48px] overflow-hidden shadow-sm mb-6 transition-all hover:border-slate-300">
                    <div className="bg-slate-50 px-8 py-3 border-b border-slate-100 flex items-center justify-between text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                      <span>Reason: {pair.match_reason}</span>
                      <span className="text-indigo-600">Points: {pair.match_score}</span>
                    </div>
                    <div className="flex flex-col md:flex-row">
                      {[1, 2].map(n => (
                        <div key={pair[`id${n}`]} onClick={() => setSelected(prev => selected.includes(pair[`id${n}`]) ? prev.filter(x => x !== pair[`id${n}`]) : [...prev, pair[`id${n}`]])} className={`flex-1 p-10 flex items-start gap-6 cursor-pointer transition-all ${n === 1 ? 'border-r border-slate-100' : ''} ${selected.includes(pair[`id${n}`]) ? 'bg-red-50/50' : 'hover:bg-slate-50/30'}`}>
                          <div className={`mt-1 h-6 w-6 rounded-full border-2 flex items-center justify-center transition-all ${selected.includes(pair[`id${n}`]) ? 'bg-red-500 border-red-500 shadow-md' : 'border-slate-200'}`}>
                            {selected.includes(pair[`id${n}`]) && <CheckCircle2 size={14} className="text-white"/>}
                          </div>
                          <div className="flex-1">
                            <p className="text-[16px] font-medium text-slate-900 leading-tight uppercase">{pair[`address${n}`] || pair[`name${n}`]}</p>
                            <div className="mt-6 grid grid-cols-2 gap-y-5 gap-x-12">
                              {activeDupType === 'properties' ? (
                                <>
                                  <div><p className="text-[9px] font-bold text-slate-400 uppercase tracking-tight">Price</p><p className="text-[13px] font-medium text-slate-700">${pair[`price${n}`]?.toLocaleString() || '0'}</p></div>
                                  <div><p className="text-[9px] font-bold text-slate-400 uppercase tracking-tight">Owner</p><p className="text-[13px] font-medium text-slate-700 truncate">{pair[`entity${n}`] || 'Unassigned'}</p></div>
                                  <div><p className="text-[9px] font-bold text-slate-400 uppercase tracking-tight">Date</p><p className="text-[13px] font-medium text-slate-700">{pair[`date${n}`] || '—'}</p></div>
                                </>
                              ) : (
                                <>
                                  <div><p className="text-[9px] font-bold text-slate-400 uppercase tracking-tight">Type</p><p className="text-[13px] font-medium text-slate-700">{pair[`type${n}`] || '-'}</p></div>
                                  <div><p className="text-[9px] font-bold text-slate-400 uppercase tracking-tight">ABN</p><p className="text-[13px] font-medium text-slate-700">{pair[`abn${n}`] || '-'}</p></div>
                                </>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

        </div>
      </main>
      {isSpreadsheetOpen && (
        <div className="fixed inset-0 z-50 flex flex-col bg-white font-sans">
          <div className="flex items-center justify-between p-6 border-b border-slate-100 shrink-0">
            <h2 className="text-xl font-light uppercase tracking-tight text-slate-900">
              Spreadsheet editor
            </h2>
            <button
              onClick={() => setIsSpreadsheetOpen(false)}
              className="p-2 text-slate-300 hover:text-black transition-colors"
            >
              <X size={20} />
            </button>
          </div>
          <div className="flex-1 p-6 min-h-0 overflow-hidden">
            <SpreadsheetEditor onClose={() => setIsSpreadsheetOpen(false)} />
          </div>
        </div>
      )}
      <ImportModal isOpen={isImportOpen} onClose={() => setIsImportOpen(false)} onRefresh={fetchHistory} />
      <DataFormattingTool isOpen={isFormatterOpen} onClose={() => setIsFormatterOpen(false)} onRefresh={() => {}} />
    </div>
  );
}