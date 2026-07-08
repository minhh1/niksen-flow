// app/api/gmail/messages/[id]/route.ts
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

    // Get parent label for this company
    const { data: prof } = await supabase
      .from('profiles').select('active_company_id').eq('id', user.id).single();
    let parentLabel = 'Shared Emails';
    if (prof?.active_company_id) {
      const { data: company } = await supabase
        .from('companies').select('gmail_parent_label').eq('id', prof.active_company_id).single();
      if (company?.gmail_parent_label) parentLabel = company.gmail_parent_label;
    }

    // Get all labels to resolve IDs → names
    const allLabelsRes = await fetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/labels',
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const allLabelsData = await allLabelsRes.json();
    const labelIdToName = new Map<string, string>();
    (allLabelsData.labels || []).forEach((l: any) => labelIdToName.set(l.id, l.name));

    // Get full message
    const msgRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!msgRes.ok) {
      const err = await msgRes.json();
      return NextResponse.json({ error: err.error?.message }, { status: msgRes.status });
    }
    const msgData = await msgRes.json();

    // Decode body
    const body = extractBody(msgData.payload);

    const labelIds: string[] = msgData.labelIds || [];
    const SYSTEM_PREFIXES = ['INBOX','UNREAD','IMPORTANT','SENT','DRAFT','SPAM','TRASH','STARRED','CATEGORY_'];

    const niksenLabels = labelIds
      .map(id => labelIdToName.get(id))
      .filter((name): name is string =>
        !!name &&
        !SYSTEM_PREFIXES.some(p => name.startsWith(p)) &&
        name.startsWith(`${parentLabel}/`)
      );

    return NextResponse.json({
      id: msgData.id,
      body,
      labelIds,
      niksenLabels,   // ← resolved names for display
    });

  } catch (err: any) {
    console.error('[message/id] Error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

function extractBody(payload: any): string {
  if (!payload) return '';

  // Direct body
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8');
  }

  // Multipart — prefer text/html then text/plain
  if (payload.parts) {
    const htmlPart = payload.parts.find((p: any) => p.mimeType === 'text/html');
    if (htmlPart?.body?.data) {
      return Buffer.from(htmlPart.body.data, 'base64').toString('utf-8');
    }
    const textPart = payload.parts.find((p: any) => p.mimeType === 'text/plain');
    if (textPart?.body?.data) {
      const text = Buffer.from(textPart.body.data, 'base64').toString('utf-8');
      return `<pre style="font-family: sans-serif; white-space: pre-wrap;">${text}</pre>`;
    }
    // Recurse into nested parts
    for (const part of payload.parts) {
      const nested = extractBody(part);
      if (nested) return nested;
    }
  }

  return '';
}