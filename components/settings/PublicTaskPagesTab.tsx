// components/settings/PublicTaskPagesTab.tsx
"use client";

import { useState, useEffect } from "react";
import { supabase } from "@/lib/supabase";
import {
  Loader2, Plus, Copy, Check, AlertTriangle, Trash2, ExternalLink, X,
} from "lucide-react";
import { PUBLIC_TASK_COLUMNS, SCOPE_LABELS } from "@/lib/publicTaskColumns";

interface Team { id: string; team_name: string; leader_id: string | null; }
interface Page {
  id: string; title: string; scope: string; teamName: string | null;
  columns: string[]; expiresAt: string | null; isActive: boolean;
  createdAt: string; createdBy: string;
}

function defaultExpiry(): string {
  const d = new Date();
  d.setDate(d.getDate() + 30);
  return d.toISOString().slice(0, 10);
}

export default function PublicTaskPagesTab() {
  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  const [ledTeams, setLedTeams] = useState<Team[]>([]);
  const [allTeams, setAllTeams] = useState<Team[]>([]);
  const [pages, setPages] = useState<Page[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => { load(); }, []);

  const load = async () => {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setLoading(false); return; }
    const { data: profile } = await supabase.from("profiles").select("active_company_id").eq("id", user.id).single();
    const companyId = profile?.active_company_id;
    if (!companyId) { setLoading(false); return; }

    const { data: membership } = await supabase
      .from("company_memberships").select("role").eq("company_id", companyId).eq("user_id", user.id).maybeSingle();
    const admin = membership?.role === "company_admin";
    setIsAdmin(admin);

    const { data: teams } = await supabase.from("teams").select("id, team_name, leader_id").eq("company_id", companyId).eq("is_active", true);
    setAllTeams(teams || []);
    setLedTeams((teams || []).filter(t => t.leader_id === user.id));

    const res = await fetch("/api/public-tasks/list");
    const json = await res.json();
    setPages(json.pages || []);
    setLoading(false);
  };

  const handleRevoke = async (id: string) => {
    if (!window.confirm("Revoke this page? The link will stop working immediately.")) return;
    await fetch(`/api/public-tasks/${id}/revoke`, { method: "PATCH" });
    load();
  };

  const copyLink = (id: string) => {
    const url = `${window.location.origin}/public/tasks/${id}`;
    navigator.clipboard.writeText(url);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  const teamOptions = isAdmin ? allTeams : ledTeams;

  if (loading) return <div className="flex justify-center p-20"><Loader2 className="animate-spin text-slate-300" /></div>;

  return (
    <div className="space-y-6 animate-in fade-in">
      <div className="flex gap-3 p-5 bg-amber-50 border border-amber-100 rounded-[24px]">
        <AlertTriangle size={16} className="text-amber-500 shrink-0 mt-0.5" />
        <div className="text-[12px] text-amber-700 leading-relaxed">
          <p className="font-bold mb-1">Public pages are reachable by anyone with the link who is signed in.</p>
          <p>Anyone with the URL and a Flow account in your company can view the tasks it shows (and add new ones). Set an expiry date whenever possible, and revoke pages you no longer need.</p>
        </div>
      </div>

      <button onClick={() => setShowCreate(true)}
        className="flex items-center gap-2 px-5 py-3 bg-indigo-600 text-white text-[11px] font-bold rounded-full hover:bg-indigo-700 transition-colors">
        <Plus size={14} /> Create public page
      </button>

      <div className="space-y-3">
        {pages.length === 0 && <p className="text-center text-slate-300 text-[11px] uppercase font-bold tracking-widest p-12">No public pages yet</p>}
        {pages.map(p => (
          <div key={p.id} className="flex items-center gap-4 p-5 bg-white border border-slate-200 rounded-[24px]">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-[13px] font-bold text-slate-800">{p.title}</p>
                <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold uppercase ${p.isActive ? "bg-emerald-50 text-emerald-600" : "bg-slate-100 text-slate-400"}`}>
                  {p.isActive ? "Active" : "Revoked"}
                </span>
              </div>
              <p className="text-[11px] text-slate-400 mt-0.5">
                {SCOPE_LABELS[p.scope]}{p.teamName ? ` — ${p.teamName}` : ""} · by {p.createdBy}
                {p.expiresAt ? ` · expires ${new Date(p.expiresAt).toLocaleDateString()}` : " · no expiry"}
              </p>
            </div>
            {p.isActive && (
              <>
                <button onClick={() => copyLink(p.id)} title="Copy link"
                  className="p-2 text-slate-400 hover:text-indigo-600 transition-colors shrink-0">
                  {copiedId === p.id ? <Check size={15} className="text-emerald-500" /> : <Copy size={15} />}
                </button>
                <a href={`/public/tasks/${p.id}`} target="_blank" rel="noopener noreferrer" title="Open"
                  className="p-2 text-slate-400 hover:text-indigo-600 transition-colors shrink-0">
                  <ExternalLink size={15} />
                </a>
                <button onClick={() => handleRevoke(p.id)} title="Revoke"
                  className="p-2 text-slate-400 hover:text-red-500 transition-colors shrink-0">
                  <Trash2 size={15} />
                </button>
              </>
            )}
          </div>
        ))}
      </div>

      {showCreate && (
        <CreatePageModal isAdmin={isAdmin} teamOptions={teamOptions} onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); load(); }} />
      )}
    </div>
  );
}

function CreatePageModal({ isAdmin, teamOptions, onClose, onCreated }: {
  isAdmin: boolean; teamOptions: Team[]; onClose: () => void; onCreated: () => void;
}) {
  const [title, setTitle] = useState("");
  const [scope, setScope] = useState<"self" | "team" | "company">("self");
  const [teamId, setTeamId] = useState("");
  const [columns, setColumns] = useState<string[]>(["project_name", "due_date", "status"]);
  const [noExpiry, setNoExpiry] = useState(false);
  const [expiresAt, setExpiresAt] = useState(defaultExpiry());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);

  const toggleColumn = (key: string) => setColumns(prev => prev.includes(key) ? prev.filter(c => c !== key) : [...prev, key]);

  const handleCreate = async () => {
    if (!title.trim()) { setError("Title is required"); return; }
    if (scope === "team" && !teamId) { setError("Select a team"); return; }
    setSaving(true);
    setError(null);
    const res = await fetch("/api/public-tasks/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title, scope, teamId: scope === "team" ? teamId : undefined,
        columns, expiresAt: noExpiry ? null : expiresAt,
      }),
    });
    const json = await res.json();
    setSaving(false);
    if (!res.ok) { setError(json.error || "Failed to create page"); return; }
    setCreatedUrl(`${window.location.origin}/public/tasks/${json.pageId}`);
  };

  if (createdUrl) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm">
        <div className="bg-white rounded-[32px] shadow-2xl w-full max-w-md mx-4 p-8 text-center space-y-4">
          <Check size={32} className="text-emerald-500 mx-auto" />
          <p className="text-[14px] font-bold text-slate-800">Page created</p>
          <div className="px-4 py-3 bg-slate-50 rounded-2xl">
            <code className="text-[11px] text-slate-600 break-all">{createdUrl}</code>
          </div>
          <button onClick={() => { navigator.clipboard.writeText(createdUrl); }}
            className="w-full py-3 bg-slate-900 text-white text-[12px] font-bold rounded-full hover:bg-slate-700 flex items-center justify-center gap-2">
            <Copy size={13} /> Copy link
          </button>
          <button onClick={onCreated} className="w-full py-3 border border-slate-200 text-slate-600 text-[12px] font-bold rounded-full hover:bg-slate-50">
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/30 backdrop-blur-sm" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-white rounded-t-[32px] sm:rounded-[32px] shadow-2xl w-full max-w-lg mx-0 sm:mx-4 max-h-[90vh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-8 pt-8 pb-4 border-b border-slate-100 shrink-0">
          <h3 className="text-[14px] font-bold text-slate-800 uppercase tracking-wide">Create public page</h3>
          <button onClick={onClose} className="p-2 text-slate-300 hover:text-slate-700"><X size={16} /></button>
        </div>
        <div className="flex-1 overflow-y-auto px-8 py-6 space-y-5">
          <div>
            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">Title</p>
            <input value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Weekly team tasks"
              className="w-full px-4 py-2.5 border border-slate-200 rounded-full text-[13px] outline-none focus:border-indigo-400" />
          </div>

          <div>
            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-2">What should it show</p>
            <div className="space-y-2">
              <label className="flex items-center gap-3 p-3 border border-slate-200 rounded-2xl cursor-pointer has-[:checked]:border-indigo-400 has-[:checked]:bg-indigo-50">
                <input type="radio" checked={scope === "self"} onChange={() => setScope("self")} />
                <span className="text-[12px] text-slate-700">Just my tasks</span>
              </label>
              {teamOptions.length > 0 && (
                <label className="flex items-center gap-3 p-3 border border-slate-200 rounded-2xl cursor-pointer has-[:checked]:border-indigo-400 has-[:checked]:bg-indigo-50">
                  <input type="radio" checked={scope === "team"} onChange={() => setScope("team")} />
                  <span className="text-[12px] text-slate-700">My team's tasks</span>
                </label>
              )}
              {isAdmin && (
                <label className="flex items-center gap-3 p-3 border border-slate-200 rounded-2xl cursor-pointer has-[:checked]:border-indigo-400 has-[:checked]:bg-indigo-50">
                  <input type="radio" checked={scope === "company"} onChange={() => setScope("company")} />
                  <span className="text-[12px] text-slate-700">Everyone's tasks (admin)</span>
                </label>
              )}
            </div>
          </div>

          {scope === "team" && teamOptions.length > 1 && (
            <div>
              <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">Team</p>
              <select value={teamId} onChange={e => setTeamId(e.target.value)}
                className="w-full px-4 py-2.5 border border-slate-200 rounded-full text-[13px] outline-none bg-white">
                <option value="">— Select team —</option>
                {teamOptions.map(t => <option key={t.id} value={t.id}>{t.team_name}</option>)}
              </select>
            </div>
          )}
          {scope === "team" && teamOptions.length === 1 && (
            (() => { if (teamId !== teamOptions[0].id) setTeamId(teamOptions[0].id); return null; })()
          )}

          <div>
            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-2">Columns to show</p>
            <div className="flex flex-wrap gap-2">
              {PUBLIC_TASK_COLUMNS.map(c => (
                <button key={c.key} type="button" onClick={() => toggleColumn(c.key)}
                  className={`px-3 py-1.5 rounded-full text-[11px] font-medium border transition-colors ${
                    columns.includes(c.key) ? "bg-indigo-600 text-white border-indigo-600" : "bg-white text-slate-500 border-slate-200 hover:border-indigo-300"
                  }`}>
                  {c.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">Expiry date <span className="text-indigo-500 normal-case font-normal">(strongly recommended)</span></p>
            <input type="date" value={expiresAt} onChange={e => setExpiresAt(e.target.value)} disabled={noExpiry}
              className="w-full px-4 py-2.5 border border-slate-200 rounded-full text-[13px] outline-none disabled:opacity-40" />
            <label className="flex items-center gap-2 mt-2 cursor-pointer">
              <input type="checkbox" checked={noExpiry} onChange={e => setNoExpiry(e.target.checked)} />
              <span className="text-[11px] text-slate-500">No expiry (not recommended — leaves this link open indefinitely)</span>
            </label>
          </div>

          {error && <p className="text-[11px] text-red-500">{error}</p>}
        </div>
        <div className="px-8 py-5 border-t border-slate-100 shrink-0">
          <button onClick={handleCreate} disabled={saving}
            className="w-full py-3 bg-indigo-600 text-white text-[12px] font-bold rounded-full hover:bg-indigo-700 disabled:opacity-40 transition-colors">
            {saving ? "Creating..." : "Create page"}
          </button>
        </div>
      </div>
    </div>
  );
}
