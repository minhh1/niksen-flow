// app/link-teams/page.tsx
// Landing page for the Teams-bot magic link (see
// app/api/teams/bot/[companyId]/route.ts, which sends this URL to an
// unrecognized Teams sender). Requires a real Diract login -- that's the
// actual identity-proving step; app/api/teams/bot/link/route.ts does the
// write once confirmed here.
"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Sparkles, Loader2, CheckCircle2, AlertTriangle } from "lucide-react";
import { supabase } from "@/lib/supabase";

export default function LinkTeamsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const code = searchParams.get("code");

  const [checkingAuth, setCheckingAuth] = useState(true);
  const [linking, setLinking] = useState(false);
  const [linked, setLinked] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        const redirectTo = `/link-teams?code=${encodeURIComponent(code ?? "")}`;
        router.replace(`/login?redirect=${encodeURIComponent(redirectTo)}`);
        return;
      }
      setCheckingAuth(false);
    })();
  }, [code, router]);

  const confirmLink = async () => {
    if (!code) return;
    setLinking(true);
    setError(null);
    const res = await fetch("/api/teams/bot/link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const json = await res.json().catch(() => null);
    setLinking(false);
    if (!res.ok) {
      setError(json?.error || "Failed to link your account");
      return;
    }
    setLinked(true);
  };

  if (!code) {
    return (
      <div className="flex items-center justify-center h-screen bg-[#F9FAFB]">
        <p className="text-[13px] text-slate-400">Missing link code.</p>
      </div>
    );
  }

  if (checkingAuth) {
    return (
      <div className="flex items-center justify-center h-screen bg-[#F9FAFB]">
        <Loader2 size={20} className="animate-spin text-slate-300" />
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center h-screen bg-[#F9FAFB] font-sans antialiased">
      <div className="bg-white border border-slate-200 rounded-[32px] p-8 max-w-sm w-full text-center space-y-4">
        <div className="h-12 w-12 rounded-2xl bg-indigo-50 flex items-center justify-center mx-auto">
          <Sparkles size={22} className="text-indigo-600" />
        </div>

        {linked ? (
          <>
            <p className="flex items-center justify-center gap-1.5 text-[14px] font-bold text-emerald-600">
              <CheckCircle2 size={16} /> Linked
            </p>
            <p className="text-[12px] text-slate-500">
              Your Microsoft Teams account is now linked to Diract. Go back to Teams and send your question again.
            </p>
          </>
        ) : (
          <>
            <p className="text-[14px] font-bold text-slate-800">Link your Microsoft Teams account</p>
            <p className="text-[12px] text-slate-500">
              This lets the AI assistant remember your conversation across messages in Teams, tied to your Diract account.
            </p>
            {error && (
              <p className="flex items-center justify-center gap-1.5 text-[11px] text-red-500">
                <AlertTriangle size={12} /> {error}
              </p>
            )}
            <button
              onClick={confirmLink}
              disabled={linking}
              className="w-full px-5 py-2.5 bg-indigo-600 text-white text-[12px] font-bold rounded-full hover:bg-indigo-700 disabled:opacity-40 transition-colors"
            >
              {linking ? "Linking..." : "Link account"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
