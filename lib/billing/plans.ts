// lib/billing/plans.ts
// Static plan-tier config, mirroring lib/vmProviders/pricing.ts's
// hand-curated-table precedent -- tiers change rarely, and a matching
// Stripe Price object has to exist in the Stripe Dashboard regardless, so a
// DB table wouldn't be the real source of truth anyway.
import type { CloudProviderId } from "@/lib/vmProviders/types";

export type PlanId = "starter" | "standard" | "pro" | "payg";

// Flat fee charged per 1K tokens on self-hosted AI assistant usage (see
// ai_usage_events.sql) -- there's no real per-token provider cost to pass
// through since the company runs its own Ollama, but usage is still
// metered and billed, same shape as PAYG VMs' meteredServiceFeeUsdPerHour
// stacking on top of a real cost that can itself be zero.
export const PLATFORM_AI_SERVICE_FEE_USD_PER_1K_TOKENS = 0.0005;

export interface PlanConfig {
  id: PlanId;
  name: string;
  priceUsdDisplay: number; // display only -- Stripe is the source of truth for actual charges
  includedVmSlots: number;
  allowedSizes: Partial<Record<CloudProviderId, string[]>>;
  // Only set for the pay-as-you-go plan: no flat priceUsdDisplay, billed on
  // real VM uptime (see supabase/virtual_computer_usage_events.sql) plus
  // this flat per-hour platform fee stacked on the real provider rate.
  // Doesn't require a company_vm_schedules row the way the flat tiers do --
  // real usage is what's billed regardless of hours.
  meteredServiceFeeUsdPerHour?: number;
}

export const PLANS: Record<PlanId, PlanConfig> = {
  payg: {
    id: "payg",
    name: "Pay-as-you-go",
    priceUsdDisplay: 0,
    // Not a flat-fee slot budget to protect (cost passthrough is the whole
    // model) -- still capped as a safety net against runaway cost from a
    // mistake or compromised account, same order of magnitude as Pro.
    includedVmSlots: 10,
    allowedSizes: {
      digitalocean: ["s-2vcpu-4gb", "s-4vcpu-8gb", "s-4vcpu-8gb-intel", "s-4vcpu-8gb-240gb-intel", "s-8vcpu-16gb"],
      aws: ["t3.medium", "t3.large", "t3.xlarge", "m5.2xlarge"],
    },
    meteredServiceFeeUsdPerHour: 0.02,
  },
  starter: {
    id: "starter",
    name: "Starter",
    priceUsdDisplay: 49,
    includedVmSlots: 1,
    allowedSizes: { digitalocean: ["s-2vcpu-4gb"] },
  },
  standard: {
    id: "standard",
    name: "Standard",
    priceUsdDisplay: 149,
    includedVmSlots: 3,
    allowedSizes: { digitalocean: ["s-2vcpu-4gb", "s-4vcpu-8gb"] },
  },
  pro: {
    id: "pro",
    name: "Pro",
    priceUsdDisplay: 399,
    includedVmSlots: 10,
    // Windows (AWS) VMs are Pro-only -- AWS Windows Server licensing costs
    // noticeably more than the flat DigitalOcean droplet pricing the other
    // tiers assume (see lib/vmProviders/pricing.ts), so it's gated to the
    // plan that already has the most headroom.
    allowedSizes: {
      digitalocean: ["s-2vcpu-4gb", "s-4vcpu-8gb", "s-4vcpu-8gb-intel", "s-4vcpu-8gb-240gb-intel", "s-8vcpu-16gb"],
      aws: ["t3.medium", "t3.large", "t3.xlarge", "m5.2xlarge"],
    },
  },
};

export function isPlanId(v: string): v is PlanId {
  return v in PLANS;
}

// Price IDs differ between Stripe test/live mode -- one env var per tier,
// read lazily so a missing var only throws when a checkout is actually
// attempted, not at import/build time.
export function getStripePriceId(planId: PlanId): string {
  const key = `STRIPE_PRICE_${planId.toUpperCase()}`;
  const value = process.env[key];
  if (!value) throw new Error(`Missing env var ${key} for plan "${planId}"`);
  return value;
}
