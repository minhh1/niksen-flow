// app/api/billing/status/route.ts
// Any company member can view billing status; only admins can act on it
// (see checkout/portal routes).
import { NextResponse } from "next/server";
import { authorizeCompanyMember } from "@/lib/documentTemplateAuth";
import { PLANS, isPlanId } from "@/lib/billing/plans";

export async function GET() {
  const auth = await authorizeCompanyMember();
  if (auth.error) return auth.error;
  const { admin, companyId } = auth;

  const { data: sub } = await admin
    .from("company_subscriptions")
    .select("plan_id, status, current_period_end")
    .eq("company_id", companyId)
    .maybeSingle();

  const plan = sub?.plan_id && isPlanId(sub.plan_id) ? PLANS[sub.plan_id] : null;

  // Pay-as-you-go companies don't have a flat price to show -- surface an
  // approximate running total for the current month instead, summed from
  // the same usage ledger the sweep route reports to Stripe from (see
  // supabase/virtual_computer_usage_events.sql). Approximate because it
  // includes still-open (not yet ended) intervals estimated to "now".
  let usageThisMonthUsd: number | null = null;
  if (plan?.id === "payg") {
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const { data: events } = await admin
      .from("virtual_computer_usage_events")
      .select("started_at, ended_at, hourly_usd_at_start")
      .eq("company_id", companyId)
      .gte("started_at", monthStart.toISOString());
    const serviceFee = plan.meteredServiceFeeUsdPerHour ?? 0;
    usageThisMonthUsd = (events ?? []).reduce((sum: number, e: any) => {
      const end = e.ended_at ? new Date(e.ended_at) : new Date();
      const hours = (end.getTime() - new Date(e.started_at).getTime()) / (1000 * 60 * 60);
      return sum + hours * (e.hourly_usd_at_start + serviceFee);
    }, 0);
  }

  return NextResponse.json({
    subscription: sub
      ? { planId: sub.plan_id, status: sub.status, currentPeriodEnd: sub.current_period_end }
      : null,
    plan,
    plans: Object.values(PLANS),
    usageThisMonthUsd,
  });
}
