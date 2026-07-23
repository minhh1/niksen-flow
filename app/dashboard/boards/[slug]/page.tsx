"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import * as LucideIcons from "lucide-react";
import { Settings, LayoutDashboard } from "lucide-react";
import { useProgressBarWhile } from "@/components/TopProgressBar";
import { useCompany } from "@/components/CompanyContext";
import { useDashboardData } from "@/lib/hooks/useDashboardData";
import StaticWidgetGrid from "@/components/dashboard/builder/StaticWidgetGrid";
import DashboardWidgetRenderer from "@/components/dashboard/DashboardWidgetRenderer";

export default function DashboardViewPage() {
  const params = useParams();
  const slug = params.slug as string;
  const { companyId, userId, isAdmin } = useCompany();
  const {
    dashboard, tableDef, fields, fieldById, records, allRecords, loading, filters, setFilter, refetch, updateWidget,
  } = useDashboardData(slug);

  useProgressBarWhile(loading || !companyId || !userId);

  if (loading || !companyId || !userId) {
    return null;
  }
  if (!dashboard) {
    return <p className="text-center text-[12px] text-slate-400 py-20">Dashboard not found</p>;
  }

  const Icon = (LucideIcons as any)[dashboard.icon] || LayoutDashboard;

  return (
    <div className="max-w-6xl mx-auto p-8 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-xl flex items-center justify-center" style={{ backgroundColor: `${dashboard.color}20` }}>
            <Icon size={18} style={{ color: dashboard.color }} />
          </div>
          <h1 className="text-xl font-light uppercase tracking-tight text-slate-900">{dashboard.name}</h1>
        </div>
        {isAdmin && (
          <Link
            href={`/dashboard/dashboards/${slug}/builder`}
            className="flex items-center gap-2 px-4 py-2 bg-slate-50 text-slate-600 rounded-full text-[11px] font-bold hover:bg-slate-100 transition-all"
          >
            <Settings size={13} /> Edit
          </Link>
        )}
      </div>

      <StaticWidgetGrid widgets={dashboard.widgets}>
        {(w) => (
          <DashboardWidgetRenderer
            widget={w}
            fields={fields}
            fieldById={fieldById}
            records={records}
            allRecords={allRecords}
            tableId={dashboard.source_table_id}
            companyId={companyId}
            userId={userId}
            filters={filters}
            setFilter={setFilter}
            onChanged={refetch}
            mode="view"
            isLedger={tableDef?.is_ledger}
            isAdmin={isAdmin}
            onWidgetChange={updateWidget}
          />
        )}
      </StaticWidgetGrid>
    </div>
  );
}
