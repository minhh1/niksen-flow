// app/dashboard/billing/page.tsx
// Company billing: view/subscribe to a platform plan (Stripe Checkout) and
// manage an existing subscription (Stripe Billing Portal). Any company
// member can view; only a company_admin sees the Subscribe/Manage buttons --
// mirrors the admin-gating pattern in app/dashboard/admin/page.tsx, but
// non-admins get a read-only view instead of a hard block, since their
// virtual-computer options depend on knowing the plan/status.
"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { CreditCard, Loader2, CheckCircle2, AlertCircle } from "lucide-react";

interface Plan {
  id: string;
  name: string;
  priceUsdDisplay: number;
  includedVmSlots: number;
  meteredServiceFeeUsdPerHour?: number;
}

interface Subscription {
  planId: string | null;
  status: string;
  currentPeriodEnd: string | null;
}

const STATUS_STYLES: Record<string, string> = {
  active: "bg-emerald-50 text-emerald-600",
  trialing: "bg-blue-50 text-blue-600",
  past_due: "bg-amber-50 text-amber-600",
  incomplete: "bg-amber-50 text-amber-600",
  incomplete_expired: "bg-red-50 text-red-600",
  canceled: "bg-red-50 text-red-600",
  unpaid: "bg-red-50 text-red-600",
  paused: "bg-slate-100 text-slate-500",
};

export default function BillingPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const checkoutResult = searchParams.get("checkout");

  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [usageThisMonthUsd, setUsageThisMonthUsd] = useState<number | null>(null);
  const [subscribingPlanId, setSubscribingPlanId] = useState<string | null>(null);
  const [openingPortal, setOpeningPortal] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    const res = await fetch("/api/billing/status");
    const json = await res.json();
    setSubscription(json.subscription);
    setPlans(json.plans || []);
    setUsageThisMonthUsd(typeof json.usageThisMonthUsd === "number" ? json.usageThisMonthUsd : null);
  }, []);

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { router.replace("/login"); return; }

      const { data: profile } = await supabase
        .from("profiles").select("active_company_id").eq("id", user.id).single();

      if (profile?.active_company_id) {
        const { data: membership } = await supabase
          .from("company_memberships")
          .select("role")
          .eq("user_id", user.id)
          .eq("company_id", profile.active_company_id)
          .single();
        setIsAdmin(membership?.role === "company_admin");
      }

      await loadStatus();
      setLoading(false);
    })();
  }, [loadStatus, router]);

  useEffect(() => {
    if (checkoutResult !== "success") return;
    // The webhook lands a moment after the redirect -- re-poll briefly so
    // the status badge catches up without requiring a manual refresh.
    let attempts = 0;
    const interval = setInterval(async () => {
      attempts += 1;
      await loadStatus();
      if (attempts >= 5) clearInterval(interval);
    }, 2000);
    return () => clearInterval(interval);
  }, [checkoutResult, loadStatus]);

  const subscribe = async (planId: string) => {
    setError(null);
    setSubscribingPlanId(planId);
    const res = await fetch("/api/billing/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planId }),
    });
    const json = await res.json();
    if (!res.ok) {
      setError(json.error || "Could not start checkout");
      setSubscribingPlanId(null);
      return;
    }
    window.location.href = json.url;
  };

  const manageBilling = async () => {
    setError(null);
    setOpeningPortal(true);
    const res = await fetch("/api/billing/portal", { method: "POST" });
    const json = await res.json();
    if (!res.ok) {
      setError(json.error || "Could not open billing portal");
      setOpeningPortal(false);
      return;
    }
    window.location.href = json.url;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Loader2 className="animate-spin text-slate-300" size={24} />
      </div>
    );
  }

  return (
    <div className="p-8 max-w-3xl mx-auto min-h-screen">
      <h1 className="text-xl font-bold text-slate-800 mb-1">Billing</h1>
      <p className="text-[13px] text-slate-400 mb-8">
        Subscribe to a plan to let admins create platform-billed virtual computers -- we provision and pay the cloud provider, you pay us on a fixed monthly plan.
      </p>

      {checkoutResult === "success" && (
        <div className="flex items-center gap-2 px-4 py-3 mb-6 bg-emerald-50 text-emerald-700 rounded-2xl text-[12px]">
          <CheckCircle2 size={14} className="shrink-0" />
          Checkout complete -- your subscription status will update shortly.
        </div>
      )}
      {checkoutResult === "cancel" && (
        <div className="flex items-center gap-2 px-4 py-3 mb-6 bg-slate-100 text-slate-600 rounded-2xl text-[12px]">
          Checkout was canceled.
        </div>
      )}
      {error && (
        <div className="flex items-center gap-2 px-4 py-3 mb-6 bg-red-50 text-red-600 rounded-2xl text-[12px]">
          <AlertCircle size={14} className="shrink-0" />
          {error}
        </div>
      )}

      {subscription?.planId && (
        <div className="flex items-center gap-4 bg-white border border-slate-200 rounded-[32px] p-6 mb-6">
          <div className="w-11 h-11 rounded-full bg-indigo-50 flex items-center justify-center shrink-0">
            <CreditCard size={18} className="text-indigo-500" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[13px] font-bold text-slate-800">
              Current plan: {plans.find((p) => p.id === subscription.planId)?.name || subscription.planId}
            </p>
            {subscription.currentPeriodEnd && (
              <p className="text-[11px] text-slate-400">
                Renews {new Date(subscription.currentPeriodEnd).toLocaleDateString()}
              </p>
            )}
            {subscription.planId === "payg" && usageThisMonthUsd !== null && (
              <p className="text-[11px] text-indigo-500 font-medium">
                ~${usageThisMonthUsd.toFixed(2)} accrued this month so far (real cloud cost + $0.02/hr service fee)
              </p>
            )}
          </div>
          <span
            className={`inline-flex items-center px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-wide ${
              STATUS_STYLES[subscription.status] || "bg-slate-100 text-slate-500"
            }`}
          >
            {subscription.status.replace("_", " ")}
          </span>
          {isAdmin && (
            <button
              onClick={manageBilling}
              disabled={openingPortal}
              className="px-4 py-2 bg-slate-900 text-white text-[12px] font-bold rounded-full hover:bg-slate-700 disabled:opacity-40 transition-colors"
            >
              {openingPortal ? "Opening..." : "Manage billing"}
            </button>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {plans.map((plan) => {
          const isCurrent = subscription?.planId === plan.id && subscription?.status !== "canceled";
          const isMetered = plan.id === "payg";
          return (
            <div key={plan.id} className="bg-white border border-slate-200 rounded-[32px] p-6 flex flex-col">
              <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-2">{plan.name}</p>
              {isMetered ? (
                <>
                  <p className="text-2xl font-bold text-slate-800 mb-1">
                    +${plan.meteredServiceFeeUsdPerHour?.toFixed(2)}
                    <span className="text-[12px] font-medium text-slate-400">/vm-hr</span>
                  </p>
                  <p className="text-[11px] text-slate-400 mb-6">
                    No base fee -- real cloud cost plus this service fee, billed only for actual hours running (VMs
                    hibernate when idle).
                  </p>
                </>
              ) : (
                <>
                  <p className="text-2xl font-bold text-slate-800 mb-1">
                    ${plan.priceUsdDisplay}
                    <span className="text-[12px] font-medium text-slate-400">/mo</span>
                  </p>
                  <p className="text-[12px] text-slate-500 mb-6">{plan.includedVmSlots} virtual computer{plan.includedVmSlots !== 1 ? "s" : ""} included</p>
                </>
              )}
              {isAdmin && (
                <button
                  onClick={() => subscribe(plan.id)}
                  disabled={isCurrent || subscribingPlanId !== null}
                  className={`mt-auto px-5 py-2.5 text-[12px] font-bold rounded-full transition-colors disabled:opacity-40 ${
                    isCurrent ? "bg-slate-100 text-slate-400" : "bg-indigo-600 text-white hover:bg-indigo-700"
                  }`}
                >
                  {isCurrent ? "Current plan" : subscribingPlanId === plan.id ? "Redirecting..." : "Subscribe"}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
