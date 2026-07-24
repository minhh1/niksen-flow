"use client";

import { useState, useEffect } from "react";
import { X, GripVertical } from "lucide-react";
import FieldValueInput from "./FieldValueInput";
import { createRecord, updateRecord, deleteRecord } from "@/lib/services/customTableService";
import type { CustomTableField, CustomTableRecord } from "@/lib/hooks/useCustomTable";

const DEFAULT_COLUMN_WIDTH = 140;
const MIN_COLUMN_WIDTH = 80;

interface Props {
  tableId: string;
  companyId: string;
  userId: string; // draft rows create records, same as DashboardQuickAddForm
  fields: CustomTableField[]; // full field list -- formula recompute needs dependencies
  gridFieldIds: string[]; // ordered subset of columns to show
  records: CustomTableRecord[];
  onChanged: () => void;
  // Ledger tables (company_tables.is_ledger) are append-only -- cells render
  // disabled and the delete column is hidden entirely.
  readOnly?: boolean;
  // Blank rows always kept at the bottom for fast entry -- typing into any
  // cell of one creates a new record from it (see DraftRow state below).
  emptyRowCount?: number;
  // Per-column pixel width, keyed by field id -- see GridWidget.config in
  // lib/dashboardWidgets/types.ts. Missing entries fall back to DEFAULT_COLUMN_WIDTH.
  columnWidths?: Record<string, number>;
  // Column reorder (drag the grip handle) / resize (drag the right edge) --
  // both admin-gated and both mirror the exact interaction already
  // established for the system-table master grid (see MasterTable.tsx's
  // draggable header + usePresetTable.ts's startResizing). Omitted
  // entirely (not just disabled) in builder-preview contexts, where the
  // widget's own config panel is the one place to change these instead.
  isAdmin?: boolean;
  onReorder?: (fieldIds: string[]) => void;
  onResize?: (fieldId: string, width: number) => void;
}

// A blank row-in-progress, before it has a real company_table_records row
// (recordId null) and after (recordId set, but not yet reflected in the
// `records` prop -- see the graduation effect below).
interface DraftRow { key: string; recordId: string | null; values: Record<string, any> }

// A lightweight grid scoped to a dashboard's configured columns, distinct
// from components/CustomTableMasterPage.tsx's full-featured master-table
// view (column drawer, search, expand-row) -- this is meant to be one
// section of a composed dashboard, not a standalone page.
export default function DashboardGrid({
  tableId, companyId, userId, fields, gridFieldIds, records, onChanged, readOnly, emptyRowCount = 0,
  columnWidths, isAdmin, onReorder, onResize,
}: Props) {
  const gridFields = gridFieldIds
    .map(id => fields.find(f => f.id === id))
    .filter((f): f is CustomTableField => !!f);

  // Drag-to-reorder state (which column index is currently being dragged).
  const [draggedIdx, setDraggedIdx] = useState<number | null>(null);
  // Drag-to-resize: a transient local override for instant visual feedback
  // while dragging, layered over the persisted `columnWidths` prop; cleared
  // on mouseup once onResize has handed the final width off to the parent
  // to persist (mirrors usePresetTable.ts's startResizing exactly, just
  // inlined here since this grid doesn't have an equivalent shared hook).
  const [liveWidths, setLiveWidths] = useState<Record<string, number> | null>(null);
  const widthFor = (fieldId: string) => (liveWidths ?? columnWidths ?? {})[fieldId] || DEFAULT_COLUMN_WIDTH;

  const startResizing = (fieldId: string, e: React.MouseEvent) => {
    if (!isAdmin || !onResize) return;
    const startX = e.pageX;
    const startWidth = widthFor(fieldId);
    let latest = startWidth;
    const onMouseMove = (mE: MouseEvent) => {
      latest = Math.max(MIN_COLUMN_WIDTH, startWidth + (mE.pageX - startX));
      setLiveWidths(prev => ({ ...(prev ?? columnWidths ?? {}), [fieldId]: latest }));
    };
    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      setLiveWidths(null);
      onResize(fieldId, latest);
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  };

  const handleDrop = (targetIdx: number) => {
    if (draggedIdx === null || !onReorder) return;
    const next = [...gridFieldIds];
    const [moved] = next.splice(draggedIdx, 1);
    next.splice(targetIdx, 0, moved);
    onReorder(next);
    setDraggedIdx(null);
  };

  // Optimistic local edits (recordId -> field_key -> value), rendered ahead
  // of the network round-trip so e.g. ticking a checkbox reflects instantly
  // instead of waiting on updateRecord + the subsequent refetch. Cleared
  // per-key once `records` (the real data, from onChanged's refetch) agrees
  // with the override, or immediately on a failed write.
  const [overrides, setOverrides] = useState<Record<string, Record<string, any>>>({});

  useEffect(() => {
    setOverrides(prev => {
      let changed = false;
      const next: Record<string, Record<string, any>> = {};
      for (const [recordId, fieldOverrides] of Object.entries(prev)) {
        const record = records.find(r => r.id === recordId);
        const remaining: Record<string, any> = {};
        for (const [key, val] of Object.entries(fieldOverrides)) {
          if (record && record.values[key] === val) changed = true;
          else remaining[key] = val;
        }
        if (Object.keys(remaining).length) next[recordId] = remaining;
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [records]);

  const valueFor = (record: CustomTableRecord, field: CustomTableField) =>
    overrides[record.id]?.[field.field_key] ?? record.values[field.field_key];

  const handleCellCommit = async (recordId: string, field: CustomTableField, value: any) => {
    setOverrides(prev => ({ ...prev, [recordId]: { ...prev[recordId], [field.field_key]: value } }));
    const result = await updateRecord(recordId, tableId, companyId, { [field.field_key]: value }, fields);
    if (result && 'error' in result) {
      window.alert(result.error);
      setOverrides(prev => {
        const { [field.field_key]: _removed, ...rest } = prev[recordId] || {};
        return { ...prev, [recordId]: rest };
      });
      return;
    }
    onChanged();
  };

  const handleDelete = async (recordId: string) => {
    if (!window.confirm('Delete this entry? It can be restored from Trash.')) return;
    const result = await deleteRecord(recordId);
    if (result && 'error' in result) window.alert(result.error);
    onChanged();
  };

  // Ledger tables can only be created through the quick-add form's
  // single-shot flow (a second commit on an unrefreshed draft would hit the
  // ledger's append-only guard) -- see readOnly's own doc comment.
  const showDraftRows = emptyRowCount > 0 && !readOnly;
  const [draftRows, setDraftRows] = useState<DraftRow[]>([]);

  // Keeps exactly `emptyRowCount` blank drafts available: drops a draft once
  // its created record shows up in `records` (a real refetch landed, so it
  // now renders through the normal records.map below instead) and tops back
  // up to the configured count.
  useEffect(() => {
    if (!showDraftRows) { setDraftRows([]); return; }
    setDraftRows(prev => {
      const remaining = prev.filter(d => !d.recordId || !records.some(r => r.id === d.recordId));
      const blanks = remaining.filter(d => !d.recordId).length;
      const need = Math.max(0, emptyRowCount - blanks);
      const additions: DraftRow[] = Array.from({ length: need }, () => ({
        key: crypto.randomUUID(), recordId: null, values: {},
      }));
      return need > 0 || remaining.length !== prev.length ? [...remaining, ...additions] : prev;
    });
  }, [records, emptyRowCount, showDraftRows]);

  const handleDraftCommit = async (draftKey: string, field: CustomTableField, value: any) => {
    const draft = draftRows.find(d => d.key === draftKey);
    if (!draft) return;
    const nextValues = { ...draft.values, [field.field_key]: value };
    setDraftRows(prev => prev.map(d => d.key === draftKey ? { ...d, values: nextValues } : d));

    if (!draft.recordId) {
      const record = await createRecord(tableId, companyId, userId, nextValues, fields);
      if (record && 'error' in record) { window.alert(record.error); return; }
      if (record) {
        setDraftRows(prev => prev.map(d => d.key === draftKey ? { ...d, recordId: record.id } : d));
        onChanged();
      }
      return;
    }
    const result = await updateRecord(draft.recordId, tableId, companyId, { [field.field_key]: value }, fields);
    if (result && 'error' in result) { window.alert(result.error); return; }
    onChanged();
  };

  if (gridFields.length === 0) {
    return <p className="text-center text-[11px] text-slate-300 italic py-6">No columns configured</p>;
  }

  return (
    <div className="overflow-x-auto border border-slate-200 rounded-2xl bg-white">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="border-b border-slate-100 bg-slate-50">
            {gridFields.map((f, idx) => (
              <th
                key={f.id}
                style={{ width: widthFor(f.id), minWidth: widthFor(f.id) }}
                className="relative text-left px-0 py-0 text-[9px] font-bold text-slate-400 uppercase tracking-widest group/header select-none"
              >
                <div className="flex items-center h-full">
                  {isAdmin && onReorder && (
                    <div
                      draggable
                      onDragStart={() => setDraggedIdx(idx)}
                      onDragOver={e => e.preventDefault()}
                      onDrop={() => handleDrop(idx)}
                      className="pl-3 py-2.5 cursor-move opacity-0 group-hover/header:opacity-100 transition-opacity shrink-0"
                      title="Reorder column (admin only)"
                    >
                      <GripVertical size={11} />
                    </div>
                  )}
                  <div className={`flex-1 py-2.5 truncate whitespace-nowrap ${isAdmin && onReorder ? 'px-2' : 'px-4'}`}>
                    {f.label}
                  </div>
                  {isAdmin && onResize && (
                    <div
                      onMouseDown={e => startResizing(f.id, e)}
                      className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-indigo-500 z-10"
                      title="Resize column (admin only)"
                    />
                  )}
                </div>
              </th>
            ))}
            {!readOnly && <th className="w-10" />}
          </tr>
        </thead>
        <tbody>
          {records.map(r => (
            <tr key={r.id} className="border-b border-slate-50 hover:bg-slate-50/50 transition-colors">
              {gridFields.map(f => (
                <td key={f.id} className="px-4 py-2" style={{ width: widthFor(f.id), minWidth: widthFor(f.id), maxWidth: widthFor(f.id) }}>
                  <FieldValueInput
                    field={f}
                    value={valueFor(r, f)}
                    onCommit={v => handleCellCommit(r.id, f, v)}
                    disabled={readOnly}
                    displayValue={r.displayValues[f.field_key]}
                  />
                </td>
              ))}
              {!readOnly && (
                <td className="px-2">
                  <button onClick={() => handleDelete(r.id)} className="p-1 text-slate-300 hover:text-red-500 transition-colors">
                    <X size={13} />
                  </button>
                </td>
              )}
            </tr>
          ))}
          {showDraftRows && draftRows.map(draft => (
            <tr key={draft.key} className="border-b border-slate-50">
              {gridFields.map(f => (
                <td key={f.id} className="px-4 py-2" style={{ width: widthFor(f.id), minWidth: widthFor(f.id), maxWidth: widthFor(f.id) }}>
                  <FieldValueInput
                    field={f}
                    value={draft.values[f.field_key]}
                    onCommit={v => handleDraftCommit(draft.key, f, v)}
                  />
                </td>
              ))}
              <td className="px-2" />
            </tr>
          ))}
          {records.length === 0 && !(showDraftRows && draftRows.length > 0) && (
            <tr>
              <td colSpan={gridFields.length + (readOnly ? 0 : 1)} className="text-center py-8 text-[11px] text-slate-300 italic">
                No entries yet
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
