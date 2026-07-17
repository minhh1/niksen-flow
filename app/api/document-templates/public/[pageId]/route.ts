// app/api/document-templates/public/[pageId]/route.ts
// GENUINELY UNAUTHENTICATED client-facing route. External clients/customers have no
// account in this system, so this route performs NO supabase.auth.getUser() and NO
// session/membership check of any kind — access is gated only by the page id
// existing, is_active = true, and expires_at not in the past (see loadActiveFillPage).
// Uses the service-role admin client throughout because there is no user session.
//
// Returns the page title + a computed `heading` ("Documents Template" or
// "Documents Template - {clientName}") + the merged, de-duplicated (by
// tag_key) list of fields across all the page's joined templates, pre-
// filling any auto_fill_field_id-bound value from the project's custom
// field data. Each document also carries `fieldTagKeys` — which of the
// deduped fields belong to it — so the client page can show one tab per
// document with just its own fields.
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { loadActiveFillPage, codeMatches } from "@/lib/documentFillPageGate";

function computeHeading(clientName: string | null): string {
  return clientName ? `Documents Template - ${clientName}` : "Documents Template";
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ pageId: string }> }) {
  const { pageId } = await params;

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const gate = await loadActiveFillPage(admin, pageId);
  if (gate.error) return gate.error;
  const { page } = gate;

  // Access-code gate — a second, independent check on top of expiry/active.
  // No code supplied yet: tell the client a code is needed without leaking
  // the field list. Wrong code: 401. Both cases skip the rest of this route.
  const heading = computeHeading(page.client_name);

  if (page.access_code) {
    const code = req.nextUrl.searchParams.get("code");
    if (!code) return NextResponse.json({ title: page.title, heading, requiresCode: true, documents: [], fields: [] });
    if (!codeMatches(page, code)) {
      return NextResponse.json({ error: "Incorrect access code" }, { status: 401 });
    }
  }

  // Templates bundled into this page.
  const { data: joins } = await admin
    .from("document_fill_page_templates").select("template_id").eq("page_id", pageId);
  const templateIds = (joins || []).map((j: any) => j.template_id);
  if (!templateIds.length) {
    return NextResponse.json({ title: page.title, heading, requiresCode: false, documents: [], fields: [] });
  }

  const { data: templateRows } = await admin
    .from("document_templates").select("id, name, description").in("id", templateIds);

  const { data: fieldRows } = await admin
    .from("document_template_fields")
    .select("id, template_id, tag_key, label, field_type, select_options, is_required, auto_fill_field_id, default_value, display_order")
    .in("template_id", templateIds)
    .order("display_order");

  // ── Resolve auto-fill values from the project's custom field data ──
  // Read shape mirrors RecordDashboard.tsx's company_custom_field_values merge.
  const autoFillFieldIds = [...new Set((fieldRows || []).map((f: any) => f.auto_fill_field_id).filter(Boolean))];
  const autoFillValues: Record<string, any> = {};
  if (autoFillFieldIds.length) {
    const { data: values } = await admin
      .from("company_custom_field_values")
      .select("field_id, value_text, value_number, value_date, value_boolean")
      .eq("record_id", page.project_id)
      .in("field_id", autoFillFieldIds);
    for (const v of values || []) {
      autoFillValues[v.field_id] = v.value_text ?? v.value_number ?? v.value_date ?? v.value_boolean ?? null;
    }
  }

  // ── De-duplicate by tag_key (a tag shared by two templates is asked once) ──
  const seen = new Set<string>();
  const fields: any[] = [];
  for (const f of fieldRows || []) {
    if (seen.has(f.tag_key)) continue;
    seen.add(f.tag_key);
    const autoVal = f.auto_fill_field_id ? autoFillValues[f.auto_fill_field_id] ?? null : null;
    const autoFilled = autoVal !== null && autoVal !== undefined && autoVal !== "";
    // Default value only kicks in when there's no actual project data to
    // auto-fill from — real project data always wins over a generic fallback.
    const isDefault = !autoFilled && !!f.default_value;
    fields.push({
      tagKey: f.tag_key,
      label: f.label,
      fieldType: f.field_type,
      selectOptions: f.select_options,
      isRequired: f.is_required,
      autoFilled,
      isDefault,
      value: autoFilled ? String(autoVal) : (isDefault ? String(f.default_value) : ""),
    });
  }

  // Which deduped tag keys belong to each document — powers one tab per
  // document on the client page, each showing only its own fields (a tag
  // shared across documents just shows up on every tab that uses it, kept
  // in sync since they all read/write the same `values[tagKey]`).
  const documents = (templateRows || []).map((t: any) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    fieldTagKeys: [...new Set((fieldRows || []).filter((f: any) => f.template_id === t.id).map((f: any) => f.tag_key))],
  }));

  return NextResponse.json({ title: page.title, heading, requiresCode: false, documents, fields });
}
