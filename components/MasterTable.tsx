// components/MasterTable.tsx
"use client";

import React, { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronUp, GripVertical, Trash2, ExternalLink, ChevronsUpDown } from "lucide-react";
import DataTable from "@/components/DataTable";
import RelationSubTable from "@/components/RelationSubTable";
import UniversalSelectionModal from "@/components/UniversalSelectionModal";
import RecordEditModal from "@/components/RecordEditModal";
import { updateRecord, softDeleteRecord } from "@/lib/genericRecordActions";
import type { RelationDef } from "@/lib/relationDefinitions";
import type { LogParentType } from "@/lib/logging";

export interface RelationalEditConfig {
  table: "entities" | "projects" | "properties";
  title: string;
  editParentType: LogParentType;
  editFields: {
    id: string;
    label: string;
    type?: 'text' | 'date' | 'number' | 'checkbox' | 'select';
    options?: any[];
    fetchOptions?: () => Promise<any[]>;
  }[];
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
  isAdmin?: boolean;
  editableCols?: string[];
  relationalEditCols?: Record<string, RelationalEditConfig>;
  onRowMutated?: () => void;
  sort?: { colId: string; direction: 'asc' | 'desc'; mode?: string } | null;
  onSort?: (colId: string, direction: 'asc' | 'desc', mode?: 'name' | 'number') => void;
  addressSortOpen?: boolean;
  onAddressSortOpenChange?: (open: boolean) => void;
  resolveColLabel?: (colId: string) => string;
}

function errorMessage(code: string): string {
  switch (code) {
    case '23505': return "A record with this value already exists — this field must be unique.";
    case '23503': return "This value references a record that doesn't exist.";
    case '23514': return "This value isn't valid for this field (check format or allowed values).";
    case '42501': return "You don't have permission to edit this field.";
    default: return "Couldn't save this change. Please try again.";
  }
}

export default function MasterTable({
  items, tableCols, expandCols, colWidths,
  draggedIdx, setDraggedIdx, onReorder, startResizing,
  expandedRow, toggleExpandRow, resolveValue, getLinkTarget,
  relations = [], expandRelations = [],
  minWidth = 1200, rowKey = (item) => item.id,
  baseTable, parentType, companyId, isAdmin = false, editableCols, relationalEditCols, onRowMutated,
  sort, onSort, addressSortOpen, onAddressSortOpenChange, resolveColLabel,
}: MasterTableProps) {
  const router = useRouter();
  const [editingCell, setEditingCell] = useState<{ rowId: string; colId: string } | null>(null);
  const [savingCell, setSavingCell] = useState<{ rowId: string; colId: string } | null>(null);
  const [cellErrors, setCellErrors] = useState<Map<string, string>>(new Map());
  const [relationalPicker, setRelationalPicker] = useState<{ item: any; colId: string } | null>(null);
  const [recordEditTarget, setRecordEditTarget] = useState<{
    config: RelationalEditConfig;
    recordId: string;
    currentValues: Record<string, any>;
  } | null>(null);

  const activeRelations = relations.filter(rel => expandRelations.includes(rel.key));
  const canEdit = !!(baseTable && parentType && companyId && editableCols);

  // Close address sort dropdown on outside click
  useEffect(() => {
    if (!addressSortOpen) return;
    const handleClick = () => onAddressSortOpenChange?.(false);
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [addressSortOpen, onAddressSortOpenChange]);

  const setCellError = (rowId: string, colId: string, message: string) => {
    const key = `${rowId}:${colId}`;
    setCellErrors(prev => { const next = new Map(prev); next.set(key, message); return next; });
    setTimeout(() => {
      setCellErrors(prev => { const next = new Map(prev); next.delete(key); return next; });
    }, 6000);
  };

  const clearCellError = (rowId: string, colId: string) => {
    setCellErrors(prev => { const next = new Map(prev); next.delete(`${rowId}:${colId}`); return next; });
  };

  const handleCellSave = async (item: any, colId: string, newValue: string) => {
    if (!canEdit) return;
    setEditingCell(null);

    const originalValue = resolveValue(item, colId);
    if (String(originalValue ?? '') === String(newValue ?? '')) return;

    setSavingCell({ rowId: rowKey(item), colId });

    const { error } = await updateRecord({
      table: baseTable!,
      id: item.id,
      changes: { [colId]: newValue },
      parentType: parentType!,
      parentId: item.id,
      companyId: companyId!,
      recordLabel: item.street_address || item.name || undefined,
    });

    setSavingCell(null);

    if (error) {
      setCellError(rowKey(item), colId, errorMessage((error as any).code || ''));
      return;
    }

    clearCellError(rowKey(item), colId);
    onRowMutated?.();
  };

  const handleRelationalSave = async (id: string, name: string) => {
    if (!relationalPicker || !canEdit) return;
    const { item, colId } = relationalPicker;
    setRelationalPicker(null);
    setSavingCell({ rowId: rowKey(item), colId });

    const { error } = await updateRecord({
      table: baseTable!,
      id: item.id,
      changes: { [colId]: id },
      parentType: parentType!,
      parentId: item.id,
      companyId: companyId!,
      recordLabel: item.street_address || item.name || undefined,
    });

    setSavingCell(null);

    if (error) {
      setCellError(rowKey(item), colId, errorMessage((error as any).code || ''));
      return;
    }

    clearCellError(rowKey(item), colId);
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
            {tableCols.map((colId, idx) => {
              const isAddressCol = colId === 'street_address';
              const isActiveSortCol = sort?.colId === colId;

              return (
                <th key={colId} style={{ width: colWidths[colId] || 250 }} className="relative border-r border-slate-100 group/header select-none p-0">
                  <div className="flex items-center h-full">
                    {isAdmin && (
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
                        className="p-4 cursor-move opacity-0 group-hover/header:opacity-100 transition-opacity shrink-0"
                        title="Reorder column (admin only)"
                      >
                        <GripVertical size={14} />
                      </div>
                    )}

                    <div className={`flex-1 py-5 px-2 uppercase text-[10px] font-bold tracking-widest truncate ${isActiveSortCol ? 'text-indigo-600' : ''}`}>
                      {resolveColLabel ? resolveColLabel(colId) : colId.replace('_id', '').replace('.', ' ')}
                    </div>

                    {onSort && (
                      isAddressCol ? (
                        <div className="relative mr-2 shrink-0" onClick={e => e.stopPropagation()}>
                          <button
                            onClick={() => onAddressSortOpenChange?.(!addressSortOpen)}
                            className={`p-1.5 rounded-lg transition-all ${isActiveSortCol ? 'text-indigo-600 bg-indigo-50' : 'text-slate-300 hover:text-slate-500 hover:bg-slate-100 opacity-0 group-hover/header:opacity-100'}`}
                            title="Sort options"
                          >
                            <ChevronsUpDown size={13} />
                          </button>

                          {addressSortOpen && (
                            <div className="absolute top-full left-0 mt-1 bg-white rounded-2xl shadow-lg border border-slate-100 z-50 py-1 min-w-[172px]">
                              {([
                                { label: '# Number (asc)', direction: 'asc' as const, mode: 'number' as const },
                                { label: '# Number (desc)', direction: 'desc' as const, mode: 'number' as const },
                                { label: 'A–Z Street name', direction: 'asc' as const, mode: 'name' as const },
                                { label: 'Z–A Street name', direction: 'desc' as const, mode: 'name' as const },
                              ]).map(opt => {
                                const isActive = sort?.colId === 'street_address' && sort?.direction === opt.direction && sort?.mode === opt.mode;
                                return (
                                  <button
                                    key={opt.label}
                                    onClick={() => onSort('street_address', opt.direction, opt.mode)}
                                    className={`w-full text-left px-4 py-2.5 text-[11px] font-medium transition-colors ${isActive ? 'text-indigo-600 bg-indigo-50' : 'text-slate-600 hover:bg-slate-50'}`}
                                  >
                                    {opt.label}
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      ) : (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (!isActiveSortCol) onSort(colId, 'asc');
                            else if (sort?.direction === 'asc') onSort(colId, 'desc');
                            else onSort(colId, 'asc');
                          }}
                          className={`p-1.5 rounded-lg mr-2 shrink-0 transition-all ${isActiveSortCol ? 'text-indigo-600 bg-indigo-50' : 'text-slate-300 hover:text-slate-500 hover:bg-slate-100 opacity-0 group-hover/header:opacity-100'}`}
                          title={isActiveSortCol ? (sort?.direction === 'asc' ? 'Sort descending' : 'Sort ascending') : 'Sort'}
                        >
                          {isActiveSortCol
                            ? sort?.direction === 'asc' ? <ChevronUp size={13} /> : <ChevronDown size={13} />
                            : <ChevronsUpDown size={13} />
                          }
                        </button>
                      )
                    )}

                    {isAdmin && (
                      <div onMouseDown={(e) => startResizing(colId, e)} className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-indigo-500 z-10" title="Resize column (admin only)" />
                    )}
                  </div>
                </th>
              );
            })}
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
                    const cellError = cellErrors.get(`${key}:${colId}`);

                    const startEdit = (e: React.MouseEvent) => {
                      e.stopPropagation();
                      clearCellError(key, colId);
                      if (relationalConfig) {
                        const linkedId = item[colId];
                        if (!linkedId) return;
                        const alias = colId.replace(/_id$/, '');
                        setRecordEditTarget({
                          config: relationalConfig,
                          recordId: linkedId,
                          currentValues: item[alias] || {},
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
                        ) : cellError ? (
                          // Error state — original value stays, shown red with tooltip
                          <div className="relative group/error">
                            <span
                              onClick={canEditThisCol ? startEdit : undefined}
                              className={`block truncate text-red-500 border-b border-dashed border-red-300 ${canEditThisCol ? 'cursor-text' : ''}`}
                            >
                              {String(rawValue || '-')}
                            </span>
                            <div className="absolute bottom-full left-0 mb-2 z-50 hidden group-hover/error:block pointer-events-none">
                              <div className="bg-red-600 text-white text-[10px] font-medium rounded-xl px-3 py-2 max-w-[240px] leading-relaxed shadow-lg whitespace-normal">
                                {cellError}
                              </div>
                              <div className="w-2 h-2 bg-red-600 rotate-45 ml-4 -mt-1" />
                            </div>
                          </div>
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
                                {resolveColLabel ? resolveColLabel(colId) : colId.replace('_id', '').replace('.', ' ')}
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