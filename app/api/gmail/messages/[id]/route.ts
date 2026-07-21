// app/api/gmail/messages/[id]/route.ts
// Label detection: check project_emails table — no Gmail label ID mapping needed.

import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabaseServer";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { data: tokenRow } = await supabase
      .from('user_gmail_tokens')
      .select('access_token, refresh_token, token_expires_at')
      .eq('user_id', user.id)
      .single();

    if (!tokenRow) return NextResponse.json({ error: 'Not connected' }, { status: 400 });

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

    // ── Check project_emails — simple DB lookup ────────────────────
    const { data: pe } = await supabase
      .from('project_emails')
      .select('project_id')
      .eq('gmail_message_id', id)
      .eq('user_id', user.id)
      .single();

    let diractLabels: string[] = [];
    let diractProjectIds: string[] = [];

    if (pe?.project_id) {
      // Get label name from project_gmail_labels
      const { data: pgl } = await supabase
        .from('project_gmail_labels')
        .select('gmail_label_name')
        .eq('project_id', pe.project_id)
        .single();

      const labelName = pgl?.gmail_label_name || pe.project_id;
      diractLabels = [labelName];
      diractProjectIds = [pe.project_id];
    }

    console.log('[LABEL STEP 2 - API] message:', id, 'project_emails found:', !!pe, 'diractLabels:', diractLabels);

    // Get full message body
    const msgRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!msgRes.ok) {
      const err = await msgRes.json();
      return NextResponse.json({ error: err.error?.message }, { status: msgRes.status });
    }
    const msgData = await msgRes.json();
    const body = extractBody(msgData.payload);

    return NextResponse.json({
      id: msgData.id,
      body,
      labelIds: msgData.labelIds || [],
      diractLabels,
      diractProjectIds,
    });

  } catch (err: any) {
    console.error('[message/id] Error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

function extractBody(payload: any): string {
  if (!payload) return '';
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8');
  }
  if (payload.parts) {
    const htmlPart = payload.parts.find((p: any) => p.mimeType === 'text/html');
    if (htmlPart?.body?.data) {
      return Buffer.from(htmlPart.body.data, 'base64').toString('utf-8');
    }
    const textPart = payload.parts.find((p: any) => p.mimeType === 'text/plain');
    if (textPart?.body?.data) {
      const text = Buffer.from(textPart.body.data, 'base64').toString('utf-8');
      return `<pre style="font-family:sans-serif;white-space:pre-wrap">${text}</pre>`;
    }
    for (const part of payload.parts) {
      const nested = extractBody(part);
      if (nested) return nested;
    }
  }
  return '';
}