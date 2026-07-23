"use client";

import { useParams } from "next/navigation";
import { Suspense } from "react";
import DashboardBuilderPage from "@/components/dashboard/DashboardBuilderPage";

// Custom tables have no builder route, so this is unconditionally the
// dashboard builder -- editing an existing dashboard (tableSlug = its slug)
// or creating a new one (tableSlug = 'new').
function DashboardBuilderPageInner() {
  const params = useParams();
  const slugParam = params.tableSlug as string;
  return <DashboardBuilderPage slugParam={slugParam} />;
}

export default function Builder() {
  return (
    <Suspense fallback={null}>
      <DashboardBuilderPageInner />
    </Suspense>
  );
}
