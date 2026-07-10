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

  // Resolve email from token — try userinfo first, then tokeninfo
  let email: string | null = null;

  const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo',
    { headers: { Authorization: `Bearer ${accessToken}` } });

  if (userRes.ok) {
    const userInfo = await userRes.json();
    email = userInfo.email || null;
  } else {
    // Fallback — tokeninfo works for ScriptApp.getOAuthToken()
    const tokenRes = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?access_token=${accessToken}`
    );
    if (tokenRes.ok) {
      const tokenInfo = await tokenRes.json();
      email = tokenInfo.email || null;
    }
  }

  if (!email) {
    return NextResponse.json({ error: 'Invalid token — could not resolve user email' }, { status: 401 });
  }

  // Find user by email
  let userId: string | null = null;

  const { data: tokenByEmail } = await db
    .from('user_gmail_tokens').select('user_id').eq('email', email).single();
  if (tokenByEmail?.user_id) {
    userId = tokenByEmail.user_id;
  } else {
    // Also try profiles table by email
    const { data: profileByEmail } = await db
      .from('profiles').select('id').eq('email', email).single();
    if (profileByEmail?.id) userId = profileByEmail.id;
  }

  if (!userId) {
    return NextResponse.json(
      { error: `Gmail account ${email} is not connected to Flow. Please connect it in the app first.` },
      { status: 404 }
    );
  }

  const { data: prof } = await db
    .from('profiles').select('active_company_id').eq('id', userId).single();
  if (!prof?.active_company_id) {
    return NextResponse.json({ error: 'No company associated with this account' }, { status: 404 });
  }

  const companyId = prof.active_company_id;

  const { data: company } = await db
    .from('companies')
    .select('gmail_parent_label, gmail_parent_code, gmail_label_tokens, gmail_sublabel_separator, gmail_source_emails')
    .eq('id', companyId)
    .single();

  const { data: membership } = await db
    .from('company_memberships')
    .select('role')
    .eq('user_id', userId)
    .eq('company_id', companyId)
    .single();

  const sourceEmails: string[] = company?.gmail_source_emails || [];
  const isAdmin = membership?.role === 'company_admin' || sourceEmails.includes(email);

  return NextResponse.json({
    parentLabel: company?.gmail_parent_label || '',
    parentCode:  company?.gmail_parent_code  || '',
    tokens:      company?.gmail_label_tokens  || ['matter_number', 'project_name'],
    separator:   company?.gmail_sublabel_separator || ' — ',
    isAdmin,
    email,
  });
}