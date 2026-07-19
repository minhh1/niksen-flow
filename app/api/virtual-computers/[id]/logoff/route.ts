// app/api/virtual-computers/[id]/logoff/route.ts
// The explicit, primary disconnect signal (see the sidebar navigation guard
// in components/Sidebar.tsx / VmSessionContext) -- assigned member or admin
// only. Starts the snapshot right away rather than waiting for the next
// sweep cron tick; snapshotting itself can take many minutes (see
// lib/vmProviders/types.ts), so this only *starts* it and returns --
// app/api/virtual-computers/sweep/route.ts polls it to completion and
// destroys the instance once the snapshot is durable.
import { NextResponse } from "next/server";
import { authorizeCompanyMember } from "@/lib/documentTemplateAuth";
import { loadVm, startHibernate } from "../../_lib";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await authorizeCompanyMember();
  if (auth.error) return auth.error;
  const { admin, companyId, user, isAdmin } = auth;

  const vm = await loadVm(admin, companyId, id);
  if (!vm) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!isAdmin && vm.assigned_user_id !== user.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (vm.status !== "running") return NextResponse.json({ ok: true });

  await startHibernate(admin, vm);
  return NextResponse.json({ ok: true });
}
