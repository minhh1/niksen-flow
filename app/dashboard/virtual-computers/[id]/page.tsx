// app/dashboard/virtual-computers/[id]/page.tsx
// Full-screen session view. The API layer (app/api/virtual-computers/[id]/*)
// guards that only the assigned member or an admin can reach this VM.
//
// Disconnect detection is entirely passive here -- there's no "explicit
// logoff" action tied to leaving this page (that coupling used to live on
// the back button plus an app-wide navigation guard, but it made leaving
// the page feel fiddly and could get stuck asking to "log off" a VM that
// was already mid-hibernate). Just bump last_seen_at while the tab is open
// and let the sweep route's own inactivity rule (see
// app/api/virtual-computers/sweep/route.ts) decide, whenever this page
// happens to be closed.
"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState, useCallback, useRef } from "react";
import { ArrowLeft, Loader2, HelpCircle, Copy, Check } from "lucide-react";
import GuacamoleViewer from "@/components/virtualcomputers/GuacamoleViewer";
import VmStatusBadge from "@/components/virtualcomputers/VmStatusBadge";
import CredentialsHelpDrawer from "@/components/admin/CredentialsHelpDrawer";

interface VmStatus {
  id: string;
  status: string;
  errorMessage: string | null;
  os: "linux" | "windows";
  provider: string;
  protocol: string;
  createdAt: string;
  hibernateDeadline: string | null;
  resolutionWidth: number | null;
  resolutionHeight: number | null;
}

interface ConnectionInfo {
  hostname: string;
  port: number;
  protocol: string;
  username: string;
  password: string;
}

// "Ultra-wide" is an honest single wide desktop, not real multi-monitor --
// Guacamole's RDP support doesn't have confirmed multi-monitor capability.
const RESOLUTION_PRESETS: { label: string; width: number | null; height: number | null }[] = [
  { label: "Match my screen", width: null, height: null },
  { label: "1920 x 1080", width: 1920, height: 1080 },
  { label: "2560 x 1440", width: 2560, height: 1440 },
  { label: "3840 x 1080 (ultra-wide)", width: 3840, height: 1080 },
];

function elapsedLabel(createdAt: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - new Date(createdAt).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

// Native RDP/VNC clients skip the browser<->Guacamole relay entirely --
// confirmed directly, this connects straight from a Mac's own Windows App
// to a real VM: noticeably snappier than the same VM through the browser,
// though some residual lag remains either way (nested-virtualization
// scheduling jitter, not something a client choice can fix). Worth
// documenting as a real, already-available option -- the RDP/VNC port is
// already open on every VM's public IP regardless (that's how the native
// client test above worked at all), this just surfaces it.
function connectStepsFor(protocol: string) {
  const nativeApp =
    protocol === "rdp"
      ? "a Remote Desktop app -- \"Windows App\" (Mac App Store) on a Mac, the built-in \"Remote Desktop Connection\" on Windows, or \"Remmina\" on Linux"
      : "a VNC viewer app -- \"Screen Sharing\" (built into macOS) or \"RealVNC Viewer\"/\"TigerVNC Viewer\" on Windows/Linux";
  return [
    {
      title: "Opening it in the browser",
      description:
        "\"Open virtual computer\" launches a full remote desktop in a new browser tab -- no install needed, works on any device, but it does add a small relay hop and re-renders the screen for the browser, which can feel a little softer than a direct connection.",
    },
    {
      title: "Want it faster? Connect with a native app instead",
      description: `Connecting directly with ${nativeApp} skips that relay and rendering step, and can feel noticeably snappier -- confirmed directly by testing both side by side on the same computer. Click "Show connection details" below to get the address and login, then add them as a new connection in that app.`,
    },
    {
      title: "Your computer's schedule still applies",
      description:
        "Connecting a different way doesn't change when this computer sleeps or wakes -- it still follows whatever awake-hours schedule your admin set, it just won't show this page's \"waking up\" progress screen while you wait.",
    },
  ];
}

const HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000;
const EXTEND_PROMPT_LEAD_MS = 15 * 60 * 1000;

export default function VirtualComputerSessionPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [status, setStatus] = useState<VmStatus | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [showExtendPrompt, setShowExtendPrompt] = useState(false);
  const wakeRequested = useRef(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [connectionInfo, setConnectionInfo] = useState<ConnectionInfo | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [loadingConnectionInfo, setLoadingConnectionInfo] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [changingPassword, setChangingPassword] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordMessage, setPasswordMessage] = useState<string | null>(null);
  const [savingPassword, setSavingPassword] = useState(false);

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

  // Deliberately coarse (every 30 min), just bumps last_seen_at. Runs any
  // time the tab is open with the VM running -- whether that staleness
  // actually matters (and how stale is stale enough) is entirely decided
  // server-side by the sweep route's inactivity rule.
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

  const setResolution = async (width: number | null, height: number | null) => {
    await fetch(`/api/virtual-computers/${id}/resolution`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ width, height }),
    });
    poll();
  };

  const revealConnectionInfo = async () => {
    setLoadingConnectionInfo(true);
    setConnectionError(null);
    const res = await fetch(`/api/virtual-computers/${id}/connection-info`);
    const json = await res.json();
    setLoadingConnectionInfo(false);
    if (!res.ok) {
      setConnectionError(json.error || "Could not load connection details");
      return;
    }
    setConnectionInfo(json);
  };

  const copyField = (field: string, value: string) => {
    navigator.clipboard.writeText(value);
    setCopiedField(field);
    setTimeout(() => setCopiedField((cur) => (cur === field ? null : cur)), 1500);
  };

  const submitNewPassword = async () => {
    setSavingPassword(true);
    setPasswordError(null);
    setPasswordMessage(null);
    const res = await fetch(`/api/virtual-computers/${id}/reset-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: newPassword }),
    });
    const json = await res.json();
    setSavingPassword(false);
    if (!res.ok) {
      setPasswordError(json.error || "Could not save this password");
      return;
    }
    setPasswordMessage(json.message);
    setNewPassword("");
    setChangingPassword(false);
    // The connection details panel (if already revealed) would otherwise
    // keep showing the now-stale password until the next full page load.
    setConnectionInfo(null);
  };

  return (
    <div className="flex flex-col h-screen">
      <div className="flex items-center gap-3 px-6 py-3 border-b border-slate-100 bg-white shrink-0">
        <button
          onClick={() => router.push("/dashboard/virtual-computers")}
          className="p-1.5 text-slate-400 hover:text-slate-700"
        >
          <ArrowLeft size={16} />
        </button>
        <p className="text-[13px] font-bold text-slate-800 flex-1">Virtual Computer</p>
        {status && (
          <select
            value={RESOLUTION_PRESETS.findIndex(
              (p) => p.width === status.resolutionWidth && p.height === status.resolutionHeight
            )}
            onChange={(e) => {
              const preset = RESOLUTION_PRESETS[Number(e.target.value)];
              setResolution(preset.width, preset.height);
            }}
            title="Display size (takes effect next connect)"
            className="px-2 py-1 border border-slate-200 rounded-full text-[11px] outline-none focus:border-indigo-400"
          >
            {RESOLUTION_PRESETS.map((p, i) => (
              <option key={p.label} value={i}>
                {p.label}
              </option>
            ))}
          </select>
        )}
        {status && <VmStatusBadge status={status.status} />}
        <button
          onClick={() => setHelpOpen(true)}
          className="flex items-center gap-1 px-2 py-1 text-[11px] font-bold text-slate-400 hover:text-indigo-600 transition-colors"
        >
          <HelpCircle size={13} />
          Connect a different way
        </button>
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
                ? "Saving a snapshot before shutting down..."
                : "Setting up your virtual computer..."}
              {status.createdAt && ` (${elapsedLabel(status.createdAt, now)})`}
            </p>
            <p className="text-[12px] text-slate-400 max-w-sm">
              {status.os === "windows" && status.provider === "digitalocean"
                ? "Installing Windows 11 from scratch -- this can take 75-90 minutes."
                : status.os === "windows"
                ? "Installing Windows and Microsoft Office -- this can take 10-15 minutes."
                : "This usually takes about a minute."}
            </p>
          </div>
        )}
      </div>

      {status && (
        <CredentialsHelpDrawer
          isOpen={helpOpen}
          onClose={() => setHelpOpen(false)}
          title="Connect a different way"
          intro="This computer is reachable from the browser, or directly from a native app on your own device."
          steps={connectStepsFor(status.protocol)}
          footer={
            <div className="pt-2 border-t border-slate-100">
              {status.status !== "running" ? (
                <p className="text-[11px] text-slate-400">
                  Connection details are only available while this computer is running.
                </p>
              ) : !connectionInfo ? (
                <button
                  onClick={revealConnectionInfo}
                  disabled={loadingConnectionInfo}
                  className="w-full px-4 py-2 bg-indigo-600 text-white text-[12px] font-bold rounded-full hover:bg-indigo-700 disabled:opacity-40 transition-colors"
                >
                  {loadingConnectionInfo ? "Loading..." : "Show connection details"}
                </button>
              ) : (
                <div className="space-y-2">
                  {[
                    { label: "Address", value: `${connectionInfo.hostname}:${connectionInfo.port}` },
                    { label: "Username", value: connectionInfo.username },
                    { label: "Password", value: connectionInfo.password },
                  ].map((field) => (
                    <div key={field.label} className="flex items-center gap-2 bg-slate-50 rounded-2xl px-4 py-2">
                      <div className="flex-1 min-w-0">
                        <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">{field.label}</p>
                        <p className="text-[12px] font-mono text-slate-700 truncate">{field.value}</p>
                      </div>
                      <button
                        onClick={() => copyField(field.label, field.value)}
                        className="p-1.5 text-slate-300 hover:text-indigo-600 transition-colors shrink-0"
                        title={`Copy ${field.label.toLowerCase()}`}
                      >
                        {copiedField === field.label ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {connectionError && <p className="text-[11px] text-red-500 mt-2">{connectionError}</p>}

              <div className="pt-3 mt-3 border-t border-slate-100">
                {status.provider === "digitalocean" && status.os === "windows" ? (
                  <p className="text-[11px] text-slate-400">
                    This computer&rsquo;s password can&rsquo;t be changed after Windows 11 finishes installing --
                    ask an admin to reinstall Windows if you need it reset.
                  </p>
                ) : !changingPassword ? (
                  <button
                    onClick={() => {
                      setChangingPassword(true);
                      setPasswordMessage(null);
                    }}
                    className="text-[11px] font-bold text-slate-400 hover:text-indigo-600 transition-colors"
                  >
                    Change password
                  </button>
                ) : (
                  <div className="space-y-2">
                    <p className="text-[11px] text-slate-400">
                      Takes effect the next time this computer sleeps and wakes back up -- not immediately, and not
                      for your current session.
                    </p>
                    <input
                      type="text"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      placeholder="New password"
                      className="w-full px-3 py-2 border border-slate-200 rounded-full text-[12px] font-mono outline-none focus:border-indigo-400"
                    />
                    {passwordError && <p className="text-[11px] text-red-500">{passwordError}</p>}
                    <div className="flex gap-2">
                      <button
                        onClick={submitNewPassword}
                        disabled={savingPassword || !newPassword}
                        className="flex-1 px-4 py-2 bg-indigo-600 text-white text-[12px] font-bold rounded-full hover:bg-indigo-700 disabled:opacity-40 transition-colors"
                      >
                        {savingPassword ? "Saving..." : "Save"}
                      </button>
                      <button
                        onClick={() => {
                          setChangingPassword(false);
                          setNewPassword("");
                          setPasswordError(null);
                        }}
                        className="px-4 py-2 text-[12px] font-bold text-slate-400 hover:text-slate-700 transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
                {passwordMessage && <p className="text-[11px] text-emerald-600 mt-2">{passwordMessage}</p>}
              </div>
            </div>
          }
        />
      )}
    </div>
  );
}
