// app/api/gmail/sync/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabaseServer";
import { createClient } from "@supabase/supabase-js";

export async function POST(req: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: prof } = await supabase
    .from('profiles')
    .select('active_company_id')
    .eq('id', user.id)
    .single();

  const companyId = prof?.active_company_id;
  if (!companyId) return NextResponse.json({ error: 'No company' }, { status: 400 });

  const result = await runSync(companyId, user.id);
  return NextResponse.json(result);
}

export async function runSync(companyId: string, triggeredBy: string) {
  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  console.log(`[sync] Starting for company ${companyId}`);

  const { data: projectLabels } = await db
    .from('project_gmail_labels')
    .select('project_id, gmail_label_name')
    .eq('company_id', companyId);

  if (!projectLabels?.length) return { synced: 0, reapplied: 0, users: 0 };

  // Get company source emails + all members
  const { data: company } = await db
    .from('companies')
    .select('gmail_source_emails')
    .eq('id', companyId)
    .single();

  const sourceEmailList: string[] = company?.gmail_source_emails || [];

  const { data: members } = await db
    .from('company_memberships')
    .select('user_id')
    .eq('company_id', companyId);

  const connectedUsers: { userId: string; accessToken: string }[] = [];
  for (const m of (members || [])) {
    const token = await getAccessToken(db, m.user_id);
    if (token) connectedUsers.push({ userId: m.user_id, accessToken: token });
  }

  if (!connectedUsers.length) return { synced: 0, reapplied: 0, users: 0 };

  // Find source users — those whose Gmail email is nominated as source of truth
  // If none nominated, fall back to first connected user
  let sourceUsers: { userId: string; accessToken: string }[] = [];

  if (sourceEmailList.length > 0) {
    // Look up user IDs for nominated emails
    const { data: tokenRows } = await db
      .from('user_gmail_tokens')
      .select('user_id, email')
      .in('email', sourceEmailList);

    for (const tr of (tokenRows || [])) {
      const found = connectedUsers.find(u => u.userId === tr.user_id);
      if (found) sourceUsers.push(found);
    }
  }

  if (!sourceUsers.length) {
    // Fallback — use first connected user
    sourceUsers = [connectedUsers[0]];
    console.log(`[sync] No source emails nominated — using ${connectedUsers[0].userId} as source`);
  } else {
    console.log(`[sync] Using ${sourceUsers.length} nominated source email(s)`);
  }

  // Use first source user for reading (multiple sources merged below)
  const sourceUser = sourceUsers[0];
  const logs: any[] = [];
  let totalSynced = 0;
  let totalReapplied = 0;

  for (const pl of projectLabels) {
    if (!pl.gmail_label_name) continue;

    const sourceLabelId = await getLabelId(sourceUser.accessToken, pl.gmail_label_name);
    if (!sourceLabelId) continue;

    const messageIds = await getMessagesWithLabel(sourceUser.accessToken, sourceLabelId);
    if (!messageIds.length) continue;

    console.log(`[sync] "${pl.gmail_label_name}" — ${messageIds.length} messages`);

    for (const msgId of messageIds) {
      // Get raw message + subject from source
      let rawMessage: string | null = null;
      let subject = '';

      try {
        const rawRes = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}?format=raw`,
          { headers: { Authorization: `Bearer ${sourceUser.accessToken}` } }
        );
        if (!rawRes.ok) continue;
        const rawData = await rawRes.json();
        rawMessage = rawData.raw || null;

        const metaRes = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}?format=metadata&metadataHeaders=Subject`,
          { headers: { Authorization: `Bearer ${sourceUser.accessToken}` } }
        );
        const metaData = await metaRes.json();
        subject = metaData.payload?.headers?.find((h: any) => h.name === 'Subject')?.value || '';
      } catch { continue; }

      if (!rawMessage) continue;

      // Check existing sync records for this message
      const { data: existingSync } = await db
        .from('user_gmail_label_sync')
        .select('user_id, label_removed_at')
        .eq('project_id', pl.project_id)
        .eq('gmail_message_id', msgId);

      const syncMap = new Map(
        (existingSync || []).map((s: any) => [s.user_id, s.label_removed_at])
      );

      for (const { userId, accessToken } of connectedUsers) {
        const removedAt = syncMap.get(userId);
        const hasSyncRecord = syncMap.has(userId);

        // Get or create label in this user's Gmail
        const userLabelId = await getOrCreateLabel(accessToken, pl.gmail_label_name);
        if (!userLabelId) continue;

        if (!hasSyncRecord) {
          // ── New user — never synced this message ─────────────────
          let finalMsgId = msgId;

          const existingMsgRes = await fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
          );

          if (existingMsgRes.ok) {
            // User has the message — just apply label
            const applyRes = await fetch(
              `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}/modify`,
              {
                method: 'POST',
                headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ addLabelIds: [userLabelId] }),
              }
            );
            if (!applyRes.ok) continue;
          } else {
            // Import email into user's inbox
            const importRes = await fetch(
              `https://gmail.googleapis.com/gmail/v1/users/me/messages/import`,
              {
                method: 'POST',
                headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ raw: rawMessage, labelIds: [userLabelId, 'INBOX'] }),
              }
            );
            if (!importRes.ok) continue;
            const imported = await importRes.json();
            finalMsgId = imported.id || msgId;
          }

          await db.from('user_gmail_label_sync').upsert({
            company_id: companyId,
            user_id: userId,
            project_id: pl.project_id,
            gmail_message_id: finalMsgId,
            gmail_label_id: userLabelId,
            label_applied_at: new Date().toISOString(),
            synced_at: new Date().toISOString(),
            label_removed_at: null,
          }, { onConflict: 'user_id,project_id,gmail_message_id' });

          await db.from('project_emails').upsert({
            user_id: userId,
            company_id: companyId,
            project_id: pl.project_id,
            gmail_message_id: finalMsgId,
            subject,
            gmail_label_applied: true,
          }, { onConflict: 'user_id,gmail_message_id' });

          totalSynced++;
          logs.push({
            company_id: companyId,
            triggered_by: triggeredBy,
            action: 'sync_to_user',
            project_id: pl.project_id,
            gmail_message_id: finalMsgId,
            gmail_label_name: pl.gmail_label_name,
            target_user_id: userId,
            details: { subject, source: 'background_sync' },
          });

          console.log(`[sync] ✓ NEW "${subject}" → ${userId}`);

        } else if (removedAt !== null) {
          // ── Label was removed — re-apply it ─────────────────────
          // Non-admin removed their label — sync restores it

          const msgRes = await fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
          );

          if (msgRes.ok) {
            // Check if label is already on the message
            const msgData = await msgRes.json();
            const hasLabel = (msgData.labelIds || []).includes(userLabelId);

            if (!hasLabel) {
              // Re-apply the label
              const reapplyRes = await fetch(
                `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}/modify`,
                {
                  method: 'POST',
                  headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
                  body: JSON.stringify({ addLabelIds: [userLabelId] }),
                }
              );
              if (!reapplyRes.ok) continue;

              // Clear the removed_at flag
              await db.from('user_gmail_label_sync')
                .update({
                  label_removed_at: null,
                  synced_at: new Date().toISOString(),
                })
                .eq('user_id', userId)
                .eq('project_id', pl.project_id)
                .eq('gmail_message_id', msgId);

              totalReapplied++;
              logs.push({
                company_id: companyId,
                triggered_by: triggeredBy,
                action: 'label_reapplied',
                project_id: pl.project_id,
                gmail_message_id: msgId,
                gmail_label_name: pl.gmail_label_name,
                target_user_id: userId,
                details: { subject, source: 'reapply_sync' },
              });

              console.log(`[sync] ↺ REAPPLIED "${subject}" → ${userId}`);
            } else {
              // Label is already there — just clear removed_at
              await db.from('user_gmail_label_sync')
                .update({ label_removed_at: null, synced_at: new Date().toISOString() })
                .eq('user_id', userId)
                .eq('project_id', pl.project_id)
                .eq('gmail_message_id', msgId);
            }
          } else {
            // User no longer has the message — re-import it
            const importRes = await fetch(
              `https://gmail.googleapis.com/gmail/v1/users/me/messages/import`,
              {
                method: 'POST',
                headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ raw: rawMessage, labelIds: [userLabelId, 'INBOX'] }),
              }
            );
            if (!importRes.ok) continue;
            const imported = await importRes.json();

            await db.from('user_gmail_label_sync')
              .update({
                gmail_message_id: imported.id || msgId,
                label_removed_at: null,
                synced_at: new Date().toISOString(),
              })
              .eq('user_id', userId)
              .eq('project_id', pl.project_id)
              .eq('gmail_message_id', msgId);

            totalReapplied++;
            console.log(`[sync] ↺ REIMPORTED "${subject}" → ${userId}`);
          }
        }
        // else: hasSyncRecord && removedAt === null → already synced, no action needed
      }
    }
  }

  if (logs.length > 0) {
    await db.from('gmail_sync_log').insert(logs);
  }

  console.log(`[sync] Done. synced=${totalSynced} reapplied=${totalReapplied}`);
  return {
    synced: totalSynced,
    reapplied: totalReapplied,
    users: connectedUsers.length,
    labels: projectLabels.length,
  };
}

// ── Helpers ────────────────────────────────────────────────────────

async function getAccessToken(db: any, userId: string): Promise<string | null> {
  const { data } = await db
    .from('user_gmail_tokens')
    .select('access_token, refresh_token, token_expires_at')
    .eq('user_id', userId)
    .single();
  if (!data) return null;
  const isExpired = Date.now() > new Date(data.token_expires_at).getTime() - 5 * 60 * 1000;
  if (!isExpired) return data.access_token;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      refresh_token: data.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  const refreshed = await res.json();
  if (!refreshed.access_token) return null;
  await db.from('user_gmail_tokens').update({
    access_token: refreshed.access_token,
    token_expires_at: new Date(Date.now() + refreshed.expires_in * 1000).toISOString(),
  }).eq('user_id', userId);
  return refreshed.access_token;
}

async function getLabelId(accessToken: string, labelName: string): Promise<string | null> {
  const res = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/labels',
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const data = await res.json();
  return (data.labels || []).find((l: any) => l.name === labelName)?.id || null;
}

async function getOrCreateLabel(accessToken: string, labelName: string): Promise<string | null> {
  const existing = await getLabelId(accessToken, labelName);
  if (existing) return existing;
  const parts = labelName.split('/');
  let createdId: string | null = null;
  const allRes = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/labels',
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const allData = await allRes.json();
  const all: { id: string; name: string }[] = allData.labels || [];
  for (let i = 1; i <= parts.length; i++) {
    const partial = parts.slice(0, i).join('/');
    const found = all.find(l => l.name === partial);
    if (found) { createdId = found.id; continue; }
    const cr = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/labels', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: partial,
        labelListVisibility: 'labelShow',
        messageListVisibility: i === parts.length ? 'show' : 'hide',
      }),
    });
    if (!cr.ok) return null;
    const created = await cr.json();
    createdId = created.id;
    all.push({ id: created.id, name: partial });
  }
  return createdId;
}

async function getMessagesWithLabel(accessToken: string, labelId: string): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
    url.searchParams.set('labelIds', labelId);
    url.searchParams.set('maxResults', '500');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
    const data = await res.json();
    if (!res.ok) break;
    (data.messages || []).forEach((m: any) => ids.push(m.id));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return ids;
}