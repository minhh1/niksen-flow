// app/api/gmail/addon/label-settings/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export async function GET(req: NextRequest) {
  const accessToken = req.headers.get('X-Gmail-Access-Token');
  if (!accessToken) return NextResponse.json({ error: 'No token' }, { status: 401 });

  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  // Resolve user from Gmail token
  const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo',
    { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!userRes.ok) return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
  const userInfo = await userRes.json();

  // Try to find user by email first, then fall back to sub (Google user ID)
  let userId: string | null = null;

  const { data: tokenByEmail } = await db
    .from('user_gmail_tokens').select('user_id').eq('email', userInfo.email).single();
  if (tokenByEmail?.user_id) {
    userId = tokenByEmail.user_id;
  } else {
    // Fall back — find by any connected token and match via Google user ID
    const { data: tokenBySub } = await db
      .from('user_gmail_tokens').select('user_id').eq('google_user_id', userInfo.id).single();
    if (tokenBySub?.user_id) userId = tokenBySub.user_id;
  }

  if (!userId) {
    console.log('[addon/label-settings] User not found for email:', userInfo.email);
    return NextResponse.json({ error: 'User not connected — please connect Gmail in the app first' }, { status: 404 });
  }

  const tokenRow = { user_id: userId };

  const { data: prof } = await db
    .from('profiles').select('active_company_id').eq('id', userId).single();
  if (!prof?.active_company_id) return NextResponse.json({ error: 'No company' }, { status: 404 });

  const { data: company } = await db
    .from('companies')
    .select('gmail_parent_label, gmail_parent_code, gmail_label_tokens, gmail_sublabel_separator, gmail_source_emails')
    .eq('id', prof.active_company_id)
    .single();

  // Check if user is admin
  const { data: membership } = await db
    .from('company_memberships')
    .select('role')
    .eq('user_id', userId)
    .eq('company_id', prof.active_company_id)
    .single();

  // Check if user is nominated source email (can remove labels)
  const sourceEmails: string[] = company?.gmail_source_emails || [];
  const isSourceEmail = sourceEmails.includes(userInfo.email);
  const isAdmin = membership?.role === 'company_admin' || isSourceEmail;

  return NextResponse.json({
    parentLabel: company?.gmail_parent_label || 'Shared Emails',
    parentCode: company?.gmail_parent_code || '',
    tokens: company?.gmail_label_tokens || ['matter_number', 'project_name'],
    separator: company?.gmail_sublabel_separator || ' — ',
    isAdmin,
  });
}