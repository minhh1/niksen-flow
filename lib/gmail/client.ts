// lib/gmail/client.ts
// Gmail client for the niksen-flow app.
// Label management always goes through project_gmail_labels (DB source of truth).
// Never generates label codes client-side — codes are created by the Edge Function.

export interface GmailMessage {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  fromName: string;
  date: string;
  snippet: string;
  hasAttachments: boolean;
  isRead: boolean;
  body?: string;
}

// ── Token management ───────────────────────────────────────────────

async function refreshTokenIfNeeded(userId: string, supabase: any): Promise<string> {
  const { data: tokenRow } = await supabase
    .from('user_gmail_tokens')
    .select('*')
    .eq('user_id', userId)
    .single();

  if (!tokenRow) throw new Error('Gmail not connected');

  const expiresAt = new Date(tokenRow.token_expires_at).getTime();
  const needsRefresh = Date.now() > expiresAt - 5 * 60 * 1000;

  if (needsRefresh) {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID!,
        client_secret: process.env.GOOGLE_CLIENT_SECRET!,
        refresh_token: tokenRow.refresh_token,
        grant_type: 'refresh_token',
      }),
    });
    const refreshed = await res.json();
    if (!refreshed.error) {
      await supabase
        .from('user_gmail_tokens')
        .update({
          access_token: refreshed.access_token,
          token_expires_at: new Date(Date.now() + refreshed.expires_in * 1000).toISOString(),
        })
        .eq('user_id', userId);
      return refreshed.access_token;
    }
  }

  return tokenRow.access_token;
}

// ── Fetch emails ───────────────────────────────────────────────────

export async function fetchEmails(
  userId: string,
  supabase: any,
  query = 'in:inbox',
  maxResults = 50
): Promise<GmailMessage[]> {
  const token = await refreshTokenIfNeeded(userId, supabase);

  const listRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const list = await listRes.json();
  if (!list.messages?.length) return [];

  const messages = await Promise.all(
    list.messages.map(async (m: { id: string; threadId: string }) => {
      const msgRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      return msgRes.json();
    })
  );

  return messages
    .filter((msg: any) => msg.id)
    .map((msg: any) => {
      const headers: { name: string; value: string }[] = msg.payload?.headers || [];
      const get = (name: string) =>
        headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
      const fromRaw = get('From');
      const fromMatch = fromRaw.match(/^(.+?)\s*<(.+?)>$/);
      return {
        id: msg.id,
        threadId: msg.threadId,
        subject: get('Subject') || '(no subject)',
        from: fromMatch ? fromMatch[2].trim() : fromRaw.trim(),
        fromName: fromMatch
          ? fromMatch[1].trim().replace(/^"|"$/g, '')
          : fromRaw.trim(),
        date: get('Date'),
        snippet: msg.snippet || '',
        hasAttachments: (msg.payload?.parts || []).some(
          (p: any) => p.filename && p.filename.length > 0
        ),
        isRead: !msg.labelIds?.includes('UNREAD'),
      };
    });
}

// ── Fetch email body ───────────────────────────────────────────────

export async function fetchEmailBody(
  messageId: string,
  userId: string,
  supabase: any
): Promise<string> {
  const token = await refreshTokenIfNeeded(userId, supabase);

  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const msg = await res.json();

  const extractBody = (payload: any): string => {
    if (!payload) return '';
    if (payload.body?.data) {
      const base64 = payload.body.data.replace(/-/g, '+').replace(/_/g, '/');
      try { return atob(base64); } catch { return ''; }
    }
    if (payload.parts?.length) {
      const htmlPart = payload.parts.find((p: any) => p.mimeType === 'text/html');
      const textPart = payload.parts.find((p: any) => p.mimeType === 'text/plain');
      const preferred = htmlPart || textPart;
      if (preferred?.body?.data) {
        const base64 = preferred.body.data.replace(/-/g, '+').replace(/_/g, '/');
        try { return atob(base64); } catch { return ''; }
      }
      for (const part of payload.parts) {
        const body = extractBody(part);
        if (body) return body;
      }
    }
    return '';
  };

  return extractBody(msg.payload);
}

// ── Apply project label ────────────────────────────────────────────
// Uses project_gmail_labels as source of truth.
// Never generates label names — always reads from DB.

export async function applyProjectLabel(
  messageId: string,
  projectId: string,
  userId: string,
  supabase: any
): Promise<{ ok: boolean; error?: string }> {
  try {
    const token = await refreshTokenIfNeeded(userId, supabase);

    // Look up the label from DB — single source of truth
    const { data: labelRow } = await supabase
      .from('project_gmail_labels')
      .select('gmail_label_name, label_code')
      .eq('project_id', projectId)
      .is('removed_at', null)
      .maybeSingle();

    if (!labelRow) {
      return { ok: false, error: 'No label found for this project. Create one first via the Gmail addon.' };
    }

    const labelName = labelRow.gmail_label_name;

    // Find label in user's Gmail by code (most reliable) or name
    const labelsRes = await fetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/labels',
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const labelsData = await labelsRes.json();
    const allLabels: any[] = labelsData.labels || [];

    let gmailLabel = labelRow.label_code
      ? allLabels.find(l => l.name.includes(`[${labelRow.label_code}]`))
      : allLabels.find(l => l.name === labelName);

    // Create label hierarchy if it doesn't exist
    if (!gmailLabel) {
      gmailLabel = await createLabelHierarchy(token, labelName);
    }

    if (!gmailLabel?.id) {
      return { ok: false, error: `Could not find or create Gmail label: ${labelName}` };
    }

    // Apply label to message
    const applyRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ addLabelIds: [gmailLabel.id] }),
      }
    );

    if (!applyRes.ok) {
      const err = await applyRes.json();
      return { ok: false, error: err.error?.message || 'Failed to apply label' };
    }

    // Record in project_emails
    await supabase.from('project_emails').upsert({
      project_id: projectId,
      user_id: userId,
      gmail_message_id: messageId,
      gmail_label_applied: true,
      last_synced_at: new Date().toISOString(),
    }, { onConflict: 'project_id,user_id,gmail_message_id' });

    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

// ── Create label hierarchy ─────────────────────────────────────────
// Creates parent/child labels in Gmail. e.g. "Huynh Lawyers/260547 — Smith [ABC12]"

async function createLabelHierarchy(token: string, labelName: string): Promise<any> {
  const parts = labelName.split('/');

  const existingRes = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/labels',
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const existing: any[] = existingRes.ok ? (await existingRes.json()).labels || [] : [];

  let lastLabel: any = null;

  for (let i = 1; i <= parts.length; i++) {
    const partial = parts.slice(0, i).join('/');
    const found = existing.find(l => l.name === partial);
    if (found) { lastLabel = found; continue; }

    const isLeaf = i === parts.length;
    const createRes = await fetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/labels',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: partial,
          labelListVisibility: 'labelShow',
          messageListVisibility: isLeaf ? 'show' : 'hide',
        }),
      }
    );
    if (createRes.ok) {
      lastLabel = await createRes.json();
      existing.push(lastLabel);
    }
  }

  return lastLabel;
}

// ── Send email ─────────────────────────────────────────────────────

export async function sendEmail(
  to: string,
  subject: string,
  body: string,
  threadId: string | undefined,
  userId: string,
  supabase: any
): Promise<void> {
  const token = await refreshTokenIfNeeded(userId, supabase);

  const emailLines = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/html; charset=utf-8',
    '',
    body,
  ];

  const raw = btoa(unescape(encodeURIComponent(emailLines.join('\r\n'))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      raw,
      ...(threadId ? { threadId } : {}),
    }),
  });
}