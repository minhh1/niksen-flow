// lib/vmProviders/regions.ts
// Static, curated list of currently-active regions per provider, for the
// region <select> in the admin create-VM form -- a free-text region field
// previously let through both typos and deprecated/mismatched region
// slugs, producing real DigitalOcean 422s ("no regions available that
// match your request"). Not full per-size availability checking -- DO's
// standard Basic droplet sizes (the only sizes this repo offers, see
// lib/vmProviders/pricing.ts) are available in all regions listed here as
// of writing; refresh this list by hand if that ever changes.
import type { CloudProviderId } from "./types";

export const REGIONS: Partial<Record<CloudProviderId, { slug: string; label: string }[]>> = {
  digitalocean: [
    { slug: "nyc1", label: "New York 1" },
    { slug: "nyc3", label: "New York 3" },
    { slug: "sfo3", label: "San Francisco 3" },
    { slug: "tor1", label: "Toronto 1" },
    { slug: "lon1", label: "London 1" },
    { slug: "ams3", label: "Amsterdam 3" },
    { slug: "fra1", label: "Frankfurt 1" },
    { slug: "sgp1", label: "Singapore 1" },
    { slug: "blr1", label: "Bangalore 1" },
    { slug: "syd1", label: "Sydney 1" },
  ],
  aws: [
    { slug: "us-east-1", label: "N. Virginia" },
    { slug: "us-west-2", label: "Oregon" },
    { slug: "eu-west-1", label: "Ireland" },
    { slug: "eu-central-1", label: "Frankfurt" },
    { slug: "ap-southeast-1", label: "Singapore" },
    { slug: "ap-southeast-2", label: "Sydney" },
  ],
};
