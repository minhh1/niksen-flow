// components/gmail/SyncLog.tsx
"use client";

import { useState, useEffect } from "react";
import { supabase } from "@/lib/supabase";
import { Loader2, RotateCcw, RefreshCw, Tag, User, Mail, AlertTriangle } from "lucide-react";

interface SyncLogEntry {
  id: string;
  action: string;
  gmail_label_name: string | null;
  gmail_message_id: string | null;
  project_id: string | null;
  target_user_id: string | null;
  triggered_by: string | null;
  details: any;
  reversed_at: string | null;
  reversed_by: string | null;
  created_at: string;
  // Joined
  project_name?: string;
  target_user_name?: string;
  triggered_by_name?: string;
}

const ACTION_CONFIG: Record<string, { label: string; color: string }> = {
  label_applied:        { label: 'Label applied',      color: 'bg-indigo-100 text-indigo-700' },
  label_removed:        { label: 'Label removed',      color: 'bg-red-100 text-red-600' },
  sync_to_user:         { label: 'Synced to user',     color: 'bg-emerald-100 text-emerald-700' },
  label_created:        { label: 'Label created',      color: 'bg-blue-100 text-blue-700' },
  gmail_label_detected: { label: 'Detected in Gmail',  color: 'bg-amber-100 text-amber-700' },
  gmail_sync:           { label: 'Gmail synced',       color: 'bg-slate-100 text-slate-600' },
  label_reversed:       { label: 'Reversed',           color: 'bg-slate-100 text-slate-500' },
};

export default function SyncLog({ isAdmin }: { isAdmin: boolean }) {
  const [logs, setLogs] = useState<SyncLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reversing, setReversing] = useState<string | null>(null);

  const loadLogs = async () => {
    setLoading(true);
    setError(null);

    try {
      // Fetch logs — simple query without joins to avoid RLS issues
      const { data: rawLogs, error: logsError } = await supabase
        .from('gmail_sync_log')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(200);

      if (logsError) {
        console.error('SyncLog error:', logsError);
        setError(logsError.message);
        setLoading(false);
        return;
      }

      if (!rawLogs?.length) {
        setLogs([]);
        setLoading(false);
        return;
      }

      // Resolve project names
      const projectIds = [...new Set(rawLogs.map(l => l.project_id).filter(Boolean))];
      const userIds = [...new Set([
        ...rawLogs.map(l => l.target_user_id),
        ...rawLogs.map(l => l.triggered_by),
      ].filter(Boolean))];

      const [projectsRes, profilesRes] = await Promise.all([
        projectIds.length
          ? supabase.from('projects').select('id, name').in('id', projectIds)
          : Promise.resolve({ data: [] }),
        userIds.length
          ? supabase.from('profiles').select('id, full_name').in('id', userIds)
          : Promise.resolve({ data: [] }),
      ]);

      const projectMap = new Map<string, string>();
      (projectsRes.data || []).forEach((p: any) => projectMap.set(p.id, p.name));

      const profileMap = new Map<string, string>();
      (profilesRes.data || []).forEach((p: any) => profileMap.set(p.id, p.full_name || p.id));

      const enriched: SyncLogEntry[] = rawLogs.map(log => ({
        ...log,
        project_name: log.project_id ? projectMap.get(log.project_id) : undefined,
        target_user_name: log.target_user_id ? profileMap.get(log.target_user_id) : undefined,
        triggered_by_name: log.triggered_by ? profileMap.get(log.triggered_by) : undefined,
      }));

      setLogs(enriched);
    } catch (err: any) {
      setError(err.message || 'Failed to load logs');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadLogs(); }, []);

  const handleReverse = async (log: SyncLogEntry) => {
    if (!isAdmin) return;
    if (!window.confirm('Remove this label from all users in Gmail?')) return;
    setReversing(log.id);
    try {
      await fetch('/api/gmail/remove-label', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageId: log.gmail_message_id,
          projectId: log.project_id,
          logId: log.id,
        }),
      });
      await loadLogs();
    } catch (err) {
      console.error('Reverse error:', err);
    } finally {
      setReversing(null);
    }
  };

  if (loading) return (
    <div className="flex justify-center py-20">
      <Loader2 className="animate-spin text-slate-300" size={20} />
    </div>
  );

  if (error) return (
    <div className="flex flex-col items-center justify-center py-20 gap-3">
      <AlertTriangle size={24} className="text-red-400" />
      <p className="text-[11px] text-red-500 font-bold uppercase tracking-widest text-center">
        {error}
      </p>
      <button
        onClick={loadLogs}
        className="text-[10px] text-indigo-600 font-bold hover:underline"
      >
        Try again
      </button>
    </div>
  );

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
          {logs.length} events
        </p>
        <button
          onClick={loadLogs}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-full text-[10px] font-bold text-slate-500 hover:border-indigo-300 hover:text-indigo-600 transition-all"
        >
          <RefreshCw size={11} /> Refresh
        </button>
      </div>

      {logs.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 gap-3">
          <p className="text-[11px] text-slate-300 font-bold uppercase tracking-widest">
            No activity yet
          </p>
          <p className="text-[11px] text-slate-400 text-center max-w-xs">
            Label assignments and removals will appear here
          </p>
        </div>
      ) : (
        logs.map(log => {
          const cfg = ACTION_CONFIG[log.action] || {
            label: log.action.replace(/_/g, ' '),
            color: 'bg-slate-100 text-slate-600',
          };
          const isReversed = !!log.reversed_at;
          const canReverse = isAdmin &&
            ['label_applied', 'sync_to_user', 'gmail_label_detected'].includes(log.action) &&
            !isReversed &&
            !!log.gmail_message_id;

          return (
            <div
              key={log.id}
              className={`flex items-start gap-4 p-4 bg-white border rounded-2xl transition-all ${
                isReversed ? 'border-slate-100 opacity-60' : 'border-slate-100 hover:border-slate-200'
              }`}
            >
              {/* Action badge */}
              <span className={`px-2.5 py-1 rounded-full text-[9px] font-bold uppercase shrink-0 mt-0.5 ${cfg.color}`}>
                {cfg.label}
              </span>

              {/* Details */}
              <div className="flex-1 min-w-0 space-y-1">
                {/* Project */}
                {log.project_name && (
                  <p className="text-[13px] font-bold text-slate-800 truncate">
                    {log.project_name}
                  </p>
                )}

                {/* Label name */}
                {log.gmail_label_name && (
                  <div className="flex items-center gap-1.5">
                    <Tag size={10} className="text-indigo-400 shrink-0" />
                    <span className="text-[10px] text-indigo-600 font-mono bg-indigo-50 px-2 py-0.5 rounded-full truncate">
                      {log.gmail_label_name}
                    </span>
                  </div>
                )}

                {/* Target user */}
                {log.target_user_name && (
                  <div className="flex items-center gap-1.5">
                    <User size={10} className="text-slate-400 shrink-0" />
                    <span className="text-[10px] text-slate-500">
                      {log.target_user_name}
                    </span>
                  </div>
                )}

                {/* Email subject from details */}
                {log.details?.subject && (
                  <div className="flex items-center gap-1.5">
                    <Mail size={10} className="text-slate-400 shrink-0" />
                    <span className="text-[10px] text-slate-400 truncate">
                      {log.details.subject}
                    </span>
                  </div>
                )}

                {/* Synced to N users */}
                {log.action === 'label_applied' && log.details?.syncedToUsers !== undefined && (
                  <p className="text-[10px] text-slate-400">
                    Synced to {log.details.syncedToUsers} other user{log.details.syncedToUsers !== 1 ? 's' : ''}
                  </p>
                )}

                {/* Triggered by */}
                {log.triggered_by_name && (
                  <p className="text-[9px] text-slate-400">
                    by {log.triggered_by_name}
                  </p>
                )}

                {/* Reversed info */}
                {isReversed && (
                  <p className="text-[9px] text-slate-400 italic">
                    Reversed {new Date(log.reversed_at!).toLocaleString('en-AU', {
                      day: 'numeric', month: 'short',
                      hour: '2-digit', minute: '2-digit',
                    })}
                  </p>
                )}
              </div>

              {/* Timestamp + reverse */}
              <div className="text-right shrink-0 space-y-1">
                <p className="text-[10px] text-slate-400">
                  {new Date(log.created_at).toLocaleDateString('en-AU', {
                    day: 'numeric', month: 'short',
                  })}
                </p>
                <p className="text-[10px] text-slate-400">
                  {new Date(log.created_at).toLocaleTimeString('en-AU', {
                    hour: '2-digit', minute: '2-digit',
                  })}
                </p>
                {canReverse && (
                  <button
                    onClick={() => handleReverse(log)}
                    disabled={reversing === log.id}
                    className="flex items-center gap-1 px-2 py-1 bg-red-50 text-red-500 hover:bg-red-100 rounded-full text-[9px] font-bold transition-all disabled:opacity-50 ml-auto"
                  >
                    {reversing === log.id
                      ? <Loader2 size={9} className="animate-spin" />
                      : <RotateCcw size={9} />
                    }
                    Reverse
                  </button>
                )}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
