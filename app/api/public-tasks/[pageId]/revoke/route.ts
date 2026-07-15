// app/api/public-tasks/[pageId]/revoke/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabaseServer";
import { createClient } from "@supabase/supabase-js";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ pageId: string }> }) {
  const { pageId } = await params;

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { data: page } = await admin.from("public_task_pages").select("id, company_id, created_by").eq("id", pageId).maybeSingle();
  if (!page) return NextResponse.json({ error: "Page not found" }, { status: 404 });

  const { data: membership } = await admin
    .from("company_memberships").select("role").eq("company_id", page.company_id).eq("user_id", user.id).maybeSingle();
  const isAdmin = membership?.role === "company_admin";

  if (!isAdmin && page.created_by !== user.id) {
    return NextResponse.json({ error: "Only the page creator or a company admin can revoke this page" }, { status: 403 });
  }

  const { error } = await admin.from("public_task_pages").update({ is_active: false }).eq("id", pageId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
