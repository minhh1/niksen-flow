"use client";

import { useState, useEffect } from "react";
import { supabase } from "@/lib/supabase";
import { CheckCircle2, Circle, Briefcase, Clock, RotateCcw, Archive, AlertCircle, Loader2 } from "lucide-react";

export const dynamic = 'force-dynamic';

export default function AllTasksPage() {
  const [view, setView] = useState<"active" | "archived">("active");
  const [tasks, setTasks] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchTasks = async () => {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    let query = supabase.from("tasks").select(`*, projects ( name ), task_statuses ( label )`).eq("created_by", user?.id).order("due_date", { ascending: true });
    if (view === "active") query = query.is("deleted_at", null);
    else query = query.not("deleted_at", "is", null);
    const { data } = await query;
    if (data) setTasks(data);
    setLoading(false);
  };

  useEffect(() => { fetchTasks(); }, [view]);

  return (
    <div className="p-8 md:p-14 bg-[#fcfcfd] min-h-screen">
      <header className="mb-14 flex flex-col lg:flex-row lg:items-end justify-between gap-8">
        <div><h1 className="text-5xl font-black tracking-tighter text-slate-900 italic mb-3">Task Master</h1><p className="text-slate-500 font-medium max-w-md">Your responsibilities across Diract.</p></div>
        <div className="flex p-1.5 bg-slate-200/50 rounded-full w-fit border border-slate-200 backdrop-blur-md">
          <button onClick={() => setView("active")} className={`px-8 py-2.5 rounded-full text-[12px] font-black uppercase tracking-widest transition-all ${view === "active" ? "bg-white text-black shadow-lg" : "text-slate-400 hover:text-slate-600"}`}>Active</button>
          <button onClick={() => setView("archived")} className={`px-8 py-2.5 rounded-full text-[12px] font-black uppercase tracking-widest transition-all ${view === "archived" ? "bg-black text-white shadow-lg" : "text-slate-400 hover:text-slate-600"}`}>Archived</button>
        </div>
      </header>
      <div className="max-w-6xl mx-auto space-y-4">
        {loading ? <Loader2 className="animate-spin text-slate-200 mx-auto" size={48} /> : tasks.map((task) => (
          <div key={task.id} className="bg-white border rounded-[36px] p-8 shadow-sm flex items-center justify-between">
            <div className="flex items-center gap-6">
              <div className="text-slate-200">{task.is_completed ? <CheckCircle2 className="text-emerald-500" size={28} /> : <Circle size={28} />}</div>
              <div>
                <span className="text-[10px] font-black text-indigo-500 uppercase flex items-center gap-1"><Briefcase size={10} /> {task.projects?.name}</span>
                <h3 className="font-bold text-slate-800 text-[18px]">{task.name}</h3>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}