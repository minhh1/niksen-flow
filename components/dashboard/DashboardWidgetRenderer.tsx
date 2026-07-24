"use client";

// The one place widget -> presentational component dispatch happens. Used
// by both the view page (app/dashboard/[slug]/page.tsx, via
// StaticWidgetGrid) and the builder's Canvas editor (via react-grid-layout)
// and Code editor's preview pane -- so view-mode and every builder preview
// share one rendering code path.
import DashboardFilterBar from "./DashboardFilterBar";
import DashboardQuickAddForm from "./DashboardQuickAddForm";
import DashboardGrid from "./DashboardGrid";
import { SummaryTile } from "./DashboardSummaryTiles";
import DashboardActivityChart from "./DashboardActivityChart";
import TrustReconciliationWidget from "./TrustReconciliationWidget";
import LedesExportWidget from "./LedesExportWidget";
import TrustLedgerStatementWidget from "./TrustLedgerStatementWidget";
import TrustCashBookWidget from "./TrustCashBookWidget";
import TrustAgedBalancesWidget from "./TrustAgedBalancesWidget";
import { computeSummaryTileValue, computeChartSeries, filterByConditions } from "@/lib/dashboardWidgets/compute";
import type { DashboardWidget } from "@/lib/dashboardWidgets/types";
import type { CustomTableField, CustomTableRecord } from "@/lib/hooks/useCustomTable";

interface Props {
  widget: DashboardWidget;
  fields: CustomTableField[];
  fieldById: Map<string, CustomTableField>;
  records: CustomTableRecord[]; // already filtered by the active filter bar
  // Unfiltered -- trust_reconciliation/ledes_export ignore the dashboard's
  // ad-hoc filter bar (a matter filter narrowing the grid must not also
  // narrow a statutory reconciliation or an invoice export list).
  allRecords: CustomTableRecord[];
  tableId: string;
  // The source custom table's slug -- lets the grid widget's fullscreen
  // expand button link to that table's own full master-table page
  // (/dashboard/<slug>, see CustomTableMasterPage) instead of duplicating
  // that page's UI here. Undefined in builder-preview contexts (no real
  // saved table to link to) and in a few older callers that haven't been
  // threaded through yet -- the button simply doesn't render then, same
  // convention as isAdmin/onWidgetChange below.
  sourceTableSlug?: string | null;
  companyId: string;
  userId: string;
  filters: Record<string, any>;
  setFilter: (fieldId: string, value: any) => void;
  onChanged: () => void;
  // 'preview' is used by the Code editor's live preview pane, where the
  // dashboard being previewed may not be saved yet -- interactive bits
  // (adding a record, editing a cell) are disabled rather than wired to a
  // real tableId/companyId that might not correspond to what's on screen.
  mode?: 'view' | 'preview';
  // Source table is an append-only ledger (company_tables.is_ledger) --
  // grids render read-only; entries are only added via the quick-add form.
  isLedger?: boolean;
  // Gates the grid widget's column reorder/resize handles (see
  // DashboardGrid's isAdmin) -- omitted (undefined) in builder-preview
  // contexts on purpose, same as onWidgetChange below, so the only place
  // this ever shows is the live view page.
  isAdmin?: boolean;
  // Persists a change to THIS widget's own config (column reorder/resize
  // today) back to company_dashboards.widgets -- see useDashboardData's
  // updateWidget. Left undefined in builder-preview contexts, where the
  // widget's own config panel (gear icon) is the one place to edit it
  // instead of live drag interactions on a preview that isn't the real thing.
  onWidgetChange?: (updated: DashboardWidget) => void;
  // Extra field_key -> value pairs merged into every record created via the
  // quick_add_form/grid widgets below -- see DashboardQuickAddForm's doc
  // comment. Undefined everywhere except record-scoped dashboard tabs.
  fixedValues?: Record<string, any>;
}

export default function DashboardWidgetRenderer({
  widget, fields, fieldById, records, allRecords, tableId, sourceTableSlug, companyId, userId, filters, setFilter, onChanged, mode = 'view', isLedger,
  isAdmin, onWidgetChange, fixedValues,
}: Props) {
  switch (widget.type) {
    case 'heading': {
      const Tag = (`h${widget.config.level}` as unknown) as 'h1' | 'h2' | 'h3';
      const sizeClass = widget.config.level === 1 ? 'text-xl' : widget.config.level === 2 ? 'text-base' : 'text-sm';
      return <Tag className={`${sizeClass} font-bold text-slate-900`}>{widget.config.text || 'Heading'}</Tag>;
    }

    case 'text':
      return <p className="text-[13px] text-slate-600 whitespace-pre-wrap">{widget.config.text}</p>;

    case 'filter_bar':
      return (
        <DashboardFilterBar
          fields={fields}
          filterFieldIds={widget.config.fieldIds}
          filters={filters}
          onFilterChange={setFilter}
        />
      );

    case 'quick_add_form':
      if (mode === 'preview') {
        return <div className="p-4 bg-white border border-dashed border-slate-200 rounded-2xl text-[11px] text-slate-300 italic">Quick-add form preview (disabled while editing)</div>;
      }
      return (
        <DashboardQuickAddForm
          tableId={tableId}
          companyId={companyId}
          userId={userId}
          fields={fields}
          quickAddFieldIds={widget.config.fieldIds}
          onAdded={onChanged}
          fixedValues={fixedValues}
        />
      );

    case 'grid':
      return (
        <DashboardGrid
          tableId={tableId}
          companyId={companyId}
          fields={fields}
          gridFieldIds={widget.config.fieldIds}
          records={filterByConditions(records, widget.config.conditions, fieldById)}
          onChanged={mode === 'preview' ? () => {} : onChanged}
          readOnly={isLedger}
          emptyRowCount={mode === 'preview' ? 0 : (widget.config.emptyRowCount || 0)}
          columnWidths={widget.config.columnWidths}
          columnHighlights={widget.config.columnHighlights}
          showTotalsRow={widget.config.showTotalsRow}
          fieldById={fieldById}
          fullscreenHref={mode === 'view' && sourceTableSlug ? `/dashboard/${sourceTableSlug}` : undefined}
          isAdmin={mode === 'view' ? isAdmin : undefined}
          onReorder={onWidgetChange ? (fieldIds) => onWidgetChange({ ...widget, config: { ...widget.config, fieldIds } }) : undefined}
          onResize={onWidgetChange ? (fieldId, width) => onWidgetChange({
            ...widget,
            config: { ...widget.config, columnWidths: { ...(widget.config.columnWidths || {}), [fieldId]: width } },
          }) : undefined}
        />
      );

    case 'summary_tile': {
      const { value, fieldType } = computeSummaryTileValue(widget.config, records, fieldById);
      return <SummaryTile label={widget.config.label} value={value} fieldType={fieldType} />;
    }

    case 'chart': {
      const series = computeChartSeries(widget.config, records, fieldById);
      return <DashboardActivityChart series={series} granularity={widget.config.granularity ?? 'day'} />;
    }

    case 'trust_reconciliation':
      return <TrustReconciliationWidget records={allRecords} />;

    case 'ledes_export':
      return <LedesExportWidget records={allRecords} />;

    case 'trust_ledger_statement':
      return <TrustLedgerStatementWidget records={allRecords} />;

    case 'trust_cash_book':
      return <TrustCashBookWidget records={allRecords} />;

    case 'trust_aged_balances':
      return <TrustAgedBalancesWidget records={allRecords} dormantDays={widget.config.dormantDays} />;

    default:
      return null;
  }
}
