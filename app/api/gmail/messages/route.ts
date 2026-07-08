// app/api/gmail/messages/route.ts
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

    // Get company's parent label so we can identify niksen labels
    const { data: prof } = await supabase
      .from('profiles')
      .select('active_company_id')
      .eq('id', user.id)
      .single();

    let parentLabel = 'Shared Emails';
    if (prof?.active_company_id) {
      const { data: company } = await supabase
        .from('companies')
        .select('gmail_parent_label')
        .eq('id', prof.active_company_id)
        .single();
      if (company?.gmail_parent_label) parentLabel = company.gmail_parent_label;
    }

    // Get all user's Gmail labels upfront — needed to resolve IDs to names
    const allLabelsRes = await fetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/labels',
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const allLabelsData = await allLabelsRes.json();
    const allLabels: { id: string; name: string }[] = allLabelsData.labels || [];

    // Build a map of label ID → name for fast lookup
    const labelIdToName = new Map<string, string>();
    allLabels.forEach(l => labelIdToName.set(l.id, l.name));

    // Get search query from URL params
    const { searchParams } = new URL(req.url);
    const q = searchParams.get('q') || 'in:inbox';

    // Fetch message list
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

    if (!messageIds.length) {
      return NextResponse.json({ messages: [] });
    }

    // Fetch message details in parallel (batches of 10)
    const BATCH_SIZE = 10;
    const messages = [];

    for (let i = 0; i < messageIds.length; i += BATCH_SIZE) {
      const batch = messageIds.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(async (id) => {
          const msgRes = await fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
          );
          if (!msgRes.ok) return null;
          return msgRes.json();
        })
      );
      messages.push(...batchResults.filter(Boolean));
    }

    // Parse messages
    const SYSTEM_LABEL_PREFIXES = [
      'INBOX', 'UNREAD', 'IMPORTANT', 'SENT', 'DRAFT',
      'SPAM', 'TRASH', 'STARRED', 'CATEGORY_',
    ];

    const parsed = messages.map((msg: any) => {
      const headers = msg.payload?.headers || [];
      const get = (name: string) =>
        headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

      const fromRaw = get('From');
      const fromMatch = fromRaw.match(/^(.+?)\s*<(.+?)>$/);
      const fromName = fromMatch
        ? fromMatch[1].trim().replace(/^"|"$/g, '')
        : fromRaw;
      const fromAddr = fromMatch ? fromMatch[2].trim() : fromRaw;

      const labelIds: string[] = msg.labelIds || [];

      // Resolve label IDs to names and filter out system labels
      const resolvedLabels = labelIds
        .map(id => labelIdToName.get(id))
        .filter((name): name is string => {
          if (!name) return false;
          return !SYSTEM_LABEL_PREFIXES.some(prefix => name.startsWith(prefix));
        });

      // Identify niksen/project labels — those starting with our parent label
      const niksenLabels = resolvedLabels.filter(name =>
        name.startsWith(`${parentLabel}/`)
      );

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
        labelIds,                  // raw IDs — used internally
        niksenLabels,              // resolved names for project labels
      };
    });

    return NextResponse.json({ messages: parsed });

  } catch (err: any) {
    console.error('[messages] Error:', err);
    return NextResponse.json({ error: err.message || 'Unknown error' }, { status: 500 });
  }
}