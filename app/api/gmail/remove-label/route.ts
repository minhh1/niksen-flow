// app/api/gmail/remove-label/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabaseServer";

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { messageId, projectId, logId } = body;
  console.log('[remove-label] body:', { messageId, projectId, logId });

  try {
    const supabase = await createSupabaseServerClient();

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { data: prof } = await supabase
      .from('profiles')
      .select('active_company_id, is_admin')
      .eq('id', user.id)
      .single();

    const isAdmin = prof?.is_admin || false;
    const companyId = prof?.active_company_id;
    if (!companyId) return NextResponse.json({ error: 'No company' }, { status: 400 });

    // ── Step 1: resolve the Gmail label name ───────────────────────
    let gmailLabelName: string | null = null;

    // Try DB first
    const { data: projectLabel } = await supabase
      .from('project_gmail_labels')
      .select('gmail_label_name, gmail_label_id')
      .eq('project_id', projectId)
      .eq('company_id', companyId)
      .single();

    console.log('[remove-label] project_gmail_labels:', projectLabel);

    if (projectLabel?.gmail_label_name) {
      gmailLabelName = projectLabel.gmail_label_name;
    } else {
      // Fallback — look at the actual message labels in Gmail
      console.log('[remove-label] No DB label record, checking Gmail directly...');

      const { data: tokenRow } = await supabase
        .from('user_gmail_tokens')
        .select('access_token, refresh_token, token_expires_at')
        .eq('user_id', user.id)
        .single();

      if (tokenRow) {
        // Refresh if needed
        let accessToken = tokenRow.access_token;
        const isExpired = Date.now() > new Date(tokenRow.token_expires_at).getTime() - 5 * 60 * 1000;
        if (isExpired) {
          const refreshRes = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              client_id: process.env.GOOGLE_CLIENT_ID!,
              client_secret: process.env.GOOGLE_CLIENT_SECRET!,
              refresh_token: tokenRow.refresh_token,
              grant_type: 'refresh_token',
            }),
          });
          const refreshed = await refreshRes.json();
          if (refreshed.access_token) {
            accessToken = refreshed.access_token;
            await supabase.from('user_gmail_tokens').update({
              access_token: refreshed.access_token,
              token_expires_at: new Date(Date.now() + refreshed.expires_in * 1000).toISOString(),
            }).eq('user_id', user.id);
          }
        }

        // Get company parent label
        const { data: company } = await supabase
          .from('companies')
          .select('gmail_parent_label')
          .eq('id', companyId)
          .single();
        const parentLabel = company?.gmail_parent_label || 'Shared Emails';

        // Get all Gmail labels → ID to name map
        const allLabelsRes = await fetch(
          'https://gmail.googleapis.com/gmail/v1/users/me/labels',
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        const allLabelsData = await allLabelsRes.json();
        const labelIdToName = new Map<string, string>();
        (allLabelsData.labels || []).forEach((l: any) => labelIdToName.set(l.id, l.name));

        // Get this message's current label IDs
        const msgRes = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=metadata`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        const msgData = await msgRes.json();
        const msgLabelIds: string[] = msgData.labelIds || [];

        console.log('[remove-label] message labelIds:', msgLabelIds.length);

        // Find any label on this message starting with our parent prefix
        const niksenLabel = msgLabelIds
          .map(id => labelIdToName.get(id))
          .find(name => name && name.startsWith(`${parentLabel}/`));

        console.log('[remove-label] found niksen label on message:', niksenLabel);

        if (niksenLabel) {
          gmailLabelName = niksenLabel;
          // Backfill project_gmail_labels so future removes work from DB
          await supabase.from('project_gmail_labels').upsert({
            company_id: companyId,
            project_id: projectId,
            gmail_label_name: niksenLabel,
            label_sub: niksenLabel.split('/').slice(-1)[0],
            created_by: user.id,
          }, { onConflict: 'company_id,project_id' });
        }
      }
    }

    if (!gmailLabelName) {
      console.log('[remove-label] Could not resolve label name');
      return NextResponse.json(
        { error: 'No label found — it may have already been removed from Gmail' },
        { status: 400 }
      );
    }

    console.log('[remove-label] Removing label:', gmailLabelName);

    // ── Step 2: determine which users to remove from ───────────────
    const usersToProcess: string[] = [];
    if (isAdmin) {
      const { data: members } = await supabase
        .from('company_memberships')
        .select('user_id')
        .eq('company_id', companyId);
      usersToProcess.push(...(members || []).map((m: any) => m.user_id));
    } else {
      usersToProcess.push(user.id);
    }

    console.log('[remove-label] users to process:', usersToProcess.length);

    let removedCount = 0;

    // ── Step 3: remove label from each user's Gmail ────────────────
    for (const userId of usersToProcess) {
      try {
        const { data: tokenRow } = await supabase
          .from('user_gmail_tokens')
          .select('access_token, refresh_token, token_expires_at')
          .eq('user_id', userId)
          .single();

        if (!tokenRow) {
          console.log(`[remove-label] No token for user ${userId}`);
          continue;
        }

        // Refresh if needed
        let accessToken = tokenRow.access_token;
        const isExpired = Date.now() > new Date(tokenRow.token_expires_at).getTime() - 5 * 60 * 1000;
        if (isExpired) {
          const refreshRes = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              client_id: process.env.GOOGLE_CLIENT_ID!,
              client_secret: process.env.GOOGLE_CLIENT_SECRET!,
              refresh_token: tokenRow.refresh_token,
              grant_type: 'refresh_token',
            }),
          });
          const refreshed = await refreshRes.json();
          if (!refreshed.access_token) {
            console.log(`[remove-label] Failed to refresh token for ${userId}`);
            continue;
          }
          accessToken = refreshed.access_token;
          await supabase.from('user_gmail_tokens').update({
            access_token: refreshed.access_token,
            token_expires_at: new Date(Date.now() + refreshed.expires_in * 1000).toISOString(),
          }).eq('user_id', userId);
        }

        // Find the label ID in this user's Gmail by name
        const labelsRes = await fetch(
          'https://gmail.googleapis.com/gmail/v1/users/me/labels',
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        const labelsData = await labelsRes.json();
        const found = (labelsData.labels || []).find(
          (l: any) => l.name === gmailLabelName
        );

        if (!found?.id) {
          console.log(`[remove-label] Label "${gmailLabelName}" not found in Gmail for user ${userId}`);
          continue;
        }

        console.log(`[remove-label] Removing label ${found.id} from message ${messageId} for user ${userId}`);

        // Remove label from message
        const removeRes = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ removeLabelIds: [found.id] }),
          }
        );

        if (!removeRes.ok) {
          const err = await removeRes.json();
          console.error(`[remove-label] Gmail API error for ${userId}:`, err);
          continue;
        }

        removedCount++;
        console.log(`[remove-label] Successfully removed from user ${userId}`);

        // Update sync record if exists
        await supabase
          .from('user_gmail_label_sync')
          .update({ label_removed_at: new Date().toISOString() })
          .eq('user_id', userId)
          .eq('project_id', projectId)
          .eq('gmail_message_id', messageId);

        // Log
        await supabase.from('gmail_sync_log').insert({
          company_id: companyId,
          triggered_by: user.id,
          action: 'label_removed',
          project_id: projectId,
          gmail_message_id: messageId,
          gmail_label_name: gmailLabelName,
          target_user_id: userId,
          details: { removedByAdmin: isAdmin, labelId: found.id },
        });

      } catch (err: any) {
        console.error(`[remove-label] Error for user ${userId}:`, err);
      }
    }

    // ── Step 4: clean up DB ────────────────────────────────────────

    // Remove from project_emails
    const peQuery = supabase
      .from('project_emails')
      .delete()
      .eq('gmail_message_id', messageId)
      .eq('company_id', companyId);

    if (isAdmin) {
      await peQuery;
    } else {
      await peQuery.eq('user_id', user.id);
    }

    // Mark log entry as reversed if provided
    if (logId) {
      await supabase
        .from('gmail_sync_log')
        .update({
          reversed_at: new Date().toISOString(),
          reversed_by: user.id,
        })
        .eq('id', logId);
    }

    console.log('[remove-label] Done. removedCount:', removedCount);
    return NextResponse.json({ ok: true, removedFromUsers: removedCount });

  } catch (err: any) {
    console.error('[remove-label] Unhandled error:', err);
    return NextResponse.json({ error: err.message || 'Unknown error' }, { status: 500 });
  }
}