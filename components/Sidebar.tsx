"use client";

import { useState, useEffect } from "react";
import { 
  CheckSquare, 
  Folder, 
  Plus, 
  Import, 
  SortAsc, 
  X, 
  LogOut, 
  Loader2,
  ChevronRight,
  Building
} from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import NewProjectModal from "./NewProjectModal";

export default function Sidebar() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const currentProjectId = searchParams.get("id");

  // --- 1. MODAL & UI STATES ---
  const [isProjectModalOpen, setIsProjectModalOpen] = useState(false);
  const [sortBy, setSortBy] = useState("modified_desc"); // modified_desc, address_alpha

  // --- 2. DATA STATES ---
  const [userProfile, setUserProfile] = useState<any>(null);
  const [allProjects, setAllProjects] = useState<any[]>([]); // The "Master List" from DB
  const [treeProjects, setTreeProjects] = useState<any[]>([]); // The "Active Tree" shown in UI

  // --- 3. LIFECYCLE ---
  useEffect(() => { 
    fetchUserData(); 
  }, []);

  useEffect(() => { 
    if (userProfile) fetchInitialProjects(); 
  }, [userProfile]);

  const fetchUserData = async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      const { data } = await supabase.from("profiles").select("*").eq("id", user.id).single();
      setUserProfile(data);
    }
  };

  const fetchInitialProjects = async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    // Security: Only fetch projects where the user is a member
    const { data, error } = await supabase
      .from('project_members')
      .select(`
        project:project_id (
          id, 
          name, 
          updated_at,
          properties ( street_address, suburb )
        )
      `)
      .eq('profile_id', user.id);

    if (data) {
      // Flatten the join result
      const projects = data.map((item: any) => item.project).filter(p => p !== null);
      setAllProjects(projects);
      setTreeProjects(projects); // Default: Import all on first load
    }
  };

  // --- 4. TREE OPERATIONS ---
  
  // Logic: Remove from tree (UI only, never deletes from database)
  const removeFromTree = (id: string) => {
    setTreeProjects(prev => prev.filter(p => p.id !== id));
  };

  // Logic: Import all projects you have access to back into the tree
  const importAllToTree = () => {
    setTreeProjects(allProjects);
  };

  // Logic: Sorting
  const sortedProjects = [...treeProjects].sort((a, b) => {
    if (sortBy === "modified_desc") {
      return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
    }
    if (sortBy === "address_alpha") {
      const suburbA = a.properties?.suburb || "";
      const suburbB = b.properties?.suburb || "";
      return suburbA.localeCompare(suburbB);
    }
    return 0;
  });

  const getInitials = (name: string) => name?.split(' ').map(n => n[0]).join('').toUpperCase().substring(0, 2) || "??";

  return (
    <div className="flex flex-col h-full bg-white px-4 py-8 border-r border-slate-200 overflow-hidden font-sans antialiased selection:bg-black selection:text-white">
      
      {/* BRANDING: Only mentioned once here */}
      <div className="flex items-center gap-3 px-3 mb-12 select-none">
        <div className="h-10 w-10 rounded-2xl bg-black flex items-center justify-center shadow-xl">
          <div className="h-4 w-4 rounded-full border-[2.5px] border-white" />
        </div>
        <span className="font-black text-[20px] tracking-tighter text-slate-900 italic">niksen-flow</span>
      </div>

      <nav className="flex-1 flex flex-col min-h-0">
        
        {/* TOP LEVEL NAVIGATION */}
        <Link 
          href="/dashboard/tasks" 
          className={`flex items-center gap-4 px-5 py-4 rounded-full text-[14px] font-bold mb-10 transition-all ${
            pathname === '/dashboard/tasks' ? 'bg-slate-100 text-black shadow-sm' : 'text-slate-400 hover:text-black hover:bg-slate-50'
          }`}
        >
          <CheckSquare size={20} /> My Responsibilities
        </Link>

        {/* PROJECT TREE HEADER */}
        <div className="flex items-center justify-between px-5 mb-4 group">
          <p className="text-[10px] font-black text-slate-300 uppercase tracking-[0.3em]">Project Tree</p>
          
          <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
            {/* 1. Add Project Button */}
            <button 
              onClick={() => setIsProjectModalOpen(true)} 
              className="p-1.5 hover:bg-slate-100 rounded text-slate-400 hover:text-black transition-all"
              title="Create New Project"
            >
              <Plus size={14} strokeWidth={3} />
            </button>

            {/* 2. Import All Button */}
            <button 
              onClick={importAllToTree} 
              className="p-1.5 hover:bg-slate-100 rounded text-slate-400 hover:text-black transition-all"
              title="Import All Projects"
            >
              <Import size={14}/>
            </button>

            {/* 3. Sort Select */}
            <div className="relative">
              <SortAsc size={14} className="p-0.5 cursor-pointer text-slate-400 hover:text-black mt-0.5" />
              <select 
                className="absolute inset-0 opacity-0 cursor-pointer" 
                onChange={(e) => setSortBy(e.target.value)}
                value={sortBy}
              >
                <option value="modified_desc">Last Modified</option>
                <option value="address_alpha">Suburb (A-Z)</option>
              </select>
            </div>
          </div>
        </div>

        {/* DYNAMIC TREE AREA */}
        <div className="flex-1 overflow-y-auto space-y-1.5 pr-2 custom-scrollbar">
          {sortedProjects.length > 0 ? (
            sortedProjects.map((proj) => {
              const isActive = currentProjectId === proj.id;
              return (
                <div key={proj.id} className="group relative">
                  <Link 
                    href={`/dashboard/projects?id=${proj.id}`} 
                    className={`flex items-center gap-4 px-5 py-3.5 rounded-full text-[13px] font-bold transition-all ${
                      isActive ? 'bg-indigo-50 text-indigo-600 shadow-sm' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900'
                    }`}
                  >
                    <Folder size={17} strokeWidth={isActive ? 3 : 2} />
                    <span className="truncate pr-6">{proj.name}</span>
                  </Link>
                  
                  {/* 4. Remove Project from Tree button */}
                  <button 
                    onClick={(e) => { e.preventDefault(); removeFromTree(proj.id); }} 
                    className="absolute right-4 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 text-slate-300 hover:text-red-500 transition-all p-1"
                    title="Remove from tree"
                  >
                    <X size={14} />
                  </button>
                </div>
              );
            })
          ) : (
            <div className="px-5 py-8 border-2 border-dashed border-slate-50 rounded-[32px] text-center">
              <p className="text-[11px] font-bold text-slate-300 italic leading-relaxed">
                Your tree is currently empty. Use the Import or Plus buttons above.
              </p>
            </div>
          )}
        </div>
      </nav>

      {/* COMPACT USER FOOTER: Fits on one screen */}
      <div className="mt-auto pt-6 border-t border-slate-100 gap-2 flex flex-col">
        {userProfile ? (
          <div className="flex items-center gap-3 p-3 rounded-[24px] bg-slate-50 border border-slate-100 shadow-sm transition-all hover:border-slate-200">
            <div className="h-9 w-9 rounded-full bg-indigo-600 flex items-center justify-center text-[10px] font-black text-white border-2 border-white shadow-md shrink-0 italic">
              {getInitials(userProfile.full_name)}
            </div>
            <div className="flex flex-col min-w-0">
              <p className="text-[12px] font-black text-slate-900 truncate tracking-tight">{userProfile.full_name}</p>
              <p className="text-[9px] font-bold text-indigo-500 uppercase tracking-tighter">
                {userProfile.company_id ? 'Corporate' : 'Independent'}
              </p>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-center p-4"><Loader2 className="animate-spin text-slate-200" size={20} /></div>
        )}
        
        <button 
          onClick={async () => { await supabase.auth.signOut(); window.location.replace("/login"); }} 
          className="flex items-center gap-4 px-5 py-3 rounded-full text-[13px] font-bold text-slate-400 hover:text-red-600 hover:bg-red-50 transition-all group"
        >
          <LogOut size={18} className="group-hover:-translate-x-1 transition-transform" /> 
          <span className="font-black uppercase text-[11px] tracking-widest">Sign Out</span>
        </button>
      </div>

      {/* MODAL COMPONENTS */}
      <NewProjectModal 
        isOpen={isProjectModalOpen} 
        onClose={() => setIsProjectModalOpen(false)} 
        onRefresh={fetchInitialProjects} 
        userProfile={userProfile}
      />
    </div>
  );
}