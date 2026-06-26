// lib/columnDefinitions.ts

import { MapPin, Building2, Folder, KeyRound } from "lucide-react";

const formatLabel = (s: string) =>
  s.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

const buildFields = (cols: string[], prefix = '') =>
  cols.map(c => ({
    id: prefix ? `${prefix}.${c}` : c,
    label: formatLabel(c),
  }));

// ---- properties ----
export const PROPERTY_COLUMNS = [
  'street_address', 'suburb', 'state', 'postcode', 'country',
  'folio_identifier', 'holding_entity_id', 'purchase_price', 'purchase_date',
  'insurer_name', 'insurance_expiry', 'purchase_entity_id', 'policy_number',
  'project_manager', 'project_owner', 'last_coc_date', 'council_entity_id',
  'insurer_entity_id', 'is_sold', 'sold_date', 'sold_price',
];

// ---- entities ----
export const ENTITY_COLUMNS = [
  'name', 'entity_type', 'acn', 'abn', 'gst_registered',
  'trust_deed_date', 'established_date',
];

// ---- projects ----
export const PROJECT_COLUMNS = [
  'name', 'description', 'property_id', 'estimated_completion_date',
];

const CREDENTIAL_CATEGORIES = ['Council', 'Electricity', 'Water', 'Land Tax', 'Gas'];

const CREDENTIAL_FIELD_LABELS: { suffix: string; label: string }[] = [
  { suffix: 'account_name', label: 'Account Name' },
  { suffix: 'account_number', label: 'Account Number' },
  { suffix: 'login_id', label: 'Login ID' },
  { suffix: 'nominated_mobile', label: 'Nominated Mobile' },
  { suffix: 'additional_email', label: 'Additional Email' },
  { suffix: 'access_note', label: 'Online Access Note' },
  { suffix: 'nominated_payor', label: 'Payor' },
  { suffix: 'auto_forward_note', label: 'Auto Forward Note' },
  { suffix: 'credential_provider', label: 'Provider (Credential)' },
  { suffix: 'bill_provider', label: 'Provider (Bill)' },
];

// Note: encrypted_password is deliberately excluded from this list and
// will never be added as a toggleable column — passwords are never
// surfaced in the master table, per the earlier decision in this
// project to keep credential secrets out of any list/export view.
export function buildCredentialColumnSections() {
  return CREDENTIAL_CATEGORIES.map(category => {
    const key = category.toLowerCase().replace(/\s+/g, '_');
    return {
      title: `${category} Details`,
      icon: KeyRound,
      fields: CREDENTIAL_FIELD_LABELS.map(f => ({
        id: `${key}_${f.suffix}`,
        label: `${category} ${f.label}`,
      })),
    };
  });
}

export function buildPropertySections() {
  return [
    { title: "Property", icon: MapPin, fields: buildFields(PROPERTY_COLUMNS) },
    { title: "Holding Entity", icon: Building2, fields: buildFields(ENTITY_COLUMNS, 'holding_entity') },
    ...buildCredentialColumnSections(),
  ];
}

export function buildEntitySections() {
  return [
    { title: "Entity", icon: Building2, fields: buildFields(ENTITY_COLUMNS) },
  ];
}

export function buildProjectSections() {
  return [
    { title: "Project", icon: Folder, fields: buildFields(PROJECT_COLUMNS) },
    { title: "Property", icon: MapPin, fields: buildFields(PROPERTY_COLUMNS, 'property') },
  ];
}