// lib/hooks/usePresetTable.ts
"use client";

import { useState, useEffect, useCallback } from "react";
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

  const init = useCallback(async () => {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setLoading(false); return; }

    const saved = await preferenceService.getByTable(user.id, tableSlug);

    let resolvedTableCols = defaultCols;
    let resolvedExpandCols = defaultExpandCols;

    if (saved?.length) {
      setPresets(saved);
      const active = saved.find(p => p.is_active) || saved[0];
      resolvedTableCols = active.columns || defaultCols;
      resolvedExpandCols = active.expansion_columns || defaultExpandCols;
      setTableCols(resolvedTableCols);
      setExpandCols(resolvedExpandCols);
      setColWidths(active.column_widths || {});
      setExpandRelations(active.expand_relations || defaultExpandRelations);
      setActivePreset(active.preset_name);
    } else {
      setPresets([]);
    }

    const data = await fetchItems([...resolvedTableCols, ...resolvedExpandCols]);
    setItems(data);
    setLoading(false);
  }, [tableSlug, fetchItems]); // eslint-disable-line react-hooks/exhaustive-deps

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

    // Switching presets can introduce columns whose data was never
    // fetched (e.g. a category this preset shows that the previous one
    // didn't) — re-fetch with the newly selected preset's full column
    // list so nothing renders blank.
    const data = await fetchItems([...(p.columns || []), ...(p.expansion_columns || [])]);
    setItems(data);

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

      const data = await fetchItems([...(fallback.columns || []), ...(fallback.expansion_columns || [])]);
      setItems(data);
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