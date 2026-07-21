// supabase/functions/ai-embed-worker/index.ts
// Chunks + embeds each company's CRM records, Gmail activity, WhatsApp
// messages, and Teams messages into ai_document_chunks (see
// supabase/ai_embeddings.sql), on the schedule set up in
// supabase/ai_embed_cron.sql. Self-contained Deno script, same shape as
// gmail-email-sync-worker/index.ts.
//
// Each row/message becomes exactly one chunk (no further splitting) -- CRM
// rows and individual chat messages are short enough in practice that
// sentence-window chunking isn't needed yet. Revisit if a source ever
// produces multi-page content (e.g. long document attachments).
//
// Embedding path: platform-hosted (Together AI's
// intfloat/multilingual-e5-large-instruct -- its only serverless embedding
// model, confirmed 2026-07-21 against docs.together.ai/docs/serverless-models,
// 1024-dim) if TOGETHER_API_KEY is set, otherwise the company's self-hosted
// Ollama (mxbai-embed-large) from ai_chat_settings.self_hosted_ollama_url.
// ai_document_chunks.embedding is vector(1024) to match the hosted path --
// a self-hosted model that doesn't also output 1024 dims will fail the
// insert below, which is caught per-company and recorded as an error
// rather than crashing the whole run.
//
// Both models are asymmetric retrieval models that need an instruction
// prefix on the *query* side only (see lib/ai/embeddings.ts, used by
// app/api/ai/chat/route.ts) -- document/passage text, which is all this
// worker ever embeds, intentionally gets no prefix per each model's own
// card. Don't add one here to "match" the query side; that would make
// retrieval worse, not better.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } }
);

const TOGETHER_API_KEY = Deno.env.get("TOGETHER_API_KEY");
const CRM_TABLES = ["properties", "entities", "projects"] as const;
const BATCH_SIZE = 50;

// Columns that are structural, not content -- skipped when a CRM row is
// flattened into embeddable text.
const CRM_META_COLUMNS = new Set(["id", "company_id", "created_at", "updated_at", "active_company_id"]);

interface EmbedCandidate {
  sourceId: string;
  sourceUrl: string | null;
  content: string;
  createdAt: string;
}

async function embedTexts(texts: string[], ollamaUrl: string | null): Promise<(number[] | null)[]> {
  if (TOGETHER_API_KEY) {
    const res = await fetch("https://api.together.xyz/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOGETHER_API_KEY}` },
      body: JSON.stringify({ model: "intfloat/multilingual-e5-large-instruct", input: texts }),
    });
    if (!res.ok) throw new Error(`Together embeddings failed: ${res.status} ${await res.text()}`);
    const json = await res.json();
    return json.data.map((d: { embedding: number[] }) => d.embedding);
  }

  if (ollamaUrl) {
    const embeddings: (number[] | null)[] = [];
    for (const text of texts) {
      const res = await fetch(`${ollamaUrl}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "mxbai-embed-large", prompt: text }),
      });
      if (!res.ok) {
        embeddings.push(null);
        continue;
      }
      const json = await res.json();
      embeddings.push(json.embedding ?? null);
    }
    return embeddings;
  }

  // No embedding provider configured for this company -- nothing to do.
  return texts.map(() => null);
}

async function getCursor(companyId: string, sourceType: string): Promise<string> {
  const { data } = await db
    .from("ai_embed_cursors")
    .select("last_embedded_at")
    .eq("company_id", companyId)
    .eq("source_type", sourceType)
    .maybeSingle();
  return data?.last_embedded_at ?? "1970-01-01T00:00:00Z";
}

async function saveCursor(companyId: string, sourceType: string, timestamp: string) {
  await db
    .from("ai_embed_cursors")
    .upsert({ company_id: companyId, source_type: sourceType, last_embedded_at: timestamp }, { onConflict: "company_id,source_type" });
}

function flattenCrmRow(row: Record<string, unknown>): string {
  return Object.entries(row)
    .filter(([key, value]) => !CRM_META_COLUMNS.has(key) && value !== null && value !== "")
    .map(([key, value]) => `${key}: ${typeof value === "object" ? JSON.stringify(value) : value}`)
    .join("\n");
}

async function collectCrmCandidates(companyId: string, since: string): Promise<EmbedCandidate[]> {
  const candidates: EmbedCandidate[] = [];
  for (const table of CRM_TABLES) {
    const { data, error } = await db
      .from(table)
      .select("*")
      .eq("company_id", companyId)
      .gt("created_at", since)
      .order("created_at", { ascending: true })
      .limit(BATCH_SIZE);
    if (error || !data) continue;

    for (const row of data as Record<string, unknown>[]) {
      const content = flattenCrmRow(row);
      if (!content) continue;
      candidates.push({
        sourceId: `${table}:${row.id}`,
        sourceUrl: `/dashboard/${table}?id=${row.id}`,
        content,
        createdAt: row.created_at as string,
      });
    }
  }
  return candidates;
}

// gmail_activity_log (referenced in an earlier version of this function) was
// never real -- its own migration file was superseded by
// gmail_sync_log_reconcile.sql, which deliberately drops it as a duplicate
// of gmail_sync_log. project_emails is the actual first-class table Gmail
// sync writes per-message rows to (subject/snippet/from_name/project_id),
// 2,300+ real rows as of 2026-07-21 -- use that instead.
async function collectGmailCandidates(companyId: string, since: string): Promise<EmbedCandidate[]> {
  const { data, error } = await db
    .from("project_emails")
    .select("id, project_id, subject, snippet, from_name, created_at")
    .eq("company_id", companyId)
    .gt("created_at", since)
    .order("created_at", { ascending: true })
    .limit(BATCH_SIZE);
  if (error || !data) return [];

  return data
    .filter((row) => row.subject || row.snippet)
    .map((row) => ({
      sourceId: row.id,
      sourceUrl: row.project_id ? `/dashboard/projects?id=${row.project_id}` : null,
      content: [row.from_name ? `From: ${row.from_name}` : null, row.subject, row.snippet].filter(Boolean).join("\n"),
      createdAt: row.created_at,
    }));
}

async function collectWhatsAppCandidates(companyId: string, since: string): Promise<EmbedCandidate[]> {
  const { data, error } = await db
    .from("whatsapp_messages")
    .select("id, contact_name, contact_wa_id, body, created_at")
    .eq("company_id", companyId)
    .gt("created_at", since)
    .order("created_at", { ascending: true })
    .limit(BATCH_SIZE);
  if (error || !data) return [];

  return data
    .filter((row) => row.body)
    .map((row) => ({
      sourceId: row.id,
      sourceUrl: null,
      content: `From ${row.contact_name ?? row.contact_wa_id}: ${row.body}`,
      createdAt: row.created_at,
    }));
}

async function collectTeamsCandidates(companyId: string, since: string): Promise<EmbedCandidate[]> {
  const { data, error } = await db
    .from("teams_messages")
    .select("id, from_name, body, created_at")
    .eq("company_id", companyId)
    .gt("created_at", since)
    .order("created_at", { ascending: true })
    .limit(BATCH_SIZE);
  if (error || !data) return [];

  return data
    .filter((row) => row.body)
    .map((row) => ({
      sourceId: row.id,
      sourceUrl: null,
      content: `From ${row.from_name ?? "unknown"}: ${row.body}`,
      createdAt: row.created_at,
    }));
}

async function embedAndStore(companyId: string, sourceType: string, candidates: EmbedCandidate[], ollamaUrl: string | null) {
  if (candidates.length === 0) return;

  const embeddings = await embedTexts(candidates.map((c) => c.content), ollamaUrl);

  // Only candidates whose embedding actually succeeded count toward
  // advancing the cursor -- previously the cursor advanced past every
  // candidate in the batch regardless, so a missing/misconfigured
  // embedding provider (e.g. TOGETHER_API_KEY not set on Supabase, which
  // is a separate secrets store from Vercel's env vars) silently discarded
  // whole batches of real data forever: embedTexts() returned null for
  // everything, nothing got stored, but the cursor still moved past them.
  const succeeded = candidates
    .map((c, i) => ({ c, embedding: embeddings[i] }))
    .filter((x): x is { c: EmbedCandidate; embedding: number[] } => x.embedding !== null);

  if (succeeded.length === 0) return;

  const rows = succeeded.map(({ c, embedding }) => ({
    company_id: companyId,
    source_type: sourceType,
    source_id: c.sourceId,
    source_url: c.sourceUrl,
    content: c.content,
    embedding,
  }));
  await db.from("ai_document_chunks").upsert(rows, { onConflict: "company_id,source_type,source_id" });

  const latest = succeeded.reduce((max, { c }) => (c.createdAt > max ? c.createdAt : max), succeeded[0].c.createdAt);
  await saveCursor(companyId, sourceType, latest);
}

Deno.serve(async () => {
  try {
    return await runEmbedPass();
  } catch (err) {
    // A crash outside the per-company try/catch (e.g. the initial
    // companies/settings queries) used to surface as a bare "Internal
    // Server Error" with no way to tell what broke -- always return
    // diagnosable JSON instead.
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});

async function runEmbedPass(): Promise<Response> {
  const started = Date.now();

  // ai_chat_settings only gets a row once a company's admin actually saves a
  // change on the AI Assistant tab (see app/api/ai/settings/route.ts's POST
  // handler) -- just viewing the tab doesn't create one. Iterating only over
  // existing settings rows meant no company ever got embedded until someone
  // happened to save a settings change, even with sources fully connected.
  // Iterate every company instead, and default missing settings to "all
  // sources enabled" -- same !== false fallback app/api/ai/chat/route.ts uses.
  const { data: companies } = await db.from("companies").select("id");
  const { data: settingsRows } = await db
    .from("ai_chat_settings")
    .select("company_id, source_crm, source_gmail, source_whatsapp, source_teams, self_hosted_ollama_url");
  const settingsByCompany = new Map((settingsRows ?? []).map((s) => [s.company_id, s]));

  const results: Record<string, string> = {};

  for (const company of companies ?? []) {
    const companyId = company.id as string;
    const settings = settingsByCompany.get(companyId);
    const ollamaUrl = settings?.self_hosted_ollama_url ?? null;

    try {
      let embeddedCount = 0;

      if (settings?.source_crm !== false) {
        const since = await getCursor(companyId, "crm_record");
        const candidates = await collectCrmCandidates(companyId, since);
        await embedAndStore(companyId, "crm_record", candidates, ollamaUrl);
        embeddedCount += candidates.length;
      }
      if (settings?.source_gmail !== false) {
        const since = await getCursor(companyId, "gmail");
        const candidates = await collectGmailCandidates(companyId, since);
        await embedAndStore(companyId, "gmail", candidates, ollamaUrl);
        embeddedCount += candidates.length;
      }
      if (settings?.source_whatsapp !== false) {
        const since = await getCursor(companyId, "whatsapp");
        const candidates = await collectWhatsAppCandidates(companyId, since);
        await embedAndStore(companyId, "whatsapp", candidates, ollamaUrl);
        embeddedCount += candidates.length;
      }
      if (settings?.source_teams !== false) {
        const since = await getCursor(companyId, "teams");
        const candidates = await collectTeamsCandidates(companyId, since);
        await embedAndStore(companyId, "teams", candidates, ollamaUrl);
        embeddedCount += candidates.length;
      }

      results[companyId] = `ok: ${embeddedCount} candidates processed`;
    } catch (err) {
      results[companyId] = `error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  await db.from("cron_heartbeats").upsert(
    { name: "ai-embed-worker", last_run_at: new Date().toISOString(), last_duration_ms: Date.now() - started, last_result: results },
    { onConflict: "name" }
  );

  return new Response(JSON.stringify({ companies: Object.keys(results).length, results }), {
    headers: { "Content-Type": "application/json" },
  });
}
