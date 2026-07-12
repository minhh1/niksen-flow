// lib/hooks/useProfile.ts
// Shared TanStack Query hook for fetching user profile + company + memberships.
// Sidebar and any other component using this hook share one cached result.

import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

async function fetchProfile() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const t0 = performance.now();

  // Profile
  const { data: prof, error } = await supabase
    .from("profiles")
    .select("id, full_name, is_admin, active_company_id, sidebar_visible_tables")
    .eq("id", user.id)
    .single();

  if (error || !prof) return null;
  console.log(`[useProfile] profile: ${(performance.now()-t0).toFixed(0)}ms`);

  const t1 = performance.now();

  // Company + membership + all memberships — parallel
  const [companyRes, membershipRes, membershipsRes] = await Promise.all([
    prof.active_company_id
      ? supabase.from("companies").select("id, name, status").eq("id", prof.active_company_id).single()
      : Promise.resolve({ data: null }),
    supabase.from("company_memberships").select("role")
      .eq("user_id", user.id).eq("company_id", prof.active_company_id || '').single(),
    supabase.from("company_memberships")
      .select("company_id, role, company:company_id(id, name, status)")
      .eq("user_id", user.id),
  ]);

  console.log(`[useProfile] company+memberships (parallel): ${(performance.now()-t1).toFixed(0)}ms`);

  return {
    ...prof,
    company: companyRes.data,
    isAdmin: membershipRes.data?.role === 'company_admin',
    memberships: membershipsRes.data || [],
  };
}

export function useProfile() {
  return useQuery({
    queryKey: ['profile'],
    queryFn: fetchProfile,
    staleTime: 60 * 1000, // profile changes rarely — cache for 1 min
  });
}