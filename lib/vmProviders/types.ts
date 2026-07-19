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
  // Set when waking a hibernated VM: launch from this saved snapshot/image
  // instead of the provider's base image, and skip whatever first-boot
  // provisioning is already baked into it (see createSnapshot below).
  fromSnapshotId?: string;
}

export interface StartSnapshotResult {
  // Opaque provider-specific handle to poll via getSnapshotStatus. For AWS
  // this IS the eventual AMI/image ID (DescribeImages polls the same ID
  // that CreateImage returns); for DigitalOcean it's a droplet action ID,
  // which resolves to a *different* value (the new snapshot's image ID)
  // once the action completes.
  snapshotTaskId: string;
}

export interface SnapshotStatus {
  status: "pending" | "completed" | "error";
  // Only set once status is "completed" -- the value to store as
  // virtual_computers.snapshot_id and later pass back as `fromSnapshotId`.
  snapshotId: string | null;
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
  // Snapshotting a running instance takes anywhere from several minutes to
  // ~40+ minutes (DigitalOcean scales with used disk; AWS Windows AMIs
  // commonly take 10-20 min) -- far longer than a single serverless
  // function invocation should block for. So this is split into a
  // fire-and-forget start plus a cheap, repeatable status check: the sweep
  // route (app/api/virtual-computers/sweep/route.ts) calls startSnapshot
  // once, then calls getSnapshotStatus on subsequent cron passes until it
  // reports "completed", only then calling destroyInstance.
  startSnapshot(credentials: ProviderCredentials, providerInstanceId: string, region: string): Promise<StartSnapshotResult>;
  getSnapshotStatus(
    credentials: ProviderCredentials,
    providerInstanceId: string,
    region: string,
    snapshotTaskId: string
  ): Promise<SnapshotStatus>;
}
