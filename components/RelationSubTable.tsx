"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { Loader2, Pencil, Trash2 } from "lucide-react";
import type { RelationDef } from "@/lib/relationDefinitions";
import type { LogParentType } from "@/lib/logging";
import { updateRecord, softDeleteRecord } from "@/lib/genericRecordActions";
import RelationEditModal from "@/components/RelationEditModal";

interface Props {
  relation: RelationDef;
  parentId: string;
  parentType?: LogParentType;
  companyId?: string;
  onMutated?: () => void;
}

export default function RelationSubTable({ relation, parentId, parentType, companyId, onMutated }: Props) {
  const router = useRouter();
  const [rows, setRows] = useState<any[] | null>(null);
  const [editingRow, setEditingRow] = useState<any | null>(null);

  const canEdit = !!(parentType && companyId);

  const fetchRows = async () => {
    let query = supabase
      .from(relation.childTable)
      .select(`
        *,
        credential:property_credential_id ( account_number, access_note, nominated_payor ),
        provider_entity:provider_entity_id ( name )
      `)
      .eq(relation.foreignKey, parentId)
      .is('deleted_at', null)
      .limit(20);

    if (relation.orderBy) {
      query = query.order(relation.orderBy.column, { ascending: relation.orderBy.ascending ?? true });
    }

    const { data, error } = await query;

    if (error) {
      const { data: fallbackData } = await supabase
        .from(relation.childTable)
        .select('*')
        .eq(relation.foreignKey, parentId)
        .is('deleted_at', null)
        .limit(20);
      setRows(fallbackData || []);
      return;
    }
    setRows(data || []);
  };

  useEffect(() => { fetchRows(); }, [relation, parentId]);

  const handleDelete = async (row: any, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!canEdit) return;
    if (!window.confirm(`Archive this ${relation.label.toLowerCase()} entry? It will be hidden but not permanently deleted.`)) return;

    await softDeleteRecord({
      table: relation.childTable,
      id: row.id,
      parentType: parentType!,
      parentId,
      companyId: companyId!,
      recordLabel: relation.label,
    });

    fetchRows();
    onMutated?.();
  };

  const handleSaveEdit = async (changes: Record<string, any>) => {
    if (!editingRow || !canEdit) return;
    await updateRecord({
      table: relation.childTable,
      id: editingRow.id,
      changes,
      parentType: parentType!,
      parentId,
      companyId: companyId!,
      recordLabel: relation.label,
    });
    setEditingRow(null);
    fetchRows();
    onMutated?.();
  };

  if (rows === null) {
    return (
      <div className="flex items-center gap-2 text-slate-400 text-[11px] py-4">
        <Loader2 size={12} className="animate-spin" /> Loading {relation.label.toLowerCase()}...
      </div>
    );
  }

  if (rows.length === 0) {
    return <p className="text-[11px] text-slate-300 italic py-2">No {relation.label.toLowerCase()} on record</p>;
  }

  return (
    <>
      <div className="overflow-x-auto rounded-2xl border border-slate-100">
        <table className="w-full text-left">
          <thead className="bg-slate-50">
            <tr>
              {relation.columns.map(c => (
                <th key={c.id} className="px-4 py-2 text-[9px] font-bold uppercase tracking-widest text-slate-400 border-b border-slate-100">
                  {c.label}
                </th>
              ))}
              {canEdit && <th className="px-4 py-2 border-b border-slate-100 w-20"></th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const href = relation.linkTo?.(row);
              return (
                <tr
                  key={row.id ?? i}
                  className={`border-b border-slate-50 last:border-0 group ${href ? 'hover:bg-indigo-50/30 cursor-pointer' : ''}`}
                  onClick={href ? () => router.push(href) : undefined}
                >
                  {relation.columns.map(c => (
                    <td key={c.id} className="px-4 py-2.5 text-[12px] font-medium text-slate-700">
                      {formatCell(resolveCellValue(row, c.id))}
                    </td>
                  ))}
                  {canEdit && (
                    <td className="px-4 py-2.5 flex items-center gap-1 justify-end opacity-0 group-hover:opacity-100">
                      <button onClick={(e) => { e.stopPropagation(); setEditingRow(row); }} className="p-1.5 text-slate-300 hover:text-indigo-600 hover:bg-indigo-50 rounded-full transition-all">
                        <Pencil size={12} />
                      </button>
                      <button onClick={(e) => handleDelete(row, e)} className="p-1.5 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-full transition-all">
                        <Trash2 size={12} />
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {editingRow && (
        <RelationEditModal
          relation={relation}
          row={editingRow}
          onClose={() => setEditingRow(null)}
          onSave={handleSaveEdit}
        />
      )}
    </>
  );
}

function resolveCellValue(row: any, path: string) {
  if (path === 'provider_entity_name') return row.provider_entity?.name ?? null;
  const value = path.split('.').reduce((obj: any, key: string) => obj?.[key], row);
  return typeof value === 'object' ? null : value;
}

function formatCell(value: any) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return value.toLocaleString();
  if (value === 'half_yearly') return 'Half yearly';
  if (typeof value === 'string' && ['monthly', 'quarterly', 'annually'].includes(value)) {
    return value.charAt(0).toUpperCase() + value.slice(1);
  }
  return String(value);
}