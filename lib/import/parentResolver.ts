// lib/import/parentResolver.ts

import { supabase } from "@/lib/supabase";

export interface ParentResolution {
  id: string | null;
  wasCreated: boolean;
  error?: string;
}

export interface PropertyMatch {
  id: string;
  street_address: string;
  suburb: string;
}

// Normalizes an address string for comparison purposes only — strips
// commas, collapses whitespace, lowercases. Used so that "Lot 7, 90 Baker
// Drive" and "Lot 7 90 Baker Drive" (same address, different punctuation)
// are correctly recognised as the same property, instead of failing a
// raw SQL ilike comparison that only ignores case, not punctuation.
function normalizeAddressForMatch(addr: string): string {
  return (addr || '')
    .replace(/,/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Finds an existing property belonging to this company whose address
 * matches the given street address (and suburb, if provided), using
 * punctuation/whitespace-normalized comparison rather than exact string
 * equality. This is the single source of truth for "does this address
 * match an existing property" — used both at review time (to decide
 * whether a child-section row defaults to New or Update) and at commit
 * time (resolvePropertyParent below), so the two stages can never
 * disagree with each other about whether a property already exists.
 */
export async function findMatchingProperty(
  companyId: string,
  streetAddress: string,
  suburb?: string
): Promise<PropertyMatch | null> {
  if (!streetAddress) return null;
  const normalizedTarget = normalizeAddressForMatch(streetAddress);

  const { data: candidates } = await supabase
    .from('properties')
    .select('id, street_address, suburb')
    .eq('company_id', companyId)
    .is('deleted_at', null);

  const match = (candidates || []).find(c => {
    const sameAddress = normalizeAddressForMatch(c.street_address) === normalizedTarget;
    if (!sameAddress) return false;
    if (suburb) return normalizeAddressForMatch(c.suburb || '') === normalizeAddressForMatch(suburb);
    return true;
  });

  if (!match) return null;
  return { id: match.id, street_address: match.street_address, suburb: match.suburb };
}

/**
 * Resolves a property_street_address reference (and optional suburb) to
 * a real properties.id, scoped to this company. If no match exists,
 * creates a minimal property record from what's available and flags it
 * as newly-created so the review step can surface "this property record
 * was auto-created with minimal details — fill in the rest later."
 */
export async function resolvePropertyParent(
  companyId: string,
  streetAddress: string,
  suburb?: string
): Promise<ParentResolution> {
  if (!streetAddress) return { id: null, wasCreated: false, error: "No property reference provided" };

  const match = await findMatchingProperty(companyId, streetAddress, suburb);
  if (match) return { id: match.id, wasCreated: false };

  const { data: created, error } = await supabase
    .from('properties')
    .insert({ company_id: companyId, street_address: streetAddress.trim(), suburb: suburb?.trim() || null })
    .select('id')
    .single();

  if (error) return { id: null, wasCreated: false, error: error.message };
  return { id: created.id, wasCreated: true };
}

/**
 * Resolves an entity_name (+ optional entity_type) to a real entities.id,
 * creating a minimal entity record if none matches. Reused both for the
 * "parent entity" case (entities-mode child sections) and for "provider
 * entity" resolution on bills/credentials.
 */
export async function resolveEntityParent(
  companyId: string,
  entityName: string,
  entityType?: string
): Promise<ParentResolution> {
  if (!entityName) return { id: null, wasCreated: false, error: "No entity reference provided" };

  const { data: existing } = await supabase
    .from('entities')
    .select('id')
    .eq('company_id', companyId)
    .ilike('name', entityName.trim())
    .is('deleted_at', null)
    .limit(1)
    .single();

  if (existing) return { id: existing.id, wasCreated: false };

  const { data: created, error } = await supabase
    .from('entities')
    .insert({ company_id: companyId, name: entityName.trim(), entity_type: entityType || 'Company' })
    .select('id')
    .single();

  if (error) return { id: null, wasCreated: false, error: error.message };
  return { id: created.id, wasCreated: true };
}

export async function resolveProjectParent(
  companyId: string,
  projectName: string
): Promise<ParentResolution> {
  if (!projectName) return { id: null, wasCreated: false, error: "No project reference provided" };

  const { data: existing } = await supabase
    .from('projects')
    .select('id')
    .eq('company_id', companyId)
    .ilike('name', projectName.trim())
    .is('deleted_at', null)
    .limit(1)
    .single();

  if (existing) return { id: existing.id, wasCreated: false };

  const { data: created, error } = await supabase
    .from('projects')
    .insert({ company_id: companyId, name: projectName.trim() })
    .select('id')
    .single();

  if (error) return { id: null, wasCreated: false, error: error.message };
  return { id: created.id, wasCreated: true };
}

/**
 * Checks whether a row already exists in a child table for a given
 * property (and, for tables like property_credentials that share one
 * physical table across categories, a matching category too).
 */
export async function findExistingChildRow(
  targetTable: string,
  propertyId: string,
  category?: string
): Promise<string | null> {
  let query = supabase.from(targetTable).select('id').eq('property_id', propertyId);
  if (category) query = query.eq('category', category);
  const { data } = await query.limit(1).single();
  return data?.id ?? null;
}