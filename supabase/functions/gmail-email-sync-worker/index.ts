// supabase/functions/gmail-email-sync-worker/index.ts
// Every 1 min via pg_cron — DISPATCHER ONLY. See gmail-label-sync-worker
// for the full rationale: cheap DB-only pass here, actual Gmail work fans
// out to gmail-email-sync-processor via plain HTTPS fetch, one invocation
// per pending user, each in its own isolate.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } }
);

const googleClientId = Deno.env.get("GOOGLE_CLIENT_ID")!;
const googleClientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const PROCESSOR_URL = `${SUPABASE_URL}/functions/v1/gmail-email-sync-processor`;

const MAX_ATTEMPTS = 3;
// Per-job work here also includes a Gmail metadata backfill for NULL-subject
// rows, so this dispatcher is heavier than the label-sync one — same
// DISPATCH_CONCURRENCY ceiling applies, so keep the per-tick job count modest.
// See gmail-label-sync-worker for why pacing is ~1 req/s, not 2.86 req/s —
// empirically the gateway's sustainable rate is lower than that.
const BATCH_SIZE = 5;
const DISPATCH_CONCURRENCY = 3;
const MIN_DISPATCH_INTERVAL_MS = 1000; // paces request starts to stay under the gateway's own rate limit
const DISPATCH_TIMEOUT_MS = 90_000; // processor may sync many messages for one user

const FETCH_TIMEOUT_MS = 15_000;
function withTimeout(): AbortSignal { return AbortSignal.timeout(FETCH_TIMEOUT_MS); }

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
        client_id: googleClientId, client_secret: googleClientSecret,
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

async function logActivity(row: Record<string, unknown>): Promise<void> {
  try { await db.from("gmail_sync_log").insert(row); } catch (_) { /* never break sync over logging */ }
}

async function heartbeat(name: string, durationMs: number, result: unknown): Promise<void> {
  try {
    await db.from("cron_heartbeats").upsert(
      { name, last_run_at: new Date().toISOString(), last_duration_ms: durationMs, last_result: result },
      { onConflict: "name" }
    );
  } catch (_) { /* never break sync */ }
}

function respond(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

interface DispatchUnit {
  jobId: string; userId: string; companyId: string; projectId: string;
  labelCode: string | null; gmailLabelName: string; totalUsers: number;
  msgIds: string[]; subjectByMsgId: Record<string, string | null>;
  sourceToken: string | null; sourceUserId: string;
}

// See gmail-label-sync-worker for the rationale: the gateway limit is a
// token bucket, not a pure concurrency cap, so pace request starts directly.
let nextSlotAt = 0;
async function paceDispatch(): Promise<void> {
  const now = Date.now();
  const wait = Math.max(0, nextSlotAt - now);
  nextSlotAt = Math.max(now, nextSlotAt) + MIN_DISPATCH_INTERVAL_MS;
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
}

async function dispatchOnce(unit: DispatchUnit): Promise<{ quarantined?: boolean } | null> {
  await paceDispatch();
  const res = await fetch(PROCESSOR_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(unit),
    signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
  });
  return await res.json().catch(() => ({}));
}

async function dispatchOne(unit: DispatchUnit): Promise<"ok" | "quarantined" | "dispatch_error"> {
  try {
    const data = await dispatchOnce(unit);
    if (data?.quarantined) return "quarantined";
    return "ok";
  } catch (err: any) {
    // Supabase's own function gateway rate-limits concurrent invocations
    // and tells us how long to back off — worth one retry within the same
    // tick before giving up, since DISPATCH_CONCURRENCY alone won't catch
    // every burst.
    const backoffMatch = /retry after (\d+)ms/i.exec(err.message || "");
    if (backoffMatch) {
      const waitMs = Math.min(parseInt(backoffMatch[1], 10), 5000);
      await new Promise(r => setTimeout(r, waitMs));
      try {
        const data = await dispatchOnce(unit);
        if (data?.quarantined) return "quarantined";
        return "ok";
      } catch (retryErr: any) {
        err = retryErr;
      }
    }

    console.error(`[email-sync-worker] Dispatch failed for user ${unit.userId} job ${unit.jobId}:`, err.message);
    await logActivity({
      company_id: unit.companyId, triggered_by: null, action: "dispatch_error",
      project_id: unit.projectId, gmail_label_name: unit.gmailLabelName,
      target_user_id: unit.userId, details: { job_type: "email_sync", error: err.message },
    });
    return "dispatch_error";
  }
}

const LOCK_NAME = "gmail-email-sync-worker";
const LOCK_TTL_MS = 170_000; // longer than the 150s platform ceiling, so a genuinely-still-running tick keeps its lock

async function acquireLock(): Promise<boolean> {
  const { data } = await db.from("dispatcher_locks")
    .update({ locked_until: new Date(Date.now() + LOCK_TTL_MS).toISOString() })
    .eq("name", LOCK_NAME).lt("locked_until", new Date().toISOString()).select();
  return !!data && data.length > 0;
}

async function releaseLock(): Promise<void> {
  try { await db.from("dispatcher_locks").update({ locked_until: new Date().toISOString() }).eq("name", LOCK_NAME); } catch (_) {}
}

Deno.serve(async (_req) => {
  console.log("[email-sync-worker] ========== DISPATCH START ==========");
  const t0 = Date.now();

  if (!(await acquireLock())) {
    console.log("[email-sync-worker] Previous tick still running — skipping");
    return respond({ ok: true, skipped: "already_running" });
  }

  try {
    return await runDispatch(t0);
  } finally {
    await releaseLock();
  }
});

async function runDispatch(t0: number): Promise<Response> {
  // Realtime-flagged jobs (a genuinely new email, deletion, or newly-
  // created label, per gmail-push/gmail-addon) sort first, ahead of the
  // ordinary FIFO backlog — otherwise a brand-new action just competes on
  // equal footing with the rest of the queue.
  const { data: jobs } = await db.from("gmail_sync_jobs")
    .select("*").eq("job_type", "email_sync").in("status", ["pending", "processing"])
    .lt("attempts", MAX_ATTEMPTS)
    .order("is_realtime", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(BATCH_SIZE);

  if (!jobs?.length) {
    console.log("[email-sync-worker] No pending jobs");
    await heartbeat("gmail-email-sync-worker", Date.now() - t0, { dispatched: 0 });
    return respond({ ok: true, dispatched: 0 });
  }

  console.log(`[email-sync-worker] ${jobs.length} jobs to inspect`);
  const units: DispatchUnit[] = [];

  for (const job of jobs) {
    const { id: jobId, company_id: companyId, project_id: projectId, label_code: labelCode, gmail_label_name: rawName, completed_users, total_users } = job;
    const gmailLabelName = sanitiseLabelName(rawName || "");

    const { data: members } = await db.from("company_memberships").select("user_id").eq("company_id", companyId);
    const memberIds = (members || []).map((m: any) => m.user_id);
    const { data: connectedTokens } = memberIds.length
      ? await db.from("user_gmail_tokens").select("user_id").in("user_id", memberIds)
      : { data: [] as any[] };
    const allUserIds: string[] = (connectedTokens || []).map((t: any) => t.user_id);

    const completedSet = new Set(completed_users || []);
    const stillNeeded = allUserIds.filter(id => !completedSet.has(id));
    if (!stillNeeded.length) {
      await db.from("gmail_sync_jobs").update({ status: "done", updated_at: new Date().toISOString() }).eq("id", jobId);
      continue;
    }

    const { data: quarantined } = await db.from("gmail_sync_failures")
      .select("user_id").eq("job_id", jobId).in("status", ["pending_retry", "persistent_failure"]);
    const quarantinedSet = new Set((quarantined || []).map((q: any) => q.user_id));
    const pendingUsers = stillNeeded.filter(id => !quarantinedSet.has(id));
    if (!pendingUsers.length) continue;

    const { data: dbEmails } = await db.from("project_emails")
      .select("gmail_message_id, subject").eq("project_id", projectId).eq("company_id", companyId);
    const msgIds = (dbEmails || []).map((e: any) => e.gmail_message_id);
    const subjectByMsgId: Record<string, string | null> = {};
    for (const e of (dbEmails || [])) subjectByMsgId[e.gmail_message_id] = e.subject;
    const nullSubjectIds = new Set((dbEmails || []).filter((e: any) => !e.subject).map((e: any) => e.gmail_message_id));
    if (!msgIds.length) {
      await db.from("gmail_sync_jobs").update({ status: "done", updated_at: new Date().toISOString() }).eq("id", jobId);
      continue;
    }

    const sourceUserId = allUserIds.find(id => !quarantinedSet.has(id)) || allUserIds[0];
    let sourceToken: string | null = null;
    try {
      sourceToken = await getAccessToken(sourceUserId);
    } catch (srcErr: any) {
      console.error(`[email-sync-worker] Source token fetch failed for ${sourceUserId}:`, srcErr.message);
    }

    // Backfill metadata for NULL rows once per job, not once per dispatched user
    if (nullSubjectIds.size > 0 && sourceToken) {
      console.log(`[email-sync-worker] Backfilling metadata for ${nullSubjectIds.size} emails`);
      await mapWithConcurrency(Array.from(nullSubjectIds), 4, async (msgId) => {
        try {
          const res = await fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
            { headers: { Authorization: `Bearer ${sourceToken}` }, signal: withTimeout() }
          );
          if (!res.ok) return;
          const md = await res.json();
          const headers = md?.payload?.headers || [];
          const get = (n: string) => headers.find((h: any) => h.name === n)?.value || null;
          const fromRaw = get("From");
          let from_name = null, from_address = null;
          if (fromRaw) {
            const m = fromRaw.match(/^(.+?)\s*<([^>]+)>/);
            if (m) { from_name = m[1].replace(/^"|"$/g, "").trim(); from_address = m[2].trim(); }
            else { from_address = fromRaw.trim(); }
          }
          const dateRaw = get("Date");
          let date = null;
          try { if (dateRaw) date = new Date(dateRaw).toISOString(); } catch {}
          await db.from("project_emails").update({
            subject: get("Subject"), from_address, from_name,
            date, snippet: md?.snippet || null, gmail_thread_id: md?.threadId || msgId,
          }).eq("gmail_message_id", msgId).eq("project_id", projectId);
          subjectByMsgId[msgId] = get("Subject");
        } catch (backfillErr: any) {
          console.error(`[email-sync-worker] Backfill failed for message ${msgId}:`, backfillErr.message);
        }
      });
    }

    for (const userId of pendingUsers) {
      units.push({
        jobId, userId, companyId, projectId, labelCode, gmailLabelName,
        totalUsers: total_users || allUserIds.length, msgIds, subjectByMsgId, sourceToken, sourceUserId,
      });
    }
  }

  console.log(`[email-sync-worker] Dispatching ${units.length} (job, user) units, concurrency=${DISPATCH_CONCURRENCY}`);

  const outcomes = await mapWithConcurrency(units, DISPATCH_CONCURRENCY, dispatchOne);
  const ok = outcomes.filter(o => o === "ok").length;
  const quarantinedCount = outcomes.filter(o => o === "quarantined").length;
  const dispatchErrors = outcomes.filter(o => o === "dispatch_error").length;

  const { count: remaining } = await db.from("gmail_sync_jobs")
    .select("*", { count: "exact", head: true }).eq("job_type", "email_sync").eq("status", "pending");

  const result = { dispatched: units.length, ok, quarantined: quarantinedCount, dispatchErrors, remaining };
  console.log(`[email-sync-worker] DONE in ${Date.now() - t0}ms —`, JSON.stringify(result));
  await heartbeat("gmail-email-sync-worker", Date.now() - t0, result);
  return respond({ ok: true, ...result });
}
