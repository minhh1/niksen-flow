import { supabase } from "../supabase";

export const preferenceService = {
  async getByTable(user_id: string, table_slug: string) {
    const { data } = await supabase
      .from("user_column_preferences")
      .select("*")
      .eq("user_id", user_id)
      .eq("table_slug", table_slug)
      .order('preset_name', { ascending: true });
    return data || [];
  },

  async save(payload: any) {
    // 1. If this is being set as active, mark all other presets for this table as inactive
    if (payload.is_active) {
      await supabase.from("user_column_preferences")
        .update({ is_active: false })
        .eq("user_id", payload.user_id)
        .eq("table_slug", payload.table_slug);
    }

    // 2. Upsert the preset (Update if name matches, else Insert)
    const { error } = await supabase
      .from("user_column_preferences")
      .upsert(payload, { onConflict: 'user_id,table_slug,preset_name' });
    
    return { error };
  }
};