// lib/gmail/client.ts

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

async function refreshTokenIfNeeded(
  userId: string,
  supabase: any
): Promise<string> {
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
          token_expires_at: new Date(
            Date.now() + refreshed.expires_in * 1000
          ).toISOString(),
        })
        .eq('user_id', userId);
      return refreshed.access_token;
    }
  }

  return tokenRow.access_token;
}

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
      return Buffer.from(payload.body.data, 'base64url').toString('utf-8');
    }

    if (payload.parts?.length) {
      // Prefer HTML over plain text
      const htmlPart = payload.parts.find((p: any) => p.mimeType === 'text/html');
      const textPart = payload.parts.find((p: any) => p.mimeType === 'text/plain');
      const preferred = htmlPart || textPart;

      if (preferred?.body?.data) {
        return Buffer.from(preferred.body.data, 'base64url').toString('utf-8');
      }

      // Recurse into nested multipart
      for (const part of payload.parts) {
        const body = extractBody(part);
        if (body) return body;
      }
    }

    return '';
  };

  return extractBody(msg.payload);
}

export async function applyProjectLabel(
  threadId: string,
  projectName: string,
  userId: string,
  supabase: any
): Promise<void> {
  const token = await refreshTokenIfNeeded(userId, supabase);
  const labelName = `Shared Labels/${projectName}`;

  // List existing labels
  const labelsRes = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/labels',
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const labelsData = await labelsRes.json();
  let label = labelsData.labels?.find((l: any) => l.name === labelName);

  // Create if it doesn't exist
  if (!label) {
    const createRes = await fetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/labels',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: labelName,
          labelListVisibility: 'labelShow',
          messageListVisibility: 'show',
          color: { backgroundColor: '#4a86e8', textColor: '#ffffff' },
        }),
      }
    );
    label = await createRes.json();
  }

  if (!label?.id) return;

  // Apply label to thread
  await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}/modify`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ addLabelIds: [label.id] }),
    }
  );
}

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

  const raw = Buffer.from(emailLines.join('\r\n'))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      raw,
      ...(threadId ? { threadId } : {}),
    }),
  });
}