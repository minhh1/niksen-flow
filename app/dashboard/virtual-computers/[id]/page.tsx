// app/dashboard/virtual-computers/[id]/page.tsx
// Full-screen session view. The API layer (app/api/virtual-computers/[id]/*)
// guards that only the assigned member or an admin can reach this VM.
//
// This page is also where the app's primary disconnect-detection signal
// lives: while mounted, it marks the shared VmSessionContext active so
// Sidebar.tsx blocks navigation elsewhere in the app -- the back button
// here is the one sanctioned exit, and it explicitly logs the session off
// (see the plan's disconnect-detection design) rather than just navigating
// away silently.
"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState, useCallback, useRef } from "react";
import { ArrowLeft, Loader2 } from "lucide-react";
import GuacamoleViewer from "@/components/virtualcomputers/GuacamoleViewer";
import VmStatusBadge from "@/components/virtualcomputers/VmStatusBadge";
import { useVmSession } from "@/components/VmSessionContext";

interface VmStatus {
  id: string;
  status: string;
  errorMessage: string | null;
  os: "linux" | "windows";
  createdAt: string;
  hibernateDeadline: string | null;
}

function elapsedLabel(createdAt: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - new Date(createdAt).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

const HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000;
const EXTEND_PROMPT_LEAD_MS = 15 * 60 * 1000;

export default function VirtualComputerSessionPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const vmSession = useVmSession();
  const [status, setStatus] = useState<VmStatus | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [loggingOff, setLoggingOff] = useState(false);
  const [showExtendPrompt, setShowExtendPrompt] = useState(false);
  const wakeRequested = useRef(false);

  const poll = useCallback(async () => {
    const res = await fetch(`/api/virtual-computers/${id}/status`);
    if (!res.ok) {
      router.replace("/dashboard/virtual-computers");
      return;
    }
    const json = await res.json();
    setStatus(json);
  }, [id, router]);

  useEffect(() => {
    poll();
  }, [poll]);

  // Primary disconnect signal: mark the session active for as long as this
  // page is mounted; Sidebar.tsx blocks navigation elsewhere while it is.
  useEffect(() => {
    vmSession.setActive(true);
    return () => vmSession.setActive(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isWaiting = status?.status === "provisioning" || status?.status === "snapshotting" || status?.status === "hibernated";

  useEffect(() => {
    if (!isWaiting) return;
    const interval = setInterval(poll, 4000);
    return () => clearInterval(interval);
  }, [isWaiting, poll]);

  useEffect(() => {
    if (!isWaiting) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [isWaiting]);

  // Auto-wake: arriving at a hibernated VM (outside the schedule's
  // pre-warmed window) still gets a working experience, just without the
  // head start -- kick off wake once, then poll like any other
  // provisioning wait.
  useEffect(() => {
    if (status?.status !== "hibernated" || wakeRequested.current) return;
    wakeRequested.current = true;
    fetch(`/api/virtual-computers/${id}/wake`, { method: "POST" }).finally(poll);
  }, [status, id, poll]);

  // Evening-only heartbeat fallback -- deliberately coarse (every 30 min),
  // just bumps last_seen_at so the sweep cron can tell whether the last
  // couple of pings showed any activity. Whether that staleness actually
  // matters is decided server-side (only after 7pm company time).
  useEffect(() => {
    if (status?.status !== "running") return;
    const interval = setInterval(() => {
      fetch(`/api/virtual-computers/${id}/heartbeat`, { method: "POST" });
    }, HEARTBEAT_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [status, id]);

  // Midnight backstop extend prompt.
  useEffect(() => {
    if (status?.status !== "running" || !status.hibernateDeadline) {
      setShowExtendPrompt(false);
      return;
    }
    const msUntilDeadline = new Date(status.hibernateDeadline).getTime() - now;
    setShowExtendPrompt(msUntilDeadline <= EXTEND_PROMPT_LEAD_MS);
  }, [status, now]);

  useEffect(() => {
    if (status?.status !== "running") return;
    const interval = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(interval);
  }, [status]);

  const extendSession = async () => {
    await fetch(`/api/virtual-computers/${id}/extend`, { method: "POST" });
    setShowExtendPrompt(false);
    poll();
  };

  const logOffAndLeave = async () => {
    if (status?.status === "running") {
      setLoggingOff(true);
      await fetch(`/api/virtual-computers/${id}/logoff`, { method: "POST" });
    }
    vmSession.setActive(false);
    router.push("/dashboard/virtual-computers");
  };

  return (
    <div className="flex flex-col h-screen">
      <div className="flex items-center gap-3 px-6 py-3 border-b border-slate-100 bg-white shrink-0">
        <button
          onClick={logOffAndLeave}
          disabled={loggingOff}
          className="p-1.5 text-slate-400 hover:text-slate-700 disabled:opacity-40"
        >
          {loggingOff ? <Loader2 size={16} className="animate-spin" /> : <ArrowLeft size={16} />}
        </button>
        <p className="text-[13px] font-bold text-slate-800 flex-1">Virtual Computer</p>
        {status && <VmStatusBadge status={status.status} />}
      </div>

      {showExtendPrompt && (
        <div className="flex items-center gap-3 px-6 py-3 bg-amber-50 text-amber-700 text-[12px] shrink-0">
          <p className="flex-1">Still working? This virtual computer is scheduled to log off soon.</p>
          <button onClick={extendSession} className="px-4 py-1.5 bg-amber-600 text-white rounded-full font-bold hover:bg-amber-700 transition-colors">
            Keep it running
          </button>
        </div>
      )}

      <div className="flex-1 min-h-0">
        {!status ? null : status.status === "running" ? (
          <GuacamoleViewer vmId={id} />
        ) : status.status === "error" ? (
          <div className="flex items-center justify-center h-full text-[13px] text-red-600 bg-red-50 m-6 rounded-2xl p-6">
            {status.errorMessage || "Something went wrong provisioning this virtual computer."}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center px-6">
            <Loader2 size={20} className="text-indigo-400 animate-spin" />
            <p className="text-[13px] text-slate-500 font-medium">
              {status.status === "hibernated"
                ? "Waking up your virtual computer..."
                : status.status === "snapshotting"
                ? "Saving a snapshot and logging off..."
                : "Setting up your virtual computer..."}
              {status.createdAt && ` (${elapsedLabel(status.createdAt, now)})`}
            </p>
            <p className="text-[12px] text-slate-400 max-w-sm">
              {status.os === "windows"
                ? "Installing Windows and Microsoft Office -- this can take 10-15 minutes."
                : "This usually takes about a minute."}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
