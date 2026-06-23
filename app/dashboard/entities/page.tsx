"use client";

import React, { useState, useEffect, Suspense, useMemo } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { Search, Building2 } from "lucide-react";

import EntityDashboard from "@/app/dashboard/entities/EntityDashboard";
import DataTable from "@/components/DataTable";
import DeleteAction from "@/components/actions/DeleteAction";

export const dynamic = "force-dynamic";

function EntityMaster() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const id = searchParams.get("id");
  const [items, setItems] = useState<any[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => { if (!id) fetch(); }, [id]);

  const fetch = async () => {
    setLoading(true);
    const { data } = await supabase.from("entities").select("*").is('deleted_at', null).order('name');
    setItems(data || []);
    setLoading(false);
  };

  if (id) return <EntityDashboard entityId={id} onBack={() => router.push('/dashboard/entities')} />;

  return (
    <div className="flex flex-col h-screen bg-[#F9FAFB] font-sans antialiased text-slate-600 overflow-hidden">
      <header className="bg-white p-8 border-b border-slate-100 shrink-0">
        <h1 className="text-3xl font-light uppercase tracking-tight text-slate-900 mb-8 leading-none">Entities</h1>
        <div className="relative"><Search className="absolute left-5 top-1/2 -translate-y-1/2 text-slate-300" size={20} /><input placeholder="Search directory..." className="w-full bg-slate-50 border border-slate-100 rounded-2xl py-4.5 pl-14 pr-8 text-sm font-medium outline-none" value={search} onChange={e => setSearch(e.target.value)} /></div>
      </header>
      <main className="flex-1 overflow-auto p-8">
        <DataTable minWidth={1000}>
          <thead className="bg-slate-50 border-b border-slate-200 text-slate-400">
            <tr>
              <th className="p-6 border-r border-slate-100 font-bold uppercase text-[10px] tracking-widest">Entity Name</th>
              <th className="p-6 border-r border-slate-100 font-bold uppercase text-[10px] tracking-widest">Type</th>
              <th className="p-6 border-r border-slate-100 font-bold uppercase text-[10px] tracking-widest">ABN</th>
              <th className="w-24"></th>
            </tr>
          </thead>
          <tbody>
            {items.filter(i => (i.name || "").toLowerCase().includes(search.toLowerCase())).map(item => (
              <tr key={item.id} className="border-b border-slate-50 hover:bg-indigo-50/20 transition-all cursor-pointer">
                <td className="p-6 border-r border-slate-50 truncate font-medium text-slate-700" onClick={() => router.push(`/dashboard/entities?id=${item.id}`)}>{item.name}</td>
                <td className="p-6 border-r border-slate-50 truncate font-medium text-slate-500" onClick={() => router.push(`/dashboard/entities?id=${item.id}`)}>{item.entity_type || '-'}</td>
                <td className="p-6 border-r border-slate-50 truncate font-medium text-slate-500" onClick={() => router.push(`/dashboard/entities?id=${item.id}`)}>{item.abn || '-'}</td>
                <td className="p-6 text-center"><DeleteAction table="entities" id={item.id} identifier={item.name} onRefresh={fetch} /></td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      </main>
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={null}><EntityMaster /></Suspense>;
}