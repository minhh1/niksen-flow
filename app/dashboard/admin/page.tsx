// app/dashboard/admin/page.tsx
"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import {
  Loader2, Users, Settings, Shield, Trash2,
  CheckCircle2, XCircle, Plus, X, Copy, Link, Clock, Mail,
} from "lucide-react";
import SourceEmailManager from "@/components/gmail/SourceEmailManager";

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

export default function AdminPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [unauthorized, setUnauthorized] = useState(false);
  const [company, setCompany] = useState<Company | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [tokens, setTokens] = useState<Token[]>([]);
  const [activeTab, setActiveTab] = useState<'members' | 'company' | 'invites' | 'gmail'>('members');
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

  useEffect(() => { load(); }, []);

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

    // Load company + tokens in parallel
    const [{ data: comp }, { data: tokenData }] = await Promise.all([
      supabase.from('companies').select('*').eq('id', companyId).single(),
      supabase
        .from('registration_tokens')
        .select('*')
        .eq('company_id', companyId)
        .order('created_at', { ascending: false }),
    ]);

    if (comp) {
      setCompany(comp);
      setCompanyName(comp.name);
      setCompanyAbn(comp.abn || '');
      setCompanyAcn(comp.acn || '');
    }
    setTokens(tokenData || []);

    // Load source emails from company
    setSourceEmails(comp?.gmail_source_emails || []);

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

      // Load connected Gmail emails for source-of-truth picker
      const memberUserIds = memberships.map((m: any) => m.user_id);
      const { data: gmailTokens } = await supabase
        .from('user_gmail_tokens')
        .select('email')
        .in('user_id', memberUserIds);
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

  const handleSourceEmailsChange = async (emails: string[]) => {
    setSourceEmails(emails);
    if (!company) return;
    await supabase
      .from('companies')
      .update({ gmail_source_emails: emails })
      .eq('id', company.id);
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
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      })
      .select()
      .single();
    setNewTokenNote('');
    setGeneratingToken(false);
    if (data) setTokens(prev => [data, ...prev]);
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

  if (loading) return (
    <div className="flex items-center justify-center h-screen">
      <Loader2 className="animate-spin text-slate-300" size={24} />
    </div>
  );

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

  const tabs = [
    { id: 'members' as const,  label: 'Members',      icon: Users },
    { id: 'invites' as const,  label: 'Invite links', icon: Link },
    { id: 'gmail'   as const,  label: 'Gmail',        icon: Mail },
    { id: 'company' as const,  label: 'Company',      icon: Settings },
  ];

  return (
    <div className="flex flex-col h-screen bg-[#F9FAFB] font-sans antialiased text-slate-600 overflow-hidden">

      {/* Header */}
      <header className="bg-white border-b border-slate-100 shrink-0 px-8 pt-8 pb-0">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-2xl bg-amber-50 flex items-center justify-center">
              <Shield size={18} className="text-amber-600" />
            </div>
            <div>
              <h1 className="text-2xl font-light uppercase tracking-tight text-slate-900">
                Admin
              </h1>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                {company?.name}
              </p>
            </div>
          </div>
        </div>

        <div className="flex gap-1">
          {tabs.map(tab => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-2 px-4 py-3 text-[11px] font-bold border-b-2 transition-all ${
                  activeTab === tab.id
                    ? 'border-amber-500 text-amber-600'
                    : 'border-transparent text-slate-400 hover:text-slate-700'
                }`}
              >
                <Icon size={13} />
                {tab.label}
              </button>
            );
          })}
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
                  onClick={() => setActiveTab('invites')}
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

          {/* ── Gmail source of truth ── */}
          {activeTab === 'gmail' && (
            <div className="bg-white border border-slate-200 rounded-[40px] p-8">
              <SourceEmailManager
                sourceEmails={sourceEmails}
                connectedEmails={connectedEmails}
                onChange={handleSourceEmailsChange}
              />
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
                {savingCompany
                  ? <Loader2 size={14} className="animate-spin" />
                  : 'Save changes'
                }
              </button>

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