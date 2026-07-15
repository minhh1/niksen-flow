// app/api/public-tasks/create/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabaseServer";
import { createClient } from "@supabase/supabase-js";
import { PUBLIC_TASK_COLUMNS } from "@/lib/publicTaskColumns";

export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const { title, scope, teamId, columns, expiresAt } = body;
  if (!title?.trim()) return NextResponse.json({ error: "Title is required" }, { status: 400 });
  if (!["self", "team", "company"].includes(scope)) {
    return NextResponse.json({ error: "Invalid scope" }, { status: 400 });
  }
  if (scope === "team" && !teamId) {
    return NextResponse.json({ error: "teamId is required for team scope" }, { status: 400 });
  }
  const validKeys = new Set(PUBLIC_TASK_COLUMNS.map(c => c.key));
  const cleanColumns = Array.isArray(columns) ? columns.filter((c: string) => validKeys.has(c as any)) : [];

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { data: profile } = await admin.from("profiles").select("active_company_id").eq("id", user.id).single();
  const companyId = profile?.active_company_id;
  if (!companyId) return NextResponse.json({ error: "No active company" }, { status: 400 });

  const { data: membership } = await admin
    .from("company_memberships").select("role").eq("company_id", companyId).eq("user_id", user.id).maybeSingle();
  const isAdmin = membership?.role === "company_admin";

  // ── Permission check per scope ──────────────────────────────────
  if (scope === "company" && !isAdmin) {
    return NextResponse.json({ error: "Only company admins can create a company-wide page" }, { status: 403 });
  }
  if (scope === "team") {
    const { data: team } = await admin.from("teams").select("id, leader_id, company_id").eq("id", teamId).maybeSingle();
    if (!team || team.company_id !== companyId) {
      return NextResponse.json({ error: "Team not found" }, { status: 404 });
    }
    if (!isAdmin && team.leader_id !== user.id) {
      return NextResponse.json({ error: "Only the team leader or a company admin can create a page for this team" }, { status: 403 });
    }
  }

  const { data: page, error } = await admin.from("public_task_pages").insert({
    company_id: companyId,
    created_by: user.id,
    title: title.trim(),
    scope,
    team_id: scope === "team" ? teamId : null,
    columns: cleanColumns,
    expires_at: expiresAt || null,
  }).select("id").single();

  if (error || !page) return NextResponse.json({ error: error?.message || "Failed to create page" }, { status: 500 });

  return NextResponse.json({ ok: true, pageId: page.id });
}
