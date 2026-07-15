// app/api/public-tasks/list/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabaseServer";
import { createClient } from "@supabase/supabase-js";

export async function GET(req: NextRequest) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { data: profile } = await admin.from("profiles").select("active_company_id").eq("id", user.id).single();
  const companyId = profile?.active_company_id;
  if (!companyId) return NextResponse.json({ pages: [] });

  const { data: membership } = await admin
    .from("company_memberships").select("role").eq("company_id", companyId).eq("user_id", user.id).maybeSingle();
  const isAdmin = membership?.role === "company_admin";

  let query = admin
    .from("public_task_pages")
    .select("id, title, scope, team_id, columns, expires_at, is_active, created_at, created_by, teams:team_id(team_name), creator:created_by(full_name, email)")
    .eq("company_id", companyId)
    .order("created_at", { ascending: false });

  if (!isAdmin) query = query.eq("created_by", user.id);

  const { data: pages, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    pages: (pages || []).map((p: any) => ({
      id: p.id,
      title: p.title,
      scope: p.scope,
      teamName: p.teams?.team_name || null,
      columns: p.columns,
      expiresAt: p.expires_at,
      isActive: p.is_active,
      createdAt: p.created_at,
      createdBy: p.creator?.full_name || p.creator?.email || "Unknown",
    })),
  });
}
