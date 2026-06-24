"use client";

import React, { useState, useEffect, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { erpData } from "@/lib/erp-data";
import { Search, Settings2, LayoutGrid } from "lucide-react";

import ProjectDashboard from "./ProjectDashboard";
import ColumnConfigDrawer from "@/components/ColumnConfigDrawer";
import DataTable from "@/components/DataTable";
import ViewPresets from "@/components/ViewPresets";
import NewProjectModal from "@/components/NewProjectModal";

export const dynamic = "force-dynamic";

function ProjectMaster() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const id = searchParams.get("id");

  const [items, setItems] = useState<any[]>([]);
  const [search, setSearch] = useState("");
  const [tableCols, setTableCols] = useState<string[]>(['name', 'estimated_completion_date']);
  const [presets, setPresets] = useState<any[]>([]);
  const [activePreset, setActivePreset] = useState("Default view");
  const [isConfigOpen, setIsConfigOpen] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);

  useEffect(() => { if (!id) init(); }, [id]);

  const init = async () => {
    const { data: { user } } = await supabase.auth.getUser();
    const saved = await erpData.getUserPrefs(user?.id!, "projects");
    if (saved?.length) {
      setPresets(saved);
      const active = saved.find(p => p.is_active) || saved[0];
      setTableCols(active.columns);
      setActivePreset(active.preset_name);
    } else {
      setPresets([{ preset_name: "Default view" }]);
    }
    const data = await erpData.getProjects();
    setItems(data);
  };

  const savePrefs = async (t: string[], pName: string) => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    await erpData.saveUserPrefs({ user_id: user.id, table_slug: "projects", preset_name: pName, columns: t });
  };

  if (id) return <ProjectDashboard projectId={id} onBack={() => { init(); router.push('/dashboard/projects'); }} />;

  return (
    <div className="flex flex-col h-screen bg-[#F9FAFB] font-sans antialiased text-slate-600 overflow-hidden">
      <header className="bg-white p-8 border-b border-slate-100 shrink-0">
        <div className="flex justify-between items-center mb-8"><h1 className="text-3xl font-light uppercase tracking-tight text-slate-900">Projects</h1><div className="flex gap-2">
          <button onClick={() => setIsConfigOpen(true)} className="flex items-center gap-2 px-4 py-2 bg-slate-50 border border-slate-200 rounded-full text-[11px] font-bold"><Settings2 size={16}/> Setup</button>
          <button onClick={() => setIsModalOpen(true)} className="bg-slate-900 text-white px-6 py-2 rounded-full text-[11px] font-bold">+ New project</button>
        </div></div>
        <div className="relative"><Search className="absolute left-5 top-1/2 -translate-y-1/2 text-slate-300" size={20} /><input placeholder="Search projects..." className="w-full bg-slate-50 border border-slate-100 rounded-2xl py-4 pl-14 pr-8 text-sm font-medium outline-none" value={search} onChange={e => setSearch(e.target.value)} /></div>
        <ViewPresets presets={presets} activePreset={activePreset} onSelect={(p: any) => { setTableCols(p.columns); setActivePreset(p.preset_name); savePrefs(p.columns, p.preset_name); }} onSaveNew={() => {
          const name = prompt("Name this project view:");
          if (name) savePrefs(tableCols, name).then(() => init());
        }} />
      </header>
      <main className="flex-1 overflow-auto p-8">
        <DataTable minWidth={1000}><thead className="bg-slate-50 border-b border-slate-200 text-slate-400"><tr>{tableCols.map(colId => (<th key={colId} className="p-6 border-r border-slate-100 font-bold uppercase text-[10px] tracking-widest">{colId}</th>))}</tr></thead><tbody>{items.filter(i => (i.name || "").toLowerCase().includes(search.toLowerCase())).map(item => (<tr key={item.id} className="border-b border-slate-50 hover:bg-indigo-50/20 transition-all cursor-pointer" onClick={() => router.push(`/dashboard/projects?id=${item.id}`)}>{tableCols.map(colId => (<td key={colId} className="p-6 border-r border-slate-50 truncate font-medium text-slate-700">{String(item[colId] || '-')}</td>))}</tr>))}</tbody></DataTable>
      </main>
      <NewProjectModal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} onRefresh={init} />
    </div>
  );
}

export default function Page() { return <Suspense fallback={null}><ProjectMaster /></Suspense>; }