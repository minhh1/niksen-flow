// app/api/virtual-computers/create/route.ts
// Admin-only. Provisions a VM via the chosen provider adapter and assigns it
// to one company member. See "Access model" in the virtual computers plan --
// there is no self-service launch flow for regular members.
//
// billingMode "byo" (default): company pays the cloud provider directly via
// its own company_cloud_credentials row (credentialId required).
// billingMode "platform": the platform pays the cloud provider; the company
// pays the platform via its fixed monthly Stripe subscription instead (see
// lib/billing/plans.ts, supabase/company_subscriptions.sql) -- no
// credentialId needed, but requires an active/trialing subscription with a
// free slot, and only sizes included in the plan are allowed.
import { NextRequest, NextResponse } from "next/server";
import { authorizeCompanyMember } from "@/lib/documentTemplateAuth";
import { getProvider, PROVISIONABLE_PROVIDERS } from "@/lib/vmProviders/registry";
import { PRICING } from "@/lib/vmProviders/pricing";
import { getPlatformCredentials } from "@/lib/vmProviders/platformCredentials";
import { PLANS, isPlanId } from "@/lib/billing/plans";
import { generateRemotePassword, generateWindowsPassword, openUsageEvent, getCompanySchedule } from "../_lib";
import { nextLocalMidnight } from "@/lib/vmProviders/scheduling";
import type { CloudProviderId, ProviderCredentials, VmOs, VmProtocol } from "@/lib/vmProviders/types";

export async function POST(req: NextRequest) {
  const auth = await authorizeCompanyMember();
  if (auth.error) return auth.error;
  const { admin, companyId, user, isAdmin } = auth;
  if (!isAdmin) return NextResponse.json({ error: "Admin access required" }, { status: 403 });

  const body = await req.json().catch(() => null);
  const { name, provider, sizeSlug, region, protocol, credentialId, assignedUserId, os: requestedOs } = body || {};
  const billingMode = body?.billingMode === "platform" ? "platform" : "byo";

  if (!PROVISIONABLE_PROVIDERS.includes(provider)) {
    return NextResponse.json({ error: `Provider "${provider}" is not provisionable yet` }, { status: 400 });
  }
  if (protocol !== "vnc" && protocol !== "rdp") {
    return NextResponse.json({ error: "protocol must be vnc or rdp" }, { status: 400 });
  }
  if (!name || !sizeSlug || !region || !assignedUserId) {
    return NextResponse.json({ error: "name, sizeSlug, region, and assignedUserId are required" }, { status: 400 });
  }
  if (billingMode === "byo" && !credentialId) {
    return NextResponse.json({ error: "credentialId is required for bring-your-own billing" }, { status: 400 });
  }

  // AWS is Windows-only here (see lib/vmProviders/aws.ts), added specifically
  // to preinstall Microsoft Office. DigitalOcean, by contrast, offers
  // Windows 11 as an explicit opt-in choice alongside its default Ubuntu
  // desktop (see lib/vmProviders/digitalocean.ts's windowsCloudInitScript --
  // a real Windows 11 install inside nested KVM via dockur/windows), so its
  // `os` comes from the request rather than being implied by provider.
  // Platform-billed Windows VMs are gated to the Pro plan only (see
  // lib/billing/plans.ts) via the generic allowedSizes check below -- no
  // special-casing needed here since a plan without a matching sizeSlug in
  // its allowedSizes already rejects it the same way for every provider.
  const os: VmOs = provider === "aws" ? "windows" : requestedOs === "windows" ? "windows" : "linux";

  // dockur/windows needs meaningfully more resources than this repo's
  // smallest DigitalOcean tier -- confirmed directly (this session's spike)
  // that a real, usable unattended Windows 11 + Office install needs at
  // least the s-4vcpu-8gb tier, not s-2vcpu-4gb.
  const WINDOWS_CAPABLE_DO_SIZES = ["s-4vcpu-8gb", "s-8vcpu-16gb"];
  if (provider === "digitalocean" && os === "windows" && !WINDOWS_CAPABLE_DO_SIZES.includes(sizeSlug)) {
    return NextResponse.json(
      { error: `Windows 11 needs at least the ${WINDOWS_CAPABLE_DO_SIZES[0]} size.` },
      { status: 400 }
    );
  }
  // dockur/windows only ever exposes RDP (3389), never VNC -- the UI forces
  // this, but don't just trust the client for it.
  if (os === "windows" && protocol !== "rdp") {
    return NextResponse.json({ error: "Windows VMs must use the rdp protocol" }, { status: 400 });
  }

  const sizeOption = PRICING[provider as CloudProviderId]?.find((s) => s.slug === sizeSlug);
  if (!sizeOption) return NextResponse.json({ error: "Unknown sizeSlug for provider" }, { status: 400 });

  const { data: assignee } = await admin
    .from("company_memberships")
    .select("user_id")
    .eq("company_id", companyId)
    .eq("user_id", assignedUserId)
    .maybeSingle();
  if (!assignee) return NextResponse.json({ error: "assignedUserId is not a member of this company" }, { status: 400 });

  let credentials: ProviderCredentials;

  if (billingMode === "platform") {
    const { data: sub } = await admin
      .from("company_subscriptions")
      .select("plan_id, status")
      .eq("company_id", companyId)
      .maybeSingle();

    if (!sub || !["active", "trialing"].includes(sub.status) || !sub.plan_id || !isPlanId(sub.plan_id)) {
      return NextResponse.json(
        { error: "Platform-billed VMs require an active subscription. Set one up at /dashboard/billing." },
        { status: 402 }
      );
    }

    const plan = PLANS[sub.plan_id];
    const allowedSizes = plan.allowedSizes[provider as CloudProviderId] || [];
    if (!allowedSizes.includes(sizeSlug)) {
      return NextResponse.json({ error: `Size "${sizeSlug}" is not included in the ${plan.name} plan` }, { status: 400 });
    }

    const { count } = await admin
      .from("virtual_computers")
      .select("id", { count: "exact", head: true })
      .eq("company_id", companyId)
      .eq("billing_mode", "platform")
      .neq("status", "destroyed");
    if ((count ?? 0) >= plan.includedVmSlots) {
      return NextResponse.json(
        { error: `Plan limit reached (${plan.includedVmSlots} included). Upgrade or destroy an existing VM.` },
        { status: 402 }
      );
    }

    try {
      credentials = getPlatformCredentials(provider as CloudProviderId);
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Platform billing is not fully configured yet" },
        { status: 500 }
      );
    }
  } else {
    const { data: credential } = await admin
      .from("company_cloud_credentials")
      .select("id, company_id, provider, credentials")
      .eq("id", credentialId)
      .maybeSingle();
    if (!credential || credential.company_id !== companyId || credential.provider !== provider) {
      return NextResponse.json({ error: "Invalid credential" }, { status: 400 });
    }
    credentials = credential.credentials;
  }

  const remoteUsername = os === "windows" ? "Administrator" : "vcuser";
  const remotePassword = os === "windows" ? generateWindowsPassword() : generateRemotePassword();

  const { data: row, error: insertError } = await admin
    .from("virtual_computers")
    .insert({
      company_id: companyId,
      assigned_user_id: assignedUserId,
      name,
      provider,
      protocol,
      os,
      size_slug: sizeSlug,
      region,
      credential_id: billingMode === "byo" ? credentialId : null,
      billing_mode: billingMode,
      remote_username: remoteUsername,
      remote_password: remotePassword,
      hourly_usd_at_creation: sizeOption.hourlyUsd,
      status: "provisioning",
      created_by: user.id,
    })
    .select("id")
    .single();
  if (insertError) return NextResponse.json({ error: insertError.message }, { status: 500 });

  try {
    const adapter = getProvider(provider as CloudProviderId);
    const result = await adapter.createInstance({
      credentials,
      name,
      sizeSlug,
      region,
      protocol: protocol as VmProtocol,
      os,
      remoteUsername,
      remotePassword,
    });
    await openUsageEvent(admin, { id: row.id, company_id: companyId, hourly_usd_at_creation: sizeOption.hourlyUsd });
    const schedule = await getCompanySchedule(admin, companyId);
    const deadline = nextLocalMidnight(new Date(), schedule.timezone);
    await admin
      .from("virtual_computers")
      .update({
        provider_instance_id: result.providerInstanceId,
        ip_address: result.ipAddress,
        last_seen_at: new Date().toISOString(),
        hibernate_deadline: deadline.toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);
  } catch (err) {
    await admin
      .from("virtual_computers")
      .update({
        status: "error",
        error_message: err instanceof Error ? err.message : "Provisioning failed",
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Provisioning failed" }, { status: 502 });
  }

  return NextResponse.json({ id: row.id });
}
