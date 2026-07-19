// lib/vmProviders/registry.ts
import type { CloudProviderId, VmProvider } from "./types";
import { digitalOceanProvider } from "./digitalocean";
import { awsProvider } from "./aws";

// AWS is Windows-only here (see aws.ts) -- added specifically so Microsoft
// Office can be preinstalled, not as general-purpose AWS Linux support.
// GCP still appears in the admin cost-comparison table (see
// lib/vmProviders/pricing.ts) but isn't selectable until an adapter lands.
export const PROVISIONABLE_PROVIDERS: CloudProviderId[] = ["digitalocean", "aws"];

const PROVIDERS: Partial<Record<CloudProviderId, VmProvider>> = {
  digitalocean: digitalOceanProvider,
  aws: awsProvider,
};

export function getProvider(id: CloudProviderId): VmProvider {
  const provider = PROVIDERS[id];
  if (!provider) throw new Error(`Provider "${id}" is not yet provisionable.`);
  return provider;
}
