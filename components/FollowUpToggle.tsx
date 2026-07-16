// components/FollowUpToggle.tsx
// Second "tick" — marks a task as done-on-our-end but awaiting a follow-up,
// distinct from full completion. Turning it on offers an optional follow-up
// date via a small popover.
"use client";

import { useState, useRef, useEffect } from "react";
import { Flag } from "lucide-react";

interface Props {
  checked: boolean;
  date: string | null;
  onChange: (checked: boolean, date: string | null) => void;
}

export default function FollowUpToggle({ checked, date, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [pendingDate, setPendingDate] = useState(date || "");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const handleClick = () => {
    if (checked) {
      onChange(false, null);
    } else {
      setPendingDate(date || "");
      setOpen(true);
    }
  };

  const confirm = (withDate: boolean) => {
    onChange(true, withDate ? (pendingDate || null) : null);
    setOpen(false);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={handleClick}
        title={checked ? "Awaiting follow-up — click to clear" : "Mark done on our end, awaiting follow-up"}
        className={`w-5 h-5 rounded-full border-2 shrink-0 flex items-center justify-center transition-all ${
          checked ? "bg-amber-400 border-amber-400" : "border-slate-300 hover:border-amber-400"
        }`}
      >
        {checked && <Flag size={10} className="text-white" />}
      </button>
      {open && (
        <div className="absolute z-50 top-full left-0 mt-2 w-64 bg-white border border-slate-200 rounded-2xl shadow-lg p-4 space-y-3">
          <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Follow-up date (optional)</p>
          <input
            type="date"
            value={pendingDate}
            onChange={e => setPendingDate(e.target.value)}
            className="w-full px-3 py-2 border border-slate-200 rounded-full text-[12px] outline-none focus:border-amber-400"
          />
          <div className="flex gap-2">
            <button onClick={() => confirm(false)}
              className="flex-1 py-2 border border-slate-200 text-slate-500 text-[11px] font-bold rounded-full hover:bg-slate-50">
              Skip
            </button>
            <button onClick={() => confirm(true)}
              className="flex-1 py-2 bg-amber-500 text-white text-[11px] font-bold rounded-full hover:bg-amber-600">
              Set
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
