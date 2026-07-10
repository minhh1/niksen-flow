// app/api/gmail/addon/create-project/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  const { messageId, projectName, matterNumber, status, accessToken, userEmail: bodyEmail } = body;

  if (!projectName?.trim()) {
    return NextResponse.json({ error: 'Project name required' }, { status: 400 });
  }

  // adminDb created inside handler — never at module level
  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  // Resolve email
  let gmailEmail: string | null = bodyEmail || null;
  if (!gmailEmail && accessToken) {
    const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo',
      { headers: { Authorization: `Bearer ${accessToken}` } });
    if (userRes.ok) {
      const info = await userRes.json();
      gmailEmail = info.email || null;
    }
  }
  if (!gmailEmail) {
    return NextResponse.json({ error: 'Could not resolve user email' }, { status: 401 });
  }

  // Find userId
  let userId: string | null = null;
  const { data: tr } = await db.from('user_gmail_tokens').select('user_id').eq('email', gmailEmail).single();
  if (tr?.user_id) {
    userId = tr.user_id;
  } else {
    const { data: pr } = await db.from('profiles').select('id').eq('email', gmailEmail).single();
    if (pr?.id) userId = pr.id;
  }
  if (!userId) {
    return NextResponse.json(
      { error: `${gmailEmail} is not connected to Flow. Connect Gmail in the app first.` },
      { status: 404 }
    );
  }

  // Get company
  const { data: prof } = await db.from('profiles').select('active_company_id').eq('id', userId).single();
  const companyId = prof?.active_company_id;
  if (!companyId) return NextResponse.json({ error: 'No company associated' }, { status: 400 });

  // Get label settings from DB
  const { data: company } = await db
    .from('companies')
    .select('gmail_parent_label, gmail_parent_code, gmail_label_tokens, gmail_sublabel_separator')
    .eq('id', companyId)
    .single();

  if (!company?.gmail_parent_label) {
    return NextResponse.json({ error: 'Label settings not configured. Set them in the Flow app first.' }, { status: 400 });
  }

  const parentLabel = company.gmail_parent_label;
  const parentCode  = company.gmail_parent_code || '';
  const parentFull  = parentCode ? `${parentLabel} #${parentCode}` : parentLabel;
  const tokens: string[] = company.gmail_label_tokens || ['matter_number', 'project_name'];
  const separator: string = company.gmail_sublabel_separator || ' — ';

  // Build sublabel from tokens
  const sublabelParts: string[] = [];
  for (const token of tokens) {
    switch (token) {
      case 'project_name':  sublabelParts.push(projectName.trim()); break;
      case 'matter_number': sublabelParts.push(matterNumber?.trim() || ''); break;
      case 'year':          sublabelParts.push(String(new Date().getFullYear())); break;
    }
  }
  const sublabel = sublabelParts.filter(Boolean).join(separator);

  // Generate unique 5-char label code
  const labelCode = Math.random().toString(36).substring(2, 7).toUpperCase();
  const gmailLabelName = `${parentFull}/${sublabel} [${labelCode}]`;

  // Create project
  const { data: project, error: projError } = await db
    .from('projects')
    .insert({
      company_id: companyId,
      name: projectName.trim(),
      status: status || 'Open',
      created_by: userId,
    })
    .select('id')
    .single();

  if (projError || !project) {
    console.error('[addon/create-project] project insert error:', projError?.message);
    return NextResponse.json({ error: projError?.message || 'Failed to create project' }, { status: 500 });
  }

  const projectId = project.id;

  // Save matter number as custom field if provided
  if (matterNumber?.trim()) {
    const { data: matterField } = await db
      .from('company_custom_fields')
      .select('id')
      .eq('company_id', companyId)
      .eq('table_name', 'projects')
      .ilike('label', '%matter%')
      .single();

    if (matterField) {
      await db.from('company_custom_field_values').upsert({
        company_id: companyId,
        record_id: projectId,
        field_id: matterField.id,
        table_name: 'projects',
        value_text: matterNumber.trim(),
      }, { onConflict: 'field_id,record_id' });
    }
  }

  // Save project_gmail_labels WITH label_code
  const { error: pglError } = await db.from('project_gmail_labels').upsert({
    company_id: companyId,
    project_id: projectId,
    gmail_label_name: gmailLabelName,
    label_code: labelCode,
    label_sub: sublabel,
    removed_at: null,
    created_by: userId,
  }, { onConflict: 'company_id,project_id' });

  if (pglError) {
    console.error('[addon/create-project] project_gmail_labels error:', pglError.message);
    // Roll back project
    await db.from('projects').delete().eq('id', projectId);
    return NextResponse.json({ error: pglError.message }, { status: 500 });
  }

  // Save project_emails if email context
  if (messageId) {
    await db.from('project_emails').upsert({
      user_id: userId,
      company_id: companyId,
      project_id: projectId,
      gmail_message_id: messageId,
      gmail_label_applied: true,
    }, { onConflict: 'user_id,gmail_message_id' });

    await db.from('gmail_sync_log').insert({
      company_id: companyId,
      triggered_by: userId,
      action: 'label_applied',
      project_id: projectId,
      gmail_message_id: messageId,
      gmail_label_name: gmailLabelName,
      target_user_id: userId,
      details: { source: 'gmail_addon', projectName, matterNumber, labelCode },
    });
  }

  console.log(`[addon/create-project] ✓ "${projectName}" labelCode=${labelCode} label="${gmailLabelName}"`);

  return NextResponse.json({
    ok: true,
    projectId,
    projectName: projectName.trim(),
    labelName: gmailLabelName,
    labelCode,
  });
}