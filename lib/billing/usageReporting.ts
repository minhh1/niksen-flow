// lib/billing/usageReporting.ts
// Reports accumulated pay-as-you-go VM usage to Stripe's Billing Meters API
// (confirmed present in the installed stripe SDK, v22.3.2:
// stripe.billing.meterEvents.create -- node_modules/stripe/cjs/resources/Billing/MeterEvents.d.ts).
// Called periodically from app/api/virtual-computers/sweep/route.ts.
//
// Requires a Stripe Billing Meter with event_name METER_EVENT_NAME below
// (`default_aggregation: { formula: "sum" }`, `customer_mapping.event_payload_key:
// "stripe_customer_id"`, `value_settings.event_payload_key: "value"`) and a
// metered Price attached to it at $0.01/unit (the value reported here is in
// *cents*, since the real per-VM rate varies by size and can't be expressed
// as a single Stripe unit price otherwise) -- already set up in the test-mode
// Stripe account (meter mtr_test_61V4D72CI6XwzdGW041Qz3sfMzgyFMi8, price
// price_1TupA1Qz3sfMzgyFSWsHJ5Ay / STRIPE_PRICE_PAYG). Re-create both in the
// live-mode account before going live. If either is ever missing,
// reportPaygUsage() throws -- the catch in the sweep route leaves events
// unreported (retried next pass) rather than losing them.
import { getStripe } from "@/lib/stripe";

const METER_EVENT_NAME = "vm_usage_cents";
const PAYG_SERVICE_FEE_USD_PER_HOUR = 0.02;

interface UsageEventRow {
  id: string;
  started_at: string;
  ended_at: string;
  hourly_usd_at_start: number;
}

// Reports every not-yet-reported closed usage interval for one Stripe
// customer as a single aggregated meter event (cheaper than one event per
// interval, and Stripe's meter aggregation is a sum regardless). Marks the
// reported rows so a later pass doesn't double-report them.
export async function reportUsageForCustomer(
  admin: any,
  stripeCustomerId: string,
  events: UsageEventRow[]
): Promise<void> {
  if (events.length === 0) return;
  const totalCents = events.reduce((sum, e) => {
    const hours = (new Date(e.ended_at).getTime() - new Date(e.started_at).getTime()) / (1000 * 60 * 60);
    const costUsd = hours * (e.hourly_usd_at_start + PAYG_SERVICE_FEE_USD_PER_HOUR);
    return sum + Math.round(costUsd * 100);
  }, 0);
  if (totalCents <= 0) {
    await admin
      .from("virtual_computer_usage_events")
      .update({ reported_to_stripe_at: new Date().toISOString() })
      .in("id", events.map((e) => e.id));
    return;
  }

  const stripe = getStripe();
  await stripe.billing.meterEvents.create({
    event_name: METER_EVENT_NAME,
    payload: { stripe_customer_id: stripeCustomerId, value: String(totalCents) },
  });

  await admin
    .from("virtual_computer_usage_events")
    .update({ reported_to_stripe_at: new Date().toISOString() })
    .in("id", events.map((e) => e.id));
}
