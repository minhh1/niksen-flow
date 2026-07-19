// app/api/virtual-computers/[id]/destroy/route.ts
// Admin-only. Tears down the underlying cloud instance and marks the row destroyed.
import { NextResponse } from "next/server";
import { authorizeCompanyMember } from "@/lib/documentTemplateAuth";
import { getProvider } from "@/lib/vmProviders/registry";
import { loadVm, resolveCredentials, closeUsageEvent } from "../../_lib";
import type { CloudProviderId } from "@/lib/vmProviders/types";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await authorizeCompanyMember();
  if (auth.error) return auth.error;
  const { admin, companyId, isAdmin } = auth;
  if (!isAdmin) return NextResponse.json({ error: "Admin access required" }, { status: 403 });

  const vm = await loadVm(admin, companyId, id);
  if (!vm) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (vm.status === "destroyed") return NextResponse.json({ ok: true });

  await admin.from("virtual_computers").update({ status: "destroying", updated_at: new Date().toISOString() }).eq("id", id);

  if (vm.provider_instance_id) {
    try {
      const credentials = await resolveCredentials(admin, vm);
      if (credentials) {
        const adapter = getProvider(vm.provider as CloudProviderId);
        await adapter.destroyInstance(credentials, vm.provider_instance_id, vm.region);
      }
    } catch (err) {
      // Don't fall through to marking the row destroyed -- if we can't
      // resolve credentials (e.g. a missing platform env var) or the
      // provider call fails, the underlying instance is still out there.
      await admin
        .from("virtual_computers")
        .update({
          status: "error",
          error_message: err instanceof Error ? err.message : "Destroy failed",
          updated_at: new Date().toISOString(),
        })
        .eq("id", id);
      return NextResponse.json({ error: err instanceof Error ? err.message : "Destroy failed" }, { status: 502 });
    }
  }

  await closeUsageEvent(admin, id);
  await admin
    .from("virtual_computers")
    .update({ status: "destroyed", destroyed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", id);

  return NextResponse.json({ ok: true });
}
