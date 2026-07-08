// app/api/gmail/sync/route.ts
// Detects labels applied in Gmail and syncs them to other users + the app
import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabaseServer";
import { getUserAccessToken, getOrCreateGmailLabel, applyLabelToMessage } from "@/lib/gmail/labelManager";

export async function POST(req: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: prof } = await supabase
    .from('profiles')
    .select('active_company_id')
    .eq('id', user.id)
    .single();

  const companyId = prof?.active_company_id;
  if (!companyId) return NextResponse.json({ synced: 0 });

  const accessToken = await getUserAccessToken(user.id);
  if (!accessToken) return NextResponse.json({ synced: 0 });

  const { data: company } = await supabase
    .from('companies')
    .select('gmail_parent_label')
    .eq('id', companyId)
    .single();

  const parentLabel = company?.gmail_parent_label || 'Shared Emails';

  // Get all Gmail labels that start with the parent label
  const labelsRes = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/labels',
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const labelsData = await labelsRes.json();
  const projectLabels = (labelsData.labels || []).filter(
    (l: any) => l.name.startsWith(`${parentLabel}/`)
  );

  let synced = 0;
  const logEntries: any[] = [];

  for (const label of projectLabels) {
    const sublabel = label.name.split('/').slice(-1)[0];

    // Find matching project in DB
    const { data: pgl } = await supabase
      .from('project_gmail_labels')
      .select('project_id')
      .eq('company_id', companyId)
      .eq('label_sub', sublabel)
      .single();

    // Also try matching by name directly
    let projectId = pgl?.project_id;
    if (!projectId) {
      const { data: project } = await supabase
        .from('projects')
        .select('id')
        .eq('company_id', companyId)
        .or(`name.ilike.%${sublabel}%`)
        .is('deleted_at', null)
        .limit(1)
        .single();
      projectId = project?.id;
    }

    // Get messages with this label
    const msgsRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=${label.id}&maxResults=50`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const msgsData = await msgsRes.json();
    if (!msgsData.messages?.length) continue;

    for (const msg of msgsData.messages) {
      // Check if this is new (not already in our sync table)
      const { data: existing } = await supabase
        .from('user_gmail_label_sync')
        .select('id')
        .eq('user_id', user.id)
        .eq('gmail_message_id', msg.id)
        .eq('project_id', projectId || '')
        .single();

      if (existing) continue;

      // Get message metadata
      const msgRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const msgData = await msgRes.json();
      const headers = msgData.payload?.headers || [];
      const get = (name: string) =>
        headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

      // Save to project_emails
      const fromRaw = get('From');
      const fromMatch = fromRaw.match(/^(.+?)\s*<(.+?)>$/);

      await supabase.from('project_emails').upsert({
        user_id: user.id,
        company_id: companyId,
        project_id: projectId || null,
        gmail_message_id: msg.id,
        gmail_thread_id: msgData.threadId,
        subject: get('Subject') || '(no subject)',
        from_address: fromMatch ? fromMatch[2].trim() : fromRaw,
        from_name: fromMatch ? fromMatch[1].replace(/^"|"$/g, '').trim() : fromRaw,
        date: get('Date'),
        snippet: msgData.snippet || '',
        gmail_label_applied: true,
      }, { onConflict: 'user_id,gmail_message_id' });

      // Record sync
      await supabase.from('user_gmail_label_sync').upsert({
        company_id: companyId,
        user_id: user.id,
        project_id: projectId || '',
        gmail_message_id: msg.id,
        gmail_label_id: label.id,
        label_applied_at: new Date().toISOString(),
        synced_at: new Date().toISOString(),
      }, { onConflict: 'user_id,project_id,gmail_message_id' });

      logEntries.push({
        company_id: companyId,
        triggered_by: user.id,
        action: 'gmail_label_detected',
        project_id: projectId || null,
        gmail_message_id: msg.id,
        gmail_label_name: label.name,
        target_user_id: user.id,
        details: { sublabel, source: 'gmail_sync', subject: get('Subject') },
      });

      synced++;

      // Now sync to all other company members
      if (projectId) {
        const { data: otherMembers } = await supabase
          .from('company_memberships')
          .select('user_id')
          .eq('company_id', companyId)
          .neq('user_id', user.id);

        for (const member of (otherMembers || [])) {
          const memberToken = await getUserAccessToken(member.user_id);
          if (!memberToken) continue;

          const memberLabelId = await getOrCreateGmailLabel(memberToken, label.name);
          if (!memberLabelId) continue;

          await applyLabelToMessage(memberToken, msg.id, memberLabelId);

          await supabase.from('user_gmail_label_sync').upsert({
            company_id: companyId,
            user_id: member.user_id,
            project_id: projectId,
            gmail_message_id: msg.id,
            gmail_label_id: memberLabelId,
            label_applied_at: new Date().toISOString(),
            synced_at: new Date().toISOString(),
          }, { onConflict: 'user_id,project_id,gmail_message_id' });

          logEntries.push({
            company_id: companyId,
            triggered_by: user.id,
            action: 'sync_to_user',
            project_id: projectId,
            gmail_message_id: msg.id,
            gmail_label_name: label.name,
            target_user_id: member.user_id,
            details: { sublabel, source: 'cross_user_sync' },
          });
        }
      }
    }
  }

  if (logEntries.length > 0) {
    await supabase.from('gmail_sync_log').insert(logEntries);
  }

  return NextResponse.json({ synced, labels: projectLabels.length });
}