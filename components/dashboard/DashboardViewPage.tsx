"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import * as LucideIcons from "lucide-react";
import { Settings, LayoutDashboard, Trash2, Maximize2, Minimize2 } from "lucide-react";
import { useProgressBarWhile } from "@/components/TopProgressBar";
import { useCompany } from "@/components/CompanyContext";
import { useDashboardData } from "@/lib/hooks/useDashboardData";
import { supabase } from "@/lib/supabase";
import { logSchemaChange } from "@/lib/services/schemaChangeLog";
import StaticWidgetGrid from "@/components/dashboard/builder/StaticWidgetGrid";
import DashboardWidgetRenderer from "@/components/dashboard/DashboardWidgetRenderer";

export default function DashboardViewPage({ slug }: { slug: string }) {
  const router = useRouter();
  const { companyId, userId, isAdmin } = useCompany();
  const {
    dashboard, tableDef, fields, fieldById, records, allRecords, loading, filters, setFilter, refetch, updateWidget,
  } = useDashboardData(slug);

  // Fullscreen = the whole dashboard (every widget), not any single one --
  // covers the persistent Sidebar too (fixed + a high z-index, rather than
  // anything Sidebar/layout.tsx need to know about) and drops the max-w-6xl
  // cap so widgets actually get to use the extra width. Esc exits, same as
  // the platform convention for the real Fullscreen API even though this
  // is a CSS-only "maximize within the page" rather than that API.
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFullscreen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen]);

  useProgressBarWhile(loading || !companyId || !userId);

  if (loading || !companyId || !userId) {
    return null;
  }
  if (!dashboard) {
    return <p className="text-center text-[12px] text-slate-400 py-20">Dashboard not found</p>;
  }

  const Icon = (LucideIcons as any)[dashboard.icon] || LayoutDashboard;

  const handleDelete = async () => {
    if (!window.confirm(`Delete "${dashboard.name}"? This moves it to Trash and can be restored later.`)) return;
    await supabase.from('company_dashboards').update({ deleted_at: new Date().toISOString() }).eq('id', dashboard.id);
    logSchemaChange({ companyId, actorId: userId, entityType: 'company_dashboard', entityId: dashboard.id, entityLabel: dashboard.name, action: 'delete', before: dashboard });
    router.push('/dashboard/properties');
  };

  return (
    <div className={fullscreen ? "fixed inset-0 z-50 bg-slate-50 overflow-y-auto" : ""}>
      <div className={fullscreen ? "p-8 space-y-4" : "max-w-6xl mx-auto p-8 space-y-4"}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-xl flex items-center justify-center" style={{ backgroundColor: `${dashboard.color}20` }}>
              <Icon size={18} style={{ color: dashboard.color }} />
            </div>
            <h1 className="text-xl font-light uppercase tracking-tight text-slate-900">{dashboard.name}</h1>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setFullscreen(p => !p)}
              title={fullscreen ? "Exit full screen (Esc)" : "Full screen"}
              aria-label={fullscreen ? "Exit full screen" : "Full screen"}
              className="p-2.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-full transition-all"
            >
              {fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            </button>
            {isAdmin && (
              <>
                <Link
                  href={`/dashboard/${slug}/builder`}
                  className="flex items-center gap-2 px-4 py-2 bg-slate-50 text-slate-600 rounded-full text-[11px] font-bold hover:bg-slate-100 transition-all"
                >
                  <Settings size={13} /> Edit
                </Link>
                <button
                  onClick={handleDelete}
                  title="Delete dashboard"
                  aria-label="Delete dashboard"
                  className="p-2.5 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-full transition-all"
                >
                  <Trash2 size={15} />
                </button>
              </>
            )}
          </div>
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
    </div>
  );
}
