"use client";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { Plus, ListChecks, Calendar as CalIcon, GanttChartSquare, MapPin, Clock, Users, Loader2, Share2, ClipboardList, History } from "lucide-react";
import TaskItem from "@/components/TaskItem";
import CalendarModule from "@/components/CalendarModule";
import AddTaskModal from "@/components/AddTaskModal";

export const dynamic = 'force-dynamic';

function ProjectContent() {
  const searchParams = useSearchParams();
  const projectId = searchParams.get("id");
  const [userProfile, setUserProfile] = useState<any>(null);
  const [project, setProject] = useState<any>(null);
  const [tasks, setTasks] = useState<any[]>([]);
  const [logs, setLogs] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState("checklist");
  const [isTaskModalOpen, setIsTaskModalOpen] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function init() {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const { data } = await supabase.from("profiles").select("*").eq("id", user.id).single();
        setUserProfile(data);
      }
    }
    init();
  }, []);

  useEffect(() => {
    if (projectId) { fetchDetails(); fetchLogs(); }
  }, [projectId, activeTab, userProfile]);

  const fetchDetails = async () => {
    setLoading(true);
    const { data: proj } = await supabase.from("projects").select(`*, properties (*), project_members (count), project_teams (count)`).eq("id", projectId).single();
    if (proj) setProject(proj);
    const { data: tsk } = await supabase.from("tasks").select(`*, task_statuses ( label )`).eq("project_id", projectId).is("deleted_at", null).order("due_date", { ascending: true });
    if (tsk) setTasks(tsk);
    setLoading(false);
  };

  const fetchLogs = async () => {
    const { data } = await supabase.from("audit_logs").select(`*, profiles:user_id ( full_name )`).eq("project_id", projectId).order('created_at', { ascending: false });
    if (data) setLogs(data);
  };

  if (!projectId) return (
    <div className="h-full flex flex-col items-center justify-center p-12 text-center bg-white font-sans antialiased">
      <div className="w-20 h-20 bg-slate-900 rounded-[32px] flex items-center justify-center shadow-2xl mb-8"><div className="w-8 h-8 rounded-full border-4 border-white opacity-20" /></div>
      <h2 className="text-3xl font-black italic tracking-tighter text-slate-900">Portfolio Workspace</h2>
      <p className="max-w-md text-slate-400 font-medium mt-4">{userProfile?.company_id ? `Niksen Time Pty Ltd Environment.` : "Independent workspace active. Create a project to begin."}</p>
    </div>
  );

  return (
    <div className="flex flex-col h-screen bg-[#fcfcfd] font-sans antialiased overflow-hidden">
      <header className="p-8 md:px-12 md:pt-12 md:pb-8 shrink-0">
        <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-8 mb-10">
          <div>
            <div className="flex items-center gap-3 mb-4"><span className="px-3 py-1 bg-indigo-600 text-white rounded-full text-[9px] font-black uppercase tracking-widest italic shadow-lg">Niksen Time Pty Ltd</span></div>
            <h1 className="text-5xl font-black tracking-tighter text-slate-900 italic leading-none">{project?.name}</h1>
            <div className="flex flex-wrap gap-8 text-slate-500 font-bold text-[11px] uppercase tracking-wider mt-6">
              <div className="flex items-center gap-2 font-black"><MapPin size={14} className="text-indigo-500" /> {project?.properties?.street_address}, {project?.properties?.suburb}</div>
              <div className="flex items-center gap-2 border-l pl-8 border-slate-200">Completion: <span className="text-black font-black underline decoration-2">{project?.estimated_completion_date || 'TBD'}</span></div>
            </div>
          </div>
          <button onClick={() => setIsTaskModalOpen(true)} className="flex items-center gap-3 bg-black text-white px-10 py-5 rounded-full text-sm font-black shadow-xl hover:bg-slate-800 active:scale-95 transition-all"><Plus size={22} strokeWidth={3} /><span>New Task</span></button>
        </div>
        <div className="flex p-1.5 bg-slate-200/50 rounded-full w-fit border border-slate-200 backdrop-blur-md">
          {[{ id: 'checklist', label: 'Checklist', icon: ListChecks }, { id: 'calendar', label: 'Calendar', icon: CalIcon }, { id: 'log', label: 'Change Log', icon: ClipboardList }].map((tab) => (
            <button key={tab.id} onClick={() => setActiveTab(tab.id)} className={`flex items-center gap-3 px-10 py-2.5 rounded-full text-[11px] font-black uppercase tracking-widest transition-all duration-300 ${activeTab === tab.id ? "bg-white text-black shadow-xl" : "text-slate-400 hover:text-slate-600"}`}>
              <tab.icon size={16} strokeWidth={activeTab === tab.id ? 3 : 2} /> {tab.label}
            </button>
          ))}
        </div>
      </header>
      <main className="flex-1 px-8 md:px-12 pb-10 min-h-0">
        <div className="h-full bg-white border border-slate-100 rounded-[56px] shadow-sm p-10 flex flex-col overflow-hidden relative">
          {loading ? <div className="flex items-center justify-center h-full"><Loader2 className="animate-spin text-slate-200" size={48} /></div> : (
            <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar">
              {activeTab === "checklist" && <div className="max-w-4xl mx-auto space-y-2 py-4 animate-in fade-in zoom-in-95">{tasks.map(t => <TaskItem key={t.id} task={t} onRefresh={fetchDetails} />)}</div>}
              {activeTab === "calendar" && <CalendarModule tasks={tasks} />}
              {activeTab === "log" && (
                <div className="max-w-4xl mx-auto space-y-6 py-6 animate-in slide-in-from-bottom-8">
                  <h3 className="text-3xl font-black italic tracking-tighter mb-10">Activity Logs</h3>
                  {logs.map((log) => (
                    <div key={log.id} className="relative pl-12 group mb-6">
                      <div className="absolute left-[19px] top-4 bottom-0 w-0.5 bg-slate-100 group-last:bg-transparent" />
                      <div className="absolute left-0 top-1 w-10 h-10 rounded-full bg-white border-2 border-slate-100 z-10 flex items-center justify-center font-black text-[9px] text-indigo-600 uppercase italic shadow-sm">{log.profiles?.full_name?.substring(0, 2)}</div>
                      <div className="bg-slate-50 border border-slate-100 rounded-[28px] p-6 shadow-sm hover:shadow-md transition-all">
                        <p className="text-[14px] text-slate-600 font-medium"><span className="font-black text-slate-900">{log.profiles?.full_name}</span> <span className="mx-1 text-slate-400 italic">{log.action.toLowerCase()}</span> <span className="font-black text-indigo-600">"{log.details?.task_name || 'Item'}"</span></p>
                        <div className="flex items-center gap-2 text-[10px] text-slate-300 font-bold uppercase mt-2 italic tracking-widest"><History size={12} /> {new Date(log.created_at).toLocaleString('en-AU')}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </main>
      <AddTaskModal isOpen={isTaskModalOpen} onClose={() => setIsTaskModalOpen(false)} onRefresh={fetchDetails} projectId={projectId} />
    </div>
  );
}

export default function ProjectsPage() {
  return <Suspense fallback={<div className="p-20 text-center font-black italic">Loading Workspace...</div>}><ProjectContent /></Suspense>;
}