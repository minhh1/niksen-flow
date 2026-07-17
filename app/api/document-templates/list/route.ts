// app/api/document-templates/list/route.ts
// Admin-side (auth required). Lists templates (+ their fields) and fill-pages for a
// given projectId, scoped to the caller's company. Also returns the project's
// custom fields (table_name = 'projects') so the UI can offer auto-fill bindings.
import { NextRequest, NextResponse } from "next/server";
import { authorizeCompanyMember } from "@/lib/documentTemplateAuth";

export async function GET(req: NextRequest) {
  const auth = await authorizeCompanyMember();
  if (auth.error) return auth.error;
  const { admin, companyId } = auth;

  const projectId = req.nextUrl.searchParams.get("projectId");
  if (!projectId) return NextResponse.json({ error: "projectId is required" }, { status: 400 });

  const { data: project } = await admin.from("projects").select("id, company_id").eq("id", projectId).maybeSingle();
  if (!project || project.company_id !== companyId) {
    return NextResponse.json({ error: "Invalid project" }, { status: 400 });
  }

  const { data: templates } = await admin
    .from("document_templates")
    .select("id, name, description, download_filename, storage_path, created_at, fields:document_template_fields(id, tag_key, label, field_type, select_options, is_required, auto_fill_field_id, default_value, display_order)")
    .eq("company_id", companyId)
    .eq("project_id", projectId)
    .order("created_at", { ascending: false });

  // Sort each template's fields by display_order.
  for (const t of templates || []) {
    (t as any).fields = ((t as any).fields || []).sort((a: any, b: any) => a.display_order - b.display_order);
  }

  const { data: pagesRaw } = await admin
    .from("document_fill_pages")
    .select("id, title, client_name, expires_at, is_active, access_code, created_at, templates:document_fill_page_templates(template_id)")
    .eq("company_id", companyId)
    .eq("project_id", projectId)
    .order("created_at", { ascending: false });

  const pages = (pagesRaw || []).map((p: any) => ({
    id: p.id,
    title: p.title,
    clientName: p.client_name,
    expiresAt: p.expires_at,
    isActive: p.is_active,
    accessCode: p.access_code,
    createdAt: p.created_at,
    templateIds: (p.templates || []).map((t: any) => t.template_id),
  }));

  const { data: customFields } = await admin
    .from("company_custom_fields")
    .select("id, field_key, label, field_type")
    .eq("company_id", companyId)
    .eq("table_name", "projects")
    .order("display_order");

  return NextResponse.json({ templates: templates || [], pages, customFields: customFields || [] });
}
