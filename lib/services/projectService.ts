import { supabase } from "../supabase";

export const projectService = {
  async getAll() {
    const { data } = await supabase
      .from("projects")
      .select("*")
      .is('deleted_at', null)
      .order('name');
    return data || [];
  }
};