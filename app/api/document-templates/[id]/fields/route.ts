// app/api/document-templates/[id]/fields/route.ts
// Admin-side (auth required). PATCH bulk-updates a template's field metadata
// (label / type / required / auto_fill binding) from a submitted array. `id` here
// is the templateId.
//
// NOTE: this route lives under the shared `[id]` slug (rather than the plan's
// literal `[templateId]`) because a sibling route needs `[id]` too, and Next.js
// forbids two different dynamic slug names at the same path segment.
import { NextRequest, NextResponse } from "next/server";
import { authorizeCompanyMember } from "@/lib/documentTemplateAuth";

const VALID_TYPES = new Set(["text", "date", "number", "currency", "select", "multiselect"]);

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: templateId } = await params;

  const auth = await authorizeCompanyMember();
  if (auth.error) return auth.error;
  const { admin, companyId } = auth;

  // Template must belong to the caller's company.
  const { data: template } = await admin
    .from("document_templates").select("id, company_id").eq("id", templateId).maybeSingle();
  if (!template || template.company_id !== companyId) {
    return NextResponse.json({ error: "Template not found" }, { status: 404 });
  }

  let body: any;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const fields = body?.fields;
  if (!Array.isArray(fields)) return NextResponse.json({ error: "fields array is required" }, { status: 400 });

  // Only update fields that actually belong to this template.
  const { data: existing } = await admin
    .from("document_template_fields").select("id").eq("template_id", templateId);
  const ownIds = new Set((existing || []).map((f: any) => f.id));

  for (const f of fields) {
    if (!ownIds.has(f.id)) continue;
    const fieldType = VALID_TYPES.has(f.field_type) ? f.field_type : "text";
    const { error } = await admin.from("document_template_fields").update({
      label: String(f.label || "").trim() || f.tag_key || "Field",
      field_type: fieldType,
      select_options: (fieldType === "select" || fieldType === "multiselect") ? (f.select_options ?? null) : null,
      is_required: !!f.is_required,
      auto_fill_field_id: f.auto_fill_field_id || null,
      default_value: String(f.default_value || "").trim() || null,
    }).eq("id", f.id).eq("template_id", templateId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const { data: updated } = await admin
    .from("document_template_fields")
    .select("id, tag_key, label, field_type, select_options, is_required, auto_fill_field_id, default_value, display_order")
    .eq("template_id", templateId)
    .order("display_order");

  return NextResponse.json({ ok: true, fields: updated || [] });
}
