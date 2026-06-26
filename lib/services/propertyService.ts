// lib/services/propertyService.ts

import { supabase } from "@/lib/supabase";

const CREDENTIAL_CATEGORIES = ['Council', 'Electricity', 'Water', 'Land Tax', 'Gas'];

const BILL_TABLES: Record<string, string> = {
  Council: 'property_bills_local_government',
  Electricity: 'property_bills_electricity',
  Water: 'property_bills_water',
  'Land Tax': 'property_bills_land_tax',
  Gas: 'property_bills_gas',
};

const categoryKey = (category: string) => category.toLowerCase().replace(/\s+/g, '_');

export const propertyService = {
  /**
   * @param visibleColumns - the currently active tableCols + expandCols
   * for the calling page. Determines which expensive per-category joins
   * actually run. Pass an empty array (or omit) to fetch only the base
   * property fields with no credential/bill-provider lookups at all.
   */
  async getAll(visibleColumns: string[] = []) {
    const { data: properties, error } = await supabase
      .from('properties')
      .select(`
        *,
        holding_entity:holding_entity_id ( id, name, entity_type )
      `)
      .is('deleted_at', null);

    if (error) {
      console.error('propertyService.getAll error:', error);
      return [];
    }

    const propertyIds = (properties || []).map(p => p.id);
    const flattened = (properties || []).map((p: any) => ({ ...p }));
    if (propertyIds.length === 0) return flattened;

    const categoriesNeeded = CREDENTIAL_CATEGORIES.filter(category => {
      const key = categoryKey(category);
      return visibleColumns.some(col => col.startsWith(`${key}_`));
    });

    if (categoriesNeeded.length === 0) return flattened;

    const byId = new Map(flattened.map(p => [p.id, p]));

    const credentialFetches = categoriesNeeded
      .filter(category => visibleColumns.some(col => col.startsWith(`${categoryKey(category)}_`) && !col.endsWith('_bill_provider')))
      .map(async (category) => {
        const { data: rows } = await supabase
          .from('property_credentials')
          .select('property_id, account_name, account_number, login_id, nominated_mobile, additional_email, access_note, nominated_payor, auto_forward_note, entity:entity_id ( name )')
          .eq('category', category)
          .in('property_id', propertyIds);

        const key = categoryKey(category);
        (rows || []).forEach((row: any) => {
          const prop = byId.get(row.property_id);
          if (!prop) return;
          prop[`${key}_account_name`] = row.account_name ?? null;
          prop[`${key}_account_number`] = row.account_number ?? null;
          prop[`${key}_login_id`] = row.login_id ?? null;
          prop[`${key}_nominated_mobile`] = row.nominated_mobile ?? null;
          prop[`${key}_additional_email`] = row.additional_email ?? null;
          prop[`${key}_access_note`] = row.access_note ?? null;
          prop[`${key}_nominated_payor`] = row.nominated_payor ?? null;
          prop[`${key}_auto_forward_note`] = row.auto_forward_note ?? null;
          prop[`${key}_credential_provider`] = row.entity?.name ?? null;
        });
      });

    const billProviderFetches = categoriesNeeded
      .filter(category => visibleColumns.includes(`${categoryKey(category)}_bill_provider`))
      .map(async (category) => {
        const table = BILL_TABLES[category];
        const { data: rows } = await supabase
          .from(table)
          .select('property_id, provider_entity:provider_entity_id ( name )')
          .in('property_id', propertyIds);

        const key = categoryKey(category);
        (rows || []).forEach((row: any) => {
          const prop = byId.get(row.property_id);
          if (!prop) return;
          prop[`${key}_bill_provider`] = row.provider_entity?.name ?? null;
        });
      });

    await Promise.all([...credentialFetches, ...billProviderFetches]);

    return flattened;
  },

  // lib/services/propertyService.ts — add this alongside getAll

async getDetails(propertyId: string) {
  const { data: property, error } = await supabase
    .from('properties')
    .select(`
      *,
      holding_entity:holding_entity_id ( id, name, entity_type ),
      council:council_entity_id ( id, name, entity_type )
    `)
    .eq('id', propertyId)
    .single();

  if (error) {
    console.error('propertyService.getDetails error:', error);
    throw error;
  }

  const [
    { data: valuations },
    { data: bills },
    { data: logs },
  ] = await Promise.all([
    supabase.from('property_valuations').select('*').eq('property_id', propertyId).order('valuation_date', { ascending: false }),
    supabase.from('property_bills').select('*').eq('property_id', propertyId).order('issued_date', { ascending: false }),
    supabase.from('audit_logs').select('*').eq('property_id', propertyId).order('created_at', { ascending: false }),
  ]);

  // "Insurances" and "utilities" aren't modeled as their own tables in
  // the schema this project actually has — properties carries insurer
  // fields directly (insurer_name, policy_number, insurance_expiry), and
  // utility credentials live in property_credentials. Returning them in
  // the shapes their respective modules expect:
  const { data: utilities } = await supabase
    .from('property_credentials')
    .select('*, entity:entity_id ( name )')
    .eq('property_id', propertyId);

  return {
    property,
    valuations: valuations || [],
    insurances: property.insurer_name || property.policy_number ? [{
      insurer_name: property.insurer_name,
      policy_number: property.policy_number,
      insurance_expiry: property.insurance_expiry,
    }] : [],
    utilities: utilities || [],
    bills: bills || [],
    logs: logs || [],
  };
},

};