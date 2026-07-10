// components/gmail/SourceEmailManager.tsx
// Admin UI to nominate source-of-truth Gmail email addresses.
"use client";

import { useState } from "react";
import { Plus, X, AlertTriangle, Mail, ShieldCheck } from "lucide-react";

interface Props {
  sourceEmails: string[];
  connectedEmails: string[]; // all Gmail emails connected by company members
  onChange: (emails: string[]) => void;
}

export default function SourceEmailManager({ sourceEmails, connectedEmails, onChange }: Props) {
  const [showWarning, setShowWarning] = useState<string | null>(null);

  const handleAdd = (email: string) => {
    if (sourceEmails.includes(email)) return;
    const next = [...sourceEmails, email];
    if (next.length > 1) {
      setShowWarning(
        `Multiple source emails selected. The most recently applied label changes will take precedence. ` +
        `Conflicting removals will be applied to all users.`
      );
    }
    onChange(next);
  };

  const handleRemove = (email: string) => {
    if (!window.confirm(
      `Remove "${email}" as source of truth?\n\n` +
      `Warning: If this email has labels that other users don't, those labels may be removed ` +
      `from all users on the next sync.`
    )) return;
    onChange(sourceEmails.filter(e => e !== email));
  };

  const available = connectedEmails.filter(e => !sourceEmails.includes(e));

  return (
    <div className="space-y-4">
      <div>
        <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1">
          Source of truth emails
        </p>
        <p className="text-[11px] text-slate-500 leading-relaxed">
          Labels applied or removed from these Gmail accounts will be synced to all other users.
          Only nominate accounts managed by admins.
        </p>
      </div>

      {/* Warning for multiple sources */}
      {showWarning && (
        <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-100 rounded-2xl">
          <AlertTriangle size={13} className="text-amber-500 shrink-0 mt-0.5" />
          <p className="text-[11px] text-amber-700">{showWarning}</p>
          <button onClick={() => setShowWarning(null)} className="ml-auto shrink-0 text-amber-400 hover:text-amber-700">
            <X size={12} />
          </button>
        </div>
      )}

      {/* Current source emails */}
      <div className="space-y-2">
        {sourceEmails.length === 0 && (
          <p className="text-[11px] text-slate-400 italic px-1">
            No source email nominated — sync will use the first connected user found.
          </p>
        )}
        {sourceEmails.map(email => (
          <div key={email} className="flex items-center gap-3 px-4 py-3 bg-indigo-50 border border-indigo-100 rounded-2xl">
            <ShieldCheck size={14} className="text-indigo-500 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-[12px] font-bold text-indigo-800 truncate">{email}</p>
              <p className="text-[10px] text-indigo-400">Source of truth</p>
            </div>
            <button
              onClick={() => handleRemove(email)}
              className="p-1 text-indigo-300 hover:text-red-500 transition-colors"
              title="Remove as source of truth"
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>

      {/* Add from connected emails */}
      {available.length > 0 && (
        <div>
          <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-2">
            Connected Gmail accounts
          </p>
          <div className="space-y-1.5">
            {available.map(email => (
              <button
                key={email}
                onClick={() => handleAdd(email)}
                className="w-full flex items-center gap-3 px-4 py-3 bg-white border border-slate-200 rounded-2xl hover:border-indigo-300 hover:bg-indigo-50 transition-all text-left group"
              >
                <Mail size={13} className="text-slate-400 group-hover:text-indigo-500 shrink-0" />
                <span className="text-[12px] font-medium text-slate-600 group-hover:text-indigo-700 flex-1 truncate">
                  {email}
                </span>
                <Plus size={13} className="text-slate-300 group-hover:text-indigo-500 shrink-0" />
              </button>
            ))}
          </div>
        </div>
      )}

      {available.length === 0 && connectedEmails.length === 0 && (
        <p className="text-[11px] text-slate-400 italic px-1">
          No Gmail accounts connected by company members yet.
        </p>
      )}
    </div>
  );
}