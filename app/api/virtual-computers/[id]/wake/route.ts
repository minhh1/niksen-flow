// app/api/virtual-computers/[id]/wake/route.ts
// Recreates an instance from a hibernated VM's saved snapshot. Triggered
// either by the schedule's wake-ahead sweep (app/api/virtual-computers/sweep/route.ts)
// or automatically by the session page when it sees status === "hibernated"
// (a user arriving outside the pre-warmed window still gets a working
// "wake in progress" experience, just without the head start).
import { NextResponse } from "next/server";
import { authorizeCompanyMember } from "@/lib/documentTemplateAuth";
import { loadVm, wakeVm } from "../../_lib";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await authorizeCompanyMember();
  if (auth.error) return auth.error;
  const { admin, companyId, user, isAdmin } = auth;

  const vm = await loadVm(admin, companyId, id);
  if (!vm) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!isAdmin && vm.assigned_user_id !== user.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (vm.status !== "hibernated") return NextResponse.json({ ok: true, status: vm.status });
  if (!vm.snapshot_id) {
    return NextResponse.json({ error: "This virtual computer has no saved snapshot to wake from." }, { status: 500 });
  }

  await wakeVm(admin, vm);
  return NextResponse.json({ ok: true });
}
