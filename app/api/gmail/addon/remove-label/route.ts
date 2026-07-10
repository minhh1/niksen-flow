// app/api/gmail/addon/remove-label/route.ts
// Called by Gmail Add-on (admin/source email only) to remove a label from all users.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  const { messageId, accessToken } = body;
  if (!messageId || !accessToken) {
    return NextResponse.json({ error: 'Missing fields' }, { status: 400 });
  }

  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  // Resolve user
  const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo',
    { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!userRes.ok) return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
  const userInfo = await userRes.json();

  const { data: tokenRow } = await db
    .from('user_gmail_tokens').select('user_id').eq('email', userInfo.email).single();
  if (!tokenRow?.user_id) return NextResponse.json({ error: 'User not connected' }, { status: 404 });

  const { data: prof } = await db
    .from('profiles').select('active_company_id').eq('id', tokenRow.user_id).single();
  const companyId = prof?.active_company_id;
  if (!companyId) return NextResponse.json({ error: 'No company' }, { status: 400 });

  // Check admin or source email
  const { data: company } = await db
    .from('companies').select('gmail_source_emails').eq('id', companyId).single();
  const sourceEmails: string[] = company?.gmail_source_emails || [];
  const { data: membership } = await db
    .from('company_memberships').select('role')
    .eq('user_id', tokenRow.user_id).eq('company_id', companyId).single();

  const isAdmin = membership?.role === 'company_admin' || sourceEmails.includes(userInfo.email);
  if (!isAdmin) {
    return NextResponse.json({ error: 'Only admins or source email accounts can remove labels' }, { status: 403 });
  }

  // Find project from project_emails
  const { data: pe } = await db
    .from('project_emails')
    .select('project_id')
    .eq('gmail_message_id', messageId)
    .limit(1)
    .single();

  if (!pe?.project_id) {
    return NextResponse.json({ error: 'Message not assigned to any project' }, { status: 400 });
  }

  const projectId = pe.project_id;

  // Get label name
  const { data: pgl } = await db
    .from('project_gmail_labels')
    .select('gmail_label_name')
    .eq('project_id', projectId)
    .single();

  const gmailLabelName = pgl?.gmail_label_name;
  if (!gmailLabelName) {
    return NextResponse.json({ error: 'No label found for this project' }, { status: 400 });
  }

  // Remove from all connected users' Gmail
  const { data: members } = await db
    .from('company_memberships').select('user_id').eq('company_id', companyId);

  let removedCount = 0;

  for (const m of (members || [])) {
    try {
      const { data: tr } = await db
        .from('user_gmail_tokens')
        .select('access_token, refresh_token, token_expires_at')
        .eq('user_id', m.user_id).single();
      if (!tr) continue;

      let tok = tr.access_token;
      const expired = Date.now() > new Date(tr.token_expires_at).getTime() - 5 * 60 * 1000;
      if (expired) {
        const r = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: process.env.GOOGLE_CLIENT_ID!,
            client_secret: process.env.GOOGLE_CLIENT_SECRET!,
            refresh_token: tr.refresh_token,
            grant_type: 'refresh_token',
          }),
        });
        const ref = await r.json();
        if (!ref.access_token) continue;
        tok = ref.access_token;
      }

      const labelsRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/labels',
        { headers: { Authorization: `Bearer ${tok}` } });
      const labelsData = await labelsRes.json();
      const found = (labelsData.labels || []).find((l: any) => l.name === gmailLabelName);
      if (!found?.id) continue;

      const msgRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}`,
        { headers: { Authorization: `Bearer ${tok}` } });
      if (!msgRes.ok) continue;

      await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ removeLabelIds: [found.id] }),
        }
      );
      removedCount++;
    } catch {}
  }

  // Clean up DB
  await db.from('project_emails').delete()
    .eq('gmail_message_id', messageId).eq('company_id', companyId);
  await db.from('project_gmail_labels').update({ removed_at: new Date().toISOString() })
    .eq('project_id', projectId).eq('company_id', companyId);

  return NextResponse.json({ ok: true, removedFromUsers: removedCount });
}