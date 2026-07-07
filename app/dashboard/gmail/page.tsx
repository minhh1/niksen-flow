// app/dashboard/gmail/page.tsx
"use client";

import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import {
  Mail, RefreshCw, Loader2, Search, Tag, Send,
  Inbox, Paperclip, Reply, X, Check,
} from "lucide-react";

interface GmailMessage {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  fromName: string;
  date: string;
  snippet: string;
  hasAttachments: boolean;
  isRead: boolean;
}

interface Project {
  id: string;
  name: string;
  property: { street_address: string } | { street_address: string }[] | null;
}

function getProjectLabel(project: Project): string {
  if (!project.property) return project.name;
  if (Array.isArray(project.property)) {
    return project.property[0]?.street_address || project.name;
  }
  return project.property.street_address || project.name;
}

function formatDate(dateStr: string): string {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
  } catch { return dateStr; }
}

export default function GmailPage() {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [gmailEmail, setGmailEmail] = useState<string | null>(null);
  const [messages, setMessages] = useState<GmailMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedMessage, setSelectedMessage] = useState<GmailMessage | null>(null);
  const [emailBody, setEmailBody] = useState<string | null>(null);
  const [loadingBody, setLoadingBody] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [search, setSearch] = useState('');
  const [activeFilter, setActiveFilter] = useState('in:inbox');
  const [assignedMap, setAssignedMap] = useState<Record<string, string>>({});
  const [assigning, setAssigning] = useState<string | null>(null);
  const [showCompose, setShowCompose] = useState(false);
  const [composeTo, setComposeTo] = useState('');
  const [composeSubject, setComposeSubject] = useState('');
  const [composeBody, setComposeBody] = useState('');
  const [sending, setSending] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    checkConnection();
    loadProjects();
    loadAssignments();
  }, []);

  const checkConnection = async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data } = await supabase
      .from('user_gmail_tokens')
      .select('email')
      .eq('user_id', user.id)
      .single();
    setConnected(!!data);
    if (data?.email) setGmailEmail(data.email);
    if (data) fetchMessages('in:inbox');
    else setLoading(false);
  };

  const fetchMessages = useCallback(async (query: string) => {
    setLoading(true);
    setActiveFilter(query);
    setFetchError(null);
    try {
      const res = await fetch(`/api/gmail/messages?q=${encodeURIComponent(query)}`);
      const data = await res.json();
      if (data.error) {
        console.error('Gmail API error:', data.error);
        setFetchError(data.error);
        setMessages([]);
      } else {
        setMessages(data.messages || []);
      }
    } catch (err: any) {
      console.error('fetchMessages error:', err);
      setFetchError(err?.message || 'Failed to load emails');
      setMessages([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadProjects = async () => {
    const { data } = await supabase
      .from('projects')
      .select('id, name, property:property_id(street_address)')
      .is('deleted_at', null)
      .order('created_at', { ascending: false });
    setProjects((data as Project[]) || []);
  };

  const loadAssignments = async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data } = await supabase
      .from('project_emails')
      .select('gmail_message_id, project_id')
      .eq('user_id', user.id);
    const map: Record<string, string> = {};
    (data || []).forEach(r => { map[r.gmail_message_id] = r.project_id; });
    setAssignedMap(map);
  };

  const handleSelectMessage = async (msg: GmailMessage) => {
    setSelectedMessage(msg);
    setEmailBody(null);
    setLoadingBody(true);
    try {
      const res = await fetch(`/api/gmail/messages/${msg.id}`);
      const data = await res.json();
      setEmailBody(data.body || null);
    } catch { setEmailBody(null); }
    finally { setLoadingBody(false); }
  };

  const handleAssign = async (messageId: string, projectId: string) => {
    if (!selectedMessage) return;
    setAssigning(messageId);
    const project = projects.find(p => p.id === projectId);
    try {
      await fetch('/api/gmail/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageId,
          threadId: selectedMessage.threadId,
          projectId,
          projectName: project ? getProjectLabel(project) : '',
          subject: selectedMessage.subject,
          from: selectedMessage.from,
          fromName: selectedMessage.fromName,
          date: selectedMessage.date,
          snippet: selectedMessage.snippet,
        }),
      });
      setAssignedMap(prev => ({ ...prev, [messageId]: projectId }));
    } catch (err) { console.error('handleAssign:', err); }
    finally { setAssigning(null); }
  };

  const handleSend = async () => {
    if (!composeTo || !composeSubject || !composeBody) return;
    setSending(true);
    try {
      await fetch('/api/gmail/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: composeTo,
          subject: composeSubject,
          body: composeBody,
          threadId: selectedMessage?.threadId,
        }),
      });
      setShowCompose(false);
      setComposeTo(''); setComposeSubject(''); setComposeBody('');
    } catch (err) { console.error('handleSend:', err); }
    finally { setSending(false); }
  };

  const handleReply = () => {
    if (!selectedMessage) return;
    setComposeTo(selectedMessage.from);
    setComposeSubject(
      selectedMessage.subject.startsWith('Re:')
        ? selectedMessage.subject
        : `Re: ${selectedMessage.subject}`
    );
    setShowCompose(true);
  };

  const filteredMessages = messages.filter(m => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      m.subject.toLowerCase().includes(q) ||
      m.fromName.toLowerCase().includes(q) ||
      m.from.toLowerCase().includes(q) ||
      m.snippet.toLowerCase().includes(q)
    );
  });

  // ── Not connected ─────────────────────────────────────────────────
  if (connected === false) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-[#F9FAFB] font-sans">
        <div className="bg-white border border-slate-200 rounded-[40px] p-12 max-w-md w-full mx-4 text-center shadow-sm">
          <div className="w-16 h-16 bg-red-50 rounded-full flex items-center justify-center mx-auto mb-5">
            <Mail size={28} className="text-red-500" />
          </div>
          <h2 className="text-2xl font-light uppercase tracking-tight text-slate-900 mb-3">
            Connect Gmail
          </h2>
          <p className="text-[13px] text-slate-500 mb-8 leading-relaxed">
            Connect your Gmail account to view emails, assign them to projects,
            and sync project labels back to Gmail.
          </p>
          <button
            onClick={() => { window.location.href = '/api/gmail/auth'; }}
            className="flex items-center justify-center gap-3 w-full py-4 bg-slate-900 text-white rounded-full font-bold text-[13px] hover:bg-slate-700 transition-all"
          >
            Connect with Google
          </button>
          <p className="text-[10px] text-slate-400 mt-4">
            We only request access to read, label, and send emails.
            We never store your email content.
          </p>
        </div>
      </div>
    );
  }

  if (connected === null) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Loader2 className="animate-spin text-slate-300" size={24} />
      </div>
    );
  }

  const FILTERS = [
    { label: 'Inbox',    q: 'in:inbox' },
    { label: 'Unread',   q: 'is:unread in:inbox' },
    { label: 'Sent',     q: 'in:sent' },
    { label: 'Starred',  q: 'is:starred' },
    { label: 'niksen/*', q: 'label:niksen' },
  ];

  return (
    <div className="flex flex-col h-screen bg-[#F9FAFB] font-sans antialiased overflow-hidden">

      {/* Header */}
      <header className="bg-white border-b border-slate-100 shrink-0 px-8 pt-8 pb-4">
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-4">
            <div className="h-10 w-10 rounded-2xl bg-red-50 flex items-center justify-center">
              <Mail size={20} className="text-red-500" />
            </div>
            <div>
              <h1 className="text-2xl font-light uppercase tracking-tight text-slate-900">Gmail</h1>
              {gmailEmail && (
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-0.5">
                  {gmailEmail}
                </p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => fetchMessages(activeFilter)}
              disabled={loading}
              className="p-2 bg-slate-50 border border-slate-200 rounded-full hover:bg-slate-100 transition-all text-slate-500 disabled:opacity-50"
            >
              <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
            </button>
            <button
              onClick={() => setShowCompose(true)}
              className="flex items-center gap-2 px-5 py-2 bg-slate-900 text-white rounded-full text-[11px] font-bold"
            >
              <Send size={13} /> Compose
            </button>
          </div>
        </div>

        <div className="relative mb-4">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-300" size={16} />
          <input
            placeholder="Search emails..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && search) fetchMessages(search); }}
            className="w-full bg-slate-50 border border-slate-100 rounded-2xl py-3 pl-11 pr-4 text-sm font-medium outline-none focus:ring-4 focus:ring-black/5"
          />
        </div>

        <div className="flex gap-2 flex-wrap">
          {FILTERS.map(f => (
            <button
              key={f.q}
              onClick={() => fetchMessages(f.q)}
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
      </header>

      {/* Main */}
      <div className="flex flex-1 min-h-0 overflow-hidden">

        {/* Email list */}
        <div className={`flex flex-col bg-white border-r border-slate-100 overflow-hidden transition-all ${
          selectedMessage ? 'w-80 shrink-0' : 'flex-1'
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
                onClick={() => fetchMessages('in:inbox')}
                className="text-[10px] text-indigo-600 font-bold hover:underline"
              >
                Try again
              </button>
            </div>
          ) : filteredMessages.length === 0 ? (
            <div className="flex flex-col items-center justify-center flex-1 gap-3">
              <Inbox size={32} className="text-slate-200" />
              <p className="text-[11px] text-slate-300 font-bold uppercase tracking-widest">
                No emails
              </p>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto divide-y divide-slate-50">
              {filteredMessages.map(msg => {
                const assignedProject = projects.find(p => p.id === assignedMap[msg.id]);
                const isSelected = selectedMessage?.id === msg.id;
                return (
                  <button
                    key={msg.id}
                    onClick={() => handleSelectMessage(msg)}
                    className={`w-full text-left px-5 py-4 transition-all hover:bg-indigo-50/30 ${
                      isSelected ? 'bg-indigo-50 border-l-2 border-indigo-500' : 'border-l-2 border-transparent'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2 mb-1">
                      <p className={`text-[13px] truncate ${msg.isRead ? 'text-slate-600 font-medium' : 'font-bold text-slate-900'}`}>
                        {msg.fromName || msg.from}
                      </p>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {msg.hasAttachments && <Paperclip size={11} className="text-slate-400" />}
                        <p className="text-[10px] text-slate-400">{formatDate(msg.date)}</p>
                      </div>
                    </div>
                    <p className={`text-[12px] truncate mb-1 ${msg.isRead ? 'text-slate-500' : 'font-medium text-slate-800'}`}>
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
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Email detail */}
        {selectedMessage && (
          <div className="flex-1 flex flex-col min-h-0 overflow-hidden bg-white">
            <div className="p-6 border-b border-slate-100 shrink-0">
              <div className="flex items-start justify-between gap-4 mb-4">
                <h2 className="text-xl font-light text-slate-900 flex-1 min-w-0 truncate">
                  {selectedMessage.subject}
                </h2>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={handleReply}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-full text-[10px] font-bold text-slate-600 hover:bg-slate-100 transition-all"
                  >
                    <Reply size={12} /> Reply
                  </button>
                  <button
                    onClick={() => { setSelectedMessage(null); setEmailBody(null); }}
                    className="p-1.5 text-slate-300 hover:text-slate-700 transition-colors"
                  >
                    <X size={16} />
                  </button>
                </div>
              </div>

              <div className="flex items-center gap-3 text-[12px] text-slate-500 mb-4">
                <div className="h-8 w-8 rounded-full bg-indigo-100 flex items-center justify-center text-[11px] font-bold text-indigo-600 uppercase shrink-0">
                  {selectedMessage.fromName?.charAt(0) || '?'}
                </div>
                <div className="flex-1 min-w-0">
                  <span className="font-medium text-slate-700">{selectedMessage.fromName}</span>
                  <span className="text-slate-400 ml-1.5">{'<'}{selectedMessage.from}{'>'}</span>
                </div>
                <span className="text-slate-400 shrink-0 text-[11px]">
                  {new Date(selectedMessage.date).toLocaleString('en-AU', {
                    day: 'numeric', month: 'short', year: 'numeric',
                    hour: '2-digit', minute: '2-digit',
                  })}
                </span>
              </div>

              <div className="flex items-center gap-3">
                <Tag size={14} className="text-slate-400 shrink-0" />
                <select
                  value={assignedMap[selectedMessage.id] || ''}
                  onChange={e => { if (e.target.value) handleAssign(selectedMessage.id, e.target.value); }}
                  disabled={assigning === selectedMessage.id}
                  className="flex-1 bg-slate-50 border border-slate-200 rounded-full py-2 px-4 text-[12px] font-medium outline-none appearance-none disabled:opacity-60"
                >
                  <option value="">Assign to project...</option>
                  {projects.map(p => (
                    <option key={p.id} value={p.id}>{getProjectLabel(p)}</option>
                  ))}
                </select>
                {assigning === selectedMessage.id && (
                  <Loader2 size={14} className="animate-spin text-slate-400 shrink-0" />
                )}
                {assignedMap[selectedMessage.id] && assigning !== selectedMessage.id && (
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Check size={13} className="text-emerald-500" />
                    <span className="text-[10px] font-bold text-emerald-600">Labelled in Gmail</span>
                  </div>
                )}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto">
              {loadingBody ? (
                <div className="flex items-center justify-center h-full">
                  <Loader2 className="animate-spin text-slate-300" size={20} />
                </div>
              ) : emailBody ? (
                <iframe
                  srcDoc={emailBody}
                  className="w-full h-full border-0"
                  sandbox="allow-same-origin"
                  title="Email content"
                />
              ) : (
                <div className="flex items-center justify-center h-full">
                  <p className="text-[12px] text-slate-300 italic">Could not load email body</p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Compose */}
      {showCompose && (
        <div className="fixed inset-0 z-50 flex items-end justify-end p-6 pointer-events-none">
          <div className="bg-white border border-slate-200 rounded-[32px] shadow-2xl w-full max-w-lg pointer-events-auto flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
              <p className="text-[13px] font-bold text-slate-800">New message</p>
              <button onClick={() => setShowCompose(false)} className="p-1.5 text-slate-300 hover:text-black">
                <X size={16} />
              </button>
            </div>
            <div className="p-5 space-y-3">
              <input
                value={composeTo}
                onChange={e => setComposeTo(e.target.value)}
                placeholder="To"
                type="email"
                className="w-full bg-slate-50 border border-slate-200 rounded-full py-2.5 px-4 text-[13px] font-medium outline-none focus:ring-2 focus:ring-indigo-100"
              />
              <input
                value={composeSubject}
                onChange={e => setComposeSubject(e.target.value)}
                placeholder="Subject"
                className="w-full bg-slate-50 border border-slate-200 rounded-full py-2.5 px-4 text-[13px] font-medium outline-none focus:ring-2 focus:ring-indigo-100"
              />
              <textarea
                value={composeBody}
                onChange={e => setComposeBody(e.target.value)}
                placeholder="Write your message..."
                rows={8}
                className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-3 px-4 text-[13px] font-medium outline-none focus:ring-2 focus:ring-indigo-100 resize-none"
              />
              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  onClick={() => setShowCompose(false)}
                  className="px-4 py-2 text-[11px] font-bold text-slate-400 hover:text-slate-700"
                >
                  Discard
                </button>
                <button
                  onClick={handleSend}
                  disabled={sending || !composeTo.trim() || !composeSubject.trim() || !composeBody.trim()}
                  className="flex items-center gap-2 px-5 py-2.5 bg-slate-900 text-white rounded-full text-[11px] font-bold disabled:opacity-40"
                >
                  {sending ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
                  Send
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}