// components/gmail/EmailList.tsx
"use client";

import { Loader2, Inbox, Paperclip, Tag } from "lucide-react";
import type { GmailMessage, GmailProject } from "@/lib/gmail/types";
import { getProjectLabel, formatDate } from "@/lib/gmail/types";

interface Props {
  messages: GmailMessage[];
  loading: boolean;
  fetchError: string | null;
  selectedId: string | null;
  assignedMap: Record<string, string>;
  projects: GmailProject[];
  collapsed: boolean;
  onSelect: (msg: GmailMessage) => void;
  onRetry: () => void;
}

export default function EmailList({
  messages, loading, fetchError, selectedId,
  assignedMap, projects, collapsed, onSelect, onRetry,
}: Props) {
  return (
    <div className={`flex flex-col bg-white border-r border-slate-100 overflow-hidden ${
      collapsed ? 'w-80 shrink-0' : 'flex-1'
    }`}>
      {loading ? (
        <div className="flex items-center justify-center flex-1">
          <Loader2 className="animate-spin text-slate-300" size={24} />
        </div>
      ) : fetchError ? (
        <div className="flex flex-col items-center justify-center flex-1 gap-3 p-8">
          <p className="text-[11px] text-red-400 font-bold uppercase tracking-widest text-center">
            {fetchError}
          </p>
          <button
            onClick={onRetry}
            className="text-[10px] text-indigo-600 font-bold hover:underline"
          >
            Try again
          </button>
        </div>
      ) : messages.length === 0 ? (
        <div className="flex flex-col items-center justify-center flex-1 gap-3">
          <Inbox size={32} className="text-slate-200" />
          <p className="text-[11px] text-slate-300 font-bold uppercase tracking-widest">
            No emails
          </p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto divide-y divide-slate-50">
          {messages.map(msg => {
            const assignedProject = projects.find(p => p.id === assignedMap[msg.id]);
            const isSelected = selectedId === msg.id;
            return (
              <button
                key={msg.id}
                onClick={() => onSelect(msg)}
                className={`w-full text-left px-5 py-4 transition-all hover:bg-indigo-50/30 ${
                  isSelected
                    ? 'bg-indigo-50 border-l-2 border-indigo-500'
                    : 'border-l-2 border-transparent'
                }`}
              >
                <div className="flex items-start justify-between gap-2 mb-1">
                  <p className={`text-[13px] truncate ${
                    msg.isRead ? 'text-slate-600 font-medium' : 'font-bold text-slate-900'
                  }`}>
                    {msg.fromName || msg.from}
                  </p>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {msg.hasAttachments && <Paperclip size={11} className="text-slate-400" />}
                    <p className="text-[10px] text-slate-400">{formatDate(msg.date)}</p>
                  </div>
                </div>
                <p className={`text-[12px] truncate mb-1 ${
                  msg.isRead ? 'text-slate-500' : 'font-medium text-slate-800'
                }`}>
                  {msg.subject}
                </p>
                <p className="text-[11px] text-slate-400 truncate">{msg.snippet}</p>
                {assignedProject && (
                  <div className="flex items-center gap-1 mt-2">
                    <Tag size={10} className="text-indigo-500 shrink-0" />
                    <span className="text-[10px] font-bold text-indigo-600 truncate">
                      {getProjectLabel(assignedProject)}
                    </span>
                  </div>
                )}
                {msg.niksenLabels && msg.niksenLabels.length > 0 && (
                  <div className="flex items-center gap-1 mt-1.5 flex-wrap">
                    {msg.niksenLabels.map(label => (
                      <span
                        key={label}
                        className="px-2 py-0.5 bg-indigo-100 text-indigo-700 rounded-full text-[9px] font-bold"
                      >
                        {label}
                      </span>
                    ))}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
