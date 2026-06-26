// components/MasterTable.tsx
"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronUp, GripVertical, Trash2, ExternalLink } from "lucide-react";
import DataTable from "@/components/DataTable";
import RelationSubTable from "@/components/RelationSubTable";
import UniversalSelectionModal from "@/components/UniversalSelectionModal";
import RecordEditModal from "@/components/RecordEditModal";
import { updateRecord, softDeleteRecord } from "@/lib/genericRecordActions";
import type { RelationDef } from "@/lib/relationDefinitions";
import type { LogParentType } from "@/lib/logging";
import type { FieldConfig } from "@/components/RecordEditModal";

export interface RelationalEditConfig {
  table: "entities" | "projects" | "properties";
  title: string;
  editParentType: LogParentType;
  editFields: FieldConfig[];
}

export interface MasterTableProps {
  items: any[];
  tableCols: string[];
  expandCols: string[];
  colWidths: Record<string, number>;
  draggedIdx: number | null;
  setDraggedIdx: (i: number | null) => void;
  onReorder: (next: string[]) => void;
  startResizing: (colId: string, e: React.MouseEvent) => void;
  expandedRow: string | null;
  toggleExpandRow: (id: string) => void;
  resolveValue: (item: any, path: string) => any;
  getLinkTarget: (colId: string, item: any) => string | null;
  relations?: RelationDef[];
  expandRelations?: string[];
  minWidth?: number;
  rowKey?: (item: any) => string;
  baseTable?: string;
  parentType?: LogParentType;
  companyId?: string;
  editableCols?: string[];
  // Columns that link to another table AND are edited via this dual
  // mechanism: clicking the word opens a direct edit form for the
  // LINKED record itself; clicking the small icon opens a search/select/
  // create picker to RE-LINK this row to a different record.
  relationalEditCols?: Record<string, RelationalEditConfig>;
  onRowMutated?: () => void;
}

export default function MasterTable({
  items, tableCols, expandCols, colWidths,
  draggedIdx, setDraggedIdx, onReorder, startResizing,
  expandedRow, toggleExpandRow, resolveValue, getLinkTarget,
  relations = [], expandRelations = [],
  minWidth = 1200, rowKey = (item) => item.id,
  baseTable, parentType, companyId, editableCols, relationalEditCols, onRowMutated,
}: MasterTableProps) {
  const router = useRouter();
  const [editingCell, setEditingCell] = useState<{ rowId: string; colId: string } | null>(null);
  const [savingCell, setSavingCell] = useState<{ rowId: string; colId: string } | null>(null);
  const [relationalPicker, setRelationalPicker] = useState<{ item: any; colId: string } | null>(null);
  const [recordEditTarget, setRecordEditTarget] = useState<{
    config: RelationalEditConfig;
    recordId: string;
    currentValues: Record<string, any>;
  } | null>(null);

  const activeRelations = relations.filter(rel => expandRelations.includes(rel.key));
  const canEdit = !!(baseTable && parentType && companyId && editableCols);

  const handleCellSave = async (item: any, colId: string, newValue: string) => {
    if (!canEdit) return;
    setEditingCell(null);

    const originalValue = resolveValue(item, colId);
    if (String(originalValue ?? '') === String(newValue ?? '')) return;

    setSavingCell({ rowId: rowKey(item), colId });

    await updateRecord({
      table: baseTable!,
      id: item.id,
      changes: { [colId]: newValue },
      parentType: parentType!,
      parentId: item.id,
      companyId: companyId!,
      recordLabel: item.street_address || item.name || undefined,
    });

    setSavingCell(null);
    onRowMutated?.();
  };

  const handleRelationalSave = async (id: string, name: string) => {
    if (!relationalPicker || !canEdit) return;
    const { item, colId } = relationalPicker;
    setRelationalPicker(null);
    setSavingCell({ rowId: rowKey(item), colId });

    await updateRecord({
      table: baseTable!,
      id: item.id,
      changes: { [colId]: id },
      parentType: parentType!,
      parentId: item.id,
      companyId: companyId!,
      recordLabel: item.street_address || item.name || undefined,
    });

    setSavingCell(null);
    onRowMutated?.();
  };

  const handleRowDelete = async (item: any, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!canEdit) return;
    const label = item.street_address || item.name || 'this record';
    if (!window.confirm(`Archive ${label}? It will be hidden from lists but not permanently deleted.`)) return;

    await softDeleteRecord({
      table: baseTable!,
      id: item.id,
      parentType: parentType!,
      parentId: item.id,
      companyId: companyId!,
      recordLabel: label,
    });

    onRowMutated?.();
  };

  return (
    <>
      <DataTable minWidth={minWidth}>
        <thead className="bg-slate-50 border-b border-slate-200 text-slate-400">
          <tr>
            {tableCols.map((colId, idx) => (
              <th key={colId} style={{ width: colWidths[colId] || 250 }} className="relative border-r border-slate-100 group/header select-none p-0">
                <div className="flex items-center h-full">
                  <div
                    draggable
                    onDragStart={() => setDraggedIdx(idx)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => {
                      if (draggedIdx === null) return;
                      const next = [...tableCols];
                      const [moved] = next.splice(draggedIdx, 1);
                      next.splice(idx, 0, moved);
                      onReorder(next);
                      setDraggedIdx(null);
                    }}
                    className="p-4 cursor-move opacity-0 group-hover/header:opacity-100 transition-opacity"
                  >
                    <GripVertical size={14} />
                  </div>
                  <div className="flex-1 py-5 uppercase text-[10px] font-bold tracking-widest px-4">
                    {colId.replace('_id', '').replace('.', ' ')}
                  </div>
                  <div onMouseDown={(e) => startResizing(colId, e)} className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-indigo-500 z-10" />
                </div>
              </th>
            ))}
            <th className="w-24"></th>
          </tr>
        </thead>
        <tbody>
          {items.map(item => {
            const key = rowKey(item);
            const isExpanded = expandedRow === key;
            return (
              <React.Fragment key={key}>
                <tr
                  className="border-b border-slate-50 hover:bg-indigo-50/20 transition-all cursor-pointer group"
                  onClick={() => toggleExpandRow(key)}
                >
                  {tableCols.map(colId => {
                    const linkTarget = getLinkTarget(colId, item);
                    const relationalConfig = relationalEditCols?.[colId];
                    const canEditThisCol = canEdit && editableCols!.includes(colId);
                    const isEditing = editingCell?.rowId === key && editingCell?.colId === colId;
                    const isSaving = savingCell?.rowId === key && savingCell?.colId === colId;
                    const rawValue = resolveValue(item, colId);

                    const startEdit = (e: React.MouseEvent) => {
                      e.stopPropagation();
                      if (relationalConfig) {
                        const linkedId = item[colId]; // raw FK value, e.g. item.holding_entity_id
                        if (!linkedId) return; // nothing linked yet — use the icon to link one first
                        setRecordEditTarget({
                          config: relationalConfig,
                          recordId: linkedId,
                          currentValues: item.holding_entity || {},
                        });
                      } else {
                        setEditingCell({ rowId: key, colId });
                      }
                    };

                    const openRelinkPicker = (e: React.MouseEvent) => {
                      e.stopPropagation();
                      if (relationalConfig) {
                        setRelationalPicker({ item, colId });
                      } else if (linkTarget) {
                        router.push(linkTarget);
                      }
                    };

                    return (
                      <td key={colId} className="p-6 border-r border-slate-50 truncate font-medium text-slate-700">
                        {isEditing && !relationalConfig ? (
                          <input
                            autoFocus
                            defaultValue={rawValue ?? ''}
                            onClick={(e) => e.stopPropagation()}
                            onBlur={(e) => handleCellSave(item, colId, e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEditingCell(null); }}
                            className="w-full p-1.5 -m-1.5 border border-indigo-300 rounded-lg text-sm outline-none"
                          />
                        ) : linkTarget ? (
                          <span className="flex items-center justify-between gap-2 group/cell">
                            <span
                              className={`truncate ${canEditThisCol ? 'cursor-text hover:bg-slate-100 -m-1.5 p-1.5 rounded-lg' : ''} ${isSaving ? 'opacity-40' : ''}`}
                              onClick={canEditThisCol ? startEdit : undefined}
                            >
                              {String(rawValue || '-')}
                            </span>
                            <ExternalLink
                              size={11}
                              className="text-slate-300 opacity-0 group-hover/cell:opacity-100 hover:text-indigo-500 shrink-0 transition-all cursor-pointer"
                              onClick={openRelinkPicker}
                            />
                          </span>
                        ) : canEditThisCol ? (
                          <span
                            onClick={startEdit}
                            className={`hover:bg-slate-100 -m-1.5 p-1.5 rounded-lg block cursor-text ${isSaving ? 'opacity-40' : ''}`}
                          >
                            {String(rawValue || '-')}
                          </span>
                        ) : (
                          String(rawValue || '-')
                        )}
                      </td>
                    );
                  })}
                  <td className="p-6 flex items-center justify-center gap-1">
                    {canEdit && (
                      <button
                        onClick={(e) => handleRowDelete(item, e)}
                        className="p-1.5 rounded-full text-slate-300 hover:text-red-500 hover:bg-red-50 transition-all opacity-0 group-hover:opacity-100"
                        title="Archive this record"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                    <button
                      onClick={(e) => { e.stopPropagation(); toggleExpandRow(key); }}
                      className="p-1.5 rounded-full text-slate-300 hover:text-indigo-600 hover:bg-indigo-50 transition-all"
                    >
                      {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                    </button>
                  </td>
                </tr>

                {isExpanded && (expandCols.length > 0 || activeRelations.length > 0) && (
                  <tr className="border-b border-slate-100 bg-slate-50/60">
                    <td colSpan={tableCols.length + 1} className="p-8 space-y-8">
                      {expandCols.length > 0 && (
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
                          {expandCols.map(colId => (
                            <div key={colId}>
                              <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1">
                                {colId.replace('_id', '').replace('.', ' ')}
                              </p>
                              <p className="text-[13px] font-medium text-slate-800 truncate">
                                {String(resolveValue(item, colId) || '—')}
                              </p>
                            </div>
                          ))}
                        </div>
                      )}

                      {activeRelations.map(rel => (
                        <div key={rel.key}>
                          <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-3">
                            {rel.label}
                          </p>
                          <RelationSubTable
                            relation={rel}
                            parentId={item.id}
                            parentType={parentType}
                            companyId={companyId}
                            onMutated={onRowMutated}
                          />
                        </div>
                      ))}
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </DataTable>

      {relationalPicker && relationalEditCols && (
        <UniversalSelectionModal
          isOpen={true}
          onClose={() => setRelationalPicker(null)}
          onSelect={handleRelationalSave}
          title={relationalEditCols[relationalPicker.colId].title}
          table={relationalEditCols[relationalPicker.colId].table}
        />
      )}

      {recordEditTarget && companyId && (
        <RecordEditModal
          title={recordEditTarget.config.title.replace('Select ', '')}
          table={recordEditTarget.config.table}
          recordId={recordEditTarget.recordId}
          fields={recordEditTarget.config.editFields}
          currentValues={recordEditTarget.currentValues}
          parentType={recordEditTarget.config.editParentType}
          companyId={companyId}
          onClose={() => setRecordEditTarget(null)}
          onSaved={() => { setRecordEditTarget(null); onRowMutated?.(); }}
        />
      )}
    </>
  );
}