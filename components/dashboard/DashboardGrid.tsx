"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { X, GripVertical, Maximize2 } from "lucide-react";
import FieldValueInput from "./FieldValueInput";
import { updateRecord, deleteRecord } from "@/lib/services/customTableService";
import { evaluateCondition } from "@/lib/dashboardWidgets/compute";
import type { CustomTableField, CustomTableRecord } from "@/lib/hooks/useCustomTable";
import type { GridWidget } from "@/lib/dashboardWidgets/types";

const DEFAULT_COLUMN_WIDTH = 140;
const MIN_COLUMN_WIDTH = 80;

// Tailwind needs literal class strings, not template-built ones -- this map
// is what makes the 'red' | 'amber' | 'emerald' union in GridWidget.config
// actually render instead of purging.
const HIGHLIGHT_BG: Record<string, string> = {
  red: 'bg-red-50', amber: 'bg-amber-50', emerald: 'bg-emerald-50',
};

interface Props {
  tableId: string;
  companyId: string;
  fields: CustomTableField[]; // full field list -- formula recompute needs dependencies
  gridFieldIds: string[]; // ordered subset of columns to show
  records: CustomTableRecord[];
  onChanged: () => void;
  // Ledger tables (company_tables.is_ledger) are append-only -- cells render
  // disabled and the delete column is hidden entirely.
  readOnly?: boolean;
  // Blank rows always kept at the bottom -- purely visual padding (a table
  // with only 1-2 real rows otherwise looks sparse/broken next to its
  // sibling widgets), NOT an editable fast-entry surface -- see the
  // fullscreenHref doc comment below for how a spreadsheet-style multi-row
  // entry flow is offered instead.
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
  // Per-column conditional cell highlight -- see GridWidget.config in
  // lib/dashboardWidgets/types.ts. Needs fieldById (not just `fields`) since
  // a highlight's condition can reference any field, not just the column
  // it's attached to.
  columnHighlights?: GridWidget['config']['columnHighlights'];
  fieldById?: Map<string, CustomTableField>;
  // Appends a footer row summing every number/currency gridField across the
  // (filtered) `records` prop -- see GridWidget.config in
  // lib/dashboardWidgets/types.ts.
  showTotalsRow?: boolean;
  // Link target for the fullscreen-expand button (top-right of the grid) --
  // the source table's own full master-table page (/dashboard/<slug>, see
  // CustomTableMasterPage), which shows every field (not just this widget's
  // configured subset) and has real spreadsheet-style multi-row entry.
  // Undefined hides the button entirely -- see DashboardWidgetRenderer's
  // sourceTableSlug doc comment for which contexts have it.
  fullscreenHref?: string;
}

// Same formatting as DashboardSummaryTiles' formatTileValue -- duplicated
// rather than shared, matching this widget system's existing per-file
// convention (see dsl.ts's serialize functions) rather than introducing a
// cross-component import for two lines of Intl formatting.
function formatTotal(value: number, fieldType: string): string {
  if (fieldType === 'currency') {
    return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

// A lightweight grid scoped to a dashboard's configured columns, distinct
// from components/CustomTableMasterPage.tsx's full-featured master-table
// view (column drawer, search, expand-row) -- this is meant to be one
// section of a composed dashboard, not a standalone page.
export default function DashboardGrid({
  tableId, companyId, fields, gridFieldIds, records, onChanged, readOnly, emptyRowCount = 0,
  columnWidths, isAdmin, onReorder, onResize, columnHighlights, fieldById, showTotalsRow, fullscreenHref,
}: Props) {
  const gridFields = gridFieldIds
    .map(id => fields.find(f => f.id === id))
    .filter((f): f is CustomTableField => !!f);

  const highlightBgFor = (record: CustomTableRecord, fieldId: string): string => {
    const rule = columnHighlights?.[fieldId];
    if (!rule || !fieldById) return '';
    const condField = fieldById.get(rule.condition.fieldId);
    if (!condField) return '';
    return evaluateCondition(rule.condition, record.values[condField.field_key]) ? HIGHLIGHT_BG[rule.color] || '' : '';
  };

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

  // Purely visual padding rows -- see emptyRowCount's doc comment. Not
  // offered on ledger tables (nothing here is editable anyway, but a ledger
  // grid also always renders exactly its real rows, no filler).
  const paddingRowCount = readOnly ? 0 : emptyRowCount;

  if (gridFields.length === 0) {
    return <p className="text-center text-[11px] text-slate-300 italic py-6">No columns configured</p>;
  }

  return (
    <div className="border border-slate-200 rounded-2xl bg-white overflow-hidden">
      {fullscreenHref && (
        <div className="flex justify-end px-3 py-1.5 border-b border-slate-100">
          <Link
            href={fullscreenHref}
            title="Open full view (all fields)"
            className="flex items-center gap-1.5 text-[10px] font-bold text-slate-400 hover:text-indigo-600 transition-colors"
          >
            <Maximize2 size={12} /> Full screen
          </Link>
        </div>
      )}
      <div className="overflow-x-auto">
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
                    {f.label}{f.is_required && <span className="text-red-400 ml-1">*</span>}
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
                <td key={f.id} className={`px-4 py-2 ${highlightBgFor(r, f.id)}`} style={{ width: widthFor(f.id), minWidth: widthFor(f.id), maxWidth: widthFor(f.id) }}>
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
          {Array.from({ length: paddingRowCount }, (_, i) => (
            <tr key={`pad-${i}`} className="border-b border-slate-50 select-none" aria-hidden="true">
              {gridFields.map(f => (
                <td key={f.id} className="px-4 py-2" style={{ width: widthFor(f.id), minWidth: widthFor(f.id), maxWidth: widthFor(f.id) }} />
              ))}
              <td className="px-2" />
            </tr>
          ))}
          {records.length === 0 && paddingRowCount === 0 && (
            <tr>
              <td colSpan={gridFields.length + (readOnly ? 0 : 1)} className="text-center py-8 text-[11px] text-slate-300 italic">
                No entries yet
              </td>
            </tr>
          )}
        </tbody>
        {showTotalsRow && (
          <tfoot>
            <tr className="border-t border-slate-200 bg-slate-50 font-bold">
              {gridFields.map((f, idx) => (
                <td key={f.id} className="px-4 py-2 text-[11px] text-slate-700" style={{ width: widthFor(f.id), minWidth: widthFor(f.id), maxWidth: widthFor(f.id) }}>
                  {f.field_type === 'number' || f.field_type === 'currency'
                    ? formatTotal(records.reduce((sum, r) => sum + (Number(r.values[f.field_key]) || 0), 0), f.field_type)
                    : idx === 0 ? 'Total' : ''}
                </td>
              ))}
              {!readOnly && <td className="px-2" />}
            </tr>
          </tfoot>
        )}
      </table>
      </div>
    </div>
  );
}
