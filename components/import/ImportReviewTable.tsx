"use client";

import { AlertTriangle } from "lucide-react";
import type { ParsedRow } from "@/lib/import/parseImportFile";
import type { StagingFlag } from "@/lib/import/stagingCheck";
import type { RowAction } from "@/lib/import/commitImport";

interface Props {
  parsedRows: ParsedRow[];
  isBaseSection: boolean;
  rowActions: Map<number, RowAction>;
  rowUpdateTarget: Map<number, string>;
  rowParentWarnings: Map<number, string>;
  flagsByRow: Map<number, StagingFlag[]>;
  editingCell: { row: number; field: string } | null;
  onCycleAction: (rowIndex: number) => void;
  onStartEdit: (row: number, field: string) => void;
  onCommitEdit: (rowIndex: number, field: string, value: string) => void;
}

export default function ImportReviewTable({
  parsedRows, isBaseSection, rowActions, rowUpdateTarget, rowParentWarnings,
  flagsByRow, editingCell, onCycleAction, onStartEdit, onCommitEdit,
}: Props) {
  const fields = parsedRows[0] ? Object.keys(parsedRows[0].parsed) : [];

  return (
    <div className="border border-slate-200 rounded-[28px] overflow-auto max-h-[420px] custom-scrollbar">
      <table className="w-full text-left text-[12px] border-collapse min-w-max">
        <thead className="bg-slate-50 border-b border-slate-100 text-slate-400 sticky top-0">
          <tr>
            <th className="p-3 w-20">Action</th>
            <th className="p-3 font-bold uppercase text-[9px] tracking-widest">Row</th>
            {fields.map(f => <th key={f} className="p-3 font-bold uppercase text-[9px] border-l border-slate-100 whitespace-nowrap">{f.replace(/_/g, ' ')}</th>)}
            <th className="p-3 font-bold uppercase text-[9px] border-l border-slate-100">Flags</th>
          </tr>
        </thead>
        <tbody>
          {parsedRows.map(row => {
            const action = rowActions.get(row.rowIndex) || 'include';
            const rowFlags = flagsByRow.get(row.rowIndex) || [];
            const hasExistingMatch = rowUpdateTarget.has(row.rowIndex);
            const parentWarning = rowParentWarnings.get(row.rowIndex);

            return (
              <tr key={row.rowIndex} className={`border-b border-slate-50 ${action === 'skip' ? 'opacity-40 bg-slate-50' : action === 'update' ? 'bg-blue-50/40' : rowFlags.length > 0 ? 'bg-amber-50/30' : ''}`}>
                <td className="p-3 text-center">
                  <button
                    onClick={() => onCycleAction(row.rowIndex)}
                    title={
                      action === 'include' ? 'Click to skip this row' :
                      action === 'skip' ? (hasExistingMatch ? 'Click to update the existing record instead' : 'Click to include as new') :
                      'Click to include as new'
                    }
                    className={`px-2.5 py-1 rounded-full text-[9px] font-bold uppercase tracking-wide transition-all w-full ${action === 'include' ? 'bg-emerald-50 text-emerald-600 hover:bg-emerald-100' : action === 'skip' ? 'bg-slate-100 text-slate-400 hover:bg-slate-200' : 'bg-blue-100 text-blue-700 hover:bg-blue-200'}`}
                  >
                    {action === 'include' ? 'New' : action === 'skip' ? 'Skip' : 'Update'}
                  </button>
                </td>
                <td className="p-3 font-bold text-slate-400">{row.rowIndex}</td>
                {fields.map(field => {
                  const isEditing = editingCell?.row === row.rowIndex && editingCell?.field === field;
                  return (
                    <td key={field} className="p-1 border-l border-slate-50">
                      {isEditing ? (
                        <input autoFocus defaultValue={row.parsed[field] ?? ''}
                          onBlur={(e) => onCommitEdit(row.rowIndex, field, e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                          className="w-full p-2 border border-indigo-300 rounded-lg text-[12px] outline-none" />
                      ) : (
                        <button onClick={() => onStartEdit(row.rowIndex, field)} className="w-full text-left p-2 hover:bg-slate-50 rounded-lg">
                          <span className={row.parsed[field] == null || row.parsed[field] === '' ? 'text-slate-300 italic' : 'text-slate-700 font-medium'}>
                            {row.parsed[field] === null || row.parsed[field] === undefined || row.parsed[field] === '' ? 'empty' : String(row.parsed[field])}
                          </span>
                        </button>
                      )}
                    </td>
                  );
                })}
                <td className="p-3 border-l border-slate-50 max-w-[220px]">
                  {rowFlags.map((f, i) => (
                    <div key={i} className="flex items-start gap-1.5 text-amber-600 mb-1">
                      <AlertTriangle size={11} className="mt-0.5 shrink-0" />
                      <span className="text-[10px] font-medium leading-tight">{f.match_reason} {f.matched_against === 'existing' ? `(existing: ${f.matched_identifier})` : `(${f.matched_identifier})`}</span>
                    </div>
                  ))}
                  {parentWarning && (
                    <div className="flex items-start gap-1.5 text-blue-600">
                      <AlertTriangle size={11} className="mt-0.5 shrink-0" />
                      <span className="text-[10px] font-medium leading-tight">{parentWarning}</span>
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}