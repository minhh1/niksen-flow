"use client";

import React, { useState, useEffect, Suspense, useMemo } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { Search, ChevronDown, ChevronUp, GripVertical, Settings2, MapPin, Building2 } from "lucide-react";

import PropertyDashboard from "./PropertyDashboard";
import ColumnConfigDrawer from "@/components/ColumnConfigDrawer";
import DataTable from "@/components/DataTable";
import DeleteAction from "@/components/actions/DeleteAction";

export const dynamic = "force-dynamic";

function PropertyMaster() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const id = searchParams.get("id");

  const [items, setItems] = useState<any[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [dbSections, setDbSections] = useState<any[]>([]);
  
  // Columns state - explicitly including holding_entity.entity_type
  const [tableCols, setTableCols] = useState<string[]>(['street_address', 'suburb', 'holding_entity_id', 'holding_entity.entity_type']);
  const [colWidths, setColWidths] = useState<Record<string, number>>({});
  const [sortConfig, setSortConfig] = useState({ key: 'street_address', direction: 'asc' });
  const [isConfigOpen, setIsConfigOpen] = useState(false);
  const [draggedIdx, setDraggedIdx] = useState<number | null>(null);

  useEffect(() => { if (!id) init(); }, [id]);

  const init = async () => {
    setLoading(true);
    // 1. Fetch Dynamic Schema
    const { data: pCols } = await supabase.rpc('get_table_columns', { table_name_input: 'properties' });
    const { data: eCols } = await supabase.rpc('get_table_columns', { table_name_input: 'entities' });
    const format = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

    setDbSections([
      { title: "Property", icon: MapPin, fields: pCols?.map((c: any) => ({ id: c.col_name, label: format(c.col_name) })) || [] },
      { title: "Owner", icon: Building2, fields: eCols?.map((c: any) => ({ id: `holding_entity.${c.col_name}`, label: `Owner ${format(c.col_name)}` })) || [] }
    ]);

    // 2. Fetch User Prefs
    const { data: { user } } = await supabase.auth.getUser();
    const { data: prefs } = await supabase.from("user_column_preferences").select("*").eq("user_id", user?.id).eq("table_slug", "properties").single();
    if (prefs) { 
      if (prefs.columns) setTableCols(prefs.columns);
      if (prefs.column_widths) setColWidths(prefs.column_widths);
    }

    // 3. Fetch Data with RELATIONAL JOIN for Type
    const { data } = await supabase.from("properties")
      .select(`*, holding_entity:holding_entity_id(id, name, entity_type, abn)`)
      .is('deleted_at', null);
    
    setItems(data || []);
    setLoading(false);
  };

  // Logic: Resolve nested paths like 'holding_entity.entity_type'
  const resolveValue = (item: any, path: string) => {
    if (!path || !item) return "";
    if (path === 'holding_entity_id') return item.holding_entity?.name || "unassigned";
    
    const value = path.split('.').reduce((obj, key) => obj?.[key], item);
    
    if (path.includes('price')) return value ? `$${Number(value).toLocaleString()}` : '-';
    if (typeof value === 'object' && value !== null) return value.name || "";
    return value;
  };

  const sortedItems = useMemo(() => {
    let filtered = items.filter(i => (i.street_address || "").toLowerCase().includes(search.toLowerCase()));
    return filtered.sort((a, b) => {
      const aVal = String(resolveValue(a, sortConfig.key));
      const bVal = String(resolveValue(b, sortConfig.key));
      return sortConfig.direction === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
    });
  }, [items, search, sortConfig]);

  const savePrefs = async (t: string[], w: any) => {
    const { data: { user } } = await supabase.auth.getUser();
    await supabase.from("user_column_preferences").upsert({
      user_id: user?.id, table_slug: "properties", columns: t, column_widths: w
    }, { onConflict: 'user_id,table_slug' });
  };

  // ROUTER: Correctly passes propertyId to the dashboard
  if (id) return <PropertyDashboard propertyId={id} onBack={() => router.push('/dashboard/properties')} />;

  return (
    <div className="flex flex-col h-screen bg-[#F9FAFB] font-sans antialiased text-slate-600 overflow-hidden">
      <header className="bg-white p-8 border-b border-slate-100 shrink-0">
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-3xl font-light uppercase tracking-tight text-slate-900 leading-none">Properties</h1>
          <button onClick={() => setIsConfigOpen(true)} className="flex items-center gap-2 px-4 py-2 bg-slate-50 border border-slate-200 rounded-full text-[11px] font-bold">Setup view</button>
        </div>
        <div className="relative"><Search className="absolute left-5 top-1/2 -translate-y-1/2 text-slate-300" size={20} /><input placeholder="Search assets..." className="w-full bg-slate-50 border border-slate-100 rounded-2xl py-4.5 pl-14 pr-8 text-sm font-medium outline-none focus:ring-8 focus:ring-black/5" value={search} onChange={e => setSearch(e.target.value)} /></div>
      </header>

      <ColumnConfigDrawer isOpen={isConfigOpen} onClose={() => setIsConfigOpen(false)} sections={dbSections} tableCols={tableCols} expandCols={[]} onToggle={(fid: string, target: string) => {
        const nt = tableCols.filter(c => c !== fid); if (target === 'table') nt.push(fid); setTableCols(nt); savePrefs(nt, colWidths);
      }} />

      <main className="flex-1 overflow-auto p-8">
        <DataTable minWidth={1200}>
          <thead className="bg-slate-50 border-b border-slate-200 text-slate-400">
            <tr>
              {tableCols.map((colId, idx) => (
                <th key={colId} style={{ width: colWidths[colId] || 250 }} className="relative border-r border-slate-100 group/header select-none p-0">
                  <div className="flex items-center h-full">
                    <div draggable onDragStart={() => setDraggedIdx(idx)} onDragOver={e => e.preventDefault()} onDrop={() => {
                      const next = [...tableCols]; const [moved] = next.splice(draggedIdx!, 1);
                      next.splice(idx, 0, moved); setTableCols(next); setDraggedIdx(null); savePrefs(next, colWidths);
                    }} className="p-4 cursor-move opacity-0 group-hover/header:opacity-100 transition-opacity"><GripVertical size={14}/></div>
                    <div onClick={() => setSortConfig({ key: colId, direction: sortConfig.direction === 'asc' ? 'desc' : 'asc' })} className="flex-1 py-5 uppercase text-[10px] font-bold tracking-widest px-4 cursor-pointer">
                      {colId.replace('_id','').replace('.',' ')}
                    </div>
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
                <td className="p-6 text-center"><DeleteAction table="properties" id={item.id} identifier={item.street_address} onRefresh={init} /></td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      </main>
    </div>
  );
}

export default function Page() { return <Suspense fallback={null}><PropertyMaster /></Suspense>; }