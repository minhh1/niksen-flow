"use client";

import type { CustomTableField } from "@/lib/hooks/useCustomTable";
import RelationPicker from "./RelationPicker";

// Which company_table_values column stores a given field_type's value.
export function valueColumnFor(fieldType: string): string {
  if (['number', 'currency'].includes(fieldType)) return 'value_number';
  if (fieldType === 'date') return 'value_date';
  if (fieldType === 'boolean') return 'value_boolean';
  if (['property', 'entity', 'project', 'table_relation'].includes(fieldType)) return 'value_record_id';
  return 'value_text';
}

const inputClass =
  "w-full bg-slate-50 border border-slate-200 rounded-full py-2 px-3.5 text-[13px] font-medium outline-none focus:ring-2 focus:ring-indigo-100";

interface Props {
  field: CustomTableField;
  value: any;
  onCommit: (value: any) => void;
  disabled?: boolean;
  // Pre-resolved label for a relation-type value (e.g. CustomTableRecord.
  // displayValues) -- see RelationPicker's initialLabel for why this
  // matters at any real scale of rows.
  displayValue?: string;
}

// Renders the appropriate input widget for a custom-table field, bound to a
// value, committing on blur/change. Reuses the field_type conventions shared
// across the schema system (see components/schema/types.ts).
export default function FieldValueInput({ field, value, onCommit, disabled, displayValue }: Props) {
  const type = field.field_type;

  // Computed fields are never hand-edited — see supabase/company_table_fields_formula.sql.
  if (field.formula_type) {
    return (
      <div className="w-full bg-slate-50 border border-slate-200 rounded-full py-2 px-3.5 text-[13px] font-medium text-slate-500 truncate" title="Auto-calculated">
        {value !== null && value !== undefined && value !== '' ? String(value) : '—'}
      </div>
    );
  }

  if (type === 'boolean') {
    return (
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={!!value}
          disabled={disabled}
          onChange={e => onCommit(e.target.checked)}
          className="w-4 h-4 accent-indigo-600"
        />
        <span className="text-[11px] font-medium text-slate-500">{field.label}</span>
      </label>
    );
  }

  if (type === 'select') {
    return (
      <select
        defaultValue={value ?? ''}
        disabled={disabled}
        onChange={e => onCommit(e.target.value || null)}
        className={`${inputClass} appearance-none`}
      >
        <option value="">—</option>
        {(field.select_options || []).map(opt => (
          <option key={opt} value={opt}>{opt}</option>
        ))}
      </select>
    );
  }

  if (type === 'date') {
    return (
      <input
        type="date"
        defaultValue={value ?? ''}
        disabled={disabled}
        onBlur={e => onCommit(e.target.value || null)}
        className={inputClass}
      />
    );
  }

  if (['number', 'currency'].includes(type)) {
    return (
      <input
        type="number"
        defaultValue={value ?? ''}
        disabled={disabled}
        onBlur={e => onCommit(e.target.value === '' ? null : Number(e.target.value))}
        className={inputClass}
        placeholder={field.label}
      />
    );
  }

  if (['property', 'entity', 'project', 'table_relation'].includes(type)) {
    return (
      <RelationPicker
        linkedSystemTable={field.linked_system_table}
        linkedTableId={field.linked_system_table ? null : field.linked_table_id}
        displayField={field.linked_display_field}
        searchFieldKeys={field.linked_search_field_keys}
        filterColumn={field.linked_filter_column}
        filterValue={field.linked_filter_value}
        value={value || null}
        onSelect={id => onCommit(id)}
        disabled={disabled}
        placeholder={field.label}
        initialLabel={displayValue}
      />
    );
  }

  // text / email / url / auto_id / link fallback
  return (
    <input
      type={type === 'email' ? 'email' : type === 'url' ? 'url' : 'text'}
      defaultValue={value ?? ''}
      disabled={disabled}
      onBlur={e => onCommit(e.target.value || null)}
      className={inputClass}
      placeholder={field.label}
    />
  );
}
