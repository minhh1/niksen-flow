// components/admin/AdminVirtualComputersTab.tsx
// Admin-only: cloud credential CRUD, cost comparison, and creating/
// reassigning/destroying virtual computers assigned to company members.
// There is no self-service launch flow for regular members -- see
// app/dashboard/virtual-computers/page.tsx for what they see instead.
"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { Monitor, Plus, X, KeyRound, Trash2, CreditCard } from "lucide-react";
import CostComparisonTable from "@/components/virtualcomputers/CostComparisonTable";
import VmStatusBadge from "@/components/virtualcomputers/VmStatusBadge";
import { REGIONS } from "@/lib/vmProviders/regions";
import type { CloudProviderId, VmProtocol, VmSizeOption } from "@/lib/vmProviders/types";

interface Props {
  companyId: string;
}

interface Credential {
  id: string;
  provider: CloudProviderId;
  label: string;
  created_at: string;
}

interface Vm {
  id: string;
  name: string;
  provider: CloudProviderId;
  protocol: VmProtocol;
  os: "linux" | "windows";
  size_slug: string;
  region: string;
  status: string;
  error_message: string | null;
  assigned_user_id: string | null;
  billing_mode: "byo" | "platform";
  hourly_usd_at_creation: number | null;
}

interface Member {
  id: string;
  full_name: string | null;
  email: string | null;
}

interface PricingResponse {
  pricing: Record<CloudProviderId, VmSizeOption[]>;
  providerLabels: Record<CloudProviderId, string>;
  provisionableProviders: CloudProviderId[];
}

interface PlatformPlan {
  id: string;
  name: string;
  includedVmSlots: number;
  allowedSizes: Partial<Record<CloudProviderId, string[]>>;
}

interface BillingStatus {
  subscription: { planId: string | null; status: string } | null;
  plan: PlatformPlan | null;
}

const PROVIDER_CREDENTIAL_FIELDS: Record<CloudProviderId, { key: string; label: string; type?: string }[]> = {
  digitalocean: [{ key: "api_token", label: "API token", type: "password" }],
  aws: [
    { key: "access_key_id", label: "Access key ID" },
    { key: "secret_access_key", label: "Secret access key", type: "password" },
    { key: "region", label: "Default region" },
  ],
  gcp: [
    { key: "project_id", label: "Project ID" },
    { key: "service_account_json", label: "Service account JSON" },
  ],
};

export default function AdminVirtualComputersTab({ companyId }: Props) {
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [vms, setVms] = useState<Vm[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [pricingData, setPricingData] = useState<PricingResponse | null>(null);
  const [billingStatus, setBillingStatus] = useState<BillingStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const [showCredentialForm, setShowCredentialForm] = useState(false);
  const [credProvider, setCredProvider] = useState<CloudProviderId>("digitalocean");
  const [credLabel, setCredLabel] = useState("");
  const [credFields, setCredFields] = useState<Record<string, string>>({});
  const [credError, setCredError] = useState<string | null>(null);
  const [credSaving, setCredSaving] = useState(false);

  const [showCreateForm, setShowCreateForm] = useState(false);
  const [vmName, setVmName] = useState("");
  const [vmProvider, setVmProvider] = useState<CloudProviderId>("digitalocean");
  const [vmSizeSlug, setVmSizeSlug] = useState("");
  const [vmRegion, setVmRegion] = useState("");
  const [vmProtocol, setVmProtocol] = useState<VmProtocol>("vnc");
  const [vmBillingMode, setVmBillingMode] = useState<"byo" | "platform">("byo");
  const [vmCredentialId, setVmCredentialId] = useState("");
  const [vmAssignedUserId, setVmAssignedUserId] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    const [credRes, vmRes, pricingRes, billingRes] = await Promise.all([
      fetch("/api/virtual-computers/credentials"),
      fetch("/api/virtual-computers/list"),
      fetch("/api/virtual-computers/pricing"),
      fetch("/api/billing/status"),
    ]);
    const [credJson, vmJson, pricingJson, billingJson] = await Promise.all([
      credRes.json(),
      vmRes.json(),
      pricingRes.json(),
      billingRes.json(),
    ]);
    setCredentials(credJson.credentials || []);
    setVms(vmJson.virtualComputers || []);
    setPricingData(pricingJson.pricing ? pricingJson : null);
    setBillingStatus(billingJson);

    const { data: ms } = await supabase.from("company_memberships").select("user_id").eq("company_id", companyId);
    if (ms?.length) {
      const { data: profs } = await supabase
        .from("profiles").select("id, full_name, email").in("id", ms.map((m: any) => m.user_id));
      setMembers(profs || []);
    }

    setLoading(false);
  }, [companyId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!vms.some((vm) => vm.status === "provisioning")) return;
    const interval = setInterval(load, 4000);
    return () => clearInterval(interval);
  }, [vms, load]);

  const addCredential = async () => {
    setCredError(null);
    if (!credLabel.trim()) {
      setCredError("Label is required");
      return;
    }
    for (const f of PROVIDER_CREDENTIAL_FIELDS[credProvider]) {
      if (!credFields[f.key]?.trim()) {
        setCredError(`${f.label} is required`);
        return;
      }
    }
    setCredSaving(true);
    const res = await fetch("/api/virtual-computers/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: credProvider, label: credLabel.trim(), credentials: credFields }),
    });
    const json = await res.json();
    setCredSaving(false);
    if (!res.ok) {
      setCredError(json.error || "Could not save credential");
      return;
    }
    setCredLabel("");
    setCredFields({});
    setShowCredentialForm(false);
    load();
  };

  const deleteCredential = async (id: string) => {
    if (!confirm("Delete this credential?")) return;
    await fetch(`/api/virtual-computers/credentials/${id}`, { method: "DELETE" });
    load();
  };

  const createVm = async () => {
    setCreateError(null);
    if (!vmName.trim() || !vmSizeSlug || !vmRegion.trim() || !vmAssignedUserId) {
      setCreateError("All fields are required");
      return;
    }
    if (vmBillingMode === "byo" && !vmCredentialId) {
      setCreateError("Credential is required for bring-your-own billing");
      return;
    }
    setCreating(true);
    const res = await fetch("/api/virtual-computers/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: vmName.trim(),
        provider: vmProvider,
        sizeSlug: vmSizeSlug,
        region: vmRegion.trim(),
        protocol: vmProtocol,
        billingMode: vmBillingMode,
        credentialId: vmBillingMode === "byo" ? vmCredentialId : undefined,
        assignedUserId: vmAssignedUserId,
      }),
    });
    const json = await res.json();
    setCreating(false);
    if (!res.ok) {
      setCreateError(json.error || "Could not create virtual computer");
      return;
    }
    setVmName("");
    setVmSizeSlug("");
    setVmRegion("");
    setVmCredentialId("");
    setVmAssignedUserId("");
    setShowCreateForm(false);
    load();
  };

  const reassignVm = async (id: string, userId: string) => {
    await fetch(`/api/virtual-computers/${id}/reassign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assignedUserId: userId }),
    });
    load();
  };

  const destroyVm = async (id: string) => {
    if (!confirm("Destroy this virtual computer? This can't be undone.")) return;
    await fetch(`/api/virtual-computers/${id}/destroy`, { method: "POST" });
    load();
  };

  if (loading) return <p className="text-[11px] text-slate-400">Loading...</p>;

  const credentialsForProvider = credentials.filter((c) => c.provider === vmProvider);
  const activePlan =
    billingStatus?.plan && billingStatus.subscription && ["active", "trialing"].includes(billingStatus.subscription.status)
      ? billingStatus.plan
      : null;
  const platformSlotsUsed = vms.filter((vm) => vm.billing_mode === "platform").length;
  const platformSlotsAvailable = activePlan ? activePlan.includedVmSlots - platformSlotsUsed : 0;
  const platformAllowedSizeSlugs = activePlan?.allowedSizes[vmProvider] || [];
  const sizesForProvider =
    vmBillingMode === "platform"
      ? (pricingData?.pricing[vmProvider] || []).filter((s) => platformAllowedSizeSlugs.includes(s.slug))
      : pricingData?.pricing[vmProvider] || [];
  const platformBillingBlocked = vmBillingMode === "platform" && (!activePlan || platformSlotsAvailable <= 0);

  return (
    <div className="space-y-6">
      {/* Cloud credentials */}
      <div className="bg-white border border-slate-200 rounded-[32px] p-6">
        <div className="flex items-center justify-between mb-4">
          <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">Cloud credentials</p>
          <button onClick={() => setShowCredentialForm((v) => !v)} className="p-1.5 text-slate-300 hover:text-indigo-600 transition-colors">
            <Plus size={14} />
          </button>
        </div>

        {credentials.length === 0 && !showCredentialForm && (
          <p className="text-[12px] text-slate-400">No cloud credentials yet. Add one to start provisioning virtual computers.</p>
        )}

        <div className="space-y-2 mb-2">
          {credentials.map((cred) => (
            <div key={cred.id} className="flex items-center gap-3 px-4 py-2.5 bg-slate-50 rounded-2xl">
              <KeyRound size={13} className="text-slate-400 shrink-0" />
              <p className="text-[12px] font-medium text-slate-700 flex-1">{cred.label}</p>
              <span className="text-[10px] text-slate-400 uppercase tracking-wide">{cred.provider}</span>
              <button onClick={() => deleteCredential(cred.id)} className="p-1 text-slate-300 hover:text-red-500 transition-colors">
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>

        {showCredentialForm && (
          <div className="space-y-3 pt-3 border-t border-slate-100">
            <div className="flex gap-3">
              <select
                value={credProvider}
                onChange={(e) => {
                  setCredProvider(e.target.value as CloudProviderId);
                  setCredFields({});
                }}
                className="px-3 py-2 border border-slate-200 rounded-full text-[12px] outline-none focus:border-indigo-400"
              >
                {pricingData &&
                  (Object.keys(pricingData.providerLabels) as CloudProviderId[]).map((p) => (
                    <option key={p} value={p}>
                      {pricingData.providerLabels[p]}
                    </option>
                  ))}
              </select>
              <input
                value={credLabel}
                onChange={(e) => setCredLabel(e.target.value)}
                placeholder="Label (e.g. Production account)"
                className="flex-1 px-4 py-2 border border-slate-200 rounded-full text-[12px] outline-none focus:border-indigo-400"
              />
            </div>
            {PROVIDER_CREDENTIAL_FIELDS[credProvider].map((f) => (
              <input
                key={f.key}
                type={f.type || "text"}
                value={credFields[f.key] || ""}
                onChange={(e) => setCredFields((prev) => ({ ...prev, [f.key]: e.target.value }))}
                placeholder={f.label}
                className="w-full px-4 py-2 border border-slate-200 rounded-full text-[12px] outline-none focus:border-indigo-400"
              />
            ))}
            {credError && <p className="text-[11px] text-red-500">{credError}</p>}
            <div className="flex gap-2">
              <button
                onClick={addCredential}
                disabled={credSaving}
                className="px-5 py-2 bg-indigo-600 text-white text-[12px] font-bold rounded-full hover:bg-indigo-700 disabled:opacity-40 transition-colors"
              >
                {credSaving ? "Saving..." : "Save credential"}
              </button>
              <button onClick={() => setShowCredentialForm(false)} className="px-4 py-2 text-[12px] text-slate-400 hover:text-slate-700">
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Cost comparison */}
      {pricingData && (
        <div className="bg-white border border-slate-200 rounded-[32px] p-6">
          <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-4">Cost comparison</p>
          <CostComparisonTable
            pricing={pricingData.pricing}
            providerLabels={pricingData.providerLabels}
            provisionableProviders={pricingData.provisionableProviders}
          />
        </div>
      )}

      {/* Create + list virtual computers */}
      <div className="bg-white border border-slate-200 rounded-[32px] p-6">
        <div className="flex items-center justify-between mb-4">
          <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">Virtual computers</p>
          <button onClick={() => setShowCreateForm((v) => !v)} className="p-1.5 text-slate-300 hover:text-indigo-600 transition-colors">
            <Plus size={14} />
          </button>
        </div>

        {showCreateForm && (
          <div className="space-y-3 pb-4 mb-4 border-b border-slate-100">
            <input
              value={vmName}
              onChange={(e) => setVmName(e.target.value)}
              placeholder="Name (e.g. Jane's workstation)"
              className="w-full px-4 py-2 border border-slate-200 rounded-full text-[12px] outline-none focus:border-indigo-400"
            />

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setVmBillingMode("byo");
                  setVmSizeSlug("");
                }}
                className={`flex-1 px-4 py-2 text-[12px] font-bold rounded-full border transition-colors ${
                  vmBillingMode === "byo"
                    ? "bg-slate-900 text-white border-slate-900"
                    : "bg-white text-slate-500 border-slate-200 hover:border-slate-300"
                }`}
              >
                Bring your own cloud account
              </button>
              <button
                type="button"
                onClick={() => {
                  setVmBillingMode("platform");
                  setVmSizeSlug("");
                  setVmCredentialId("");
                }}
                className={`flex-1 px-4 py-2 text-[12px] font-bold rounded-full border transition-colors ${
                  vmBillingMode === "platform"
                    ? "bg-slate-900 text-white border-slate-900"
                    : "bg-white text-slate-500 border-slate-200 hover:border-slate-300"
                }`}
              >
                Platform-billed
              </button>
            </div>

            {vmBillingMode === "platform" && (
              <div
                className={`flex items-center gap-2 px-4 py-3 rounded-2xl text-[12px] ${
                  activePlan ? "bg-slate-50 text-slate-500" : "bg-amber-50 text-amber-700"
                }`}
              >
                <CreditCard size={14} className="shrink-0" />
                {activePlan ? (
                  <span>
                    {activePlan.name} plan -- {platformSlotsAvailable}/{activePlan.includedVmSlots} slot{activePlan.includedVmSlots !== 1 ? "s" : ""} available.
                  </span>
                ) : (
                  <span>
                    Platform-billed VMs require an active subscription.{" "}
                    <Link href="/dashboard/billing" className="underline font-bold">
                      Set up billing
                    </Link>
                  </span>
                )}
                {activePlan && platformSlotsAvailable <= 0 && (
                  <Link href="/dashboard/billing" className="ml-auto underline font-bold shrink-0">
                    Upgrade
                  </Link>
                )}
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <select
                value={vmProvider}
                onChange={(e) => {
                  const nextProvider = e.target.value as CloudProviderId;
                  setVmProvider(nextProvider);
                  setVmSizeSlug("");
                  setVmCredentialId("");
                  setVmRegion("");
                  if (nextProvider === "aws") setVmProtocol("rdp");
                }}
                className="px-3 py-2 border border-slate-200 rounded-full text-[12px] outline-none focus:border-indigo-400"
              >
                {pricingData?.provisionableProviders.map((p) => (
                  <option key={p} value={p}>
                    {pricingData.providerLabels[p]}
                  </option>
                ))}
              </select>
              {vmProvider === "aws" ? (
                <div className="px-3 py-2 border border-slate-200 rounded-full text-[12px] text-slate-500">RDP</div>
              ) : (
                <select
                  value={vmProtocol}
                  onChange={(e) => setVmProtocol(e.target.value as VmProtocol)}
                  className="px-3 py-2 border border-slate-200 rounded-full text-[12px] outline-none focus:border-indigo-400"
                >
                  <option value="vnc">VNC</option>
                  <option value="rdp">RDP</option>
                </select>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <select
                value={vmSizeSlug}
                onChange={(e) => setVmSizeSlug(e.target.value)}
                className="px-3 py-2 border border-slate-200 rounded-full text-[12px] outline-none focus:border-indigo-400"
              >
                <option value="">Size...</option>
                {sizesForProvider.map((s) => (
                  <option key={s.slug} value={s.slug}>
                    {s.label} (${s.hourlyUsd.toFixed(3)}/hr)
                  </option>
                ))}
              </select>
              <select
                value={vmRegion}
                onChange={(e) => setVmRegion(e.target.value)}
                className="px-3 py-2 border border-slate-200 rounded-full text-[12px] outline-none focus:border-indigo-400"
              >
                <option value="">Region...</option>
                {(REGIONS[vmProvider] || []).map((r) => (
                  <option key={r.slug} value={r.slug}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>
            <div className={vmBillingMode === "byo" ? "grid grid-cols-2 gap-3" : ""}>
              {vmBillingMode === "byo" && (
                <select
                  value={vmCredentialId}
                  onChange={(e) => setVmCredentialId(e.target.value)}
                  className="px-3 py-2 border border-slate-200 rounded-full text-[12px] outline-none focus:border-indigo-400"
                >
                  <option value="">Credential...</option>
                  {credentialsForProvider.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </select>
              )}
              <select
                value={vmAssignedUserId}
                onChange={(e) => setVmAssignedUserId(e.target.value)}
                className="w-full px-3 py-2 border border-slate-200 rounded-full text-[12px] outline-none focus:border-indigo-400"
              >
                <option value="">Assign to...</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.full_name || m.email}
                  </option>
                ))}
              </select>
            </div>
            {createError && <p className="text-[11px] text-red-500">{createError}</p>}
            <div className="flex gap-2">
              <button
                onClick={createVm}
                disabled={creating || platformBillingBlocked}
                className="px-5 py-2 bg-indigo-600 text-white text-[12px] font-bold rounded-full hover:bg-indigo-700 disabled:opacity-40 transition-colors"
              >
                {creating ? "Creating..." : "Create"}
              </button>
              <button onClick={() => setShowCreateForm(false)} className="px-4 py-2 text-[12px] text-slate-400 hover:text-slate-700">
                Cancel
              </button>
            </div>
          </div>
        )}

        {vms.length === 0 ? (
          <p className="text-[12px] text-slate-400">No virtual computers yet.</p>
        ) : (
          <div className="space-y-2">
            {vms.map((vm) => (
              <div key={vm.id} className="flex items-center gap-3 px-4 py-3 bg-slate-50 rounded-2xl">
                <Monitor size={14} className="text-indigo-500 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-[12px] font-medium text-slate-800 truncate">{vm.name}</p>
                    {vm.os === "windows" && (
                      <span className="shrink-0 px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wide bg-sky-50 text-sky-600">
                        Windows + Office
                      </span>
                    )}
                    {vm.billing_mode === "platform" && (
                      <span className="shrink-0 px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wide bg-indigo-50 text-indigo-600">
                        Platform-billed
                      </span>
                    )}
                  </div>
                  <p className="text-[10px] text-slate-400 truncate">
                    {vm.provider} · {vm.protocol.toUpperCase()} · {vm.size_slug} · {vm.region}
                  </p>
                </div>
                <select
                  value={vm.assigned_user_id || ""}
                  onChange={(e) => reassignVm(vm.id, e.target.value)}
                  className="px-2 py-1.5 border border-slate-200 rounded-full text-[11px] outline-none focus:border-indigo-400"
                >
                  <option value="" disabled>
                    Unassigned
                  </option>
                  {members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.full_name || m.email}
                    </option>
                  ))}
                </select>
                <VmStatusBadge status={vm.status} />
                <button onClick={() => destroyVm(vm.id)} className="p-1.5 text-slate-300 hover:text-red-500 transition-colors">
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
