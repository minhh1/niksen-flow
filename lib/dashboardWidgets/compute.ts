// Per-widget aggregate math, extracted from what used to be inline in
// useDashboardData's summaryTiles/chartData useMemos (back when config was a
// fixed summary_tiles array + a single chart_config) -- same logic, just
// callable widget-by-widget now that each summary_tile is its own
// independently-positioned widget. See components/dashboard/DashboardWidgetRenderer.tsx.
import type { CustomTableField, CustomTableRecord } from "@/lib/hooks/useCustomTable";
import type { SummaryTileWidget, ChartWidget, ChartSeriesConfig, ChartGranularity, TileCondition } from "./types";

function isEmptyValue(v: any): boolean {
  return v === undefined || v === null || v === '';
}

// Loose-typed on purpose (matches this DSL/widget system's existing
// "never throw on mismatched input" posture -- see dsl.ts's error-collecting
// parser): 'gt'/'gte'/'lt'/'lte' against a non-numeric value just compare as
// NaN (always false) rather than throwing. Exported -- used directly by
// DashboardGrid for per-column highlight rules (a single row's match/no-match,
// not a whole-set filter, so it doesn't go through filterByConditions below).
export function evaluateCondition(cond: TileCondition, rawValue: any): boolean {
  switch (cond.operator) {
    case 'is_set': return !isEmptyValue(rawValue);
    case 'is_empty': return isEmptyValue(rawValue);
    case 'eq': return String(rawValue ?? '') === String(cond.value ?? '');
    case 'neq': return String(rawValue ?? '') !== String(cond.value ?? '');
    case 'contains': return String(rawValue ?? '').toLowerCase().includes(String(cond.value ?? '').toLowerCase());
    case 'gt': return Number(rawValue) > Number(cond.value);
    case 'gte': return Number(rawValue) >= Number(cond.value);
    case 'lt': return Number(rawValue) < Number(cond.value);
    case 'lte': return Number(rawValue) <= Number(cond.value);
    default: return true;
  }
}

// Keeps only rows matching every condition (AND) -- shared by
// computeSummaryTileValue's own conditions below and GridWidget's
// row-filter conditions (see DashboardWidgetRenderer's 'grid' case).
// A condition referencing a deleted field silently drops (doesn't zero
// every row), matching every other condition consumer in this file.
export function filterByConditions(
  records: CustomTableRecord[], conditions: TileCondition[] | undefined, fieldById: Map<string, CustomTableField>
): CustomTableRecord[] {
  if (!conditions?.length) return records;
  let rows = records;
  for (const cond of conditions) {
    const condField = fieldById.get(cond.fieldId);
    if (!condField) continue;
    rows = rows.filter(r => evaluateCondition(cond, r.values[condField.field_key]));
  }
  return rows;
}

// Normalizes a tile's conditions, preferring the new array but falling back
// to the old single filterFieldId/filterValue shape (an implicit `eq`) for
// widgets saved before multi-condition support -- see the deprecation notes
// on SummaryTileWidget in lib/dashboardWidgets/types.ts.
function resolveConditions(config: SummaryTileWidget['config']): TileCondition[] {
  if (config.conditions?.length) return config.conditions;
  if (config.filterFieldId) return [{ fieldId: config.filterFieldId, operator: 'eq', value: config.filterValue ?? true }];
  return [];
}

export function computeSummaryTileValue(
  config: SummaryTileWidget['config'],
  records: CustomTableRecord[],
  fieldById: Map<string, CustomTableField>
): { value: number; fieldType: string } {
  const field = config.fieldId ? fieldById.get(config.fieldId) : undefined;
  const rows = filterByConditions(records, resolveConditions(config), fieldById);
  const sumOf = (f: CustomTableField | undefined) =>
    rows.reduce((sum, r) => sum + (f ? Number(r.values[f.field_key]) || 0 : 0), 0);
  const value = config.aggregate === 'count'
    ? rows.length
    : config.aggregate === 'net'
      ? sumOf(field) - sumOf(config.fieldBId ? fieldById.get(config.fieldBId) : undefined)
      : sumOf(field);
  return { value, fieldType: field?.field_type || 'number' };
}

// Normalizes a chart's series, preferring the new array but falling back to
// the old singular valueFieldId/aggregate shape (one implicit, unlabeled,
// unconditioned series) for widgets saved before multi-series support.
// Unlike resolveConditions above, this resolves whole series objects, not
// just a conditions array -- tile's and chart's legacy shapes are unrelated,
// so this is a sibling function, not a generalization.
// Note: `config.series?.length` is falsy for BOTH an absent series array
// and a deliberately emptied one (e.g. every series row removed in the UI)
// -- both fall to the legacy fallback, so a chart with zero configured
// series still renders one flat (all-zero, since valueFieldId is usually
// null then) series rather than genuinely none. Harmless -- matches the
// builder's own "No series yet" empty state -- not distinguished further.
function resolveChartSeries(config: ChartWidget['config']): ChartSeriesConfig[] {
  if (config.series?.length) return config.series;
  return [{ label: '', valueFieldId: config.valueFieldId ?? null, aggregate: config.aggregate ?? 'sum', conditions: [] }];
}

// 'YYYY-MM-DD' for day (unchanged), Monday-of-week for week, 1st-of-month
// for month -- vanilla Date math, no library. `${day}T00:00:00` (no `Z`) is
// load-bearing: it forces LOCAL midnight parsing, so a bare date string
// doesn't shift a day backward in any negative-UTC-offset timezone (the
// bug a naive `new Date('YYYY-MM-DD')` -- which parses as UTC midnight --
// would introduce here).
export function bucketKey(dateVal: any, granularity: ChartGranularity): string {
  const day = String(dateVal).slice(0, 10);
  if (granularity === 'day') return day;
  const d = new Date(`${day}T00:00:00`);
  if (granularity === 'month') {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  }
  // week: Monday-of-week. getDay(): 0=Sun..6=Sat. Days back to Monday:
  // Sun->6, Mon->0, Tue->1, ... Sat->5, i.e. (dow + 6) % 7.
  const diffToMonday = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - diffToMonday);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export interface ChartSeriesResult {
  label: string;
  fieldType: string; // lets the renderer format per-series (e.g. currency), not chart-wide
  points: { bucket: string; value: number }[];
}

export function computeChartSeries(
  config: ChartWidget['config'],
  records: CustomTableRecord[],
  fieldById: Map<string, CustomTableField>
): ChartSeriesResult[] {
  const dateField = config.dateFieldId ? fieldById.get(config.dateFieldId) : undefined;
  if (!dateField) return [];
  const granularity = config.granularity ?? 'day';

  return resolveChartSeries(config).map(series => {
    const valueField = series.valueFieldId ? fieldById.get(series.valueFieldId) : undefined;
    const byBucket = new Map<string, number>();
    for (const r of records) {
      const dateVal = r.values[dateField.field_key];
      if (!dateVal) continue;
      const matches = (series.conditions || []).every(cond => {
        const condField = fieldById.get(cond.fieldId);
        // Referenced field deleted -- drop the condition (don't zero the row).
        return !condField || evaluateCondition(cond, r.values[condField.field_key]);
      });
      if (!matches) continue;
      const bucket = bucketKey(dateVal, granularity);
      const amount = series.aggregate === 'count' ? 1 : (valueField ? Number(r.values[valueField.field_key]) || 0 : 0);
      byBucket.set(bucket, (byBucket.get(bucket) || 0) + amount);
    }
    const points = Array.from(byBucket.entries())
      .map(([bucket, value]) => ({ bucket, value }))
      .sort((a, b) => a.bucket.localeCompare(b.bucket)); // lexicographic == chronological for all 3 key formats
    return {
      label: series.label || valueField?.label || (series.aggregate === 'count' ? 'Entries' : 'Value'),
      fieldType: valueField?.field_type || 'number',
      points,
    };
  });
}
