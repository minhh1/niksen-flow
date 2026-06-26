"use client";

import React, { useState, useRef, Suspense, useCallback } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { propertyService } from "@/lib/services/propertyService";
import { Search, Settings2 } from "lucide-react";

import PropertyDashboard from "./PropertyDashboard";
import ColumnConfigDrawer from "@/components/ColumnConfigDrawer";
import ViewPresets from "@/components/ViewPresets";
import MasterTable from "@/components/MasterTable";
import UniversalSelectionModal from "@/components/UniversalSelectionModal";
import { usePresetTable } from "@/lib/hooks/usePresetTable";
import { buildPropertySections } from "@/lib/columnDefinitions";
import { PROPERTY_RELATIONS } from "@/lib/relationDefinitions";

export const dynamic = "force-dynamic";

const CATEGORY_KEYS = ['council', 'electricity', 'water', 'land_tax', 'gas'];

function getCategoryKeyForColumn(colId: string): string | null {
  for (const key of CATEGORY_KEYS) {
    if (colId.startsWith(`${key}_`)) return key;
  }
  return null;
}

function PropertyMaster() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const id = searchParams.get("id");
  const [search, setSearch] = useState("");
  const [dbSections] = useState(buildPropertySections());
  const [isConfigOpen, setIsConfigOpen] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [companyId, setCompanyId] = useState<string | null>(null);

  const fetchedCategoriesRef = useRef<Set<string>>(new Set());

  const fetchItems = useCallback(async (visibleColumns: string[]) => {
    const { data: { user } } = await supabase.auth.getUser();
    const { data: prof } = await supabase.from("profiles").select("company_id").eq("id", user?.id).single();
    setCompanyId(prof?.company_id || null);

    fetchedCategoriesRef.current = new Set(
      visibleColumns.map(getCategoryKeyForColumn).filter((k): k is string => k !== null)
    );
    return propertyService.getAll(visibleColumns);
  }, []);

  const t = usePresetTable({
    tableSlug: "properties",
    defaultCols: ['street_address', 'suburb', 'holding_entity_id'],
    fetchItems,
  });

  const handleToggleColumnWithRefetch = async (fieldId: string, target: 'table' | 'expand' | 'none') => {
    t.handleToggleColumn(fieldId, target);
    if (target === 'none') return;
    const categoryKey = getCategoryKeyForColumn(fieldId);
    if (!categoryKey) return;
    if (fetchedCategoriesRef.current.has(categoryKey)) return;
    fetchedCategoriesRef.current.add(categoryKey);
    const nextCols = [...new Set([...t.tableCols, ...t.expandCols, fieldId])];
    const data = await propertyService.getAll(nextCols);
    t.setItems(data);
  };

  const resolveValue = (item: any, path: string) => {
    if (path === 'holding_entity_id') return item.holding_entity?.name || "";
    const value = path.split('.').reduce((obj: any, key: string) => obj?.[key], item);
    return typeof value === 'object' ? "" : value;
  };

  // Only street_address navigates to the property's own dashboard now —
  // every other field (suburb, price, dates, insurer details, etc.) is
  // inline-editable on the master list instead. holding_entity columns
  // still navigate to the linked entity's dashboard.
  const getLinkTarget = (colId: string, item: any): string | null => {
    if (colId === 'street_address') return `/dashboard/properties?id=${item.id}`;
    if (colId === 'holding_entity_id' || colId.startsWith('holding_entity.')) {
      const entityId = item.holding_entity?.id || item.holding_entity_id;
      return entityId ? `/dashboard/entities?id=${entityId}` : null;
    }
    return null;
  };

  const sortedItems = [...t.items]
    .filter(i => (i.street_address || "").toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => String(resolveValue(a, t.tableCols[0])).localeCompare(String(resolveValue(b, t.tableCols[0]))));

  if (id) return <PropertyDashboard propertyId={id} onBack={() => { t.refresh(); router.push('/dashboard/properties'); }} />;

  return (
    <div className="flex flex-col h-screen bg-[#F9FAFB] font-sans antialiased text-slate-600 overflow-hidden">
      <header className="bg-white p-8 border-b border-slate-100 shrink-0">
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-3xl font-light uppercase tracking-tight text-slate-900">Properties</h1>
          <div className="flex gap-2">
            <button onClick={() => setIsConfigOpen(true)} className="flex items-center gap-2 px-4 py-2 bg-slate-50 border border-slate-200 rounded-full text-[11px] font-bold transition-all hover:bg-slate-100">
              <Settings2 size={16} /> Setup
            </button>
            <button onClick={() => setIsModalOpen(true)} className="bg-slate-900 text-white px-6 py-2 rounded-full text-[11px] font-bold shadow-sm">+ New asset</button>
          </div>
        </div>
        <div className="relative">
          <Search className="absolute left-5 top-1/2 -translate-y-1/2 text-slate-300" size={20} />
          <input placeholder="Search records..." className="w-full bg-slate-50 border border-slate-100 rounded-2xl py-4 pl-14 pr-8 text-sm font-medium outline-none focus:ring-8 focus:ring-black/5 transition-all" value={search} onChange={e => setSearch(e.target.value)} />
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
        onToggle={handleToggleColumnWithRefetch}
      />

      <main className="flex-1 overflow-auto p-8">
        <MasterTable
          items={sortedItems}
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
          relations={PROPERTY_RELATIONS}
          expandRelations={t.expandRelations}
          minWidth={1400}
          baseTable="properties"
          parentType="property"
          companyId={companyId ?? undefined}
          editableCols={['street_address', 'suburb', 'state', 'postcode', 'folio_identifier', 'purchase_price', 'purchase_date', 'insurer_name', 'policy_number', 'insurance_expiry', 'project_manager', 'project_owner', 'holding_entity_id']}
          relationalEditCols={{
            holding_entity_id: {
              table: 'entities',
              title: 'Select holding entity',
              editParentType: 'entity',
              editFields: [
                { id: 'name', label: 'Entity name' },
                {
                  id: 'entity_type',
                  label: 'Entity type',
                  type: 'select',
                  fetchOptions: async () => {
                    const { data } = await supabase.from('entity_types').select('label').order('label');
                    return (data || []).map((t: any) => ({ value: t.label, label: t.label }));
                  },
                },
                { id: 'abn', label: 'ABN' },
                { id: 'acn', label: 'ACN' },
              ],
            },
          }}
          onRowMutated={t.refresh}
        />
      </main>

      <UniversalSelectionModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onSelect={() => { setIsModalOpen(false); t.refresh(); }}
        title="New Property"
        table="properties"
      />
    </div>
  );
}

export default function Page() { return <Suspense fallback={null}><PropertyMaster /></Suspense>; }