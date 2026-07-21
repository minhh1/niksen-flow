// lib/hooks/usePresetTable.ts
"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "@/lib/supabase";

const DEFAULT_PRESET_NAME = "Default view";

export type SortDirection = 'asc' | 'desc';
export type SortMode = 'name' | 'number';

export interface SortState {
  colId: string;
  direction: SortDirection;
  mode?: SortMode;
}

interface UsePresetTableOptions {
  tableSlug: string;
  defaultCols: string[];
  defaultExpandCols?: string[];
  defaultExpandRelations?: string[];
  userId?: string | null; // pass from context to skip auth call
  companyId?: string | null; // pass from context — columns are company-wide, not personal
  isAdmin?: boolean; // only admins may change the company's column layout
  schemaReady?: boolean; // false while defaultCols/defaultExpandCols are still resolving
  fetchItems: (visibleColumns: string[]) => Promise<any[]>;
}

export function usePresetTable({
  tableSlug,
  defaultCols,
  defaultExpandCols = [],
  defaultExpandRelations = [],
  userId: providedUserId,
  companyId,
  isAdmin = false,
  schemaReady = true,
  fetchItems,
}: UsePresetTableOptions) {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const [tableCols, setTableCols] = useState<string[]>(defaultCols);
  const [expandCols, setExpandCols] = useState<string[]>(defaultExpandCols);
  const [colWidths, setColWidths] = useState<Record<string, number>>({});
  const [expandRelations, setExpandRelations] = useState<string[]>(defaultExpandRelations);
  const [activePreset, setActivePreset] = useState(DEFAULT_PRESET_NAME);
  const [sort, setSort] = useState<SortState | null>(null);

  const [draggedIdx, setDraggedIdx] = useState<number | null>(null);
  const [expandedRow, setExpandedRow] = useState<string | null>(null);

  const fetchItemsRef = useRef(fetchItems);
  fetchItemsRef.current = fetchItems; // always latest without being a dep

  // Most callers already have the user id via context (providedUserId) —
  // only hit auth.getUser() when that isn't available.
  const resolveUserId = useCallback(async (): Promise<string | null> => {
    if (providedUserId) return providedUserId;
    const { data: { user } } = await supabase.auth.getUser();
    return user?.id ?? null;
  }, [providedUserId]);

  // Columns/widths are company-wide (set by admins, shared by every member) —
  // wait for companyId from context rather than re-resolving it here, so we
  // don't duplicate the identity fetch GenericMasterTable already does.
  const init = useCallback(async () => {
    if (!companyId || !schemaReady) return;
    setLoading(true);

    // ── Step 1: show cached rows immediately ─────────────────────
    const companyScopedKey = `nk_cache_rows_${companyId}_${tableSlug}`;
    let hasCachedData = false;
    try {
      const raw = localStorage.getItem(companyScopedKey);
      if (raw) {
        const entry = JSON.parse(raw);
        if (entry?.data?.length) {
          setItems(entry.data);
          setLoading(false);
          hasCachedData = true;
        }
      }
    } catch {}

    // ── Step 2: load the company's column layout (single source of truth) ──
    let resolvedTableCols = defaultCols;
    let resolvedExpandCols = defaultExpandCols;
    let resolvedWidths: Record<string, number> = {};
    let resolvedPresetName = DEFAULT_PRESET_NAME;
    let resolvedSort: SortState | null = null;

    const { data: companyView } = await supabase
      .from('company_default_views')
      .select('*')
      .eq('company_id', companyId)
      .eq('table_slug', tableSlug)
      .maybeSingle();

    if (companyView) {
      resolvedTableCols = companyView.columns?.length ? companyView.columns : defaultCols;
      resolvedExpandCols = companyView.expansion_columns || defaultExpandCols;
      resolvedWidths = companyView.column_widths || {};
      resolvedPresetName = companyView.preset_name || DEFAULT_PRESET_NAME;
      resolvedSort = companyView.sort || null;
    }

    setTableCols(resolvedTableCols);
    setExpandCols(resolvedExpandCols);
    setColWidths(resolvedWidths);
    setActivePreset(resolvedPresetName);
    setSort(resolvedSort);

    // ── Step 3: fetch fresh data ──────────────────────────────────
    // If we had cached data, fetch in background and only update if changed
    if (hasCachedData) {
      fetchItemsRef.current([...resolvedTableCols, ...resolvedExpandCols])
        .then(fresh => { if (fresh?.length) setItems(fresh); })
        .catch(() => {});
    } else {
      // No cache — must wait
      const data = await fetchItemsRef.current([...resolvedTableCols, ...resolvedExpandCols]);
      if (data?.length) setItems(data);
      setLoading(false);
    }
  }, [tableSlug, companyId, schemaReady]); // fetchItems/defaultCols accessed via closure — recreated only when identity/company/schema readiness changes

  useEffect(() => { init(); }, [init]);

  // Persists the company-wide column layout (+ sort). Admin-only — every
  // member reads this same row, so an admin's change is immediately
  // "hardcoded" for the team.
  const saveCompanyColumns = async (
    t: string[] = tableCols, e: string[] = expandCols,
    w: Record<string, number> = colWidths,
    s: SortState | null = sort,
  ) => {
    if (!isAdmin || !companyId) return;
    const userId = await resolveUserId();
    await supabase.from('company_default_views').upsert({
      company_id: companyId,
      table_slug: tableSlug,
      columns: t,
      expansion_columns: e,
      column_widths: w,
      sort: s,
      preset_name: activePreset,
      created_by: userId,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'company_id,table_slug' });
  };

  const startResizing = (colId: string, e: React.MouseEvent) => {
    if (!isAdmin) return;
    const startX = e.pageX;
    const startWidth = colWidths[colId] || 250;
    // Track the latest widths outside React state so the save-on-mouseup
    // call is a plain statement, not a side effect inside a setState
    // updater — React (Strict Mode) may invoke updater functions twice.
    let latestWidths = colWidths;
    const onMouseMove = (mE: MouseEvent) => {
      const newWidth = Math.max(150, startWidth + (mE.pageX - startX));
      setColWidths(prev => {
        latestWidths = { ...prev, [colId]: newWidth };
        return latestWidths;
      });
    };
    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      saveCompanyColumns(tableCols, expandCols, latestWidths, sort);
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  };

  const handleReorder = (next: string[]) => {
    if (!isAdmin) return;
    setTableCols(next);
    saveCompanyColumns(next, expandCols, colWidths);
  };

  const handleToggleColumn = (fieldId: string, target: 'table' | 'expand' | 'none') => {
    if (!isAdmin) return;
    const nt = tableCols.filter(c => c !== fieldId);
    const ne = expandCols.filter(c => c !== fieldId);
    if (target === 'table') nt.push(fieldId);
    if (target === 'expand') ne.push(fieldId);
    setTableCols(nt);
    setExpandCols(ne);
    saveCompanyColumns(nt, ne, colWidths);
  };

  // Sorting itself is free for everyone (session-only, applied client-side) —
  // but when an admin sorts, that choice also becomes the durable company
  // default, same as column changes. Mirrors how filters work: instant for
  // everyone, permanent only through the admin-authored / saved-view path.
  const handleSort = (colId: string, direction: SortDirection, mode?: SortMode) => {
    const next: SortState | null =
      (sort?.colId === colId && sort?.direction === direction && sort?.mode === mode)
        ? null
        : { colId, direction, mode };
    setSort(next);
    if (isAdmin) saveCompanyColumns(tableCols, expandCols, colWidths, next);
  };

  const toggleExpandRow = (id: string) => {
    setExpandedRow(prev => prev === id ? null : id);
  };

  return {
    items, setItems, loading, refresh: init,
    tableCols, expandCols, colWidths,
    expandRelations, setExpandRelations,
    draggedIdx, setDraggedIdx, expandedRow, toggleExpandRow,
    activePreset, sort, handleSort,
    handleToggleColumn, handleReorder, startResizing,
  };
}
