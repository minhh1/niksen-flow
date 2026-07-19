// app/api/virtual-computers/[id]/extend/route.ts
// Called when the user clicks "Still working?" near the midnight backstop
// (see VirtualComputerSessionPage) -- pushes hibernate_deadline out to the
// following local midnight so the sweep route doesn't force-hibernate
// mid-session. Also bumps last_seen_at since clicking the prompt is itself
// unambiguous activity.
import { NextResponse } from "next/server";
import { authorizeCompanyMember } from "@/lib/documentTemplateAuth";
import { loadVm, getCompanySchedule } from "../../_lib";
import { nextLocalMidnight } from "@/lib/vmProviders/scheduling";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await authorizeCompanyMember();
  if (auth.error) return auth.error;
  const { admin, companyId, user, isAdmin } = auth;

  const vm = await loadVm(admin, companyId, id);
  if (!vm) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!isAdmin && vm.assigned_user_id !== user.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (vm.status !== "running") return NextResponse.json({ ok: true });

  const schedule = await getCompanySchedule(admin, companyId);
  const now = new Date();
  // nextLocalMidnight(now, tz) resolves to *tonight's* boundary (the one
  // that's imminent, which is exactly what we're trying to get past) --
  // the new deadline is the one after that.
  const tonightMidnight = nextLocalMidnight(now, schedule.timezone);
  const newDeadline = new Date(tonightMidnight.getTime() + 24 * 60 * 60 * 1000);

  await admin
    .from("virtual_computers")
    .update({ hibernate_deadline: newDeadline.toISOString(), last_seen_at: now.toISOString() })
    .eq("id", id);

  return NextResponse.json({ ok: true, hibernateDeadline: newDeadline.toISOString() });
}
