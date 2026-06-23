"use client";

import React, { useState, useEffect, Suspense, useMemo } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { Search, ChevronDown, ChevronUp, GripVertical, Settings2, Building2, ArrowUp, ArrowDown } from "lucide-react";

import EntityDashboard from "./EntityDashboard";
import ColumnConfigDrawer from "@/components/ColumnConfigDrawer";
import DataTable from "@/components/DataTable";
import DeleteAction from "@/components/actions/DeleteAction";
import NewEntityModal from "@/components/NewEntityModal";

export const dynamic = "force-dynamic";

function EntityMaster() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const id = searchParams.get("id");

  const [items, setItems] = useState<any[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [dbSections, setDbSections] = useState<any[]>([]);
  const [tableCols, setTableCols] = useState<string[]>(['name', 'entity_type', 'abn']);
  const [expandCols, setExpandCols] = useState<string[]>([]);
  const [colWidths, setColWidths] = useState<Record<string, number>>({});
  const [sortConfig, setSortConfig] = useState({ key: 'name', direction: 'asc' });
  const [isConfigOpen, setIsConfigOpen] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [draggedIdx, setDraggedIdx] = useState<number | null>(null);

  useEffect(() => { if (!id) init(); }, [id]);

  const init = async () => {
    setLoading(true);
    const { data: cols } = await supabase.rpc('get_table_columns', { table_name_input: 'entities' });
    const format = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
    setDbSections([{ title: "Entity", icon: Building2, fields: cols?.map((c: any) => ({ id: c.col_name, label: format(c.col_name) })) || [] }]);
    
    const { data: { user } } = await supabase.auth.getUser();
    const { data: prefs } = await supabase.from("user_column_preferences").select("*").eq("user_id", user?.id).eq("table_slug", "entities").single();
    if (prefs) { 
      if (prefs.columns) setTableCols(prefs.columns);
      if (prefs.expansion_columns) setExpandCols(prefs.expansion_columns);
      if (prefs.column_widths) setColWidths(prefs.column_widths);
    }

    const { data } = await supabase.from("entities").select("*").is('deleted_at', null).order('name');
    setItems(data || []);
    setLoading(false);
  };

  const savePrefs = async (t: string[], e: string[], w: any) => {
    const { data: { user } } = await supabase.auth.getUser();
    await supabase.from("user_column_preferences").upsert({
      user_id: user?.id, table_slug: "entities", columns: t, expansion_columns: e, column_widths: w
    }, { onConflict: 'user_id,table_slug' });
  };

  const startResizing = (colId: string, e: React.MouseEvent) => {
    const startX = e.pageX;
    const startWidth = colWidths[colId] || 250;
    const onMouseMove = (mE: MouseEvent) => {
      setColWidths(prev => ({ ...prev, [colId]: Math.max(120, startWidth + (mE.pageX - startX)) }));
    };
    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      savePrefs(tableCols, expandCols, colWidths);
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  };

  if (id) return <EntityDashboard entityId={id} onBack={() => router.push('/dashboard/entities')} />;

  return (
    <div className="flex flex-col h-screen bg-[#F9FAFB] font-sans antialiased text-slate-600 overflow-hidden">
      <header className="bg-white p-8 border-b border-slate-100 shrink-0">
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-3xl font-light uppercase tracking-tight text-slate-900">Entities</h1>
          <div className="flex gap-2">
            <button onClick={() => setIsConfigOpen(true)} className="flex items-center gap-2 px-4 py-2 bg-slate-50 border border-slate-200 rounded-full text-[11px] font-bold">Column configuration</button>
            <button onClick={() => setIsModalOpen(true)} className="bg-slate-900 text-white px-6 py-2 rounded-full text-[11px] font-bold shadow-sm">+ New entity</button>
          </div>
        </div>
        <div className="relative"><Search className="absolute left-5 top-1/2 -translate-y-1/2 text-slate-300" size={20} /><input placeholder="Search directory..." className="w-full bg-slate-50 border border-slate-100 rounded-2xl py-4 pl-14 pr-8 text-sm font-medium outline-none focus:ring-8" onChange={e => setSearch(e.target.value)} /></div>
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
                    <div draggable onDragStart={(e) => setDraggedIdx(idx)} onDragOver={e => e.preventDefault()} onDrop={() => {
                      const next = [...tableCols]; const [moved] = next.splice(draggedIdx!, 1);
                      next.splice(idx, 0, moved); setTableCols(next); savePrefs(next, expandCols, colWidths);
                    }} className="p-4 cursor-move opacity-0 group-hover/header:opacity-100 transition-opacity"><GripVertical size={14}/></div>
                    <div className="flex-1 py-5 uppercase text-[10px] font-bold tracking-widest px-4">{colId}</div>
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
                {tableCols.map(colId => (<td key={colId} className="p-6 border-r border-slate-50 truncate font-medium text-slate-700" onClick={() => router.push(`/dashboard/entities?id=${item.id}`)}>{String(item[colId] || '-')}</td>))}
                <td className="p-6 text-center"><DeleteAction table="entities" id={item.id} identifier={item.name} onRefresh={init} /></td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      </main>
      <NewEntityModal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} onRefresh={init} />
    </div>
  );
}

export default function Page() { return <Suspense fallback={null}><EntityMaster /></Suspense>; }