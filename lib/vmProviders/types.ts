// lib/vmProviders/types.ts
// Shared interface every cloud provider adapter implements, so
// app/api/virtual-computers routes don't need to know which provider a
// given virtual_computers row uses.

export type VmProtocol = "vnc" | "rdp";
export type CloudProviderId = "digitalocean" | "aws" | "gcp";

export interface VmSizeOption {
  slug: string;
  label: string;
  vcpus: number;
  memoryMb: number;
  hourlyUsd: number;
}

// Shape depends on provider -- see supabase/company_cloud_credentials.sql.
export type ProviderCredentials = Record<string, string>;

export type VmOs = "linux" | "windows";

export interface CreateInstanceParams {
  credentials: ProviderCredentials;
  name: string;
  sizeSlug: string;
  region: string;
  protocol: VmProtocol;
  os: VmOs;
  remoteUsername: string;
  remotePassword: string;
}

export interface CreateInstanceResult {
  providerInstanceId: string;
  ipAddress: string | null;
}

export interface InstanceStatus {
  providerInstanceId: string;
  status: "provisioning" | "running" | "error";
  ipAddress: string | null;
}

export interface VmProvider {
  id: CloudProviderId;
  createInstance(params: CreateInstanceParams): Promise<CreateInstanceResult>;
  // `region` is unused by DigitalOcean (droplet IDs are looked up without it)
  // but required by AWS -- EC2 API calls are per-region regardless of an
  // instance ID's global uniqueness, so the region a VM was launched in has
  // to be threaded back through on every later call. Callers pass the
  // virtual_computers row's own `region` column, not the credential's
  // stored default region, since a company can launch VMs into a different
  // region than their credential's default.
  getInstance(credentials: ProviderCredentials, providerInstanceId: string, region: string): Promise<InstanceStatus>;
  destroyInstance(credentials: ProviderCredentials, providerInstanceId: string, region: string): Promise<void>;
}
