// supabase/functions/gmail-push/index.ts
// PUB/SUB handler — real-time corrections + auto-label by subject
// 1. Label removed by user → re-add if still active in DB, remove from completed_users
// 2. New email with company label → save to project_emails + store subject
// 3. New email without label → check subject against project_email_subjects → auto-label

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const googleClientId = Deno.env.get("GOOGLE_CLIENT_ID")!;
const googleClientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET")!;

const db = createClient(supabaseUrl, serviceKey, {
  auth: { persistSession: false },
});

async function logActivity(row: Record<string, unknown>): Promise<void> {
  try { await db.from("gmail_sync_log").insert(row); } catch (_) { /* never break sync over logging */ }
}

async function heartbeat(name: string, durationMs: number, result: unknown): Promise<void> {
  try {
    await db.from("cron_heartbeats").upsert(
      { name, last_run_at: new Date().toISOString(), last_duration_ms: durationMs, last_result: result },
      { onConflict: "name" }
    );
  } catch (_) { /* never break the webhook over a heartbeat write */ }
}

// ── Helpers ────────────────────────────────────────────────────────

async function getAccessToken(userId: string): Promise<string | null> {
  const { data } = await db
    .from("user_gmail_tokens")
    .select("access_token, refresh_token, token_expires_at")
    .eq("user_id", userId)
    .single();
  if (!data) return null;
  if (new Date(data.token_expires_at).getTime() < Date.now() + 60_000) {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: googleClientId,
        client_secret: googleClientSecret,
        refresh_token: data.refresh_token,
        grant_type: "refresh_token",
      }),
    });
    const refreshed = await res.json();
    if (!refreshed.access_token) return null;
    await db.from("user_gmail_tokens").update({
      access_token: refreshed.access_token,
      token_expires_at: new Date(Date.now() + refreshed.expires_in * 1000).toISOString(),
    }).eq("user_id", userId);
    return refreshed.access_token;
  }
  return data.access_token;
}

async function getGmailLabels(token: string): Promise<{ id: string; name: string }[]> {
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/labels", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  return (await res.json()).labels || [];
}

// Strip "/" from leaf label name to avoid Gmail hierarchy issues
function sanitiseLabelName(name: string): string {
  const parts = name.split("/");
  if (parts.length <= 1) return name.replace(/\//g, "-");
  const leaf = parts[parts.length - 1].replace(/\//g, "-");
  return [...parts.slice(0, -1), leaf].join("/");
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
      const created = await res.json();
      lastId = created.id;
      existingLabels.push(created);
    }
  }
  return lastId;
}

async function getMessageHistory(token: string, startHistoryId: string): Promise<any[]> {
  const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/history");
  url.searchParams.set("startHistoryId", startHistoryId);
  url.searchParams.append("historyTypes", "messageAdded");
  url.searchParams.append("historyTypes", "messageDeleted");
  url.searchParams.append("historyTypes", "labelAdded");
  url.searchParams.append("historyTypes", "labelRemoved");
  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    console.log(`[push] History fetch failed: ${res.status} ${await res.text()}`);
    return [];
  }
  return (await res.json()).history || [];
}

async function getMessage(token: string, msgId: string): Promise<any | null> {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return res.ok ? await res.json() : null;
}


function extractEmailMeta(msgData: any): {
  subject: string | null;
  from_address: string | null;
  from_name: string | null;
  date: string | null;
  snippet: string | null;
} {
  const headers = msgData?.payload?.headers || [];
  const get = (name: string) => headers.find((h: any) => h.name === name)?.value || null;
  const fromRaw = get("From");
  // Parse "Name <email>" or just "email"
  let from_name: string | null = null;
  let from_address: string | null = null;
  if (fromRaw) {
    const m = fromRaw.match(/^(.+?)\s*<([^>]+)>/);
    if (m) {
      from_name = m[1].replace(/^"|"$/g, "").trim();
      from_address = m[2].trim();
    } else {
      from_address = fromRaw.trim();
    }
  }
  const dateRaw = get("Date");
  let date: string | null = null;
  if (dateRaw) {
    try { date = new Date(dateRaw).toISOString(); } catch { date = null; }
  }
  return {
    subject: get("Subject"),
    from_address,
    from_name,
    date,
    snippet: msgData?.snippet || null,
  };
}

function normaliseSubject(subject: string): string {
  return subject
    .replace(/^(re|fwd?|fw|aw|antw|tr|sv|vs|rv|ref):\s*/gi, "")
    .replace(/\s+/g, " ").trim().toLowerCase();
}

async function applyLabel(token: string, msgId: string, labelId: string): Promise<boolean> {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}/modify`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ addLabelIds: [labelId] }),
  });
  return res.ok;
}

// Remove user from completed_users so next sync re-processes them
async function invalidateSyncJob(companyId: string, projectId: string, userId: string): Promise<void> {
  const { data: job } = await db.from("gmail_sync_jobs")
    .select("id, completed_users")
    .eq("job_type", "label_sync")
    .eq("company_id", companyId)
    .eq("project_id", projectId)
    .maybeSingle();
  if (!job) return;
  const updated = (job.completed_users || []).filter((u: string) => u !== userId);
  await db.from("gmail_sync_jobs").update({
    completed_users: updated,
    status: "pending",
    is_realtime: true,
    updated_at: new Date().toISOString(),
  }).eq("id", job.id);
}

// A genuinely new email needs to reach EVERY other team member, not just
// the one this push event was about — reset the whole job (both types),
// not just this one user, so the dispatcher reconsiders everyone next
// tick. The label/email sync crons used to do this blindly for every
// project on every 15-min sweep regardless of whether anything changed,
// which is what made most of the label-sync backlog on 2026-07-21/22 —
// now that they only touch a job when something's actually different,
// gmail-push has to be the one to flag "something's different" for new
// mail, or new messages would stop propagating to the rest of the team.
async function resetJobsForNewEmail(companyId: string, projectId: string): Promise<void> {
  for (const jobType of ["label_sync", "email_sync"]) {
    await db.from("gmail_sync_jobs")
      .update({ status: "pending", completed_users: [], is_realtime: true, updated_at: new Date().toISOString() })
      .eq("job_type", jobType).eq("company_id", companyId).eq("project_id", projectId)
      .neq("status", "processing"); // don't disturb a unit actively mid-flight
  }
}

async function isCompanyAdmin(companyId: string, userId: string): Promise<boolean> {
  const { data } = await db.from("company_memberships")
    .select("role").eq("company_id", companyId).eq("user_id", userId).maybeSingle();
  return data?.role === "company_admin";
}

// Only an admin's delete should actually stick — anyone else's is treated as
// a mistake and undone. Doesn't try to restore the exact deleted message in
// place (Gmail's history "messagesDeleted" means it's genuinely gone from
// that mailbox, not just trashed); instead it removes just this one user
// from both jobs' completed_users, so the next dispatch re-syncs everything
// for them from scratch — which naturally re-imports whatever they're
// missing, including the one they deleted, from another connected member's
// copy, the same path used for anyone newly joining an existing label.
async function restoreIfNotAdmin(companyId: string, projectId: string, userId: string): Promise<boolean> {
  if (await isCompanyAdmin(companyId, userId)) return false;
  for (const jobType of ["label_sync", "email_sync"]) {
    const { data: job } = await db.from("gmail_sync_jobs")
      .select("id, completed_users").eq("job_type", jobType)
      .eq("company_id", companyId).eq("project_id", projectId).maybeSingle();
    if (!job) continue;
    const updated = (job.completed_users || []).filter((u: string) => u !== userId);
    await db.from("gmail_sync_jobs").update({
      completed_users: updated, status: "pending", is_realtime: true, updated_at: new Date().toISOString(),
    }).eq("id", job.id);
  }
  return true;
}

// ── Main handler ───────────────────────────────────────────────────

Deno.serve(async (req) => {
  const t0 = Date.now();
  // Updated as the handler progresses so the finally block below always has
  // something meaningful to report, however early the handler exits — this
  // is a webhook, not a cron job, so its "liveness" signal is "did the last
  // invocation get this far" rather than a fixed schedule.
  const summary: Record<string, unknown> = { stage: "start" };

  try {
    const body = await req.json();

    // Pub/Sub message is base64 encoded
    const data = body.message?.data;
    if (!data) { summary.stage = "no_data"; return new Response("ok", { status: 200 }); }

    const decoded = JSON.parse(atob(data));
    const { emailAddress, historyId } = decoded;
    console.log(`[push] ${emailAddress} historyId=${historyId}`);
    summary.emailAddress = emailAddress;
    summary.stage = "decoded";

    // Find user by email
    const { data: tokenRow } = await db
      .from("user_gmail_tokens")
      .select("user_id, last_history_id")
      .eq("email", emailAddress)
      .maybeSingle();

    if (!tokenRow) {
      console.log(`[push] No token for ${emailAddress}`);
      summary.stage = "no_token";
      return new Response("ok", { status: 200 });
    }

    const { user_id: userId, last_history_id: lastHistoryId } = tokenRow;
    const token = await getAccessToken(userId);
    if (!token) { summary.stage = "no_access_token"; return new Response("ok", { status: 200 }); }

    // Get ALL companies this user belongs to, with their gmail_parent_label
    const { data: memberships } = await db
      .from("company_memberships")
      .select("company_id, companies:company_id(id, gmail_parent_label)")
      .eq("user_id", userId);

    // Build map: parentLabel → companyId
    const companiesByPrefix = new Map<string, string>();
    for (const m of (memberships || [])) {
      const pl = (m.companies as any)?.gmail_parent_label;
      if (pl) companiesByPrefix.set(pl, m.company_id);
    }

    console.log(`[push] user=${userId} companies=${companiesByPrefix.size} prefixes=[${[...companiesByPrefix.keys()].join(', ')}]`);

    if (!companiesByPrefix.size) {
      console.log(`[push] No companies with gmail configured for ${emailAddress}`);
      summary.stage = "no_companies_configured";
      return new Response("ok", { status: 200 });
    }

    // Get all active DB labels for ALL this user's companies
    const allCompanyIds = [...companiesByPrefix.values()];
    const { data: dbLabels } = await db
      .from("project_gmail_labels")
      .select("project_id, label_code, gmail_label_name, company_id")
      .in("company_id", allCompanyIds)
      .is("removed_at", null);

    // Key by label_code for quick lookup
    const dbLabelsByCode = new Map((dbLabels || []).map(l => [l.label_code, l]));

    console.log(`[push] companies=${allCompanyIds.length}, dbLabels=${dbLabelsByCode.size}`);

    // Helper: get company_id from a Gmail label name by matching prefix
    const getCompanyFromLabelName = (labelName: string): string | null => {
      for (const [prefix, companyId] of companiesByPrefix) {
        if (labelName.startsWith(prefix + "/")) return companyId;
      }
      return null;
    };

    // Fetch history since last known ID
    const startId = lastHistoryId || String(BigInt(historyId) - 10n);
    const history = await getMessageHistory(token, startId);

    // Update history ID
    await db.from("user_gmail_tokens")
      .update({ last_history_id: historyId })
      .eq("user_id", userId);

    if (!history.length) {
      console.log(`[push] No history events`);
      summary.stage = "no_history_events";
      return new Response("ok", { status: 200 });
    }

    const gmailLabels = await getGmailLabels(token);

    console.log(`[push] ${history.length} history events, companies=${allCompanyIds.length}, dbLabels=${dbLabelsByCode.size}`);
    summary.stage = "processed";
    summary.historyEvents = history.length;
    summary.companies = allCompanyIds.length;

    // ── Labels added: aggregate across ALL history events first ───────
    // A single bulk operation (e.g. someone labelling hundreds of old
    // emails at once) shows up as many separate history events, each
    // contributing one labelsAdded item — grouping by label before doing
    // any work lets us tell "a handful of new emails" apart from "a bulk
    // batch" and pick a cheap path for the latter, rather than making a
    // full Gmail metadata fetch (getMessage) per message inline in the
    // push handler, which doesn't scale and risks the handler running long
    // or leaving inconsistent state if it's cut off partway through.
    interface LabelGroupItem { msgId: string; threadId: string }
    const labelGroups = new Map<string, { companyId: string; dbLabel: any; gmailLabelDisplayName: string; items: LabelGroupItem[] }>();

    for (const event of history) {
      for (const item of (event.labelsAdded || [])) {
        const msgId = item.message?.id;
        if (!msgId) continue;
        for (const addedLabelId of (item.labelIds || [])) {
          const gmailLabel = gmailLabels.find(l => l.id === addedLabelId);
          if (!gmailLabel) continue;
          const companyId = getCompanyFromLabelName(gmailLabel.name);
          if (!companyId) continue;
          const codeMatch = gmailLabel.name.match(/\[([A-Z0-9]{4,6})\]$/);
          if (!codeMatch) continue;
          const dbLabel = dbLabelsByCode.get(codeMatch[1]);
          if (!dbLabel) continue;
          if (!labelGroups.has(codeMatch[1])) {
            labelGroups.set(codeMatch[1], { companyId, dbLabel, gmailLabelDisplayName: gmailLabel.name, items: [] });
          }
          labelGroups.get(codeMatch[1])!.items.push({ msgId, threadId: item.message?.threadId || msgId });
        }
      }
    }

    const BULK_LABEL_THRESHOLD = 5;

    for (const [labelCode, group] of labelGroups) {
      const { companyId, dbLabel, gmailLabelDisplayName, items } = group;

      if (items.length > BULK_LABEL_THRESHOLD) {
        // Bulk path — skip the per-message Gmail metadata fetch entirely.
        // We already have message/thread IDs for free from the history
        // event, so record skeleton rows (subject/snippet left null) and
        // one summary log line, then nudge the label/email sync jobs back
        // to "pending" so the regular dispatcher pipeline — which already
        // has proper timeouts, quarantine, and a metadata backfill pass —
        // reconciles the details on its own next tick. A "done" job is
        // invisible to the dispatcher's polling query, so it has to be
        // reset rather than left alone.
        console.log(`[push] Bulk label event: ${items.length} messages for "${gmailLabelDisplayName}" — deferring detail to workers`);

        const rows = items.map(it => ({
          project_id: dbLabel.project_id, company_id: companyId,
          user_id: userId, gmail_message_id: it.msgId, gmail_thread_id: it.threadId,
          gmail_label_applied: true,
        }));
        const { error: bulkErr } = await db.from("project_emails")
          .upsert(rows, { onConflict: "user_id,gmail_message_id", ignoreDuplicates: true });
        if (bulkErr) console.error(`[push] Bulk upsert error:`, bulkErr.message);

        await logActivity({
          company_id: companyId, triggered_by: null, action: "bulk_label_sync_deferred",
          project_id: dbLabel.project_id, gmail_label_name: gmailLabelDisplayName,
          target_user_id: userId, details: { label_code: labelCode, count: items.length },
        });

        await resetJobsForNewEmail(companyId, dbLabel.project_id);
        continue;
      }

      // Small path — same per-message detail as before.
      for (const it of items) {
        const msgId = it.msgId;
        console.log(`[push] Label added "${gmailLabelDisplayName}" → project ${dbLabel.project_id}`);
        const msgData1 = await getMessage(token, msgId);
        const threadId1 = msgData1?.threadId || msgId;
        const meta1 = extractEmailMeta(msgData1);
        const { data: d1, error: e1 } = await db.from("project_emails").upsert({
          project_id: dbLabel.project_id, company_id: companyId,
          user_id: userId, gmail_message_id: msgId, gmail_thread_id: threadId1,
          subject: meta1.subject, from_address: meta1.from_address, from_name: meta1.from_name,
          date: meta1.date, snippet: meta1.snippet, gmail_label_applied: true,
        }, { onConflict: "user_id,gmail_message_id", ignoreDuplicates: true }).select();
        if (e1) console.error(`[push] project_emails error:`, e1.message);
        else {
          console.log(`[push] ✓ Saved msg=${msgId} subject="${meta1.subject}"`);
          // A skipped duplicate (already tracked) returns no row — only a
          // genuinely new message needs to propagate to the rest of the team.
          if (d1 && d1.length > 0) await resetJobsForNewEmail(companyId, dbLabel.project_id);
          await logActivity({
            company_id: companyId, triggered_by: null, action: "sync_to_user",
            project_id: dbLabel.project_id, gmail_message_id: msgId, gmail_label_name: gmailLabelDisplayName,
            target_user_id: userId, details: { label_code: labelCode, subject: meta1.subject, snippet: meta1.snippet },
          });
        }
        if (meta1.subject) {
          const ns = normaliseSubject(meta1.subject);
          if (ns) await db.from("project_email_subjects").upsert({
            project_id: dbLabel.project_id, company_id: companyId,
            gmail_message_id: msgId, subject_normalised: ns,
          }, { onConflict: "project_id,gmail_message_id", ignoreDuplicates: true });
        }
      }
    }

    for (const event of history) {

      // ── Labels removed: only an admin's removal sticks ────────────
      // Same policy as message deletion — a regular member accidentally
      // unlabeling their own copy gets auto-corrected (the label is
      // supposed to be shared team-wide), but an admin deliberately taking
      // one email out of a shared label is a real decision and shouldn't
      // get silently overridden the next time this project syncs.
      for (const item of (event.labelsRemoved || [])) {
        const msgId = item.message?.id;
        if (!msgId) continue;
        for (const removedLabelId of (item.labelIds || [])) {
          const gmailLabel = gmailLabels.find(l => l.id === removedLabelId);
          if (!gmailLabel) continue;
          const companyId = getCompanyFromLabelName(gmailLabel.name);
          if (!companyId) continue;
          const codeMatch = gmailLabel.name.match(/\[([A-Z0-9]{4,6})\]$/);
          if (!codeMatch) continue;
          const dbLabel = dbLabelsByCode.get(codeMatch[1]);
          if (!dbLabel) continue;

          if (await isCompanyAdmin(companyId, userId)) {
            console.log(`[push] Admin removed label "${gmailLabel.name}" from ${msgId} — leaving it removed`);
            // Delete this user's project_emails row for this message so it's
            // permanently excluded from future resyncs for them — not just
            // skipped this once. Without this, a later trigger unrelated to
            // this message (e.g. a new team member joining, which resets
            // completed_users for everyone) would re-include it and silently
            // undo the admin's decision.
            await db.from("project_emails").delete()
              .eq("user_id", userId).eq("gmail_message_id", msgId).eq("project_id", dbLabel.project_id);
            await logActivity({
              company_id: companyId, triggered_by: null, action: "label_removed",
              project_id: dbLabel.project_id, gmail_message_id: msgId, gmail_label_name: gmailLabel.name,
              target_user_id: userId, details: { label_code: codeMatch[1], reapplied: false },
            });
            continue;
          }

          console.log(`[push] Re-adding label "${gmailLabel.name}" to ${msgId}`);
          await applyLabel(token, msgId, removedLabelId);
          await invalidateSyncJob(companyId, dbLabel.project_id, userId);
          await logActivity({
            company_id: companyId, triggered_by: null, action: "label_removed",
            project_id: dbLabel.project_id, gmail_message_id: msgId, gmail_label_name: gmailLabel.name,
            target_user_id: userId, details: { label_code: codeMatch[1], reapplied: true },
          });
        }
      }

      // ── New messages: auto-label by subject across all companies ──
      for (const item of (event.messagesAdded || [])) {
        const msg = item.message;
        if (!msg) continue;
        const msgId = msg.id;
        const msgLabelIds: string[] = msg.labelIds || [];

        // Check if already has a company label
        let matchedCode: string | null = null;
        let matchedCompanyId: string | null = null;
        for (const lid of msgLabelIds) {
          const gl = gmailLabels.find(l => l.id === lid);
          if (!gl) continue;
          const cId = getCompanyFromLabelName(gl.name);
          if (!cId) continue;
          const m = gl.name.match(/\[([A-Z0-9]{4,6})\]$/);
          if (m) { matchedCode = m[1]; matchedCompanyId = cId; break; }
        }

        if (matchedCode && matchedCompanyId) {
          const dbLabel = dbLabelsByCode.get(matchedCode);
          if (dbLabel) {
            const md2 = await getMessage(token, msgId);
            const threadId2 = md2?.threadId || msgId;
            const { data: d2, error: e2 } = await db.from("project_emails").upsert({
              project_id: dbLabel.project_id, company_id: matchedCompanyId,
              user_id: userId, gmail_message_id: msgId, gmail_thread_id: threadId2, gmail_label_applied: true,
            }, { onConflict: "user_id,gmail_message_id", ignoreDuplicates: true }).select();
            if (e2) console.error(`[push] upsert error:`, e2.message);
            else {
              console.log(`[push] ✓ Saved labelled email ${msgId} [${matchedCode}]`);
              if (d2 && d2.length > 0) await resetJobsForNewEmail(matchedCompanyId, dbLabel.project_id);
            }
            const meta2 = extractEmailMeta(md2);
            await logActivity({
              company_id: matchedCompanyId, triggered_by: null, action: "sync_to_user",
              project_id: dbLabel.project_id, gmail_message_id: msgId, gmail_label_name: dbLabel.gmail_label_name,
              target_user_id: userId, details: { label_code: matchedCode, subject: meta2.subject, snippet: meta2.snippet },
            });
            await db.from("project_emails").update({
              subject: meta2.subject, from_address: meta2.from_address, from_name: meta2.from_name,
              date: meta2.date, snippet: meta2.snippet,
            }).eq("user_id", userId).eq("gmail_message_id", msgId);
            if (meta2.subject) {
              const ns = normaliseSubject(meta2.subject);
              if (ns) await db.from("project_email_subjects").upsert({
                project_id: dbLabel.project_id, company_id: matchedCompanyId,
                gmail_message_id: msgId, subject_normalised: ns,
              }, { onConflict: "project_id,gmail_message_id", ignoreDuplicates: true });
            }
          }
          continue;
        }

        // Auto-label by subject — search across ALL companies
        const msgData = await getMessage(token, msgId);
        if (!msgData) continue;
        const sh = (msgData.payload?.headers || []).find((h: any) => h.name === "Subject");
        if (!sh?.value) continue;
        const normSubject = normaliseSubject(sh.value);
        if (!normSubject || normSubject.length < 3) continue;

        const threadIdForMatch = msgData.threadId || msgId;

        // Prefer thread continuity over subject text — Gmail's own threading
        // (References/In-Reply-To) is a far more reliable signal than a
        // normalized subject string, which two unrelated matters can share
        // (e.g. a sender's copy-paste/typo referencing the wrong lot number
        // in near-identical property names — this is exactly how emails for
        // adjacent matters 260581/260582 got cross-labeled). If this
        // message's thread already has another message filed to a project,
        // use that project directly and skip subject matching entirely.
        let subjectMatch: { project_id: string; company_id: string } | null = null;

        const { data: threadMatches } = await db.from("project_emails")
          .select("project_id, company_id")
          .in("company_id", allCompanyIds)
          .eq("gmail_thread_id", threadIdForMatch)
          .limit(2);
        const distinctThreadProjects = new Set((threadMatches || []).map(m => `${m.company_id}:${m.project_id}`));
        if (distinctThreadProjects.size === 1) {
          subjectMatch = threadMatches![0];
          console.log(`[push] Auto-label by thread continuity: "${normSubject}" → project ${subjectMatch.project_id}`);
        }

        if (!subjectMatch) {
          console.log(`[push] Auto-label check: "${normSubject}"`);

          const { data: candidates } = await db.from("project_email_subjects")
            .select("project_id, company_id")
            .in("company_id", allCompanyIds)
            .eq("subject_normalised", normSubject)
            .limit(5);

          const distinctSubjectProjects = new Set((candidates || []).map(c => `${c.company_id}:${c.project_id}`));
          if (distinctSubjectProjects.size > 1) {
            // Same subject text matches more than one project — exactly the
            // ambiguous case that caused the cross-labeling incident. No
            // reliable way to pick the right one from subject text alone,
            // so skip auto-labeling rather than guess.
            console.log(`[push] Skipping auto-label — "${normSubject}" matches ${distinctSubjectProjects.size} different projects`);
            continue;
          }
          subjectMatch = candidates?.[0] || null;
        }

        if (!subjectMatch) continue;

        const { data: dbLabel } = await db.from("project_gmail_labels")
          .select("gmail_label_name, label_code")
          .eq("project_id", subjectMatch.project_id)
          .eq("company_id", subjectMatch.company_id)
          .is("removed_at", null).maybeSingle();

        if (!dbLabel) continue;

        const safeName = sanitiseLabelName(dbLabel.gmail_label_name);
        let labelId = gmailLabels.find(l => l.name.includes(`[${dbLabel.label_code}]`))?.id || null;
        if (!labelId) labelId = await createLabelHierarchy(token, safeName, gmailLabels);

        if (labelId) {
          console.log(`[push] Auto-labelling ${msgId} → "${safeName}"`);
          await applyLabel(token, msgId, labelId);
          const threadId3 = msgData?.threadId || msgId;
          const meta3 = extractEmailMeta(msgData);
          const { data: d3 } = await db.from("project_emails").upsert({
            project_id: subjectMatch.project_id, company_id: subjectMatch.company_id,
            user_id: userId, gmail_message_id: msgId, gmail_thread_id: threadId3,
            subject: meta3.subject, from_address: meta3.from_address, from_name: meta3.from_name,
            date: meta3.date, snippet: meta3.snippet, gmail_label_applied: true,
          }, { onConflict: "user_id,gmail_message_id", ignoreDuplicates: true }).select();
          if (d3 && d3.length > 0) await resetJobsForNewEmail(subjectMatch.company_id, subjectMatch.project_id);
          await db.from("project_email_subjects").upsert({
            project_id: subjectMatch.project_id, company_id: subjectMatch.company_id,
            gmail_message_id: msgId, subject_normalised: normSubject,
          }, { onConflict: "project_id,gmail_message_id", ignoreDuplicates: true });
          await logActivity({
            company_id: subjectMatch.company_id, triggered_by: null, action: "sync_to_user",
            project_id: subjectMatch.project_id, gmail_message_id: msgId, gmail_label_name: dbLabel.gmail_label_name,
            target_user_id: userId, details: { label_code: dbLabel.label_code, subject: meta3.subject, snippet: meta3.snippet },
          });
        }
      }

      // ── Messages deleted: only an admin's delete sticks ────────────
      // Gmail's history "messagesDeleted" fires for ANY deletion anywhere
      // in the mailbox, not just shared project emails — a user cleaning
      // out personal inbox clutter generates the exact same event. Only
      // act on it (and only log it) when this message was actually a
      // tracked project email for this user; otherwise it's noise that
      // has nothing to do with any shared matter.
      for (const item of (event.messagesDeleted || [])) {
        const msgId = item.message?.id;
        if (!msgId) continue;
        const { data: existing } = await db.from("project_emails")
          .select("project_id, company_id, subject, snippet, gmail_label_applied")
          .eq("user_id", userId).eq("gmail_message_id", msgId).maybeSingle();
        if (!existing?.company_id || !existing?.project_id) continue;

        const restored = await restoreIfNotAdmin(existing.company_id, existing.project_id, userId);

        console.log(`[push] Message deleted ${msgId}${restored ? " — non-admin, restoring" : " — admin, deletion stands"}`);
        await logActivity({
          company_id: existing.company_id, triggered_by: null,
          action: "message_deleted", project_id: existing.project_id,
          gmail_message_id: msgId, target_user_id: userId,
          details: { subject: existing.subject || null, snippet: existing.snippet || null, restored },
        });

        // The deleting user's own row is gone from their mailbox — drop it
        // so it doesn't linger as a stale "they have this" record; a
        // restore (if any) will create a fresh row once the re-sync runs.
        await db.from("project_emails").delete().eq("user_id", userId).eq("gmail_message_id", msgId);
      }
    }

    return new Response("ok", { status: 200 });
  } catch (err: any) {
    console.error("[push] Error:", err.message);
    summary.stage = "error";
    summary.error = err.message;
    return new Response("ok", { status: 200 }); // always 200 to Pub/Sub
  } finally {
    await heartbeat("gmail-push", Date.now() - t0, summary);
  }
});