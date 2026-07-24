"use client";

import RelationPicker from "./RelationPicker";
import type { CustomTableField } from "@/lib/hooks/useCustomTable";
import { isRelationType, isNumericType } from "@/lib/schema/fieldCapabilities";

interface Props {
  fields: CustomTableField[];
  filterFieldIds: string[];
  filters: Record<string, any>;
  onFilterChange: (fieldId: string, value: any) => void;
}

// Renders a dashboard's configured filter fields as a top toolbar, feeding
// lib/hooks/useDashboardData.ts's filter state -- which does a generic
// String(value) === String(filterValue) match, so any field type works as
// long as the control here produces a comparable value. Type-aware, mirrors
// WidgetConfigPanel's ConditionRow value control.
export default function DashboardFilterBar({ fields, filterFieldIds, filters, onFilterChange }: Props) {
  const filterFields = filterFieldIds
    .map(id => fields.find(f => f.id === id))
    .filter((f): f is CustomTableField => !!f);

  if (filterFields.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-3 p-4 bg-white border border-slate-200 rounded-2xl">
      {filterFields.map(field => (
        <div key={field.id} className="w-48">
          <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block mb-1 px-1">
            {field.label}
          </label>
          {field.field_type === 'date' ? (
            <input
              type="date"
              value={filters[field.id] || ''}
              onChange={e => onFilterChange(field.id, e.target.value || null)}
              className="w-full bg-slate-50 border border-slate-200 rounded-full py-2 px-3.5 text-[13px] font-medium outline-none focus:ring-2 focus:ring-indigo-100"
            />
          ) : isRelationType(field.field_type) ? (
            <RelationPicker
              linkedSystemTable={field.linked_system_table}
              linkedTableId={field.linked_system_table ? null : field.linked_table_id}
              displayField={field.linked_display_field}
              searchFieldKeys={field.linked_search_field_keys}
              filterColumn={field.linked_filter_column}
              filterValue={field.linked_filter_value}
              value={filters[field.id] || null}
              onSelect={id => onFilterChange(field.id, id)}
              placeholder={`All`}
            />
          ) : field.field_type === 'boolean' ? (
            <select
              value={filters[field.id] ?? ''}
              onChange={e => onFilterChange(field.id, e.target.value || null)}
              className="w-full bg-slate-50 border border-slate-200 rounded-full py-2 px-3.5 text-[13px] font-medium outline-none appearance-none focus:ring-2 focus:ring-indigo-100"
            >
              <option value="">All</option>
              <option value="true">Yes</option>
              <option value="false">No</option>
            </select>
          ) : field.field_type === 'select' ? (
            <select
              value={filters[field.id] ?? ''}
              onChange={e => onFilterChange(field.id, e.target.value || null)}
              className="w-full bg-slate-50 border border-slate-200 rounded-full py-2 px-3.5 text-[13px] font-medium outline-none appearance-none focus:ring-2 focus:ring-indigo-100"
            >
              <option value="">All</option>
              {(field.select_options || []).map(opt => <option key={opt} value={opt}>{opt}</option>)}
            </select>
          ) : (
            <input
              type={isNumericType(field.field_type) ? 'number' : 'text'}
              value={filters[field.id] ?? ''}
              onChange={e => onFilterChange(field.id, e.target.value || null)}
              placeholder="All"
              className="w-full bg-slate-50 border border-slate-200 rounded-full py-2 px-3.5 text-[13px] font-medium outline-none focus:ring-2 focus:ring-indigo-100"
            />
          )}
        </div>
      ))}
    </div>
  );
}
