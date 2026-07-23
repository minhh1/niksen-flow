"use client";

import { useParams } from "next/navigation";
import { Suspense } from "react";
import { useCustomTables } from "@/lib/hooks/useCustomTables";
import CustomTableMasterPage from "@/components/CustomTableMasterPage";
import DashboardViewPage from "@/components/dashboard/DashboardViewPage";

// A single slug segment is shared between custom tables and dashboards (no
// separate URL namespace for either) -- so this checks which one the slug
// actually belongs to and renders that. Custom tables win on a collision
// since they were here first; a dashboard slug is auto-generated with a
// timestamp suffix (see DashboardBuilderPage) so a real collision is very
// unlikely.
function TableOrDashboardPageInner() {
  const params = useParams();
  const slug = params.tableSlug as string;
  const { tables, loading } = useCustomTables();

  if (loading) return null;

  const isCustomTable = tables.some(t => t.slug === slug);
  return isCustomTable
    ? <CustomTableMasterPage tableSlug={slug} />
    : <DashboardViewPage slug={slug} />;
}

export default function TableOrDashboardPage() {
  return (
    <Suspense fallback={null}>
      <TableOrDashboardPageInner />
    </Suspense>
  );
}
