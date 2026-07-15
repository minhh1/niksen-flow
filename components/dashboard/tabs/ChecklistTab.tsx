// components/dashboard/tabs/ChecklistTab.tsx
"use client";
import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import {
  Plus, Check, ChevronDown, ChevronRight, Trash2, Calendar,
  User, Users, DollarSign, Pencil, X,
  Copy, ArrowLeft, CheckSquare,
} from "lucide-react";
import DateCalculator from "@/components/DateCalculator";

interface Task {
  id: string; project_id: string; name: string; is_completed: boolean;
  due_date: string | null; due_time: string | null; assignee_id: string | null;
  assigned_team_id: string | null; status_id: string | null; is_monetary: boolean;
  estimated_cost: number; reminder_settings: any; parent_task_id: string | null;
  date_entered: string | null; company_id: string; created_by: string | null;
}
interface Profile { id: string; full_name: string | null; email: string | null; }
interface Team { id: string; team_name: string; }
interface Status { id: string; label: string; color_hex: string; }
interface TemplateItem {
  id: string; template_id: string; parent_item_id: string | null; title: string;
  priority: string; assigned_team_id: string | null; assignee_id: string | null;
  is_monetary: boolean; estimated_cost: number; due_offset_days: number | null;
  due_anchor: string; display_order: number;
  due_offset_mode?: 'calendar' | 'business'; due_offset_state?: string | null;
}

const AU_STATES = ['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT'];
interface Template { id: string; name: string; items: TemplateItem[]; }
interface Props { recordId: string; companyId: string; }

// ── TaskRow ────────────────────────────────────────────────────────
function TaskRow({ task, subtasks, allTasks, profiles, teams, statuses, depth, onUpdate, onDelete, onAddSubtask, onEdit }: any) {
  const [expanded, setExpanded] = useState(true);
  const assignee = profiles.find((p: any) => p.id === task.assignee_id);
  const team = teams.find((t: any) => t.id === task.assigned_team_id);
  const status = statuses.find((s: any) => s.id === task.status_id);
  const creator = profiles.find((p: any) => p.id === task.created_by);
  const completedSubtasks = subtasks.filter((s: any) => s.is_completed).length;
  return (
    <div className={depth > 0 ? 'ml-6 border-l-2 border-slate-100 pl-4' : ''}>
      <div className={`group flex items-start gap-3 py-2.5 px-3 rounded-2xl transition-all hover:bg-slate-50 ${task.is_completed ? 'opacity-60' : ''}`}>
        <button onClick={() => subtasks.length && setExpanded((p: boolean) => !p)} className="mt-0.5 shrink-0 w-4">
          {subtasks.length > 0 ? (expanded ? <ChevronDown size={14} className="text-slate-400" /> : <ChevronRight size={14} className="text-slate-400" />) : <span className="w-4" />}
        </button>
        <button onClick={() => onUpdate(task.id, { is_completed: !task.is_completed })}
          className={`mt-0.5 w-5 h-5 rounded-full border-2 shrink-0 flex items-center justify-center transition-all ${task.is_completed ? 'bg-emerald-500 border-emerald-500' : 'border-slate-300 hover:border-indigo-400'}`}>
          {task.is_completed && <Check size={11} className="text-white" />}
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-[13px] font-medium ${task.is_completed ? 'line-through text-slate-400' : 'text-slate-800'}`}>{task.name}</span>
            {status && <span className="px-2 py-0.5 rounded-full text-[9px] font-bold uppercase" style={{ background: status.color_hex + '20', color: status.color_hex }}>{status.label}</span>}
            {subtasks.length > 0 && <span className="text-[10px] text-slate-400 font-medium">{completedSubtasks}/{subtasks.length}</span>}
          </div>
          <div className="flex items-center gap-3 mt-1 flex-wrap">
            {task.due_date && <span className={`flex items-center gap-1 text-[10px] font-medium ${!task.is_completed && new Date(task.due_date) < new Date() ? 'text-red-500' : 'text-slate-400'}`}><Calendar size={10} />{new Date(task.due_date).toLocaleDateString('en-AU')}{task.due_time && ` ${task.due_time.slice(0,5)}`}</span>}
            {assignee && <span className="flex items-center gap-1 text-[10px] text-slate-400"><User size={10} />{assignee.full_name || assignee.email}</span>}
            {team && <span className="flex items-center gap-1 text-[10px] text-slate-400"><Users size={10} />{team.team_name}</span>}
            {task.is_monetary && task.estimated_cost > 0 && <span className="flex items-center gap-1 text-[10px] text-slate-400"><DollarSign size={10} />${Number(task.estimated_cost).toLocaleString()}</span>}
            {creator && <span className="text-[10px] text-slate-300">Added by {creator.full_name || creator.email}</span>}
          </div>
        </div>
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
          <button onClick={() => onAddSubtask(task.id)} title="Add subtask" className="p-1.5 text-slate-300 hover:text-indigo-600 transition-colors"><Plus size={12} /></button>
          <button onClick={() => onEdit(task)} title="Edit" className="p-1.5 text-slate-300 hover:text-indigo-600 transition-colors"><Pencil size={12} /></button>
          <button onClick={() => onDelete(task.id)} title="Delete" className="p-1.5 text-slate-300 hover:text-red-500 transition-colors"><Trash2 size={12} /></button>
        </div>
      </div>
      {expanded && subtasks.length > 0 && (
        <div className="mt-1">
          {subtasks.map((sub: any) => (
            <TaskRow key={sub.id} task={sub} subtasks={allTasks.filter((t: any) => t.parent_task_id === sub.id)} allTasks={allTasks}
              profiles={profiles} teams={teams} statuses={statuses} depth={depth + 1}
              onUpdate={onUpdate} onDelete={onDelete} onAddSubtask={onAddSubtask} onEdit={onEdit} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── TaskEditModal ─────────────────────────────────────────────────
function TaskEditModal({ task, profiles, teams, statuses, onSave, onClose }: any) {
  const [draft, setDraft] = useState<Partial<Task>>({ ...task });
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<Task>) => setDraft(p => ({ ...p, ...patch }));
  const handleSave = async () => { setSaving(true); await onSave(draft); setSaving(false); onClose(); };
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/30 backdrop-blur-sm" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-white rounded-t-[40px] sm:rounded-[40px] shadow-2xl w-full max-w-xl mx-0 sm:mx-4 max-h-[90vh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-8 pt-8 pb-4 border-b border-slate-100 shrink-0">
          <div>
            <h3 className="text-[14px] font-bold text-slate-800 uppercase tracking-wide">{task.id ? 'Edit task' : 'New task'}</h3>
            {task.id && task.created_by && (() => {
              const creator = profiles.find((p: any) => p.id === task.created_by);
              return creator ? <p className="text-[10px] text-slate-400 mt-1">Added by {creator.full_name || creator.email}</p> : null;
            })()}
          </div>
          <button onClick={onClose} className="p-2 text-slate-300 hover:text-slate-700"><X size={16} /></button>
        </div>
        <div className="flex-1 overflow-y-auto px-8 py-6 space-y-5">
          <div>
            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">Task name *</p>
            <input value={draft.name || ''} onChange={e => set({ name: e.target.value })} placeholder="Enter task name..."
              className="w-full px-4 py-2.5 border border-slate-200 rounded-full text-[13px] outline-none focus:border-indigo-400" />
          </div>
          <div>
            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">Status</p>
            <select value={draft.status_id || ''} onChange={e => set({ status_id: e.target.value || null })}
              className="w-full px-4 py-2.5 border border-slate-200 rounded-full text-[13px] outline-none bg-white">
              <option value="">— No status —</option>
              {statuses.map((s: any) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="flex items-center gap-1.5 mb-1.5">
                <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">Due date</p>
                <DateCalculator onApply={date => set({ due_date: date })} />
              </div>
              <input type="date" value={draft.due_date ? String(draft.due_date).slice(0,10) : ''} onChange={e => set({ due_date: e.target.value || null })}
                className="w-full px-4 py-2.5 border border-slate-200 rounded-full text-[13px] outline-none" />
            </div>
            <div>
              <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">Due time</p>
              <input type="time" value={draft.due_time || ''} onChange={e => set({ due_time: e.target.value || null })}
                className="w-full px-4 py-2.5 border border-slate-200 rounded-full text-[13px] outline-none" />
            </div>
          </div>
          <div>
            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">Assignee</p>
            <select value={draft.assignee_id || ''} onChange={e => set({ assignee_id: e.target.value || null })}
              className="w-full px-4 py-2.5 border border-slate-200 rounded-full text-[13px] outline-none bg-white">
              <option value="">— Unassigned —</option>
              {profiles.map((p: any) => <option key={p.id} value={p.id}>{p.full_name || p.email}</option>)}
            </select>
          </div>
          <div>
            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">Assigned team</p>
            <select value={draft.assigned_team_id || ''} onChange={e => set({ assigned_team_id: e.target.value || null })}
              className="w-full px-4 py-2.5 border border-slate-200 rounded-full text-[13px] outline-none bg-white">
              <option value="">— No team —</option>
              {teams.map((t: any) => <option key={t.id} value={t.id}>{t.team_name}</option>)}
            </select>
          </div>
          <div>
            <label className="flex items-center gap-3 cursor-pointer">
              <div onClick={() => set({ is_monetary: !draft.is_monetary })}
                className={`w-10 h-6 rounded-full transition-colors ${draft.is_monetary ? 'bg-indigo-600' : 'bg-slate-200'}`}>
                <div className={`w-5 h-5 bg-white rounded-full shadow mt-0.5 transition-transform ${draft.is_monetary ? 'translate-x-4' : 'translate-x-0.5'}`} />
              </div>
              <span className="text-[12px] text-slate-700 font-medium">Monetary task</span>
            </label>
            {draft.is_monetary && (
              <div className="mt-3">
                <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">Estimated cost</p>
                <div className="flex items-center gap-2">
                  <span className="text-slate-400 text-[13px]">$</span>
                  <input type="number" value={draft.estimated_cost || 0} onChange={e => set({ estimated_cost: parseFloat(e.target.value) || 0 })}
                    className="flex-1 px-4 py-2.5 border border-slate-200 rounded-full text-[13px] outline-none" />
                </div>
              </div>
            )}
          </div>
          <div>
            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">Reminder</p>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-[10px] text-slate-400 mb-1">Days before</p>
                <input type="number" min="0" value={draft.reminder_settings?.days ?? 0}
                  onChange={e => set({ reminder_settings: { ...draft.reminder_settings, days: parseInt(e.target.value) || 0 } })}
                  className="w-full px-4 py-2 border border-slate-200 rounded-full text-[12px] outline-none" />
              </div>
              <div>
                <p className="text-[10px] text-slate-400 mb-1">At time</p>
                <input type="time" value={draft.reminder_settings?.time ?? '09:00'}
                  onChange={e => set({ reminder_settings: { ...draft.reminder_settings, time: e.target.value } })}
                  className="w-full px-4 py-2 border border-slate-200 rounded-full text-[12px] outline-none" />
              </div>
            </div>
          </div>
        </div>
        <div className="px-8 py-5 border-t border-slate-100 shrink-0">
          <button onClick={handleSave} disabled={saving || !draft.name?.trim()}
            className="w-full py-3 bg-indigo-600 text-white text-[12px] font-bold rounded-full hover:bg-indigo-700 disabled:opacity-40 transition-colors">
            {saving ? 'Saving...' : task.id ? 'Save changes' : 'Add task'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── TemplateModal ─────────────────────────────────────────────────
function TemplateModal({ templates, setTemplates, profiles, teams, companyId, projectId, projectCreatedAt, projectDueDate, tasks, onApply, onSaveNew, onClose }: any) {
  type View = 'list' | 'apply' | 'create' | 'edit';
  const [view, setView] = useState<View>('list');
  const [selected, setSelected] = useState<Template | null>(null);
  const [newName, setNewName] = useState('');
  const [newItems, setNewItems] = useState<Partial<TemplateItem>[]>([
    { title: '', due_offset_days: 0, due_anchor: 'record_created', display_order: 0 }
  ]);
  const [editName, setEditName] = useState('');
  const [editItems, setEditItems] = useState<Partial<TemplateItem>[]>([]);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  const openEdit = (t: Template) => {
    setSelected(t);
    setEditName(t.name);
    setEditItems(t.items.map(i => ({ ...i })));
    setView('edit');
  };

  const handleSaveEdit = async () => {
    if (!selected || !editName.trim()) return;
    setSaving(true);
    // Update template name
    await supabase.from('checklist_templates').update({ name: editName.trim() }).eq('id', selected.id);
    // Delete all existing items and re-insert
    await supabase.from('checklist_template_items').delete().eq('template_id', selected.id);
    const validItems = editItems.filter(i => i.title?.trim());
    if (validItems.length) {
      await supabase.from('checklist_template_items').insert(
        validItems.map((item, i) => ({ ...item, template_id: selected.id, display_order: i }))
      );
    }
    // Update local state
    const updatedTemplate = { ...selected, name: editName.trim(), items: validItems.map((item, i) => ({ ...item, template_id: selected.id, display_order: i, id: item.id || '' })) };
    setTemplates((prev: Template[]) => prev.map(t => t.id === selected.id ? updatedTemplate : t));
    setSaving(false);
    setView('list');
    setSelected(null);
  };

  const ANCHORS = [
    { value: 'record_created', label: 'Project created' },
    { value: 'record_due', label: 'Project due date' },
  ];

  const getAnchorDate = (item: TemplateItem): Date => {
    if (item.due_anchor === 'record_created') return new Date(projectCreatedAt);
    if (item.due_anchor === 'record_due' && projectDueDate) return new Date(projectDueDate);
    return new Date();
  };

  // Calendar-day resolution — instant, no network call.
  const resolveDate = (item: TemplateItem): string | null => {
    if (item.due_offset_days === null) return null;
    const anchor = getAnchorDate(item);
    anchor.setDate(anchor.getDate() + (item.due_offset_days || 0));
    return anchor.toISOString().split('T')[0];
  };

  // Business-day resolution — calls date-calc for AU state-aware holiday skipping.
  // Falls back to the calendar-day result if the item isn't in business mode or the call fails.
  const resolveDateAsync = async (item: TemplateItem): Promise<string | null> => {
    if (item.due_offset_days === null) return null;
    if (item.due_offset_mode === 'business' && item.due_offset_state) {
      const fromDateStr = getAnchorDate(item).toISOString().split('T')[0];
      const { data, error } = await supabase.functions.invoke('date-calc', {
        body: { fromDate: fromDateStr, days: item.due_offset_days, mode: 'business', state: item.due_offset_state },
      });
      if (!error && data?.resultDate) return data.resultDate;
    }
    return resolveDate(item);
  };

  // Resolved dates for the "apply" preview — keyed by item id, populated async
  // for business-day items (calendar-day items resolve instantly via resolveDate).
  const [resolvedDates, setResolvedDates] = useState<Record<string, string | null>>({});

  useEffect(() => {
    if (view !== 'apply' || !selected) return;
    let cancelled = false;
    (async () => {
      const items = selected.items.filter(i => !i.parent_item_id);
      const entries = await Promise.all(items.map(async item => [item.id, await resolveDateAsync(item)] as const));
      if (!cancelled) setResolvedDates(Object.fromEntries(entries));
    })();
    return () => { cancelled = true; };
  }, [view, selected]);

  const handleApply = async () => {
    if (!selected) return;
    setSaving(true);
    console.log('[template] Applying:', selected.name, 'items:', selected.items.length);
    const itemsToApply = selected.items
      .filter(i => !i.parent_item_id)
      .sort((a, b) => a.display_order - b.display_order);
    const tasksToCreate: Partial<Task>[] = await Promise.all(itemsToApply.map(async item => ({
      project_id: projectId, company_id: companyId, name: item.title,
      assignee_id: item.assignee_id || null, assigned_team_id: item.assigned_team_id || null,
      is_monetary: item.is_monetary || false, estimated_cost: item.estimated_cost || 0,
      due_date: await resolveDateAsync(item), is_completed: false,
    })));
    console.log('[template] tasksToCreate:', tasksToCreate);
    await onApply(tasksToCreate);
    setSaving(false);
    onClose();
  };

  const handleDelete = async (templateId: string, templateName: string) => {
    if (!window.confirm(`Delete template "${templateName}"? This cannot be undone.`)) return;
    setDeleting(templateId);
    // Delete items first (FK constraint)
    await supabase.from('checklist_template_items').delete().eq('template_id', templateId);
    const { error } = await supabase.from('checklist_templates').delete().eq('id', templateId);
    if (!error) {
      setTemplates((prev: Template[]) => prev.filter(t => t.id !== templateId));
    }
    setDeleting(null);
  };

  const handleSaveNew = async () => {
    if (!newName.trim()) return;
    setSaving(true);
    await onSaveNew(newName, newItems.filter(i => i.title?.trim()));
    setSaving(false);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/30 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-white rounded-t-[40px] sm:rounded-[40px] shadow-2xl w-full max-w-2xl mx-0 sm:mx-4 max-h-[90vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-3 px-8 pt-8 pb-4 border-b border-slate-100 shrink-0">
          {view !== 'list' && (
            <button onClick={() => { setView('list'); setSelected(null); }} className="p-1.5 text-slate-400 hover:text-slate-700 transition-colors">
              <ArrowLeft size={16} />
            </button>
          )}
          <h3 className="text-[14px] font-bold text-slate-800 uppercase tracking-wide flex-1">
            {view === 'list' ? 'Checklist templates' : view === 'apply' ? `Apply: ${selected?.name}` : view === 'edit' ? `Edit: ${selected?.name}` : 'Create template'}
          </h3>
          <button onClick={onClose} className="p-2 text-slate-300 hover:text-slate-700"><X size={16} /></button>
        </div>

        <div className="flex-1 overflow-y-auto px-8 py-6">
          {/* ── List view ── */}
          {view === 'list' && (
            <div className="space-y-3">
              <button onClick={() => setView('create')}
                className="w-full flex items-center gap-3 px-4 py-3 border-2 border-dashed border-indigo-300 text-indigo-600 rounded-2xl hover:bg-indigo-50 transition-colors text-[12px] font-medium">
                <Plus size={14} /> Create new template
              </button>
              {templates.length === 0 && (
                <p className="text-center text-[11px] text-slate-300 italic py-8">No templates yet</p>
              )}
              {templates.map((t: Template) => (
                <div key={t.id} className="flex items-center gap-3 px-5 py-4 bg-slate-50 hover:bg-indigo-50 rounded-2xl transition-colors group">
                  {/* Apply area */}
                  <button onClick={() => { setSelected(t); setView('apply'); }} className="flex-1 flex items-center justify-between text-left">
                    <div>
                      <p className="text-[13px] font-bold text-slate-800">{t.name}</p>
                      <p className="text-[11px] text-slate-400 mt-0.5">{t.items.length} task{t.items.length !== 1 ? 's' : ''}</p>
                    </div>
                    <Copy size={14} className="text-slate-400 shrink-0 ml-3" />
                  </button>
                  {/* Divider */}
                  <div className="w-px h-8 bg-slate-200" />
                  {/* Edit */}
                  <button onClick={() => openEdit(t)} className="p-1.5 text-slate-300 hover:text-indigo-600 transition-colors shrink-0" title="Edit template">
                    <Pencil size={14} />
                  </button>
                  {/* Divider */}
                  <div className="w-px h-8 bg-slate-200" />
                  {/* Delete */}
                  <button onClick={() => handleDelete(t.id, t.name)} disabled={deleting === t.id}
                    className="p-1.5 text-slate-300 hover:text-red-500 transition-colors shrink-0" title="Delete template">
                    {deleting === t.id
                      ? <div className="w-4 h-4 border-2 border-red-300 border-t-transparent rounded-full animate-spin" />
                      : <Trash2 size={15} />}
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* ── Apply view ── */}
          {view === 'apply' && selected && (
            <div className="space-y-3">
              <p className="text-[11px] text-slate-500 mb-4">
                The following {selected.items.filter(i => !i.parent_item_id).length} tasks will be created with dates calculated from the project.
              </p>
              {selected.items.filter(i => !i.parent_item_id).map(item => (
                <div key={item.id} className="flex items-start gap-3 px-4 py-3 bg-slate-50 rounded-2xl">
                  <CheckSquare size={14} className="text-indigo-400 mt-0.5 shrink-0" />
                  <div className="flex-1">
                    <p className="text-[12px] font-medium text-slate-800">{item.title}</p>
                    <div className="flex items-center gap-3 mt-1 flex-wrap">
                      {item.due_offset_days !== null && (
                        <span className="text-[10px] text-slate-400 flex items-center gap-1">
                          <Calendar size={9} />
                          {item.due_offset_days === 0 ? 'On ' : item.due_offset_days > 0 ? `+${item.due_offset_days}d from ` : `${item.due_offset_days}d from `}
                          {ANCHORS.find(a => a.value === item.due_anchor)?.label || item.due_anchor}
                          {' → '}
                          <span className="font-medium text-indigo-600">{resolvedDates[item.id] ?? resolveDate(item) ?? '—'}</span>
                          {item.due_offset_mode === 'business' && (
                            <span className="text-slate-300"> ({item.due_offset_state} business days)</span>
                          )}
                        </span>
                      )}
                      {item.assignee_id && (
                        <span className="text-[10px] text-slate-400">
                          {profiles.find((p: any) => p.id === item.assignee_id)?.full_name || ''}
                        </span>
                      )}
                      {item.assigned_team_id && (
                        <span className="text-[10px] text-slate-400">
                          {teams.find((t: any) => t.id === item.assigned_team_id)?.team_name || ''}
                        </span>
                      )}
                      {item.is_monetary && item.estimated_cost > 0 && (
                        <span className="text-[10px] text-slate-400 flex items-center gap-1">
                          <DollarSign size={9} />${Number(item.estimated_cost).toLocaleString()}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* ── Create view ── */}
          {view === 'create' && (
            <div className="space-y-6">
              <div>
                <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">Template name</p>
                <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="e.g. Property Settlement"
                  className="w-full px-4 py-2.5 border border-slate-200 rounded-full text-[13px] outline-none focus:border-indigo-400" />
              </div>
              <div>
                <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-3">Tasks</p>
                <div className="space-y-3">
                  {newItems.map((item, idx) => (
                    <div key={idx} className="bg-slate-50 rounded-2xl p-4 space-y-3">
                      <div className="flex items-center gap-2">
                        <input value={item.title || ''} onChange={e => {
                          const next = [...newItems]; next[idx] = { ...next[idx], title: e.target.value }; setNewItems(next);
                        }} placeholder={`Task ${idx + 1} name...`}
                          className="flex-1 px-3 py-2 border border-slate-200 rounded-full text-[12px] outline-none focus:border-indigo-400 bg-white" />
                        <button onClick={() => setNewItems(newItems.filter((_, i) => i !== idx))}
                          className="p-1.5 text-slate-300 hover:text-red-500 transition-colors"><X size={12} /></button>
                      </div>
                      <div className="grid grid-cols-3 gap-2">
                        <div>
                          <p className="text-[9px] text-slate-400 mb-1">Offset days</p>
                          <input type="number" value={item.due_offset_days ?? 0} onChange={e => {
                            const next = [...newItems]; next[idx] = { ...next[idx], due_offset_days: parseInt(e.target.value) || 0 }; setNewItems(next);
                          }} className="w-full px-3 py-1.5 border border-slate-200 rounded-full text-[11px] outline-none bg-white" />
                        </div>
                        <div className="col-span-2">
                          <p className="text-[9px] text-slate-400 mb-1">From</p>
                          <select value={item.due_anchor || 'record_created'} onChange={e => {
                            const next = [...newItems]; next[idx] = { ...next[idx], due_anchor: e.target.value }; setNewItems(next);
                          }} className="w-full px-3 py-1.5 border border-slate-200 rounded-full text-[11px] outline-none bg-white">
                            {ANCHORS.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
                            {newItems.slice(0, idx).filter(i => i.title).map((i, prevIdx) => (
                              <option key={`task_${prevIdx}`} value={`task_${prevIdx}`}>After: {i.title || `Task ${prevIdx + 1}`}</option>
                            ))}
                          </select>
                        </div>
                      </div>
                      <div className={`grid gap-2 ${item.due_offset_mode === 'business' ? 'grid-cols-2' : 'grid-cols-1'}`}>
                        <div>
                          <p className="text-[9px] text-slate-400 mb-1">Day type</p>
                          <select value={item.due_offset_mode || 'calendar'} onChange={e => {
                            const next = [...newItems]; next[idx] = { ...next[idx], due_offset_mode: e.target.value as 'calendar' | 'business' }; setNewItems(next);
                          }} className="w-full px-3 py-1.5 border border-slate-200 rounded-full text-[11px] outline-none bg-white">
                            <option value="calendar">Calendar days</option>
                            <option value="business">Business days</option>
                          </select>
                        </div>
                        {item.due_offset_mode === 'business' && (
                          <div>
                            <p className="text-[9px] text-slate-400 mb-1">State</p>
                            <select value={item.due_offset_state || 'NSW'} onChange={e => {
                              const next = [...newItems]; next[idx] = { ...next[idx], due_offset_state: e.target.value }; setNewItems(next);
                            }} className="w-full px-3 py-1.5 border border-slate-200 rounded-full text-[11px] outline-none bg-white">
                              {AU_STATES.map(s => <option key={s} value={s}>{s}</option>)}
                            </select>
                          </div>
                        )}
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <p className="text-[9px] text-slate-400 mb-1">Assignee</p>
                          <select value={item.assignee_id || ''} onChange={e => {
                            const next = [...newItems]; next[idx] = { ...next[idx], assignee_id: e.target.value || null }; setNewItems(next);
                          }} className="w-full px-3 py-1.5 border border-slate-200 rounded-full text-[11px] outline-none bg-white">
                            <option value="">Unassigned</option>
                            {profiles.map((p: any) => <option key={p.id} value={p.id}>{p.full_name || p.email}</option>)}
                          </select>
                        </div>
                        <div>
                          <p className="text-[9px] text-slate-400 mb-1">Team</p>
                          <select value={item.assigned_team_id || ''} onChange={e => {
                            const next = [...newItems]; next[idx] = { ...next[idx], assigned_team_id: e.target.value || null }; setNewItems(next);
                          }} className="w-full px-3 py-1.5 border border-slate-200 rounded-full text-[11px] outline-none bg-white">
                            <option value="">No team</option>
                            {teams.map((t: any) => <option key={t.id} value={t.id}>{t.team_name}</option>)}
                          </select>
                        </div>
                      </div>
                    </div>
                  ))}
                  <button onClick={() => setNewItems([...newItems, { title: '', due_offset_days: 0, due_anchor: 'record_created', due_offset_mode: 'calendar', display_order: newItems.length }])}
                    className="w-full flex items-center gap-2 justify-center py-2.5 border border-dashed border-slate-300 text-slate-400 rounded-2xl hover:border-indigo-300 hover:text-indigo-600 transition-colors text-[12px]">
                    <Plus size={13} /> Add task
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ── Edit view ── */}
          {view === 'edit' && selected && (
            <div className="space-y-6">
              <div>
                <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">Template name</p>
                <input value={editName} onChange={e => setEditName(e.target.value)}
                  className="w-full px-4 py-2.5 border border-slate-200 rounded-full text-[13px] outline-none focus:border-indigo-400" />
              </div>
              <div>
                <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-3">Tasks</p>
                <div className="space-y-3">
                  {editItems.map((item, idx) => (
                    <div key={idx} className="bg-slate-50 rounded-2xl p-4 space-y-3">
                      <div className="flex items-center gap-2">
                        <input value={item.title || ''} onChange={e => {
                          const next = [...editItems]; next[idx] = { ...next[idx], title: e.target.value }; setEditItems(next);
                        }} placeholder={`Task ${idx + 1} name...`}
                          className="flex-1 px-3 py-2 border border-slate-200 rounded-full text-[12px] outline-none focus:border-indigo-400 bg-white" />
                        <button onClick={() => setEditItems(editItems.filter((_, i) => i !== idx))}
                          className="p-1.5 text-slate-300 hover:text-red-500 transition-colors"><X size={12} /></button>
                      </div>
                      <div className="grid grid-cols-3 gap-2">
                        <div>
                          <p className="text-[9px] text-slate-400 mb-1">Offset days</p>
                          <input type="number" value={item.due_offset_days ?? 0} onChange={e => {
                            const next = [...editItems]; next[idx] = { ...next[idx], due_offset_days: parseInt(e.target.value) || 0 }; setEditItems(next);
                          }} className="w-full px-3 py-1.5 border border-slate-200 rounded-full text-[11px] outline-none bg-white" />
                        </div>
                        <div className="col-span-2">
                          <p className="text-[9px] text-slate-400 mb-1">From</p>
                          <select value={item.due_anchor || 'record_created'} onChange={e => {
                            const next = [...editItems]; next[idx] = { ...next[idx], due_anchor: e.target.value }; setEditItems(next);
                          }} className="w-full px-3 py-1.5 border border-slate-200 rounded-full text-[11px] outline-none bg-white">
                            {ANCHORS.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
                          </select>
                        </div>
                      </div>
                      <div className={`grid gap-2 ${item.due_offset_mode === 'business' ? 'grid-cols-2' : 'grid-cols-1'}`}>
                        <div>
                          <p className="text-[9px] text-slate-400 mb-1">Day type</p>
                          <select value={item.due_offset_mode || 'calendar'} onChange={e => {
                            const next = [...editItems]; next[idx] = { ...next[idx], due_offset_mode: e.target.value as 'calendar' | 'business' }; setEditItems(next);
                          }} className="w-full px-3 py-1.5 border border-slate-200 rounded-full text-[11px] outline-none bg-white">
                            <option value="calendar">Calendar days</option>
                            <option value="business">Business days</option>
                          </select>
                        </div>
                        {item.due_offset_mode === 'business' && (
                          <div>
                            <p className="text-[9px] text-slate-400 mb-1">State</p>
                            <select value={item.due_offset_state || 'NSW'} onChange={e => {
                              const next = [...editItems]; next[idx] = { ...next[idx], due_offset_state: e.target.value }; setEditItems(next);
                            }} className="w-full px-3 py-1.5 border border-slate-200 rounded-full text-[11px] outline-none bg-white">
                              {AU_STATES.map(s => <option key={s} value={s}>{s}</option>)}
                            </select>
                          </div>
                        )}
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <p className="text-[9px] text-slate-400 mb-1">Assignee</p>
                          <select value={item.assignee_id || ''} onChange={e => {
                            const next = [...editItems]; next[idx] = { ...next[idx], assignee_id: e.target.value || null }; setEditItems(next);
                          }} className="w-full px-3 py-1.5 border border-slate-200 rounded-full text-[11px] outline-none bg-white">
                            <option value="">Unassigned</option>
                            {profiles.map((p: any) => <option key={p.id} value={p.id}>{p.full_name || p.email}</option>)}
                          </select>
                        </div>
                        <div>
                          <p className="text-[9px] text-slate-400 mb-1">Team</p>
                          <select value={item.assigned_team_id || ''} onChange={e => {
                            const next = [...editItems]; next[idx] = { ...next[idx], assigned_team_id: e.target.value || null }; setEditItems(next);
                          }} className="w-full px-3 py-1.5 border border-slate-200 rounded-full text-[11px] outline-none bg-white">
                            <option value="">No team</option>
                            {teams.map((t: any) => <option key={t.id} value={t.id}>{t.team_name}</option>)}
                          </select>
                        </div>
                      </div>
                    </div>
                  ))}
                  <button onClick={() => setEditItems([...editItems, { title: '', due_offset_days: 0, due_anchor: 'record_created', due_offset_mode: 'calendar', display_order: editItems.length }])}
                    className="w-full flex items-center gap-2 justify-center py-2.5 border border-dashed border-slate-300 text-slate-400 rounded-2xl hover:border-indigo-300 hover:text-indigo-600 transition-colors text-[12px]">
                    <Plus size={13} /> Add task
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="px-8 py-5 border-t border-slate-100 shrink-0">
          {view === 'apply' && (
            <button onClick={handleApply} disabled={saving}
              className="w-full py-3 bg-indigo-600 text-white text-[12px] font-bold rounded-full hover:bg-indigo-700 disabled:opacity-40 transition-colors">
              {saving ? 'Creating tasks...' : `Apply template — ${selected?.items.filter(i => !i.parent_item_id).length} tasks`}
            </button>
          )}
          {view === 'create' && (
            <button onClick={handleSaveNew} disabled={saving || !newName.trim()}
              className="w-full py-3 bg-indigo-600 text-white text-[12px] font-bold rounded-full hover:bg-indigo-700 disabled:opacity-40 transition-colors">
              {saving ? 'Saving...' : 'Save template'}
            </button>
          )}
          {view === 'edit' && (
            <button onClick={handleSaveEdit} disabled={saving || !editName.trim()}
              className="w-full py-3 bg-indigo-600 text-white text-[12px] font-bold rounded-full hover:bg-indigo-700 disabled:opacity-40 transition-colors">
              {saving ? 'Saving...' : 'Save changes'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── ChecklistTab (main) ────────────────────────────────────────────
export default function ChecklistTab({ recordId, companyId }: Props) {
  const [tasks, setTasks]               = useState<Task[]>([]);
  const [profiles, setProfiles]         = useState<Profile[]>([]);
  const [teams, setTeams]               = useState<Team[]>([]);
  const [statuses, setStatuses]         = useState<Status[]>([]);
  const [templates, setTemplates]       = useState<Template[]>([]);
  const [project, setProject]           = useState<any>(null);
  const [loading, setLoading]           = useState(true);
  const [editingTask, setEditingTask]   = useState<Partial<Task> | null>(null);
  const [showTemplates, setShowTemplates] = useState(false);
  const [showCompleted, setShowCompleted] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [
      { data: taskData }, { data: profileData }, { data: teamData },
      { data: statusData }, { data: templateData }, { data: projectData },
    ] = await Promise.all([
      supabase.from('tasks').select('*').eq('project_id', recordId).is('deleted_at', null).order('date_entered'),
      supabase.from('profiles').select('id, full_name, email').eq('is_active', true),
      supabase.from('teams').select('id, team_name').eq('is_active', true),
      supabase.from('task_statuses').select('*').eq('is_active', true),
      supabase.from('checklist_templates').select('*, items:checklist_template_items(*)').eq('company_id', companyId).order('created_at'),
      supabase.from('projects').select('created_at, estimated_completion_date').eq('id', recordId).single(),
    ]);
    setTasks(taskData || []);
    setProfiles(profileData || []);
    setTeams(teamData || []);
    setStatuses(statusData || []);
    setProject(projectData);
    setTemplates((templateData || []).map((t: any) => ({
      ...t, items: (t.items || []).sort((a: any, b: any) => a.display_order - b.display_order),
    })));
    setLoading(false);
  }, [recordId, companyId]);

  useEffect(() => { load(); }, [load]);

  const handleAddTask = (parentId?: string) => {
    setEditingTask({ project_id: recordId, company_id: companyId, parent_task_id: parentId || null, is_completed: false, is_monetary: false, estimated_cost: 0, reminder_settings: { days: 0, time: '09:00' } });
  };

  const handleSaveTask = async (draft: Partial<Task>) => {
    if (draft.id) {
      const { id, ...rest } = draft;
      await supabase.from('tasks').update(rest).eq('id', id);
      setTasks(prev => prev.map(t => t.id === id ? { ...t, ...rest } : t));
    } else {
      const { data: { user } } = await supabase.auth.getUser();
      const { data } = await supabase.from('tasks').insert({
        ...draft,
        created_by: user?.id,
        date_entered: new Date().toISOString().split('T')[0],
      }).select().single();
      if (data) setTasks(prev => [...prev, data]);
    }
  };

  const handleUpdate = async (id: string, patch: Partial<Task>) => {
    await supabase.from('tasks').update(patch).eq('id', id);
    setTasks(prev => prev.map(t => t.id === id ? { ...t, ...patch } : t));
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('Delete this task?')) return;
    await supabase.from('tasks').update({ deleted_at: new Date().toISOString() }).eq('id', id);
    setTasks(prev => prev.filter(t => t.id !== id));
  };

  const handleApplyTemplate = async (tasksToCreate: Partial<Task>[]) => {
    if (!tasksToCreate.length) return;
    const { data: { user } } = await supabase.auth.getUser();
    const rows = tasksToCreate.map((t) => {
      const { display_order, ...rest } = t as any;
      return {
        ...rest,
        created_by: user?.id,
        date_entered: new Date().toISOString().split('T')[0],
      };
    });
    const { data, error } = await supabase.from('tasks').insert(rows).select();
    if (error) {
      console.error('[apply] Insert error:', error);
      alert(`Failed to apply template: ${error.message}`);
      return;
    }
    if (data) setTasks(prev => [...prev, ...data]);
  };

  const handleSaveTemplate = async (name: string, items: Partial<TemplateItem>[]) => {
    const { data: tpl } = await supabase.from('checklist_templates').insert({ company_id: companyId, name, record_table: 'projects' }).select().single();
    if (!tpl) return;
    await supabase.from('checklist_template_items').insert(items.map((item, i) => ({ ...item, template_id: tpl.id, display_order: i })));
    load();
  };

  const rootTasks = tasks.filter(t => !t.parent_task_id);
  const activeTasks = rootTasks.filter(t => !t.is_completed);
  const completedTasks = rootTasks.filter(t => t.is_completed);
  const totalCost = tasks.filter(t => t.is_monetary).reduce((s, t) => s + (t.estimated_cost || 0), 0);
  const completedCount = tasks.filter(t => t.is_completed).length;
  const progress = tasks.length ? Math.round(completedCount / tasks.length * 100) : 0;

  if (loading) return <p className="text-[11px] text-slate-400 text-center py-8">Loading checklist...</p>;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div>
            <p className="text-[11px] font-bold text-slate-700">{completedCount}/{tasks.length} tasks</p>
            <div className="mt-1 w-32 h-1.5 bg-slate-100 rounded-full overflow-hidden">
              <div className="h-full bg-indigo-500 rounded-full transition-all" style={{ width: `${progress}%` }} />
            </div>
          </div>
          {totalCost > 0 && <div className="text-[11px] text-slate-500"><DollarSign size={11} className="inline" />{totalCost.toLocaleString()} est.</div>}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowTemplates(true)}
            className="flex items-center gap-1.5 px-3 py-2 text-[11px] text-slate-500 font-medium border border-slate-200 rounded-full hover:border-indigo-300 hover:text-indigo-600 transition-colors">
            <Copy size={12} /> Templates {templates.length > 0 && <span className="ml-0.5 text-slate-400">({templates.length})</span>}
          </button>
          <button onClick={() => handleAddTask()}
            className="flex items-center gap-1.5 px-4 py-2 bg-indigo-600 text-white text-[11px] font-bold rounded-full hover:bg-indigo-700 transition-colors">
            <Plus size={13} /> Add task
          </button>
        </div>
      </div>

      {/* Empty state */}
      {activeTasks.length === 0 && completedTasks.length === 0 && (
        <div className="text-center py-16">
          <CheckSquare size={32} className="text-slate-200 mx-auto mb-3" />
          <p className="text-[11px] text-slate-300 font-bold uppercase tracking-widest mb-3">No tasks yet</p>
          <div className="flex items-center justify-center gap-2">
            <button onClick={() => handleAddTask()} className="px-5 py-2.5 bg-indigo-600 text-white rounded-full text-[11px] font-bold hover:bg-indigo-700 transition-colors">Add first task</button>
            {templates.length > 0 && (
              <button onClick={() => setShowTemplates(true)} className="px-5 py-2.5 border border-slate-200 text-slate-600 rounded-full text-[11px] font-bold hover:border-indigo-300 hover:text-indigo-600 transition-colors">Apply template</button>
            )}
          </div>
        </div>
      )}

      {/* Active tasks */}
      {activeTasks.length > 0 && (
        <div className="space-y-1">
          {activeTasks.map(task => (
            <TaskRow key={task.id} task={task} subtasks={tasks.filter(t => t.parent_task_id === task.id)}
              allTasks={tasks} profiles={profiles} teams={teams} statuses={statuses} depth={0}
              onUpdate={handleUpdate} onDelete={handleDelete} onAddSubtask={handleAddTask} onEdit={(t: Task) => setEditingTask(t)} />
          ))}
        </div>
      )}

      {/* Completed */}
      {completedTasks.length > 0 && (
        <div>
          <button onClick={() => setShowCompleted(p => !p)} className="flex items-center gap-2 text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">
            {showCompleted ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Completed ({completedTasks.length})
          </button>
          {showCompleted && (
            <div className="space-y-1 opacity-70">
              {completedTasks.map(task => (
                <TaskRow key={task.id} task={task} subtasks={tasks.filter(t => t.parent_task_id === task.id)}
                  allTasks={tasks} profiles={profiles} teams={teams} statuses={statuses} depth={0}
                  onUpdate={handleUpdate} onDelete={handleDelete} onAddSubtask={handleAddTask} onEdit={(t: Task) => setEditingTask(t)} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Modals */}
      {editingTask && (
        <TaskEditModal task={editingTask} profiles={profiles} teams={teams} statuses={statuses}
          companyId={companyId} projectId={recordId} onSave={handleSaveTask} onClose={() => setEditingTask(null)} />
      )}
      {showTemplates && (
        <TemplateModal
          templates={templates}
          setTemplates={setTemplates}
          profiles={profiles} teams={teams} companyId={companyId} projectId={recordId}
          projectCreatedAt={project?.created_at || new Date().toISOString()}
          projectDueDate={project?.estimated_completion_date || null}
          tasks={tasks} onApply={handleApplyTemplate} onSaveNew={handleSaveTemplate}
          onClose={() => { setShowTemplates(false); }}
        />
      )}
    </div>
  );
}