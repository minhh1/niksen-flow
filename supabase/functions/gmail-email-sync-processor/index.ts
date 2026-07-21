// supabase/functions/gmail-email-sync-processor/index.ts
// Does the actual Gmail work for ONE (job, user) pair. Invoked directly by
// gmail-email-sync-worker (the dispatcher) via a plain HTTPS fetch — see
// gmail-label-sync-processor for the full rationale. Since only one user's
// data lives in this isolate, a small internal message-level concurrency is
// safe here (it isn't multiplied by many other jobs/users sharing the same
// isolate the way it was during the 2026-07-21 incident).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } }
);

const FETCH_TIMEOUT_MS = 15_000;
function withTimeout(): AbortSignal { return AbortSignal.timeout(FETCH_TIMEOUT_MS); }

const MESSAGE_CONCURRENCY = 4;

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function sanitiseLabelName(name: string): string {
  const parts = name.split("/");
  if (parts.length <= 1) return name.replace(/\//g, "-");
  const parent = parts.slice(0, -1).join("/");
  const leaf = parts[parts.length - 1].replace(/\//g, "-");
  return `${parent}/${leaf}`;
}

async function getAccessToken(userId: string): Promise<string | null> {
  const { data } = await db.from("user_gmail_tokens")
    .select("access_token, refresh_token, token_expires_at")
    .eq("user_id", userId).single();
  if (!data) return null;
  if (new Date(data.token_expires_at).getTime() < Date.now() + 60_000) {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: Deno.env.get("GOOGLE_CLIENT_ID")!, client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!,
        refresh_token: data.refresh_token, grant_type: "refresh_token",
      }),
      signal: withTimeout(),
    });
    const r = await res.json();
    if (!r.access_token) return null;
    await db.from("user_gmail_tokens").update({
      access_token: r.access_token,
      token_expires_at: new Date(Date.now() + r.expires_in * 1000).toISOString(),
    }).eq("user_id", userId);
    return r.access_token;
  }
  return data.access_token;
}

async function getGmailLabels(token: string): Promise<{ id: string; name: string }[]> {
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/labels", {
    headers: { Authorization: `Bearer ${token}` }, signal: withTimeout(),
  });
  if (!res.ok) return [];
  return (await res.json()).labels || [];
}

function findLabelId(labels: { id: string; name: string }[], labelCode: string | null, labelName: string): string | null {
  if (labelCode) {
    const byCode = labels.find(l => l.name.includes(`[${labelCode}]`));
    if (byCode) return byCode.id;
  }
  const norm = (s: string) => s.replace(/[—–‒]/g, "-").trim().toLowerCase();
  return labels.find(l => norm(l.name) === norm(labelName))?.id || null;
}

async function createLabelHierarchy(token: string, labelName: string, existingLabels: { id: string; name: string }[]): Promise<string | null> {
  const safeName = sanitiseLabelName(labelName);
  const parts = safeName.split("/");
  let lastId: string | null = null;
  for (let i = 1; i <= parts.length; i++) {
    const partial = parts.slice(0, i).join("/");
    const found = existingLabels.find(l => l.name === partial);
    if (found) { lastId = found.id; continue; }
    const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/labels", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: partial, labelListVisibility: "labelShow", messageListVisibility: i === parts.length ? "show" : "hide" }),
      signal: withTimeout(),
    });
    if (res.ok) {
      const c = await res.json();
      lastId = c.id;
      existingLabels.push(c);
    }
  }
  return lastId;
}

async function getMessagesWithLabel(token: string, labelId: string): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    url.searchParams.set("labelIds", labelId);
    url.searchParams.set("maxResults", "500");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` }, signal: withTimeout() });
    if (!res.ok) break;
    const data = await res.json();
    (data.messages || []).forEach((m: any) => ids.push(m.id));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return ids;
}

async function applyLabelOrNotFound(token: string, msgId: string, labelId: string): Promise<"applied" | "not_found"> {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}/modify`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ addLabelIds: [labelId] }), signal: withTimeout(),
  });
  if (res.ok) return "applied";
  if (res.status === 404) return "not_found";
  throw new Error(`Gmail modify failed: ${res.status} ${await res.text().catch(() => "")}`);
}

async function importMessage(sourceToken: string, targetToken: string, msgId: string, labelId: string): Promise<boolean> {
  const rawRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}?format=raw`, {
    headers: { Authorization: `Bearer ${sourceToken}` }, signal: withTimeout(),
  });
  if (!rawRes.ok) return false;
  const { raw } = await rawRes.json();
  if (!raw) return false;
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/import", {
    method: "POST", headers: { Authorization: `Bearer ${targetToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw, labelIds: [labelId, "INBOX"] }), signal: withTimeout(),
  });
  return res.ok;
}

async function markUserComplete(jobId: string, userId: string, totalUsers: number): Promise<void> {
  const { data: job } = await db.from("gmail_sync_jobs")
    .select("completed_users, total_users").eq("id", jobId).single();
  if (!job) return;
  const completed: string[] = job.completed_users || [];
  if (!completed.includes(userId)) completed.push(userId);
  const allDone = completed.length >= (job.total_users || totalUsers);
  await db.from("gmail_sync_jobs").update({
    completed_users: completed, status: allDone ? "done" : "processing", updated_at: new Date().toISOString(),
  }).eq("id", jobId);
}

async function logActivity(row: Record<string, unknown>): Promise<void> {
  try { await db.from("gmail_sync_log").insert(row); } catch (_) { /* never break sync over logging */ }
}

async function quarantineUser(params: {
  companyId: string; jobId: string; jobType: string; projectId: string; userId: string;
  gmailLabelName: string; error: string;
}): Promise<void> {
  try {
    const { data: existing } = await db.from("gmail_sync_failures")
      .select("id, status").eq("job_id", params.jobId).eq("user_id", params.userId).maybeSingle();
    if (existing) {
      if (existing.status === "resolved") {
        await db.from("gmail_sync_failures").update({
          status: "pending_retry", attempts: 0, last_error: params.error,
          first_failed_at: new Date().toISOString(), last_attempted_at: new Date().toISOString(), resolved_at: null,
        }).eq("id", existing.id);
      } else {
        await db.from("gmail_sync_failures").update({
          last_error: params.error, last_attempted_at: new Date().toISOString(),
        }).eq("id", existing.id);
      }
    } else {
      await db.from("gmail_sync_failures").insert({
        company_id: params.companyId, job_id: params.jobId, job_type: params.jobType,
        project_id: params.projectId, user_id: params.userId,
        status: "pending_retry", last_error: params.error, last_attempted_at: new Date().toISOString(),
      });
    }
  } catch (_) { /* never break sync over quarantine bookkeeping */ }

  await logActivity({
    company_id: params.companyId, triggered_by: null, action: "sync_error",
    project_id: params.projectId, gmail_label_name: params.gmailLabelName,
    target_user_id: params.userId, details: { job_type: params.jobType, error: params.error },
  });
}

function respond(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

interface ProcessorRequest {
  jobId: string; userId: string; companyId: string; projectId: string;
  labelCode: string | null; gmailLabelName: string; totalUsers: number;
  msgIds: string[]; subjectByMsgId: Record<string, string | null>;
  sourceToken: string | null; sourceUserId: string;
}

Deno.serve(async (req) => {
  let body: ProcessorRequest;
  try { body = await req.json(); } catch {
    return respond({ ok: false, error: "Invalid request body" }, 400);
  }

  const { jobId, userId, companyId, projectId, labelCode, totalUsers, msgIds, subjectByMsgId, sourceToken, sourceUserId } = body;
  const gmailLabelName = sanitiseLabelName(body.gmailLabelName || "");
  console.log(`[email-sync-processor] job=${jobId} user=${userId} messages=${msgIds.length}`);

  try {
    const token = await getAccessToken(userId);
    if (!token) {
      console.log(`[email-sync-processor] No token for ${userId}`);
      return respond({ ok: true, userId, skipped: "no_token" });
    }

    const gmailLabels = await getGmailLabels(token);
    let labelId = findLabelId(gmailLabels, labelCode, gmailLabelName);
    if (!labelId) labelId = await createLabelHierarchy(token, gmailLabelName, gmailLabels);
    if (!labelId) throw new Error("Could not find or create label");

    const labelled = new Set(await getMessagesWithLabel(token, labelId));
    const toProcess = msgIds.filter(id => !labelled.has(id));

    let imported = 0, applied = 0;
    await mapWithConcurrency(toProcess, MESSAGE_CONCURRENCY, async (msgId) => {
      const result = await applyLabelOrNotFound(token, msgId, labelId!);
      if (result === "applied") {
        applied++;
        await logActivity({
          company_id: companyId, triggered_by: null, action: "sync_to_user",
          project_id: projectId, gmail_message_id: msgId, gmail_label_name: gmailLabelName,
          target_user_id: userId, details: { label_code: labelCode, subject: subjectByMsgId[msgId] || null },
        });
      } else if (sourceToken && userId !== sourceUserId) {
        const ok = await importMessage(sourceToken, token, msgId, labelId!);
        if (ok) {
          imported++;
          await logActivity({
            company_id: companyId, triggered_by: null, action: "sync_to_user",
            project_id: projectId, gmail_message_id: msgId, gmail_label_name: gmailLabelName,
            target_user_id: userId, details: { label_code: labelCode, subject: subjectByMsgId[msgId] || null },
          });
        }
      }
    });

    console.log(`[email-sync-processor] User ${userId}: applied=${applied} imported=${imported} skipped=${msgIds.length - toProcess.length}`);

    if (applied + imported > 0) {
      await db.from("project_emails").update({ gmail_label_applied: true })
        .eq("project_id", projectId).eq("company_id", companyId).eq("user_id", userId);
    }

    await markUserComplete(jobId, userId, totalUsers);
    return respond({ ok: true, userId, applied, imported });

  } catch (err: any) {
    console.error(`[email-sync-processor] ✗ User ${userId} failed:`, err.message);
    await quarantineUser({
      companyId, jobId, jobType: "email_sync", projectId, userId,
      gmailLabelName, error: err.message || "Unknown error",
    });
    return respond({ ok: false, userId, quarantined: true, error: err.message });
  }
});
