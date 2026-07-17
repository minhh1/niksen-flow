// app/api/document-templates/public/[pageId]/submit/route.ts
// GENUINELY UNAUTHENTICATED client-facing route. Like the sibling GET route it
// performs NO supabase.auth.getUser() and NO session/membership check of any kind —
// access is gated only by loadActiveFillPage (page exists + active + not expired),
// using the service-role admin client throughout.
//
// On submit: validates required fields, records a document_fill_submissions row, then
// for each bundled template downloads its source .docx, renders {{tag}} -> value with
// docxtemplater (pizzip zip engine), uploads the rendered .docx, and inserts a
// document_fill_generated_files row. If more than one template was rendered they are
// also zipped together with jszip. Returns short-lived signed URLs (bucket is private).
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { loadActiveFillPage, codeMatches } from "@/lib/documentFillPageGate";
import { findSoleTagParagraphs, cleanupDocxBuffer } from "@/lib/docxCleanup";
import PizZip from "pizzip";
import Docxtemplater from "docxtemplater";
import JSZip from "jszip";

const SIGNED_URL_TTL = 3600; // seconds

function safeFileName(name: string): string {
  const base = (name || "document").replace(/\.docx$/i, "").replace(/[^\w\-. ]+/g, "_").trim() || "document";
  return `${base}.docx`;
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ pageId: string }> }) {
  const { pageId } = await params;

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const gate = await loadActiveFillPage(admin, pageId);
  if (gate.error) return gate.error;
  const { page } = gate;

  let body: any;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  // Re-check the access code here too — the GET route already gated the
  // form, but submit is an independent request and must not be bypassable
  // by calling it directly.
  if (!codeMatches(page, body?.code)) {
    return NextResponse.json({ error: "Incorrect access code" }, { status: 401 });
  }

  const submitted: Record<string, any> = (body?.values && typeof body.values === "object") ? body.values : {};
  // Fields the client explicitly marked "Not applicable" — treated as
  // intentionally blank (satisfies "required", forces a blank value even if
  // stale text is sitting in `submitted`) rather than just an empty input,
  // so the doc-cleanup pass below removes the line for them too.
  const naFields: Set<string> = new Set(Array.isArray(body?.naFields) ? body.naFields : []);

  // ── Load the page's templates + their fields ─────────────────────
  const { data: joins } = await admin
    .from("document_fill_page_templates").select("template_id").eq("page_id", pageId);
  const templateIds = (joins || []).map((j: any) => j.template_id);
  if (!templateIds.length) return NextResponse.json({ error: "This page has no templates" }, { status: 400 });

  // "Generate this document only" scopes rendering (and required-field
  // validation below) to a subset of the page's bundled templates; omitting
  // templateIds (or sending an empty/invalid one) falls back to generating
  // everything, matching the original "Generate all documents" behavior.
  const requestedTemplateIds: string[] = Array.isArray(body?.templateIds) ? body.templateIds : [];
  const targetTemplateIds = requestedTemplateIds.length
    ? templateIds.filter((id: string) => requestedTemplateIds.includes(id))
    : templateIds;
  if (!targetTemplateIds.length) return NextResponse.json({ error: "No valid document selected" }, { status: 400 });

  const { data: templates } = await admin
    .from("document_templates").select("id, name, download_filename, storage_path").in("id", targetTemplateIds);

  const { data: fieldRows } = await admin
    .from("document_template_fields")
    .select("id, template_id, tag_key, label, is_required, auto_fill_field_id, joined_to_field_id")
    .in("template_id", templateIds);

  // Resolve each field to its join-root — mirrors the GET route (see
  // app/api/document-templates/public/[pageId]/route.ts for the full
  // rationale). The client's form was built from that same resolution, so
  // `values`/`naFields` here are keyed by ROOT tag_key; each field row still
  // substitutes into its OWN literal {{tag}} placeholder in its own document.
  const fieldsById = new Map((fieldRows || []).map((f: any) => [f.id, f]));
  function pageLocalRoot(f: any): any {
    let current = f;
    const seen = new Set<string>();
    while (current.joined_to_field_id && fieldsById.has(current.joined_to_field_id) && !seen.has(current.id)) {
      seen.add(current.id);
      current = fieldsById.get(current.joined_to_field_id);
    }
    return current;
  }

  // ── Resolve auto-fill values from the project's custom field data ──
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

  // Effective value for a tag: "Not applicable" always wins (forces blank
  // even over stale submitted text), then whatever the client actually
  // submitted (which already started out pre-filled with the auto-fill or
  // default value — see the GET route — so this is what they chose to keep,
  // edit, or delete), else its auto-fill value as a last-resort fallback if
  // the client genuinely never touched the field. Default values are NOT
  // reapplied here — they only ever pre-fill the input once; if the client
  // deletes that text without marking "Not applicable", it must stay blank
  // rather than silently reappearing in the generated document.
  const effective = (tagKey: string, autoFillFieldId: string | null): string => {
    if (naFields.has(tagKey)) return "";
    const s = submitted[tagKey];
    if (s !== undefined && s !== null) return String(s);
    if (autoFillFieldId && autoFillValues[autoFillFieldId] != null) return String(autoFillValues[autoFillFieldId]);
    return "";
  };

  // ── Validate required fields (de-duplicated by join-resolved tag_key) ──
  // A field marked "Not applicable" satisfies its own requiredness — that's
  // the whole point of the button. Scoped to the documents actually being
  // generated — a required field exclusive to a document that isn't part of
  // this "generate this document only" request shouldn't block it. Uses
  // each field's ROOT for requiredness/label, since once joined the group
  // is treated as one field (see pageLocalRoot above).
  const seenReq = new Set<string>();
  for (const f of (fieldRows || []).filter((f: any) => targetTemplateIds.includes(f.template_id))) {
    const root = pageLocalRoot(f);
    if (!root.is_required || seenReq.has(root.tag_key)) continue;
    seenReq.add(root.tag_key);
    if (naFields.has(root.tag_key)) continue;
    if (!effective(root.tag_key, root.auto_fill_field_id)) {
      return NextResponse.json({ error: `"${root.label}" is required` }, { status: 400 });
    }
  }

  // ── Record the submission ────────────────────────────────────────
  const { data: submission, error: subErr } = await admin.from("document_fill_submissions").insert({
    page_id: pageId,
    values: submitted,
  }).select("id").single();
  if (subErr || !submission) return NextResponse.json({ error: subErr?.message || "Failed to save submission" }, { status: 500 });

  // ── Render each template ─────────────────────────────────────────
  const bucket = admin.storage.from("document-templates");
  const generated: { name: string; storagePath: string; buffer: Buffer }[] = [];

  for (const tpl of templates || []) {
    const { data: fileData, error: dlErr } = await bucket.download(tpl.storage_path);
    if (dlErr || !fileData) {
      return NextResponse.json({ error: `Could not load template "${tpl.name}"` }, { status: 500 });
    }
    const srcBuffer = Buffer.from(await fileData.arrayBuffer());

    // Build this template's substitution map from its own fields — each
    // substitutes into ITS OWN literal {{tag}} placeholder, but the value
    // comes from its join-resolved root (shared across every document that
    // joins onto the same answer).
    const data: Record<string, string> = {};
    for (const f of (fieldRows || []).filter((f: any) => f.template_id === tpl.id)) {
      const root = pageLocalRoot(f);
      data[f.tag_key] = effective(root.tag_key, root.auto_fill_field_id);
    }

    let out: Buffer;
    try {
      // Read the ORIGINAL (pre-render) document.xml from a separate PizZip
      // instance to find paragraphs whose only content is a tag — that's
      // only knowable before rendering (see lib/docxCleanup.ts).
      const analysisZip = new PizZip(srcBuffer);
      const soleTagParas = findSoleTagParagraphs(analysisZip.file("word/document.xml")?.asText() || "");

      const zip = new PizZip(srcBuffer);
      const doc = new Docxtemplater(zip, {
        paragraphLoop: true,
        linebreaks: true,
        delimiters: { start: "{{", end: "}}" },
        nullGetter: () => "",
      });
      doc.render(data);
      out = doc.getZip().generate({ type: "nodebuffer" });
      out = cleanupDocxBuffer(out, soleTagParas);
    } catch (e: any) {
      return NextResponse.json({ error: `Failed to generate "${tpl.name}": ${e?.message || "render error"}` }, { status: 500 });
    }

    const storagePath = `generated/${pageId}/${submission.id}/${tpl.id}.docx`;
    const { error: upErr } = await bucket.upload(storagePath, out, {
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      upsert: true,
    });
    if (upErr) return NextResponse.json({ error: `Failed to store "${tpl.name}": ${upErr.message}` }, { status: 500 });

    await admin.from("document_fill_generated_files").insert({
      submission_id: submission.id,
      template_id: tpl.id,
      storage_path: storagePath,
    });

    generated.push({ name: safeFileName(tpl.download_filename || tpl.name), storagePath, buffer: out });
  }

  // ── Signed download URLs ─────────────────────────────────────────
  const files: { name: string; url: string }[] = [];
  for (const g of generated) {
    const { data: signed } = await bucket.createSignedUrl(g.storagePath, SIGNED_URL_TTL);
    if (signed?.signedUrl) files.push({ name: g.name, url: signed.signedUrl });
  }

  // ── Zip all outputs together when there's more than one ──────────
  let zipUrl: string | null = null;
  if (generated.length > 1) {
    const jszip = new JSZip();
    const used = new Set<string>();
    for (const g of generated) {
      // Guard against duplicate template names colliding inside the zip.
      let name = g.name;
      let i = 2;
      while (used.has(name)) { name = g.name.replace(/\.docx$/i, ` (${i}).docx`); i++; }
      used.add(name);
      jszip.file(name, g.buffer);
    }
    const zipBuffer = await jszip.generateAsync({ type: "nodebuffer" });
    const zipPath = `generated/${pageId}/${submission.id}/documents.zip`;
    const { error: zErr } = await bucket.upload(zipPath, zipBuffer, { contentType: "application/zip", upsert: true });
    if (!zErr) {
      const { data: signed } = await bucket.createSignedUrl(zipPath, SIGNED_URL_TTL);
      zipUrl = signed?.signedUrl || null;
    }
  }

  return NextResponse.json({ ok: true, files, zipUrl });
}
