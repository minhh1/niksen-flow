import { supabase } from "../supabase";

export const propertyService = {
  // Fetch Master List with Owner Join
  async getAll() {
    const { data, error } = await supabase
      .from("properties")
      .select(`
        *,
        holding_entity:holding_entity_id(id, name, entity_type, abn, nab_connect_id)
      `)
      .is('deleted_at', null)
      .order('street_address');
    
    if (error) console.error("Property Fetch Error:", error);
    return data || [];
  },

  // Fetch Full Individual Details
  async getDetails(id: string) {
    const { data: property } = await supabase.from("properties")
      .select(`*, holding_entity:holding_entity_id(*), council:council_entity_id(name)`)
      .eq("id", id).single();

    const { data: valuations } = await supabase.from("property_valuations").select("*").eq("property_id", id).order('valuation_date', { ascending: false });
    const { data: insurances } = await supabase.from("property_insurances").select("*, insurer:insurer_entity_id(name)").eq("property_id", id);
    const { data: utilities } = await supabase.from("property_utility_accounts").select("*").eq("property_id", id);
    const { data: bills } = await supabase.from("property_utility_bills").select("*").eq("property_id", id).order('issued_date', { ascending: false });
    const { data: logs } = await supabase.from("audit_logs").select(`*, profiles:user_id(full_name)`).eq("property_id", id).order('created_at', { ascending: false });

    return { property, valuations, insurances, utilities, bills, logs };
  }
};