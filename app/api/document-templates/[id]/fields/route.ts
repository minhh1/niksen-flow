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

  // Fields already in this template vs. brand-new ones the admin authored
  // inline (a "branch-only" question with no {{tag}} in the document — see
  // is_branch_only) that arrived in this same batch with a client-generated
  // id, to be inserted rather than updated.
  const { data: existing } = await admin
    .from("document_template_fields").select("id, is_branch_only").eq("template_id", templateId);
  const ownIds = new Set((existing || []).map((f: any) => f.id));
  // Trigger fields must point at a field that will actually exist once this
  // save completes — includes ids brand-new in this same batch, since a
  // freshly-created branch-only question is typically wired up as a trigger
  // in the very save that creates it.
  const allIds = new Set<string>([...ownIds, ...fields.map(f => f.id)]);

  // A branch-only question missing from this save was deleted client-side —
  // safe to actually remove since it never corresponded to a real {{tag}}
  // in the document. Deliberately scoped to is_branch_only only: a real,
  // document-detected field silently missing from the payload (a bug, a
  // stale client, whatever) must never be deleted, since its {{tag}}
  // placeholder would be left unfillable in the generated document.
  const incomingIds = new Set(fields.map(f => f.id));
  const toDelete = (existing || []).filter(f => f.is_branch_only && !incomingIds.has(f.id)).map(f => f.id);
  if (toDelete.length) {
    const { error } = await admin.from("document_template_fields").delete().in("id", toDelete).eq("template_id", templateId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Trigger fields must point within this same template and can't create a
  // cycle. The whole array arrives in one batch, so cycles are resolvable
  // up front from the submitted trigger_field_id values (falling back to
  // null for anything invalid) before any row is written.
  const proposedTrigger = new Map<string, string | null>();
  for (const f of fields) {
    const t = f.trigger_field_id;
    proposedTrigger.set(f.id, (t && allIds.has(t) && t !== f.id) ? t : null);
  }
  function createsCycle(fieldId: string): boolean {
    const seen = new Set<string>();
    let current: string | null = fieldId;
    while (current) {
      if (seen.has(current)) return true;
      seen.add(current);
      current = proposedTrigger.get(current) ?? null;
      if (current === fieldId) return true;
    }
    return false;
  }
  for (const id of proposedTrigger.keys()) {
    if (createsCycle(id)) proposedTrigger.set(id, null);
  }

  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    const fieldType = VALID_TYPES.has(f.field_type) ? f.field_type : "text";
    const triggerFieldId = proposedTrigger.get(f.id) ?? null;
    const payload = {
      label: String(f.label || "").trim() || f.tag_key || "Field",
      field_type: fieldType,
      select_options: (fieldType === "select" || fieldType === "multiselect") ? (f.select_options ?? null) : null,
      is_required: !!f.is_required,
      auto_fill_field_id: f.auto_fill_field_id || null,
      default_value: String(f.default_value || "").trim() || null,
      trigger_field_id: triggerFieldId,
      trigger_value: triggerFieldId ? (String(f.trigger_value || "").trim() || null) : null,
      is_branch_only: !!f.is_branch_only,
      // Persist the order the admin arranged fields into client-side —
      // display_order was previously read-only (only ever set once at
      // upload time from tag-discovery order).
      display_order: i,
    };
    if (ownIds.has(f.id)) {
      const { error } = await admin.from("document_template_fields").update(payload).eq("id", f.id).eq("template_id", templateId);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    } else {
      const tagKey = String(f.tag_key || "").trim();
      if (!tagKey) continue; // nothing to insert without a tag_key — see the "new branching question" flow, which always generates one
      const { error } = await admin.from("document_template_fields").insert({ id: f.id, template_id: templateId, tag_key: tagKey, ...payload });
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    }
  }

  const { data: updated } = await admin
    .from("document_template_fields")
    .select("id, tag_key, label, field_type, select_options, is_required, auto_fill_field_id, default_value, joined_to_field_id, trigger_field_id, trigger_value, is_branch_only, display_order")
    .eq("template_id", templateId)
    .order("display_order");

  return NextResponse.json({ ok: true, fields: updated || [] });
}
