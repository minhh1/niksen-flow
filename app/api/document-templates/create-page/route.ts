// app/api/document-templates/create-page/route.ts
// Admin-side (auth required). Creates a client-facing document_fill_pages row plus
// document_fill_page_templates join rows for the selected templateIds. Mirrors the
// auth+company-membership check in app/api/public-tasks/create/route.ts.
import { NextRequest, NextResponse } from "next/server";
import { authorizeCompanyMember } from "@/lib/documentTemplateAuth";

export async function POST(req: NextRequest) {
  const auth = await authorizeCompanyMember();
  if (auth.error) return auth.error;
  const { admin, user, companyId } = auth;

  let body: any;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const { title, projectId, expiresAt, templateIds, accessCode, clientName } = body;
  if (!title?.trim()) return NextResponse.json({ error: "Title is required" }, { status: 400 });
  if (!projectId) return NextResponse.json({ error: "projectId is required" }, { status: 400 });
  if (!Array.isArray(templateIds) || templateIds.length === 0) {
    return NextResponse.json({ error: "Select at least one template" }, { status: 400 });
  }

  const { data: project } = await admin.from("projects").select("id, company_id").eq("id", projectId).maybeSingle();
  if (!project || project.company_id !== companyId) {
    return NextResponse.json({ error: "Invalid project" }, { status: 400 });
  }

  // Every selected template must belong to this company + project.
  const { data: templates } = await admin
    .from("document_templates").select("id")
    .eq("company_id", companyId).eq("project_id", projectId).in("id", templateIds);
  const validIds = new Set((templates || []).map((t: any) => t.id));
  const cleanTemplateIds = templateIds.filter((id: string) => validIds.has(id));
  if (cleanTemplateIds.length === 0) {
    return NextResponse.json({ error: "No valid templates selected" }, { status: 400 });
  }

  const { data: page, error } = await admin.from("document_fill_pages").insert({
    company_id: companyId,
    project_id: projectId,
    title: title.trim(),
    expires_at: expiresAt || null,
    access_code: accessCode?.trim() || null,
    client_name: clientName?.trim() || null,
    created_by: user.id,
  }).select("id").single();

  if (error || !page) return NextResponse.json({ error: error?.message || "Failed to create page" }, { status: 500 });

  const { error: joinErr } = await admin.from("document_fill_page_templates").insert(
    cleanTemplateIds.map((templateId: string) => ({ page_id: page.id, template_id: templateId }))
  );
  if (joinErr) {
    await admin.from("document_fill_pages").delete().eq("id", page.id);
    return NextResponse.json({ error: joinErr.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, pageId: page.id });
}
