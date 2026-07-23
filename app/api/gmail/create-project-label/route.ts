// app/api/gmail/create-project-label/route.ts
// Called right after a project is created from the dashboard (NewProjectModal)
// so it gets a shared Gmail label the same way projects created via the
// Gmail Add-on do — that flow was previously the only path that ever wrote a
// project_gmail_labels row, so dashboard-created projects never synced to
// Gmail at all. Only writes metadata here; the actual per-mailbox Gmail
// label creation happens in gmail-label-sync-processor once the job below
// is picked up, same as every other label-creation path in this app.
import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabaseServer";
import { createClient } from "@supabase/supabase-js";

async function generateUniqueLabelCode(adminDb: any): Promise<string> {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  for (let attempt = 0; attempt < 10; attempt++) {
    let code = "";
    for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
    const { data } = await adminDb
      .from("project_gmail_labels")
      .select("id, projects!inner(deleted_at)")
      .eq("label_code", code)
      .is("projects.deleted_at", null)
      .maybeSingle();
    if (!data) return code;
  }
  return "Z" + Date.now().toString(36).toUpperCase().slice(-4);
}

export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const { projectId } = body;
  if (!projectId) return NextResponse.json({ error: "Missing projectId" }, { status: 400 });

  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: prof } = await supabase.from("profiles").select("active_company_id").eq("id", user.id).single();
  const companyId = prof?.active_company_id;
  if (!companyId) return NextResponse.json({ error: "No company" }, { status: 400 });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return NextResponse.json({ error: "Server configuration error" }, { status: 500 });
  const adminDb = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: project } = await adminDb.from("projects").select("id, name, company_id").eq("id", projectId).single();
  if (!project || project.company_id !== companyId) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const { data: existing } = await adminDb
    .from("project_gmail_labels").select("id, gmail_label_name")
    .eq("project_id", projectId).is("removed_at", null).maybeSingle();
  if (existing) return NextResponse.json({ ok: true, labelName: existing.gmail_label_name, existed: true });

  const { data: company } = await adminDb
    .from("companies")
    .select("gmail_parent_label, gmail_parent_code, gmail_label_tokens, gmail_sublabel_separator")
    .eq("id", companyId).single();

  const parentLabel = company?.gmail_parent_label || "Shared Emails";
  const parentCode = company?.gmail_parent_code || "";
  const parentFull = parentCode ? `${parentLabel} #${parentCode}` : parentLabel;
  const tokens: string[] = company?.gmail_label_tokens || ["project_name"];
  const separator: string = company?.gmail_sublabel_separator || " — ";

  let matterNumber = "";
  const { data: matterField } = await adminDb
    .from("company_custom_fields").select("id")
    .eq("company_id", companyId).eq("table_name", "projects")
    .ilike("label", "%matter%number%").is("deleted_at", null).maybeSingle();
  if (matterField) {
    const { data: matterVal } = await adminDb
      .from("company_custom_field_values").select("value_text")
      .eq("field_id", matterField.id).eq("record_id", projectId).maybeSingle();
    matterNumber = matterVal?.value_text || "";
  }

  const parts = tokens.map((t: string) => {
    if (t === "project_name") return project.name;
    if (t === "matter_number") return matterNumber || "";
    if (t === "year") return new Date().getFullYear().toString();
    return t;
  }).filter(Boolean);
  const cleanParts = parts.map((p: string) => p.replace(/\//g, ","));
  const labelCode = await generateUniqueLabelCode(adminDb);
  const sublabel = cleanParts.join(separator) + ` [${labelCode}]`;
  const fullLabelName = `${parentFull}/${sublabel}`;

  const { error: pglErr } = await adminDb.from("project_gmail_labels").insert({
    company_id: companyId,
    project_id: projectId,
    gmail_label_name: fullLabelName,
    label_sub: sublabel,
    label_code: labelCode,
    created_by: user.id,
  });
  if (pglErr) {
    console.error("[create-project-label] insert failed:", pglErr.message);
    return NextResponse.json({ error: pglErr.message }, { status: 500 });
  }

  const { data: members } = await adminDb.from("company_memberships").select("user_id").eq("company_id", companyId);
  const memberIds = (members || []).map((m: any) => m.user_id);
  const { data: connected } = memberIds.length
    ? await adminDb.from("user_gmail_tokens").select("user_id").in("user_id", memberIds)
    : { data: [] as any[] };
  const totalUsers = (connected || []).length;

  if (totalUsers > 0) {
    await adminDb.from("gmail_sync_jobs").insert({
      job_type: "label_sync",
      company_id: companyId,
      project_id: projectId,
      label_code: labelCode,
      gmail_label_name: fullLabelName,
      status: "pending",
      attempts: 0,
      completed_users: [],
      total_users: totalUsers,
      is_realtime: true, // a brand-new label should sync ahead of the routine backlog
    });
  }

  return NextResponse.json({ ok: true, labelName: fullLabelName, labelCode });
}
