// app/api/gmail/addon/search-projects/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export async function GET(req: NextRequest) {
  const accessToken = req.headers.get('X-Gmail-Access-Token');
  const q = new URL(req.url).searchParams.get('q') || '';
  if (!accessToken) return NextResponse.json({ error: 'No token' }, { status: 401 });

  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  // Resolve email — prefer header, fall back to token
  let email: string | null = req.headers.get('X-User-Email');
  if (!email) {
    const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo',
      { headers: { Authorization: `Bearer ${accessToken}` } });
    if (userRes.ok) email = (await userRes.json()).email || null;
  }
  if (!email) return NextResponse.json({ error: 'Invalid token' }, { status: 401 });

  let userId: string | null = null;
  const { data: tokenRow } = await db
    .from('user_gmail_tokens').select('user_id').eq('email', email).single();
  if (tokenRow?.user_id) {
    userId = userId;
  } else {
    const { data: pr } = await db.from('profiles').select('id').eq('email', email).single();
    if (pr?.id) userId = pr.id;
  }
  if (!userId) return NextResponse.json({ error: 'User not found' }, { status: 404 });
  const tokenRow2 = { user_id: userId };

  const { data: prof } = await db
    .from('profiles').select('active_company_id').eq('id', userId).single();
  if (!prof?.active_company_id) return NextResponse.json({ error: 'No company' }, { status: 404 });

  // Search projects by name or matter number
  const { data: projects } = await db
    .from('projects')
    .select('id, name')
    .eq('company_id', prof.active_company_id)
    .ilike('name', `%${q}%`)
    .limit(10);

  // Get label names for results
  const projectIds = (projects || []).map(p => p.id);
  const { data: labels } = await db
    .from('project_gmail_labels')
    .select('project_id, gmail_label_name')
    .in('project_id', projectIds)
    .is('removed_at', null);

  const labelMap = new Map((labels || []).map(l => [l.project_id, l.gmail_label_name]));

  return NextResponse.json({
    projects: (projects || []).map(p => ({
      id: p.id,
      name: p.name,
      labelName: labelMap.get(p.id) || null,
    })),
  });
}