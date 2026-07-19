// lib/billing/plans.ts
// Static plan-tier config, mirroring lib/vmProviders/pricing.ts's
// hand-curated-table precedent -- tiers change rarely, and a matching
// Stripe Price object has to exist in the Stripe Dashboard regardless, so a
// DB table wouldn't be the real source of truth anyway.
import type { CloudProviderId } from "@/lib/vmProviders/types";

export type PlanId = "starter" | "standard" | "pro";

export interface PlanConfig {
  id: PlanId;
  name: string;
  priceUsdDisplay: number; // display only -- Stripe is the source of truth for actual charges
  includedVmSlots: number;
  allowedSizes: Partial<Record<CloudProviderId, string[]>>;
}

export const PLANS: Record<PlanId, PlanConfig> = {
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
      digitalocean: ["s-2vcpu-4gb", "s-4vcpu-8gb", "s-8vcpu-16gb"],
      aws: ["t3.medium", "t3.xlarge", "m5.2xlarge"],
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
