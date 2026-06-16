"use client";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { 
  Plus, 
  ListChecks, 
  Calendar as CalIcon, 
  GanttChartSquare, 
  MapPin, 
  Clock, 
  Users, 
  Loader2, 
  Share2, 
  ClipboardList, 
  History 
} from "lucide-react";

// Local Component Imports
import TaskItem from "../../../components/TaskItem";
import CalendarModule from "../../../components/CalendarModule";
import AddTaskModal from "../../../components/AddTaskModal";
import { usePermission } from "../../../hooks/usePermission";

// --- VERCEL BUILD FIX ---
// This tells Vercel: "Do not try to pre-build this page. Only build it when a user visits."
export const dynamic = 'force-dynamic';

function ProjectDashboardContent() {
  const searchParams = useSearchParams();
  const projectId = searchParams.get("id");
  
  const [userProfile, setUserProfile] = useState<any>(null);
  const [project, setProject] = useState<any>(null);
  const [tasks, setTasks] = useState<any[]>([]);
  const [logs, setLogs] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState("checklist");
  const [isTaskModalOpen, setIsTaskModalOpen] = useState(false);
  const [loading, setLoading] = useState(true);

  // Authority Check
  const canShare = usePermission('share_project');

  // 1. Initial User Profile Fetch
  useEffect(() => {
    async function initUser() {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const { data } = await supabase.from("profiles").select("*").eq("id", user.id).single();
        setUserProfile(data);
      }
    }
    initUser();
  }, []);

  // 2. Data Fetching (Stable dependency array to avoid React Console errors)
  useEffect(() => {
    if (projectId && userProfile) {
      fetchDetails();
      fetchLogs();
    }
  }, [projectId, activeTab, userProfile]);

  const fetchDetails = async () => {
    setLoading(true);
    const { data: proj } = await supabase
      .from("projects")
      .select(`*, properties (*), project_members (count), project_teams (count)`)
      .eq("id", projectId)
      .single();
    
    if (proj) setProject(proj);

    const { data: tsk } = await supabase
      .from("tasks")
      .select(`*, task_statuses ( label )`)
      .eq("project_id", projectId)
      .is("deleted_at", null)
      .order("due_date", { ascending: true });
    
    if (tsk) setTasks(tsk);
    setLoading(false);
  };

  const fetchLogs = async () => {
    const { data } = await supabase
      .from("audit_logs")
      .select(`*, profiles:user_id ( full_name )`)
      .eq("project_id", projectId)
      .order('created_at', { ascending: false });
    if (data) setLogs(data);
  };

  const handleShare = async () => {
    const email = prompt("Enter email of the personnel to grant project access:");
    if (!email) return;
    const { data: targetUser } = await supabase.from("profiles").select("id").eq("email", email).single();
    if (targetUser) {
      await supabase.from("project_members").insert([{ project_id: projectId, profile_id: targetUser.id }]);
      alert("Project shared successfully.");
    } else {
      alert("User not found in Niksen Database.");
    }
  };

  // Welcome screen if no project selected
  if (!projectId) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-12 text-center bg-white font-sans antialiased">
        <div className="w-24 h-24 bg-slate-900 rounded-[40px] flex items-center justify-center shadow-2xl mb-10 rotate-3 transition-transform hover:rotate-0">
           <div className="w-10 h-10 rounded-full border-4 border-white opacity-20" />
        </div>
        <h2 className="text-4xl font-black italic tracking-tighter text-slate-900">Portfolio Workspace</h2>
        <p className="max-w-md text-slate-400 font-medium mt-4 text-[15px]">
          {userProfile?.company_id 
            ? "Corporate environment active. Select a property portfolio from the tree to begin." 
            : "Independent workspace active. Create a project to begin building your portfolio."}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-[#fcfcfd] font-sans antialiased overflow-hidden selection:bg-black selection:text-white">
      {/* 1. PROJECT HEADER */}
      <header className="p-8 md:px-12 md:pt-12 md:pb-8 shrink-0">
        <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-8 mb-10">
          <div>
            <div className="flex items-center gap-3 mb-4">
               <span className="px-3 py-1 bg-indigo-600 text-white rounded-full text-[9px] font-black uppercase tracking-widest italic shadow-lg">Niksen Time Pty Ltd</span>
               <span className="text-slate-300 font-black">•</span>
               <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest italic">Asset Management</span>
            </div>
            <h1 className="text-5xl font-black tracking-tighter text-slate-900 italic leading-none">{project?.name || "Loading..."}</h1>
            
            <div className="flex flex-wrap gap-8 text-slate-500 font-bold text-[11px] uppercase tracking-wider mt-6">
              <div className="flex items-center gap-2 font-black"><MapPin size={14} className="text-indigo-500" /> {project?.properties?.street_address}, {project?.properties?.suburb}</div>
              <div className="flex items-center gap-2"><Users size={14} /> {project?.project_members?.[0]?.count || 1} Staff • {project?.project_teams?.[0]?.count || 0} Teams</div>
              <div className="flex items-center gap-2 border-l pl-8 border-slate-200">Completion: <span className="text-black font-black underline decoration-2">{project?.estimated_completion_date || 'TBD'}</span></div>
            </div>
          </div>

          <div className="flex items-center gap-4">
            {canShare && (
              <button onClick={handleShare} className="p-4 rounded-full bg-white border border-slate-100 text-slate-400 hover:text-black hover:shadow-xl transition-all flex items-center gap-2 group">
                <Share2 size={20} className="group-hover:scale-110 transition-transform" />
                <span className="text-[11px] font-black uppercase pr-2">Share</span>
              </button>
            )}
            <button onClick={() => setIsTaskModalOpen(true)} className="flex items-center gap-3 bg-black text-white px-10 py-5 rounded-full text-sm font-black shadow-xl hover:bg-slate-800 active:scale-95 transition-all">
              <Plus size={22} strokeWidth={3} />
              <span>New Task</span>
            </button>
          </div>
        </div>

        {/* 2. TAB SWITCHER */}
        <div className="flex p-1.5 bg-slate-200/50 rounded-full w-fit border border-slate-200 backdrop-blur-md">
          {[
            { id: 'checklist', label: 'Checklist', icon: ListChecks },
            { id: 'calendar', label: 'Calendar', icon: CalIcon },
            { id: 'log', label: 'Change Log', icon: ClipboardList }
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-3 px-10 py-2.5 rounded-full text-[11px] font-black uppercase tracking-widest transition-all duration-300 ${
                activeTab === tab.id ? "bg-white text-black shadow-xl" : "text-slate-400 hover:text-slate-600"
              }`}
            >
              <tab.icon size={16} strokeWidth={activeTab === tab.id ? 3 : 2} /> {tab.label}
            </button>
          ))}
        </div>
      </header>

      {/* 3. MAIN DASHBOARD AREA */}
      <main className="flex-1 px-8 md:px-12 pb-10 min-h-0">
        <div className="h-full bg-white border border-slate-100 rounded-[56px] shadow-[0_0_100px_rgba(0,0,0,0.02)] p-10 flex flex-col overflow-hidden relative">
          
          {loading ? (
            <div className="flex items-center justify-center h-full"><Loader2 className="animate-spin text-slate-200" size={48} /></div>
          ) : (
            <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar">
              {activeTab === "checklist" && (
                <div className="max-w-4xl mx-auto space-y-2 py-4 animate-in fade-in zoom-in-95">
                  {tasks.length > 0 ? tasks.map(t => <TaskItem key={t.id} task={t} onRefresh={fetchDetails} />) : (
                    <div className="py-20 text-center text-slate-300 font-bold italic border-4 border-dashed border-slate-50 rounded-[48px]">No Tasks In Portfolio</div>
                  )}
                </div>
              )}

              {activeTab === "calendar" && <CalendarModule tasks={tasks} />}

              {activeTab === "log" && (
                <div className="max-w-4xl mx-auto space-y-6 py-6 animate-in slide-in-from-bottom-8">
                  <h3 className="text-3xl font-black italic tracking-tighter mb-10">Operation Logs</h3>
                  {logs.map((log) => (
                    <div key={log.id} className="relative pl-12 group mb-6">
                      <div className="absolute left-[19px] top-4 bottom-0 w-0.5 bg-slate-100 group-last:bg-transparent" />
                      <div className="absolute left-0 top-1 w-10 h-10 rounded-full bg-white border-2 border-slate-100 z-10 flex items-center justify-center font-black text-[9px] text-indigo-600 uppercase italic shadow-sm">
                        {log.profiles?.full_name?.substring(0, 2)}
                      </div>
                      <div className="bg-slate-50 border border-slate-100 rounded-[28px] p-6 shadow-sm hover:shadow-md transition-all">
                        <p className="text-[14px] text-slate-600 font-medium">
                          <span className="font-black text-slate-900">{log.profiles?.full_name}</span> 
                          <span className="mx-1 text-slate-400 italic">{log.action.toLowerCase()}</span> 
                          <span className="font-black text-indigo-600 tracking-tight">"{log.details?.task_name || 'Project'}"</span>
                        </p>
                        <div className="flex items-center gap-2 text-[10px] text-slate-300 font-bold uppercase mt-2 tracking-widest italic">
                          <History size={12} /> {new Date(log.created_at).toLocaleString('en-AU')}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </main>

      {/* Task Creation Modal */}
      <AddTaskModal 
        isOpen={isTaskModalOpen} 
        onClose={() => setIsTaskModalOpen(false)} 
        onRefresh={fetchDetails} 
        projectId={projectId} 
      />
    </div>
  );
}

// THE FINAL EXPORT
export default function ProjectsPage() {
  return (
    <Suspense fallback={
      <div className="h-full w-full flex items-center justify-center bg-white font-black italic text-slate-200 uppercase tracking-widest">
        Loading niksen-flow...
      </div>
    }>
      <ProjectDashboardContent />
    </Suspense>
  );
}