// Single source of truth for "what does a field type mean" -- consolidates
// what used to be four independently-maintained copies of relation/numeric/
// date type lists (components/schema/FieldConfigPanel.tsx,
// components/dashboard/builder/WidgetConfigPanel.tsx,
// lib/dashboardWidgets/linkField.ts, lib/services/customTableService.ts),
// which had already drifted out of sync with each other. Every widget/schema
// consumer should ask this module "what can this field type do" instead of
// keeping its own type-name list, so a field type's capabilities only need
// to be taught once and every widget slot picks it up automatically.
import type { FieldType } from "@/components/schema/types";

export type FieldCapability =
  | 'numeric-aggregatable' // sum/net meaningful
  | 'countable'            // count/count-distinct meaningful
  | 'filterable-equality'  // eq/neq
  | 'filterable-text'      // contains
  | 'filterable-range'     // gt/gte/lt/lte
  | 'chart-axis-categorical' // meaningful as a group-by/category axis
  | 'chart-axis-temporal'  // meaningful as a chart's date x-axis
  | 'relation';            // links to a record on another table

export const RELATION_FIELD_TYPES: FieldType[] = ['table_relation', 'property', 'entity', 'project', 'link'];
export const NUMERIC_FIELD_TYPES: FieldType[] = ['number', 'currency'];
export const DATE_FIELD_TYPES: FieldType[] = ['date'];

const CAPABILITIES: Record<FieldType, FieldCapability[]> = {
  text:     ['countable', 'filterable-equality', 'filterable-text', 'chart-axis-categorical'],
  number:   ['numeric-aggregatable', 'countable', 'filterable-equality', 'filterable-range'],
  currency: ['numeric-aggregatable', 'countable', 'filterable-equality', 'filterable-range'],
  date:     ['countable', 'filterable-equality', 'filterable-range', 'chart-axis-temporal'],
  boolean:  ['countable', 'filterable-equality', 'chart-axis-categorical'],
  select:   ['countable', 'filterable-equality', 'chart-axis-categorical'],
  email:    ['countable', 'filterable-equality', 'filterable-text'],
  url:      ['countable', 'filterable-equality', 'filterable-text'],
  auto_id:  ['filterable-equality'],
  link:         ['countable', 'filterable-equality', 'relation', 'chart-axis-categorical'],
  property:     ['countable', 'filterable-equality', 'relation', 'chart-axis-categorical'],
  entity:       ['countable', 'filterable-equality', 'relation', 'chart-axis-categorical'],
  project:      ['countable', 'filterable-equality', 'relation', 'chart-axis-categorical'],
  table_relation: ['countable', 'filterable-equality', 'relation', 'chart-axis-categorical'],
};

export function capabilitiesForType(fieldType: string): FieldCapability[] {
  return CAPABILITIES[fieldType as FieldType] || [];
}

export function hasCapability(fieldType: string, capability: FieldCapability): boolean {
  return capabilitiesForType(fieldType).includes(capability);
}

export function isRelationType(fieldType: string): boolean {
  return (RELATION_FIELD_TYPES as string[]).includes(fieldType);
}

export function isNumericType(fieldType: string): boolean {
  return (NUMERIC_FIELD_TYPES as string[]).includes(fieldType);
}

export function isDateType(fieldType: string): boolean {
  return (DATE_FIELD_TYPES as string[]).includes(fieldType);
}

export type TileOperator = 'eq' | 'neq' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte' | 'is_set' | 'is_empty';

// Which comparisons make sense for a field type -- e.g. "contains" only for
// free text, "is set"/"is empty" for relations (an empty relation is a
// common, meaningful condition; a blank text/number is comparatively rare so
// its eq/neq already covers that via an empty value). Consolidates the
// per-widget-type switch that used to live in WidgetConfigPanel.tsx.
export function operatorsForType(fieldType: string): { value: TileOperator; label: string }[] {
  if (fieldType === 'boolean') return [{ value: 'eq', label: 'is' }];
  if (fieldType === 'select') return [{ value: 'eq', label: 'is' }, { value: 'neq', label: 'is not' }];
  if (fieldType === 'text' || fieldType === 'email' || fieldType === 'url') return [
    { value: 'eq', label: 'is' }, { value: 'neq', label: 'is not' }, { value: 'contains', label: 'contains' },
    { value: 'is_set', label: 'is set' }, { value: 'is_empty', label: 'is empty' },
  ];
  if (isNumericType(fieldType)) return [
    { value: 'eq', label: '=' }, { value: 'neq', label: '≠' },
    { value: 'gt', label: '>' }, { value: 'gte', label: '≥' }, { value: 'lt', label: '<' }, { value: 'lte', label: '≤' },
    { value: 'is_set', label: 'is set' }, { value: 'is_empty', label: 'is empty' },
  ];
  if (isDateType(fieldType)) return [
    { value: 'eq', label: 'on' }, { value: 'neq', label: 'not on' },
    { value: 'gt', label: 'after' }, { value: 'gte', label: 'on or after' }, { value: 'lt', label: 'before' }, { value: 'lte', label: 'on or before' },
    { value: 'is_set', label: 'is set' }, { value: 'is_empty', label: 'is empty' },
  ];
  if (isRelationType(fieldType)) return [
    { value: 'eq', label: 'is' }, { value: 'neq', label: 'is not' },
    { value: 'is_set', label: 'is set' }, { value: 'is_empty', label: 'is empty' },
  ];
  return [{ value: 'eq', label: 'is' }, { value: 'neq', label: 'is not' }];
}

export type TileAggregate = 'sum' | 'count' | 'net' | 'count-distinct';

// Which tile/chart-series aggregates make sense for a field type. Every
// type gets 'count' (rows matching, regardless of what's in the field);
// numeric types additionally get sum/net; other countable types (select,
// boolean, relations, text, ...) get count-distinct instead, so e.g. a
// Summary Tile can show "4 distinct Statuses" or "3 linked Matters" without
// the field having to be numeric.
export function aggregatesForType(fieldType: string): { value: TileAggregate; label: string }[] {
  const opts: { value: TileAggregate; label: string }[] = [{ value: 'count', label: 'Count' }];
  if (hasCapability(fieldType, 'numeric-aggregatable')) {
    opts.push({ value: 'sum', label: 'Sum' }, { value: 'net', label: 'Net (A − B)' });
  } else if (hasCapability(fieldType, 'countable')) {
    opts.push({ value: 'count-distinct', label: 'Count distinct' });
  }
  return opts;
}

// One-line, human-readable summary of what a field type enables in
// widgets -- shown as a hover hint on the "choose field type" palette
// (components/SchemaVisualisation.tsx) so the capability is visible before
// a field is even created, not just discovered later while building a
// widget and finding the type you picked doesn't offer what you need.
export function describeCapabilities(fieldType: string): string {
  const caps = capabilitiesForType(fieldType);
  const parts: string[] = [];
  if (caps.includes('relation')) parts.push("links to another table's records");
  if (caps.includes('numeric-aggregatable')) parts.push('can be summed in widgets');
  else if (caps.includes('countable')) parts.push('can be counted in widgets');
  if (caps.includes('chart-axis-temporal')) parts.push("usable as a chart's date axis");
  if (caps.includes('filterable-text')) parts.push('supports text search filters');
  else if (caps.includes('filterable-range')) parts.push('supports range filters (>, <)');
  return parts.length ? parts.join(' · ') : 'basic equality filtering only';
}

// Which company_table_values/company_custom_field_values column a field
// type's values live in. `link` is classified as a relation type ("Link
// record" in the FIELD_TYPES palette, and already treated as a
// foreign-key-ish type by SchemaMap's isFK check and FieldConfigPanel's
// relation config panel) and therefore stores value_record_id like the
// other relation types -- previously it fell through to value_text here,
// out of step with the rest of the codebase. No field currently uses type
// 'link' in the database (verified before this change), so there's no
// existing value_text data this reclassification would orphan.
export function getValueColumn(fieldType: string): string {
  if (isNumericType(fieldType)) return 'value_number';
  if (isDateType(fieldType)) return 'value_date';
  if (fieldType === 'boolean') return 'value_boolean';
  if (isRelationType(fieldType)) return 'value_record_id';
  return 'value_text';
}
