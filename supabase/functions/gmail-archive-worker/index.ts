// supabase/functions/gmail-archive-worker/index.ts
// Every 1 min — processes 'archive' jobs from gmail_sync_jobs.
// Phase A: deliver every project email to every nominated archive account
// and verify (re-check) presence in ALL of them.
// Phase B: only once every email is confirmed present in every archive
// account, trash it from every other connected member and remove their
// now-empty copy of the original shared label. Never trashes anything
// unconfirmed — a partial delivery failure just retries next tick.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } }
);

const googleClientId = Deno.env.get("GOOGLE_CLIENT_ID")!;
const googleClientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET")!;
const MAX_ATTEMPTS = 3;
const BATCH_SIZE = 5; // archiving does much more work per job than the other workers

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
    headers: { Authorization: `Bearer ${token}` },
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
  token: string,
  labelName: string,
  existingLabels: { id: string; name: string }[]
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
        name: partial,
        labelListVisibility: "labelShow",
        messageListVisibility: i === parts.length ? "show" : "hide",
      }),
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
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
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
    body: JSON.stringify({ addLabelIds: [labelId] }),
  });
  return res.ok;
}

async function removeLabelFromMessage(token: string, msgId: string, labelId: string): Promise<boolean> {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}/modify`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ removeLabelIds: [labelId] }),
  });
  return res.ok;
}

async function deleteGmailLabel(token: string, labelId: string): Promise<void> {
  const msgs = await getMessagesWithLabel(token, labelId);
  if (msgs.length) {
    for (let i = 0; i < msgs.length; i += 50) {
      await Promise.all(msgs.slice(i, i + 50).map(id =>
        removeLabelFromMessage(token, id, labelId)
      ));
    }
  }
  await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/labels/${labelId}`, {
    method: "DELETE", headers: { Authorization: `Bearer ${token}` },
  });
}

async function userHasMessage(token: string, msgId: string): Promise<boolean> {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}?format=minimal`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return res.ok;
}

async function importMessage(
  sourceToken: string, targetToken: string,
  msgId: string, labelId: string
): Promise<boolean> {
  const rawRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}?format=raw`,
    { headers: { Authorization: `Bearer ${sourceToken}` } }
  );
  if (!rawRes.ok) return false;
  const { raw } = await rawRes.json();
  if (!raw) return false;

  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/import", {
    method: "POST",
    headers: { Authorization: `Bearer ${targetToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw, labelIds: [labelId] }),
  });
  return res.ok;
}

// Moves to Trash (recoverable for ~30 days via Gmail), never a hard delete.
async function trashMessage(token: string, msgId: string): Promise<boolean> {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}/trash`, {
    method: "POST", headers: { Authorization: `Bearer ${token}` },
  });
  return res.ok;
}

// ── Job / logging helpers ─────────────────────────────────────────

async function markUserComplete(jobId: string, userId: string, totalUsers: number): Promise<void> {
  const { data: job } = await db.from("gmail_sync_jobs")
    .select("completed_users, total_users").eq("id", jobId).single();
  if (!job) return;

  const completed: string[] = job.completed_users || [];
  if (!completed.includes(userId)) completed.push(userId);

  const allDone = completed.length >= (job.total_users || totalUsers);
  await db.from("gmail_sync_jobs").update({
    completed_users: completed,
    total_users: job.total_users || totalUsers,
    status: allDone ? "done" : "processing",
    updated_at: new Date().toISOString(),
  }).eq("id", jobId);
}

async function logActivity(row: Record<string, unknown>): Promise<void> {
  try { await db.from("gmail_sync_log").insert(row); } catch (_) { /* never break archiving over logging */ }
}

async function heartbeat(name: string, durationMs: number, result: unknown): Promise<void> {
  try {
    await db.from("cron_heartbeats").upsert(
      { name, last_run_at: new Date().toISOString(), last_duration_ms: durationMs, last_result: result },
      { onConflict: "name" }
    );
  } catch (_) { /* never break archiving */ }
}

function respond(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status, headers: { "Content-Type": "application/json" },
  });
}

// ── Overlap guard ────────────────────────────────────────────────
// Runs on both pg_cron and a GitHub Actions backup trigger — this table
// (shared with the label/email dispatchers) makes a second trigger source
// firing mid-run a safe no-op. Especially important here since this worker
// trashes emails; two concurrent invocations racing on the same job's
// confirmation/purge phases is worth avoiding even though the phase checks
// are individually idempotent.

const LOCK_NAME = "gmail-archive-worker";
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
  console.log("[archive-worker] START");
  const t0 = Date.now();

  if (!(await acquireLock())) {
    console.log("[archive-worker] Previous tick still running — skipping");
    return respond({ ok: true, skipped: "already_running" });
  }

  try {
    return await runArchive(t0);
  } finally {
    await releaseLock();
  }
});

async function runArchive(t0: number): Promise<Response> {
  const { data: jobs } = await db.from("gmail_sync_jobs")
    .select("*")
    .eq("job_type", "archive")
    .in("status", ["pending", "processing"])
    .lt("attempts", MAX_ATTEMPTS)
    .order("created_at", { ascending: true })
    .limit(BATCH_SIZE);

  if (!jobs?.length) {
    console.log("[archive-worker] No pending jobs");
    await heartbeat("gmail-archive-worker", Date.now() - t0, { processed: 0 });
    return respond({ ok: true, processed: 0 });
  }

  let processed = 0;

  for (const job of jobs) {
    const {
      id: jobId, company_id: companyId, project_id: projectId,
      label_code: labelCode, gmail_label_name: rawLabelName,
      completed_users, attempts,
    } = job;
    const gmailLabelName = sanitiseLabelName(rawLabelName || "");
    console.log(`[archive-worker] ── Job ${jobId} project=${projectId} label="${gmailLabelName}" ──`);

    try {
      const { data: company } = await db.from("companies")
        .select("name, gmail_parent_label, gmail_archive_emails, gmail_archive_label")
        .eq("id", companyId).single();

      const archiveEmails: string[] = company?.gmail_archive_emails || [];
      if (!archiveEmails.length) {
        await db.from("gmail_sync_jobs").update({
          status: "failed", error: "No archive account nominated", updated_at: new Date().toISOString(),
        }).eq("id", jobId);
        continue;
      }

      const archiveUserIds: string[] = [];
      for (const email of archiveEmails) {
        const { data: t } = await db.from("user_gmail_tokens").select("user_id").eq("email", email).maybeSingle();
        if (t) archiveUserIds.push(t.user_id);
      }
      if (!archiveUserIds.length) {
        await db.from("gmail_sync_jobs").update({
          status: "failed", error: "No connected archive account(s)", updated_at: new Date().toISOString(),
        }).eq("id", jobId);
        continue;
      }
      if (archiveUserIds.length < archiveEmails.length) {
        console.log(`[archive-worker] Warning: only ${archiveUserIds.length}/${archiveEmails.length} nominated archive accounts are connected`);
      }

      // All connected company members, minus the archive accounts themselves
      const { data: members } = await db.from("company_memberships").select("user_id").eq("company_id", companyId);
      const allUserIds: string[] = [];
      for (const { user_id } of (members || [])) {
        const { data: t } = await db.from("user_gmail_tokens").select("user_id").eq("user_id", user_id).maybeSingle();
        if (t) allUserIds.push(user_id);
      }
      const archiveSet = new Set(archiveUserIds);
      const otherUserIds = allUserIds.filter(id => !archiveSet.has(id));

      // Archive label = same path, parent swapped for the company's archive label
      const archiveParent = company?.gmail_archive_label || `${company?.name || "Company"} Archive`;
      const parentPrefix = `${company?.gmail_parent_label || ""}/`;
      const archiveLabelName = gmailLabelName.startsWith(parentPrefix)
        ? `${archiveParent}/${gmailLabelName.slice(parentPrefix.length)}`
        : `${archiveParent}/${gmailLabelName}`;

      const { data: dbEmails } = await db.from("project_emails")
        .select("gmail_message_id, subject").eq("project_id", projectId).eq("company_id", companyId);
      const msgIds = Array.from(new Set((dbEmails || []).map((e: any) => e.gmail_message_id)));
      const subjectByMsgId = new Map((dbEmails || []).map((e: any) => [e.gmail_message_id, e.subject]));
      console.log(`[archive-worker] ${msgIds.length} distinct messages, archiveAccounts=${archiveUserIds.length}, otherUsers=${otherUserIds.length}`);

      const sourceUserId = otherUserIds[0] || archiveUserIds[0];
      const sourceToken = sourceUserId ? await getAccessToken(sourceUserId) : null;

      // ── Phase A: deliver to every archive account ───────────────
      const archiveTokens = new Map<string, string>();
      for (const userId of archiveUserIds) {
        const token = await getAccessToken(userId);
        if (!token) { console.error(`[archive-worker] No token for archive user ${userId}`); continue; }
        archiveTokens.set(userId, token);

        const gmailLabels = await getGmailLabels(token);
        let labelId = findLabelId(gmailLabels, null, archiveLabelName);
        if (!labelId) labelId = await createLabelHierarchy(token, archiveLabelName, gmailLabels);
        if (!labelId) { console.error(`[archive-worker] Could not create archive label for ${userId}`); continue; }

        for (const msgId of msgIds) {
          const hasMsg = await userHasMessage(token, msgId);
          if (hasMsg) await applyLabel(token, msgId, labelId);
          else if (sourceToken) await importMessage(sourceToken, token, msgId, labelId);
        }
      }

      if (archiveTokens.size < archiveUserIds.length) {
        console.log(`[archive-worker] Only reached ${archiveTokens.size}/${archiveUserIds.length} archive accounts this tick — retrying next tick`);
        await db.from("gmail_sync_jobs").update({ status: "processing", updated_at: new Date().toISOString() }).eq("id", jobId);
        continue;
      }

      // ── Verify: only messages confirmed present in EVERY archive account proceed ──
      const confirmedMsgIds: string[] = [];
      for (const msgId of msgIds) {
        let allConfirmed = true;
        for (const userId of archiveUserIds) {
          const token = archiveTokens.get(userId)!;
          if (!(await userHasMessage(token, msgId))) { allConfirmed = false; break; }
        }
        if (allConfirmed) {
          confirmedMsgIds.push(msgId);
          for (const userId of archiveUserIds) {
            await logActivity({
              company_id: companyId, triggered_by: null, action: "archived",
              project_id: projectId, gmail_message_id: msgId, gmail_label_name: archiveLabelName,
              target_user_id: userId, details: { subject: subjectByMsgId.get(msgId) || null },
            });
          }
        }
      }
      console.log(`[archive-worker] Confirmed ${confirmedMsgIds.length}/${msgIds.length} in every archive account`);

      if (confirmedMsgIds.length < msgIds.length) {
        await db.from("gmail_sync_jobs").update({ status: "processing", updated_at: new Date().toISOString() }).eq("id", jobId);
        continue;
      }

      // ── Phase B: purge confirmed messages from everyone else ────
      const completedSet = new Set(completed_users || []);
      const pendingUsers = otherUserIds.filter(id => !completedSet.has(id));

      if (!pendingUsers.length) {
        await db.from("project_gmail_labels").update({ removed_at: new Date().toISOString() })
          .eq("project_id", projectId).eq("company_id", companyId);
        await db.from("gmail_sync_jobs").update({ status: "done", updated_at: new Date().toISOString() }).eq("id", jobId);
        console.log(`[archive-worker] ✓ Job ${jobId} done — nothing left to purge`);
        processed++;
        continue;
      }

      for (const userId of pendingUsers) {
        const token = await getAccessToken(userId);
        if (!token) { await markUserComplete(jobId, userId, otherUserIds.length); continue; }

        let trashed = 0;
        for (const msgId of confirmedMsgIds) {
          if (!(await userHasMessage(token, msgId))) continue;
          const ok = await trashMessage(token, msgId);
          if (ok) {
            trashed++;
            await logActivity({
              company_id: companyId, triggered_by: null, action: "email_trashed",
              project_id: projectId, gmail_message_id: msgId, gmail_label_name: gmailLabelName,
              target_user_id: userId, details: { subject: subjectByMsgId.get(msgId) || null },
            });
          }
        }
        console.log(`[archive-worker] User ${userId}: trashed ${trashed}/${confirmedMsgIds.length}`);

        const gmailLabels = await getGmailLabels(token);
        const labelId = findLabelId(gmailLabels, labelCode, gmailLabelName);
        if (labelId) await deleteGmailLabel(token, labelId);

        await db.from("project_emails").delete()
          .eq("project_id", projectId).eq("company_id", companyId).eq("user_id", userId);

        await markUserComplete(jobId, userId, otherUserIds.length);
        processed++;
      }

      const { data: refreshed } = await db.from("gmail_sync_jobs").select("status").eq("id", jobId).single();
      if (refreshed?.status === "done") {
        await db.from("project_gmail_labels").update({ removed_at: new Date().toISOString() })
          .eq("project_id", projectId).eq("company_id", companyId);
        console.log(`[archive-worker] ✓ Job ${jobId} fully done`);
      }

    } catch (err: any) {
      console.error(`[archive-worker] ✗ Error job ${jobId}:`, err.message, err.stack);
      await db.from("gmail_sync_jobs").update({
        status: attempts + 1 >= MAX_ATTEMPTS ? "failed" : "pending",
        attempts: attempts + 1, error: err.message,
        updated_at: new Date().toISOString(),
      }).eq("id", jobId);
    }
  }

  const { count: remaining } = await db.from("gmail_sync_jobs")
    .select("*", { count: "exact", head: true }).eq("job_type", "archive").in("status", ["pending", "processing"]);

  console.log(`[archive-worker] DONE in ${Date.now() - t0}ms — processed=${processed} remaining=${remaining}`);
  await heartbeat("gmail-archive-worker", Date.now() - t0, { processed, remaining });
  return respond({ ok: true, processed, remaining });
}
