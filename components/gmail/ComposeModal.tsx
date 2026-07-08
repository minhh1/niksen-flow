// components/gmail/ComposeModal.tsx
"use client";

import { useState } from "react";
import { X, Send, Loader2 } from "lucide-react";

interface Props {
  initialTo?: string;
  initialSubject?: string;
  onSend: (to: string, subject: string, body: string) => Promise<void>;
  onClose: () => void;
}

export default function ComposeModal({ initialTo = '', initialSubject = '', onSend, onClose }: Props) {
  const [to, setTo] = useState(initialTo);
  const [subject, setSubject] = useState(initialSubject);
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);

  const handleSend = async () => {
    if (!to || !subject || !body) return;
    setSending(true);
    try {
      await onSend(to, subject, body);
      onClose();
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-end p-6 pointer-events-none">
      <div className="bg-white border border-slate-200 rounded-[32px] shadow-2xl w-full max-w-lg pointer-events-auto flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
          <p className="text-[13px] font-bold text-slate-800">New message</p>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-300 hover:text-black transition-colors"
          >
            <X size={16} />
          </button>
        </div>
        <div className="p-5 space-y-3">
          <input
            value={to}
            onChange={e => setTo(e.target.value)}
            placeholder="To"
            type="email"
            className="w-full bg-slate-50 border border-slate-200 rounded-full py-2.5 px-4 text-[13px] font-medium outline-none focus:ring-2 focus:ring-indigo-100"
          />
          <input
            value={subject}
            onChange={e => setSubject(e.target.value)}
            placeholder="Subject"
            className="w-full bg-slate-50 border border-slate-200 rounded-full py-2.5 px-4 text-[13px] font-medium outline-none focus:ring-2 focus:ring-indigo-100"
          />
          <textarea
            value={body}
            onChange={e => setBody(e.target.value)}
            placeholder="Write your message..."
            rows={8}
            className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-3 px-4 text-[13px] font-medium outline-none focus:ring-2 focus:ring-indigo-100 resize-none"
          />
          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              onClick={onClose}
              className="px-4 py-2 text-[11px] font-bold text-slate-400 hover:text-slate-700 transition-colors"
            >
              Discard
            </button>
            <button
              onClick={handleSend}
              disabled={sending || !to.trim() || !subject.trim() || !body.trim()}
              className="flex items-center gap-2 px-5 py-2.5 bg-slate-900 text-white rounded-full text-[11px] font-bold disabled:opacity-40 hover:bg-black transition-all"
            >
              {sending ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
