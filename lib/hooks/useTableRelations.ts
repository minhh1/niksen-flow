// lib/hooks/useTableRelations.ts
"use client";

import { useState, useEffect } from "react";
import { supabase } from "@/lib/supabase";
import type { RelationDef } from "@/lib/relationDefinitions";

interface ReverseRelation {
  child_table: string;
  foreign_key_column: string;
  display_column: string;
  label: string;
}

// Which columns to show in each child table's relation panel.
// This is the one config piece that can't be derived from schema alone —
// which columns are worth showing in a compact sub-table is a display
// decision, not a structural one.
const RELATION_DISPLAY_COLS: Record<string, { id: string; label: string }[]> = {
  property_valuations: [
    { id: 'amount', label: 'Amount' },
    { id: 'valuation_date', label: 'Date' },
    { id: 'is_full_valuation', label: 'Full valuation' },
  ],
  property_bills_local_government: [
    { id: 'issued_date', label: 'Issued' },
    { id: 'amount', label: 'Amount' },
    { id: 'is_paid', label: 'Paid' },
    { id: 'paid_up_to', label: 'Paid up to' },
  ],
  property_bills_electricity: [
    { id: 'issued_date', label: 'Issued' },
    { id: 'amount', label: 'Amount' },
    { id: 'is_paid', label: 'Paid' },
    { id: 'paid_up_to', label: 'Paid up to' },
  ],
  property_bills_water: [
    { id: 'issued_date', label: 'Issued' },
    { id: 'amount', label: 'Amount' },
    { id: 'is_paid', label: 'Paid' },
    { id: 'paid_up_to', label: 'Paid up to' },
  ],
  property_bills_gas: [
    { id: 'issued_date', label: 'Issued' },
    { id: 'amount', label: 'Amount' },
    { id: 'is_paid', label: 'Paid' },
    { id: 'paid_up_to', label: 'Paid up to' },
  ],
  property_bills_land_tax: [
    { id: 'issued_date', label: 'Issued' },
    { id: 'amount', label: 'Amount' },
    { id: 'is_paid', label: 'Paid' },
    { id: 'paid_up_to', label: 'Paid up to' },
  ],
  property_credentials: [
    { id: 'category', label: 'Category' },
    { id: 'account_name', label: 'Account name' },
    { id: 'account_number', label: 'Account number' },
    { id: 'login_id', label: 'Login ID' },
  ],
  entity_officeholders: [
    { id: 'name', label: 'Name' },
    { id: 'role', label: 'Role' },
    { id: 'date_appointed', label: 'Appointed' },
    { id: 'is_current', label: 'Current' },
  ],
  // Projects shown as child of a property
  projects: [
    { id: 'name', label: 'Name' },
    { id: 'status', label: 'Status' },
    { id: 'description', label: 'Description' },
    { id: 'estimated_completion_date', label: 'Est. Completion' },
  ],
  // Child properties (lots) shown under a project
  properties: [
    { id: 'street_address', label: 'Address' },
    { id: 'suburb', label: 'Suburb' },
    { id: 'folio_identifier', label: 'Folio' },
    { id: 'purchase_price', label: 'Price' },
  ],
};

const RELATION_ORDER_BY: Record<string, { column: string; ascending: boolean }> = {
  property_valuations: { column: 'valuation_date', ascending: false },
  property_bills_local_government: { column: 'issued_date', ascending: false },
  property_bills_electricity: { column: 'issued_date', ascending: false },
  property_bills_water: { column: 'issued_date', ascending: false },
  property_bills_gas: { column: 'issued_date', ascending: false },
  property_bills_land_tax: { column: 'issued_date', ascending: false },
  projects: { column: 'created_at', ascending: true },
  properties: { column: 'street_address', ascending: true },
};

const RELATION_LINK_TO: Record<string, (row: any) => string> = {
  properties: (row) => `/dashboard/properties?id=${row.id}`,
  projects: (row) => `/dashboard/projects?id=${row.id}`,
  entities: (row) => `/dashboard/entities?id=${row.id}`,
};

function buildRelationDef(r: ReverseRelation, parentTable: string): RelationDef {
  const columns = RELATION_DISPLAY_COLS[r.child_table] || [
    { id: 'name', label: 'Name' },
    { id: 'created_at', label: 'Created' },
  ];

  return {
    key: `${r.child_table}:${r.foreign_key_column}`,
    label: r.label,
    parentTable,
    childTable: r.child_table,
    foreignKey: r.foreign_key_column,
    orderBy: RELATION_ORDER_BY[r.child_table],
    columns,
    linkTo: RELATION_LINK_TO[r.child_table],
  };
}

// In-memory cache so we don't re-fetch on every render or navigation
const cache = new Map<string, RelationDef[]>();

export function useTableRelations(tableName: string): {
  relations: RelationDef[];
  loading: boolean;
} {
  const [relations, setRelations] = useState<RelationDef[]>(
    cache.get(tableName) || []
  );
  const [loading, setLoading] = useState(!cache.has(tableName));

  useEffect(() => {
    if (!tableName || tableName === '__skip__') { setLoading(false); return; }
    if (cache.has(tableName)) return;
    let active = true;

    (async () => {
      const [{ data: reverse, error: reverseErr }, { data: self, error: selfErr }] =
        await Promise.all([
          supabase.rpc('get_reverse_relations', { target_table: tableName }),
          supabase.rpc('get_self_relations', { target_table: tableName }),
        ]);

      if (!active) return;

      if (reverseErr) console.error('get_reverse_relations error:', reverseErr);
      if (selfErr) console.error('get_self_relations error:', selfErr);

      const all: RelationDef[] = [
        // Self-references first (e.g. sub-projects under projects)
        ...(self || []).map((r: ReverseRelation) => buildRelationDef(r, tableName)),
        // Then tables that point to this one (child lots, bills, valuations etc.)
        ...(reverse || []).map((r: ReverseRelation) => buildRelationDef(r, tableName)),
      ];

      cache.set(tableName, all);
      setRelations(all);
      setLoading(false);
    })();

    return () => { active = false; };
  }, [tableName]);

  return { relations, loading };
}

// Call this after a schema migration to force a fresh fetch
export function invalidateRelationsCache(tableName?: string) {
  if (tableName) cache.delete(tableName);
  else cache.clear();
}