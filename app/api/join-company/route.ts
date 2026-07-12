// app/api/join-company/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabaseServer";
import { createClient } from "@supabase/supabase-js";

export async function POST(req: NextRequest) {
  console.log('[join-company] route called');

  let body: any;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  const { token } = body;
  if (!token) return NextResponse.json({ error: 'Token required' }, { status: 400 });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    console.error('[join-company] Missing env vars:', { supabaseUrl: !!supabaseUrl, serviceRoleKey: !!serviceRoleKey });
    return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  // Look up token — include default_team_id
  const { data: tokenData, error: tokenError } = await supabaseAdmin
    .from('registration_tokens')
    .select('id, company_id, used_at, expires_at, default_team_id, company:company_id(id, name)')
    .eq('token', token)
    .single();

  console.log('[join-company] token lookup:', { found: !!tokenData, error: tokenError?.message });

  if (!tokenData) {
    return NextResponse.json({ error: 'Invalid token — not found' }, { status: 400 });
  }
  if (tokenData.used_at) {
    return NextResponse.json({ error: 'This invitation link has already been used' }, { status: 400 });
  }
  if (tokenData.expires_at && new Date(tokenData.expires_at) < new Date()) {
    return NextResponse.json({ error: 'This invitation link has expired' }, { status: 400 });
  }

  const companyId = tokenData.company_id;
  if (!companyId) {
    return NextResponse.json({ error: 'Token has no company associated' }, { status: 400 });
  }

  // Upsert membership as operator
  const { error: memberError } = await supabaseAdmin
    .from('company_memberships')
    .upsert({
      company_id: companyId,
      user_id: user.id,
      role: 'operator',
    }, { onConflict: 'company_id,user_id', ignoreDuplicates: false });

  if (memberError) {
    console.error('[join-company] membership upsert error:', memberError);
    return NextResponse.json({ error: memberError.message }, { status: 500 });
  }

  // Switch active company
  const { error: profileError } = await supabaseAdmin
    .from('profiles')
    .update({ active_company_id: companyId })
    .eq('id', user.id);

  if (profileError) {
    console.error('[join-company] profile update error:', profileError);
    return NextResponse.json({ error: profileError.message }, { status: 500 });
  }

  // Assign to default team if specified on the token
  if (tokenData.default_team_id) {
    const { error: teamError } = await supabaseAdmin
      .from('team_members')
      .upsert({
        team_id: tokenData.default_team_id,
        profile_id: user.id,
      }, { onConflict: 'team_id,profile_id' });
    if (teamError) {
      console.error('[join-company] team assignment error:', teamError.message);
    } else {
      console.log('[join-company] assigned to team', tokenData.default_team_id);
    }
  }

  // Mark token used
  await supabaseAdmin
    .from('registration_tokens')
    .update({ used_at: new Date().toISOString() })
    .eq('id', tokenData.id);

  console.log('[join-company] success — user', user.id, 'joined company', companyId);

  return NextResponse.json({
    ok: true,
    companyId,
    companyName: (tokenData.company as any)?.name || 'Company',
  });
}