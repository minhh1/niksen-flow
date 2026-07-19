// components/virtualcomputers/VmStatusBadge.tsx
"use client";

const STATUS_STYLES: Record<string, string> = {
  provisioning: "bg-amber-50 text-amber-600",
  running: "bg-emerald-50 text-emerald-600",
  error: "bg-red-50 text-red-600",
  destroying: "bg-slate-100 text-slate-500",
  destroyed: "bg-slate-100 text-slate-400",
  snapshotting: "bg-amber-50 text-amber-600",
  hibernated: "bg-sky-50 text-sky-600",
};

const STATUS_LABELS: Record<string, string> = {
  provisioning: "Setting up...",
  running: "Running",
  error: "Error",
  destroying: "Destroying...",
  destroyed: "Destroyed",
  snapshotting: "Saving snapshot...",
  hibernated: "Hibernated",
};

export default function VmStatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex items-center px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-wide ${
        STATUS_STYLES[status] || "bg-slate-100 text-slate-500"
      }`}
    >
      {STATUS_LABELS[status] || status}
    </span>
  );
}
