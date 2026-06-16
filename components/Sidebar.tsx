"use client";

import { useState, useEffect, Suspense } from "react";
import { CheckSquare, Folder, Plus, Import, SortAsc, X, LogOut, Loader2 } from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import NewProjectModal from "./NewProjectModal";

export default function Sidebar() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const currentProjectId = searchParams.get("id");
  const [userProfile, setUserProfile] = useState<any>(null);
  const [allProjects, setAllProjects] = useState<any[]>([]); 
  const [treeProjects, setTreeProjects] = useState<any[]>([]); 
  const [sortBy, setSortBy] = useState("modified_desc");
  const [isProjectModalOpen, setIsProjectModalOpen] = useState(false);

  useEffect(() => { fetchUserData(); }, []);
  useEffect(() => { if (userProfile) fetchInitialProjects(); }, [userProfile]);

  const fetchUserData = async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      const { data } = await supabase.from("profiles").select("*").eq("id", user.id).single();
      setUserProfile(data);
    }
  };

  const fetchInitialProjects = async () => {
    const { data: { user } } = await supabase.auth.getUser();
    const { data } = await supabase.from('projects').select(`id, name, updated_at, properties ( street_address, suburb ), project_members!inner ( profile_id )`).is('deleted_at', null).eq('project_members.profile_id', user?.id);
    if (data) { setAllProjects(data); setTreeProjects(data); }
  };

  return (
    <div className="flex flex-col h-full bg-white px-4 py-8 border-r border-slate-200 overflow-hidden font-sans antialiased">
      <div className="flex items-center gap-3 px-3 mb-12 select-none">
        <div className="h-10 w-10 rounded-2xl bg-black flex items-center justify-center shadow-xl shadow-black/10"><div className="h-4 w-4 rounded-full border-[2.5px] border-white" /></div>
        <span className="font-black text-[20px] tracking-tighter text-slate-900 italic">niksen-flow</span>
      </div>
      <nav className="flex-1 flex flex-col min-h-0">
        <Link href="/dashboard/tasks" className={`flex items-center gap-4 px-5 py-4 rounded-full text-[14px] font-bold mb-10 transition-all ${pathname === '/dashboard/tasks' ? 'bg-slate-100 text-black shadow-sm' : 'text-slate-400 hover:text-black hover:bg-slate-50'}`}><CheckSquare size={20} /> My Responsibilities</Link>
        <div className="flex items-center justify-between px-5 mb-4 group">
          <p className="text-[10px] font-black text-slate-300 uppercase tracking-[0.3em]">Project Tree</p>
          <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
            <button onClick={() => setIsProjectModalOpen(true)} className="p-1 hover:bg-slate-100 rounded text-slate-400 hover:text-black" title="Create New Project"><Plus size={14} strokeWidth={3}/></button>
            <button onClick={() => setTreeProjects(allProjects)} className="p-1 hover:bg-slate-100 rounded text-slate-400 hover:text-black" title="Import All"><Import size={14}/></button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto space-y-1 pr-2 custom-scrollbar">
          {treeProjects.map((proj) => (
            <div key={proj.id} className="group relative">
              <Link href={`/dashboard/projects?id=${proj.id}`} className={`flex items-center gap-4 px-5 py-3.5 rounded-full text-[13px] font-bold transition-all ${currentProjectId === proj.id ? 'bg-indigo-50 text-indigo-600 shadow-sm' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900'}`}>
                <Folder size={17} strokeWidth={currentProjectId === proj.id ? 3 : 2} />
                <span className="truncate pr-4">{proj.name}</span>
              </Link>
            </div>
          ))}
          <button onClick={() => setIsProjectModalOpen(true)} className="w-full flex items-center gap-4 px-5 py-4 mt-2 rounded-full text-[13px] font-black text-slate-300 hover:text-black hover:bg-slate-50 border-2 border-dashed border-transparent hover:border-slate-100 transition-all"><Plus size={18} strokeWidth={3} /><span className="uppercase tracking-widest text-[11px]">Add project</span></button>
        </div>
      </nav>
      <div className="mt-auto pt-6 border-t border-slate-100 gap-2 flex flex-col">
        {userProfile ? (
          <div className="flex items-center gap-3 p-3.5 rounded-[28px] bg-slate-50 border border-slate-100 shadow-sm transition-all hover:border-slate-200">
            <div className="h-10 w-10 rounded-full bg-indigo-600 flex items-center justify-center text-[11px] font-black text-white border-2 border-white shadow-md shrink-0 italic">{userProfile.full_name?.substring(0,2).toUpperCase()}</div>
            <div className="flex flex-col min-w-0"><p className="text-[13px] font-black text-slate-900 truncate tracking-tight">{userProfile.full_name}</p><p className="text-[10px] font-bold text-indigo-500 uppercase tracking-tighter mt-1">{userProfile.company_id ? 'Niksen Staff' : 'Independent'}</p></div>
          </div>
        ) : <Loader2 className="animate-spin text-slate-300 mx-auto" />}
        <button onClick={async () => { await supabase.auth.signOut(); window.location.replace("/login"); }} className="flex items-center gap-4 px-5 py-4 rounded-full text-[13px] font-bold text-slate-400 hover:text-red-600 hover:bg-red-50 transition-all group"><LogOut size={18} /> Sign Out</button>
      </div>
      <NewProjectModal isOpen={isProjectModalOpen} onClose={() => setIsProjectModalOpen(false)} onRefresh={fetchInitialProjects} userProfile={userProfile} />
    </div>
  );
}