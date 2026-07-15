// app/public/tasks/[pageId]/page.tsx
// Embeddable public task report page (e.g. for a Teams tab). Requires a
// real signed-in session — no separate PIN system. Access scope (self /
// team / company) is enforced server-side in the API route.
"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { Loader2, Plus, X, ExternalLink, RefreshCw } from "lucide-react";
import { PUBLIC_TASK_COLUMNS } from "@/lib/publicTaskColumns";

interface Task {
  id: string; name: string; isCompleted: boolean;
  dueDate: string | null; dueTime: string | null;
  projectName: string | null; matterNumber: string | null;
  status: string | null; statusColor: string | null;
  team: string | null; estimatedCost: number | null; dateEntered: string | null;
}
interface Tab { userId: string; userName: string; tasks: Task[]; }
interface FormOptions {
  projects: { id: string; name: string }[];
  statuses: { id: string; label: string }[];
  teams: { id: string; team_name: string }[];
  assignees: { id: string; name: string }[];
}
interface PageData { title: string; scope: string; columns: string[]; tabs: Tab[]; formOptions: FormOptions; }

export default function PublicTaskPage() {
  const params = useParams();
  const pageId = params.pageId as string;

  const [authChecked, setAuthChecked] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<PageData | null>(null);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [saving, setSaving] = useState(false);

  const checkAuthAndLoad = useCallback(async () => {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    setSignedIn(!!user);
    setAuthChecked(true);
    if (!user) { setLoading(false); return; }

    const res = await fetch(`/api/public-tasks/${pageId}`);
    const json = await res.json();
    if (!res.ok) {
      setError(json.error || "Failed to load page");
      setLoading(false);
      return;
    }
    setData(json);
    setActiveTab(prev => prev || json.tabs[0]?.userId || null);
    setError(null);
    setLoading(false);
  }, [pageId]);

  useEffect(() => { checkAuthAndLoad(); }, [checkAuthAndLoad]);

  const isEmbedded = typeof window !== "undefined" && window.self !== window.top;

  const openInNewTab = () => {
    window.open(window.location.href, "_blank");
  };

  // ── Not signed in ────────────────────────────────────────────────
  if (authChecked && !signedIn) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
        <div className="max-w-sm w-full bg-white rounded-[32px] border border-slate-200 p-8 text-center space-y-4">
          <p className="text-[13px] font-bold text-slate-800">Sign in required</p>
          <p className="text-[12px] text-slate-500">
            {isEmbedded
              ? "This page is embedded and can't access your sign-in session here. Open it in a full browser tab instead."
              : "This page shows task data and requires you to sign in to Flow first."}
          </p>
          {isEmbedded ? (
            <button onClick={openInNewTab}
              className="w-full py-3 bg-slate-900 text-white text-[12px] font-bold rounded-full hover:bg-slate-700 flex items-center justify-center gap-2">
              <ExternalLink size={13} /> Open in new tab
            </button>
          ) : (
            <>
              <button onClick={() => { window.location.href = "/login"; }}
                className="w-full py-3 bg-slate-900 text-white text-[12px] font-bold rounded-full hover:bg-slate-700 flex items-center justify-center gap-2">
                <ExternalLink size={13} /> Sign in
              </button>
              <button onClick={checkAuthAndLoad}
                className="w-full py-3 border border-slate-200 text-slate-600 text-[12px] font-bold rounded-full hover:bg-slate-50 flex items-center justify-center gap-2">
                <RefreshCw size={13} /> I've signed in — reload
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center bg-slate-50"><Loader2 className="animate-spin text-slate-400" /></div>;
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
        <div className="max-w-sm w-full bg-white rounded-[32px] border border-slate-200 p-8 text-center">
          <p className="text-[13px] font-bold text-red-600">{error}</p>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const activeTasks = data.tabs.find(t => t.userId === activeTab)?.tasks || [];
  const columns = PUBLIC_TASK_COLUMNS.filter(c => data.columns.includes(c.key));

  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6">
      <div className="max-w-5xl mx-auto space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h1 className="text-[16px] font-bold text-slate-800">{data.title}</h1>
          <div className="flex items-center gap-2">
            {isEmbedded && (
              <button onClick={openInNewTab} title="Open in new tab"
                className="flex items-center gap-1.5 px-3 py-2 text-slate-400 hover:text-slate-700 text-[11px] font-medium transition-colors">
                <ExternalLink size={13} />
              </button>
            )}
            <button onClick={() => setShowAddForm(true)}
              className="flex items-center gap-1.5 px-4 py-2 bg-indigo-600 text-white text-[11px] font-bold rounded-full hover:bg-indigo-700 transition-colors">
              <Plus size={13} /> Add task
            </button>
          </div>
        </div>

        {data.tabs.length > 1 && (
          <div className="flex items-center gap-2 overflow-x-auto pb-1">
            {data.tabs.map(tab => (
              <button key={tab.userId} onClick={() => setActiveTab(tab.userId)}
                className={`shrink-0 px-4 py-1.5 rounded-full text-[11px] font-bold transition-colors ${
                  activeTab === tab.userId ? "bg-slate-900 text-white" : "bg-white text-slate-500 border border-slate-200 hover:border-slate-300"
                }`}>
                {tab.userName} <span className="opacity-60">({tab.tasks.length})</span>
              </button>
            ))}
          </div>
        )}

        <div className="bg-white rounded-[24px] border border-slate-200 overflow-hidden overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-slate-100 text-left">
                <th className="px-4 py-3 text-[9px] font-bold text-slate-400 uppercase tracking-widest">Task</th>
                {columns.map(c => (
                  <th key={c.key} className="px-4 py-3 text-[9px] font-bold text-slate-400 uppercase tracking-widest whitespace-nowrap">{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {activeTasks.length === 0 && (
                <tr><td colSpan={columns.length + 1} className="px-4 py-8 text-center text-[11px] text-slate-300 italic">No tasks</td></tr>
              )}
              {activeTasks.map(t => (
                <tr key={t.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50">
                  <td className={`px-4 py-3 font-medium ${t.isCompleted ? "line-through text-slate-400" : "text-slate-800"}`}>{t.name}</td>
                  {columns.map(c => (
                    <td key={c.key} className="px-4 py-3 text-slate-600 whitespace-nowrap">
                      {renderCell(c.key, t)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {showAddForm && (
        <AddTaskModal
          pageId={pageId}
          formOptions={data.formOptions}
          defaultAssigneeId={activeTab}
          saving={saving}
          setSaving={setSaving}
          onClose={() => setShowAddForm(false)}
          onCreated={() => { setShowAddForm(false); checkAuthAndLoad(); }}
        />
      )}
    </div>
  );
}

function renderCell(key: string, t: Task) {
  switch (key) {
    case "project_name": return t.projectName || "—";
    case "matter_number": return t.matterNumber || "—";
    case "due_date": return t.dueDate || "—";
    case "due_time": return t.dueTime ? t.dueTime.slice(0, 5) : "—";
    case "status": return t.status
      ? <span className="px-2 py-0.5 rounded-full text-[9px] font-bold uppercase" style={{ background: (t.statusColor || "#94a3b8") + "20", color: t.statusColor || "#64748b" }}>{t.status}</span>
      : "—";
    case "team": return t.team || "—";
    case "estimated_cost": return t.estimatedCost ? `$${Number(t.estimatedCost).toLocaleString()}` : "—";
    case "date_entered": return t.dateEntered || "—";
    default: return "—";
  }
}

function AddTaskModal({ pageId, formOptions, defaultAssigneeId, saving, setSaving, onClose, onCreated }: {
  pageId: string; formOptions: FormOptions; defaultAssigneeId: string | null;
  saving: boolean; setSaving: (v: boolean) => void; onClose: () => void; onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [projectId, setProjectId] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [dueTime, setDueTime] = useState("");
  const [statusId, setStatusId] = useState("");
  const [teamId, setTeamId] = useState("");
  const [assigneeId, setAssigneeId] = useState(defaultAssigneeId || "");
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!name.trim()) { setError("Task name is required"); return; }
    if (!projectId) { setError("Project is required"); return; }
    setSaving(true);
    setError(null);
    const res = await fetch(`/api/public-tasks/${pageId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, projectId, dueDate: dueDate || null, dueTime: dueTime || null, statusId: statusId || null, teamId: teamId || null, assigneeId: assigneeId || null }),
    });
    const json = await res.json();
    setSaving(false);
    if (!res.ok) { setError(json.error || "Failed to create task"); return; }
    onCreated();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/30 backdrop-blur-sm" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-white rounded-t-[32px] sm:rounded-[32px] shadow-2xl w-full max-w-md mx-0 sm:mx-4 max-h-[90vh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-6 pt-6 pb-3 border-b border-slate-100 shrink-0">
          <h3 className="text-[13px] font-bold text-slate-800">Add task</h3>
          <button onClick={onClose} className="p-2 text-slate-300 hover:text-slate-700"><X size={16} /></button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
          <div>
            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">Task name *</p>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="Enter task name..."
              className="w-full px-4 py-2.5 border border-slate-200 rounded-full text-[13px] outline-none focus:border-indigo-400" />
          </div>
          <div>
            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">Project *</p>
            <select value={projectId} onChange={e => setProjectId(e.target.value)}
              className="w-full px-4 py-2.5 border border-slate-200 rounded-full text-[13px] outline-none bg-white">
              <option value="">— Select project —</option>
              {formOptions.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">Due date</p>
              <input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)}
                className="w-full px-4 py-2.5 border border-slate-200 rounded-full text-[13px] outline-none" />
            </div>
            <div>
              <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">Due time</p>
              <input type="time" value={dueTime} onChange={e => setDueTime(e.target.value)}
                className="w-full px-4 py-2.5 border border-slate-200 rounded-full text-[13px] outline-none" />
            </div>
          </div>
          <div>
            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">Status</p>
            <select value={statusId} onChange={e => setStatusId(e.target.value)}
              className="w-full px-4 py-2.5 border border-slate-200 rounded-full text-[13px] outline-none bg-white">
              <option value="">— No status —</option>
              {formOptions.statuses.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </div>
          {formOptions.assignees.length > 1 && (
            <div>
              <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">Assignee</p>
              <select value={assigneeId} onChange={e => setAssigneeId(e.target.value)}
                className="w-full px-4 py-2.5 border border-slate-200 rounded-full text-[13px] outline-none bg-white">
                <option value="">— Unassigned —</option>
                {formOptions.assignees.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
          )}
          {formOptions.teams.length > 0 && (
            <div>
              <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">Assigned team</p>
              <select value={teamId} onChange={e => setTeamId(e.target.value)}
                className="w-full px-4 py-2.5 border border-slate-200 rounded-full text-[13px] outline-none bg-white">
                <option value="">— No team —</option>
                {formOptions.teams.map(t => <option key={t.id} value={t.id}>{t.team_name}</option>)}
              </select>
            </div>
          )}
          {error && <p className="text-[11px] text-red-500">{error}</p>}
        </div>
        <div className="px-6 py-4 border-t border-slate-100 shrink-0">
          <button onClick={handleSubmit} disabled={saving}
            className="w-full py-3 bg-indigo-600 text-white text-[12px] font-bold rounded-full hover:bg-indigo-700 disabled:opacity-40 transition-colors">
            {saving ? "Adding..." : "Add task"}
          </button>
        </div>
      </div>
    </div>
  );
}
