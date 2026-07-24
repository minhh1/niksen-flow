"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import type { CustomTable } from "./useCustomTables";

export interface CustomTableField {
  id: string;
  table_id: string;
  field_key: string;
  label: string;
  field_type: string;
  select_options: string[] | null;
  linked_table_id: string | null;
  linked_system_table: string | null;
  linked_display_field: string | null;
  // Extra config for relation fields linked to a system table (see
  // supabase/company_table_fields_relation_config.sql) -- lets the picker
  // search more than just the display field, and restrict results (e.g. a
  // Staff field only showing entities where entity_type = 'Staff').
  linked_search_field_keys: string[] | null;
  linked_filter_column: string | null;
  linked_filter_value: string | null;
  is_required: boolean;
  is_unique: boolean;
  show_in_table: boolean;
  display_order: number;
  section_name: string | null;
  help_text: string | null;
  // Computed/formula fields (see supabase/company_table_fields_formula.sql
  // and _formula_extend.sql) -- formula_type null means an ordinary,
  // user-entered field. For sum_related, formula_field_a_id and
  // formula_relation_field_id are fields on the RELATED table.
  formula_type: 'multiply' | 'percentage_of' | 'add' | 'sum_related' | null;
  formula_field_a_id: string | null;
  formula_field_b_id: string | null;
  formula_percent: number | null;
  formula_relation_field_id: string | null;
  // Server-assigned consecutive numbering (see
  // supabase/company_table_field_sequences.sql), e.g. 'TR-' -> TR-000001.
  auto_number_prefix: string | null;
  // Multi-record relations (see
  // supabase/company_table_field_allow_multiple.sql) -- relation-type
  // fields only; false means the normal single-value behavior every other
  // field type also has. When true, `values[field_key]` on a
  // CustomTableRecord is a string[] of linked record ids instead of a
  // single id -- see this file's own load() below.
  allow_multiple: boolean;
}

export interface CustomTableRecord {
  id: string;
  table_id: string;
  created_at: string;
  values: Record<string, any>; // field_key → value (raw value_record_id for relation fields)
  // field_key → resolved label, populated only for relation-type fields
  // (table_relation/entity/project/property) -- see resolveRelationLabels
  // below. Display-only; editing still reads/writes the raw id in `values`.
  displayValues: Record<string, string>;
}

const RELATION_FIELD_TYPES = ['table_relation', 'entity', 'project', 'property'];

// Batch-resolves each relation field's target record ids to a human label,
// one query per relation field (not per row), and writes the results onto
// each record's `displayValues`. Mirrors the label lookups RelationPicker
// already does for the edit-side picker (components/dashboard/RelationPicker.tsx),
// just batched across all rows in the grid instead of one value at a time.
async function resolveRelationLabels(fieldList: CustomTableField[], records: CustomTableRecord[]) {
  const relationFields = fieldList.filter(f => RELATION_FIELD_TYPES.includes(f.field_type));
  if (relationFields.length === 0) return;

  await Promise.all(relationFields.map(async field => {
    // allow_multiple fields hold a string[]; every other relation field
    // holds a single string -- flatten both into one flat id list to
    // resolve, same as if every field were scalar.
    const rawValues = records.map(r => r.values[field.field_key]);
    const targetIds = Array.from(new Set(
      rawValues.flatMap(v => Array.isArray(v) ? v : [v]).filter((v): v is string => typeof v === 'string' && v.length > 0)
    ));
    if (targetIds.length === 0) return;

    const labelById = new Map<string, string>();

    if (field.field_type === 'table_relation' && field.linked_table_id) {
      const { data: targetFields } = await supabase
        .from('company_table_fields').select('id, field_key')
        .eq('table_id', field.linked_table_id).is('deleted_at', null);
      let displayField = (targetFields || []).find(f => f.field_key === field.linked_display_field);
      if (!displayField) {
        const { data: targetTable } = await supabase
          .from('company_tables').select('primary_field_key').eq('id', field.linked_table_id).maybeSingle();
        displayField = (targetFields || []).find(f => f.field_key === targetTable?.primary_field_key) || (targetFields || [])[0];
      }
      if (displayField) {
        const { data: values } = await supabase
          .from('company_table_values')
          .select('record_id, value_text, value_number, value_date, value_boolean')
          .eq('field_id', displayField.id)
          .in('record_id', targetIds);
        (values || []).forEach(v => {
          const label = v.value_text ?? v.value_number ?? v.value_date ?? (v.value_boolean !== null ? String(v.value_boolean) : null);
          if (label !== null && label !== undefined) labelById.set(v.record_id, String(label));
        });
      }
    } else if (field.linked_system_table) {
      const col = field.linked_display_field || 'name';
      const { data: rows } = await supabase.from(field.linked_system_table).select(`id, ${col}`).in('id', targetIds);
      (rows || []).forEach((r: any) => { if (r[col] != null) labelById.set(r.id, String(r[col])); });
    }

    records.forEach(rec => {
      const targetId = rec.values[field.field_key];
      if (Array.isArray(targetId)) {
        const labels = targetId.map(id => labelById.get(id)).filter((l): l is string => !!l);
        if (labels.length) rec.displayValues[field.field_key] = labels.join(', ');
        return;
      }
      const label = typeof targetId === 'string' ? labelById.get(targetId) : undefined;
      if (label !== undefined) rec.displayValues[field.field_key] = label;
    });
  }));
}

export function useCustomTable(tableSlug: string | null): {
  tableDef: CustomTable | null;
  fields: CustomTableField[];
  records: CustomTableRecord[];
  loading: boolean;
  refetch: () => void;
} {
  const [tableDef, setTableDef] = useState<CustomTable | null>(null);
  const [fields, setFields] = useState<CustomTableField[]>([]);
  const [records, setRecords] = useState<CustomTableRecord[]>([]);
  const [loading, setLoading] = useState(true);

  // Fetches table def + fields + records and swaps them in. Deliberately
  // does not touch `loading` itself -- the mount effect below wraps the
  // *first* call in a loading flag; a later `refetch()` (after adding/
  // editing/deleting a record) calls this directly so the page keeps
  // showing the current data instead of unmounting into a spinner.
  const load = useCallback(async () => {
    if (!tableSlug) return;
    const { data: tbl } = await supabase
      .from('company_tables')
      .select('*')
      .eq('slug', tableSlug)
      .is('deleted_at', null)
      .single();

    if (!tbl) return;
    setTableDef(tbl);

    const { data: flds } = await supabase
      .from('company_table_fields')
      .select('*')
      .eq('table_id', tbl.id)
      .is('deleted_at', null)
      .order('display_order');

    const fieldList = (flds || []) as CustomTableField[];
    setFields(fieldList);

    const { data: recs } = await supabase
      .from('company_table_records')
      .select('*, values:company_table_values(field_id, value_text, value_number, value_date, value_boolean, value_record_id)')
      .eq('table_id', tbl.id)
      .is('deleted_at', null)
      .order('created_at', { ascending: false });

    // Build a field_id → field_key map for resolving values
    const fieldMap = new Map(fieldList.map(f => [f.id, f]));

    const hydratedRecords: CustomTableRecord[] = (recs || []).map(rec => {
      const values: Record<string, any> = {};
      (rec.values || []).forEach((v: any) => {
        const field = fieldMap.get(v.field_id);
        if (!field) return;
        values[field.field_key] = v.value_text
          ?? v.value_number
          ?? v.value_date
          ?? v.value_boolean
          ?? v.value_record_id
          ?? null;
      });
      return { id: rec.id, table_id: rec.table_id, created_at: rec.created_at, values, displayValues: {} };
    });

    // Multi-record relations (allow_multiple) hold their links in a
    // separate junction table, not company_table_values -- overwrite those
    // fields' values with the real string[] once loaded. field_id already
    // scopes to this table (a field belongs to exactly one table), so no
    // need to also filter by this table's record ids.
    const multiFields = fieldList.filter(f => f.allow_multiple);
    if (multiFields.length) {
      const { data: links } = await supabase
        .from('company_table_value_links')
        .select('record_id, field_id, value_record_id')
        .in('field_id', multiFields.map(f => f.id));
      const byRecord = new Map<string, Record<string, string[]>>();
      (links || []).forEach(l => {
        const field = fieldMap.get(l.field_id);
        if (!field) return;
        if (!byRecord.has(l.record_id)) byRecord.set(l.record_id, {});
        const rec = byRecord.get(l.record_id)!;
        (rec[field.field_key] ||= []).push(l.value_record_id);
      });
      for (const rec of hydratedRecords) {
        for (const field of multiFields) {
          rec.values[field.field_key] = byRecord.get(rec.id)?.[field.field_key] || [];
        }
      }
    }

    await resolveRelationLabels(fieldList, hydratedRecords);
    setRecords(hydratedRecords);
  }, [tableSlug]);

  useEffect(() => {
    if (!tableSlug) return;
    let active = true;
    setLoading(true);
    load().finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [tableSlug, load]);

  return {
    tableDef,
    fields,
    records,
    loading,
    refetch: load,
  };
}