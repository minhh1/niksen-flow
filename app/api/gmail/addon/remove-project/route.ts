// app/api/gmail/addon/remove-project/route.ts
// Removes a project and its label from all users (admin only).

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  const { messageId, projectId, accessToken, userEmail: bodyEmail } = body;
  if (!projectId) return NextResponse.json({ error: 'Missing projectId' }, { status: 400 });

  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  // Resolve email
  let email: string | null = bodyEmail || null;
  if (!email && accessToken) {
    const r = await fetch('https://www.googleapis.com/oauth2/v2/userinfo',
      { headers: { Authorization: `Bearer ${accessToken}` } });
    if (r.ok) email = (await r.json()).email || null;
  }
  if (!email) return NextResponse.json({ error: 'Could not resolve user' }, { status: 401 });

  // Find userId
  let userId: string | null = null;
  const { data: tr } = await db.from('user_gmail_tokens').select('user_id').eq('email', email).single();
  if (tr?.user_id) userId = tr.user_id;
  else {
    const { data: pr } = await db.from('profiles').select('id').eq('email', email).single();
    if (pr?.id) userId = pr.id;
  }
  if (!userId) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  // Get company
  const { data: prof } = await db.from('profiles').select('active_company_id').eq('id', userId).single();
  const companyId = prof?.active_company_id;
  if (!companyId) return NextResponse.json({ error: 'No company' }, { status: 400 });

  // Check admin
  const { data: membership } = await db
    .from('company_memberships').select('role')
    .eq('user_id', userId).eq('company_id', companyId).single();
  const { data: company } = await db
    .from('companies').select('gmail_source_emails').eq('id', companyId).single();
  const sourceEmails: string[] = company?.gmail_source_emails || [];
  const isAdmin = membership?.role === 'company_admin' || sourceEmails.includes(email);

  if (!isAdmin) {
    return NextResponse.json({ error: 'Only admins can remove projects' }, { status: 403 });
  }

  // Get label info before deleting
  const { data: pgl } = await db
    .from('project_gmail_labels')
    .select('gmail_label_name, label_code')
    .eq('project_id', projectId)
    .single();

  const gmailLabelName = pgl?.gmail_label_name;

  // Remove label from all users' Gmail
  if (gmailLabelName) {
    const { data: members } = await db
      .from('company_memberships').select('user_id').eq('company_id', companyId);

    for (const m of (members || [])) {
      try {
        const { data: t } = await db
          .from('user_gmail_tokens')
          .select('access_token, refresh_token, token_expires_at')
          .eq('user_id', m.user_id).single();
        if (!t) continue;

        let tok = t.access_token;
        const expired = Date.now() > new Date(t.token_expires_at).getTime() - 5 * 60 * 1000;
        if (expired) {
          const rf = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              client_id: process.env.GOOGLE_CLIENT_ID!,
              client_secret: process.env.GOOGLE_CLIENT_SECRET!,
              refresh_token: t.refresh_token,
              grant_type: 'refresh_token',
            }),
          });
          const rfd = await rf.json();
          if (!rfd.access_token) continue;
          tok = rfd.access_token;
        }

        // Get label ID and delete label entirely from Gmail
        const labelsRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/labels',
          { headers: { Authorization: `Bearer ${tok}` } });
        const labelsData = await labelsRes.json();
        const found = (labelsData.labels || []).find((l: any) => l.name === gmailLabelName);
        if (found?.id) {
          await fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/labels/${found.id}`,
            { method: 'DELETE', headers: { Authorization: `Bearer ${tok}` } }
          );
        }
      } catch {}
    }
  }

  const now = new Date().toISOString();

  // Soft delete — set deleted_at, never hard delete
  // Records remain recoverable from the app
  await db.from('projects')
    .update({ deleted_at: now })
    .eq('id', projectId)
    .eq('company_id', companyId);

  await db.from('project_gmail_labels')
    .update({ deleted_at: now, removed_at: now })
    .eq('project_id', projectId);

  await db.from('project_emails')
    .delete()
    .eq('project_id', projectId);

  await db.from('user_gmail_label_sync')
    .update({ label_removed_at: now })
    .eq('project_id', projectId);

  return NextResponse.json({ ok: true });
}