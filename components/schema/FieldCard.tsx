"use client";

import { GripVertical, Link2 } from "lucide-react";
import type { CustomField } from "./types";
import { getFieldTypeConfig } from "./types";
import { isRelationType } from "@/lib/schema/fieldCapabilities";
import type { CustomTable } from "@/lib/hooks/useCustomTables";

interface Props {
  field: CustomField;
  isSelected: boolean;
  // Other tables (company-wide) that also have a field with this exact
  // label -- a common source of confusion when picking fields for a widget
  // ("which 'Status' did I mean?"). Empty when the label is unique.
  otherTablesWithLabel?: string[];
  customTables?: CustomTable[];
  onSelect: () => void;
  onDragStart: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: () => void;
}

// What a relation field points at, e.g. "→ Matters" / "→ Properties" -- the
// type label alone ("Relation") doesn't say where, which is the actual
// source of confusion when several relation fields sit on one table.
function relationTargetLabel(field: CustomField, customTables: CustomTable[]): string | null {
  if (!isRelationType(field.field_type)) return null;
  if (field.linked_table) return field.linked_table.charAt(0).toUpperCase() + field.linked_table.slice(1);
  if (field.linked_table_id) return customTables.find(t => t.id === field.linked_table_id)?.name || null;
  return null;
}

export default function FieldCard({
  field, isSelected, otherTablesWithLabel = [], customTables = [], onSelect, onDragStart, onDragOver, onDrop,
}: Props) {
  const ftConfig = getFieldTypeConfig(field.field_type);
  const FtIcon = ftConfig.icon;
  const spanFull = field.grid_width === 1;
  const relationTarget = relationTargetLabel(field, customTables);

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={e => { e.preventDefault(); onDragOver(e); }}
      onDrop={onDrop}
      onClick={onSelect}
      className={`relative group cursor-pointer rounded-2xl border-2 p-4 transition-all ${
        spanFull ? 'col-span-2' : 'col-span-1'
      } ${
        isSelected
          ? 'border-indigo-500 bg-indigo-50/50 shadow-sm shadow-indigo-100'
          : 'border-slate-100 bg-white hover:border-slate-300 hover:shadow-sm'
      }`}
    >
      <div className="flex items-center gap-3">
        <div className="cursor-grab text-slate-300 hover:text-slate-500 transition-colors shrink-0">
          <GripVertical size={14} />
        </div>
        <div className={`p-1.5 rounded-lg ${ftConfig.color} shrink-0`}>
          <FtIcon size={13} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-bold text-slate-800 truncate">{field.label}</p>
          <p className="text-[10px] text-slate-400 font-medium truncate">
            {ftConfig.label}{relationTarget && <span className="text-indigo-500"> → {relationTarget}</span>}
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {field.is_required && (
            <span className="w-1.5 h-1.5 rounded-full bg-red-400" title="Required" />
          )}
          {field.is_unique && (
            <span className="w-1.5 h-1.5 rounded-full bg-purple-400" title="Unique" />
          )}
          {field.show_in_table && (
            <span className="w-1.5 h-1.5 rounded-full bg-indigo-400" title="Shown in table" />
          )}
          {field.auto_generate && (
            <span className="w-1.5 h-1.5 rounded-full bg-rose-400" title="Auto-generated" />
          )}
        </div>
      </div>
      {field.help_text && (
        <p className="text-[10px] text-slate-400 mt-2 ml-7 truncate">{field.help_text}</p>
      )}
      {otherTablesWithLabel.length > 0 && (
        <p
          className="flex items-center gap-1 text-[10px] text-amber-600 mt-2 ml-7 truncate"
          title={`A field also called "${field.label}" exists on: ${otherTablesWithLabel.join(', ')} -- easy to pick the wrong one when building a widget`}
        >
          <Link2 size={10} className="shrink-0" />
          Also on {otherTablesWithLabel.join(', ')}
        </p>
      )}
    </div>
  );
}