import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } }
);

const googleClientId = Deno.env.get("GOOGLE_CLIENT_ID")!;
const googleClientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET")!;
const MAX_ATTEMPTS = 3;
const BATCH_SIZE = 20;

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

// Strip "/" from the leaf label name (part after last /)
// e.g. "Huynh Lawyers/260576 — A/B Test [CODE]"
//   → "Huynh Lawyers/260576 — A-B Test [CODE]"
function sanitiseLabelName(name: string): string {
  const parts = name.split("/");
  if (parts.length <= 1) return name.replace(/\//g, "-");
  const parent = parts.slice(0, -1).join("/");
  const leaf = parts[parts.length - 1].replace(/\//g, "-");
  return `${parent}/${leaf}`;
}

// Normalise subject for matching (strip Re:/Fwd:, lowercase, trim)
function normaliseSubject(subject: string): string {
  return subject
    .replace(/^(re|fwd?|fw|aw|antw|tr|sv|vs|rv|ref):\s*/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
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
  const norm = (s: string) => s.replace(/[\u2014\u2013\u2012]/g, "-").trim().toLowerCase();
  return labels.find(l => norm(l.name) === norm(labelName))?.id || null;
}

async function createLabelHierarchy(
  token: string,
  labelName: string,
  existingLabels: { id: string; name: string }[]
): Promise<string | null> {
  // Sanitise before creating
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

async function applyLabelToMessage(token: string, msgId: string, labelId: string): Promise<boolean> {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}/modify`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
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
    body: JSON.stringify({ raw, labelIds: [labelId, "INBOX"] }),
  });
  return res.ok;
}

async function getMessageSubject(token: string, msgId: string): Promise<string | null> {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}?format=metadata&metadataHeaders=Subject`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) return null;
  const data = await res.json();
  const subjectHeader = (data.payload?.headers || []).find((h: any) => h.name === "Subject");
  return subjectHeader?.value || null;
}

// ── Job helpers ────────────────────────────────────────────────────

async function markUserComplete(jobId: string, userId: string, totalUsers: number): Promise<void> {
  // Append userId to completed_users array
  // Mark job done only when all users completed
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

async function markUserFailed(jobId: string, error: string, attempts: number): Promise<void> {
  await db.from("gmail_sync_jobs").update({
    status: attempts + 1 >= MAX_ATTEMPTS ? "failed" : "pending",
    attempts: attempts + 1,
    error,
    updated_at: new Date().toISOString(),
  }).eq("id", jobId);
}

async function removeUserFromCompleted(
  companyId: string, projectId: string, userId: string, jobType: string
): Promise<void> {
  const { data: job } = await db.from("gmail_sync_jobs")
    .select("id, completed_users")
    .eq("job_type", jobType)
    .eq("company_id", companyId)
    .eq("project_id", projectId)
    .maybeSingle();
  if (!job) return;

  const completed = (job.completed_users || []).filter((u: string) => u !== userId);
  await db.from("gmail_sync_jobs").update({
    completed_users: completed,
    status: "pending", // needs re-processing for this user
    updated_at: new Date().toISOString(),
  }).eq("id", job.id);
}

function respond(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status, headers: { "Content-Type": "application/json" },
  });
}

async function heartbeat(name: string, durationMs: number, result: unknown): Promise<void> {
  try {
    await db.from("cron_heartbeats").upsert(
      { name, last_run_at: new Date().toISOString(), last_duration_ms: durationMs, last_result: result },
      { onConflict: "name" }
    );
  } catch (_) { /* never break sync over a heartbeat write */ }
}

// ── Function ──────────────────────────────────────────────────────

// supabase/functions/gmail-email-sync-cron/index.ts
// Every 15 min (offset 7) — queues email_sync jobs per project


Deno.serve(async (_req) => {
  console.log("[email-sync-cron] START");
  const t0 = Date.now();
  let queued = 0;

  const { data: companies, error: companiesErr } = await db.from("companies")
    .select("id, gmail_parent_label").not("gmail_parent_label", "is", null);

  console.log(`[email-sync-cron] companies=${companies?.length || 0}${companiesErr ? ' error=' + companiesErr.message : ''}`);

  for (const company of (companies || [])) {
    const companyId = company.id;
    let companyQueued = 0;
    console.log(`[email-sync-cron] ── Company ${companyId} (${company.gmail_parent_label}) ──`);

    // Count connected users
    const { data: members, error: membersErr } = await db.from("company_memberships").select("user_id").eq("company_id", companyId);
    console.log(`[email-sync-cron] members=${members?.length || 0}${membersErr ? ' error=' + membersErr.message : ''}`);

    const memberIds = (members || []).map((m: any) => m.user_id);
    const { data: tokenRows, error: tokensErr } = await db
      .from("user_gmail_tokens")
      .select("user_id, email")
      .in("user_id", memberIds.length ? memberIds : ["00000000-0000-0000-0000-000000000000"]);

    console.log(`[email-sync-cron] tokenRows=${tokenRows?.length || 0}${tokensErr ? ' error=' + tokensErr.message : ''}`);

    const connectedUserIds: string[] = (tokenRows || []).map((t: any) => {
      console.log(`[email-sync-cron] ✓ connected: ${t.email} (${t.user_id})`);
      return t.user_id;
    });
    const notConnected = memberIds.filter((id: string) => !connectedUserIds.includes(id));
    if (notConnected.length) console.log(`[email-sync-cron] ✗ no token for ${notConnected.length} users: ${notConnected.join(', ')}`);
    if (!connectedUserIds.length) { console.log(`[email-sync-cron] No connected users — skipping`); continue; }

    // Get active labels — archived projects are owned exclusively by gmail-archive-worker
    const { data: labels, error: labelsErr } = await db.from("project_gmail_labels")
      .select("project_id, label_code, gmail_label_name").eq("company_id", companyId)
      .is("removed_at", null).is("archived_at", null);
    console.log(`[email-sync-cron] activeLabels=${labels?.length || 0}${labelsErr ? ' error=' + labelsErr.message : ''}`);
    if (!labels?.length) { console.log(`[email-sync-cron] No active labels — skipping`); continue; }

    // Batch: get all project_ids that have emails
    const { data: projectsWithEmails, error: emailsErr } = await db.from("project_emails")
      .select("project_id")
      .eq("company_id", companyId)
      .in("project_id", labels.map(l => l.project_id));

    const projectIdsWithEmails = new Set((projectsWithEmails || []).map((e: any) => e.project_id));
    console.log(`[email-sync-cron] projectsWithEmails=${projectIdsWithEmails.size}/${labels.length}${emailsErr ? ' error=' + emailsErr.message : ''}`);

    // Batch fetch existing jobs — include completed_users to check progress
    const { data: existingJobs, error: jobsErr } = await db.from("gmail_sync_jobs")
      .select("id, status, project_id, completed_users, total_users")
      .eq("job_type", "email_sync")
      .eq("company_id", companyId);
    console.log(`[email-sync-cron] existingJobs=${existingJobs?.length || 0}${jobsErr ? ' error=' + jobsErr.message : ''}`);
    const existingByProject = new Map((existingJobs || []).map((j: any) => [j.project_id, j]));

    const toUpdate: string[] = [];
    const toInsert: any[] = [];
    let skippedNoEmails = 0, skippedProcessing = 0, skippedInProgress = 0, skippedAlreadyDone = 0;

    for (const label of (labels as any[])) {
      if (!projectIdsWithEmails.has(label.project_id)) { skippedNoEmails++; continue; }
      const existing = existingByProject.get(label.project_id) as any;

      // Skip if currently processing
      if (existing?.status === "processing") { skippedProcessing++; continue; }

      // Skip if partially completed — don't wipe progress
      const completedCount = (existing?.completed_users || []).length;
      const totalUsers = existing?.total_users || 0;
      if (existing?.status === "pending" && completedCount > 0 && completedCount < totalUsers) {
        skippedInProgress++;
        // Just update total_users in case it changed
        if (totalUsers !== connectedUserIds.length) {
          await db.from("gmail_sync_jobs").update({
            total_users: connectedUserIds.length,
            updated_at: new Date().toISOString(),
          }).eq("id", existing.id);
        }
        continue;
      }

      // A job that's already "done" only needs redoing if the connected-
      // member count changed since — otherwise leave it alone. This used
      // to reset EVERY done job to pending on EVERY 15-min sweep
      // unconditionally, meaning the whole system perpetually re-verified
      // every project's emails against every user's mailbox forever. See
      // the matching fix in gmail-label-sync-cron for the full story.
      if (existing?.status === "done" && totalUsers === connectedUserIds.length) {
        skippedAlreadyDone++;
        continue;
      }

      if (existing) {
        toUpdate.push(existing.id);
      } else {
        toInsert.push({
          job_type: "email_sync", company_id: companyId,
          project_id: label.project_id, label_code: label.label_code,
          gmail_label_name: label.gmail_label_name, status: "pending",
          attempts: 0, completed_users: [], total_users: connectedUserIds.length,
        });
      }
    }

    console.log(`[email-sync-cron] toUpdate=${toUpdate.length} toInsert=${toInsert.length} skippedNoEmails=${skippedNoEmails} skippedProcessing=${skippedProcessing} skippedInProgress=${skippedInProgress} skippedAlreadyDone=${skippedAlreadyDone}`);

    if (toUpdate.length) {
      const { error: updateErr } = await db.from("gmail_sync_jobs").update({
        status: "pending", attempts: 0, error: null,
        completed_users: [], total_users: connectedUserIds.length,
        updated_at: new Date().toISOString(),
      }).in("id", toUpdate);
      if (updateErr) console.error(`[email-sync-cron] update error:`, updateErr.message);
    }
    if (toInsert.length) {
      const { error: insertErr } = await db.from("gmail_sync_jobs").insert(toInsert);
      if (insertErr) console.error(`[email-sync-cron] insert error:`, insertErr.message);
    }

    companyQueued = toUpdate.length + toInsert.length;
    queued += companyQueued;
    console.log(`[email-sync-cron] Company ${companyId}: queued=${companyQueued}`);
  }

  console.log(`[email-sync-cron] DONE in ${Date.now() - t0}ms — totalQueued=${queued}`);
  await heartbeat("gmail-email-sync-cron", Date.now() - t0, { queued });
  return new Response(JSON.stringify({ ok: true, queued }), { headers: { "Content-Type": "application/json" } });
});