// Canonical, ordered array of typed, positioned dashboard widgets -- the one
// shape both Canvas (react-grid-layout) and Code (DSL) authoring modes read/
// write, and the one shape the view page renders from. See
// lib/dashboardWidgets/dsl.ts (DSL <-> widgets), lib/dashboardWidgets/legacyConvert.ts
// (old company_dashboards columns -> widgets), and
// components/dashboard/DashboardWidgetRenderer.tsx (widget -> presentational
// component dispatch).
//
// Field references inside widget config are company_table_fields.id (uuid) --
// the SAME convention as today's quick_add_field_ids/grid_field_ids/
// filter_field_ids/summary_tiles/chart_config -- not field_key text. The DSL
// is a human-typable *view* onto this: it parses field_key/label text down to
// ids at parse time and serializes ids back to the field's *current*
// field_key at serialize time, so canvas-mode widgets stay robust across a
// field rename (id doesn't change) while code-mode text always reflects
// current field_keys when regenerated.

export interface WidgetLayout {
  x: number; // 0-11, react-grid-layout grid units (12-column grid)
  y: number; // row index, stacking order in code mode
  w: number; // column span, 1-12
  h: number; // row span, in rowHeight units
}

interface BaseWidget {
  id: string; // crypto.randomUUID(), client-generated
  layout: WidgetLayout;
}

export interface HeadingWidget extends BaseWidget {
  type: 'heading';
  config: { text: string; level: 1 | 2 | 3 };
}

export interface TextWidget extends BaseWidget {
  type: 'text';
  config: { text: string };
}

export interface FilterBarWidget extends BaseWidget {
  type: 'filter_bar';
  config: { fieldIds: string[] }; // max 2, mirrors filter_field_ids today
}

export interface QuickAddFormWidget extends BaseWidget {
  type: 'quick_add_form';
  config: { fieldIds: string[] }; // ordered, mirrors quick_add_field_ids
}

export interface GridWidget extends BaseWidget {
  type: 'grid';
  config: {
    fieldIds: string[]; // ordered, mirrors grid_field_ids -- column order
    // Extra blank rows always kept at the bottom for fast spreadsheet-style
    // entry -- typing into any cell of one creates a new record from it.
    // Undefined/0 means none (today's behavior). Not offered on ledger
    // tables (see DashboardGrid's readOnly).
    emptyRowCount?: number;
    // Per-column pixel width, keyed by field id. Missing entries fall back
    // to DashboardGrid's default (140px) -- mirrors company_default_views'
    // column_widths for the system-table master grid (see MasterTable.tsx/
    // usePresetTable.ts), just stored on the widget instead of a separate
    // per-table-slug row, since a grid widget's columns are already
    // per-dashboard, not shared across every view of the source table.
    columnWidths?: Record<string, number>;
    // Only shows rows matching every condition (AND) -- a static, saved-with-
    // the-widget filter, distinct from the interactive filter bar (which the
    // viewer changes at will). Identical shape/semantics to a summary tile's
    // conditions -- see TileCondition below and computeSummaryTileValue's
    // sibling `filterByConditions` in compute.ts, which this reuses.
    conditions?: TileCondition[];
    // Per-column conditional highlight: when `condition` matches a row,
    // that row's cell in this column gets `color`'s background instead of
    // filtering rows out (that's `conditions` above) -- e.g. highlight
    // Duration red when it's over 8 hours, or Status amber when Overdue.
    // Condition can reference ANY field, not just the column it's attached
    // to (e.g. highlight Amount when Status = Overdue). One rule per
    // column; canvas-only (like columnWidths) -- not part of the DSL
    // grammar, dropped like any other visual-only setting on a code-mode
    // round-trip.
    columnHighlights?: Record<string, { condition: TileCondition; color: 'red' | 'amber' | 'emerald' }>;
    // Appends a footer row summing every visible number/currency column
    // across the grid's current (filtered) records -- draft/empty rows
    // never contribute, since they're not real records yet. Undefined/false
    // means no footer (today's behavior).
    showTotalsRow?: boolean;
  };
}

// One condition in a summary tile's "only count/sum rows where..." filter.
// Multiple conditions on one tile are ANDed together. `value` is unused for
// is_set/is_empty. Operator eligibility depends on the referenced field's
// type -- see OPERATORS_BY_FIELD_TYPE in
// components/dashboard/builder/WidgetConfigPanel.tsx -- but nothing here
// enforces that at the data level, so a hand-written DSL script (or old
// saved data) with a mismatched operator/type just evaluates loosely
// (e.g. 'gt' on a text field does a numeric compare that's always false for
// non-numeric text) rather than erroring.
export interface TileCondition {
  fieldId: string;
  operator: 'eq' | 'neq' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte' | 'is_set' | 'is_empty';
  value?: any;
}

// One tile per widget now (was one entry in a summary_tiles array) --
// independently positionable.
export interface SummaryTileWidget extends BaseWidget {
  type: 'summary_tile';
  config: {
    label: string;
    fieldId: string | null;
    // 'net' = sum(fieldId) - sum(fieldBId), e.g. a trust ledger's live
    // balance from Amount In / Amount Out columns.
    aggregate: 'sum' | 'count' | 'net';
    fieldBId?: string | null;
    // Every condition must match (AND) for a record to count. Preferred
    // going forward over filterFieldId/filterValue below, which are kept
    // only so widgets saved before multi-condition support still compute
    // correctly -- see computeSummaryTileValue in
    // lib/dashboardWidgets/compute.ts, which falls back to them as a single
    // implicit `eq` condition when `conditions` is absent.
    conditions?: TileCondition[];
    /** @deprecated superseded by `conditions` -- read as a fallback only */
    filterFieldId?: string | null;
    /** @deprecated superseded by `conditions` -- read as a fallback only */
    filterValue?: any;
  };
}

export type ChartGranularity = 'day' | 'week' | 'month';

// One measure plotted on a chart. Multiple series share the chart's single
// dateFieldId/granularity (one x-axis) but each independently filters its
// own rows via `conditions` -- identical shape/semantics to a summary
// tile's conditions (every condition ANDed) -- and aggregates its own
// value. Intended use: multiple measures of the SAME unit (e.g. billable
// vs non-billable hours, both hours) -- see the hint text in
// WidgetConfigPanel. Nothing here technically prevents mixing units on one
// chart; per the dataviz skill, that belongs on a second chart widget
// instead. Addressed by array index everywhere (no id field), matching how
// tile conditions are addressed.
export interface ChartSeriesConfig {
  label: string;
  valueFieldId: string | null;
  aggregate: 'sum' | 'count';
  conditions?: TileCondition[];
}

export interface ChartWidget extends BaseWidget {
  type: 'chart';
  config: {
    dateFieldId: string; // shared x-axis across every series -- never per-series
    // Absent/undefined = 'day' (today's only behavior, zero migration needed).
    granularity?: ChartGranularity;
    // Preferred going forward. Absent/empty falls back to the deprecated
    // valueFieldId/aggregate pair below as one implicit, unlabeled,
    // unconditioned series -- see resolveChartSeries in compute.ts, which
    // mirrors SummaryTileWidget's conditions/filterFieldId fallback (a
    // sibling function, not a generalization -- chart's legacy fallback is
    // a whole-series shape, not just a conditions-array shape).
    series?: ChartSeriesConfig[];
    /** @deprecated superseded by `series` -- read as a fallback only */
    valueFieldId?: string | null;
    /** @deprecated superseded by `series` -- read as a fallback only */
    aggregate?: 'sum' | 'count';
  };
}

// Trust three-way reconciliation (see components/dashboard/TrustReconciliationWidget.tsx).
// No config: it always reconciles the dashboard's own bound table, reading
// date/matter/amount_in/amount_out by field_key convention -- meaningful on
// an append-only ledger table, an empty state on any other table.
export interface TrustReconciliationWidget extends BaseWidget {
  type: 'trust_reconciliation';
  config: {};
}

// LEDES 1998B export list (see components/dashboard/LedesExportWidget.tsx).
// No config: lists the dashboard's bound table's records with a per-row
// LEDES download link, reading invoice_number/issue_date/status/
// total_inc_gst by field_key convention.
export interface LedesExportWidget extends BaseWidget {
  type: 'ledes_export';
  config: {};
}

// Per-matter trust ledger statement (see
// components/dashboard/TrustLedgerStatementWidget.tsx) -- every transaction
// for one matter, in date order, with running balance; printable. No
// config: the matter is picked interactively within the widget.
export interface TrustLedgerStatementWidget extends BaseWidget {
  type: 'trust_ledger_statement';
  config: {};
}

// Trust cash book (see components/dashboard/TrustCashBookWidget.tsx) --
// every transaction across every matter, in date order, with a
// whole-account running total. No config: date range is picked
// interactively within the widget.
export interface TrustCashBookWidget extends BaseWidget {
  type: 'trust_cash_book';
  config: {};
}

// Dormant/aged trust balances (see
// components/dashboard/TrustAgedBalancesWidget.tsx) -- matters with a live
// (non-zero) trust balance whose last transaction is older than
// dormantDays, a common trust-compliance check for unclaimed money.
export interface TrustAgedBalancesWidget extends BaseWidget {
  type: 'trust_aged_balances';
  config: { dormantDays: number };
}

export type DashboardWidget =
  | HeadingWidget | TextWidget | FilterBarWidget | QuickAddFormWidget
  | GridWidget | SummaryTileWidget | ChartWidget
  | TrustReconciliationWidget | LedesExportWidget
  | TrustLedgerStatementWidget | TrustCashBookWidget | TrustAgedBalancesWidget;

export type DashboardWidgetType = DashboardWidget['type'];
