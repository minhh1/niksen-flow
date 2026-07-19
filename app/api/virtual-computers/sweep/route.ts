// app/api/virtual-computers/sweep/route.ts
// Cron-only -- iterates across every company's VMs, not just one caller's,
// so this must never be reachable by a company member. Vercel Cron signs
// its own requests with CRON_SECRET as a Bearer token (see vercel.json);
// this route verifies that rather than trusting the network. Run every
// 5-10 minutes.
//
// Three passes, matching the plan's detection layers:
// 1. Resolve any in-progress snapshot ('snapshotting' VMs) and destroy the
//    source instance once it's durable.
// 2. Evaluate 'running' VMs against the midnight backstop, the evening-only
//    heartbeat fallback, and (if a company opted in) strict schedule
//    end-of-day enforcement.
// 3. Wake-ahead any 'hibernated' VM whose company schedule's start_time is
//    coming up, with enough lead time to be fully running by then.
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getProvider } from "@/lib/vmProviders/registry";
import { resolveCredentials, startHibernate, wakeVm, getCompanySchedule, closeUsageEvent } from "../_lib";
import { hourInTimezone, todayAtLocalTime, dayOfWeekInTimezone } from "@/lib/vmProviders/scheduling";
import { reportUsageForCustomer } from "@/lib/billing/usageReporting";
import type { CloudProviderId } from "@/lib/vmProviders/types";

const HEARTBEAT_FALLBACK_HOUR = 19; // 7pm -- before this, inactivity means nothing.
const HEARTBEAT_STALE_MS = 65 * 60 * 1000; // ~2 missed 30-min heartbeats.
const WAKE_LEAD_MS: Record<string, number> = {
  linux: 10 * 60 * 1000, // DigitalOcean restore is the faster path.
  windows: 20 * 60 * 1000, // AWS Windows restore is the slower path.
};

function adminClient() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function isAuthorizedCron(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  return !!secret && req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const admin = adminClient();
  const now = new Date();

  const { data: snapshotting } = await admin.from("virtual_computers").select("*").eq("status", "snapshotting");
  for (const vm of snapshotting ?? []) {
    if (!vm.snapshot_task_id) continue;
    try {
      const credentials = await resolveCredentials(admin, vm);
      if (!credentials) throw new Error("Missing credentials for this virtual computer.");
      const adapter = getProvider(vm.provider as CloudProviderId);
      const result = await adapter.getSnapshotStatus(credentials, vm.provider_instance_id, vm.region, vm.snapshot_task_id);
      if (result.status === "pending") continue;
      if (result.status === "error") {
        await admin
          .from("virtual_computers")
          .update({ status: "error", error_message: "Snapshot failed", updated_at: now.toISOString() })
          .eq("id", vm.id);
        continue;
      }
      // Only destroy the source instance once the snapshot is confirmed
      // durable -- destroying earlier risks losing data still being copied.
      await adapter.destroyInstance(credentials, vm.provider_instance_id, vm.region);
      await closeUsageEvent(admin, vm.id);
      await admin
        .from("virtual_computers")
        .update({
          status: "hibernated",
          snapshot_id: result.snapshotId,
          snapshot_task_id: null,
          hibernated_at: now.toISOString(),
          updated_at: now.toISOString(),
        })
        .eq("id", vm.id);
    } catch (err) {
      await admin
        .from("virtual_computers")
        .update({
          status: "error",
          error_message: err instanceof Error ? err.message : "Could not finish hibernating",
          updated_at: now.toISOString(),
        })
        .eq("id", vm.id);
    }
  }

  const { data: running } = await admin.from("virtual_computers").select("*").eq("status", "running");
  for (const vm of running ?? []) {
    const schedule = await getCompanySchedule(admin, vm.company_id);
    const tz = schedule.timezone;

    // Midnight backstop -- unconditional, ignores activity/heartbeats
    // entirely. This is what actually bounds the day by default, not
    // end_time (see point 8 of the plan).
    if (vm.hibernate_deadline && new Date(vm.hibernate_deadline).getTime() <= now.getTime()) {
      await startHibernate(admin, vm);
      continue;
    }

    // Evening-only heartbeat fallback -- a quiet VM during the workday is
    // normal, not a signal; only treat staleness as "logged off" after 7pm.
    const lastSeenMs = vm.last_seen_at ? new Date(vm.last_seen_at).getTime() : new Date(vm.created_at).getTime();
    if (hourInTimezone(now, tz) >= HEARTBEAT_FALLBACK_HOUR && now.getTime() - lastSeenMs >= HEARTBEAT_STALE_MS) {
      await startHibernate(admin, vm);
      continue;
    }

    // Opt-in strict schedule enforcement only -- the default
    // (enforce_end_time = false) leaves end_time as informational only.
    if (schedule.enabled && schedule.enforce_end_time && schedule.days.includes(dayOfWeekInTimezone(now, tz))) {
      const [endH, endM] = schedule.end_time.split(":").map(Number);
      const endInstant = todayAtLocalTime(now, tz, endH, endM);
      if (now.getTime() >= endInstant.getTime()) {
        await startHibernate(admin, vm);
      }
    }
  }

  const { data: hibernated } = await admin.from("virtual_computers").select("*").eq("status", "hibernated");
  for (const vm of hibernated ?? []) {
    if (!vm.snapshot_id) continue;
    const schedule = await getCompanySchedule(admin, vm.company_id);
    if (!schedule.enabled || !schedule.days.includes(dayOfWeekInTimezone(now, schedule.timezone))) continue;

    const [startH, startM] = schedule.start_time.split(":").map(Number);
    const startInstant = todayAtLocalTime(now, schedule.timezone, startH, startM);
    const leadMs = WAKE_LEAD_MS[vm.os] ?? WAKE_LEAD_MS.linux;
    const wakeAt = new Date(startInstant.getTime() - leadMs);
    if (now.getTime() >= wakeAt.getTime() && now.getTime() < startInstant.getTime()) {
      await wakeVm(admin, vm);
    }
  }

  // Report accumulated pay-as-you-go usage to Stripe -- only companies
  // actually on the payg plan, and only intervals that closed since the
  // last report (see supabase/virtual_computer_usage_events.sql).
  const { data: paygSubs } = await admin
    .from("company_subscriptions")
    .select("company_id, stripe_customer_id, status")
    .eq("plan_id", "payg")
    .in("status", ["active", "trialing"]);
  for (const sub of paygSubs ?? []) {
    const { data: unreported } = await admin
      .from("virtual_computer_usage_events")
      .select("id, started_at, ended_at, hourly_usd_at_start")
      .eq("company_id", sub.company_id)
      .not("ended_at", "is", null)
      .is("reported_to_stripe_at", null);
    try {
      await reportUsageForCustomer(admin, sub.stripe_customer_id, unreported ?? []);
    } catch {
      // Leave events unreported -- retried next sweep pass. Most likely
      // cause: the Stripe Meter/Price for payg hasn't been set up yet (see
      // lib/billing/usageReporting.ts's header comment).
    }
  }

  return NextResponse.json({ ok: true });
}
