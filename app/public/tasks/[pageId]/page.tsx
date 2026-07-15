// app/public/tasks/[pageId]/page.tsx
// Embeddable public task report page (e.g. for a Teams tab). Requires a
// real signed-in session — no separate PIN system. Access scope (self /
// team / company) is enforced server-side in the API route.
"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { Loader2, Plus, X, ExternalLink, RefreshCw, Pencil, Trash2, Check, FileStack } from "lucide-react";
import { PUBLIC_TASK_COLUMNS } from "@/lib/publicTaskColumns";
import DateCalculator from "@/components/DateCalculator";
import ProjectPicker, { PickedProject } from "@/components/public/ProjectPicker";

interface Task {
  id: string; name: string; isCompleted: boolean;
  dueDate: string | null; dueTime: string | null;
  projectId: string | null; projectName: string | null; matterNumber: string | null;
  statusId: string | null; status: string | null; statusColor: string | null;
  teamId: string | null; team: string | null;
  isMonetary: boolean; estimatedCost: number | null; dateEntered: string | null;
  createdBy: string | null;
}
interface Tab { userId: string; userName: string; tasks: Task[]; }
interface FormOptions {
  projects: PickedProject[];
  statuses: { id: string; label: string }[];
  teams: { id: string; team_name: string }[];
  assignees: { id: string; name: string }[];
}
interface PageData { title: string; scope: string; columns: string[]; companyId: string; tabs: Tab[]; formOptions: FormOptions; }

// Columns whose content can run long (project names, people's names) should
// wrap within their cell instead of forcing the table wider — everything
// else (dates, status, cost) is short enough to stay on one line.
const WRAP_COLUMNS = new Set(["project_name", "created_by"]);

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
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [showTemplates, setShowTemplates] = useState(false);
  const [saving, setSaving] = useState(false);

  // Silent refetch — updates data in place without flashing the full-page
  // loading spinner. Used for realtime-triggered refreshes and after the
  // current user's own mutations.
  const refresh = useCallback(async () => {
    const res = await fetch(`/api/public-tasks/${pageId}`);
    const json = await res.json();
    if (!res.ok) { setError(json.error || "Failed to load page"); return; }
    setData(json);
    setActiveTab(prev => prev || json.tabs[0]?.userId || null);
    setError(null);
  }, [pageId]);

  const checkAuthAndLoad = useCallback(async () => {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    setSignedIn(!!user);
    setAuthChecked(true);
    if (!user) { setLoading(false); return; }
    await refresh();
    setLoading(false);
  }, [refresh]);

  useEffect(() => { checkAuthAndLoad(); }, [checkAuthAndLoad]);

  // ── Realtime — live-refresh when anyone (this page or the main app)
  // changes a task for this company, so multiple viewers stay in sync
  // without a manual reload.
  const refreshDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!data?.companyId) return;
    const channel = supabase
      .channel(`public-tasks-${pageId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "tasks", filter: `company_id=eq.${data.companyId}` }, () => {
        if (refreshDebounceRef.current) clearTimeout(refreshDebounceRef.current);
        refreshDebounceRef.current = setTimeout(() => refresh(), 400);
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [data?.companyId, pageId, refresh]);

  const isEmbedded = typeof window !== "undefined" && window.self !== window.top;

  const openInNewTab = () => {
    window.open(window.location.href, "_blank");
  };

  const toggleComplete = async (task: Task) => {
    // Optimistic — flip it locally right away, then confirm with the server.
    setData(prev => prev ? {
      ...prev,
      tabs: prev.tabs.map(tab => ({
        ...tab,
        tasks: tab.tasks.map(t => t.id === task.id ? { ...t, isCompleted: !t.isCompleted } : t),
      })),
    } : prev);
    const res = await fetch(`/api/public-tasks/${pageId}/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isCompleted: !task.isCompleted }),
    });
    if (!res.ok) refresh(); // revert to server truth on failure
  };

  const deleteTask = async (task: Task) => {
    if (!window.confirm(`Delete "${task.name}"?`)) return;
    await fetch(`/api/public-tasks/${pageId}/tasks/${task.id}`, { method: "DELETE" });
    refresh();
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
      <div className="max-w-[1600px] mx-auto space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h1 className="text-[16px] font-bold text-slate-800">{data.title}</h1>
          <div className="flex items-center gap-2">
            {isEmbedded && (
              <button onClick={openInNewTab} title="Open in new tab"
                className="flex items-center gap-1.5 px-3 py-2 text-slate-400 hover:text-slate-700 text-[11px] font-medium transition-colors">
                <ExternalLink size={13} />
              </button>
            )}
            <button onClick={() => setShowTemplates(true)}
              className="flex items-center gap-1.5 px-4 py-2 bg-white border border-slate-200 text-slate-600 text-[11px] font-bold rounded-full hover:border-indigo-300 transition-colors">
              <FileStack size={13} /> Apply template
            </button>
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
          <table className="w-full text-[13px] table-fixed">
            <thead>
              <tr className="border-b border-slate-100 text-left">
                <th className="px-4 py-3.5 w-10"></th>
                <th className="px-4 py-3.5 text-[10px] font-bold text-slate-400 uppercase tracking-widest w-[38%] min-w-[280px]">Task</th>
                {columns.map(c => (
                  <th key={c.key} className={`px-4 py-3.5 text-[10px] font-bold text-slate-400 uppercase tracking-widest ${WRAP_COLUMNS.has(c.key) ? "" : "whitespace-nowrap"}`}>{c.label}</th>
                ))}
                <th className="px-4 py-3.5 w-20"></th>
              </tr>
            </thead>
            <tbody>
              {activeTasks.length === 0 && (
                <tr><td colSpan={columns.length + 3} className="px-4 py-10 text-center text-[12px] text-slate-300 italic">No tasks</td></tr>
              )}
              {activeTasks.map(t => (
                <tr key={t.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50 group">
                  <td className="px-4 py-4">
                    <button onClick={() => toggleComplete(t)}
                      className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-all ${t.isCompleted ? "bg-emerald-500 border-emerald-500" : "border-slate-300 hover:border-indigo-400"}`}>
                      {t.isCompleted && <Check size={11} className="text-white" />}
                    </button>
                  </td>
                  <td className={`px-4 py-4 font-medium cursor-pointer leading-snug ${t.isCompleted ? "line-through text-slate-400" : "text-slate-800"}`}
                    onClick={() => setEditingTask(t)}>
                    {t.name}
                  </td>
                  {columns.map(c => (
                    <td key={c.key} className={`px-4 py-4 text-slate-600 leading-snug ${WRAP_COLUMNS.has(c.key) ? "" : "whitespace-nowrap"}`}>
                      {renderCell(c.key, t)}
                    </td>
                  ))}
                  <td className="px-4 py-4">
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button onClick={() => setEditingTask(t)} title="Edit" className="p-1.5 text-slate-300 hover:text-indigo-600"><Pencil size={13} /></button>
                      <button onClick={() => deleteTask(t)} title="Delete" className="p-1.5 text-slate-300 hover:text-red-500"><Trash2 size={13} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {showAddForm && (
        <TaskModal
          pageId={pageId}
          formOptions={data.formOptions}
          defaultAssigneeId={activeTab}
          saving={saving}
          setSaving={setSaving}
          onClose={() => setShowAddForm(false)}
          onSaved={() => { setShowAddForm(false); refresh(); }}
        />
      )}

      {editingTask && (
        <TaskModal
          pageId={pageId}
          formOptions={data.formOptions}
          defaultAssigneeId={activeTab}
          task={editingTask}
          saving={saving}
          setSaving={setSaving}
          onClose={() => setEditingTask(null)}
          onSaved={() => { setEditingTask(null); refresh(); }}
          onDeleted={() => { setEditingTask(null); refresh(); }}
        />
      )}

      {showTemplates && (
        <TemplatesModal
          pageId={pageId}
          projects={data.formOptions.projects}
          onClose={() => setShowTemplates(false)}
          onApplied={() => { setShowTemplates(false); refresh(); }}
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
    case "created_by": return t.createdBy || "—";
    default: return "—";
  }
}

// ── Add / Edit task modal ───────────────────────────────────────────
function TaskModal({ pageId, formOptions, defaultAssigneeId, task, saving, setSaving, onClose, onSaved, onDeleted }: {
  pageId: string; formOptions: FormOptions; defaultAssigneeId: string | null; task?: Task;
  saving: boolean; setSaving: (v: boolean) => void; onClose: () => void; onSaved: () => void; onDeleted?: () => void;
}) {
  const isEdit = !!task;
  const [name, setName] = useState(task?.name || "");
  const [project, setProject] = useState<PickedProject | null>(
    task?.projectId ? { id: task.projectId, name: task.projectName || "", matterNumber: task.matterNumber } : null
  );
  const [dueDate, setDueDate] = useState(task?.dueDate || "");
  const [dueTime, setDueTime] = useState(task?.dueTime ? task.dueTime.slice(0, 5) : "");
  const [statusId, setStatusId] = useState(task?.statusId || "");
  const [teamId, setTeamId] = useState(task?.teamId || "");
  const [assigneeId, setAssigneeId] = useState(defaultAssigneeId || "");
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const handleSubmit = async () => {
    if (!name.trim()) { setError("Task name is required"); return; }
    if (!isEdit && !project) { setError("Project is required"); return; }
    setSaving(true);
    setError(null);
    const body: any = { name, dueDate: dueDate || null, dueTime: dueTime || null, statusId: statusId || null, teamId: teamId || null };
    if (!isEdit) { body.projectId = project!.id; body.assigneeId = assigneeId || null; }
    const res = await fetch(`/api/public-tasks/${pageId}${isEdit ? `/tasks/${task!.id}` : ""}`, {
      method: isEdit ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    setSaving(false);
    if (!res.ok) { setError(json.error || "Failed to save task"); return; }
    onSaved();
  };

  const handleDelete = async () => {
    if (!task || !window.confirm(`Delete "${task.name}"?`)) return;
    setDeleting(true);
    await fetch(`/api/public-tasks/${pageId}/tasks/${task.id}`, { method: "DELETE" });
    setDeleting(false);
    onDeleted?.();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/30 backdrop-blur-sm" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-white rounded-t-[32px] sm:rounded-[32px] shadow-2xl w-full max-w-md mx-0 sm:mx-4 max-h-[90vh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-6 pt-6 pb-3 border-b border-slate-100 shrink-0">
          <h3 className="text-[13px] font-bold text-slate-800">{isEdit ? "Edit task" : "Add task"}</h3>
          <button onClick={onClose} className="p-2 text-slate-300 hover:text-slate-700"><X size={16} /></button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
          <div>
            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">Task name *</p>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="Enter task name..."
              className="w-full px-4 py-2.5 border border-slate-200 rounded-full text-[13px] outline-none focus:border-indigo-400" />
          </div>
          {!isEdit && (
            <ProjectPicker projects={formOptions.projects} value={project} onChange={setProject} />
          )}
          {isEdit && task?.projectName && (
            <div>
              <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">Project</p>
              <p className="text-[12px] text-slate-500 px-4 py-2.5 bg-slate-50 rounded-full">{task.projectName}{task.matterNumber ? ` — ${task.matterNumber}` : ""}</p>
            </div>
          )}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="flex items-center gap-1.5 mb-1.5">
                <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">Due date</p>
                <DateCalculator defaultFromDate={dueDate || undefined} onApply={setDueDate} />
              </div>
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
          {!isEdit && formOptions.assignees.length > 1 && (
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
        <div className="px-6 py-4 border-t border-slate-100 shrink-0 space-y-2">
          <button onClick={handleSubmit} disabled={saving}
            className="w-full py-3 bg-indigo-600 text-white text-[12px] font-bold rounded-full hover:bg-indigo-700 disabled:opacity-40 transition-colors">
            {saving ? "Saving..." : isEdit ? "Save changes" : "Add task"}
          </button>
          {isEdit && (
            <button onClick={handleDelete} disabled={deleting}
              className="w-full py-3 border border-red-200 text-red-500 text-[12px] font-bold rounded-full hover:bg-red-50 disabled:opacity-40 transition-colors">
              {deleting ? "Deleting..." : "Delete task"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Apply template modal ────────────────────────────────────────────
function TemplatesModal({ pageId, projects, onClose, onApplied }: { pageId: string; projects: PickedProject[]; onClose: () => void; onApplied: () => void }) {
  const [project, setProject] = useState<PickedProject | null>(null);
  const [templates, setTemplates] = useState<{ id: string; name: string; itemCount: number }[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(true);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<number | null>(null);

  useEffect(() => {
    (async () => {
      const res = await fetch(`/api/public-tasks/${pageId}/templates`);
      const json = await res.json();
      setTemplates(json.templates || []);
      setLoadingTemplates(false);
    })();
  }, [pageId]);

  const handleApply = async () => {
    if (!project) { setError("Select a project first"); return; }
    if (!selectedTemplateId) { setError("Select a template"); return; }
    setApplying(true);
    setError(null);
    const res = await fetch(`/api/public-tasks/${pageId}/templates/${selectedTemplateId}/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: project.id }),
    });
    const json = await res.json();
    setApplying(false);
    if (!res.ok) { setError(json.error || "Failed to apply template"); return; }
    setResult(json.count);
  };

  if (result !== null) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm">
        <div className="bg-white rounded-[32px] shadow-2xl w-full max-w-sm mx-4 p-8 text-center space-y-4">
          <Check size={28} className="text-emerald-500 mx-auto" />
          <p className="text-[13px] font-bold text-slate-800">{result} task{result !== 1 ? "s" : ""} created</p>
          <button onClick={onApplied} className="w-full py-3 bg-slate-900 text-white text-[12px] font-bold rounded-full hover:bg-slate-700">Done</button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/30 backdrop-blur-sm" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-white rounded-t-[32px] sm:rounded-[32px] shadow-2xl w-full max-w-md mx-0 sm:mx-4 max-h-[90vh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-6 pt-6 pb-3 border-b border-slate-100 shrink-0">
          <h3 className="text-[13px] font-bold text-slate-800">Apply template</h3>
          <button onClick={onClose} className="p-2 text-slate-300 hover:text-slate-700"><X size={16} /></button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
          <ProjectPicker projects={projects} value={project} onChange={setProject} label="Project *" />
          <div>
            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">Template *</p>
            {loadingTemplates ? (
              <Loader2 size={14} className="animate-spin text-slate-300" />
            ) : templates.length === 0 ? (
              <p className="text-[11px] text-slate-300 italic">No templates available</p>
            ) : (
              <select value={selectedTemplateId} onChange={e => setSelectedTemplateId(e.target.value)}
                className="w-full px-4 py-2.5 border border-slate-200 rounded-full text-[13px] outline-none bg-white">
                <option value="">— Select template —</option>
                {templates.map(t => <option key={t.id} value={t.id}>{t.name} ({t.itemCount} tasks)</option>)}
              </select>
            )}
          </div>
          {error && <p className="text-[11px] text-red-500">{error}</p>}
        </div>
        <div className="px-6 py-4 border-t border-slate-100 shrink-0">
          <button onClick={handleApply} disabled={applying}
            className="w-full py-3 bg-indigo-600 text-white text-[12px] font-bold rounded-full hover:bg-indigo-700 disabled:opacity-40 transition-colors">
            {applying ? "Applying..." : "Apply template"}
          </button>
        </div>
      </div>
    </div>
  );
}
