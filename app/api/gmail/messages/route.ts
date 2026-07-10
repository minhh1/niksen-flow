// app/api/gmail/messages/route.ts
// Label detection: check project_emails table — no Gmail label ID mapping needed.

import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabaseServer";

export async function GET(req: NextRequest) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { data: tokenRow } = await supabase
      .from('user_gmail_tokens')
      .select('access_token, refresh_token, token_expires_at')
      .eq('user_id', user.id)
      .single();

    if (!tokenRow) return NextResponse.json({ error: 'Gmail not connected' }, { status: 400 });

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
      if (refreshed.access_token) {
        accessToken = refreshed.access_token;
        await supabase.from('user_gmail_tokens').update({
          access_token: refreshed.access_token,
          token_expires_at: new Date(Date.now() + refreshed.expires_in * 1000).toISOString(),
        }).eq('user_id', user.id);
      } else {
        return NextResponse.json({ error: 'Failed to refresh token' }, { status: 401 });
      }
    }

    // ── Simple label detection: check project_emails table ────────
    // No Gmail label ID mapping. Just: is this message in project_emails?
    const { data: projectEmails } = await supabase
      .from('project_emails')
      .select('gmail_message_id, project_id, project:project_id(name)')
      .eq('user_id', user.id);

    const emailProjectMap = new Map<string, { projectId: string; labelName: string }>();
    (projectEmails || []).forEach((pe: any) => {
      // Use stored label name from project_gmail_labels if available
      emailProjectMap.set(pe.gmail_message_id, {
        projectId: pe.project_id,
        labelName: pe.project?.name || pe.project_id,
      });
    });

    // Also get label names from project_gmail_labels for display
    const { data: projectLabels } = await supabase
      .from('project_gmail_labels')
      .select('project_id, gmail_label_name');

    const projectLabelMap = new Map<string, string>();
    (projectLabels || []).forEach((pl: any) => {
      projectLabelMap.set(pl.project_id, pl.gmail_label_name);
    });

    // Enrich emailProjectMap with label names
    emailProjectMap.forEach((val, key) => {
      const labelName = projectLabelMap.get(val.projectId);
      if (labelName) val.labelName = labelName;
    });

    console.log('[LABEL STEP 1 - API] project_emails count:', emailProjectMap.size);

    // Fetch message list
    const { searchParams } = new URL(req.url);
    const q = searchParams.get('q') || 'in:inbox';

    const listRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(q)}&maxResults=50`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    if (!listRes.ok) {
      const err = await listRes.json();
      return NextResponse.json(
        { error: err.error?.message || 'Failed to fetch messages' },
        { status: listRes.status }
      );
    }

    const listData = await listRes.json();
    const messageIds: string[] = (listData.messages || []).map((m: any) => m.id);
    if (!messageIds.length) return NextResponse.json({ messages: [] });

    // Fetch message details in batches
    const BATCH_SIZE = 10;
    const messages = [];
    for (let i = 0; i < messageIds.length; i += BATCH_SIZE) {
      const batch = messageIds.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(async (id) => {
          const res = await fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
          );
          if (!res.ok) return null;
          return res.json();
        })
      );
      messages.push(...results.filter(Boolean));
    }

    const parsed = messages.map((msg: any) => {
      const headers = msg.payload?.headers || [];
      const get = (name: string) =>
        headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

      const fromRaw = get('From');
      const fromMatch = fromRaw.match(/^(.+?)\s*<(.+?)>$/);
      const fromName = fromMatch ? fromMatch[1].trim().replace(/^"|"$/g, '') : fromRaw;
      const fromAddr = fromMatch ? fromMatch[2].trim() : fromRaw;
      const labelIds: string[] = msg.labelIds || [];

      // ── Check project_emails — simple DB lookup ────────────────
      const assignment = emailProjectMap.get(msg.id);
      const niksenLabels = assignment ? [assignment.labelName] : [];
      const niksenProjectIds = assignment ? [assignment.projectId] : [];

      return {
        id: msg.id,
        threadId: msg.threadId,
        subject: get('Subject') || '(no subject)',
        from: fromAddr,
        fromName: fromName || fromAddr,
        date: get('Date'),
        snippet: msg.snippet || '',
        isRead: !labelIds.includes('UNREAD'),
        hasAttachments: (msg.payload?.parts || []).some(
          (p: any) => p.filename && p.filename.length > 0
        ),
        labelIds,
        niksenLabels,
        niksenProjectIds,
      };
    });

    const labelled = parsed.filter(m => m.niksenLabels.length > 0);
    console.log('[LABEL STEP 1 - API] labelled messages:', labelled.length, 'of', parsed.length);

    return NextResponse.json({ messages: parsed });

  } catch (err: any) {
    console.error('[messages] Error:', err);
    return NextResponse.json({ error: err.message || 'Unknown error' }, { status: 500 });
  }
}