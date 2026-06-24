import { supabase } from "../supabase";

export const entityService = {
  async getAll() {
    const { data } = await supabase
      .from("entities")
      .select("*")
      .is('deleted_at', null)
      .order('name');
    return data || [];
  },

  async getDetails(id: string) {
    const { data: entity } = await supabase.from("entities")
      .select(`*, entity_officeholders(*), accountant:accountant_id(name)`)
      .eq("id", id).single();
    
    const { data: logs } = await supabase.from("audit_logs")
      .select(`*, profiles:user_id(full_name)`)
      .eq("entity_id", id).order('created_at', { ascending: false });

    return { entity, logs };
  }
};