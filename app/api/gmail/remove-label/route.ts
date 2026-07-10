// app/api/gmail/remove-label/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabaseServer";
import { createClient } from "@supabase/supabase-js";

export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  // Only need messageId — project resolved from DB
  const { messageId, logId } = body;
  console.log('[remove-label] messageId:', messageId);

  try {
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

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceKey) {
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
    }

    const adminDb = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // ── Step 1: find project from project_emails by messageId ──────
    const { data: pe } = await adminDb
      .from('project_emails')
      .select('project_id')
      .eq('gmail_message_id', messageId)
      .limit(1)
      .single();

    console.log('[remove-label] Step 1 project_emails:', pe);

    if (!pe?.project_id) {
      return NextResponse.json(
        { error: 'This message is not assigned to any project' },
        { status: 400 }
      );
    }

    const projectId = pe.project_id;

    // ── Step 2: get label name from project_gmail_labels ──────────
    const { data: pgl } = await adminDb
      .from('project_gmail_labels')
      .select('gmail_label_name')
      .eq('project_id', projectId)
      .single();

    console.log('[remove-label] Step 2 project_gmail_labels:', pgl);

    const gmailLabelName = pgl?.gmail_label_name || null;
    if (!gmailLabelName) {
      return NextResponse.json(
        { error: 'No label name found for this project' },
        { status: 400 }
      );
    }

    console.log('[remove-label] Step 3 label to remove:', gmailLabelName);

    // ── Step 3: check admin status ─────────────────────────────────
    const { data: membership } = await adminDb
      .from('company_memberships')
      .select('role')
      .eq('user_id', user.id)
      .eq('company_id', companyId)
      .single();

    const isAdmin = membership?.role === 'company_admin';

    // Admin removes from ALL members; non-admin removes from self only
    let usersToProcess: string[] = [];
    if (isAdmin) {
      const { data: members } = await adminDb
        .from('company_memberships')
        .select('user_id')
        .eq('company_id', companyId);
      usersToProcess = (members || []).map((m: any) => m.user_id);
    } else {
      usersToProcess = [user.id];
    }

    console.log('[remove-label] Step 3 isAdmin:', isAdmin, 'users:', usersToProcess.length);

    let removedCount = 0;

    // ── Step 4: remove label from each user's Gmail ────────────────
    for (const userId of usersToProcess) {
      try {
        const { data: tokenRow } = await adminDb
          .from('user_gmail_tokens')
          .select('access_token, refresh_token, token_expires_at')
          .eq('user_id', userId)
          .single();

        if (!tokenRow) {
          console.log(`[remove-label] No Gmail token for user ${userId} — skipping`);
          continue;
        }

        // Refresh token if needed
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
            console.log(`[remove-label] Token refresh failed for ${userId}`);
            continue;
          }
          accessToken = refreshed.access_token;
          await adminDb.from('user_gmail_tokens').update({
            access_token: refreshed.access_token,
            token_expires_at: new Date(Date.now() + refreshed.expires_in * 1000).toISOString(),
          }).eq('user_id', userId);
        }

        // Find label in this user's Gmail by name
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

        // Check user has the message
        const msgRes = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        if (!msgRes.ok) {
          console.log(`[remove-label] User ${userId} doesn't have message ${messageId}`);
          continue;
        }

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
          console.error(`[remove-label] Gmail error for ${userId}:`, err.error?.message);
          continue;
        }

        removedCount++;
        console.log(`[remove-label] ✓ Removed from user ${userId}`);

        // Mark as removed in sync table
        await adminDb
          .from('user_gmail_label_sync')
          .update({ label_removed_at: new Date().toISOString() })
          .eq('user_id', userId)
          .eq('project_id', projectId)
          .eq('gmail_message_id', messageId);

        // Log
        await adminDb.from('gmail_sync_log').insert({
          company_id: companyId,
          triggered_by: user.id,
          action: 'label_removed',
          project_id: projectId,
          gmail_message_id: messageId,
          gmail_label_name: gmailLabelName,
          target_user_id: userId,
          details: { labelId: found.id, removedByUserId: user.id, isAdminAction: isAdmin },
        });

      } catch (err: any) {
        console.error(`[remove-label] Error for user ${userId}:`, err.message);
      }
    }

    // ── Step 5: clean up DB ───────────────────────────────────────
    if (isAdmin) {
      // Delete all project_emails for this message
      await adminDb
        .from('project_emails')
        .delete()
        .eq('gmail_message_id', messageId)
        .eq('company_id', companyId);

      // Mark project_gmail_labels as removed — do NOT delete.
      // Cron uses label_code to find and remove label from all users' Gmail.
      await adminDb
        .from('project_gmail_labels')
        .update({ removed_at: new Date().toISOString() })
        .eq('project_id', projectId)
        .eq('company_id', companyId);

    } else {
      // Non-admin removes only their own row — cron will re-add within 5 min
      await adminDb
        .from('project_emails')
        .delete()
        .eq('gmail_message_id', messageId)
        .eq('user_id', user.id);
    }

    if (logId) {
      await adminDb.from('gmail_sync_log')
        .update({ reversed_at: new Date().toISOString(), reversed_by: user.id })
        .eq('id', logId);
    }

    console.log('[remove-label] Done. removedCount:', removedCount);
    return NextResponse.json({ ok: true, removedFromUsers: removedCount });

  } catch (err: any) {
    console.error('[remove-label] Unhandled error:', err);
    return NextResponse.json({ error: err.message || 'Unknown error' }, { status: 500 });
  }
}