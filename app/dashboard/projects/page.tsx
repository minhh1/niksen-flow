"use client";

import React, { useState, Suspense, useCallback } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { erpData } from "@/lib/erp-data";
import { Search, Settings2 } from "lucide-react";

import ProjectDashboard from "./ProjectDashboard";
import ColumnConfigDrawer from "@/components/ColumnConfigDrawer";
import ViewPresets from "@/components/ViewPresets";
import MasterTable from "@/components/MasterTable";
import NewProjectModal from "@/components/NewProjectModal";
import { usePresetTable } from "@/lib/hooks/usePresetTable";
import { buildProjectSections } from "@/lib/columnDefinitions";

export const dynamic = "force-dynamic";

function ProjectMaster() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const id = searchParams.get("id");
  const [search, setSearch] = useState("");
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isConfigOpen, setIsConfigOpen] = useState(false);
  const [dbSections] = useState(buildProjectSections());
  const [companyId, setCompanyId] = useState<string | null>(null);

  const fetchItems = useCallback(async (_visibleColumns: string[]) => {
    const { data: { user } } = await supabase.auth.getUser();
    const { data: prof } = await supabase.from("profiles").select("company_id").eq("id", user?.id).single();
    setCompanyId(prof?.company_id || null);
    return erpData.getProjects();
  }, []);

  const t = usePresetTable({
    tableSlug: "projects",
    defaultCols: ['name', 'estimated_completion_date'],
    fetchItems,
  });

  const resolveValue = (item: any, path: string) => {
    const value = path.split('.').reduce((obj: any, key: string) => obj?.[key], item);
    return typeof value === 'object' ? "" : value;
  };

  const getLinkTarget = (colId: string, item: any): string | null => {
    if (colId === 'name') return `/dashboard/projects?id=${item.id}`;
    if (colId === 'property_id' || colId.startsWith('property.')) {
      const propId = item.property?.id || item.property_id;
      return propId ? `/dashboard/properties?id=${propId}` : null;
    }
    return null;
  };

  const filteredItems = t.items.filter(i => (i.name || "").toLowerCase().includes(search.toLowerCase()));

  if (id) return <ProjectDashboard projectId={id} onBack={() => { t.refresh(); router.push('/dashboard/projects'); }} />;

  return (
    <div className="flex flex-col h-screen bg-[#F9FAFB] font-sans antialiased text-slate-600 overflow-hidden">
      <header className="bg-white p-8 border-b border-slate-100 shrink-0">
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-3xl font-light uppercase tracking-tight text-slate-900">Projects</h1>
          <div className="flex gap-2">
            <button onClick={() => setIsConfigOpen(true)} className="flex items-center gap-2 px-4 py-2 bg-slate-50 border border-slate-200 rounded-full text-[11px] font-bold">
              <Settings2 size={16} /> Setup
            </button>
            <button onClick={() => setIsModalOpen(true)} className="bg-slate-900 text-white px-6 py-2 rounded-full text-[11px] font-bold">+ New project</button>
          </div>
        </div>
        <div className="relative">
          <Search className="absolute left-5 top-1/2 -translate-y-1/2 text-slate-300" size={20} />
          <input placeholder="Search projects..." className="w-full bg-slate-50 border border-slate-100 rounded-2xl py-4 pl-14 pr-8 text-sm font-medium outline-none" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <ViewPresets
          presets={t.presets}
          activePreset={t.activePreset}
          onSelect={t.handleSelectPreset}
          onSaveNew={t.handleSaveAsNew}
          onDelete={t.handleDeletePreset}
          isBusy={t.isBusy}
        />
      </header>

      <ColumnConfigDrawer
        isOpen={isConfigOpen}
        onClose={() => setIsConfigOpen(false)}
        sections={dbSections}
        tableCols={t.tableCols}
        expandCols={t.expandCols}
        activePresetName={t.activePreset}
        onToggle={t.handleToggleColumn}
      />

      <main className="flex-1 overflow-auto p-8">
        <MasterTable
          items={filteredItems}
          tableCols={t.tableCols}
          expandCols={t.expandCols}
          colWidths={t.colWidths}
          draggedIdx={t.draggedIdx}
          setDraggedIdx={t.setDraggedIdx}
          onReorder={t.handleReorder}
          startResizing={t.startResizing}
          expandedRow={t.expandedRow}
          toggleExpandRow={t.toggleExpandRow}
          resolveValue={resolveValue}
          getLinkTarget={getLinkTarget}
          minWidth={1000}
          baseTable="projects"
          parentType="project"
          companyId={companyId ?? undefined}
          editableCols={['description', 'estimated_completion_date']}
          onRowMutated={t.refresh}
        />
      </main>
      <NewProjectModal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} onRefresh={t.refresh} />
    </div>
  );
}

export default function Page() { return <Suspense fallback={null}><ProjectMaster /></Suspense>; }