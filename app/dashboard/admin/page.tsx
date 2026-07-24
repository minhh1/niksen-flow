// app/dashboard/admin/page.tsx
"use client";

import { useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { useCompany } from "@/components/CompanyContext";
import {
  Loader2, Shield, Trash2,
  CheckCircle2, XCircle, Plus, X, Copy, Link, Clock, GripVertical,
} from "lucide-react";
import { useProgressBarWhile } from "@/components/TopProgressBar";
import SourceEmailManager from "@/components/gmail/SourceEmailManager";
import ArchiveSettingsManager from "@/components/gmail/ArchiveSettingsManager";
import AdminTeamsTab from "@/components/admin/AdminTeamsTab";
import AdminDefaultViewsTab from "@/components/admin/AdminDefaultViewsTab";
import AdminVirtualComputersTab from "@/components/admin/AdminVirtualComputersTab";
import AdminGmailSyncTab from "@/components/admin/AdminGmailSyncTab";
import AdminWhatsAppTab from "@/components/admin/AdminWhatsAppTab";
import AdminMsTeamsTab from "@/components/admin/AdminMsTeamsTab";
import AdminOneDriveTab from "@/components/admin/AdminOneDriveTab";
import AdminAiAssistantTab from "@/components/admin/AdminAiAssistantTab";
import AdminPerfTab from "@/components/admin/AdminPerfTab";
import AdminPlatformHealthTab from "@/components/admin/AdminPlatformHealthTab";
import AdminArchiveRequestsTab from "@/components/admin/AdminArchiveRequestsTab";

interface Member {
  id: string;
  full_name: string;
  email: string;
  role: string;
  is_active: boolean;
  is_admin: boolean;
}

interface Company {
  id: string;
  name: string;
  abn: string | null;
  acn: string | null;
  status: string;
  created_at: string;
  project_default_access: 'all_members' | 'specific_teams' | 'specific_members';
}

interface Token {
  id: string;
  token: string;
  note: string | null;
  created_at: string;
  expires_at: string | null;
  used_at: string | null;
}

const ROLE_LABELS: Record<string, string> = {
  company_admin: 'Admin',
  manager: 'Manager',
  operator: 'Operator',
};

// Calendar event title tokens — what each field means, with an example so
// admins don't have to guess what a token renders as. Beyond these two
// built-ins, the available tokens depend on this company's own custom
// fields on projects (e.g. "Matter Number" for a law firm, "Job Reference"
// for a trades company) — fetched at runtime, not hardcoded here.
const CALENDAR_BASE_TOKENS = [
  { id: 'task_name',    label: 'Task Name',    example: 'Follow up with client' },
  { id: 'project_name', label: 'Project Name', example: 'Acme Corp' },
];

interface ProjectCustomField { id: string; field_key: string; label: string; }

const CALENDAR_SEPARATORS = [
  { value: ' — ', label: 'Em dash  ( — )' },
  { value: ' - ', label: 'Hyphen   ( - )' },
  { value: '/',   label: 'Slash    ( / )' },
  { value: ' | ', label: 'Pipe     ( | )' },
  { value: ' ',   label: 'Space' },
];

function parseCalendarFormat(format: string, knownTokenIds: string[]): { tokens: string[]; separator: string } {
  const regex = /\{(\w+)\}/g;
  const tokens: string[] = [];
  const positions: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = regex.exec(format))) {
    tokens.push(m[1]);
    positions.push(m.index);
  }
  let separator = ' — ';
  if (tokens.length >= 2) {
    const firstEnd = format.indexOf('}', positions[0]) + 1;
    separator = format.slice(firstEnd, positions[1]);
  }
  const known = tokens.filter(t => knownTokenIds.includes(t));
  return { tokens: known.length ? known : ['task_name'], separator };
}

function buildCalendarFormat(tokens: string[], separator: string): string {
  return tokens.map(t => `{${t}}`).join(separator);
}

type AdminTab = 'members' | 'teams' | 'views' | 'company' | 'invites' | 'gmail' | 'gmailSync' | 'virtualComputers' | 'whatsapp' | 'msTeams' | 'oneDrive' | 'aiAssistant' | 'perf' | 'platformHealth' | 'archiveRequests';
const ADMIN_TABS: AdminTab[] = ['members', 'teams', 'views', 'company', 'invites', 'gmail', 'gmailSync', 'virtualComputers', 'whatsapp', 'msTeams', 'oneDrive', 'aiAssistant', 'perf', 'platformHealth', 'archiveRequests'];
const ADMIN_TAB_LABELS: Record<AdminTab, string> = {
  members: 'Members', teams: 'Teams', views: 'Default views', invites: 'Invite links',
  gmail: 'Gmail', gmailSync: 'Gmail sync', whatsapp: 'WhatsApp', msTeams: 'Microsoft Teams',
  oneDrive: 'OneDrive',
  aiAssistant: 'AI Assistant', virtualComputers: 'Virtual computers', company: 'Company', perf: 'Performance',
  platformHealth: 'Platform health', archiveRequests: 'Archive requests',
};

export default function AdminPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Which tab is active now lives in the URL — the sidebar's Admin panel
  // links directly to e.g. ?tab=gmailSync, replacing what used to be a
  // horizontal tab bar crammed with 12 items on this page itself.
  const tabParam = searchParams.get('tab');
  const activeTab: AdminTab = (tabParam && ADMIN_TABS.includes(tabParam as AdminTab)) ? (tabParam as AdminTab) : 'members';
  const [loading, setLoading] = useState(true);
  const [unauthorized, setUnauthorized] = useState(false);
  const [company, setCompany] = useState<Company | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [tokens, setTokens] = useState<Token[]>([]);
  const { isSiteAdmin } = useCompany();
  const [saving, setSaving] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // Company edit
  const [companyName, setCompanyName] = useState('');
  const [companyAbn, setCompanyAbn] = useState('');
  const [companyAcn, setCompanyAcn] = useState('');
  const [savingCompany, setSavingCompany] = useState(false);

  // Token generation
  const [newTokenNote, setNewTokenNote] = useState('');
  const [generatingToken, setGeneratingToken] = useState(false);

  // Source of truth emails
  const [sourceEmails, setSourceEmails] = useState<string[]>([]);
  const [connectedEmails, setConnectedEmails] = useState<string[]>([]);

  // Closed-matter archiving
  const [archiveEmails, setArchiveEmails] = useState<string[]>([]);
  const [archiveLabel, setArchiveLabel] = useState('');
  const [autoArchiveOnClose, setAutoArchiveOnClose] = useState(false);

  // Calendar settings
  const [calendarTokens, setCalendarTokens] = useState<string[]>(['matter_number', 'task_name']);
  const [calendarSeparator, setCalendarSeparator] = useState(' — ');
  const [calendarDragIdx, setCalendarDragIdx] = useState<number | null>(null);
  const [calendarDuration, setCalendarDuration] = useState(30);
  const [syncToCompanyCalendar, setSyncToCompanyCalendar] = useState(false);
  const [savingCalendar, setSavingCalendar] = useState(false);
  const [projectCustomFields, setProjectCustomFields] = useState<ProjectCustomField[]>([]);
  const [addingCustomField, setAddingCustomField] = useState(false);
  const [newCustomFieldLabel, setNewCustomFieldLabel] = useState('');
  const [savingNewCustomField, setSavingNewCustomField] = useState(false);

  // Invite token default team
  const [newTokenTeamId, setNewTokenTeamId] = useState<string>('');
  const [allTeams, setAllTeams] = useState<{ id: string; team_name: string }[]>([]);

  useEffect(() => { load(); }, []);
  useProgressBarWhile(loading);

  const load = async () => {
    setLoading(true);

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { router.replace('/login'); return; }

    // Get profile
    const { data: profile } = await supabase
      .from('profiles')
      .select('active_company_id')
      .eq('id', user.id)
      .single();

    if (!profile?.active_company_id) {
      setUnauthorized(true);
      setLoading(false);
      return;
    }

    const companyId = profile.active_company_id;

    // Check admin via membership role (per-company)
    const { data: myMembership } = await supabase
      .from('company_memberships')
      .select('role')
      .eq('user_id', user.id)
      .eq('company_id', companyId)
      .single();

    if (myMembership?.role !== 'company_admin') {
      setUnauthorized(true);
      setLoading(false);
      return;
    }

    // Load company + tokens + this company's own custom fields on projects
    // (calendar sync tokens depend on what this specific company has
    // configured, not a hardcoded list — e.g. a law firm might have
    // "Matter Number" while another company has nothing extra at all).
    const [{ data: comp }, { data: tokenData }, { data: customFieldData }] = await Promise.all([
      supabase.from('companies').select('*').eq('id', companyId).single(),
      supabase
        .from('registration_tokens')
        .select('*')
        .eq('company_id', companyId)
        .order('created_at', { ascending: false }),
      supabase
        .from('company_custom_fields')
        .select('id, field_key, label')
        .eq('company_id', companyId)
        .eq('table_name', 'projects')
        .is('deleted_at', null)
        .order('display_order'),
    ]);
    setProjectCustomFields(customFieldData || []);

    if (comp) {
      setCompany(comp);
      setCompanyName(comp.name);
      setCompanyAbn(comp.abn || '');
      setCompanyAcn(comp.acn || '');
    }
    setTokens(tokenData || []);

    // Load teams for invite default team selector
    const { data: teamsData } = await supabase
      .from('teams')
      .select('id, team_name')
      .eq('is_active', true)
      .order('team_name');
    setAllTeams(teamsData || []);

    // Load source emails from company
    setSourceEmails(comp?.gmail_source_emails || []);
    setArchiveEmails(comp?.gmail_archive_emails || []);
    setArchiveLabel(comp?.gmail_archive_label || '');
    setAutoArchiveOnClose(!!comp?.gmail_auto_archive_on_close);
    const knownTokenIds = [...CALENDAR_BASE_TOKENS.map(t => t.id), ...(customFieldData || []).map(f => f.field_key)];
    const parsedFormat = parseCalendarFormat(comp?.calendar_event_title_format || '{task_name}', knownTokenIds);
    setCalendarTokens(parsedFormat.tokens);
    setCalendarSeparator(parsedFormat.separator);
    setCalendarDuration(comp?.calendar_event_duration_mins || 30);
    setSyncToCompanyCalendar(!!comp?.sync_tasks_to_company_calendar);

    // Members — two separate queries to avoid FK join issues
    const { data: memberships } = await supabase
      .from('company_memberships')
      .select('user_id, role')
      .eq('company_id', companyId);

    if (memberships && memberships.length > 0) {
      const userIds = memberships.map((m: any) => m.user_id);
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, full_name, email, is_active')
        .in('id', userIds);

      // Load connected Gmail emails for source-of-truth / archive pickers.
      // Queries the company_gmail_connections view, not user_gmail_tokens
      // directly — that table's RLS (user_id = auth.uid()) only ever
      // returns your own row, so this is the only way to see who else in
      // the company is connected without exposing anyone's OAuth tokens.
      const { data: gmailTokens } = await supabase
        .from('company_gmail_connections')
        .select('email');
      setConnectedEmails((gmailTokens || []).map((t: any) => t.email).filter(Boolean));

      setMembers(memberships.map((m: any) => {
        const prof = profiles?.find((p: any) => p.id === m.user_id);
        return {
          id: m.user_id,
          full_name: prof?.full_name || '',
          email: prof?.email || '',
          role: m.role || 'operator',
          is_active: prof?.is_active ?? true,
          is_admin: m.role === 'company_admin',
        };
      }));
    } else {
      setMembers([]);
    }

    setLoading(false);
  };

  const handleToggleAdmin = async (member: Member) => {
    setSaving(member.id);
    const newIsAdmin = !member.is_admin;
    await supabase.from('company_memberships')
      .update({ role: (newIsAdmin ? 'company_admin' : 'operator') as any })
      .eq('user_id', member.id)
      .eq('company_id', company!.id);
    setMembers(prev => prev.map(m =>
      m.id === member.id
        ? { ...m, is_admin: newIsAdmin, role: newIsAdmin ? 'company_admin' : 'operator' }
        : m
    ));
    setSaving(null);
  };

  const handleToggleActive = async (member: Member) => {
    setSaving(member.id);
    await supabase.from('profiles')
      .update({ is_active: !member.is_active })
      .eq('id', member.id);
    setMembers(prev => prev.map(m =>
      m.id === member.id ? { ...m, is_active: !m.is_active } : m
    ));
    setSaving(null);
  };

  const handleRemoveMember = async (member: Member) => {
    if (!window.confirm(`Remove ${member.full_name || member.email} from this company?`)) return;
    setSaving(member.id);
    await supabase.from('company_memberships')
      .delete()
      .eq('user_id', member.id)
      .eq('company_id', company!.id);
    setMembers(prev => prev.filter(m => m.id !== member.id));
    setSaving(null);
  };

  const handleSaveCompany = async () => {
    if (!company) return;
    setSavingCompany(true);
    await supabase.from('companies').update({
      name: companyName,
      abn: companyAbn || null,
      acn: companyAcn || null,
    }).eq('id', company.id);
    setCompany(prev => prev ? { ...prev, name: companyName } : prev);
    setSavingCompany(false);
  };

  const handleSaveCalendar = async () => {
    if (!company) return;
    setSavingCalendar(true);
    await supabase.from('companies').update({
      calendar_event_title_format: buildCalendarFormat(calendarTokens, calendarSeparator),
      calendar_event_duration_mins: calendarDuration,
      sync_tasks_to_company_calendar: syncToCompanyCalendar,
    }).eq('id', company.id);
    setSavingCalendar(false);
  };

  // Lets an admin whose company doesn't have a relevant custom field yet
  // (e.g. no "Matter Number" equivalent) create one on the spot, so it's
  // immediately available as a calendar title token — instead of being
  // stuck with only the fixed Task Name / Project Name tokens.
  const handleAddCustomField = async () => {
    if (!company || !newCustomFieldLabel.trim()) return;
    setSavingNewCustomField(true);
    const field_key = `field_${Date.now()}`;
    const { data, error } = await supabase
      .from('company_custom_fields')
      .insert({
        company_id: company.id,
        table_name: 'projects',
        field_key,
        label: newCustomFieldLabel.trim(),
        field_type: 'text',
        display_order: projectCustomFields.length,
        show_in_table: false,
        is_required: false,
      })
      .select('id, field_key, label')
      .single();
    setSavingNewCustomField(false);
    if (error || !data) return;
    setProjectCustomFields(prev => [...prev, data]);
    setCalendarTokens(prev => [...prev, data.field_key]);
    setNewCustomFieldLabel('');
    setAddingCustomField(false);
  };

  const handleSourceEmailsChange = async (emails: string[]) => {
    setSourceEmails(emails);
    if (!company) return;
    await supabase
      .from('companies')
      .update({ gmail_source_emails: emails })
      .eq('id', company.id);
  };

  const handleArchiveSettingsChange = async (next: {
    archiveEmails?: string[]; archiveLabel?: string; autoArchiveOnClose?: boolean;
  }) => {
    if (!company) return;
    const update: Record<string, unknown> = {};
    if (next.archiveEmails !== undefined) { setArchiveEmails(next.archiveEmails); update.gmail_archive_emails = next.archiveEmails; }
    if (next.archiveLabel !== undefined) { setArchiveLabel(next.archiveLabel); update.gmail_archive_label = next.archiveLabel || null; }
    if (next.autoArchiveOnClose !== undefined) { setAutoArchiveOnClose(next.autoArchiveOnClose); update.gmail_auto_archive_on_close = next.autoArchiveOnClose; }
    await supabase.from('companies').update(update).eq('id', company.id);
  };

  const handleGenerateToken = async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user || !company) return;
    setGeneratingToken(true);
    const { data } = await supabase
      .from('registration_tokens')
      .insert({
        created_by: user.id,
        company_id: company.id,
        note: newTokenNote.trim() || null,
        default_team_id: newTokenTeamId || null,
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      })
      .select()
      .single();
    setNewTokenNote('');
    setNewTokenTeamId('');
    setGeneratingToken(false);
    if (data) setTokens(prev => [data, ...prev]);
  };

  const handleAssignTeam = async (memberId: string, teamId: string | null) => {
    if (teamId) {
      await supabase.from('team_members').upsert(
        { team_id: teamId, profile_id: memberId },
        { onConflict: 'team_id,profile_id' }
      );
    } else {
      // Remove from all teams
      await supabase.from('team_members').delete().eq('profile_id', memberId);
    }
  };

  const handleRevokeToken = async (tokenId: string) => {
    await supabase.from('registration_tokens')
      .update({ used_at: new Date().toISOString() })
      .eq('id', tokenId);
    setTokens(prev => prev.map(t =>
      t.id === tokenId ? { ...t, used_at: new Date().toISOString() } : t
    ));
  };

  const getRegistrationLink = (token: string) =>
    `${window.location.origin}/login?token=${token}`;

  const handleCopy = (token: string) => {
    navigator.clipboard.writeText(getRegistrationLink(token));
    setCopied(token);
    setTimeout(() => setCopied(null), 2000);
  };

  // ── Loading / unauthorized ─────────────────────────────────────

  if (loading) return null;

  if (unauthorized) return (
    <div className="flex flex-col items-center justify-center h-screen gap-3">
      <Shield size={32} className="text-slate-200" />
      <p className="text-slate-400 font-bold text-[11px] uppercase tracking-widest">
        Admin access required
      </p>
      <button
        onClick={() => router.back()}
        className="text-[11px] text-indigo-600 font-bold hover:underline"
      >
        Go back
      </button>
    </div>
  );

  // Tokens available for the calendar title format: the two universal ones
  // plus whatever custom fields this company has configured on projects.
  const calendarTokenDefs = [
    ...CALENDAR_BASE_TOKENS,
    ...projectCustomFields.map(f => ({ id: f.field_key, label: f.label, example: 'Custom value' })),
  ];

  return (
    <div className="flex flex-col h-screen bg-[#F9FAFB] font-sans antialiased text-slate-600 overflow-hidden">

      {/* Header — the tab bar that used to live here moved to the sidebar's
          Admin panel; 12 tabs in a horizontal row was getting too crowded. */}
      <header className="bg-white border-b border-slate-100 shrink-0 px-8 py-8">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-2xl bg-amber-50 flex items-center justify-center">
            <Shield size={18} className="text-amber-600" />
          </div>
          <div>
            <h1 className="text-2xl font-light uppercase tracking-tight text-slate-900">
              Admin
            </h1>
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
              {company?.name} · {ADMIN_TAB_LABELS[activeTab]}
            </p>
          </div>
        </div>
      </header>

      {/* Main */}
      <main className="flex-1 overflow-y-auto p-8">
        <div className="max-w-3xl mx-auto space-y-4">

          {/* ── Members ── */}
          {activeTab === 'members' && (
            <>
              <div className="flex items-center justify-between mb-2">
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                  {members.length} member{members.length !== 1 ? 's' : ''}
                </p>
                <button
                  onClick={() => router.push('/dashboard/admin?tab=invites')}
                  className="flex items-center gap-2 px-4 py-2 bg-amber-600 text-white rounded-full text-[10px] font-bold hover:bg-amber-700 transition-all"
                >
                  <Plus size={12} /> Invite member
                </button>
              </div>

              {members.length === 0 ? (
                <p className="text-center text-slate-300 text-[11px] uppercase font-bold tracking-widest py-16">
                  No members yet
                </p>
              ) : (
                members.map(member => (
                  <div
                    key={member.id}
                    className={`bg-white border rounded-[28px] p-5 flex items-center gap-4 ${
                      member.is_active ? 'border-slate-100' : 'border-slate-100 opacity-50'
                    }`}
                  >
                    <div className="h-10 w-10 rounded-full bg-slate-100 flex items-center justify-center text-[12px] font-bold text-slate-600 uppercase shrink-0">
                      {(member.full_name || member.email).substring(0, 2)}
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-[13px] font-bold text-slate-800 truncate">
                          {member.full_name || '—'}
                        </p>
                        <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold uppercase ${
                          member.role === 'company_admin'
                            ? 'bg-amber-100 text-amber-700'
                            : member.role === 'manager'
                            ? 'bg-indigo-100 text-indigo-700'
                            : 'bg-slate-100 text-slate-500'
                        }`}>
                          {ROLE_LABELS[member.role] || member.role}
                        </span>
                        {!member.is_active && (
                          <span className="px-2 py-0.5 rounded-full text-[9px] font-bold uppercase bg-red-100 text-red-500">
                            Inactive
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-slate-400 truncate mt-0.5">
                        {member.email}
                      </p>
                      {allTeams.length > 0 && (
                        <select
                          onChange={e => handleAssignTeam(member.id, e.target.value || null)}
                          className="mt-1.5 text-[11px] text-slate-500 border border-slate-200 rounded-full px-3 py-1 outline-none bg-white hover:border-indigo-300 cursor-pointer"
                          defaultValue=""
                        >
                          <option value="">Assign to team...</option>
                          {allTeams.map(t => (
                            <option key={t.id} value={t.id}>{t.team_name}</option>
                          ))}
                        </select>
                      )}
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      {saving === member.id ? (
                        <Loader2 size={16} className="animate-spin text-slate-300" />
                      ) : (
                        <>
                          <button
                            onClick={() => handleToggleAdmin(member)}
                            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[10px] font-bold transition-all ${
                              member.is_admin
                                ? 'bg-amber-50 text-amber-700 hover:bg-amber-100'
                                : 'bg-slate-50 text-slate-500 hover:bg-amber-50 hover:text-amber-600'
                            }`}
                          >
                            <Shield size={11} />
                            {member.is_admin ? 'Admin' : 'Make admin'}
                          </button>
                          <button
                            onClick={() => handleToggleActive(member)}
                            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[10px] font-bold transition-all ${
                              member.is_active
                                ? 'bg-slate-50 text-slate-500 hover:bg-red-50 hover:text-red-500'
                                : 'bg-emerald-50 text-emerald-600 hover:bg-emerald-100'
                            }`}
                          >
                            {member.is_active
                              ? <><XCircle size={11} /> Deactivate</>
                              : <><CheckCircle2 size={11} /> Activate</>
                            }
                          </button>
                          <button
                            onClick={() => handleRemoveMember(member)}
                            className="p-1.5 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-full transition-all"
                          >
                            <Trash2 size={14} />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ))
              )}
            </>
          )}

          {/* ── Invite links ── */}
          {activeTab === 'invites' && (
            <>
              <div className="bg-white border border-slate-200 rounded-[32px] p-6 space-y-4">
                <div>
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">
                    Generate invitation link
                  </p>
                  <p className="text-[12px] text-slate-500">
                    Share this link with a new team member. Each link can only be used once and
                    expires in 7 days. Invited users join as Operator — promote them to Admin after they join.
                  </p>
                </div>
                <div className="flex gap-3">
                  <input
                    value={newTokenNote}
                    onChange={e => setNewTokenNote(e.target.value)}
                    placeholder="Note e.g. 'For John Smith onboarding'"
                    className="flex-1 bg-slate-50 border border-slate-200 rounded-full px-4 py-2.5 text-[13px] font-medium outline-none focus:ring-2 focus:ring-indigo-100"
                    onKeyDown={e => { if (e.key === 'Enter') handleGenerateToken(); }}
                  />
                  <button
                    onClick={handleGenerateToken}
                    disabled={generatingToken}
                    className="flex items-center gap-2 px-5 py-2.5 bg-slate-900 text-white rounded-full text-[11px] font-bold disabled:opacity-50 shrink-0"
                  >
                    {generatingToken
                      ? <Loader2 size={12} className="animate-spin" />
                      : <Plus size={12} />
                    }
                    Generate
                  </button>
                </div>
                {allTeams.length > 0 && (
                  <div>
                    <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-2">
                      Assign to team on join <span className="font-normal text-slate-300">(optional)</span>
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={() => setNewTokenTeamId('')}
                        className={`px-3 py-1.5 rounded-full text-[11px] font-medium border transition-all ${
                          !newTokenTeamId ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-500 border-slate-200 hover:border-slate-400'
                        }`}
                      >
                        No team
                      </button>
                      {allTeams.map(t => (
                        <button
                          key={t.id}
                          onClick={() => setNewTokenTeamId(t.id)}
                          className={`px-3 py-1.5 rounded-full text-[11px] font-medium border transition-all ${
                            newTokenTeamId === t.id ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-slate-500 border-slate-200 hover:border-indigo-300'
                          }`}
                        >
                          {t.team_name}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {tokens.length === 0 ? (
                <p className="text-center text-slate-300 text-[11px] uppercase font-bold tracking-widest py-10">
                  No invitation links generated yet
                </p>
              ) : (
                tokens.map(token => {
                  const isUsed = !!token.used_at;
                  const isExpired = token.expires_at
                    ? new Date(token.expires_at) < new Date()
                    : false;
                  const isActive = !isUsed && !isExpired;
                  const link = getRegistrationLink(token.token);

                  return (
                    <div
                      key={token.id}
                      className={`bg-white border rounded-[28px] p-5 flex items-start gap-4 ${
                        isActive ? 'border-emerald-100' : 'border-slate-100 opacity-60'
                      }`}
                    >
                      <div className={`p-2.5 rounded-2xl shrink-0 ${
                        isActive ? 'bg-emerald-50' : 'bg-slate-50'
                      }`}>
                        <Link size={16} className={isActive ? 'text-emerald-600' : 'text-slate-400'} />
                      </div>

                      <div className="flex-1 min-w-0">
                        {token.note && (
                          <p className="text-[13px] font-bold text-slate-700 mb-1">{token.note}</p>
                        )}
                        {(token as any).default_team_id && (
                          <p className="text-[10px] text-indigo-500 font-medium mb-1">
                            Team: {allTeams.find(t => t.id === (token as any).default_team_id)?.team_name || 'Unknown'}
                          </p>
                        )}
                        <p className="text-[10px] font-mono text-slate-400 truncate">{link}</p>
                        <div className="flex items-center gap-3 mt-2 flex-wrap">
                          {isUsed ? (
                            <span className="flex items-center gap-1 text-[9px] font-bold uppercase text-slate-400">
                              <CheckCircle2 size={10} /> Used
                            </span>
                          ) : isExpired ? (
                            <span className="flex items-center gap-1 text-[9px] font-bold uppercase text-red-400">
                              <Clock size={10} /> Expired
                            </span>
                          ) : (
                            <span className="flex items-center gap-1 text-[9px] font-bold uppercase text-emerald-600">
                              <CheckCircle2 size={10} />
                              Expires {token.expires_at
                                ? new Date(token.expires_at).toLocaleDateString('en-AU')
                                : 'never'}
                            </span>
                          )}
                          <span className="text-[9px] text-slate-300">
                            Created {new Date(token.created_at).toLocaleDateString('en-AU')}
                          </span>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        {isActive && (
                          <button
                            onClick={() => handleCopy(token.token)}
                            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[10px] font-bold transition-all ${
                              copied === token.token
                                ? 'bg-emerald-50 text-emerald-600'
                                : 'bg-slate-50 text-slate-600 hover:bg-indigo-50 hover:text-indigo-600'
                            }`}
                          >
                            {copied === token.token
                              ? <CheckCircle2 size={11} />
                              : <Copy size={11} />
                            }
                            {copied === token.token ? 'Copied!' : 'Copy link'}
                          </button>
                        )}
                        {isActive && (
                          <button
                            onClick={() => handleRevokeToken(token.id)}
                            className="p-1.5 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-full transition-all"
                            title="Revoke"
                          >
                            <X size={14} />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </>
          )}

          {/* ── Teams ── */}
          {activeTab === 'teams' && company?.id && (
            <AdminTeamsTab companyId={company.id} />
          )}

          {/* ── Default views ── */}
          {activeTab === 'views' && company?.id && (
            <AdminDefaultViewsTab companyId={company.id} />
          )}

          {/* ── Gmail source of truth ── */}
          {activeTab === 'gmail' && (
            <div className="bg-white border border-slate-200 rounded-[40px] p-8">
              <SourceEmailManager
                sourceEmails={sourceEmails}
                connectedEmails={connectedEmails}
                onChange={handleSourceEmailsChange}
              />
              <ArchiveSettingsManager
                archiveEmails={archiveEmails}
                archiveLabel={archiveLabel}
                archiveLabelPlaceholder={`${company?.name || 'Company'} Archive`}
                autoArchiveOnClose={autoArchiveOnClose}
                connectedEmails={connectedEmails}
                onChange={handleArchiveSettingsChange}
              />
            </div>
          )}

          {/* ── Gmail sync activity & health ── */}
          {activeTab === 'gmailSync' && company?.id && (
            <AdminGmailSyncTab companyId={company.id} />
          )}

          {/* ── WhatsApp ── */}
          {activeTab === 'whatsapp' && company?.id && (
            <AdminWhatsAppTab companyId={company.id} />
          )}

          {/* ── Microsoft Teams ── */}
          {activeTab === 'msTeams' && company?.id && (
            <AdminMsTeamsTab companyId={company.id} />
          )}

          {/* ── OneDrive / SharePoint ── */}
          {activeTab === 'oneDrive' && company?.id && (
            <AdminOneDriveTab companyId={company.id} />
          )}

          {/* ── AI Assistant ── */}
          {activeTab === 'aiAssistant' && company?.id && (
            <AdminAiAssistantTab companyId={company.id} />
          )}

          {/* ── Performance (internal — site-admin only) ── */}
          {activeTab === 'perf' && isSiteAdmin && (
            <AdminPerfTab />
          )}

          {/* ── Platform health (site-admin only) ── */}
          {activeTab === 'platformHealth' && isSiteAdmin && (
            <AdminPlatformHealthTab />
          )}

          {/* ── Archive requests ── */}
          {activeTab === 'archiveRequests' && company?.id && (
            <AdminArchiveRequestsTab companyId={company.id} />
          )}

          {/* ── Virtual computers ── */}
          {activeTab === 'virtualComputers' && company?.id && (
            <AdminVirtualComputersTab companyId={company.id} />
          )}

          {/* ── Team access defaults ── */}
          {activeTab === 'company' && (
            <div className="bg-white border border-slate-200 rounded-[40px] p-8 mb-4">
              <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-4">
                Default project access
              </p>
              <p className="text-[11px] text-slate-500 mb-4">
                When a new project is created, who can see it by default?
              </p>
              <div className="space-y-2">
                {([
                  { value: 'all_members',      label: 'All company members' },
                  { value: 'specific_teams',   label: 'Specific teams only' },
                  { value: 'specific_members', label: 'Specific members only' },
                ] as { value: string; label: string }[]).map(opt => (
                  <button
                    key={opt.value}
                    onClick={async () => {
                      if (!company) return;
                      await supabase.from('companies')
                        .update({ project_default_access: opt.value })
                        .eq('id', company.id);
                      setCompany({ ...company, project_default_access: opt.value as Company["project_default_access"] });
                    }}
                    className={`w-full flex items-center gap-3 px-4 py-3 rounded-2xl border text-left transition-all ${
                      company?.project_default_access === opt.value
                        ? 'bg-indigo-50 border-indigo-200'
                        : 'bg-white border-slate-200 hover:border-slate-300'
                    }`}
                  >
                    <div className={`w-4 h-4 rounded-full border-2 shrink-0 flex items-center justify-center ${
                      company?.project_default_access === opt.value ? 'border-indigo-500' : 'border-slate-300'
                    }`}>
                      {company?.project_default_access === opt.value && (
                        <div className="w-2 h-2 rounded-full bg-indigo-500" />
                      )}
                    </div>
                    <span className={`text-[12px] font-bold ${
                      company?.project_default_access === opt.value ? 'text-indigo-800' : 'text-slate-700'
                    }`}>{opt.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* ── Company settings ── */}
          {activeTab === 'company' && (
            <div className="bg-white border border-slate-200 rounded-[40px] p-8 space-y-5">
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                Company details
              </p>

              <div>
                <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block mb-1.5">
                  Company name
                </label>
                <input
                  value={companyName}
                  onChange={e => setCompanyName(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-full py-3 px-5 text-sm font-medium outline-none focus:ring-4 focus:ring-indigo-100"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block mb-1.5">
                    ABN
                  </label>
                  <input
                    value={companyAbn}
                    onChange={e => setCompanyAbn(e.target.value)}
                    placeholder="Optional"
                    className="w-full bg-slate-50 border border-slate-200 rounded-full py-3 px-5 text-sm font-medium outline-none focus:ring-4 focus:ring-indigo-100"
                  />
                </div>
                <div>
                  <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block mb-1.5">
                    ACN
                  </label>
                  <input
                    value={companyAcn}
                    onChange={e => setCompanyAcn(e.target.value)}
                    placeholder="Optional"
                    className="w-full bg-slate-50 border border-slate-200 rounded-full py-3 px-5 text-sm font-medium outline-none focus:ring-4 focus:ring-indigo-100"
                  />
                </div>
              </div>

              <button
                onClick={handleSaveCompany}
                disabled={savingCompany}
                className="w-full py-3.5 bg-slate-900 text-white rounded-full text-[11px] font-bold uppercase tracking-widest disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {savingCompany ? <Loader2 size={14} className="animate-spin" /> : 'Save changes'}
              </button>

              {/* ── Calendar settings ── */}
              <div className="pt-6 border-t border-slate-100 space-y-4">
                <p className="text-[11px] font-bold text-slate-700 uppercase tracking-widest">Calendar sync</p>
                <p className="text-[11px] text-slate-400">
                  Events are created on the assignee's own Google Calendar. Optionally also add a copy to the nominated source email's calendar below.
                </p>

                <div className="space-y-3">
                  <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block">
                    Event title format
                  </label>
                  <p className="text-[11px] text-slate-400">
                    Drag to reorder. Fields are joined with the separator below to build each event's title.
                  </p>

                  {/* Active tokens */}
                  <div className="space-y-1.5">
                    {calendarTokens.map((id, idx) => {
                      const tok = calendarTokenDefs.find(t => t.id === id);
                      return (
                        <div
                          key={id}
                          draggable
                          onDragStart={() => setCalendarDragIdx(idx)}
                          onDragOver={e => e.preventDefault()}
                          onDrop={() => {
                            if (calendarDragIdx === null || calendarDragIdx === idx) return;
                            const next = [...calendarTokens];
                            const [moved] = next.splice(calendarDragIdx, 1);
                            next.splice(idx, 0, moved);
                            setCalendarTokens(next);
                            setCalendarDragIdx(null);
                          }}
                          className="flex items-center gap-3 px-4 py-2.5 bg-indigo-50 border border-indigo-100 rounded-2xl cursor-grab active:cursor-grabbing"
                        >
                          <GripVertical size={14} className="text-indigo-300 shrink-0" />
                          <div className="flex-1">
                            <p className="text-[12px] font-bold text-indigo-800">{tok?.label || id}</p>
                            <p className="text-[10px] text-indigo-400">e.g. {tok?.example}</p>
                          </div>
                          <button
                            onClick={() => setCalendarTokens(prev => prev.filter(t => t !== id))}
                            className="text-indigo-300 hover:text-red-500 transition-colors"
                          >
                            <X size={13} />
                          </button>
                        </div>
                      );
                    })}
                  </div>

                  {/* Add tokens */}
                  <div className="flex flex-wrap gap-2">
                    {calendarTokenDefs.filter(t => !calendarTokens.includes(t.id)).map(tok => (
                      <button
                        key={tok.id}
                        onClick={() => setCalendarTokens(prev => [...prev, tok.id])}
                        className="flex items-center gap-1.5 px-3 py-1.5 border border-dashed border-slate-300 rounded-full text-[11px] text-slate-500 hover:border-indigo-400 hover:text-indigo-600 hover:bg-indigo-50 transition-all"
                      >
                        + {tok.label}
                      </button>
                    ))}
                    {!addingCustomField && (
                      <button
                        onClick={() => setAddingCustomField(true)}
                        className="flex items-center gap-1.5 px-3 py-1.5 border border-dashed border-indigo-300 rounded-full text-[11px] text-indigo-600 hover:bg-indigo-50 transition-all"
                      >
                        <Plus size={12} /> Add custom field
                      </button>
                    )}
                  </div>

                  {/* Inline "add custom field" — for when this company doesn't
                      have the reference field it wants to sync yet (e.g. a
                      matter number, job reference, PO number...). */}
                  {addingCustomField && (
                    <div className="flex items-center gap-2 px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-2xl">
                      <input
                        autoFocus
                        value={newCustomFieldLabel}
                        onChange={e => setNewCustomFieldLabel(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') handleAddCustomField(); if (e.key === 'Escape') setAddingCustomField(false); }}
                        placeholder="Field name, e.g. Job Reference"
                        className="flex-1 bg-white border border-slate-200 rounded-full py-2 px-4 text-[12px] outline-none focus:ring-4 focus:ring-indigo-100"
                      />
                      <button
                        onClick={handleAddCustomField}
                        disabled={savingNewCustomField || !newCustomFieldLabel.trim()}
                        className="px-4 py-2 bg-indigo-600 text-white text-[11px] font-bold rounded-full disabled:opacity-40"
                      >
                        {savingNewCustomField ? <Loader2 size={12} className="animate-spin" /> : 'Add'}
                      </button>
                      <button
                        onClick={() => { setAddingCustomField(false); setNewCustomFieldLabel(''); }}
                        className="p-2 text-slate-300 hover:text-slate-600"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  )}

                  {/* Separator */}
                  <div className="pt-1">
                    <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block mb-1.5">
                      Separator between fields
                    </label>
                    <div className="flex flex-wrap gap-2">
                      {CALENDAR_SEPARATORS.map(s => (
                        <button
                          key={s.value}
                          onClick={() => setCalendarSeparator(s.value)}
                          className={`px-3 py-1.5 rounded-full text-[11px] font-mono border transition-all ${
                            calendarSeparator === s.value
                              ? 'bg-indigo-600 text-white border-indigo-600'
                              : 'bg-white text-slate-500 border-slate-200 hover:border-indigo-300'
                          }`}
                        >
                          {s.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Live preview */}
                  <div className="px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl">
                    <p className="text-[10px] text-slate-400 mb-1">Preview</p>
                    <p className="text-[12px] text-slate-700 font-medium">
                      {calendarTokens.length
                        ? calendarTokens
                            .map(id => calendarTokenDefs.find(t => t.id === id)?.example || id)
                            .join(calendarSeparator)
                        : '—'}
                    </p>
                  </div>
                </div>
                <div>
                  <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block mb-1.5">
                    Default event duration (minutes)
                  </label>
                  <div className="flex items-center gap-3">
                    {[15, 30, 60, 90, 120].map(d => (
                      <button
                        key={d}
                        onClick={() => setCalendarDuration(d)}
                        className={`px-4 py-2 rounded-full text-[11px] font-bold border transition-colors ${
                          calendarDuration === d
                            ? 'bg-indigo-600 text-white border-indigo-600'
                            : 'bg-white text-slate-500 border-slate-200 hover:border-indigo-300'
                        }`}
                      >
                        {d}m
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="flex items-center gap-3 cursor-pointer">
                    <div onClick={() => setSyncToCompanyCalendar(v => !v)}
                      className={`w-10 h-6 rounded-full transition-colors shrink-0 ${syncToCompanyCalendar ? 'bg-indigo-600' : 'bg-slate-200'} ${sourceEmails.length ? '' : 'opacity-40 pointer-events-none'}`}>
                      <div className={`w-5 h-5 bg-white rounded-full shadow mt-0.5 transition-transform ${syncToCompanyCalendar ? 'translate-x-4' : 'translate-x-0.5'}`} />
                    </div>
                    <span className="text-[12px] text-slate-700 font-medium">
                      Also add every task event to {sourceEmails[0] ? <span className="font-mono text-[11px]">{sourceEmails[0]}</span> : 'the source email'}'s calendar
                    </span>
                  </label>
                  {!sourceEmails.length && (
                    <p className="text-[10px] text-slate-400 mt-1.5 ml-[52px]">Nominate a source email above first.</p>
                  )}
                </div>
                <button
                  onClick={handleSaveCalendar}
                  disabled={savingCalendar}
                  className="w-full py-3 bg-indigo-600 text-white rounded-full text-[11px] font-bold uppercase tracking-widest disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {savingCalendar ? <Loader2 size={14} className="animate-spin" /> : 'Save calendar settings'}
                </button>
              </div>

              <div className="pt-4 border-t border-slate-100">
                <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1">
                  Company ID
                </p>
                <p className="text-[11px] font-mono text-slate-400 select-all">{company?.id}</p>
              </div>
            </div>
          )}

        </div>
      </main>
    </div>
  );
}