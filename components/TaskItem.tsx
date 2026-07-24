"use client";

import { useState, useEffect } from "react";
import { 
  ChevronDown, ChevronUp, Circle, CheckCircle2, 
  Clock, Users, DollarSign, Bell, Trash2, Tag, User 
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useCompany } from "@/components/CompanyContext";
import { createArchiveRequest } from "@/lib/archiveRequests";

export default function TaskItem({ task, onRefresh }: { task: any; onRefresh: () => void }) {
  const { isAdmin, companyId } = useCompany();
  const [isExpanded, setIsExpanded] = useState(false);
  const [hasPendingArchiveRequest, setHasPendingArchiveRequest] = useState(false);

  useEffect(() => {
    supabase.from("archive_requests")
      .select("id", { head: true, count: "exact" })
      .eq("entity_table", "tasks")
      .eq("entity_id", task.id)
      .eq("status", "pending")
      .then(({ count }) => setHasPendingArchiveRequest(!!count));
  }, [task.id]);

  const getStatusStyles = (label: string) => {
    if (label === 'Urgent') return 'bg-red-50 text-red-600 border-red-100';
    if (label === 'Important') return 'bg-amber-50 text-amber-600 border-amber-100';
    return 'bg-blue-50 text-blue-600 border-blue-100';
  };

  const logAudit = async (action: string, details: any) => {
    const { data: { user } } = await supabase.auth.getUser();
    await supabase.from("audit_logs").insert([{
      project_id: task.project_id,
      user_id: user?.id,
      action: action,
      details: details
    }]);
  };

  const handleArchive = async (e: React.MouseEvent) => {
    e.stopPropagation();

    if (!isAdmin) {
      if (!window.confirm(`Request archiving "${task.name}"? A company admin will need to approve it.`)) return;
      if (!companyId) return;
      const result = await createArchiveRequest("tasks", task.id, task.name, companyId);
      if (!result.ok) { alert(result.error); return; }
      setHasPendingArchiveRequest(true);
      alert(result.alreadyPending ? "Already requested — waiting on admin review." : "Archive requested — a company admin will review it.");
      return;
    }

    const { error } = await supabase.from("tasks").update({ deleted_at: new Date().toISOString() }).eq("id", task.id);
    if (!error) {
      await logAudit("Archived task", { task_name: task.name });
      onRefresh();
    }
  };

  const toggleComplete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const newStatus = !task.is_completed;
    const { error } = await supabase.from("tasks").update({ is_completed: newStatus }).eq("id", task.id);
    if (!error) {
      await logAudit(newStatus ? "Completed task" : "Restored task", { task_name: task.name });
      onRefresh();
    }
  };

  return (
    <div className="mb-4 overflow-hidden rounded-[32px] border border-slate-100 bg-white shadow-sm transition-all hover:border-slate-300 group font-sans">
      <div className="flex items-center justify-between px-8 py-6 cursor-pointer select-none" onClick={() => setIsExpanded(!isExpanded)}>
        <div className="flex items-center gap-6">
          <button onClick={toggleComplete} className="transition-all active:scale-75">
            {task.is_completed ? <CheckCircle2 size={26} className="text-emerald-500" /> : <Circle size={26} className="text-slate-200" />}
          </button>
          <div>
            <h3 className={`font-bold text-[16px] tracking-tight ${task.is_completed ? 'line-through text-slate-300' : 'text-slate-800'}`}>{task.name}</h3>
            <div className="flex gap-2 mt-2">
               <span className={`text-[9px] font-black uppercase px-2.5 py-1 rounded-full border shadow-sm ${getStatusStyles(task.task_statuses?.label)}`}>
                 {task.task_statuses?.label || 'Standard'}
               </span>
               {task.is_monetary && <span className="text-[9px] font-black uppercase px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-600 border border-emerald-100 shadow-sm">$ Monetary</span>}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-8">
          <div className="hidden md:flex flex-col items-end">
            <span className="text-[10px] font-black text-slate-300 uppercase tracking-widest leading-none mb-1.5 italic">Deadline</span>
            <span className="text-[13px] font-black text-slate-700 italic uppercase">
              {task.due_date ? new Date(task.due_date).toLocaleDateString('en-AU') : 'N/A'}
              {task.due_time && <span className="text-indigo-500 ml-2">@ {task.due_time.slice(0, 5)}</span>}
            </span>
          </div>
          <div className={`p-2.5 rounded-full transition-all ${isExpanded ? 'bg-black text-white' : 'bg-slate-50 text-slate-400 group-hover:bg-slate-100'}`}>
            {isExpanded ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
          </div>
        </div>
      </div>

      {isExpanded && (
        <div className="px-12 pb-12 pt-4 animate-in fade-in slide-in-from-top-6 duration-500 border-t border-slate-50 mt-2">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-12 mt-8">
            <div className="space-y-6">
              <div className="flex items-start gap-4">
                <div className="p-3 bg-slate-50 rounded-2xl text-slate-400"><Clock size={20} /></div>
                <div><p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 italic">Date Logged</p><p className="text-[13px] font-bold text-slate-900">{task.date_entered || 'N/A'}</p></div>
              </div>
              <div className="flex items-start gap-4">
                <div className="p-3 bg-emerald-50 rounded-2xl text-emerald-600"><DollarSign size={20} /></div>
                <div><p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 italic">Est. Impact</p><p className="text-[14px] font-black text-slate-900 tracking-tighter italic">${task.estimated_cost?.toLocaleString() || '0.00'}</p></div>
              </div>
            </div>
            <div className="space-y-6">
              <div className="flex items-start gap-4">
                <div className="p-3 bg-indigo-50 rounded-2xl text-indigo-600"><Users size={20} /></div>
                <div><p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 italic">Responsibility</p><p className="text-[13px] font-bold text-slate-900">{task.responsible_team || 'Asset Mgmt'}</p><p className="text-[11px] text-indigo-500 font-bold mt-1">Assignee: {task.assigned_to || 'Unassigned'}</p></div>
              </div>
              <div className="flex items-start gap-4">
                <div className="p-3 bg-amber-50 rounded-2xl text-amber-600"><Bell size={20} /></div>
                <div><p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 italic">Reminder</p><p className="text-[13px] font-bold text-slate-900">{task.reminder_setting || 'None'}</p></div>
              </div>
            </div>
            <div className="flex flex-col justify-end gap-3">
              <button className="w-full py-4 bg-black text-white text-[11px] font-black uppercase tracking-widest rounded-full shadow-xl hover:bg-slate-800 transition-all">Save Changes</button>
              {hasPendingArchiveRequest ? (
                <span className="w-full py-4 text-center text-amber-600 bg-amber-50 text-[11px] font-black uppercase rounded-full">Archive requested</span>
              ) : (
                <button onClick={handleArchive} className="w-full py-4 border border-slate-200 text-slate-400 text-[11px] font-black uppercase rounded-full hover:text-red-600 hover:border-red-100 transition-all flex items-center justify-center gap-2 group"><Trash2 size={16} /> Archive Task</button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}