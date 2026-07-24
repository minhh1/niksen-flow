import {
  Type, Hash, Calendar, ToggleLeft, List, Link2,
  Fingerprint, Mail, Globe, DollarSign, MapPin, Building2
} from "lucide-react";

export type FieldType =
  | 'text' | 'number' | 'date' | 'boolean' | 'select'
  | 'auto_id' | 'email' | 'url' | 'currency' | 'link'
  | 'property' | 'entity' | 'project' | 'table_relation';

export interface CustomField {
  id: string;
  table_name: string;
  table_id?: string;
  field_key: string;
  label: string;
  field_type: FieldType;
  select_options: string[] | null;
  is_required: boolean;
  is_unique: boolean;
  display_order: number;
  default_value: string | null;
  validation_regex: string | null;
  validation_min: number | null;
  validation_max: number | null;
  auto_generate: boolean;
  auto_generate_type: string | null;
  auto_generate_prefix: string | null;
  linked_table: string | null;
  linked_table_id: string | null;
  linked_display_column: string | null;
  // Extra relation config -- custom-table fields linked to a system table
  // only (see supabase/company_table_fields_relation_config.sql).
  linked_search_field_keys?: string[] | null;
  linked_filter_column?: string | null;
  linked_filter_value?: string | null;
  section_name: string | null;
  grid_width: number;
  show_in_table: boolean;
  help_text: string | null;
  isCustomTable?: boolean;
  // Auto numbering — custom-table fields only (see
  // supabase/company_table_field_sequences.sql). Non-null prefix marks the
  // field auto-numbered ('' = bare numbers); prefix may contain {YY}/{YYYY}/
  // {MM} date tokens. pad is the zero-pad width (null = 6), start the
  // minimum counter value (null = 1).
  auto_number_prefix?: string | null;
  auto_number_start?: number | null;
  auto_number_pad?: number | null;
  // Computed/formula fields — custom-table fields only (see
  // supabase/company_table_fields_formula.sql). null means an ordinary,
  // user-entered field.
  formula_type?: 'multiply' | 'percentage_of' | null;
  formula_field_a_id?: string | null;
  formula_field_b_id?: string | null;
  formula_percent?: number | null;
}

export const FIELD_TYPES: {
  type: FieldType;
  label: string;
  icon: React.ElementType;
  color: string;
}[] = [
  { type: 'text',          label: 'Text',        icon: Type,        color: 'bg-blue-50 text-blue-600' },
  { type: 'number',        label: 'Number',      icon: Hash,        color: 'bg-purple-50 text-purple-600' },
  { type: 'date',          label: 'Date',        icon: Calendar,    color: 'bg-orange-50 text-orange-600' },
  { type: 'boolean',       label: 'Yes / No',    icon: ToggleLeft,  color: 'bg-green-50 text-green-600' },
  { type: 'select',        label: 'Dropdown',    icon: List,        color: 'bg-yellow-50 text-yellow-600' },
  { type: 'link',          label: 'Link record', icon: Link2,       color: 'bg-indigo-50 text-indigo-600' },
  { type: 'auto_id',       label: 'Auto ID',     icon: Fingerprint, color: 'bg-rose-50 text-rose-600' },
  { type: 'email',         label: 'Email',       icon: Mail,        color: 'bg-cyan-50 text-cyan-600' },
  { type: 'url',           label: 'URL',         icon: Globe,       color: 'bg-teal-50 text-teal-600' },
  { type: 'currency',      label: 'Currency',    icon: DollarSign,  color: 'bg-emerald-50 text-emerald-600' },
  { type: 'property',      label: 'Property',    icon: MapPin,      color: 'bg-violet-50 text-violet-600' },
  { type: 'entity',        label: 'Entity',      icon: Building2,   color: 'bg-pink-50 text-pink-600' },
  { type: 'table_relation',label: 'Relation',    icon: Link2,       color: 'bg-slate-50 text-slate-600' },
];

export function getFieldTypeConfig(type: string) {
  return FIELD_TYPES.find(f => f.type === type) || FIELD_TYPES[0];
}

export const SYSTEM_TABLES = ['properties', 'entities', 'projects'] as const;
export type SystemTable = typeof SYSTEM_TABLES[number];