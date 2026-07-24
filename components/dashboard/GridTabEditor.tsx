"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Loader2, Plus, Combine, Split, Save, Type, Database } from "lucide-react";
import { supabase } from "@/lib/supabase";
import type { CustomTableField } from "@/lib/hooks/useCustomTable";
import FieldValueInput, { valueColumnFor } from "./FieldValueInput";
import { useProgressBarWhile } from "@/components/TopProgressBar";
import { relationCandidates as computeRelationCandidates, parentKindLabel, type ParentSystemTable } from "@/lib/dashboardWidgets/linkField";

const COLS = 3;

interface GridCell {
  key: string;
  id?: string;
  row_start: number;
  col_start: number;
  row_span: number;
  col_span: number;
  cell_type: 'static' | 'field';
  content: string | null;
  field_id: string | null;
}

interface RecordRow {
  id: string;
  values: Record<string, any>; // field_id → raw value
}

interface Props {
  tabId: string;
  linkedTableId: string;
  recordId: string;
  companyId: string;
  isEditing: boolean;
  recordSystemTable?: ParentSystemTable;
}

const newKey = () =>
  (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));

// Fill in a 1x1 static cell for every grid position not covered by an anchor's span.
function normalize(anchors: GridCell[], rows: number): GridCell[] {
  const covered = new Set<string>();
  anchors.forEach(a => {
    for (let r = a.row_start; r < a.row_start + a.row_span; r++)
      for (let c = a.col_start; c < a.col_start + a.col_span; c++)
        if (!(r === a.row_start && c === a.col_start)) covered.add(`${r}:${c}`);
  });
  const anchorAt = new Set(anchors.map(a => `${a.row_start}:${a.col_start}`));
  const result = [...anchors];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < COLS; c++) {
      const key = `${r}:${c}`;
      if (covered.has(key) || anchorAt.has(key)) continue;
      result.push({
        key: newKey(), row_start: r, col_start: c, row_span: 1, col_span: 1,
        cell_type: 'static', content: '', field_id: null,
      });
    }
  return result;
}

function coalesce(v: any): any {
  return v.value_text ?? v.value_number ?? v.value_date ?? v.value_boolean ?? v.value_record_id ?? null;
}

export default function GridTabEditor({ tabId, linkedTableId, recordId, companyId, isEditing, recordSystemTable }: Props) {
  const [loading, setLoading] = useState(true);
  const [fields, setFields] = useState<CustomTableField[]>([]);
  const [cells, setCells] = useState<GridCell[]>([]);
  const [rows, setRows] = useState(4);
  const [linkFieldId, setLinkFieldId] = useState<string | null>(null);
  const [hasSavedLayout, setHasSavedLayout] = useState(false);
  const [saving, setSaving] = useState(false);

  // Design-mode drag selection
  const [selStart, setSelStart] = useState<{ r: number; c: number } | null>(null);
  const [selEnd, setSelEnd] = useState<{ r: number; c: number } | null>(null);
  const selectingRef = useRef(false);

  // Display-mode records
  const [records, setRecords] = useState<RecordRow[]>([]);
  const [addingRecord, setAddingRecord] = useState(false);

  const fieldMap = new Map(fields.map(f => [f.id, f]));

  // ── Load fields + saved layout + link field ──────────────────────
  useEffect(() => {
    let active = true;
    setLoading(true);
    (async () => {
      const [{ data: flds }, { data: savedCells }, { data: tab }] = await Promise.all([
        supabase.from('company_table_fields').select('*').eq('table_id', linkedTableId).is('deleted_at', null).order('display_order'),
        supabase.from('record_tab_grid_cells').select('*').eq('tab_id', tabId).order('display_order'),
        supabase.from('record_tabs').select('link_field_id').eq('id', tabId).single(),
      ]);
      if (!active) return;

      const fieldList = (flds || []) as CustomTableField[];
      setFields(fieldList);

      const anchors: GridCell[] = (savedCells || []).map((c: any) => ({
        key: c.id, id: c.id,
        row_start: c.row_start, col_start: c.col_start,
        row_span: c.row_span, col_span: c.col_span,
        cell_type: c.cell_type, content: c.content, field_id: c.field_id,
      }));
      setHasSavedLayout(anchors.length > 0);
      const maxRow = anchors.reduce((m, a) => Math.max(m, a.row_start + a.row_span), 0);
      const rowCount = Math.max(4, maxRow);
      setRows(rowCount);
      setCells(normalize(anchors, rowCount));

      // Resolve link field — auto-set if exactly one field on the linked
      // table plausibly points back at this parent record (scoped to the
      // parent's own system table when known, so an unrelated relation
      // field of a different kind on the same table doesn't cause a false
      // ambiguity — see lib/dashboardWidgets/linkField.ts).
      let lf: string | null = tab?.link_field_id ?? null;
      if (!lf) {
        const candidates = computeRelationCandidates(fieldList, recordSystemTable);
        if (candidates.length === 1) {
          lf = candidates[0].id;
          await supabase.from('record_tabs').update({ link_field_id: lf }).eq('id', tabId);
        }
      }
      setLinkFieldId(lf);
      setLoading(false);
    })();
    return () => { active = false; };
  }, [tabId, linkedTableId, recordSystemTable]);

  // ── Load records (display mode) ──────────────────────────────────
  const loadRecords = useCallback(async () => {
    if (!linkFieldId) { setRecords([]); return; }
    const { data } = await supabase
      .from('company_table_records')
      .select('id, values:company_table_values(field_id, value_text, value_number, value_date, value_boolean, value_record_id)')
      .eq('table_id', linkedTableId)
      .is('deleted_at', null)
      .order('created_at', { ascending: true });

    const matched: RecordRow[] = [];
    (data || []).forEach((rec: any) => {
      const values: Record<string, any> = {};
      let linksHere = false;
      (rec.values || []).forEach((v: any) => {
        values[v.field_id] = coalesce(v);
        if (v.field_id === linkFieldId && v.value_record_id === recordId) linksHere = true;
      });
      if (linksHere) matched.push({ id: rec.id, values });
    });

    // allow_multiple fields hold their links in a separate junction table
    // (see supabase/company_table_field_allow_multiple.sql) -- overwrite
    // those fields' values with the real string[] once loaded, same as
    // useCustomTable.ts's load().
    const multiFields = fields.filter(f => f.allow_multiple);
    if (multiFields.length && matched.length) {
      const { data: links } = await supabase
        .from('company_table_value_links')
        .select('record_id, field_id, value_record_id')
        .in('field_id', multiFields.map(f => f.id))
        .in('record_id', matched.map(r => r.id));
      const byRecordField = new Map<string, string[]>();
      (links || []).forEach(l => {
        const key = `${l.record_id}:${l.field_id}`;
        (byRecordField.get(key) || byRecordField.set(key, []).get(key)!).push(l.value_record_id);
      });
      matched.forEach(r => {
        multiFields.forEach(f => { r.values[f.id] = byRecordField.get(`${r.id}:${f.id}`) || []; });
      });
    }

    setRecords(matched);
  }, [linkFieldId, linkedTableId, recordId, fields]);

  useEffect(() => {
    if (!isEditing) loadRecords();
  }, [isEditing, loadRecords]);

  // ── Selection helpers ────────────────────────────────────────────
  useEffect(() => {
    const onUp = () => { selectingRef.current = false; };
    window.addEventListener('mouseup', onUp);
    return () => window.removeEventListener('mouseup', onUp);
  }, []);

  useProgressBarWhile(loading);

  const selRect = () => {
    if (!selStart || !selEnd) return null;
    return {
      r0: Math.min(selStart.r, selEnd.r), r1: Math.max(selStart.r, selEnd.r),
      c0: Math.min(selStart.c, selEnd.c), c1: Math.max(selStart.c, selEnd.c),
    };
  };
  const inSelection = (r: number, c: number) => {
    const rect = selRect();
    return rect ? r >= rect.r0 && r <= rect.r1 && c >= rect.c0 && c <= rect.c1 : false;
  };

  const startSelect = (r: number, c: number) => { selectingRef.current = true; setSelStart({ r, c }); setSelEnd({ r, c }); };
  const extendSelect = (r: number, c: number) => { if (selectingRef.current) setSelEnd({ r, c }); };

  const mergeSelection = () => {
    const rect = selRect();
    if (!rect || (rect.r0 === rect.r1 && rect.c0 === rect.c1)) return;
    setCells(prev => prev
      .filter(cell => {
        const inside = cell.row_start >= rect.r0 && cell.row_start <= rect.r1 &&
          cell.col_start >= rect.c0 && cell.col_start <= rect.c1;
        return !inside || (cell.row_start === rect.r0 && cell.col_start === rect.c0);
      })
      .map(cell => (cell.row_start === rect.r0 && cell.col_start === rect.c0)
        ? { ...cell, row_span: rect.r1 - rect.r0 + 1, col_span: rect.c1 - rect.c0 + 1 }
        : cell));
    setSelStart(null); setSelEnd(null);
  };

  const unmerge = (cell: GridCell) => {
    setCells(prev => normalize(
      prev.map(c => c.key === cell.key ? { ...c, row_span: 1, col_span: 1 } : c),
      rows
    ));
  };

  const updateCell = (key: string, patch: Partial<GridCell>) =>
    setCells(prev => prev.map(c => c.key === key ? { ...c, ...patch } : c));

  const addRow = () => {
    const nr = rows + 1;
    setCells(prev => normalize(prev, nr));
    setRows(nr);
  };

  const saveLayout = async () => {
    setSaving(true);
    await supabase.from('record_tab_grid_cells').delete().eq('tab_id', tabId);
    const payload = cells.map((c, i) => ({
      tab_id: tabId,
      row_start: c.row_start, col_start: c.col_start,
      row_span: c.row_span, col_span: c.col_span,
      cell_type: c.cell_type,
      content: c.cell_type === 'static' ? (c.content || null) : null,
      field_id: c.cell_type === 'field' ? c.field_id : null,
      display_order: i,
    }));
    if (payload.length) await supabase.from('record_tab_grid_cells').insert(payload);
    setHasSavedLayout(payload.length > 0);
    setSaving(false);
  };

  const setLinkField = async (fid: string) => {
    setLinkFieldId(fid || null);
    await supabase.from('record_tabs').update({ link_field_id: fid || null }).eq('id', tabId);
  };

  // ── Value editing (display mode) ─────────────────────────────────
  const commitValue = async (recId: string, field: CustomTableField, value: any) => {
    // allow_multiple relation fields hold a string[] of linked ids -- can't
    // go through the single-value_record_id upsert below (see
    // supabase/company_table_field_allow_multiple.sql), so they're routed
    // to company_table_value_links instead, same replace-all approach as
    // saveValues in lib/services/customTableService.ts.
    if (field.allow_multiple) {
      const ids: string[] = Array.isArray(value) ? value.filter(Boolean) : [];
      await supabase.from('company_table_value_links').delete().eq('record_id', recId).eq('field_id', field.id);
      if (ids.length) {
        await supabase.from('company_table_value_links').insert(
          ids.map(id => ({ company_id: companyId, record_id: recId, field_id: field.id, value_record_id: id }))
        );
      }
      setRecords(prev => prev.map(r => r.id === recId ? { ...r, values: { ...r.values, [field.id]: ids } } : r));
      return;
    }
    const col = valueColumnFor(field.field_type);
    await supabase.from('company_table_values').upsert({
      company_id: companyId,
      table_id: linkedTableId,
      record_id: recId,
      field_id: field.id,
      [col]: value,
    }, { onConflict: 'record_id,field_id' });
    setRecords(prev => prev.map(r => r.id === recId ? { ...r, values: { ...r.values, [field.id]: value } } : r));
  };

  const addRecord = async () => {
    if (!linkFieldId) return;
    setAddingRecord(true);
    const { data: { user } } = await supabase.auth.getUser();
    const { data: rec } = await supabase
      .from('company_table_records')
      .insert({ table_id: linkedTableId, company_id: companyId, created_by: user?.id })
      .select('id').single();
    if (rec) {
      await supabase.from('company_table_values').insert({
        company_id: companyId,
        table_id: linkedTableId,
        record_id: rec.id,
        field_id: linkFieldId,
        value_record_id: recordId,
      });
      setRecords(prev => [...prev, { id: rec.id, values: { [linkFieldId]: recordId } }]);
    }
    setAddingRecord(false);
  };

  const relationCandidates = computeRelationCandidates(fields, recordSystemTable);
  const parentKind = parentKindLabel(recordSystemTable);

  if (loading) return null;

  const gridStyle = { gridTemplateColumns: `repeat(${COLS}, minmax(0, 1fr))` } as const;

  // ── Design mode ──────────────────────────────────────────────────
  if (isEditing) {
    const rect = selRect();
    const canMerge = rect && !(rect.r0 === rect.r1 && rect.c0 === rect.c1);
    return (
      <div className="space-y-5">
        {/* Toolbar */}
        <div className="flex items-center gap-3 flex-wrap">
          <button
            onClick={mergeSelection}
            disabled={!canMerge}
            className="inline-flex items-center gap-2 px-4 py-2 bg-slate-900 text-white rounded-full text-[11px] font-bold disabled:opacity-30"
          >
            <Combine size={13} /> Merge cells
          </button>
          <button
            onClick={addRow}
            className="inline-flex items-center gap-2 px-4 py-2 bg-slate-50 text-slate-600 hover:bg-slate-100 rounded-full text-[11px] font-bold"
          >
            <Plus size={13} /> Add row
          </button>
          <button
            onClick={saveLayout}
            disabled={saving}
            className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-full text-[11px] font-bold disabled:opacity-50 ml-auto"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />} Save layout
          </button>
        </div>

        {/* Link-field selector — only prompt if unresolved and ambiguous */}
        {(!linkFieldId && relationCandidates.length > 1) && (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
            <label className="text-[9px] font-bold text-amber-700 uppercase tracking-widest block mb-1.5">
              Which field links a record to this {parentKind}?
            </label>
            <select
              value={linkFieldId || ''}
              onChange={e => setLinkField(e.target.value)}
              className="w-full bg-white border border-amber-200 rounded-full py-2.5 px-4 text-sm font-medium outline-none appearance-none"
            >
              <option value="">Select a field...</option>
              {relationCandidates.map(f => (
                <option key={f.id} value={f.id}>{f.label}</option>
              ))}
            </select>
          </div>
        )}
        {linkFieldId && relationCandidates.length > 1 && (
          <div className="text-[10px] font-medium text-slate-400 px-1">
            Link field:{' '}
            <select
              value={linkFieldId}
              onChange={e => setLinkField(e.target.value)}
              className="bg-slate-50 border border-slate-200 rounded-full py-1 px-3 text-[11px] font-bold outline-none appearance-none"
            >
              {relationCandidates.map(f => (
                <option key={f.id} value={f.id}>{f.label}</option>
              ))}
            </select>
          </div>
        )}

        {/* Editable grid */}
        <div className="grid gap-2 select-none" style={gridStyle}>
          {cells.map(cell => (
            <div
              key={cell.key}
              onMouseDown={() => startSelect(cell.row_start, cell.col_start)}
              onMouseEnter={() => extendSelect(cell.row_start, cell.col_start)}
              style={{
                gridColumn: `${cell.col_start + 1} / span ${cell.col_span}`,
                gridRow: `${cell.row_start + 1} / span ${cell.row_span}`,
              }}
              className={`rounded-2xl border-2 p-3 transition-all ${
                inSelection(cell.row_start, cell.col_start)
                  ? 'border-indigo-500 bg-indigo-50/50'
                  : 'border-slate-100 bg-white hover:border-slate-200'
              }`}
            >
              <div className="flex items-center gap-1.5 mb-2" onMouseDown={e => e.stopPropagation()}>
                <button
                  onClick={() => updateCell(cell.key, { cell_type: 'static' })}
                  className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-[9px] font-bold uppercase tracking-widest ${
                    cell.cell_type === 'static' ? 'bg-slate-900 text-white' : 'bg-slate-50 text-slate-400'
                  }`}
                >
                  <Type size={10} /> Static
                </button>
                <button
                  onClick={() => updateCell(cell.key, { cell_type: 'field' })}
                  className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-[9px] font-bold uppercase tracking-widest ${
                    cell.cell_type === 'field' ? 'bg-indigo-600 text-white' : 'bg-slate-50 text-slate-400'
                  }`}
                >
                  <Database size={10} /> Field
                </button>
                {(cell.row_span > 1 || cell.col_span > 1) && (
                  <button
                    onClick={() => unmerge(cell)}
                    title="Split"
                    className="ml-auto p-1 text-slate-300 hover:text-slate-600"
                  >
                    <Split size={12} />
                  </button>
                )}
              </div>

              <div onMouseDown={e => e.stopPropagation()}>
                {cell.cell_type === 'static' ? (
                  <input
                    value={cell.content || ''}
                    onChange={e => updateCell(cell.key, { content: e.target.value })}
                    placeholder="Static text…"
                    className="w-full bg-slate-50 border border-slate-200 rounded-full py-2 px-3.5 text-[13px] font-medium outline-none focus:ring-2 focus:ring-indigo-100"
                  />
                ) : (
                  <select
                    value={cell.field_id || ''}
                    onChange={e => updateCell(cell.key, { field_id: e.target.value || null })}
                    className="w-full bg-slate-50 border border-slate-200 rounded-full py-2 px-3.5 text-[13px] font-medium outline-none appearance-none"
                  >
                    <option value="">Select field…</option>
                    {fields.map(f => (
                      <option key={f.id} value={f.id}>{f.label}</option>
                    ))}
                  </select>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ── Display mode ─────────────────────────────────────────────────
  if (!hasSavedLayout) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-2 text-center">
        <p className="text-slate-300 text-[11px] font-bold uppercase tracking-widest">No layout yet</p>
        <p className="text-[12px] text-slate-400">Switch to edit mode to design this tab’s layout.</p>
      </div>
    );
  }

  if (!linkFieldId) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-2 text-center">
        <p className="text-slate-300 text-[11px] font-bold uppercase tracking-widest">Not configured</p>
        <p className="text-[12px] text-slate-400">Switch to edit mode and pick the field that links a record to this {parentKind}.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {records.length === 0 && (
        <div className="text-center py-10 text-slate-300 text-[11px] font-bold uppercase tracking-widest">
          No records yet
        </div>
      )}
      {records.map(rec => (
        <div key={rec.id} className="rounded-2xl border border-slate-100 bg-white p-4">
          <div className="grid gap-2" style={gridStyle}>
            {cells.map(cell => (
              <div
                key={cell.key}
                style={{
                  gridColumn: `${cell.col_start + 1} / span ${cell.col_span}`,
                  gridRow: `${cell.row_start + 1} / span ${cell.row_span}`,
                }}
              >
                {cell.cell_type === 'static' ? (
                  cell.content ? (
                    <div className="text-[13px] font-semibold text-slate-700 py-2">{cell.content}</div>
                  ) : null
                ) : cell.field_id && fieldMap.get(cell.field_id) ? (
                  <div>
                    <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block mb-1">
                      {fieldMap.get(cell.field_id)!.label}
                    </label>
                    <FieldValueInput
                      field={fieldMap.get(cell.field_id)!}
                      value={rec.values[cell.field_id]}
                      onCommit={v => commitValue(rec.id, fieldMap.get(cell.field_id!)!, v)}
                    />
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ))}

      <button
        onClick={addRecord}
        disabled={addingRecord}
        className="inline-flex items-center gap-2 px-5 py-2.5 bg-slate-900 text-white rounded-full text-[11px] font-bold disabled:opacity-50"
      >
        {addingRecord ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} Add record
      </button>
    </div>
  );
}
