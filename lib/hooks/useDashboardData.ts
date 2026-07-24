"use client";

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { supabase } from "@/lib/supabase";
import { useCustomTable } from "./useCustomTable";
import { ensureDashboardWidgetsMigrated } from "@/lib/dashboardWidgets/ensureMigrated";
import { logSchemaChange } from "@/lib/services/schemaChangeLog";
import type { DashboardWidget } from "@/lib/dashboardWidgets/types";

export interface SummaryTileConfig {
  label: string;
  fieldId: string | null;
  aggregate: 'sum' | 'count';
  filterFieldId?: string | null;
  filterValue?: any;
}

export interface ChartConfig {
  dateFieldId: string;
  valueFieldId: string | null;
  aggregate: 'sum' | 'count';
}

export interface CompanyDashboard {
  id: string;
  company_id: string;
  name: string;
  slug: string;
  icon: string;
  color: string;
  source_table_id: string;
  quick_add_field_ids: string[];
  grid_field_ids: string[];
  filter_field_ids: string[];
  summary_tiles: SummaryTileConfig[];
  chart_config: ChartConfig | null;
  widgets: DashboardWidget[];
  code_source: string | null;
  builder_mode: 'canvas' | 'code';
}

// Loads a dashboard's config, resolves its source custom table via
// useCustomTable, and computes filtered records + summary tile values +
// daily chart series client-side over that table's full (unpaginated)
// record set -- same scale assumption useCustomTable already makes
// elsewhere in the app.
export function useDashboardData(dashboardSlug: string) {
  const [dashboard, setDashboard] = useState<CompanyDashboard | null>(null);
  const [sourceTableSlug, setSourceTableSlug] = useState<string | null>(null);
  const [dashboardLoading, setDashboardLoading] = useState(true);
  const [filters, setFilters] = useState<Record<string, any>>({});

  useEffect(() => {
    let active = true;
    setDashboardLoading(true);
    (async () => {
      const { data: dash } = await supabase
        .from('company_dashboards').select('*').eq('slug', dashboardSlug).is('deleted_at', null).maybeSingle();
      if (!active) return;
      if (dash && !dash.widgets_migrated_at) {
        dash.widgets = await ensureDashboardWidgetsMigrated(dash);
      }
      if (!active) return;
      setDashboard(dash);
      if (dash?.source_table_id) {
        const { data: tbl } = await supabase.from('company_tables').select('slug').eq('id', dash.source_table_id).maybeSingle();
        if (active) setSourceTableSlug(tbl?.slug || null);
      }
      setDashboardLoading(false);
    })();
    return () => { active = false; };
  }, [dashboardSlug]);

  const { tableDef, fields, records, loading: tableLoading, refetch: refetchTable } = useCustomTable(sourceTableSlug);

  const fieldById = useMemo(() => new Map(fields.map(f => [f.id, f])), [fields]);

  const setFilter = useCallback((fieldId: string, value: any) => {
    setFilters(prev => ({ ...prev, [fieldId]: value }));
  }, []);

  // Any date-type field in the filter bar defaults to today the first time
  // the dashboard's config + fields are both available -- e.g. a Time Entry
  // dashboard should open already scoped to today's entries (grid, summary
  // tiles) rather than showing everything, and since "today" is computed
  // fresh on each load, it changes every day without any stored state.
  // Seeded once (defaultsSeededRef), not on every fields/dashboard change,
  // so it never overwrites a filter the user has since cleared or changed.
  const defaultsSeededRef = useRef(false);
  useEffect(() => {
    if (defaultsSeededRef.current || !dashboard || fields.length === 0) return;
    defaultsSeededRef.current = true;
    const filterBarWidget = dashboard.widgets.find(w => w.type === 'filter_bar');
    if (!filterBarWidget || filterBarWidget.type !== 'filter_bar') return;
    const today = new Date().toISOString().slice(0, 10);
    const dateFieldIds = filterBarWidget.config.fieldIds.filter(id => fields.find(f => f.id === id)?.field_type === 'date');
    if (dateFieldIds.length) {
      setFilters(prev => {
        const next = { ...prev };
        for (const id of dateFieldIds) if (next[id] === undefined) next[id] = today;
        return next;
      });
    }
  }, [dashboard, fields]);

  // Persists a single widget's config change (column reorder/resize from
  // DashboardGrid today) back into company_dashboards.widgets. Updates
  // local state optimistically -- the drag interaction that triggers this
  // already gives its own instant visual feedback (DashboardGrid's
  // liveWidths), so this just needs to not visibly "snap back" once the
  // network round-trip lands -- then persists and logs it through the same
  // schema-history mechanism the builder page's own saves use, so this is
  // revertible like any other dashboard edit.
  const updateWidget = useCallback(async (updated: DashboardWidget) => {
    if (!dashboard) return;
    const before = dashboard;
    const nextWidgets = dashboard.widgets.map(w => w.id === updated.id ? updated : w);
    setDashboard({ ...dashboard, widgets: nextWidgets });

    const { data: { user } } = await supabase.auth.getUser();
    const { data: after } = await supabase
      .from('company_dashboards').update({ widgets: nextWidgets }).eq('id', dashboard.id).select().single();
    if (after) {
      logSchemaChange({
        companyId: dashboard.company_id, actorId: user?.id ?? null, entityType: 'company_dashboard',
        entityId: dashboard.id, entityLabel: dashboard.name, action: 'update', before, after,
      });
    }
  }, [dashboard]);

  const filteredRecords = useMemo(() => {
    const active = Object.entries(filters).filter(([, v]) => v !== null && v !== undefined && v !== '');
    if (active.length === 0) return records;
    return records.filter(r => active.every(([fieldId, val]) => {
      const field = fieldById.get(fieldId);
      if (!field) return true;
      return String(r.values[field.field_key] ?? '') === String(val);
    }));
  }, [records, filters, fieldById]);

  const summaryTiles = useMemo(() => {
    return (dashboard?.summary_tiles || []).map(tile => {
      const field = tile.fieldId ? fieldById.get(tile.fieldId) : undefined;
      let rows = filteredRecords;
      if (tile.filterFieldId) {
        const filterField = fieldById.get(tile.filterFieldId);
        if (filterField) {
          rows = rows.filter(r => String(r.values[filterField.field_key] ?? '') === String(tile.filterValue));
        }
      }
      const value = tile.aggregate === 'count'
        ? rows.length
        : rows.reduce((sum, r) => sum + (field ? Number(r.values[field.field_key]) || 0 : 0), 0);
      return { label: tile.label, value, fieldType: field?.field_type || 'number' };
    });
  }, [dashboard, filteredRecords, fieldById]);

  const chartData = useMemo(() => {
    const config = dashboard?.chart_config;
    const dateField = config ? fieldById.get(config.dateFieldId) : undefined;
    if (!config || !dateField) return [];
    const valueField = config.valueFieldId ? fieldById.get(config.valueFieldId) : undefined;

    const byDay = new Map<string, number>();
    for (const r of filteredRecords) {
      const dateVal = r.values[dateField.field_key];
      if (!dateVal) continue;
      const day = String(dateVal).slice(0, 10);
      const amount = config.aggregate === 'count' ? 1 : (valueField ? Number(r.values[valueField.field_key]) || 0 : 0);
      byDay.set(day, (byDay.get(day) || 0) + amount);
    }
    return Array.from(byDay.entries())
      .map(([date, value]) => ({ date, value }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [dashboard, filteredRecords, fieldById]);

  return {
    dashboard,
    tableDef,
    fields,
    fieldById,
    records: filteredRecords,
    allRecords: records,
    loading: dashboardLoading || tableLoading,
    filters,
    setFilter,
    summaryTiles,
    chartData,
    // Record-level mutations (add/edit/delete) only ever need the source
    // table's data reloaded, not the dashboard's own config row -- refetchTable
    // swaps records in without flipping a loading flag, so the page never
    // unmounts into a spinner just because one entry was added.
    refetch: refetchTable,
    updateWidget,
  };
}
