// app/api/document-templates/[id]/route.ts
// Admin-side (auth required). `id` here is the templateId. PATCH updates a
// template's description (shown to the client on the fill-in link, see
// app/public/documents/[pageId]/page.tsx) and download_filename (the base
// filename used for the generated .docx — falls back to the template's own
// `name` when unset, see safeFileName() in the submit route). DELETE removes
// a document template: the stored .docx object, then the DB row (cascades to
// document_template_fields and document_fill_page_templates join rows via
// FK ON DELETE CASCADE — a template used by an existing client link is
// simply dropped from that link's document set, not blocked).
import { NextRequest, NextResponse } from "next/server";
import { authorizeCompanyMember } from "@/lib/documentTemplateAuth";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: templateId } = await params;

  const auth = await authorizeCompanyMember();
  if (auth.error) return auth.error;
  const { admin, companyId } = auth;

  const { data: template } = await admin
    .from("document_templates").select("id, company_id").eq("id", templateId).maybeSingle();
  if (!template || template.company_id !== companyId) {
    return NextResponse.json({ error: "Template not found" }, { status: 404 });
  }

  let body: any;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const update: Record<string, string | null> = {};
  if ("description" in body) update.description = String(body?.description || "").trim() || null;
  if ("download_filename" in body) update.download_filename = String(body?.download_filename || "").trim() || null;

  const { error } = await admin.from("document_templates").update(update).eq("id", templateId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: templateId } = await params;

  const auth = await authorizeCompanyMember();
  if (auth.error) return auth.error;
  const { admin, companyId } = auth;

  const { data: template } = await admin
    .from("document_templates").select("id, company_id, storage_path").eq("id", templateId).maybeSingle();
  if (!template || template.company_id !== companyId) {
    return NextResponse.json({ error: "Template not found" }, { status: 404 });
  }

  await admin.storage.from("document-templates").remove([template.storage_path]);

  const { error } = await admin.from("document_templates").delete().eq("id", templateId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
