// supabase/functions/gmail-label-sync-worker/index.ts
// Every 1 min via pg_cron — DISPATCHER ONLY. Does cheap DB-only work
// (which jobs need attention, who's pending, who's quarantined) and fans
// out one concurrent HTTPS call per pending user to
// gmail-label-sync-processor, which does the actual Gmail API work in its
// OWN isolate. This is what actually scales: throughput is bounded by how
// many concurrent isolates Supabase runs, not by one function's own 150s
// execution ceiling or memory/CPU budget (both of which we hit trying to
// do this work in-process during the 2026-07-21 incident).
//
// Dispatch happens via plain Deno fetch() to another edge function's URL —
// NOT through pg_net — so it doesn't compete with pg_cron's own limited
// outbound worker pool (the other bottleneck from that incident).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } }
);

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const PROCESSOR_URL = `${SUPABASE_URL}/functions/v1/gmail-label-sync-processor`;

const MAX_ATTEMPTS = 3;
// Dispatcher-side work per job is cheap (DB only), but the real ceiling is
// DISPATCH_CONCURRENCY (kept low to respect Supabase's own function-gateway
// rate limit) — so total (job,user) units per tick still has to stay
// modest or the dispatcher itself blows the 150s ceiling waiting them out.
// Empirically even ~2.86 req/s (350ms pacing) kept exceeding the gateway's
// sustainable rate (observed retry-after growing across a single tick), so
// this is paced much more conservatively at ~1 req/s. Per-tier job limits
// (not one shared BATCH_SIZE) live next to each query below.
const DISPATCH_CONCURRENCY = 3;
const MIN_DISPATCH_INTERVAL_MS = 1000; // paces request starts to stay under the gateway's own rate limit
const DISPATCH_TIMEOUT_MS = 60_000; // processor may do several sequential Gmail calls

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
  isRemoved: boolean; dbMsgIds: string[]; fastPath: boolean;
}

// Supabase's gateway rate limit is a token bucket, not a pure concurrency
// cap — a free concurrency slot re-fires the instant it's free, which can
// drain the bucket faster than it refills even at DISPATCH_CONCURRENCY=3
// (observed retry-after growing to 25s under sustained pressure). Pace the
// request *start* rate independently of how many slots are open.
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

    // Couldn't reach the processor even after one retry — a dispatch-level
    // problem, not necessarily evidence this user's account is broken, so
    // don't quarantine here. Log it clearly and leave them pending for next tick.
    console.error(`[label-sync-worker] Dispatch failed for user ${unit.userId} job ${unit.jobId}:`, err.message);
    await logActivity({
      company_id: unit.companyId, triggered_by: null, action: "dispatch_error",
      project_id: unit.projectId, gmail_label_name: unit.gmailLabelName,
      target_user_id: unit.userId, details: { job_type: "label_sync", error: err.message },
    });
    return "dispatch_error";
  }
}

const LOCK_NAME = "gmail-label-sync-worker";
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
  console.log("[label-sync-worker] ========== DISPATCH START ==========");
  const t0 = Date.now();

  if (!(await acquireLock())) {
    console.log("[label-sync-worker] Previous tick still running — skipping");
    return respond({ ok: true, skipped: "already_running" });
  }

  try {
    return await runDispatch(t0);
  } finally {
    await releaseLock();
  }
});

async function runDispatch(t0: number): Promise<Response> {
  // Each tier gets its own reserved query limit instead of "gather
  // new-then-processing-then-old and truncate to BATCH_SIZE" — that scheme
  // let a steady trickle of brand-new jobs (newJobs alone often filled
  // BATCH_SIZE) permanently starve processingJobs, since the merge loop
  // broke before ever reaching them. Found in production on 2026-07-22:
  // 184 label_sync jobs sat frozen in "processing" (mid-rollout, some
  // members never getting synced) while only ~8 new jobs kept cycling
  // through every tick. Processing jobs get the largest allowance since
  // they're closest to done and users are actively waiting on them; most
  // have only 1-2 pending users left, so a larger job count here doesn't
  // translate into a proportionally larger dispatch-unit count.
  // Realtime-flagged jobs (a genuinely new email, deletion, or newly-
  // created label, per gmail-push/gmail-addon) always go first, ahead of
  // the ordinary backlog tiers below — otherwise a brand-new action just
  // competes on equal footing with hundreds of routine backlog jobs.
  const { data: realtimeJobs } = await db
    .from("gmail_sync_jobs")
    .select("*")
    .eq("job_type", "label_sync")
    .eq("is_realtime", true)
    .in("status", ["pending", "processing"])
    .lt("attempts", MAX_ATTEMPTS)
    .order("updated_at", { ascending: false })
    .limit(10);

  const { data: newJobs } = await db
    .from("gmail_sync_jobs")
    .select("*")
    .eq("job_type", "label_sync")
    .eq("status", "pending")
    .lt("attempts", MAX_ATTEMPTS)
    .eq("completed_users", "[]")
    .order("updated_at", { ascending: false })
    .limit(3);

  const { data: processingJobs } = await db
    .from("gmail_sync_jobs")
    .select("*")
    .eq("job_type", "label_sync")
    .eq("status", "processing")
    .lt("attempts", MAX_ATTEMPTS)
    .order("updated_at", { ascending: true })
    .limit(30);

  const { data: oldJobs } = await db
    .from("gmail_sync_jobs")
    .select("*")
    .eq("job_type", "label_sync")
    .eq("status", "pending")
    .lt("attempts", MAX_ATTEMPTS)
    .neq("completed_users", "[]")
    .order("updated_at", { ascending: true })
    .limit(8);

  const seen = new Set<string>();
  const jobs: any[] = [];
  for (const j of [...(realtimeJobs || []), ...(newJobs || []), ...(processingJobs || []), ...(oldJobs || [])]) {
    if (!seen.has(j.id)) { seen.add(j.id); jobs.push(j); }
  }

  console.log(`[label-sync-worker] Jobs: realtime=${realtimeJobs?.length||0} new=${newJobs?.length||0} processing=${processingJobs?.length||0} old=${oldJobs?.length||0} total=${jobs.length}`);

  if (!jobs.length) {
    console.log("[label-sync-worker] No pending jobs");
    await heartbeat("gmail-label-sync-worker", Date.now() - t0, { dispatched: 0 });
    return respond({ ok: true, dispatched: 0 });
  }

  const units: DispatchUnit[] = [];
  // Job count alone doesn't bound tick duration — the 184-job starvation
  // backlog found on 2026-07-22 wasn't uniform: most jobs had 1-2 pending
  // users left, but a handful had 6-7 (never touched since creation). At
  // ~1 unit/sec pacing, a batch that happens to include several of those
  // can still blow the 150s ceiling even with a modest job-count limit —
  // cap the actual unit count directly and let leftover jobs roll to next
  // tick instead.
  const MAX_UNITS_PER_TICK = 25;

  for (const job of jobs) {
    if (units.length >= MAX_UNITS_PER_TICK) break;
    const { id: jobId, company_id: companyId, project_id: projectId, label_code: labelCode, gmail_label_name: rawLabelName, completed_users, total_users } = job;
    const gmailLabelName = sanitiseLabelName(rawLabelName || "");

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

    const { data: dbLabel } = await db.from("project_gmail_labels")
      .select("removed_at").eq("project_id", projectId).eq("company_id", companyId).maybeSingle();
    const isRemoved = !!dbLabel?.removed_at;

    const { data: dbEmails } = await db.from("project_emails")
      .select("gmail_message_id").eq("project_id", projectId).eq("company_id", companyId);
    const dbMsgIds = (dbEmails || []).map((e: any) => e.gmail_message_id);
    const fastPath = !isRemoved && dbMsgIds.length === 0;

    for (const userId of pendingUsers) {
      units.push({
        jobId, userId, companyId, projectId, labelCode, gmailLabelName,
        totalUsers: total_users || allUserIds.length, isRemoved, dbMsgIds, fastPath,
      });
    }
  }

  console.log(`[label-sync-worker] Dispatching ${units.length} (job, user) units, concurrency=${DISPATCH_CONCURRENCY}`);

  const outcomes = await mapWithConcurrency(units, DISPATCH_CONCURRENCY, dispatchOne);
  const ok = outcomes.filter(o => o === "ok").length;
  const quarantinedCount = outcomes.filter(o => o === "quarantined").length;
  const dispatchErrors = outcomes.filter(o => o === "dispatch_error").length;

  const { count: remaining } = await db.from("gmail_sync_jobs")
    .select("*", { count: "exact", head: true }).eq("job_type", "label_sync").eq("status", "pending");

  const result = { dispatched: units.length, ok, quarantined: quarantinedCount, dispatchErrors, remaining };
  console.log(`[label-sync-worker] DONE in ${Date.now() - t0}ms —`, JSON.stringify(result));
  await heartbeat("gmail-label-sync-worker", Date.now() - t0, result);
  return respond({ ok: true, ...result });
}
