// app/api/gmail/assign/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabaseServer";

export async function POST(req: NextRequest) {

  // ── Read body ONCE ─────────────────────────────────────────────
  let body: any;
  try {
    body = await req.json();
  } catch (err) {
    console.error('[assign] Failed to parse body:', err);
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const {
    messageId,
    threadId,
    projectId,
    projectName: gmailLabelName,
    subject,
    from: fromAddr,
    fromName,
    date,
    snippet,
  } = body;

  console.log('[assign] body:', { messageId, projectId, gmailLabelName });

  if (!messageId || !projectId || !gmailLabelName) {
    return NextResponse.json(
      { error: `Missing fields: ${!messageId ? 'messageId ' : ''}${!projectId ? 'projectId ' : ''}${!gmailLabelName ? 'projectName' : ''}`.trim() },
      { status: 400 }
    );
  }

  try {
    const supabase = await createSupabaseServerClient();

    // ── Step 1: get user ───────────────────────────────────────
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    console.log('[assign] Step 1 user:', user?.id, 'error:', userError?.message);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    // ── Step 2: get company ────────────────────────────────────
    const { data: prof, error: profError } = await supabase
      .from('profiles')
      .select('active_company_id')
      .eq('id', user.id)
      .single();
    console.log('[assign] Step 2 company:', prof?.active_company_id, 'error:', profError?.message);
    const companyId = prof?.active_company_id;
    if (!companyId) return NextResponse.json({ error: 'No company' }, { status: 400 });

    // ── Step 3: get Gmail token row directly ───────────────────
    const { data: tokenRow, error: tokenError } = await supabase
      .from('user_gmail_tokens')
      .select('access_token, refresh_token, token_expires_at')
      .eq('user_id', user.id)
      .single();
    console.log('[assign] Step 3 token row found:', !!tokenRow, 'error:', tokenError?.message);

    if (!tokenRow) {
      return NextResponse.json(
        { error: `Gmail not connected — no token row for user ${user.id}` },
        { status: 400 }
      );
    }

    // ── Step 4: refresh token if needed ───────────────────────
    let accessToken = tokenRow.access_token;
    const expiresAt = new Date(tokenRow.token_expires_at).getTime();
    const isExpired = Date.now() > expiresAt - 5 * 60 * 1000;
    console.log('[assign] Step 4 token expires:', new Date(tokenRow.token_expires_at).toISOString(), 'isExpired:', isExpired);

    if (isExpired) {
      console.log('[assign] Refreshing token...');
      const refreshRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: process.env.GOOGLE_CLIENT_ID!,
          client_secret: process.env.GOOGLE_CLIENT_SECRET!,
          refresh_token: tokenRow.refresh_token,
          grant_type: 'refresh_token',
        }),
      });
      const refreshed = await refreshRes.json();
      console.log('[assign] Refresh result:', refreshed.access_token ? 'ok' : refreshed.error);

      if (refreshed.access_token) {
        accessToken = refreshed.access_token;
        await supabase.from('user_gmail_tokens').update({
          access_token: refreshed.access_token,
          token_expires_at: new Date(
            Date.now() + refreshed.expires_in * 1000
          ).toISOString(),
        }).eq('user_id', user.id);
      } else {
        return NextResponse.json(
          { error: `Failed to refresh Gmail token: ${refreshed.error}` },
          { status: 400 }
        );
      }
    }

    console.log('[assign] Step 5 accessToken length:', accessToken?.length);

    // ── Step 5: get existing Gmail labels ──────────────────────
    const labelsRes = await fetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/labels',
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    if (!labelsRes.ok) {
      const err = await labelsRes.json();
      console.error('[assign] Failed to list Gmail labels:', err);
      return NextResponse.json(
        { error: `Failed to list Gmail labels: ${err.error?.message || JSON.stringify(err)}` },
        { status: 400 }
      );
    }

    const labelsData = await labelsRes.json();
    const existingLabels: { id: string; name: string }[] = labelsData.labels || [];
    console.log('[assign] Existing labels count:', existingLabels.length);

    // ── Step 6: create label hierarchy ────────────────────────
    const labelParts = gmailLabelName.split('/');
    console.log('[assign] Creating label hierarchy:', labelParts);
    let createdLabelId: string | null = null;

    for (let i = 1; i <= labelParts.length; i++) {
      const partialName = labelParts.slice(0, i).join('/');
      const existing = existingLabels.find(l => l.name === partialName);

      if (existing) {
        console.log(`[assign] Label already exists: "${partialName}" → ${existing.id}`);
        createdLabelId = existing.id;
        continue;
      }

      console.log(`[assign] Creating label: "${partialName}"`);
      const createRes = await fetch(
        'https://gmail.googleapis.com/gmail/v1/users/me/labels',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name: partialName,
            labelListVisibility: 'labelShow',
            messageListVisibility: i === labelParts.length ? 'show' : 'hide',
          }),
        }
      );

      if (!createRes.ok) {
        const err = await createRes.json();
        console.error(`[assign] Failed to create label "${partialName}":`, err);
        throw new Error(
          `Failed to create Gmail label "${partialName}": ${err.error?.message || JSON.stringify(err)}`
        );
      }

      const created = await createRes.json();
      console.log(`[assign] Created label: "${partialName}" → ${created.id}`);
      createdLabelId = created.id;
      existingLabels.push({ id: created.id, name: partialName });
    }

    if (!createdLabelId) {
      throw new Error('Could not get or create label');
    }

    // ── Step 7: apply label to message ────────────────────────
    console.log('[assign] Applying label', createdLabelId, 'to message', messageId);
    const applyRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ addLabelIds: [createdLabelId] }),
      }
    );

    if (!applyRes.ok) {
      const err = await applyRes.json();
      console.error('[assign] Failed to apply label:', err);
      throw new Error(
        `Failed to apply label: ${err.error?.message || JSON.stringify(err)}`
      );
    }
    console.log('[assign] Label applied successfully');

    const sublabel = labelParts[labelParts.length - 1];

    // ── Step 8: persist to DB ──────────────────────────────────
    const { error: pglError } = await supabase
      .from('project_gmail_labels')
      .upsert({
        company_id: companyId,
        project_id: projectId,
        gmail_label_id: createdLabelId,
        gmail_label_name: gmailLabelName,
        label_sub: sublabel,
        created_by: user.id,
      }, { onConflict: 'company_id,project_id' });
    console.log('[assign] project_gmail_labels upsert error:', pglError?.message);

    const { error: peError } = await supabase
      .from('project_emails')
      .upsert({
        user_id: user.id,
        company_id: companyId,
        project_id: projectId,
        gmail_message_id: messageId,
        gmail_thread_id: threadId || null,
        subject: subject || '(no subject)',
        from_address: fromAddr || '',
        from_name: fromName || '',
        date: date || null,
        snippet: snippet || '',
        gmail_label_applied: true,
      }, { onConflict: 'user_id,gmail_message_id' });
    console.log('[assign] project_emails upsert error:', peError?.message);

    // ── Also write to user_gmail_label_sync for current user ───
    await supabase
      .from('user_gmail_label_sync')
      .upsert({
        company_id: companyId,
        user_id: user.id,
        project_id: projectId,
        gmail_message_id: messageId,
        gmail_label_id: createdLabelId,
        label_applied_at: new Date().toISOString(),
        synced_at: new Date().toISOString(),
      }, { onConflict: 'user_id,project_id,gmail_message_id' });

    // ── Step 9: sync to other company members ──────────────────
    const { data: members } = await supabase
      .from('company_memberships')
      .select('user_id')
      .eq('company_id', companyId)
      .neq('user_id', user.id);

    console.log('[assign] Other members to sync:', members?.length || 0);
    const syncResults: string[] = [];

    for (const member of (members || [])) {
      try {
        const { data: mTokenRow } = await supabase
          .from('user_gmail_tokens')
          .select('access_token, refresh_token, token_expires_at')
          .eq('user_id', member.user_id)
          .single();

        if (!mTokenRow) continue;

        let mAccessToken = mTokenRow.access_token;
        const mExpired = Date.now() > new Date(mTokenRow.token_expires_at).getTime() - 5 * 60 * 1000;

        if (mExpired) {
          const mRefreshRes = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              client_id: process.env.GOOGLE_CLIENT_ID!,
              client_secret: process.env.GOOGLE_CLIENT_SECRET!,
              refresh_token: mTokenRow.refresh_token,
              grant_type: 'refresh_token',
            }),
          });
          const mRefreshed = await mRefreshRes.json();
          if (mRefreshed.access_token) {
            mAccessToken = mRefreshed.access_token;
            await supabase.from('user_gmail_tokens').update({
              access_token: mRefreshed.access_token,
              token_expires_at: new Date(Date.now() + mRefreshed.expires_in * 1000).toISOString(),
            }).eq('user_id', member.user_id);
          } else continue;
        }

        // Get member labels and create hierarchy
        const mLabelsRes = await fetch(
          'https://gmail.googleapis.com/gmail/v1/users/me/labels',
          { headers: { Authorization: `Bearer ${mAccessToken}` } }
        );
        const mLabelsData = await mLabelsRes.json();
        const mExisting: { id: string; name: string }[] = mLabelsData.labels || [];
        let mLabelId: string | null = null;

        for (let i = 1; i <= labelParts.length; i++) {
          const partialName = labelParts.slice(0, i).join('/');
          const found = mExisting.find(l => l.name === partialName);
          if (found) { mLabelId = found.id; continue; }

          const mCreateRes = await fetch(
            'https://gmail.googleapis.com/gmail/v1/users/me/labels',
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${mAccessToken}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                name: partialName,
                labelListVisibility: 'labelShow',
                messageListVisibility: i === labelParts.length ? 'show' : 'hide',
              }),
            }
          );
          if (!mCreateRes.ok) continue;
          const mCreated = await mCreateRes.json();
          mLabelId = mCreated.id;
          mExisting.push({ id: mCreated.id, name: partialName });
        }

        if (!mLabelId) continue;

        await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${mAccessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ addLabelIds: [mLabelId] }),
          }
        );

        // Write sync record for this member
        await supabase
          .from('user_gmail_label_sync')
          .upsert({
            company_id: companyId,
            user_id: member.user_id,
            project_id: projectId,
            gmail_message_id: messageId,
            gmail_label_id: mLabelId,
            label_applied_at: new Date().toISOString(),
            synced_at: new Date().toISOString(),
          }, { onConflict: 'user_id,project_id,gmail_message_id' });

        syncResults.push(member.user_id);
      } catch (memberErr) {
        console.error(`[assign] Failed to sync to member ${member.user_id}:`, memberErr);
      }
    }

    // ── Step 10: log ───────────────────────────────────────────
    await supabase.from('gmail_sync_log').insert({
      company_id: companyId,
      triggered_by: user.id,
      action: 'label_applied',
      project_id: projectId,
      gmail_message_id: messageId,
      gmail_label_name: gmailLabelName,
      target_user_id: user.id,
      details: {
        subject,
        labelId: createdLabelId,
        sublabel,
        syncedToUsers: syncResults.length,
      },
    });

    console.log('[assign] Done. syncedToUsers:', syncResults.length);
    return NextResponse.json({
      ok: true,
      labelName: gmailLabelName,
      labelId: createdLabelId,
      syncedToUsers: syncResults.length,
    });

  } catch (err: any) {
    console.error('[assign] Unhandled error:', err);
    return NextResponse.json(
      { error: err.message || 'Unknown error' },
      { status: 500 }
    );
  }
}