import { supabase } from "./supabase";

export const erpData = {
  // Fetch Properties with Joins
  async getProperties() {
    const { data } = await supabase
      .from("properties")
      .select(`*, holding_entity:holding_entity_id(name, entity_type)`)
      .is('deleted_at', null)
      .order('street_address');
    return data || [];
  },

  // Fetch Entities (Fixes the error)
  async getEntities() {
    const { data } = await supabase
      .from("entities")
      .select("*")
      .is('deleted_at', null)
      .order('name');
    return data || [];
  },

  // Fetch Projects
  async getProjects() {
    const { data } = await supabase
      .from("projects")
      .select("*")
      .is('deleted_at', null)
      .order('name');
    return data || [];
  },

  // Fetch User Preferences for any table
  async getUserPrefs(user_id: string, table_slug: string) {
    const { data } = await supabase
      .from("user_column_preferences")
      .select("*")
      .eq("user_id", user_id)
      .eq("table_slug", table_slug);
    return data || [];
  },

  // Unified Save (Handles multi-preset logic)
  async saveUserPrefs(payload: any) {
    // Mark others as inactive first
    await supabase.from("user_column_preferences")
      .update({ is_active: false })
      .eq("user_id", payload.user_id)
      .eq("table_slug", payload.table_slug);

    const { error } = await supabase.from("user_column_preferences").upsert({
      ...payload,
      is_active: true
    }, { onConflict: 'user_id,table_slug,preset_name' });
    
    return { error };
  },

  // Property Detail Fetcher
  async getPropertyDetails(id: string) {
    const { data: property } = await supabase.from("properties")
      .select(`*, holding_entity:holding_entity_id(name), council:council_entity_id(name), insurer:insurer_entity_id(name)`)
      .eq("id", id).single();
    const { data: valuations } = await supabase.from("property_valuations").select("*").eq("property_id", id).order('valuation_date', { ascending: false });
    const { data: insurances } = await supabase.from("property_insurances").select("*, insurer:insurer_entity_id(name)").eq("property_id", id);
    const { data: utilities } = await supabase.from("property_utility_accounts").select("*").eq("property_id", id);
    const { data: bills } = await supabase.from("property_utility_bills").select("*").eq("property_id", id).order('issued_date', { ascending: false });
    const { data: logs } = await supabase.from("audit_logs").select(`*, profiles:user_id(full_name)`).eq("property_id", id).order('created_at', { ascending: false });
    return { property, valuations, insurances, utilities, bills, logs };
  }
};