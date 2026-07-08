// lib/gmail/labelManager.ts

import { supabase } from "@/lib/supabase";
import type { LabelFormat } from "@/lib/gmail/types";

export interface LabelConfig {
  parentLabel: string;
  format: LabelFormat;
  companyId: string;
  companyPrefix: string; // first two words of company name
}

// ── Get or create a Gmail label ────────────────────────────────────
export async function getOrCreateGmailLabel(
  accessToken: string,
  labelName: string
): Promise<string | null> {
  const res = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/labels',
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const data = await res.json();
  const existing = (data.labels || []).find((l: any) => l.name === labelName);
  if (existing) return existing.id;

  const createRes = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/labels',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: labelName,
        labelListVisibility: 'labelShow',
        messageListVisibility: 'show',
      }),
    }
  );
  const created = await createRes.json();
  return created.id || null;
}

// ── Build label name for a project ─────────────────────────────────
// Always produces at least 2 fields after the parent:
//   project_name:    ParentLabel/CompanyPrefix/ProjectName
//   matter_number:   ParentLabel/CompanyPrefix/MatterNumber
//   company_project: ParentLabel/CompanyPrefix/ProjectName/MatterNumber

export async function buildProjectLabelName(
  projectId: string,
  config: LabelConfig
): Promise<string> {
  // Load project name
  const { data: project } = await supabase
    .from('projects')
    .select('name')
    .eq('id', projectId)
    .single();
  const projectName = project?.name || projectId;

  // Load matter number if needed
  let matterNumber = '';
  if (config.format === 'matter_number' || config.format === 'company_project') {
    // Find the matter_number custom field for projects
    const { data: cfv } = await supabase
      .from('company_custom_field_values')
      .select('value_text, field:field_id(label)')
      .eq('record_id', projectId)
      .eq('table_name', 'projects');

    const matterField = (cfv || []).find(
      (v: any) =>
        v.field?.label?.toLowerCase().includes('matter number') ||
        v.field?.label?.toLowerCase().includes('matter_number')
    );
    matterNumber = matterField?.value_text || '';
  }

  const { parentLabel, companyPrefix } = config;

  switch (config.format) {
    case 'project_name':
      // e.g. Shared Emails/Huynh Lawyers/Separation Agreement
      return `${parentLabel}/${companyPrefix}/${projectName}`;

    case 'matter_number':
      // e.g. Shared Emails/Huynh Lawyers/MN-240204
      // Falls back to project name if no matter number
      return `${parentLabel}/${companyPrefix}/${matterNumber || projectName}`;

    case 'company_project':
      // e.g. Shared Emails/Huynh Lawyers/Separation Agreement/MN-240204
      // Falls back to just project name if no matter number
      return matterNumber
        ? `${parentLabel}/${companyPrefix}/${projectName}/${matterNumber}`
        : `${parentLabel}/${companyPrefix}/${projectName}`;
  }
}

// ── Apply label to a message ───────────────────────────────────────
export async function applyLabelToMessage(
  accessToken: string,
  messageId: string,
  labelId: string
): Promise<boolean> {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ addLabelIds: [labelId] }),
    }
  );
  return res.ok;
}

// ── Remove label from a message ────────────────────────────────────
export async function removeLabelFromMessage(
  accessToken: string,
  messageId: string,
  labelId: string
): Promise<boolean> {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ removeLabelIds: [labelId] }),
    }
  );
  return res.ok;
}

// ── Get user's Gmail access token (with auto-refresh) ─────────────
export async function getUserAccessToken(userId: string): Promise<string | null> {
  console.log('getUserAccessToken for userId:', userId);
  const { data, error } = await supabase
    .from('user_gmail_tokens')
    .select('access_token, refresh_token, token_expires_at')
    .eq('user_id', userId)
    .single();

  console.log('token lookup result:', { data: !!data, error });

  if (!data) return null;

  const expiresAt = new Date(data.token_expires_at).getTime();
  if (Date.now() > expiresAt - 5 * 60 * 1000) {
    const refreshRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID!,
        client_secret: process.env.GOOGLE_CLIENT_SECRET!,
        refresh_token: data.refresh_token,
        grant_type: 'refresh_token',
      }),
    });
    const refreshed = await refreshRes.json();
    if (refreshed.access_token) {
      await supabase.from('user_gmail_tokens').update({
        access_token: refreshed.access_token,
        token_expires_at: new Date(
          Date.now() + refreshed.expires_in * 1000
        ).toISOString(),
      }).eq('user_id', userId);
      return refreshed.access_token;
    }
    return null;
  }

  return data.access_token;
}