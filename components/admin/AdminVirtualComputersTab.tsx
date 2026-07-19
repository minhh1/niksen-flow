// components/admin/AdminVirtualComputersTab.tsx
// Admin-only: cloud credential CRUD, cost comparison, and creating/
// reassigning/destroying virtual computers assigned to company members.
// There is no self-service launch flow for regular members -- see
// app/dashboard/virtual-computers/page.tsx for what they see instead.
"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { Monitor, Plus, X, KeyRound, Trash2, CreditCard, Loader2 } from "lucide-react";
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

interface Schedule {
  enabled: boolean;
  days: number[];
  start_time: string;
  end_time: string;
  timezone: string;
  enforce_end_time: boolean;
}

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

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
  const [destroyingIds, setDestroyingIds] = useState<Set<string>>(new Set());
  const [wakingIds, setWakingIds] = useState<Set<string>>(new Set());
  const [actionMessage, setActionMessage] = useState<{ type: "info" | "success" | "error"; text: string } | null>(null);
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [scheduleSaving, setScheduleSaving] = useState(false);

  const notify = useCallback((type: "info" | "success" | "error", text: string, autoDismissMs = 6000) => {
    setActionMessage({ type, text });
    if (autoDismissMs) {
      setTimeout(() => setActionMessage((cur) => (cur?.text === text ? null : cur)), autoDismissMs);
    }
  }, []);

  const load = useCallback(async () => {
    const [credRes, vmRes, pricingRes, billingRes, scheduleRes] = await Promise.all([
      fetch("/api/virtual-computers/credentials"),
      fetch("/api/virtual-computers/list"),
      fetch("/api/virtual-computers/pricing"),
      fetch("/api/billing/status"),
      fetch("/api/virtual-computers/schedule"),
    ]);
    const [credJson, vmJson, pricingJson, billingJson, scheduleJson] = await Promise.all([
      credRes.json(),
      vmRes.json(),
      pricingRes.json(),
      billingRes.json(),
      scheduleRes.json(),
    ]);
    setCredentials(credJson.credentials || []);
    setVms(vmJson.virtualComputers || []);
    setPricingData(pricingJson.pricing ? pricingJson : null);
    setBillingStatus(billingJson);
    setSchedule(scheduleJson.schedule || null);

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
    if (!vms.some((vm) => vm.status === "provisioning" || vm.status === "snapshotting")) return;
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
    const trimmedName = vmName.trim();
    setCreating(true);
    notify(
      "info",
      `Creating "${trimmedName}"... ${
        vmProvider === "aws" ? "Windows + Office setup can take 10-15 minutes." : "This usually takes about a minute."
      }`,
      0
    );
    const res = await fetch("/api/virtual-computers/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: trimmedName,
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
      const message = json.error || "Could not create virtual computer";
      setCreateError(message);
      notify("error", `Could not create "${trimmedName}": ${message}`);
      return;
    }
    notify("success", `"${trimmedName}" is being set up now -- watch its status below.`);
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
    const vm = vms.find((v) => v.id === id);
    if (!confirm("Destroy this virtual computer? This can't be undone.")) return;
    const label = vm?.name || "virtual computer";
    setDestroyingIds((prev) => new Set(prev).add(id));
    notify("info", `Destroying "${label}"...`, 0);
    const res = await fetch(`/api/virtual-computers/${id}/destroy`, { method: "POST" });
    setDestroyingIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      notify("error", `Could not destroy "${label}": ${json.error || "Unknown error"}`);
    } else {
      notify("success", `"${label}" destroyed.`);
    }
    load();
  };

  const wakeVm = async (id: string) => {
    const vm = vms.find((v) => v.id === id);
    const label = vm?.name || "virtual computer";
    setWakingIds((prev) => new Set(prev).add(id));
    notify("info", `Waking "${label}" from its saved snapshot...`, 0);
    const res = await fetch(`/api/virtual-computers/${id}/wake`, { method: "POST" });
    setWakingIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      notify("error", `Could not wake "${label}": ${json.error || "Unknown error"}`);
    } else {
      notify("success", `"${label}" is waking up -- watch its status below.`);
    }
    load();
  };

  const saveSchedule = async (next: Schedule) => {
    setSchedule(next);
    setScheduleSaving(true);
    await fetch("/api/virtual-computers/schedule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: next.enabled,
        days: next.days,
        startTime: next.start_time,
        endTime: next.end_time,
        timezone: next.timezone,
        enforceEndTime: next.enforce_end_time,
      }),
    });
    setScheduleSaving(false);
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

      {/* VM schedule */}
      {schedule && (
        <div className="bg-white border border-slate-200 rounded-[32px] p-6">
          <div className="flex items-center justify-between mb-4">
            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">Business hours</p>
            <button
              type="button"
              onClick={() => saveSchedule({ ...schedule, enabled: !schedule.enabled })}
              className={`px-4 py-1.5 text-[11px] font-bold rounded-full transition-colors ${
                schedule.enabled ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-500"
              }`}
            >
              {schedule.enabled ? "Enabled" : "Disabled"}
            </button>
          </div>

          {activePlan && activePlan.id !== "payg" && !schedule.enabled && (
            <p className="text-[12px] text-amber-700 bg-amber-50 rounded-2xl px-4 py-3 mb-4">
              {`The ${activePlan.name} plan is priced assuming bounded business-hours usage -- turn this on so idle hours outside your team's schedule don't run up cost. Pay-as-you-go plans can leave this off.`}
            </p>
          )}

          <div className="space-y-3">
            <div className="flex gap-1.5 flex-wrap">
              {DAY_LABELS.map((label, idx) => {
                const selected = schedule.days.includes(idx);
                return (
                  <button
                    key={label}
                    type="button"
                    onClick={() =>
                      saveSchedule({
                        ...schedule,
                        days: selected ? schedule.days.filter((d) => d !== idx) : [...schedule.days, idx].sort(),
                      })
                    }
                    className={`w-10 py-1.5 text-[11px] font-bold rounded-full transition-colors ${
                      selected ? "bg-indigo-600 text-white" : "bg-slate-50 text-slate-400 hover:bg-slate-100"
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>

            <div className="grid grid-cols-3 gap-3">
              <input
                type="time"
                value={schedule.start_time}
                onChange={(e) => saveSchedule({ ...schedule, start_time: e.target.value })}
                className="px-3 py-2 border border-slate-200 rounded-full text-[12px] outline-none focus:border-indigo-400"
              />
              <input
                type="time"
                value={schedule.end_time}
                onChange={(e) => saveSchedule({ ...schedule, end_time: e.target.value })}
                className="px-3 py-2 border border-slate-200 rounded-full text-[12px] outline-none focus:border-indigo-400"
              />
              <input
                value={schedule.timezone}
                onChange={(e) => saveSchedule({ ...schedule, timezone: e.target.value })}
                placeholder="Timezone (e.g. Australia/Sydney)"
                className="px-3 py-2 border border-slate-200 rounded-full text-[12px] outline-none focus:border-indigo-400"
              />
            </div>

            <label className="flex items-center gap-2 text-[12px] text-slate-500">
              <input
                type="checkbox"
                checked={schedule.enforce_end_time}
                onChange={(e) => saveSchedule({ ...schedule, enforce_end_time: e.target.checked })}
              />
              End time is a hard stop (log everyone off exactly then, even mid-session). Off by default -- VMs
              stay up as long as someone&rsquo;s using them, with a midnight safety cutoff either way.
            </label>
            {scheduleSaving && <p className="text-[10px] text-slate-300">Saving...</p>}
          </div>
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

        {actionMessage && (
          <div
            className={`flex items-start gap-2 px-4 py-2.5 rounded-2xl text-[12px] mb-4 ${
              actionMessage.type === "error"
                ? "bg-red-50 text-red-600"
                : actionMessage.type === "success"
                ? "bg-emerald-50 text-emerald-600"
                : "bg-indigo-50 text-indigo-600"
            }`}
          >
            {actionMessage.type === "info" && <Loader2 size={13} className="shrink-0 mt-0.5 animate-spin" />}
            <span className="flex-1">{actionMessage.text}</span>
            <button onClick={() => setActionMessage(null)} className="shrink-0 opacity-60 hover:opacity-100">
              <X size={12} />
            </button>
          </div>
        )}

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
                  {vm.status === "provisioning" && !destroyingIds.has(vm.id) && (
                    <p className="text-[10px] text-indigo-400 truncate mt-0.5">
                      {vm.os === "windows"
                        ? "Booting instance and installing Office -- can take 10-15 minutes."
                        : "Booting instance -- usually ready within a minute."}
                    </p>
                  )}
                </div>
                <select
                  value={vm.assigned_user_id || ""}
                  onChange={(e) => reassignVm(vm.id, e.target.value)}
                  disabled={destroyingIds.has(vm.id)}
                  className="px-2 py-1.5 border border-slate-200 rounded-full text-[11px] outline-none focus:border-indigo-400 disabled:opacity-40"
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
                {destroyingIds.has(vm.id) ? (
                  <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-wide bg-slate-100 text-slate-500">
                    <Loader2 size={11} className="animate-spin" />
                    Destroying...
                  </span>
                ) : (
                  <VmStatusBadge status={vm.status} />
                )}
                {vm.status === "hibernated" && (
                  <button
                    onClick={() => wakeVm(vm.id)}
                    disabled={wakingIds.has(vm.id)}
                    className="px-3 py-1.5 bg-sky-600 text-white text-[11px] font-bold rounded-full hover:bg-sky-700 disabled:opacity-40 transition-colors"
                  >
                    {wakingIds.has(vm.id) ? "Waking..." : "Wake now"}
                  </button>
                )}
                <button
                  onClick={() => destroyVm(vm.id)}
                  disabled={destroyingIds.has(vm.id)}
                  className="p-1.5 text-slate-300 hover:text-red-500 transition-colors disabled:opacity-30 disabled:hover:text-slate-300"
                >
                  {destroyingIds.has(vm.id) ? <Loader2 size={13} className="animate-spin" /> : <X size={13} />}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
