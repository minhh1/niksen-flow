// app/api/virtual-computers/_lib.ts
// Shared helpers for the virtual-computers API routes. Not a route itself
// (no exported HTTP method handlers), so Next.js ignores it for routing.
import crypto from "crypto";
import { getPlatformCredentials } from "@/lib/vmProviders/platformCredentials";
import { getProvider } from "@/lib/vmProviders/registry";
import { nextLocalMidnight } from "@/lib/vmProviders/scheduling";
import type { CloudProviderId, ProviderCredentials, VmOs, VmProtocol } from "@/lib/vmProviders/types";

// Classic VNC auth (TigerVNC) truncates passwords to 8 characters, so keep
// the generated password short -- used for the Linux VNC/xrdp path only.
export function generateRemotePassword(): string {
  const raw = crypto.randomBytes(6).toString("base64").replace(/[^a-zA-Z0-9]/g, "");
  return (raw + "Ax9K2qLp").slice(0, 8);
}

// Windows local-account passwords have no 8-char cap and, unlike the Linux
// path, are checked against a default complexity policy (needs 3 of:
// upper/lower/digit/symbol) -- build one that always satisfies it. The
// symbol set deliberately excludes quote/backtick/dollar/backslash
// characters, since this password gets embedded in a PowerShell double-
// quoted string in the EC2 UserData script (see lib/vmProviders/aws.ts) and
// those would need extra escaping to be safe there.
export function generateWindowsPassword(): string {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghjkmnpqrstuvwxyz";
  const digits = "23456789";
  const symbols = "!@#%^&*_-+=";
  const all = upper + lower + digits + symbols;

  const pick = (chars: string) => chars[crypto.randomInt(chars.length)];
  const required = [pick(upper), pick(lower), pick(digits), pick(symbols)];
  const rest = Array.from({ length: 12 }, () => pick(all));

  // Fisher-Yates shuffle so the required characters aren't predictably in
  // the first 4 positions.
  const password = [...required, ...rest];
  for (let i = password.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [password[i], password[j]] = [password[j], password[i]];
  }
  return password.join("");
}

export async function loadVm(admin: any, companyId: string, id: string) {
  const { data } = await admin.from("virtual_computers").select("*").eq("id", id).maybeSingle();
  if (!data || data.company_id !== companyId) return null;
  return data;
}

export interface CompanyVmSchedule {
  enabled: boolean;
  days: number[];
  start_time: string;
  end_time: string;
  timezone: string;
  enforce_end_time: boolean;
}

const DEFAULT_SCHEDULE: CompanyVmSchedule = {
  enabled: false,
  days: [1, 2, 3, 4, 5],
  start_time: "09:00",
  end_time: "17:00",
  timezone: "UTC",
  enforce_end_time: false,
};

// Companies without a configured schedule (payg companies aren't required
// to have one -- see supabase/company_vm_schedules.sql) fall back to a
// disabled default so callers can always evaluate against a schedule shape
// without a null check at every call site.
export async function getCompanySchedule(admin: any, companyId: string): Promise<CompanyVmSchedule> {
  const { data } = await admin.from("company_vm_schedules").select("*").eq("company_id", companyId).maybeSingle();
  if (!data) return DEFAULT_SCHEDULE;
  return {
    enabled: data.enabled,
    days: data.days ?? DEFAULT_SCHEDULE.days,
    start_time: data.start_time ?? DEFAULT_SCHEDULE.start_time,
    end_time: data.end_time ?? DEFAULT_SCHEDULE.end_time,
    timezone: data.timezone ?? DEFAULT_SCHEDULE.timezone,
    enforce_end_time: data.enforce_end_time ?? false,
  };
}

// Resolves the credentials to hand a provider adapter for a given VM row,
// branching on billing_mode. Platform-billed rows have credential_id = NULL
// by design -- routes that only checked `vm.credential_id` before calling
// into a provider adapter would silently skip platform-billed VMs (destroy
// would mark the row destroyed without ever deleting the underlying
// instance; status would poll-loop stuck on "provisioning" forever).
export async function resolveCredentials(
  admin: any,
  vm: { billing_mode: string; credential_id: string | null; provider: string }
): Promise<ProviderCredentials | null> {
  if (vm.billing_mode === "platform") {
    return getPlatformCredentials(vm.provider as CloudProviderId);
  }
  if (!vm.credential_id) return null;
  const { data } = await admin
    .from("company_cloud_credentials")
    .select("credentials")
    .eq("id", vm.credential_id)
    .maybeSingle();
  return data?.credentials ?? null;
}

// Usage ledger (see supabase/virtual_computer_usage_events.sql) -- opens a
// row whenever a VM starts running (create or wake) and closes it whenever
// it stops (hibernate, destroy, or error), regardless of billing plan.
// Logged unconditionally since it's cheap and plan-agnostic; only
// pay-as-you-go companies actually have it reported to Stripe (see
// lib/billing/usageReporting.ts), but the history is there if a company
// switches plans later.
export async function openUsageEvent(admin: any, vm: { id: string; company_id: string; hourly_usd_at_creation: number | null }): Promise<void> {
  await admin.from("virtual_computer_usage_events").insert({
    vm_id: vm.id,
    company_id: vm.company_id,
    started_at: new Date().toISOString(),
    hourly_usd_at_start: vm.hourly_usd_at_creation ?? 0,
  });
}

export async function closeUsageEvent(admin: any, vmId: string): Promise<void> {
  await admin
    .from("virtual_computer_usage_events")
    .update({ ended_at: new Date().toISOString() })
    .eq("vm_id", vmId)
    .is("ended_at", null);
}

// Shared by the explicit logoff route and the sweep cron's inferred-disconnect
// paths (evening heartbeat fallback, midnight backstop, schedule end-of-day)
// -- starts (but doesn't wait out) the snapshot, since it can take far
// longer than one request should block for. The sweep route's own
// 'snapshotting' pass is what polls this to completion and destroys the
// instance once the snapshot is durable.
export async function startHibernate(admin: any, vm: { id: string; provider: string; provider_instance_id: string; region: string; billing_mode: string; credential_id: string | null }): Promise<void> {
  try {
    const credentials = await resolveCredentials(admin, vm);
    if (!credentials) throw new Error("Missing credentials for this virtual computer.");
    const adapter = getProvider(vm.provider as CloudProviderId);
    const { snapshotTaskId } = await adapter.startSnapshot(credentials, vm.provider_instance_id, vm.region);
    await admin
      .from("virtual_computers")
      .update({
        status: "snapshotting",
        snapshot_task_id: snapshotTaskId,
        last_seen_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", vm.id);
  } catch (err) {
    // Note: the underlying instance is presumably still running here (the
    // snapshot never started) -- deliberately NOT closing the usage event,
    // since the VM is still actually accruing cost, just no longer mid an
    // active hibernate attempt.
    await admin
      .from("virtual_computers")
      .update({
        status: "error",
        error_message: err instanceof Error ? err.message : "Could not start snapshot",
        updated_at: new Date().toISOString(),
      })
      .eq("id", vm.id);
  }
}

// Shared by the wake route and the sweep cron's schedule wake-ahead pass --
// relaunches a hibernated VM from its saved snapshot.
export async function wakeVm(
  admin: any,
  vm: {
    id: string;
    company_id: string;
    provider: string;
    name: string;
    size_slug: string;
    region: string;
    protocol: string;
    os: VmOs;
    remote_username: string;
    remote_password: string;
    snapshot_id: string;
    billing_mode: string;
    credential_id: string | null;
    hourly_usd_at_creation: number | null;
  }
): Promise<void> {
  await admin.from("virtual_computers").update({ status: "provisioning", updated_at: new Date().toISOString() }).eq("id", vm.id);
  try {
    const credentials = await resolveCredentials(admin, vm);
    if (!credentials) throw new Error("Missing credentials for this virtual computer.");
    const adapter = getProvider(vm.provider as CloudProviderId);
    const result = await adapter.createInstance({
      credentials,
      name: vm.name,
      sizeSlug: vm.size_slug,
      region: vm.region,
      protocol: vm.protocol as VmProtocol,
      os: vm.os,
      remoteUsername: vm.remote_username,
      remotePassword: vm.remote_password,
      fromSnapshotId: vm.snapshot_id,
    });
    await openUsageEvent(admin, vm);
    const schedule = await getCompanySchedule(admin, vm.company_id);
    const deadline = nextLocalMidnight(new Date(), schedule.timezone);
    await admin
      .from("virtual_computers")
      .update({
        provider_instance_id: result.providerInstanceId,
        ip_address: result.ipAddress,
        last_seen_at: new Date().toISOString(),
        hibernate_deadline: deadline.toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", vm.id);
  } catch (err) {
    await admin
      .from("virtual_computers")
      .update({
        status: "error",
        error_message: err instanceof Error ? err.message : "Could not wake this virtual computer",
        updated_at: new Date().toISOString(),
      })
      .eq("id", vm.id);
  }
}
