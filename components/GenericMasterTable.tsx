"use client";

import React, { useState, useEffect, useRef, useCallback, useMemo, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { Search, Settings2, LayoutGrid, X } from "lucide-react";

import MasterTable from "@/components/MasterTable";
import ColumnConfigDrawer from "@/components/ColumnConfigDrawer";
import ViewPresets from "@/components/ViewPresets";
import UniversalSelectionModal from "@/components/UniversalSelectionModal";

import { usePresetTable } from "@/lib/hooks/usePresetTable";
import { useTableSchema } from "@/lib/hooks/useTableSchema";
import { useRelationalEditFields } from "@/lib/hooks/useRelationalEditFields";
import { useTableRealtime } from "@/lib/hooks/useTableRealtime";
import { useTableRelations } from "@/lib/hooks/useTableRelations";
import { useRelatedFields } from "@/lib/hooks/useRelatedFields";
import { useRelationSections } from "@/lib/hooks/useRelationSections";
import { deriveLabel } from "@/lib/services/schemaService";
import { propertyService } from "@/lib/services/propertyService";
import { buildCredentialColumnSections } from "@/lib/columnDefinitions";
import { PROPERTY_RELATIONS, ENTITY_RELATIONS } from "@/lib/relationDefinitions";
import SpreadsheetEditor from "@/components/SpreadsheetEditor";
import type { ActiveFilter } from "@/lib/types/filters";


interface GenericMasterTableProps {
  tableName: "properties" | "entities" | "projects";
  pageTitle: string;
  newButtonLabel: string;
  renderDashboard?: (id: string, onBack: () => void) => React.ReactNode;
}

type SortDirection = 'asc' | 'desc';
type SortMode = 'name' | 'number';

interface SortState {
  colId: string;
  direction: SortDirection;
  mode?: SortMode;
}

const PROPERTY_CATEGORY_KEYS = ['council', 'electricity', 'water', 'land_tax', 'gas'];

function getCategoryKeyForColumn(colId: string): string | null {
  for (const key of PROPERTY_CATEGORY_KEYS) {
    if (colId.startsWith(`${key}_`)) return key;
  }
  return null;
}

const TABLE_AREA_CLASS = "bg-[#F9FAFB] p-8";

function buildDynamicSelectQuery(
  schemaColumns: any[],
  visibleCols: string[],
  relatedFieldsByPath: Map<string, any>
): string {
  const aliasMap = new Map<string, { fkColumn: string; fields: Set<string> }>();

  for (const col of schemaColumns.filter(c => c.category === 'relation' && c.relation_table)) {
    const alias = col.column_name.replace(/_id$/, '');
    const displayCol = col.relation_display_column || 'name';
    if (!aliasMap.has(alias)) {
      aliasMap.set(alias, { fkColumn: col.column_name, fields: new Set(['id', displayCol]) });
    } else {
      aliasMap.get(alias)!.fields.add('id');
      aliasMap.get(alias)!.fields.add(displayCol);
    }
  }

  for (const col of visibleCols) {
    if (!col.includes('.')) continue;
    const fieldMeta = relatedFieldsByPath.get(col);
    if (!fieldMeta) continue;
    if (!aliasMap.has(fieldMeta.alias)) {
      aliasMap.set(fieldMeta.alias, {
        fkColumn: fieldMeta.fk_column,
        fields: new Set(['id', fieldMeta.field_name]),
      });
    } else {
      aliasMap.get(fieldMeta.alias)!.fields.add(fieldMeta.field_name);
    }
  }

  const embeds = [...aliasMap.entries()].map(
    ([alias, { fkColumn, fields }]) =>
      `${alias}:${fkColumn}(${[...fields].join(',')})`
  );

  return ['*', ...embeds].join(', ');
}

function extractStreetNumber(address: string): number {
  if (!address) return Infinity;
  const clean = address.replace(/,/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  const words = clean.split(' ');
  if (words[0] && /^\d+[a-z]?\/(\d+)/.test(words[0])) {
    const match = words[0].match(/\/(\d+)/);
    return match ? parseInt(match[1]) : Infinity;
  }
  let idx = 0;
  if (words[0] && ['unit', 'lot', 'suite', 'shop', 'apartment', 'apt', 'villa', 'level'].includes(words[0])) {
    idx = 2;
  }
  if (idx < words.length && /^\d+/.test(words[idx])) {
    return parseInt(words[idx]);
  }
  return Infinity;
}

function extractStreetName(address: string): string {
  if (!address) return '';
  const clean = address.replace(/,/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  const words = clean.split(' ');
  let idx = 0;
  if (words[0] && ['unit', 'lot', 'suite', 'shop', 'apartment', 'apt', 'villa', 'level'].includes(words[0])) {
    idx = 2;
  }
  if (idx < words.length && /^\d+/.test(words[idx])) idx++;
  return words.slice(idx).join(' ');
}

function GenericMasterTableInner({
  tableName, pageTitle, newButtonLabel, renderDashboard,
}: GenericMasterTableProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectedId = searchParams.get("id");

  const [search, setSearch] = useState("");
  const [isConfigOpen, setIsConfigOpen] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [sort, setSort] = useState<SortState | null>(null);
  const [addressSortOpen, setAddressSortOpen] = useState(false);
  const [filters, setFilters] = useState<ActiveFilter[]>([]);
  const [isSpreadsheetOpen, setIsSpreadsheetOpen] = useState(false);

  const schema = useTableSchema(tableName);
  const relationalEditCols = useRelationalEditFields(schema.relationalEditCols);
  const relatedFields = useRelatedFields(tableName);
  const fetchedCategoriesRef = useRef<Set<string>>(new Set());
  const [customFieldCols, setCustomFieldCols] = useState<any[]>([]);

  useEffect(() => {
    const loadCustomFields = async () => {
      const { data } = await supabase
        .from('company_custom_fields')
        .select('id, field_key, label, field_type, show_in_table, select_options')
        .eq('table_name', tableName)
        .order('display_order');
      setCustomFieldCols(data || []);
    };
    loadCustomFields();
  }, [tableName]);

  

  const { relations: projectRelations } = useTableRelations(
    tableName === 'projects' ? 'projects' : '__skip__'
  );

  const relations = useMemo(() => {
    if (tableName === 'properties') return PROPERTY_RELATIONS;
    if (tableName === 'entities') return ENTITY_RELATIONS;
    return projectRelations;
  }, [tableName, projectRelations]);

  const relationSections = useRelationSections(relations, companyId);

  // ── fetchItems ─────────────────────────────────────────────────────

  const fetchItems = useCallback(async (visibleColumns: string[]) => {
    const { data: { user } } = await supabase.auth.getUser();
    const { data: prof } = await supabase
      .from("profiles").select("active_company_id").eq("id", user?.id).single();
    const cid = prof?.active_company_id || null;
    setCompanyId(cid);

    let items: any[] = [];

    if (tableName === 'properties') {
      fetchedCategoriesRef.current = new Set(
        visibleColumns.map(getCategoryKeyForColumn).filter((k): k is string => k !== null)
      );
      items = await propertyService.getAll(visibleColumns);
    } else {
      const baseVisibleCols = visibleColumns.filter(c => !c.startsWith('custom_field:'));
      const selectQuery = buildDynamicSelectQuery(schema.all, baseVisibleCols, relatedFields.byPath);
      const { data, error } = await supabase
        .from(tableName)
        .select(selectQuery)
        .is('deleted_at', null);
      if (error) { console.error(`fetchItems(${tableName}):`, error); return []; }
      items = data || [];
    }

    // Load custom field values — batched to avoid URL length limits
    const visibleCustomFieldIds = visibleColumns
      .filter(c => c.startsWith('custom_field:'))
      .map(c => c.replace('custom_field:', ''));

    if (visibleCustomFieldIds.length > 0 && items.length > 0 && cid) {
      const recordIds = items.map(i => i.id);
      const BATCH_SIZE = 100;
      const allCfValues: any[] = [];

      for (let i = 0; i < recordIds.length; i += BATCH_SIZE) {
        const batch = recordIds.slice(i, i + BATCH_SIZE);
        const { data: batchValues } = await supabase
          .from('company_custom_field_values')
          .select('record_id, field_id, value_text, value_number, value_date, value_boolean')
          .in('record_id', batch)
          .in('field_id', visibleCustomFieldIds);
        allCfValues.push(...(batchValues || []));
      }

      const byRecord: Record<string, Record<string, any>> = {};
      allCfValues.forEach(v => {
        if (!byRecord[v.record_id]) byRecord[v.record_id] = {};
        byRecord[v.record_id][v.field_id] =
          v.value_text ?? v.value_number ?? v.value_date ?? v.value_boolean;
      });

      items = items.map(item => ({
        ...item,
        __customFields: byRecord[item.id] || {},
      }));
    }

    return items;
  }, [tableName, schema.all, relatedFields.byPath]);

  const t = usePresetTable({
    tableSlug: tableName,
    defaultCols: schema.defaultTableCols,
    fetchItems,
  });

  // ── Filter persistence ─────────────────────────────────────────────

  useEffect(() => {
    const loadFilters = async () => {
      if (!t.activePreset) return;
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data } = await supabase
        .from('user_column_preferences')
        .select('filters')
        .eq('user_id', user.id)
        .eq('table_slug', tableName)
        .eq('preset_name', t.activePreset)
        .eq('is_active', true)
        .single();
      setFilters(data?.filters || []);
    };
    loadFilters();
  }, [t.activePreset, tableName]);

  useEffect(() => {
    if (!t.activePreset) return;
    const saveFilters = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      await supabase
        .from('user_column_preferences')
        .update({ filters })
        .eq('user_id', user.id)
        .eq('table_slug', tableName)
        .eq('preset_name', t.activePreset)
        .eq('is_active', true);
    };
    saveFilters();
  }, [filters, t.activePreset, tableName]);

  // ── Realtime ───────────────────────────────────────────────────────

  const handleRealtimeInsert = useCallback((row: Record<string, any>) => {
    t.setItems(prev => {
      if (prev.some(item => item.id === row.id)) return prev;
      return [row, ...prev];
    });
  }, [t.setItems]);

  const handleRealtimeUpdate = useCallback(async (row: Record<string, any>) => {
    const relationColNames = schema.all
      .filter(c => c.category === 'relation')
      .map(c => c.column_name);
    const hasRelationChange = relationColNames.some(col => col in row);

    if (hasRelationChange) {
      const selectQuery = buildDynamicSelectQuery(
        schema.all, [...t.tableCols, ...t.expandCols], relatedFields.byPath
      );
      const { data, error } = await supabase
        .from(tableName).select(selectQuery).eq('id', row.id).single();
      if (!error && data && typeof data === 'object' && 'id' in data) {
        t.setItems(prev => prev.map(item =>
          item.id === (data as any).id ? { ...item, ...(data as any) } : item
        ));
      }
    } else {
      t.setItems(prev => prev.map(item =>
        item.id === row.id ? { ...item, ...row } : item
      ));
    }
  }, [tableName, schema.all, t.tableCols, t.expandCols, t.setItems, relatedFields.byPath]);

  const handleRealtimeDelete = useCallback((id: string) => {
    t.setItems(prev => prev.filter(item => item.id !== id));
  }, [t.setItems]);

  useTableRealtime({
    tableName, companyId,
    onInsert: handleRealtimeInsert,
    onUpdate: handleRealtimeUpdate,
    onDelete: handleRealtimeDelete,
  });

  // ── Sort ───────────────────────────────────────────────────────────

  const handleSort = useCallback((colId: string, direction: SortDirection, mode?: SortMode) => {
    setSort(prev => {
      if (prev?.colId === colId && prev?.direction === direction && prev?.mode === mode) return null;
      return { colId, direction, mode };
    });
    setAddressSortOpen(false);
  }, []);

  // ── Column toggle ──────────────────────────────────────────────────

  const handleToggleColumnWithRefetch = async (
    fieldId: string, target: 'table' | 'expand' | 'none'
  ) => {
    t.handleToggleColumn(fieldId, target);

    // Properties — lazy credential refetch
    if (tableName === 'properties' && target !== 'none') {
      const categoryKey = getCategoryKeyForColumn(fieldId);
      if (categoryKey && !fetchedCategoriesRef.current.has(categoryKey)) {
        fetchedCategoriesRef.current.add(categoryKey);
        const nextCols = [...new Set([...t.tableCols, ...t.expandCols, fieldId])];
        const data = await propertyService.getAll(nextCols);
        t.setItems(data);
        return;
      }
    }

    // Custom field columns on any table — refetch with new column included
    if (fieldId.startsWith('custom_field:') && target !== 'none') {
      const allCols = [...new Set([...t.tableCols, ...t.expandCols, fieldId])];
      const data = await fetchItems(allCols);
      if (data) t.setItems(data);
    }
  };

  // ── Value resolution ───────────────────────────────────────────────

  const resolveValue = useCallback((item: any, path: string): any => {
    if (!path) return '';

    if (path.startsWith('custom_field:')) {
      const fieldId = path.replace('custom_field:', '');
      const val = item.__customFields?.[fieldId];
      if (val === null || val === undefined) return '';
      const fieldMeta = customFieldCols.find(f => f.id === fieldId);
      if (fieldMeta?.field_type === 'boolean') return val ? 'Yes' : 'No';
      if (fieldMeta?.field_type === 'currency') return `$${Number(val).toLocaleString()}`;
      if (fieldMeta?.field_type === 'date') {
        try { return new Date(val).toLocaleDateString('en-AU'); } catch { return val; }
      }
      return String(val);
    }

    if (path.includes('.')) {
      const value = path.split('.').reduce((obj: any, key: string) => obj?.[key], item);
      return typeof value === 'object' ? '' : (value ?? '');
    }

    const col = schema.all.find(c => c.column_name === path);
    if (col?.category === 'relation' && col.relation_display_column) {
      const alias = path.replace(/_id$/, '');
      return item[alias]?.[col.relation_display_column] ?? item[alias]?.name ?? '';
    }

    const value = path.split('.').reduce((obj: any, key: string) => obj?.[key], item);
    return typeof value === 'object' ? '' : (value ?? '');
  }, [schema.all, customFieldCols]);

  const resolveColLabel = useCallback((colId: string): string => {
    if (colId.startsWith('custom_field:')) {
      const fieldId = colId.replace('custom_field:', '');
      const field = customFieldCols.find(f => f.id === fieldId);
      return field?.label || fieldId;
    }
    if (colId.includes('.')) {
      return colId.replace('.', ' ').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    }
    const col = schema.all.find(c => c.column_name === colId);
    if (col?.label) return col.label;
    return colId.replace(/_id$/, '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }, [customFieldCols, schema.all]);

  const getLinkTarget = useCallback((colId: string, item: any): string | null => {
    if (colId.includes('.')) return null;
    if (colId.startsWith('custom_field:')) return null;
    const primaryCol = tableName === 'properties' ? 'street_address' : 'name';
    if (colId === primaryCol) return `/dashboard/${tableName}?id=${item.id}`;
    const col = schema.all.find(c => c.column_name === colId);
    if (col?.category === 'relation' && col.relation_table) {
      const alias = colId.replace(/_id$/, '');
      const linkedId = item[alias]?.id || item[colId];
      if (!linkedId) return null;
      const pageMap: Record<string, string> = {
        properties: 'properties', entities: 'entities', projects: 'projects',
      };
      const target = pageMap[col.relation_table];
      return target ? `/dashboard/${target}?id=${linkedId}` : null;
    }
    return null;
  }, [tableName, schema.all]);

  // ── Derived data ───────────────────────────────────────────────────

  const drawerSections = useMemo(() => {
    const baseSections = tableName === 'properties'
      ? [...schema.sections, ...buildCredentialColumnSections()]
      : schema.sections;
    const crossSections = relatedFields.sections;
    const customSection = customFieldCols.length > 0
      ? [{
          label: 'Custom Fields',
          fields: customFieldCols.map(f => ({
            id: `custom_field:${f.id}`,
            label: f.label,
            fieldType: f.field_type,
          })),
        }]
      : [];

    const allSections = [...baseSections, ...crossSections, ...relationSections, ...customSection];
    // Normalise — ensure every section has a `fields` array
    return allSections.map(section => ({
    ...section,
    label: (section as any).label ?? (section as any).title ?? '',
    fields: (section as any).fields ?? (section as any).cols ?? [],
    }))
  }, [tableName, schema.sections, relatedFields.sections, relationSections, customFieldCols]);

  const filterableFields = useMemo(() => {
    const base = schema.all
      .filter(c => ['data', 'identity'].includes(c.category))
      .map(c => ({
        id: c.column_name,
        label: c.label || c.column_name.replace(/_/g, ' ').replace(/\b\w/g, x => x.toUpperCase()),
        fieldType:
          c.data_type === 'boolean' ? 'boolean'
          : c.data_type?.includes('timestamp') || c.data_type === 'date' ? 'date'
          : ['numeric', 'integer'].includes(c.data_type) ? 'number'
          : 'text',
        options: (c as any).select_options || undefined,
      }));

    const custom = customFieldCols.map(f => ({
      id: `custom_field:${f.id}`,
      label: f.label,
      fieldType: f.field_type,
      options: f.select_options || undefined,
    }));

    return [...base, ...custom];
  }, [schema.all, customFieldCols]);

  const tableContentWidth = useMemo(() => {
    const baseWidth = t.tableCols.reduce((sum, colId) => sum + (t.colWidths[colId] || 250), 0);
    return baseWidth + 96;
  }, [t.tableCols, t.colWidths]);

  const filteredItems = useMemo(() => {
    const primaryCol = tableName === 'properties' ? 'street_address' : 'name';

    // Search
    let result = [...t.items].filter(item =>
      String(resolveValue(item, primaryCol) || '').toLowerCase().includes(search.toLowerCase())
    );

    // Active filters
    if (filters.length > 0) {
      result = result.filter(item =>
        filters.every(filter => {
          const raw = filter.fieldId.startsWith('custom_field:')
            ? item.__customFields?.[filter.fieldId.replace('custom_field:', '')]
            : item[filter.fieldId];
          const itemVal = (raw === null || raw === undefined ? '' : String(raw)).toLowerCase().trim();
          const filterVal = filter.value.toLowerCase().trim();

          switch (filter.operator) {
            case 'equals':       return itemVal === filterVal;
            case 'not_equals':   return itemVal !== filterVal;
            case 'contains':     return itemVal.includes(filterVal);
            case 'not_contains': return !itemVal.includes(filterVal);
            case 'starts_with':  return itemVal.startsWith(filterVal);
            case 'is_empty':     return itemVal === '';
            case 'is_not_empty': return itemVal !== '';
            case 'is_true':      return raw === true || itemVal === 'true' || itemVal === 'yes';
            case 'is_false':     return raw === false || itemVal === 'false' || itemVal === 'no';
            case 'gt':           return Number(raw) > Number(filter.value);
            case 'gte':          return Number(raw) >= Number(filter.value);
            case 'lt':           return Number(raw) < Number(filter.value);
            case 'lte':          return Number(raw) <= Number(filter.value);
            default:             return true;
          }
        })
      );
    }

    // Sort
    if (!sort) {
      if (tableName === 'properties') {
        return result.sort((a, b) =>
          extractStreetNumber(a.street_address || '') - extractStreetNumber(b.street_address || '')
        );
      }
      const firstCol = t.tableCols[0];
      if (!firstCol) return result;
      return result.sort((a, b) => {
        const va = String(resolveValue(a, firstCol) || '');
        const vb = String(resolveValue(b, firstCol) || '');
        return va.localeCompare(vb, undefined, { numeric: true, sensitivity: 'base' });
      });
    }

    return result.sort((a, b) => {
      let va: any;
      let vb: any;
      if (sort.colId === 'street_address' && sort.mode === 'number') {
        const diff = extractStreetNumber(a.street_address || '') - extractStreetNumber(b.street_address || '');
        return sort.direction === 'asc' ? diff : -diff;
      }
      if (sort.colId === 'street_address' && sort.mode === 'name') {
        va = extractStreetName(a.street_address || '');
        vb = extractStreetName(b.street_address || '');
      } else {
        va = String(resolveValue(a, sort.colId) ?? '');
        vb = String(resolveValue(b, sort.colId) ?? '');
      }
      const cmp = va.localeCompare(vb, undefined, { numeric: true, sensitivity: 'base' });
      return sort.direction === 'asc' ? cmp : -cmp;
    });
  }, [t.items, search, t.tableCols, resolveValue, tableName, sort, filters]);

  // ── Preset handlers with filter support ────────────────────────────

  const prevPresetRef = useRef<string | undefined>(undefined);
  
  useEffect(() => {
    if (prevPresetRef.current !== undefined && prevPresetRef.current !== t.activePreset) {
      setFilters([]);
    }
    prevPresetRef.current = t.activePreset;
  }, [t.activePreset]);

  const handleSaveAsNewWithFilters = async (name: string) => {
    await (t.handleSaveAsNew as any)(name);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    await supabase
      .from('user_column_preferences')
      .update({ filters })
      .eq('user_id', user.id)
      .eq('table_slug', tableName)
      .eq('preset_name', name);
  };

  // ── Early returns ──────────────────────────────────────────────────

  if (selectedId && renderDashboard) {
    return <>{renderDashboard(selectedId, () => {
      t.refresh();
      router.push(`/dashboard/${tableName}`);
    })}</>;
  }

  if (schema.loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <p className="text-slate-400 text-[11px] uppercase font-bold tracking-widest">
          Loading schema...
        </p>
      </div>
    );
  }

  // ── Render ─────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-screen bg-[#F9FAFB] font-sans antialiased text-slate-600 overflow-hidden">
      <header className="bg-white border-b border-slate-100 shrink-0">
        <div className="p-8 pb-4">

          {/* Title + actions */}
          <div className="flex justify-between items-center mb-8">
            <h1 className="text-3xl font-light uppercase tracking-tight text-slate-900">
              {pageTitle}
            </h1>
            <div className="flex gap-2">
              <button
                onClick={() => setIsConfigOpen(true)}
                className="flex items-center gap-2 px-4 py-2 bg-slate-50 border border-slate-200 rounded-full text-[11px] font-bold transition-all hover:bg-slate-100"
              >
                <Settings2 size={16} /> Setup
                {filters.length > 0 && (
                  <span className="px-1.5 py-0.5 bg-indigo-600 text-white rounded-full text-[9px] font-bold">
                    {filters.length}
                  </span>
                )}
              </button>
              <button
                onClick={() => setIsSpreadsheetOpen(true)}
                className="flex items-center gap-2 px-4 py-2 bg-slate-50 border border-slate-200 rounded-full text-[11px] font-bold transition-all hover:bg-slate-100"
              >
                <LayoutGrid size={16} /> Spreadsheet
              </button>
              <button
                onClick={() => setIsModalOpen(true)}
                className="bg-slate-900 text-white px-6 py-2 rounded-full text-[11px] font-bold shadow-sm"
              >
                {newButtonLabel}
              </button>
            </div>
          </div>

          {/* Search */}
          <div className="relative mb-4">
            <Search className="absolute left-5 top-1/2 -translate-y-1/2 text-slate-300" size={20} />
            <input
              placeholder={`Search ${pageTitle.toLowerCase()}...`}
              className="w-full bg-slate-50 border border-slate-100 rounded-2xl py-4 pl-14 pr-8 text-sm font-medium outline-none focus:ring-8 focus:ring-black/5 transition-all"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>

          {/* Active filter chips */}
          {filters.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap mb-4">
              <span className="text-[9px] font-bold text-slate-400 uppercase tracking-widest shrink-0">
                Filters:
              </span>
              {filters.map((f, i) => (
                <div
                  key={i}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-50 border border-indigo-200 rounded-full"
                >
                  <span className="text-[11px] font-bold text-indigo-700">{f.label}</span>
                  <span className="text-[10px] text-indigo-400">{f.operator.replace(/_/g, ' ')}</span>
                  {f.value && (
                    <span className="text-[11px] font-bold text-indigo-700">{f.value}</span>
                  )}
                  <button
                    onClick={() => setFilters(prev => prev.filter((_, fi) => fi !== i))}
                    className="text-indigo-300 hover:text-indigo-700 transition-colors ml-0.5"
                  >
                    <X size={11} />
                  </button>
                </div>
              ))}
              <button
                onClick={() => setFilters([])}
                className="text-[10px] font-bold text-slate-400 hover:text-red-500 transition-colors"
              >
                Clear all
              </button>
            </div>
          )}

          <ViewPresets
            presets={t.presets}
            activePreset={t.activePreset}
            onSelect={t.handleSelectPreset}
            onSaveNew={handleSaveAsNewWithFilters}
            onDelete={t.handleDeletePreset}
            isBusy={t.isBusy}
          />
        </div>
      </header>

      <ColumnConfigDrawer
        isOpen={isConfigOpen}
        onClose={() => setIsConfigOpen(false)}
        sections={drawerSections}
        tableCols={t.tableCols}
        expandCols={t.expandCols}
        activePresetName={t.activePreset}
        onToggle={handleToggleColumnWithRefetch}
        filters={filters}
        filterableFields={filterableFields}
        onFiltersChange={setFilters}
      />

      <main className={`flex-1 flex flex-col min-h-0 overflow-x-auto ${TABLE_AREA_CLASS}`}>
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
          resolveColLabel={resolveColLabel}
          relations={relations}
          expandRelations={t.expandRelations}
          minWidth={tableContentWidth}
          baseTable={tableName}
          parentType={schema.parentType ?? undefined}
          companyId={companyId ?? undefined}
          editableCols={schema.editableCols}
          relationalEditCols={relationalEditCols}
          onRowMutated={t.refresh}
          sort={sort}
          onSort={handleSort}
          addressSortOpen={addressSortOpen}
          onAddressSortOpenChange={setAddressSortOpen}
        />
      </main>

      {isSpreadsheetOpen && (
        <div className="fixed inset-0 z-50 flex flex-col bg-white font-sans">
          <div className="flex items-center justify-between p-6 border-b border-slate-100 shrink-0">
            <h2 className="text-xl font-light uppercase tracking-tight text-slate-900">
              Spreadsheet — {pageTitle}
            </h2>
            <button
              onClick={() => { setIsSpreadsheetOpen(false); t.refresh(); }}
              className="p-2 text-slate-300 hover:text-black transition-colors"
            >
              <X size={20} />
            </button>
          </div>
          <div className="flex-1 p-6 min-h-0 overflow-hidden">
            <SpreadsheetEditor
              tableName={tableName}
              onClose={() => { setIsSpreadsheetOpen(false); t.refresh(); }}
            />
          </div>
        </div>
      )}

      <UniversalSelectionModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onSelect={() => { setIsModalOpen(false); t.refresh(); }}
        title={`New ${deriveLabel(tableName).slice(0, -1)}`}
        table={tableName}
      />
    </div>
  );
}

export default function GenericMasterTable(props: GenericMasterTableProps) {
  return (
    <Suspense fallback={null}>
      <GenericMasterTableInner {...props} />
    </Suspense>
  );
}