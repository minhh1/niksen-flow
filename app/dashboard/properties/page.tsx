"use client";

import React, { useState, useEffect, Suspense, useMemo } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { propertyService } from "@/lib/services/propertyService";
import { preferenceService } from "@/lib/services/preferenceService";
import { Search, ChevronDown, ChevronUp, GripVertical, Settings2, MapPin, Building2 } from "lucide-react";

import PropertyDashboard from "./PropertyDashboard";
import ColumnConfigDrawer from "@/components/ColumnConfigDrawer";
import DataTable from "@/components/DataTable";
import ViewPresets from "@/components/ViewPresets";
import UniversalSelectionModal from "@/components/UniversalSelectionModal";

export const dynamic = "force-dynamic";

function PropertyMaster() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const id = searchParams.get("id");

  const [items, setItems] = useState<any[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [dbSections, setDbSections] = useState<any[]>([]);
  
  // Layout States
  const [tableCols, setTableCols] = useState<string[]>(['street_address', 'suburb', 'holding_entity_id']);
  const [expandCols, setExpandCols] = useState<string[]>([]);
  const [colWidths, setColWidths] = useState<Record<string, number>>({});
  
  // Presets States
  const [presets, setPresets] = useState<any[]>([]);
  const [activePreset, setActivePreset] = useState("Default view");

  const [isConfigOpen, setIsConfigOpen] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [draggedIdx, setDraggedIdx] = useState<number | null>(null);
  const [sortConfig, setSortConfig] = useState({ key: 'street_address', direction: 'asc' });

  useEffect(() => { if (!id) init(); }, [id]);

  const init = async () => {
    setLoading(true);
    const { data: pCols } = await supabase.rpc('get_table_columns', { table_name_input: 'properties' });
    const { data: eCols } = await supabase.rpc('get_table_columns', { table_name_input: 'entities' });
    const formatLabel = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

    setDbSections([
      { title: "Property", icon: MapPin, fields: pCols?.map((c: any) => ({ id: c.col_name, label: formatLabel(c.col_name) })) || [] },
      { title: "Holding Entity", icon: Building2, fields: eCols?.map((c: any) => ({ id: `holding_entity.${c.col_name}`, label: `Owner ${formatLabel(c.col_name)}` })) || [] }
    ]);

    const { data: { user } } = await supabase.auth.getUser();
    const saved = await preferenceService.getByTable(user?.id!, "properties");
    
    if (saved?.length) {
      setPresets(saved);
      const active = saved.find(p => p.is_active) || saved[0];
      setTableCols(active.columns || ['street_address']);
      setExpandCols(active.expansion_columns || []);
      setColWidths(active.column_widths || {});
      setActivePreset(active.preset_name);
    } else {
      setPresets([{ preset_name: "Default view", is_active: true }]);
    }

    const data = await propertyService.getAll();
    setItems(data);
    setLoading(false);
  };

  // Logic: Auto-save changes to the current active preset
  const autoSave = async (t: string[], e: string[], w: any) => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    await preferenceService.save({
      user_id: user.id, table_slug: "properties", preset_name: activePreset,
      columns: t, expansion_columns: e, column_widths: w, is_active: true
    });
  };

  const handleSelectPreset = (p: any) => {
    setTableCols(p.columns);
    setExpandCols(p.expansion_columns || []);
    setColWidths(p.column_widths || {});
    setActivePreset(p.preset_name);
    autoSave(p.columns, p.expansion_columns || [], p.column_widths || {});
  };

  const handleSaveAsNew = async () => {
    const name = prompt("Name for this new view configuration:");
    if (!name) return;
    const { data: { user } } = await supabase.auth.getUser();
    await preferenceService.save({
      user_id: user?.id, table_slug: "properties", preset_name: name,
      columns: tableCols, expansion_columns: expandCols, column_widths: colWidths, is_active: true
    });
    setActivePreset(name);
    init(); // Refresh preset bar
  };

  const startResizing = (colId: string, e: React.MouseEvent) => {
    const startX = e.pageX;
    const startWidth = colWidths[colId] || 250;
    const onMouseMove = (mE: MouseEvent) => {
      const newWidth = Math.max(150, startWidth + (mE.pageX - startX));
      setColWidths(prev => ({ ...prev, [colId]: newWidth }));
    };
    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      autoSave(tableCols, expandCols, colWidths);
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  };

  const resolveValue = (item: any, path: string) => {
    if (path === 'holding_entity_id') return item.holding_entity?.name || "";
    const value = path.split('.').reduce((obj, key) => obj?.[key], item);
    return typeof value === 'object' ? "" : value;
  };

  const sortedItems = useMemo(() => {
    return items.filter(i => (i.street_address || "").toLowerCase().includes(search.toLowerCase()))
      .sort((a, b) => String(resolveValue(a, tableCols[0])).localeCompare(String(resolveValue(b, tableCols[0]))));
  }, [items, search, tableCols]);

  if (id) return <PropertyDashboard propertyId={id} onBack={() => { init(); router.push('/dashboard/properties'); }} />;

  return (
    <div className="flex flex-col h-screen bg-[#F9FAFB] font-sans antialiased text-slate-600 overflow-hidden">
      <header className="bg-white p-8 border-b border-slate-100 shrink-0">
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-3xl font-light uppercase tracking-tight text-slate-900">Properties</h1>
          <div className="flex gap-2">
            <button onClick={() => setIsConfigOpen(true)} className="flex items-center gap-2 px-4 py-2 bg-slate-50 border border-slate-200 rounded-full text-[11px] font-bold transition-all hover:bg-slate-100">
              <Settings2 size={16}/> Setup
            </button>
            <button onClick={() => setIsModalOpen(true)} className="bg-slate-900 text-white px-6 py-2 rounded-full text-[11px] font-bold shadow-sm">+ New asset</button>
          </div>
        </div>
        <div className="relative">
          <Search className="absolute left-5 top-1/2 -translate-y-1/2 text-slate-300" size={20} />
          <input placeholder="Search records..." className="w-full bg-slate-50 border border-slate-100 rounded-2xl py-4 pl-14 pr-8 text-sm font-medium outline-none focus:ring-8 focus:ring-black/5 transition-all" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <ViewPresets presets={presets} activePreset={activePreset} onSelect={handleSelectPreset} onSaveNew={handleSaveAsNew} />
      </header>

      <ColumnConfigDrawer isOpen={isConfigOpen} onClose={() => setIsConfigOpen(false)} sections={dbSections} tableCols={tableCols} expandCols={expandCols} onToggle={(fid: string, target: string) => {
        const nt = tableCols.filter(c => c !== fid); const ne = expandCols.filter(c => c !== fid);
        if (target === 'table') nt.push(fid); if (target === 'expand') ne.push(fid);
        setTableCols(nt); setExpandCols(ne); autoSave(nt, ne, colWidths);
      }} />

      <main className="flex-1 overflow-auto p-8">
        <DataTable minWidth={1400}>
          <thead className="bg-slate-50 border-b border-slate-200 text-slate-400">
            <tr>
              {tableCols.map((colId, idx) => (
                <th key={colId} style={{ width: colWidths[colId] || 250 }} className="relative border-r border-slate-100 group/header select-none p-0">
                  <div className="flex items-center h-full">
                    <div draggable onDragStart={() => setDraggedIdx(idx)} onDragOver={e => e.preventDefault()} onDrop={() => {
                      if (draggedIdx === null) return;
                      const next = [...tableCols]; const [moved] = next.splice(draggedIdx, 1);
                      next.splice(idx, 0, moved); setTableCols(next); setDraggedIdx(null); autoSave(next, expandCols, colWidths);
                    }} className="p-4 cursor-move opacity-0 group-hover/header:opacity-100 transition-opacity"><GripVertical size={14}/></div>
                    <div className="flex-1 py-5 uppercase text-[10px] font-bold tracking-widest px-4">{colId.replace('_id','').replace('.',' ')}</div>
                    <div onMouseDown={(e) => startResizing(colId, e)} className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-indigo-500 z-10" />
                  </div>
                </th>
              ))}
              <th className="w-24"></th>
            </tr>
          </thead>
          <tbody>
            {sortedItems.map(item => (
              <tr key={item.id} className="border-b border-slate-50 hover:bg-indigo-50/20 transition-all cursor-pointer">
                {tableCols.map(colId => (<td key={colId} className="p-6 border-r border-slate-50 truncate font-medium text-slate-700" onClick={() => router.push(`/dashboard/properties?id=${item.id}`)}>{String(resolveValue(item, colId) || '-')}</td>))}
                <td className="p-6"></td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      </main>
    </div>
  );
}

export default function Page() { return <Suspense fallback={null}><PropertyMaster /></Suspense>; }