// components/gmail/GmailHeader.tsx
"use client";

import { RefreshCw, Send, Settings, Search, Mail } from "lucide-react";
import { GMAIL_FILTERS } from "@/lib/gmail/types";

interface Props {
  gmailEmail: string | null;
  loading: boolean;
  syncing: boolean;
  lastSynced: Date | null;
  activeFilter: string;
  search: string;
  showActivityLog: boolean;
  onSearch: (q: string) => void;
  onFilter: (q: string) => void;
  onRefresh: () => void;
  onSync: () => void;
  onCompose: () => void;
  onLabelSettings: () => void;
  onToggleActivityLog: () => void;
  onDisconnect: () => void;
}

export default function GmailHeader({
  gmailEmail, loading, syncing, lastSynced, activeFilter,
  search, showActivityLog,
  onSearch, onFilter, onRefresh, onSync, onCompose,
  onLabelSettings, onToggleActivityLog, onDisconnect
}: Props) {
  return (
    <header className="bg-white border-b border-slate-100 shrink-0 px-8 pt-8 pb-4">
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-4">
          <div className="h-10 w-10 rounded-2xl bg-red-50 flex items-center justify-center shrink-0">
            <Mail size={20} className="text-red-500" />
          </div>
          <div>
            <h1 className="text-2xl font-light uppercase tracking-tight text-slate-900">
              Gmail
            </h1>
            {gmailEmail && (
              <div className="flex items-center gap-3 mt-0.5">
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                  {gmailEmail}
                </p>
                <button
                  onClick={onDisconnect}
                  className="text-[9px] font-bold text-slate-300 hover:text-red-500 transition-colors uppercase tracking-widest"
                >
                  × Disconnect
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {lastSynced && (
            <p className="text-[10px] text-slate-400">
              Synced {lastSynced.toLocaleTimeString('en-AU', {
                hour: '2-digit', minute: '2-digit',
              })}
            </p>
          )}
          <button
            onClick={onSync}
            disabled={syncing}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-full text-[10px] font-bold text-slate-500 hover:border-indigo-300 hover:text-indigo-600 transition-all disabled:opacity-50"
          >
            <RefreshCw size={12} className={syncing ? 'animate-spin' : ''} />
            {syncing ? 'Syncing...' : 'Sync'}
          </button>
          <button
            onClick={onLabelSettings}
            className="p-2 bg-slate-50 border border-slate-200 rounded-full hover:bg-slate-100 transition-all text-slate-500"
            title="Label settings"
          >
            <Settings size={16} />
          </button>
          <button
            onClick={onRefresh}
            disabled={loading}
            className="p-2 bg-slate-50 border border-slate-200 rounded-full hover:bg-slate-100 transition-all text-slate-500 disabled:opacity-50"
          >
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={onCompose}
            className="flex items-center gap-2 px-5 py-2 bg-slate-900 text-white rounded-full text-[11px] font-bold"
          >
            <Send size={13} /> Compose
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="relative mb-4">
        <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-300" size={16} />
        <input
          placeholder="Search emails..."
          value={search}
          onChange={e => onSearch(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && search) onFilter(search); }}
          className="w-full bg-slate-50 border border-slate-100 rounded-2xl py-3 pl-11 pr-4 text-sm font-medium outline-none focus:ring-4 focus:ring-black/5"
        />
      </div>

      {/* Filter chips + view toggle */}
      <div className="flex items-center justify-between">
        <div className="flex gap-2 flex-wrap">
          {GMAIL_FILTERS.map(f => (
            <button
              key={f.q}
              onClick={() => onFilter(f.q)}
              className={`px-3 py-1.5 rounded-full text-[10px] font-bold transition-all ${
                activeFilter === f.q
                  ? 'bg-slate-900 text-white'
                  : 'bg-white border border-slate-200 text-slate-500 hover:border-indigo-300 hover:text-indigo-600'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <button
          onClick={onToggleActivityLog}
          className={`px-3 py-1.5 rounded-full text-[10px] font-bold transition-all ${
            showActivityLog
              ? 'bg-slate-900 text-white'
              : 'bg-white border border-slate-200 text-slate-500 hover:border-indigo-300'
          }`}
        >
          {showActivityLog ? 'Back to inbox' : 'Activity log'}
        </button>
      </div>
    </header>
  );
}
