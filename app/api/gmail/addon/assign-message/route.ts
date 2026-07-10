// app/api/gmail/addon/assign-message/route.ts
// Called by Gmail Add-on to assign an existing project to a message.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  const { messageId, projectId, accessToken } = body;
  if (!messageId || !projectId || !accessToken) {
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

  // Get label name for this project
  const { data: pgl } = await db
    .from('project_gmail_labels')
    .select('gmail_label_name, label_code')
    .eq('project_id', projectId)
    .single();

  const labelName = pgl?.gmail_label_name || null;

  // Save to project_emails
  await db.from('project_emails').upsert({
    user_id: tokenRow.user_id,
    company_id: companyId,
    project_id: projectId,
    gmail_message_id: messageId,
    gmail_label_applied: true,
  }, { onConflict: 'user_id,gmail_message_id' });

  // Log
  await db.from('gmail_sync_log').insert({
    company_id: companyId,
    triggered_by: tokenRow.user_id,
    action: 'label_applied',
    project_id: projectId,
    gmail_message_id: messageId,
    gmail_label_name: labelName,
    target_user_id: tokenRow.user_id,
    details: { source: 'gmail_addon_assign' },
  });

  return NextResponse.json({ ok: true, labelName });
}