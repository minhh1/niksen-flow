"use client";

import React, { useState, useEffect, Suspense, useMemo } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { Search, ChevronDown, ChevronUp, GripVertical, Settings2, Plus, LayoutGrid } from "lucide-react";

import ProjectDashboard from "./ProjectDashboard";
import ColumnConfigDrawer from "@/components/ColumnConfigDrawer";
import DataTable from "@/components/DataTable";
import DeleteAction from "@/components/actions/DeleteAction";
import NewProjectModal from "@/components/NewProjectModal";

export const dynamic = "force-dynamic";

function ProjectMaster() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const id = searchParams.get("id");

  const [items, setItems] = useState<any[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  
  const [dbSections, setDbSections] = useState<any[]>([]);
  const [tableCols, setTableCols] = useState<string[]>(['name', 'estimated_completion_date']);
  const [expandCols, setExpandCols] = useState<string[]>([]);
  const [colWidths, setColWidths] = useState<Record<string, number>>({});
  const [sortConfig, setSortConfig] = useState({ key: 'name', direction: 'asc' });

  const [isConfigOpen, setIsConfigOpen] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [draggedIdx, setDraggedIdx] = useState<number | null>(null);

  useEffect(() => { 
    if (!id) init(); 
  }, [id]);

  const init = async () => {
    setLoading(true);
    const { data: cols } = await supabase.rpc('get_table_columns', { table_name_input: 'projects' });
    const format = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
    
    setDbSections([{ 
      title: "Project", 
      icon: LayoutGrid, 
      fields: cols?.map((c: any) => ({ id: c.col_name, label: format(c.col_name) })) || [] 
    }]);

    const { data: { user } } = await supabase.auth.getUser();
    const { data: prefs } = await supabase.from("user_column_preferences").select("*").eq("user_id", user?.id).eq("table_slug", "projects").single();
    
    if (prefs) {
      if (prefs.columns) setTableCols(prefs.columns);
      if (prefs.expansion_columns) setExpandCols(prefs.expansion_columns || []);
      if (prefs.column_widths) setColWidths(prefs.column_widths || {});
    }

    await fetchProjects(); // Call the renamed function
  };

  // FIXED: Renamed from 'fetch' to 'fetchProjects' to avoid clashing with global fetch API
  const fetchProjects = async () => {
    const { data } = await supabase.from("projects").select("*").is('deleted_at', null).order('name');
    setItems(data || []);
    setLoading(false);
  };

  const savePrefs = async (t: string[], e: string[], w: any) => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    await supabase.from("user_column_preferences").upsert({
      user_id: user.id, table_slug: "projects", columns: t, expansion_columns: e, column_widths: w
    }, { onConflict: 'user_id,table_slug' });
  };

  const startResizing = (colId: string, e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.pageX;
    const startWidth = colWidths[colId] || 250;
    const onMouseMove = (moveEvent: MouseEvent) => {
      const newWidth = Math.max(120, startWidth + (moveEvent.pageX - startX));
      setColWidths(prev => ({ ...prev, [colId]: newWidth }));
    };
    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      savePrefs(tableCols, expandCols, colWidths);
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  };

  if (id) return <ProjectDashboard projectId={id} onBack={() => router.push('/dashboard/projects')} />;

  return (
    <div className="flex flex-col h-screen bg-[#F9FAFB] font-sans antialiased text-slate-600 overflow-hidden">
      <header className="bg-white p-8 border-b border-slate-100 shrink-0">
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-3xl font-light uppercase tracking-tight text-slate-900">Projects</h1>
          <div className="flex gap-2">
            <button onClick={() => setIsConfigOpen(true)} className="flex items-center gap-2 px-4 py-2 bg-slate-50 border border-slate-200 rounded-full text-[11px] font-bold transition-all hover:bg-slate-100">
              Column configuration
            </button>
            <button onClick={() => setIsModalOpen(true)} className="bg-slate-900 text-white px-6 py-2 rounded-full text-[11px] font-bold shadow-sm transition-all hover:bg-slate-800">
              + New project
            </button>
          </div>
        </div>
        <div className="relative">
          <Search className="absolute left-5 top-1/2 -translate-y-1/2 text-slate-300" size={20} />
          <input 
            placeholder="Search projects..." 
            className="w-full bg-slate-50 border border-slate-100 rounded-2xl py-4 pl-14 pr-8 text-sm font-medium outline-none focus:ring-8 focus:ring-black/5 transition-all" 
            onChange={e => setSearch(e.target.value)} 
          />
        </div>
      </header>

      <ColumnConfigDrawer isOpen={isConfigOpen} onClose={() => setIsConfigOpen(false)} sections={dbSections} tableCols={tableCols} expandCols={expandCols} onToggle={(fid: string, target: string) => {
        const nt = tableCols.filter(c => c !== fid); const ne = expandCols.filter(c => c !== fid);
        if (target === 'table') nt.push(fid); if (target === 'expand') ne.push(fid);
        setTableCols(nt); setExpandCols(ne); savePrefs(nt, ne, colWidths);
      }} />

      <main className="flex-1 overflow-auto p-8">
        <DataTable minWidth={1000}>
          <thead className="bg-slate-50 border-b border-slate-200 text-slate-400">
            <tr>
              {tableCols.map((colId, idx) => (
                <th key={colId} style={{ width: colWidths[colId] || 250 }} className="relative border-r border-slate-100 group/header select-none p-0">
                  <div className="flex items-center h-full">
                    <div draggable onDragStart={() => setDraggedIdx(idx)} onDragOver={e => e.preventDefault()} onDrop={() => {
                      if (draggedIdx === null) return;
                      const next = [...tableCols]; const [moved] = next.splice(draggedIdx, 1);
                      next.splice(idx, 0, moved); setTableCols(next); setDraggedIdx(null); savePrefs(next, expandCols, colWidths);
                    }} className="p-4 cursor-move opacity-0 group-hover/header:opacity-100 transition-opacity"><GripVertical size={14}/></div>
                    <div className="flex-1 py-5 uppercase text-[10px] font-bold tracking-widest px-4 cursor-pointer">{colId.replace(/_/g, ' ')}</div>
                    <div onMouseDown={(e) => startResizing(colId, e)} className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-indigo-500 z-10" />
                  </div>
                </th>
              ))}
              <th className="w-24"></th>
            </tr>
          </thead>
          <tbody>
            {items.filter(i => i.name.toLowerCase().includes(search.toLowerCase())).map(item => (
              <tr key={item.id} className="border-b border-slate-50 hover:bg-indigo-50/20 transition-all cursor-pointer">
                {tableCols.map(colId => (
                  <td key={colId} className="p-6 border-r border-slate-50 truncate font-medium text-slate-700" onClick={() => router.push(`/dashboard/projects?id=${item.id}`)}>
                    {String(item[colId] || '-')}
                  </td>
                ))}
                <td className="p-6 text-center">
                  <DeleteAction 
                    table="projects" 
                    id={item.id} 
                    identifier={item.name} 
                    onRefresh={fetchProjects} // Passing the fixed function name here
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      </main>
      <NewProjectModal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} onRefresh={fetchProjects} />
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={null}><ProjectMaster /></Suspense>;
}