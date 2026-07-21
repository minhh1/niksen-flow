// supabase/functions/gmail-sync-recovery-worker/index.ts
// Every 15 min — the ONLY thing that ever retries a user quarantined in
// gmail_sync_failures (gmail-label-sync-worker / gmail-email-sync-worker
// never retry a failed user themselves — they quarantine and move on so a
// single rate-limited or broken account can never block the fast queue).
// Retries one (job, user) pair at a time; on success, resumes that user in
// their original job. After RECOVERY_MAX_ATTEMPTS failed retries, escalates
// to 'persistent_failure' — surfaced in the admin "Persistent failures" tab
// so someone can go fix the underlying account issue.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } }
);

const googleClientId = Deno.env.get("GOOGLE_CLIENT_ID")!;
const googleClientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET")!;
const RECOVERY_MAX_ATTEMPTS = 3;
// Kept small — same 150s platform execution ceiling as the fast workers;
// retrying a quarantined user does real Gmail API round-trips, and this
// worker is exactly what drains a large backlog after an incident, so it's
// the most likely of the three to hit a big batch right when it matters.
const BATCH_SIZE = 10;
// Failures are processed fully sequentially (one Gmail account at a time,
// on purpose — this is the slow/safe lane), so one large mailbox or one
// account still tripping Gmail's own rate limit can eat the whole 150s
// platform ceiling by itself. Without a budget check, the platform kills
// the isolate mid-loop with no chance to persist progress — and since the
// query always orders by last_attempted_at ascending, the next tick just
// re-picks the exact same stuck item first, forever. Bail out with time to
// spare so every tick always finishes and writes its heartbeat.
const TIME_BUDGET_MS = 100_000;

const FETCH_TIMEOUT_MS = 15_000;
function withTimeout(): AbortSignal { return AbortSignal.timeout(FETCH_TIMEOUT_MS); }

// ── Token ──────────────────────────────────────────────────────────

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

// ── Label name helpers ─────────────────────────────────────────────

function sanitiseLabelName(name: string): string {
  const parts = name.split("/");
  if (parts.length <= 1) return name.replace(/\//g, "-");
  const parent = parts.slice(0, -1).join("/");
  const leaf = parts[parts.length - 1].replace(/\//g, "-");
  return `${parent}/${leaf}`;
}

// ── Gmail API ──────────────────────────────────────────────────────

async function getGmailLabels(token: string): Promise<{ id: string; name: string }[]> {
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/labels", {
    headers: { Authorization: `Bearer ${token}` }, signal: withTimeout(),
  });
  if (!res.ok) return [];
  return (await res.json()).labels || [];
}

function findLabelId(
  labels: { id: string; name: string }[],
  labelCode: string | null,
  labelName: string
): string | null {
  if (labelCode) {
    const byCode = labels.find(l => l.name.includes(`[${labelCode}]`));
    if (byCode) return byCode.id;
  }
  const norm = (s: string) => s.replace(/[—–‒]/g, "-").trim().toLowerCase();
  return labels.find(l => norm(l.name) === norm(labelName))?.id || null;
}

async function createLabelHierarchy(
  token: string, labelName: string, existingLabels: { id: string; name: string }[]
): Promise<string | null> {
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
      body: JSON.stringify({
        name: partial, labelListVisibility: "labelShow",
        messageListVisibility: i === parts.length ? "show" : "hide",
      }),
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

async function applyLabel(token: string, msgId: string, labelId: string): Promise<boolean> {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}/modify`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ addLabelIds: [labelId] }), signal: withTimeout(),
  });
  return res.ok;
}

async function removeLabelFromMessage(token: string, msgId: string, labelId: string): Promise<boolean> {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}/modify`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ removeLabelIds: [labelId] }), signal: withTimeout(),
  });
  return res.ok;
}

async function deleteGmailLabel(token: string, labelId: string): Promise<void> {
  const msgs = await getMessagesWithLabel(token, labelId);
  if (msgs.length) {
    for (let i = 0; i < msgs.length; i += 50) {
      await Promise.all(msgs.slice(i, i + 50).map(id => removeLabelFromMessage(token, id, labelId)));
    }
  }
  await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/labels/${labelId}`, {
    method: "DELETE", headers: { Authorization: `Bearer ${token}` }, signal: withTimeout(),
  });
}

async function userHasMessage(token: string, msgId: string): Promise<boolean> {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}?format=minimal`,
    { headers: { Authorization: `Bearer ${token}` }, signal: withTimeout() }
  );
  return res.ok;
}

async function importMessage(sourceToken: string, targetToken: string, msgId: string, labelId: string): Promise<boolean> {
  const rawRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}?format=raw`,
    { headers: { Authorization: `Bearer ${sourceToken}` }, signal: withTimeout() }
  );
  if (!rawRes.ok) return false;
  const { raw } = await rawRes.json();
  if (!raw) return false;
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/import", {
    method: "POST", headers: { Authorization: `Bearer ${targetToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw, labelIds: [labelId, "INBOX"] }), signal: withTimeout(),
  });
  return res.ok;
}

// ── Job / logging helpers ──────────────────────────────────────────

async function markUserComplete(jobId: string, userId: string, totalUsers: number): Promise<void> {
  const { data: job } = await db.from("gmail_sync_jobs")
    .select("completed_users, total_users").eq("id", jobId).single();
  if (!job) return;
  const completed: string[] = job.completed_users || [];
  if (!completed.includes(userId)) completed.push(userId);
  const allDone = completed.length >= (job.total_users || totalUsers);
  await db.from("gmail_sync_jobs").update({
    completed_users: completed,
    status: allDone ? "done" : "processing",
    updated_at: new Date().toISOString(),
  }).eq("id", jobId);
}

async function logActivity(row: Record<string, unknown>): Promise<void> {
  try { await db.from("gmail_sync_log").insert(row); } catch (_) { /* never break recovery over logging */ }
}

// Thrown when a single failure's own work (e.g. a large mailbox with
// hundreds of messages) alone exceeds the tick's time budget. This is real
// incremental progress, not a broken account — Gmail's label state is the
// checkpoint, so the next tick picks up wherever this one left off. Doesn't
// count against RECOVERY_MAX_ATTEMPTS, so a big mailbox can take as many
// ticks as it needs without wrongly escalating to "persistent_failure".
class BudgetDeferredError extends Error {
  deferred = true;
}

async function heartbeat(name: string, durationMs: number, result: unknown): Promise<void> {
  try {
    await db.from("cron_heartbeats").upsert(
      { name, last_run_at: new Date().toISOString(), last_duration_ms: durationMs, last_result: result },
      { onConflict: "name" }
    );
  } catch (_) { /* never break recovery */ }
}

function respond(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

// ── Overlap guard ────────────────────────────────────────────────
// Runs on both pg_cron and a GitHub Actions backup trigger — this table
// (shared with the label/email dispatchers) makes a second trigger source
// firing mid-run a safe no-op instead of two invocations racing to update
// the same gmail_sync_failures rows.

const LOCK_NAME = "gmail-sync-recovery-worker";
const LOCK_TTL_MS = 170_000;

async function acquireLock(): Promise<boolean> {
  const { data } = await db.from("dispatcher_locks")
    .update({ locked_until: new Date(Date.now() + LOCK_TTL_MS).toISOString() })
    .eq("name", LOCK_NAME).lt("locked_until", new Date().toISOString()).select();
  return !!data && data.length > 0;
}

async function releaseLock(): Promise<void> {
  try { await db.from("dispatcher_locks").update({ locked_until: new Date().toISOString() }).eq("name", LOCK_NAME); } catch (_) {}
}

// ── Function ──────────────────────────────────────────────────────

Deno.serve(async (_req) => {
  console.log("[sync-recovery-worker] START");
  const t0 = Date.now();

  if (!(await acquireLock())) {
    console.log("[sync-recovery-worker] Previous tick still running — skipping");
    return respond({ ok: true, skipped: "already_running" });
  }

  try {
    return await runRecovery(t0);
  } finally {
    await releaseLock();
  }
});

async function runRecovery(t0: number): Promise<Response> {
  const { data: failures } = await db.from("gmail_sync_failures")
    .select("*")
    .eq("status", "pending_retry")
    .order("last_attempted_at", { ascending: true, nullsFirst: true })
    .limit(BATCH_SIZE);

  if (!failures?.length) {
    console.log("[sync-recovery-worker] Nothing to retry");
    await heartbeat("gmail-sync-recovery-worker", Date.now() - t0, { retried: 0, resolved: 0, escalated: 0, deferred: 0, skipped: 0 });
    return respond({ ok: true, retried: 0, resolved: 0, escalated: 0, deferred: 0, skipped: 0 });
  }

  // A single large mailbox can eat the whole tick's time budget by itself
  // (see BudgetDeferredError above) — if it happens to be oldest, it blocks
  // every other item in the batch from even being attempted, every tick.
  // Small/fast items (which is most real failures — rate limits, transient
  // errors) should get their shot first; large mailboxes are safe to push
  // to the back since deferrals don't burn RECOVERY_MAX_ATTEMPTS and make
  // real incremental progress (Gmail's label state is the checkpoint) once
  // they do get a turn.
  const projectIds = [...new Set(failures.map((f: any) => f.project_id))];
  const sizeByProject = new Map<string, number>();
  await Promise.all(projectIds.map(async (pid) => {
    const { count } = await db.from("project_emails").select("*", { count: "exact", head: true }).eq("project_id", pid);
    sizeByProject.set(pid, count || 0);
  }));
  failures.sort((a: any, b: any) => (sizeByProject.get(a.project_id) || 0) - (sizeByProject.get(b.project_id) || 0));

  let retried = 0, resolved = 0, escalated = 0, deferred = 0, skipped = 0;

  for (const failure of failures) {
    if (Date.now() - t0 > TIME_BUDGET_MS) {
      skipped = failures.length - retried;
      console.log(`[sync-recovery-worker] Time budget reached — skipping ${skipped} untouched, deferring to next tick`);
      break;
    }
    const {
      id: failureId, company_id: companyId, job_id: jobId, job_type: jobType,
      project_id: projectId, user_id: userId, attempts,
    } = failure;
    retried++;
    console.log(`[sync-recovery-worker] Retrying failure=${failureId} job=${jobId} user=${userId} type=${jobType} attempt=${attempts + 1}/${RECOVERY_MAX_ATTEMPTS}`);

    let job: any = null;
    try {
      const { data } = await db.from("gmail_sync_jobs").select("*").eq("id", jobId).maybeSingle();
      job = data;
      if (!job) {
        // Parent job no longer exists — nothing left to recover
        await db.from("gmail_sync_failures").update({ status: "resolved", resolved_at: new Date().toISOString() }).eq("id", failureId);
        resolved++;
        continue;
      }

      const gmailLabelName = sanitiseLabelName(job.gmail_label_name || "");
      const token = await getAccessToken(userId);
      if (!token) throw new Error("No Gmail token for this user");

      if (jobType === "label_sync") {
        const { data: dbLabel } = await db.from("project_gmail_labels")
          .select("removed_at").eq("project_id", projectId).eq("company_id", companyId).maybeSingle();
        const isRemoved = !!dbLabel?.removed_at;

        const { data: dbEmails } = await db.from("project_emails")
          .select("gmail_message_id").eq("project_id", projectId).eq("company_id", companyId);
        const dbMsgIds = (dbEmails || []).map((e: any) => e.gmail_message_id);

        const gmailLabels = await getGmailLabels(token);
        const existingLabelId = findLabelId(gmailLabels, job.label_code, gmailLabelName);

        if (isRemoved) {
          if (existingLabelId) await deleteGmailLabel(token, existingLabelId);
        } else {
          let labelId = existingLabelId;
          if (!labelId) labelId = await createLabelHierarchy(token, gmailLabelName, gmailLabels);
          if (!labelId) throw new Error("Could not find or create label");
          if (dbMsgIds.length) {
            const gmailMsgSet = new Set(await getMessagesWithLabel(token, labelId));
            const toApply = dbMsgIds.filter((id: string) => !gmailMsgSet.has(id));
            for (const msgId of toApply) {
              if (Date.now() - t0 > TIME_BUDGET_MS) throw new BudgetDeferredError(`Time budget reached mid-mailbox (${toApply.length} messages, one large mailbox alone can exceed the tick budget) — will resume next tick`);
              await applyLabel(token, msgId, labelId);
            }
            if (toApply.length) {
              await db.from("project_emails").update({ gmail_label_applied: true })
                .eq("project_id", projectId).eq("company_id", companyId).eq("user_id", userId);
            }
          }
        }
      } else if (jobType === "email_sync") {
        const { data: dbEmails } = await db.from("project_emails")
          .select("gmail_message_id").eq("project_id", projectId).eq("company_id", companyId);
        const msgIds = (dbEmails || []).map((e: any) => e.gmail_message_id);

        if (msgIds.length) {
          const { data: members } = await db.from("company_memberships").select("user_id").eq("company_id", companyId);
          let sourceToken: string | null = null;
          for (const m of (members || [])) {
            if (m.user_id === userId) continue;
            const t = await getAccessToken(m.user_id);
            if (t) { sourceToken = t; break; }
          }

          const gmailLabels = await getGmailLabels(token);
          let labelId = findLabelId(gmailLabels, job.label_code, gmailLabelName);
          if (!labelId) labelId = await createLabelHierarchy(token, gmailLabelName, gmailLabels);
          if (!labelId) throw new Error("Could not find or create label");

          const labelled = new Set(await getMessagesWithLabel(token, labelId));
          for (const msgId of msgIds) {
            if (labelled.has(msgId)) continue;
            if (Date.now() - t0 > TIME_BUDGET_MS) throw new BudgetDeferredError(`Time budget reached mid-mailbox (${msgIds.length} messages, one large mailbox alone can exceed the tick budget) — will resume next tick`);
            const hasMsg = await userHasMessage(token, msgId);
            if (hasMsg) await applyLabel(token, msgId, labelId);
            else if (sourceToken) await importMessage(sourceToken, token, msgId, labelId);
          }
          await db.from("project_emails").update({ gmail_label_applied: true })
            .eq("project_id", projectId).eq("company_id", companyId).eq("user_id", userId);
        }
      } else {
        throw new Error(`Recovery not supported for job_type "${jobType}"`);
      }

      // Success — resume this user in their original job and clear the quarantine
      await markUserComplete(jobId, userId, job.total_users);
      await db.from("gmail_sync_failures").update({
        status: "resolved", resolved_at: new Date().toISOString(), last_attempted_at: new Date().toISOString(),
      }).eq("id", failureId);
      await logActivity({
        company_id: companyId, triggered_by: null, action: "sync_recovered",
        project_id: projectId, gmail_label_name: job.gmail_label_name,
        target_user_id: userId, details: { job_type: jobType },
      });
      resolved++;
      console.log(`[sync-recovery-worker] ✓ Resolved failure ${failureId}`);

    } catch (err: any) {
      if (err?.deferred) {
        // Real progress was made (Gmail's own label state is the checkpoint)
        // but this item alone ran out of time — retry it next tick without
        // burning one of its RECOVERY_MAX_ATTEMPTS.
        await db.from("gmail_sync_failures").update({
          last_error: err.message || "Deferred — resuming next tick", last_attempted_at: new Date().toISOString(),
        }).eq("id", failureId);
        deferred++;
        console.log(`[sync-recovery-worker] ⏸ Deferred (not counted as a failed attempt): ${failureId} — ${err.message}`);
        continue;
      }

      const nextAttempts = attempts + 1;
      const isPersistent = nextAttempts >= RECOVERY_MAX_ATTEMPTS;
      await db.from("gmail_sync_failures").update({
        status: isPersistent ? "persistent_failure" : "pending_retry",
        attempts: nextAttempts, last_error: err.message || "Unknown error",
        last_attempted_at: new Date().toISOString(),
      }).eq("id", failureId);

      if (isPersistent) {
        escalated++;
        await logActivity({
          company_id: companyId, triggered_by: null, action: "sync_failed",
          project_id: projectId, gmail_label_name: job?.gmail_label_name || null,
          target_user_id: userId, details: { job_type: jobType, error: err.message },
        });
        console.error(`[sync-recovery-worker] ✗ Escalated to persistent_failure: ${failureId} — ${err.message}`);
      } else {
        console.error(`[sync-recovery-worker] ✗ Retry failed (${nextAttempts}/${RECOVERY_MAX_ATTEMPTS}): ${failureId} — ${err.message}`);
      }
    }
  }

  console.log(`[sync-recovery-worker] DONE in ${Date.now() - t0}ms — retried=${retried} resolved=${resolved} escalated=${escalated} deferred=${deferred} skipped=${skipped}`);
  await heartbeat("gmail-sync-recovery-worker", Date.now() - t0, { retried, resolved, escalated, deferred, skipped });
  return respond({ ok: true, retried, resolved, escalated, deferred, skipped });
}
