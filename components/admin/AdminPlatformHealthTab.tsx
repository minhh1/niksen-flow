// components/admin/AdminPlatformHealthTab.tsx
// Cross-company "is the platform healthy" dashboard, site-admin only (see
// supabase/site_admin.sql) -- distinct from every other admin tab on this
// page, which are all scoped to the active company. Five sub-tabs:
// Secrets (credential/expiry tracking), Services (non-Gmail background job
// heartbeats -- Gmail's own are already in the Gmail sync tab), Costs
// (real spend per external service), Analytics (site-wide visits + API
// invocation counts), and Heartbeat (live reachability check across every
// external dependency + our own API).
"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import {
  Loader2, KeyRound, Radio, DollarSign, BarChart3, HeartPulse,
  CheckCircle2, XCircle, RotateCw, Plus, Trash2, Search, ChevronDown, ChevronUp,
  type LucideIcon,
} from "lucide-react";
import HeartbeatStatusList, { type HeartbeatDef, type HeartbeatRow } from "@/components/admin/HeartbeatStatusList";
import MiniLineChart from "@/components/admin/MiniLineChart";

type Section = "secrets" | "services" | "costs" | "analytics" | "heartbeat";

const SECTIONS: { id: Section; label: string; icon: LucideIcon }[] = [
  { id: "heartbeat", label: "Heartbeat", icon: HeartPulse },
  { id: "services", label: "Services", icon: Radio },
  { id: "secrets", label: "Secrets", icon: KeyRound },
  { id: "costs", label: "Costs", icon: DollarSign },
  { id: "analytics", label: "Analytics", icon: BarChart3 },
];

// ── Services (non-Gmail background jobs) ────────────────────────────
const SERVICE_HEARTBEAT_DEFS: Record<string, HeartbeatDef> = {
  "teams-sync-worker": { label: "Teams sync worker (every 15 min)", intervalMs: 15 * 60 * 1000 },
  "ai-embed-worker": { label: "AI embedding worker (every 1 min)", intervalMs: 60 * 1000 },
  "calendar-sync": { label: "Calendar sync (event-driven, per task)", intervalMs: 24 * 60 * 60 * 1000 },
  "virtual-computers-sweep": { label: "Virtual computers sweep (every 5-10 min)", intervalMs: 10 * 60 * 1000 },
  "ai-usage-sweep": { label: "AI usage → Stripe sweep (every 5-10 min)", intervalMs: 10 * 60 * 1000 },
  "platform-cost-refresh": { label: "Platform cost refresh (daily)", intervalMs: 24 * 60 * 60 * 1000 },
};

// ── Secrets ──────────────────────────────────────────────────────────
interface SecretRow {
  id: string;
  service: string;
  label: string;
  expires_at: string | null;
  rotation_interval_days: number | null;
  last_rotated_at: string | null;
  notes: string | null;
}

function secretStatus(s: SecretRow): { label: string; className: string } {
  const now = Date.now();
  if (s.expires_at) {
    const ms = new Date(s.expires_at).getTime() - now;
    if (ms < 0) return { label: "Expired", className: "bg-red-50 text-red-600" };
    if (ms < 30 * 24 * 60 * 60 * 1000) return { label: "Due soon", className: "bg-amber-50 text-amber-700" };
    return { label: "OK", className: "bg-emerald-50 text-emerald-600" };
  }
  if (s.rotation_interval_days && s.last_rotated_at) {
    const dueAt = new Date(s.last_rotated_at).getTime() + s.rotation_interval_days * 24 * 60 * 60 * 1000;
    const ms = dueAt - now;
    if (ms < 0) return { label: "Overdue", className: "bg-red-50 text-red-600" };
    if (ms < 14 * 24 * 60 * 60 * 1000) return { label: "Due soon", className: "bg-amber-50 text-amber-700" };
    return { label: "OK", className: "bg-emerald-50 text-emerald-600" };
  }
  return { label: "Never rotated", className: "bg-slate-100 text-slate-500" };
}

// ── Costs ────────────────────────────────────────────────────────────
const COST_SERVICE_LABELS: Record<string, string> = {
  digitalocean: "DigitalOcean",
  stripe_fees: "Stripe (processing fees)",
  aws: "AWS",
  vercel: "Vercel",
  fly: "Fly.io",
  supabase: "Supabase",
  together: "Together AI",
};
const MANUAL_ONLY_SERVICES = ["fly", "supabase", "together"];

interface CostSnapshotRow {
  id: string;
  service: string;
  period_start: string;
  period_end: string;
  amount_usd: number;
  source: "live" | "manual";
}
interface CostServiceGroup {
  service: string;
  latest: CostSnapshotRow;
  history: CostSnapshotRow[];
}

// ── Analytics ────────────────────────────────────────────────────────
interface DayCount { date: string; count: number }
interface AnalyticsData {
  visitsByDay: DayCount[];
  topPaths: { key: string; count: number }[];
  topCountries: { key: string; count: number }[];
  invocationsByDay: DayCount[];
  topApiEndpoints: { key: string; count: number }[];
  totals: { visits: number; invocations: number };
}

// Search + "show top N / show all" list, shared by the Analytics sub-tab's
// Top pages and Top API endpoints panels — both can have far more distinct
// entries than fit comfortably in a preview, so search is the fast way to
// find one specific path without scrolling a long list.
const RANKED_LIST_PREVIEW = 10;
function RankedList({ items, mono }: { items: { key: string; count: number }[]; mono?: boolean }) {
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState(false);

  const filtered = search.trim()
    ? items.filter(i => i.key.toLowerCase().includes(search.trim().toLowerCase()))
    : items;
  // Searching implies "show me every match", not just the top 10 of them.
  const visible = search.trim() || expanded ? filtered : filtered.slice(0, RANKED_LIST_PREVIEW);

  return (
    <div>
      <div className="relative mb-2">
        <Search size={11} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-300" />
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder={`Search ${items.length} entr${items.length === 1 ? "y" : "ies"}...`}
          className="w-full pl-8 pr-3 py-1.5 bg-slate-50 border border-slate-200 rounded-full text-[11px] outline-none focus:border-indigo-400"
        />
      </div>
      <div className="space-y-1.5 max-h-80 overflow-y-auto">
        {visible.map(p => (
          <div key={p.key} className="flex items-center justify-between text-[11px]">
            <span className={`text-slate-600 truncate ${mono ? "font-mono" : ""}`}>{p.key}</span>
            <span className="text-slate-400 font-bold shrink-0 ml-2">{p.count}</span>
          </div>
        ))}
        {items.length === 0 && <p className="text-[11px] text-slate-300">No data yet</p>}
        {items.length > 0 && filtered.length === 0 && <p className="text-[11px] text-slate-300">No matches</p>}
      </div>
      {!search.trim() && filtered.length > RANKED_LIST_PREVIEW && (
        <button
          onClick={() => setExpanded(v => !v)}
          className="flex items-center gap-1 mt-2 text-[10px] font-bold text-indigo-600 hover:underline"
        >
          {expanded
            ? <>Show less <ChevronUp size={11} /></>
            : <>Show all {filtered.length} <ChevronDown size={11} /></>}
        </button>
      )}
    </div>
  );
}

interface HeartbeatCheck {
  name: string;
  group: "external" | "internal";
  ok: boolean;
  latencyMs: number;
  detail?: string;
}

export default function AdminPlatformHealthTab() {
  const [section, setSection] = useState<Section>("heartbeat");

  // Heartbeat
  const [checks, setChecks] = useState<HeartbeatCheck[]>([]);
  const [checksLoading, setChecksLoading] = useState(true);
  const [lastCheckedAt, setLastCheckedAt] = useState<Date | null>(null);
  const checksInFlight = useRef(false);

  const runChecks = useCallback(async () => {
    if (checksInFlight.current) return;
    checksInFlight.current = true;
    try {
      const res = await fetch("/api/admin/health/check");
      const json = await res.json();
      setChecks(json.checks || []);
      setLastCheckedAt(new Date());
    } finally {
      setChecksLoading(false);
      checksInFlight.current = false;
    }
  }, []);

  useEffect(() => {
    if (section !== "heartbeat") return;
    runChecks();
    const interval = setInterval(runChecks, 30000);
    return () => clearInterval(interval);
  }, [section, runChecks]);

  // Services
  const [serviceHeartbeats, setServiceHeartbeats] = useState<HeartbeatRow[]>([]);
  const [servicesLoading, setServicesLoading] = useState(true);
  useEffect(() => {
    if (section !== "services") return;
    let cancelled = false;
    const load = async () => {
      const { data } = await supabase.from("cron_heartbeats").select("name, last_run_at, last_result");
      if (!cancelled) {
        setServiceHeartbeats((data || []).filter((h: HeartbeatRow) => h.name in SERVICE_HEARTBEAT_DEFS));
        setServicesLoading(false);
      }
    };
    load();
    const interval = setInterval(load, 15000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [section]);

  // Secrets
  const [secrets, setSecrets] = useState<SecretRow[]>([]);
  const [staleGoogleTokenCount, setStaleGoogleTokenCount] = useState(0);
  const [azureExpiring, setAzureExpiring] = useState<{ companyName: string; kind: string; expires_at: string }[]>([]);
  const [secretsLoading, setSecretsLoading] = useState(true);
  const [addingSecret, setAddingSecret] = useState(false);
  const [newSecret, setNewSecret] = useState({ service: "", label: "", expires_at: "", rotation_interval_days: "90" });
  const [editingExpiryId, setEditingExpiryId] = useState<string | null>(null);
  const [savingSecret, setSavingSecret] = useState(false);

  const loadSecrets = async () => {
    const res = await fetch("/api/admin/secrets");
    const json = await res.json();
    setSecrets(json.secrets || []);
    setStaleGoogleTokenCount(json.derived?.staleGoogleTokenCount || 0);
    setAzureExpiring(json.derived?.azureSecretsExpiringSoon || []);
    setSecretsLoading(false);
  };
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loadSecrets sets state after an await, not synchronously; this just triggers the fetch when this sub-tab becomes active
    if (section === "secrets") { loadSecrets(); }
  }, [section]);

  const handleAddSecret = async () => {
    if (!newSecret.service.trim() || !newSecret.label.trim()) return;
    setSavingSecret(true);
    await fetch("/api/admin/secrets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        service: newSecret.service.trim(),
        label: newSecret.label.trim(),
        expires_at: newSecret.expires_at || null,
        rotation_interval_days: newSecret.rotation_interval_days ? Number(newSecret.rotation_interval_days) : null,
      }),
    });
    setSavingSecret(false);
    setNewSecret({ service: "", label: "", expires_at: "", rotation_interval_days: "90" });
    setAddingSecret(false);
    loadSecrets();
  };

  const handleMarkRotated = async (id: string) => {
    await fetch(`/api/admin/secrets/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ last_rotated_at: new Date().toISOString() }),
    });
    loadSecrets();
  };

  const handleSetExpiry = async (id: string, expiresAt: string) => {
    await fetch(`/api/admin/secrets/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expires_at: expiresAt || null }),
    });
    setEditingExpiryId(null);
    loadSecrets();
  };

  const handleDeleteSecret = async (id: string) => {
    if (!confirm("Remove this tracked secret?")) return;
    await fetch(`/api/admin/secrets/${id}`, { method: "DELETE" });
    loadSecrets();
  };

  // Costs
  const [costServices, setCostServices] = useState<CostServiceGroup[]>([]);
  const [costsLoading, setCostsLoading] = useState(true);
  const [refreshingCosts, setRefreshingCosts] = useState(false);
  const [addingCost, setAddingCost] = useState(false);
  const [newCost, setNewCost] = useState({ service: "fly", amount_usd: "", notes: "" });
  const [savingCost, setSavingCost] = useState(false);

  const loadCosts = async () => {
    const res = await fetch("/api/admin/costs");
    const json = await res.json();
    setCostServices(json.services || []);
    setCostsLoading(false);
  };
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loadCosts sets state after an await, not synchronously; this just triggers the fetch when this sub-tab becomes active
    if (section === "costs") { loadCosts(); }
  }, [section]);

  const handleRefreshCosts = async () => {
    setRefreshingCosts(true);
    await fetch("/api/admin/costs/refresh", { method: "POST" });
    await loadCosts();
    setRefreshingCosts(false);
  };

  const handleAddManualCost = async () => {
    const amount = parseFloat(newCost.amount_usd);
    if (!newCost.service || isNaN(amount)) return;
    setSavingCost(true);
    const now = new Date();
    const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
    await fetch("/api/admin/costs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        service: newCost.service,
        amount_usd: amount,
        period_start: periodStart,
        period_end: now.toISOString().slice(0, 10),
        notes: newCost.notes.trim() || null,
      }),
    });
    setSavingCost(false);
    setNewCost({ service: "fly", amount_usd: "", notes: "" });
    setAddingCost(false);
    loadCosts();
  };

  const totalMonthlySpend = costServices.reduce((sum, s) => sum + (s.latest?.amount_usd || 0), 0);

  // Analytics
  const [analytics, setAnalytics] = useState<AnalyticsData | null>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(true);
  const loadAnalytics = async () => {
    const res = await fetch("/api/admin/analytics");
    const json = await res.json();
    setAnalytics(json);
    setAnalyticsLoading(false);
  };
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loadAnalytics sets state after an await, not synchronously; this just triggers the fetch when this sub-tab becomes active
    if (section === "analytics") { loadAnalytics(); }
  }, [section]);

  return (
    <div className="space-y-4">
      <div className="flex gap-2 flex-wrap">
        {SECTIONS.map(s => {
          const Icon = s.icon;
          return (
            <button
              key={s.id}
              onClick={() => setSection(s.id)}
              className={`flex items-center gap-2 px-4 py-2 rounded-full text-[11px] font-bold transition-all ${
                section === s.id ? "bg-slate-900 text-white" : "bg-white border border-slate-200 text-slate-500 hover:border-slate-400"
              }`}
            >
              <Icon size={13} />
              {s.label}
            </button>
          );
        })}
      </div>

      {/* ── Heartbeat ── */}
      {section === "heartbeat" && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
              {lastCheckedAt ? `Last checked ${lastCheckedAt.toLocaleTimeString()}` : "Checking..."}
            </p>
            <button
              onClick={runChecks}
              disabled={checksLoading}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-900 text-white rounded-full text-[10px] font-bold disabled:opacity-50"
            >
              <RotateCw size={11} className={checksLoading ? "animate-spin" : ""} /> Recheck
            </button>
          </div>
          {checksLoading && checks.length === 0 ? (
            <div className="flex justify-center py-10"><Loader2 size={20} className="animate-spin text-slate-300" /></div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {checks.map(c => (
                <div key={c.name} className={`flex items-center gap-3 p-4 rounded-2xl border ${c.ok ? "border-emerald-100 bg-emerald-50/40" : "border-red-100 bg-red-50/40"}`}>
                  {c.ok ? <CheckCircle2 size={16} className="text-emerald-600 shrink-0" /> : <XCircle size={16} className="text-red-500 shrink-0" />}
                  <div className="flex-1 min-w-0">
                    <p className="text-[12px] font-bold text-slate-800 truncate">{c.name}</p>
                    <p className="text-[10px] text-slate-400">
                      {c.ok ? `${c.latencyMs}ms` : c.detail || "unreachable"}
                      {c.ok && c.detail ? ` — ${c.detail}` : ""}
                      <span className="ml-1.5 px-1.5 py-0.5 rounded bg-slate-100 text-slate-400">{c.group}</span>
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Services (non-Gmail background jobs) ── */}
      {section === "services" && (
        servicesLoading
          ? <div className="flex justify-center py-10"><Loader2 size={20} className="animate-spin text-slate-300" /></div>
          : <HeartbeatStatusList defs={SERVICE_HEARTBEAT_DEFS} heartbeats={serviceHeartbeats} />
      )}

      {/* ── Secrets ── */}
      {section === "secrets" && (
        secretsLoading ? (
          <div className="flex justify-center py-10"><Loader2 size={20} className="animate-spin text-slate-300" /></div>
        ) : (
          <div className="space-y-3">
            {staleGoogleTokenCount > 0 && (
              <div className="px-4 py-3 bg-amber-50 border border-amber-100 rounded-2xl text-[12px] text-amber-800">
                {staleGoogleTokenCount} Gmail OAuth token{staleGoogleTokenCount !== 1 ? "s" : ""} currently expired — should self-heal on next refresh, worth checking if this persists.
              </div>
            )}
            {azureExpiring.map((a, i) => (
              <div key={i} className="px-4 py-3 bg-amber-50 border border-amber-100 rounded-2xl text-[12px] text-amber-800">
                {a.companyName} — {a.kind} client secret expires {new Date(a.expires_at).toLocaleDateString()}
              </div>
            ))}

            {secrets.map(s => {
              const status = secretStatus(s);
              return (
                <div key={s.id} className="bg-white border border-slate-100 rounded-[28px] p-5">
                  <div className="flex items-center gap-4">
                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] font-bold text-slate-800">{s.label}</p>
                      {editingExpiryId === s.id ? (
                        <input
                          type="date"
                          autoFocus
                          defaultValue={s.expires_at ? s.expires_at.slice(0, 10) : ""}
                          onBlur={e => handleSetExpiry(s.id, e.target.value)}
                          onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setEditingExpiryId(null); }}
                          className="mt-1 px-3 py-1 border border-indigo-300 rounded-full text-[11px] outline-none"
                        />
                      ) : (
                        <button
                          onClick={() => setEditingExpiryId(s.id)}
                          className="text-[11px] text-slate-400 mt-0.5 hover:text-indigo-600 hover:underline text-left"
                        >
                          {s.expires_at
                            ? `Expires ${new Date(s.expires_at).toLocaleDateString()}`
                            : s.last_rotated_at
                              ? `Last rotated ${new Date(s.last_rotated_at).toLocaleDateString()}${s.rotation_interval_days ? ` — every ${s.rotation_interval_days}d` : ""} (no expiry set)`
                              : "No expiry set — click to add"}
                        </button>
                      )}
                      {s.notes && <p className="text-[10px] text-slate-300 mt-1">{s.notes}</p>}
                    </div>
                    <span className={`px-3 py-1 rounded-full text-[10px] font-bold uppercase shrink-0 ${status.className}`}>{status.label}</span>
                    <button onClick={() => handleMarkRotated(s.id)} className="p-1.5 text-slate-300 hover:text-indigo-600 transition-colors shrink-0" title="Mark rotated today">
                      <RotateCw size={13} />
                    </button>
                    <button onClick={() => handleDeleteSecret(s.id)} className="p-1.5 text-slate-300 hover:text-red-500 transition-colors shrink-0">
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              );
            })}

            {addingSecret ? (
              <div className="bg-white border border-slate-200 rounded-[28px] p-5 space-y-2">
                <input value={newSecret.service} onChange={e => setNewSecret(p => ({ ...p, service: e.target.value }))}
                  placeholder="Service slug e.g. custom_thing" className="w-full px-4 py-2 border border-slate-200 rounded-full text-[12px] outline-none focus:border-indigo-400" />
                <input value={newSecret.label} onChange={e => setNewSecret(p => ({ ...p, label: e.target.value }))}
                  placeholder="Label e.g. Custom thing API key" className="w-full px-4 py-2 border border-slate-200 rounded-full text-[12px] outline-none focus:border-indigo-400" />
                <div>
                  <label className="text-[10px] text-slate-400 block mb-1 ml-1">Expires on (if known)</label>
                  <input type="date" value={newSecret.expires_at} onChange={e => setNewSecret(p => ({ ...p, expires_at: e.target.value }))}
                    className="w-full px-4 py-2 border border-slate-200 rounded-full text-[12px] outline-none focus:border-indigo-400" />
                </div>
                <div>
                  <label className="text-[10px] text-slate-400 block mb-1 ml-1">Or a rotation cadence, if it has no fixed expiry</label>
                  <input type="number" value={newSecret.rotation_interval_days} onChange={e => setNewSecret(p => ({ ...p, rotation_interval_days: e.target.value }))}
                    placeholder="Rotation interval (days)" className="w-full px-4 py-2 border border-slate-200 rounded-full text-[12px] outline-none focus:border-indigo-400" />
                </div>
                <div className="flex gap-2">
                  <button onClick={handleAddSecret} disabled={savingSecret} className="px-5 py-2 bg-indigo-600 text-white text-[12px] font-bold rounded-full disabled:opacity-40">
                    {savingSecret ? "Saving..." : "Add"}
                  </button>
                  <button onClick={() => setAddingSecret(false)} className="px-4 py-2 text-[12px] text-slate-400 hover:text-slate-700">Cancel</button>
                </div>
              </div>
            ) : (
              <button onClick={() => setAddingSecret(true)} className="flex items-center gap-1.5 px-4 py-2 border border-dashed border-slate-300 rounded-full text-[11px] text-slate-500 hover:border-indigo-400 hover:text-indigo-600 transition-all">
                <Plus size={12} /> Track another secret
              </button>
            )}
          </div>
        )
      )}

      {/* ── Costs ── */}
      {section === "costs" && (
        costsLoading ? (
          <div className="flex justify-center py-10"><Loader2 size={20} className="animate-spin text-slate-300" /></div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between bg-slate-900 text-white rounded-[28px] p-6">
              <div>
                <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">Estimated spend this month</p>
                <p className="text-2xl font-light">${totalMonthlySpend.toFixed(2)}</p>
              </div>
              <button onClick={handleRefreshCosts} disabled={refreshingCosts} className="flex items-center gap-1.5 px-4 py-2 bg-white text-slate-900 rounded-full text-[11px] font-bold disabled:opacity-50">
                <RotateCw size={12} className={refreshingCosts ? "animate-spin" : ""} /> Refresh live numbers
              </button>
            </div>

            {costServices.map(g => (
              <div key={g.service} className="bg-white border border-slate-100 rounded-[28px] p-5">
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <p className="text-[13px] font-bold text-slate-800">{COST_SERVICE_LABELS[g.service] || g.service}</p>
                    <p className="text-[11px] text-slate-400">{g.latest.period_start} → {g.latest.period_end}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-[18px] font-light text-slate-800">${g.latest.amount_usd.toFixed(2)}</p>
                    <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold uppercase ${g.latest.source === "live" ? "bg-emerald-50 text-emerald-600" : "bg-slate-100 text-slate-500"}`}>
                      {g.latest.source}
                    </span>
                  </div>
                </div>
                {g.history.length > 1 && (
                  <MiniLineChart valueLabel="USD" data={g.history.map(h => ({ label: h.period_start, value: h.amount_usd }))} />
                )}
              </div>
            ))}

            {addingCost ? (
              <div className="bg-white border border-slate-200 rounded-[28px] p-5 space-y-2">
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                  Manual entry — Fly.io, Supabase, and Together AI have no public billing API, so track them by hand.
                </p>
                <select value={newCost.service} onChange={e => setNewCost(p => ({ ...p, service: e.target.value }))}
                  className="w-full px-4 py-2 border border-slate-200 rounded-full text-[12px] outline-none focus:border-indigo-400 bg-white">
                  {MANUAL_ONLY_SERVICES.map(s => <option key={s} value={s}>{COST_SERVICE_LABELS[s]}</option>)}
                </select>
                <input type="number" step="0.01" value={newCost.amount_usd} onChange={e => setNewCost(p => ({ ...p, amount_usd: e.target.value }))}
                  placeholder="Amount USD" className="w-full px-4 py-2 border border-slate-200 rounded-full text-[12px] outline-none focus:border-indigo-400" />
                <input value={newCost.notes} onChange={e => setNewCost(p => ({ ...p, notes: e.target.value }))}
                  placeholder="Notes (optional)" className="w-full px-4 py-2 border border-slate-200 rounded-full text-[12px] outline-none focus:border-indigo-400" />
                <div className="flex gap-2">
                  <button onClick={handleAddManualCost} disabled={savingCost} className="px-5 py-2 bg-indigo-600 text-white text-[12px] font-bold rounded-full disabled:opacity-40">
                    {savingCost ? "Saving..." : "Add"}
                  </button>
                  <button onClick={() => setAddingCost(false)} className="px-4 py-2 text-[12px] text-slate-400 hover:text-slate-700">Cancel</button>
                </div>
              </div>
            ) : (
              <button onClick={() => setAddingCost(true)} className="flex items-center gap-1.5 px-4 py-2 border border-dashed border-slate-300 rounded-full text-[11px] text-slate-500 hover:border-indigo-400 hover:text-indigo-600 transition-all">
                <Plus size={12} /> Add manual cost entry
              </button>
            )}
          </div>
        )
      )}

      {/* ── Analytics ── */}
      {section === "analytics" && (
        analyticsLoading || !analytics ? (
          <div className="flex justify-center py-10"><Loader2 size={20} className="animate-spin text-slate-300" /></div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-white border border-slate-100 rounded-[28px] p-5">
                <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">Visits (30d)</p>
                <p className="text-xl font-light text-slate-800">{analytics.totals.visits.toLocaleString()}</p>
              </div>
              <div className="bg-white border border-slate-100 rounded-[28px] p-5">
                <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">API calls (30d)</p>
                <p className="text-xl font-light text-slate-800">{analytics.totals.invocations.toLocaleString()}</p>
              </div>
            </div>

            <div className="bg-white border border-slate-100 rounded-[28px] p-5">
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Visits per day</p>
              <MiniLineChart valueLabel="visits" data={analytics.visitsByDay.map(d => ({ label: d.date, value: d.count }))} />
            </div>

            <div className="bg-white border border-slate-100 rounded-[28px] p-5">
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">API invocations per day</p>
              <MiniLineChart valueLabel="calls" data={analytics.invocationsByDay.map(d => ({ label: d.date, value: d.count }))} />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="bg-white border border-slate-100 rounded-[28px] p-5">
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Top pages</p>
                <RankedList items={analytics.topPaths} />
              </div>
              <div className="bg-white border border-slate-100 rounded-[28px] p-5">
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Top API endpoints</p>
                <RankedList items={analytics.topApiEndpoints} mono />
              </div>
            </div>
          </div>
        )
      )}
    </div>
  );
}
