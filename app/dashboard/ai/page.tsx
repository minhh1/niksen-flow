// app/dashboard/ai/page.tsx
// Chat UI for the RAG assistant grounded in this company's CRM/Gmail/
// WhatsApp/Teams data (see app/api/ai/chat/route.ts). Data sources and the
// self-hosted Ollama URL are configured in Admin -> AI Assistant
// (components/admin/AdminAiAssistantTab.tsx).
//
// Conversations are personal (not shared with teammates) and persisted via
// supabase/ai_conversations.sql + ai_messages.sql -- see
// app/api/ai/conversations for the list/load/delete endpoints. The
// conversation id is generated client-side (crypto.randomUUID()) so the
// first message in a new chat can create the row inline in
// app/api/ai/chat/route.ts rather than needing a separate create call.
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Sparkles, Send, Loader2, AlertTriangle, Plus, Trash2, MessageSquare } from "lucide-react";

interface Model {
  id: string;
  label: string;
  provider: "hosted" | "self_hosted";
  contextWindow?: number;
}

interface Citation {
  sourceType: string;
  sourceUrl: string | null;
  snippet: string;
}

interface Message {
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
}

interface Usage {
  tokensUsed: number;
  tokenCap: number;
  estimatedCostUsd: number;
  periodEnd: string;
}

interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
}

export default function AiAssistantPage() {
  const [models, setModels] = useState<Model[]>([]);
  const [modelId, setModelId] = useState<string>("");
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retrievalWarning, setRetrievalWarning] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const loadModels = useCallback(async () => {
    const res = await fetch("/api/ai/models");
    const json = await res.json();
    setModels(json.models ?? []);
    if (json.models?.length && !modelId) setModelId(json.models[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadUsage = useCallback(async () => {
    const res = await fetch("/api/ai/usage");
    if (!res.ok) return;
    setUsage(await res.json());
  }, []);

  const loadConversations = useCallback(async () => {
    const res = await fetch("/api/ai/conversations");
    if (!res.ok) return;
    const json = await res.json();
    setConversations(json.conversations ?? []);
  }, []);

  useEffect(() => {
    loadModels();
    loadUsage();
    loadConversations();
  }, [loadModels, loadUsage, loadConversations]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const capReached = usage ? usage.tokensUsed >= usage.tokenCap : false;

  const startNewChat = () => {
    setConversationId(null);
    setMessages([]);
    setError(null);
    setRetrievalWarning(null);
  };

  const openConversation = async (id: string) => {
    setConversationId(id);
    setError(null);
    setRetrievalWarning(null);
    const res = await fetch(`/api/ai/conversations/${id}`);
    if (!res.ok) return;
    const json = await res.json();
    setMessages(
      (json.messages ?? []).map((m: { role: "user" | "assistant"; content: string; citations?: Citation[] }) => ({
        role: m.role,
        content: m.content,
        citations: m.citations ?? undefined,
      }))
    );
  };

  const deleteConversation = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm("Delete this conversation?")) return;
    await fetch(`/api/ai/conversations/${id}`, { method: "DELETE" });
    if (conversationId === id) startNewChat();
    loadConversations();
  };

  const send = async () => {
    const question = input.trim();
    if (!question || sending || capReached) return;
    const selected = models.find((m) => m.id === modelId);
    if (!selected) return;

    const activeConversationId = conversationId ?? crypto.randomUUID();
    if (!conversationId) setConversationId(activeConversationId);

    setError(null);
    setRetrievalWarning(null);
    setInput("");
    const history = messages.map((m) => ({ role: m.role, content: m.content }));
    setMessages((prev) => [...prev, { role: "user", content: question }, { role: "assistant", content: "" }]);
    setSending(true);

    try {
      const res = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, modelId, provider: selected.provider, history, conversationId: activeConversationId }),
      });
      if (!res.ok || !res.body) throw new Error((await res.json().catch(() => null))?.error || "Request failed");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const evt = JSON.parse(line);
          if (evt.citations) {
            setMessages((prev) => {
              const next = [...prev];
              next[next.length - 1] = { ...next[next.length - 1], citations: evt.citations };
              return next;
            });
          }
          if (evt.delta) {
            setMessages((prev) => {
              const next = [...prev];
              next[next.length - 1] = { ...next[next.length - 1], content: next[next.length - 1].content + evt.delta };
              return next;
            });
          }
          if (evt.retrievalError) setRetrievalWarning(evt.retrievalError);
          if (evt.error) setError(evt.error);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSending(false);
      loadUsage();
      loadConversations();
    }
  };

  return (
    <div className="flex h-screen bg-[#F9FAFB] font-sans antialiased text-slate-600 overflow-hidden">
      {/* Conversation list */}
      <div className="w-64 shrink-0 bg-white border-r border-slate-100 flex flex-col">
        <div className="p-4 border-b border-slate-100">
          <button
            onClick={startNewChat}
            className="w-full flex items-center justify-center gap-1.5 px-4 py-2.5 bg-indigo-600 text-white text-[12px] font-bold rounded-full hover:bg-indigo-700 transition-colors"
          >
            <Plus size={13} /> New chat
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {conversations.map((c) => (
            <div
              key={c.id}
              onClick={() => openConversation(c.id)}
              className={`group flex items-center gap-2 px-3 py-2.5 rounded-2xl cursor-pointer transition-colors ${
                conversationId === c.id ? "bg-indigo-50 text-indigo-700" : "hover:bg-slate-50 text-slate-600"
              }`}
            >
              <MessageSquare size={13} className="shrink-0 opacity-60" />
              <p className="text-[12px] font-medium truncate flex-1">{c.title}</p>
              <button
                onClick={(e) => deleteConversation(c.id, e)}
                className="p-1 text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all shrink-0"
              >
                <Trash2 size={11} />
              </button>
            </div>
          ))}
          {conversations.length === 0 && <p className="text-[11px] text-slate-300 text-center py-8">No conversations yet</p>}
        </div>
      </div>

      {/* Chat */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <header className="bg-white border-b border-slate-100 shrink-0 px-8 py-6">
          <div className="flex items-center justify-between max-w-3xl mx-auto">
            <div className="flex items-center gap-3">
              <div className="h-9 w-9 rounded-2xl bg-indigo-50 flex items-center justify-center">
                <Sparkles size={18} className="text-indigo-600" />
              </div>
              <h1 className="text-2xl font-light uppercase tracking-tight text-slate-900">Ask AI</h1>
            </div>
            <select
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              className="px-3 py-2 border border-slate-200 rounded-full text-[12px] outline-none focus:border-indigo-400"
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>

          {usage && (
            <div className="max-w-3xl mx-auto mt-4">
              <div className="flex items-center justify-between text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">
                <span>
                  {usage.tokensUsed.toLocaleString()} / {usage.tokenCap.toLocaleString()} tokens this period
                </span>
                <span>~${usage.estimatedCostUsd.toFixed(2)} spent</span>
              </div>
              <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full ${capReached ? "bg-red-500" : "bg-indigo-500"}`}
                  style={{ width: `${Math.min(100, (usage.tokensUsed / usage.tokenCap) * 100)}%` }}
                />
              </div>
            </div>
          )}
        </header>

        <main className="flex-1 overflow-y-auto p-8">
          <div className="max-w-3xl mx-auto space-y-4">
            {messages.length === 0 && (
              <p className="text-[12px] text-slate-400 text-center py-12">
                Ask about your CRM records, emails, WhatsApp, or Teams messages.
              </p>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[80%] rounded-[24px] px-5 py-3 text-[13px] whitespace-pre-wrap ${
                    m.role === "user" ? "bg-indigo-600 text-white" : "bg-white border border-slate-200 text-slate-700"
                  }`}
                >
                  {m.content || (sending && i === messages.length - 1 ? "..." : "")}
                  {m.citations && m.citations.length > 0 && (
                    <div className="mt-3 pt-3 border-t border-slate-100 space-y-1">
                      {m.citations.map((c, j) => (
                        <div key={j} className="text-[10px] text-slate-400">
                          [{j + 1}] {c.sourceType}
                          {c.sourceUrl && (
                            <a href={c.sourceUrl} className="ml-1 text-indigo-500 hover:underline">
                              view source
                            </a>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
        </main>

        <footer className="bg-white border-t border-slate-100 shrink-0 px-8 py-6">
          <div className="max-w-3xl mx-auto">
            {retrievalWarning && (
              <p className="flex items-center gap-1.5 text-[11px] text-amber-600 mb-2">
                <AlertTriangle size={12} /> Answered without grounding context -- retrieval failed: {retrievalWarning}
              </p>
            )}
            {error && (
              <p className="flex items-center gap-1.5 text-[11px] text-red-500 mb-2">
                <AlertTriangle size={12} /> {error}
              </p>
            )}
            {capReached && (
              <p className="flex items-center gap-1.5 text-[11px] text-amber-700 bg-amber-50 rounded-2xl px-4 py-2 mb-2">
                <AlertTriangle size={12} /> Monthly token cap reached -- ask a company admin to raise it in Admin → AI Assistant.
              </p>
            )}
            <div className="flex gap-2">
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && send()}
                disabled={capReached}
                placeholder="Ask a question..."
                className="flex-1 px-4 py-3 border border-slate-200 rounded-full text-[13px] outline-none focus:border-indigo-400 disabled:opacity-40"
              />
              <button
                onClick={send}
                disabled={sending || capReached || !input.trim()}
                className="w-11 h-11 flex items-center justify-center bg-indigo-600 text-white rounded-full hover:bg-indigo-700 disabled:opacity-40 transition-colors"
              >
                {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
              </button>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}
