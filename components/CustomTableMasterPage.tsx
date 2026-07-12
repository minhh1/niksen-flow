// components/CustomTableMasterPage.tsx
"use client";

import React, { useState, useCallback, useMemo, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Search, Settings2, LayoutGrid, X, Plus, ChevronDown, ChevronUp, Trash2 } from "lucide-react";
import * as LucideIcons from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useCustomTable } from "@/lib/hooks/useCustomTable";
import { createRecord, deleteRecord } from "@/lib/services/customTableService";
import SpreadsheetEditor from "@/components/SpreadsheetEditor";
import type { CustomTable } from "@/lib/hooks/useCustomTables";
import type { CustomTableField, CustomTableRecord } from "@/lib/hooks/useCustomTable";
import RecordDashboard from "@/components/dashboard/RecordDashboard";

interface Props {
  tableSlug: string;
}

// ── Column config drawer — mirrors ColumnConfigDrawer for custom tables ──
function CustomColumnDrawer({
  isOpen, onClose, fields, visibleFieldIds, onToggle,
}: {
  isOpen: boolean;
  onClose: () => void;
  fields: CustomTableField[];
  visibleFieldIds: Set<string>;
  onToggle: (fieldId: string) => void;
}) {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-40 flex">
      <div className="fixed inset-0 bg-slate-900/20 backdrop-blur-sm" onClick={onClose} />
      <div className="relative ml-auto w-80 bg-white h-full shadow-2xl flex flex-col">
        <div className="flex items-center justify-between p-6 border-b border-slate-100">
          <h2 className="text-[13px] font-bold text-slate-800 uppercase tracking-wide">
            Column setup
          </h2>
          <button onClick={onClose} className="p-1.5 text-slate-300 hover:text-slate-700">
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-6 space-y-2">
          {fields.map(field => {
            const visible = visibleFieldIds.has(field.id);
            return (
              <button
                key={field.id}
                onClick={() => onToggle(field.id)}
                className={`w-full flex items-center gap-3 px-4 py-3 rounded-2xl border transition-all text-left ${
                  visible
                    ? 'border-indigo-200 bg-indigo-50'
                    : 'border-slate-100 hover:border-slate-200'
                }`}
              >
                <div className={`w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 ${
                  visible ? 'bg-indigo-600 border-indigo-600' : 'border-slate-300'
                }`}>
                  {visible && <div className="w-2 h-2 bg-white rounded-sm" />}
                </div>
                <span className={`text-[12px] font-medium ${visible ? 'text-indigo-700' : 'text-slate-600'}`}>
                  {field.label}
                </span>
                <span className="ml-auto text-[9px] font-bold text-slate-300 uppercase">
                  {field.field_type}
                </span>
              </button>
            );
          })}
          {fields.length === 0 && (
            <p className="text-center text-[11px] text-slate-300 italic py-8">
              No fields defined yet — add fields in Schema settings
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Format a cell value for display ───────────────────────────────
function formatValue(value: any, field: CustomTableField): string {
  if (value === null || value === undefined || value === '') return '—';
  if (field.field_type === 'boolean') return value ? 'Yes' : 'No';
  if (field.field_type === 'currency') return `$${Number(value).toLocaleString()}`;
  if (field.field_type === 'date') {
    try { return new Date(value).toLocaleDateString('en-AU'); } catch { return String(value); }
  }
  return String(value);
}

// ── Main component ─────────────────────────────────────────────────
function CustomTableMasterPageInner({ tableSlug }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectedId = searchParams.get('id');

  const { tableDef, fields, records, loading, refetch } = useCustomTable(tableSlug);

  const [search, setSearch] = useState('');
  const [isConfigOpen, setIsConfigOpen] = useState(false);
  const [isSpreadsheetOpen, setIsSpreadsheetOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  // Which fields are visible as table columns
  const [visibleFieldIds, setVisibleFieldIds] = useState<Set<string> | null>(null);

  // Default: first 6 show_in_table fields, or first 6 fields
  const defaultVisibleIds = useMemo(() => {
    const preferred = fields.filter(f => f.show_in_table).slice(0, 6);
    const fallback = fields.slice(0, 6);
    return new Set((preferred.length > 0 ? preferred : fallback).map(f => f.id));
  }, [fields]);

  const effectiveVisibleIds = visibleFieldIds || defaultVisibleIds;

  const tableColumns = useMemo(
    () => fields.filter(f => effectiveVisibleIds.has(f.id)),
    [fields, effectiveVisibleIds]
  );

  // Primary display field
  const primaryField = useMemo(
    () => fields.find(f => f.field_key === tableDef?.primary_field_key) || fields[0],
    [fields, tableDef]
  );

  // Filtered + sorted records
  const filteredRecords = useMemo(() => {
    if (!search.trim()) return records;
    const q = search.toLowerCase();
    return records.filter(r => {
      const primary = String(r.values[primaryField?.field_key] || '');
      return primary.toLowerCase().includes(q) ||
        Object.values(r.values).some(v => String(v || '').toLowerCase().includes(q));
    });
  }, [records, search, primaryField]);

  const handleCreate = async () => {
    setIsCreating(true);
    const { data: { user } } = await supabase.auth.getUser();
    const { data: prof } = await supabase
      .from('profiles').select('active_company_id').eq('id', user?.id).single();
    const cid = prof?.active_company_id;
    setCompanyId(cid || null);
    if (!cid || !user || !tableDef) { setIsCreating(false); return; }

    const rec = await createRecord(tableDef.id, cid, user.id, {}, fields);
    setIsCreating(false);
    if (rec) {
      refetch();
      router.push(`/dashboard/${tableSlug}?id=${rec.id}`);
    }
  };

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm('Archive this record?')) return;
    setDeletingId(id);
    await deleteRecord(id);
    setDeletingId(null);
    refetch();
  };

  const handleToggleField = (fieldId: string) => {
    setVisibleFieldIds(prev => {
      const current = prev || defaultVisibleIds;
      const next = new Set(current);
      if (next.has(fieldId)) {
        if (next.size <= 1) return current; // always keep at least 1 column
        next.delete(fieldId);
      } else {
        next.add(fieldId);
      }
      return next;
    });
  };

  // ── Dashboard view ─────────────────────────────────────────────
  if (selectedId && tableDef) {
    return (
      <RecordDashboard
        tableId={tableDef.id}
        tableSlug={tableSlug}
        tableName={tableDef.name}
        recordId={selectedId}
        onBack={() => {
          refetch();
          router.push(`/dashboard/${tableSlug}`);
        }}
      />
    );
  }
  if (loading || !tableDef) {
    return (
      <div className="flex items-center justify-center h-screen">
        <p className="text-slate-400 text-[11px] uppercase font-bold tracking-widest animate-pulse">
          Loading...
        </p>
      </div>
    );
  }

  const IconComp = (LucideIcons as any)[tableDef.icon] || LucideIcons.Table2;

  return (
    <div className="flex flex-col h-screen bg-[#F9FAFB] font-sans antialiased text-slate-600 overflow-hidden">

      {/* ── Header ── */}
      <header className="bg-white border-b border-slate-100 shrink-0">
        <div className="p-8 pb-4">
          <div className="flex justify-between items-center mb-8">
            <div className="flex items-center gap-4">
              <div
                className="h-10 w-10 rounded-2xl flex items-center justify-center shrink-0"
                style={{ backgroundColor: `${tableDef.color}20` }}
              >
                <IconComp size={20} style={{ color: tableDef.color }} />
              </div>
              <h1 className="text-3xl font-light uppercase tracking-tight text-slate-900">
                {tableDef.name}
              </h1>
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => setIsConfigOpen(true)}
                className="flex items-center gap-2 px-4 py-2 bg-slate-50 border border-slate-200 rounded-full text-[11px] font-bold transition-all hover:bg-slate-100"
              >
                <Settings2 size={16} /> Setup
              </button>
              <button
                onClick={() => setIsSpreadsheetOpen(true)}
                className="flex items-center gap-2 px-4 py-2 bg-slate-50 border border-slate-200 rounded-full text-[11px] font-bold transition-all hover:bg-slate-100"
              >
                <LayoutGrid size={16} /> Spreadsheet
              </button>
              <button
                onClick={handleCreate}
                disabled={isCreating}
                className="bg-slate-900 text-white px-6 py-2 rounded-full text-[11px] font-bold shadow-sm disabled:opacity-50 flex items-center gap-2"
              >
                {isCreating ? (
                  <LucideIcons.Loader2 size={14} className="animate-spin" />
                ) : (
                  <Plus size={14} />
                )}
                New record
              </button>
            </div>
          </div>

          {/* Search */}
          <div className="relative mb-6">
            <Search
              className="absolute left-5 top-1/2 -translate-y-1/2 text-slate-300"
              size={20}
            />
            <input
              placeholder={`Search ${tableDef.name.toLowerCase()}...`}
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full bg-slate-50 border border-slate-100 rounded-2xl py-4 pl-14 pr-8 text-sm font-medium outline-none focus:ring-8 focus:ring-black/5 transition-all"
            />
          </div>
        </div>
      </header>

      {/* ── Column config drawer ── */}
      <CustomColumnDrawer
        isOpen={isConfigOpen}
        onClose={() => setIsConfigOpen(false)}
        fields={fields}
        visibleFieldIds={effectiveVisibleIds}
        onToggle={handleToggleField}
      />

      {/* ── Main table ── */}
      <main className="flex-1 overflow-auto p-8">
        {filteredRecords.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-4">
            <div
              className="h-16 w-16 rounded-3xl flex items-center justify-center"
              style={{ backgroundColor: `${tableDef.color}15` }}
            >
              <IconComp size={28} style={{ color: tableDef.color }} />
            </div>
            <p className="text-slate-400 text-[11px] uppercase font-bold tracking-widest">
              {search ? 'No records match your search' : 'No records yet'}
            </p>
            {!search && (
              <button
                onClick={handleCreate}
                className="text-indigo-600 text-[11px] font-bold uppercase tracking-widest hover:underline"
              >
                Create first record
              </button>
            )}
          </div>
        ) : (
          <div className="bg-white rounded-[40px] border border-slate-200 shadow-sm overflow-hidden">

            {/* Table header */}
            <div className="flex bg-slate-50 border-b border-slate-100">
              {tableColumns.map(col => (
                <div
                  key={col.id}
                  className="flex-1 px-6 py-4 text-[9px] font-bold uppercase tracking-widest text-slate-400 min-w-0"
                >
                  {col.label}
                </div>
              ))}
              <div className="w-24 shrink-0" />
            </div>

            {/* Rows */}
            {filteredRecords.map(record => {
              const isExpanded = expandedId === record.id;
              const isDeleting = deletingId === record.id;
              const primaryValue = record.values[primaryField?.field_key] || 'Untitled';

              // Non-visible fields shown in expand panel
              const expandFields = fields.filter(f => !effectiveVisibleIds.has(f.id));

              return (
                <React.Fragment key={record.id}>
                  <div
                    className="flex items-center border-b border-slate-50 hover:bg-indigo-50/20 transition-all cursor-pointer group"
                    onClick={() => router.push(`/dashboard/${tableSlug}?id=${record.id}`)}
                  >
                    {tableColumns.map((col, idx) => (
                      <div
                        key={col.id}
                        className="flex-1 px-6 py-5 text-[13px] font-medium text-slate-700 truncate min-w-0"
                      >
                        {idx === 0 ? (
                          // Primary column — styled as a link
                          <span className="font-bold text-slate-800 group-hover:text-indigo-600 transition-colors">
                            {formatValue(record.values[col.field_key], col)}
                          </span>
                        ) : (
                          formatValue(record.values[col.field_key], col)
                        )}
                      </div>
                    ))}

                    {/* Actions */}
                    <div
                      className="w-24 shrink-0 flex items-center justify-end gap-1 px-4"
                      onClick={e => e.stopPropagation()}
                    >
                      {isDeleting ? (
                        <LucideIcons.Loader2 size={14} className="animate-spin text-slate-300" />
                      ) : (
                        <button
                          onClick={e => handleDelete(record.id, e)}
                          className="p-1.5 rounded-full text-slate-300 hover:text-red-500 hover:bg-red-50 transition-all opacity-0 group-hover:opacity-100"
                          title="Archive"
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                      <button
                        onClick={e => {
                          e.stopPropagation();
                          setExpandedId(isExpanded ? null : record.id);
                        }}
                        className="p-1.5 rounded-full text-slate-300 hover:text-indigo-600 hover:bg-indigo-50 transition-all"
                      >
                        {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                      </button>
                    </div>
                  </div>

                  {/* Expanded row — shows hidden fields */}
                  {isExpanded && expandFields.length > 0 && (
                    <div className="border-b border-slate-100 bg-slate-50/60 px-8 py-6">
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-5">
                        {expandFields.map(col => (
                          <div key={col.id}>
                            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1">
                              {col.label}
                            </p>
                            <p className="text-[13px] font-medium text-slate-700 truncate">
                              {formatValue(record.values[col.field_key], col) || '—'}
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </React.Fragment>
              );
            })}
          </div>
        )}
      </main>

      {/* ── Spreadsheet overlay ── */}
      {isSpreadsheetOpen && (
        <div className="fixed inset-0 z-50 flex flex-col bg-white font-sans">
          <div className="flex items-center justify-between p-6 border-b border-slate-100 shrink-0">
            <h2 className="text-xl font-light uppercase tracking-tight text-slate-900">
              Spreadsheet — {tableDef.name}
            </h2>
            <button
              onClick={() => { setIsSpreadsheetOpen(false); refetch(); }}
              className="p-2 text-slate-300 hover:text-black transition-colors"
            >
              <X size={20} />
            </button>
          </div>
          <div className="flex-1 p-6 min-h-0 overflow-hidden">
            <SpreadsheetEditor
              tableName="properties" // SpreadsheetEditor uses system tables for now
              onClose={() => { setIsSpreadsheetOpen(false); refetch(); }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

export default function CustomTableMasterPage({ tableSlug }: Props) {
  return (
    <Suspense fallback={null}>
      <CustomTableMasterPageInner tableSlug={tableSlug} />
    </Suspense>
  );
}