// lib/vmProviders/pricing.ts
// Static, hand-curated pricing reference for the cost-comparison view in the
// admin "create virtual computer" form. Deliberately NOT a live pricing API
// lookup -- AWS's Price List API and GCP's Cloud Billing Catalog API are
// both heavy to integrate for what is just a comparison aid. Refresh these
// numbers by hand periodically; last checked 2026-07-18.
import type { CloudProviderId, VmSizeOption } from "./types";

export const PRICING: Record<CloudProviderId, VmSizeOption[]> = {
  digitalocean: [
    { slug: "s-2vcpu-4gb", label: "2 vCPU / 4 GB", vcpus: 2, memoryMb: 4096, hourlyUsd: 0.036 },
    { slug: "s-4vcpu-8gb", label: "4 vCPU / 8 GB", vcpus: 4, memoryMb: 8192, hourlyUsd: 0.071 },
    { slug: "s-8vcpu-16gb", label: "8 vCPU / 16 GB", vcpus: 8, memoryMb: 16384, hourlyUsd: 0.143 },
  ],
  // Windows Server pricing, not Linux -- this provider is Windows-only (see
  // lib/vmProviders/aws.ts and PROVIDER_LABELS below), roughly double the
  // equivalent Linux on-demand rate from the Microsoft OS licensing
  // surcharge baked into the instance price.
  aws: [
    { slug: "t3.medium", label: "2 vCPU / 4 GB", vcpus: 2, memoryMb: 4096, hourlyUsd: 0.0832 },
    { slug: "t3.xlarge", label: "4 vCPU / 16 GB", vcpus: 4, memoryMb: 16384, hourlyUsd: 0.3328 },
    { slug: "m5.2xlarge", label: "8 vCPU / 32 GB", vcpus: 8, memoryMb: 32768, hourlyUsd: 0.952 },
  ],
  gcp: [
    { slug: "e2-medium", label: "2 vCPU / 4 GB", vcpus: 2, memoryMb: 4096, hourlyUsd: 0.0335 },
    { slug: "e2-standard-4", label: "4 vCPU / 16 GB", vcpus: 4, memoryMb: 16384, hourlyUsd: 0.134 },
    { slug: "e2-standard-8", label: "8 vCPU / 32 GB", vcpus: 8, memoryMb: 32768, hourlyUsd: 0.268 },
  ],
};

export const PROVIDER_LABELS: Record<CloudProviderId, string> = {
  digitalocean: "DigitalOcean",
  aws: "AWS (Windows + Office)",
  gcp: "GCP Compute Engine",
};
