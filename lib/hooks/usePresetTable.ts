// lib/hooks/usePresetTable.ts
"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "@/lib/supabase";
import { preferenceService } from "@/lib/services/preferenceService";

interface UsePresetTableOptions {
  tableSlug: string;
  defaultCols: string[];
  defaultExpandCols?: string[];
  defaultExpandRelations?: string[];
  // Receives the resolved visible columns (table + expand combined) as
  // soon as the active preset is known — the fetcher no longer needs to
  // independently re-derive the preset itself.
  fetchItems: (visibleColumns: string[]) => Promise<any[]>;
}

function getCachedCompanyId(): string {
  try {
    const keys = Object.keys(localStorage).filter(k => k.startsWith('nk_cache_profile_'));
    for (const k of keys) {
      const p = JSON.parse(localStorage.getItem(k) || '{}');
      if (p?.data?.active_company_id) return p.data.active_company_id;
    }
  } catch {}
  return '';
}

export function usePresetTable({
  tableSlug,
  defaultCols,
  defaultExpandCols = [],
  defaultExpandRelations = [],
  fetchItems,
}: UsePresetTableOptions) {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const [tableCols, setTableCols] = useState<string[]>(defaultCols);
  const [expandCols, setExpandCols] = useState<string[]>(defaultExpandCols);
  const [colWidths, setColWidths] = useState<Record<string, number>>({});
  const [expandRelations, setExpandRelations] = useState<string[]>(defaultExpandRelations);

  const [presets, setPresets] = useState<any[]>([]);
  const [activePreset, setActivePreset] = useState("Default view");
  const [isBusy, setIsBusy] = useState(false);

  const [draggedIdx, setDraggedIdx] = useState<number | null>(null);
  const [expandedRow, setExpandedRow] = useState<string | null>(null);

  // Guard against re-running init when fetchItems ref changes due to
  // upstream dependency array instability
  const initRanRef = useRef(false);
  const fetchItemsRef = useRef(fetchItems);
  fetchItemsRef.current = fetchItems; // always latest without being a dep

  const init = useCallback(async () => {
    setLoading(true);

    // ── Step 1: show cache immediately ────────────────────────────
    // Get cached company to scope the cache key
    const cachedCompanyId = getCachedCompanyId();
    const companyScopedKey = `nk_cache_rows_${cachedCompanyId}_${tableSlug}`;

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

    // ── Step 2: load preferences (columns/presets) ────────────────
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setLoading(false); return; }

    const saved = await preferenceService.getByTable(user.id, tableSlug);

    let resolvedTableCols = defaultCols;
    let resolvedExpandCols = defaultExpandCols;

    if (saved?.length) {
      setPresets(saved);
      const active = saved.find((p: any) => p.is_active) || saved[0];
      resolvedTableCols = active.columns || defaultCols;
      resolvedExpandCols = active.expansion_columns || defaultExpandCols;
      setTableCols(resolvedTableCols);
      setExpandCols(resolvedExpandCols);
      setColWidths(active.column_widths || {});
      setExpandRelations(active.expand_relations || defaultExpandRelations);
      setActivePreset(active.preset_name);
    } else {
      // No user preferences yet — check for company default view
      setPresets([]);
      const { data: profile } = await supabase
        .from('profiles').select('active_company_id').eq('id', user.id).single();
      if (profile?.active_company_id) {
        const { data: companyDefault } = await supabase
          .from('company_default_views')
          .select('*')
          .eq('company_id', profile.active_company_id)
          .eq('table_slug', tableSlug)
          .single();
        if (companyDefault) {
          console.log(`[usePresetTable] Applying company default view for ${tableSlug}`);
          resolvedTableCols = companyDefault.columns || defaultCols;
          resolvedExpandCols = companyDefault.expansion_columns || defaultExpandCols;
          setTableCols(resolvedTableCols);
          setExpandCols(resolvedExpandCols);
          setColWidths(companyDefault.column_widths || {});
          setActivePreset(companyDefault.preset_name || 'Default view');
          // Save as user's own preference so it persists
          await supabase.from('user_column_preferences').insert({
            user_id: user.id,
            table_slug: tableSlug,
            columns: resolvedTableCols,
            expansion_columns: resolvedExpandCols,
            column_widths: companyDefault.column_widths || {},
            filters: companyDefault.filters || [],
            preset_name: companyDefault.preset_name || 'Default view',
            is_active: true,
          });
        }
      }
    }

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
  }, [tableSlug]); // fetchItems accessed via ref — stable dep array

  useEffect(() => { init(); }, [init]);

  const autoSave = async (
    t: string[] = tableCols, e: string[] = expandCols,
    w: Record<string, number> = colWidths, r: string[] = expandRelations
  ) => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    await preferenceService.save({
      user_id: user.id, table_slug: tableSlug, preset_name: activePreset,
      columns: t, expansion_columns: e, column_widths: w, expand_relations: r, is_active: true
    });
  };

  const handleSelectPreset = async (p: any) => {
    setIsBusy(true);
    setTableCols(p.columns);
    setExpandCols(p.expansion_columns || []);
    setColWidths(p.column_widths || {});
    setExpandRelations(p.expand_relations || []);
    setActivePreset(p.preset_name);

    const { data: { user } } = await supabase.auth.getUser();
    if (user) await preferenceService.setActive(user.id, tableSlug, p.preset_name);

    // Show cached data immediately — no blank flash while switching presets
    try {
      const cacheKey = `nk_cache_rows_${getCachedCompanyId()}_${tableSlug}`;
      const raw = localStorage.getItem(cacheKey);
      if (raw) {
        const entry = JSON.parse(raw);
        if (entry?.data?.length) {
          setItems(entry.data);
          setIsBusy(false);
          // Refetch in background to get any new columns this preset needs
          fetchItemsRef.current([...(p.columns || []), ...(p.expansion_columns || [])])
            .then(fresh => { if (fresh?.length) setItems(fresh); });
          return;
        }
      }
    } catch {}

    // No cache — must wait for fresh data
    const data = await fetchItemsRef.current([...(p.columns || []), ...(p.expansion_columns || [])]);
    if (data?.length) setItems(data);
    setIsBusy(false);
  };

  const handleSaveAsNew = async () => {
    const name = prompt("Name for this new view configuration:");
    if (!name) return;
    setIsBusy(true);
    const { data: { user } } = await supabase.auth.getUser();
    const { data: saved } = await preferenceService.save({
      user_id: user?.id!, table_slug: tableSlug, preset_name: name,
      columns: tableCols, expansion_columns: expandCols, column_widths: colWidths,
      expand_relations: expandRelations, is_active: true
    });
    if (saved) {
      setActivePreset(saved.preset_name);
      setPresets(prev => {
        const withoutNew = prev.filter(pr => pr.preset_name !== saved.preset_name);
        return [...withoutNew, saved].sort((a, b) => a.preset_name.localeCompare(b.preset_name));
      });
    }
    setIsBusy(false);
  };

  const handleDeletePreset = async (p: any) => {
    if (!window.confirm(`Delete the saved view "${p.preset_name}"? This can't be undone.`)) return;

    setIsBusy(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setIsBusy(false); return; }

    const { error } = await preferenceService.remove(user.id, tableSlug, p.preset_name);
    if (error) {
      alert("Couldn't delete this view. Please try again.");
      setIsBusy(false);
      return;
    }

    const remaining = presets.filter(pr => pr.preset_name !== p.preset_name);
    setPresets(remaining);

    if (activePreset === p.preset_name && remaining.length > 0) {
      const fallback = remaining.find(r => r.preset_name === "Default view") || remaining[0];
      await preferenceService.setActive(user.id, tableSlug, fallback.preset_name);
      setTableCols(fallback.columns);
      setExpandCols(fallback.expansion_columns || []);
      setColWidths(fallback.column_widths || {});
      setExpandRelations(fallback.expand_relations || []);
      setActivePreset(fallback.preset_name);

      // Show cached data immediately then refetch in background
      try {
        const cacheKey = `nk_cache_rows_${getCachedCompanyId()}_${tableSlug}`;
        const raw = localStorage.getItem(cacheKey);
        if (raw) {
          const entry = JSON.parse(raw);
          if (entry?.data?.length) setItems(entry.data);
        }
      } catch {}
      fetchItemsRef.current([...(fallback.columns || []), ...(fallback.expansion_columns || [])])
        .then(fresh => { if (fresh?.length) setItems(fresh); });
    }

    setIsBusy(false);
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
      setColWidths(curr => { autoSave(tableCols, expandCols, curr, expandRelations); return curr; });
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  };

  const handleReorder = (next: string[]) => {
    setTableCols(next);
    autoSave(next, expandCols, colWidths, expandRelations);
  };

  const handleToggleColumn = (fieldId: string, target: 'table' | 'expand' | 'none') => {
    const nt = tableCols.filter(c => c !== fieldId);
    const ne = expandCols.filter(c => c !== fieldId);
    if (target === 'table') nt.push(fieldId);
    if (target === 'expand') ne.push(fieldId);
    setTableCols(nt);
    setExpandCols(ne);
    autoSave(nt, ne, colWidths, expandRelations);
  };

  const handleToggleRelation = (key: string, on: boolean) => {
    const next = on ? [...expandRelations, key] : expandRelations.filter(k => k !== key);
    setExpandRelations(next);
    autoSave(tableCols, expandCols, colWidths, next);
  };

  const toggleExpandRow = (id: string) => {
    setExpandedRow(prev => prev === id ? null : id);
  };

  return {
    items, setItems, loading, refresh: init,
    tableCols, setTableCols, expandCols, setExpandCols, colWidths, setColWidths,
    expandRelations, setExpandRelations,
    draggedIdx, setDraggedIdx, expandedRow, toggleExpandRow,
    presets, activePreset, isBusy,
    handleSelectPreset, handleSaveAsNew, handleDeletePreset,
    handleToggleColumn, handleReorder, startResizing, handleToggleRelation,
  };
}