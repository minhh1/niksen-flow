// app/api/public-tasks/[pageId]/projects/route.ts
// Searches projects by name and/or matter number, for the "add/edit task"
// project picker on the public task page — avoids shipping the entire
// company's project list to the client.
import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabaseServer";
import { createClient } from "@supabase/supabase-js";
import { loadPageAndAuthorize } from "@/lib/publicTaskPageAuth";

export async function GET(req: NextRequest, { params }: { params: Promise<{ pageId: string }> }) {
  const { pageId } = await params;
  const q = (req.nextUrl.searchParams.get("q") || "").trim();

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const auth = await loadPageAndAuthorize(admin, pageId, user.id);
  if (auth.error) return auth.error;
  const { page } = auth;

  if (!q) return NextResponse.json({ projects: [] });

  // Match by project name directly...
  const { data: byName } = await admin
    .from("projects").select("id, name")
    .eq("company_id", page.company_id).is("deleted_at", null)
    .ilike("name", `%${q}%`).limit(20);

  // ...and by matter number via the custom field value.
  const { data: matterField } = await admin
    .from("company_custom_fields").select("id")
    .eq("company_id", page.company_id).eq("table_name", "projects").eq("field_key", "matter_number").maybeSingle();

  let byMatter: any[] = [];
  if (matterField) {
    const { data: matches } = await admin
      .from("company_custom_field_values").select("record_id, value_text")
      .eq("field_id", matterField.id).ilike("value_text", `%${q}%`).limit(20);
    const ids = (matches || []).map((m: any) => m.record_id);
    if (ids.length) {
      const { data: projs } = await admin.from("projects").select("id, name").in("id", ids).is("deleted_at", null);
      byMatter = projs || [];
    }
  }

  const combined = [...(byName || []), ...byMatter];
  const uniqueIds = [...new Set(combined.map(p => p.id))];
  const unique = uniqueIds.map(id => combined.find(p => p.id === id));

  // Attach matter numbers for display
  let matterByProject: Record<string, string> = {};
  if (matterField && unique.length) {
    const { data: values } = await admin
      .from("company_custom_field_values").select("record_id, value_text")
      .eq("field_id", matterField.id).in("record_id", unique.map(p => p!.id));
    matterByProject = Object.fromEntries((values || []).map((v: any) => [v.record_id, v.value_text || ""]));
  }

  return NextResponse.json({
    projects: unique.slice(0, 20).map(p => ({ id: p!.id, name: p!.name, matterNumber: matterByProject[p!.id] || null })),
  });
}
