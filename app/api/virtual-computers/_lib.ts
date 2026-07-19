// app/api/virtual-computers/_lib.ts
// Shared helpers for the virtual-computers API routes. Not a route itself
// (no exported HTTP method handlers), so Next.js ignores it for routing.
import crypto from "crypto";
import { getPlatformCredentials } from "@/lib/vmProviders/platformCredentials";
import type { CloudProviderId, ProviderCredentials } from "@/lib/vmProviders/types";

// Classic VNC auth (TigerVNC) truncates passwords to 8 characters, so keep
// the generated password short -- used for the Linux VNC/xrdp path only.
export function generateRemotePassword(): string {
  const raw = crypto.randomBytes(6).toString("base64").replace(/[^a-zA-Z0-9]/g, "");
  return (raw + "Ax9K2qLp").slice(0, 8);
}

// Windows local-account passwords have no 8-char cap and, unlike the Linux
// path, are checked against a default complexity policy (needs 3 of:
// upper/lower/digit/symbol) -- build one that always satisfies it. The
// symbol set deliberately excludes quote/backtick/dollar/backslash
// characters, since this password gets embedded in a PowerShell double-
// quoted string in the EC2 UserData script (see lib/vmProviders/aws.ts) and
// those would need extra escaping to be safe there.
export function generateWindowsPassword(): string {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghjkmnpqrstuvwxyz";
  const digits = "23456789";
  const symbols = "!@#%^&*_-+=";
  const all = upper + lower + digits + symbols;

  const pick = (chars: string) => chars[crypto.randomInt(chars.length)];
  const required = [pick(upper), pick(lower), pick(digits), pick(symbols)];
  const rest = Array.from({ length: 12 }, () => pick(all));

  // Fisher-Yates shuffle so the required characters aren't predictably in
  // the first 4 positions.
  const password = [...required, ...rest];
  for (let i = password.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [password[i], password[j]] = [password[j], password[i]];
  }
  return password.join("");
}

export async function loadVm(admin: any, companyId: string, id: string) {
  const { data } = await admin.from("virtual_computers").select("*").eq("id", id).maybeSingle();
  if (!data || data.company_id !== companyId) return null;
  return data;
}

// Resolves the credentials to hand a provider adapter for a given VM row,
// branching on billing_mode. Platform-billed rows have credential_id = NULL
// by design -- routes that only checked `vm.credential_id` before calling
// into a provider adapter would silently skip platform-billed VMs (destroy
// would mark the row destroyed without ever deleting the underlying
// instance; status would poll-loop stuck on "provisioning" forever).
export async function resolveCredentials(
  admin: any,
  vm: { billing_mode: string; credential_id: string | null; provider: string }
): Promise<ProviderCredentials | null> {
  if (vm.billing_mode === "platform") {
    return getPlatformCredentials(vm.provider as CloudProviderId);
  }
  if (!vm.credential_id) return null;
  const { data } = await admin
    .from("company_cloud_credentials")
    .select("credentials")
    .eq("id", vm.credential_id)
    .maybeSingle();
  return data?.credentials ?? null;
}
