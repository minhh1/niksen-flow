// app/api/virtual-computers/[id]/heartbeat/route.ts
// Coarse fallback signal only -- see the "Fallback" layer in the plan's
// disconnect-detection design. The session page only calls this after 7pm
// company-local time, roughly every 30 minutes; it is NOT a live presence
// check, just bumps last_seen_at so the sweep route can tell whether the
// last two pings (~60 min) showed any activity.
import { NextResponse } from "next/server";
import { authorizeCompanyMember } from "@/lib/documentTemplateAuth";
import { loadVm } from "../../_lib";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await authorizeCompanyMember();
  if (auth.error) return auth.error;
  const { admin, companyId, user, isAdmin } = auth;

  const vm = await loadVm(admin, companyId, id);
  if (!vm) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!isAdmin && vm.assigned_user_id !== user.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  if (vm.status === "running") {
    await admin.from("virtual_computers").update({ last_seen_at: new Date().toISOString() }).eq("id", id);
  }

  return NextResponse.json({ ok: true });
}
