// app/public/documents/[pageId]/page.tsx
// GENUINELY UNAUTHENTICATED client-facing document-fill page. Unlike
// app/public/tasks/[pageId]/page.tsx (which requires a signed-in session), this page
// is for external clients/customers who have NO account in this system — so there are
// NO supabase.auth calls anywhere in this file or the API routes it talks to. Access
// is gated purely server-side by the page being active + unexpired.
"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useParams } from "next/navigation";
import { Loader2, FileText, Download, Check, FileArchive, Lock, Ban, Layers } from "lucide-react";
import { renderMarkdown } from "@/lib/renderMarkdown";

interface Field {
  tagKey: string;
  label: string;
  fieldType: "text" | "date" | "number" | "currency" | "select" | "multiselect";
  selectOptions: string[] | null;
  isRequired: boolean;
  autoFilled: boolean;
  isDefault: boolean;
  isRestored: boolean;
  value: string;
  triggerTagKey: string | null;
  triggerValue: string | null;
}
interface DocumentInfo { id: string; name: string; description: string | null; fieldTagKeys: string[]; }
interface PageData { title: string; heading: string; requiresCode: boolean; documents: DocumentInfo[]; fields: Field[]; naFields?: string[]; }
interface GeneratedFile { name: string; url: string; }
interface ResultBatch { label: string; files: GeneratedFile[]; zipUrl: string | null }

// Caches a verified access code per page in localStorage so a returning
// client isn't asked to re-enter it every visit. Scoped by pageId, cleared
// automatically the moment a cached code is ever rejected (e.g. the admin
// changed it) — never trusted blindly, always re-verified against the
// server on load. Wrapped in try/catch for privacy-mode browsers where
// localStorage access can throw.
const codeCacheKey = (pageId: string) => `docfill_code_${pageId}`;
function getCachedCode(pageId: string): string | null {
  try { return localStorage.getItem(codeCacheKey(pageId)); } catch { return null; }
}
function setCachedCode(pageId: string, code: string) {
  try { localStorage.setItem(codeCacheKey(pageId), code); } catch { /* ignore */ }
}
function clearCachedCode(pageId: string) {
  try { localStorage.removeItem(codeCacheKey(pageId)); } catch { /* ignore */ }
}

// Which fields currently satisfy their trigger (if any) and should render.
// Fields with no trigger are always visible. A triggered field needs its
// trigger to itself be visible, answered (a value, or explicitly marked N/A),
// and — if triggerValue is set — the trigger's answer to include at least
// one of triggerValue's "||"-separated allowed values (a single value is
// just the one-element case). Recursive with a cache + in-progress guard so
// a chain (or an accidental cycle) resolves once and a cycle just falls back
// to "not visible" rather than infinite-looping.
function computeVisibleTagKeys(fields: Field[], values: Record<string, string>, naFields: Set<string>): Set<string> {
  const byTagKey = new Map(fields.map(f => [f.tagKey, f]));
  const cache = new Map<string, boolean>();
  const inProgress = new Set<string>();
  function visible(tagKey: string): boolean {
    if (cache.has(tagKey)) return cache.get(tagKey)!;
    if (inProgress.has(tagKey)) return false;
    inProgress.add(tagKey);
    const f = byTagKey.get(tagKey);
    let result = true;
    if (f?.triggerTagKey) {
      const parentAnswered = naFields.has(f.triggerTagKey) || !!(values[f.triggerTagKey] || "").trim();
      const answered = (values[f.triggerTagKey] || "").split(", ").filter(Boolean);
      const allowed = f.triggerValue == null ? null : f.triggerValue.split("||");
      const parentValueOk = allowed == null ? true : answered.some(v => allowed.includes(v));
      result = visible(f.triggerTagKey) && parentAnswered && parentValueOk;
    }
    inProgress.delete(tagKey);
    cache.set(tagKey, result);
    return result;
  }
  return new Set(fields.filter(f => visible(f.tagKey)).map(f => f.tagKey));
}

export default function PublicDocumentFillPage() {
  const params = useParams();
  const pageId = params.pageId as string;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<PageData | null>(null);
  const [needsCode, setNeedsCode] = useState(false);
  const [codeInput, setCodeInput] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [checkingCode, setCheckingCode] = useState(false);
  const [verifiedCode, setVerifiedCode] = useState<string | null>(null);
  const [activeDocId, setActiveDocId] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [naFields, setNaFields] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState<"all" | string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [results, setResults] = useState<ResultBatch[]>([]);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");

  const fetchPage = useCallback(async (code?: string) => {
    const url = code
      ? `/api/document-templates/public/${pageId}?code=${encodeURIComponent(code)}`
      : `/api/document-templates/public/${pageId}`;
    const res = await fetch(url);
    const json = await res.json();
    return { ok: res.ok, json };
  }, [pageId]);

  const applyLoadedData = (json: PageData) => {
    setData(json);
    setActiveDocId(json.documents?.[0]?.id ?? null);
    const initial: Record<string, string> = {};
    (json.fields || []).forEach((f: Field) => { initial[f.tagKey] = f.value || ""; });
    setValues(initial);
    // Restores which fields the client had previously marked "Not
    // applicable" in a saved draft — the answered VALUES themselves are
    // already folded into each field's `value` above (see the GET route),
    // but N/A is a separate flag with no value of its own to carry it.
    setNaFields(new Set(json.naFields || []));
  };

  const load = useCallback(async () => {
    setLoading(true);
    const cachedCode = getCachedCode(pageId);

    // Try a cached code first (if we have one) so a returning client skips
    // straight to the form. If the server rejects it — wrong, or the admin
    // changed/removed the code — fall through to a normal, code-less load
    // instead of getting stuck on a bad cached value.
    if (cachedCode) {
      const cachedAttempt = await fetchPage(cachedCode);
      if (cachedAttempt.ok && !cachedAttempt.json.requiresCode) {
        setVerifiedCode(cachedCode);
        applyLoadedData(cachedAttempt.json);
        setLoading(false);
        return;
      }
      clearCachedCode(pageId);
    }

    const { ok, json } = await fetchPage();
    if (!ok) { setError(json.error || "This page is not available"); setLoading(false); return; }
    if (json.requiresCode) {
      setData(json);
      setNeedsCode(true);
      setLoading(false);
      return;
    }
    applyLoadedData(json);
    setLoading(false);
  }, [fetchPage, pageId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (data?.heading) document.title = data.heading;
  }, [data?.heading]);

  const handleCodeSubmit = async () => {
    if (!codeInput.trim()) return;
    setCheckingCode(true);
    setCodeError(null);
    const code = codeInput.trim();
    const { ok, json } = await fetchPage(code);
    setCheckingCode(false);
    if (!ok) { setCodeError(json.error || "Incorrect access code"); return; }
    setVerifiedCode(code);
    setCachedCode(pageId, code);
    setNeedsCode(false);
    applyLoadedData(json);
  };

  const setValue = (tagKey: string, v: string) => setValues(prev => ({ ...prev, [tagKey]: v }));

  const toggleNa = (tagKey: string) => {
    setNaFields(prev => {
      const next = new Set(prev);
      if (next.has(tagKey)) next.delete(tagKey);
      else next.add(tagKey);
      return next;
    });
    setValue(tagKey, "");
  };

  // Global (not tab-scoped, since values/naFields are shared across tabs) —
  // which fields currently satisfy their trigger, if they have one.
  const visibleTagKeys = useMemo(
    () => computeVisibleTagKeys(data?.fields ?? [], values, naFields),
    [data?.fields, values, naFields]
  );

  // Clears a triggered field's stale value/N/A the moment it drops OUT of
  // visibleTagKeys (e.g. the client changes an earlier answer so a branch no
  // longer applies) — otherwise a stale answer could silently survive into a
  // generated document even though its field is no longer shown. Only fires
  // on a genuine visible→hidden transition (tracked via prevVisibleRef) —
  // NOT on initial load, when every not-yet-answered gated field starts out
  // hidden with a pre-filled default/auto-filled value that hasn't been
  // shown to the client yet and must survive until its trigger is answered.
  const prevVisibleRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!data) return;
    const prevVisible = prevVisibleRef.current;
    prevVisibleRef.current = visibleTagKeys;
    if (!prevVisible) return;
    const stale = data.fields.filter(f =>
      f.triggerTagKey && prevVisible.has(f.tagKey) && !visibleTagKeys.has(f.tagKey)
      && ((values[f.tagKey] ?? "") !== "" || naFields.has(f.tagKey))
    );
    if (!stale.length) return;
    setValues(prev => {
      const next = { ...prev };
      stale.forEach(f => { next[f.tagKey] = ""; });
      return next;
    });
    setNaFields(prev => {
      const next = new Set(prev);
      stale.forEach(f => next.delete(f.tagKey));
      return next;
    });
  }, [data, visibleTagKeys, values, naFields]);

  // Autosaves the client's answers (debounced) so a closed tab or a
  // different device doesn't mean retyping everything — see the draft
  // route. `lastLoadedDataRef` distinguishes "values just changed because a
  // fresh load/reload applied them" (skip — nothing new to save) from an
  // actual edit the client made (save it), without needing a second effect.
  const lastLoadedDataRef = useRef<PageData | null>(null);
  useEffect(() => {
    if (!data || needsCode) return;
    if (lastLoadedDataRef.current !== data) {
      lastLoadedDataRef.current = data;
      return;
    }
    setSaveState("saving");
    const timeout = setTimeout(() => {
      fetch(`/api/document-templates/public/${pageId}/draft`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values, naFields: [...naFields], code: verifiedCode }),
      })
        .then(res => setSaveState(res.ok ? "saved" : "idle"))
        .catch(() => setSaveState("idle"));
    }, 1000);
    return () => clearTimeout(timeout);
  }, [values, naFields, data, needsCode, pageId, verifiedCode]);

  const activeDoc = data?.documents.find(d => d.id === activeDocId) || null;
  const isMultiDoc = (data?.documents.length ?? 0) > 1;
  // With one document there's nothing to scope a tab to — show every field.
  // With several, each tab only shows the fields that document actually uses.
  // Either way, a field with an unmet trigger stays hidden regardless of tab.
  const visibleFields = data
    ? (isMultiDoc && activeDoc ? data.fields.filter(f => activeDoc.fieldTagKeys.includes(f.tagKey)) : data.fields)
      .filter(f => visibleTagKeys.has(f.tagKey))
    : [];

  const missingRequired = (fields: Field[]): string | null => {
    for (const f of fields) {
      if (f.isRequired && !naFields.has(f.tagKey) && !(values[f.tagKey] || "").trim()) {
        return `"${f.label}" is required`;
      }
    }
    return null;
  };

  const submit = async (label: string, templateIds: string[] | undefined, busyKey: "all" | string) => {
    setSubmitting(busyKey);
    setSubmitError(null);
    const res = await fetch(`/api/document-templates/public/${pageId}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values, naFields: [...naFields], code: verifiedCode, templateIds }),
    });
    const json = await res.json();
    setSubmitting(null);
    if (!res.ok) { setSubmitError(json.error || "Failed to generate documents"); return; }
    setResults(prev => [{ label, files: json.files || [], zipUrl: json.zipUrl || null }, ...prev]);
  };

  const handleGenerateAll = async () => {
    if (!data) return;
    const missing = missingRequired(data.fields.filter(f => visibleTagKeys.has(f.tagKey)));
    if (missing) { setSubmitError(missing); return; }
    await submit("All documents", undefined, "all");
  };

  const handleGenerateOne = async () => {
    if (!data || !activeDoc) return;
    const missing = missingRequired(visibleFields);
    if (missing) { setSubmitError(missing); return; }
    await submit(activeDoc.name, [activeDoc.id], activeDoc.id);
  };

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center bg-slate-50"><Loader2 className="animate-spin text-slate-400" /></div>;
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
        <div className="max-w-sm w-full bg-white rounded-[32px] border border-slate-200 p-8 text-center space-y-2">
          <p className="text-[13px] font-bold text-slate-800">This page is not available</p>
          <p className="text-[12px] text-slate-500">The link may have expired or been revoked.</p>
        </div>
      </div>
    );
  }

  if (!data) return null;

  // ── Access-code gate ───────────────────────────────────────────────
  if (needsCode) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
        <div className="max-w-sm w-full bg-white rounded-[32px] border border-slate-200 p-8 text-center space-y-4">
          <Lock size={28} className="text-indigo-600 mx-auto" />
          <div>
            <p className="text-[15px] font-bold text-slate-800">{data.heading}</p>
            <p className="text-[12px] text-slate-500 mt-1">Enter the access code you were given to continue.</p>
          </div>
          <input
            value={codeInput}
            onChange={e => { setCodeInput(e.target.value.toUpperCase()); setCodeError(null); }}
            onKeyDown={e => { if (e.key === "Enter") handleCodeSubmit(); }}
            placeholder="Access code"
            autoFocus
            className="w-full px-4 py-3 border border-slate-200 rounded-full text-[14px] font-bold tracking-wider text-center outline-none focus:border-indigo-400" />
          {codeError && <p className="text-[11px] text-red-500">{codeError}</p>}
          <button onClick={handleCodeSubmit} disabled={checkingCode || !codeInput.trim()}
            className="w-full py-3 bg-indigo-600 text-white text-[12px] font-bold rounded-full hover:bg-indigo-700 disabled:opacity-40 transition-colors flex items-center justify-center gap-2">
            {checkingCode ? <Loader2 size={14} className="animate-spin" /> : "Continue"}
          </button>
        </div>
      </div>
    );
  }

  // ── Fill form ────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6">
      <div className="max-w-lg mx-auto space-y-4">
        <div>
          <div className="flex items-center gap-2">
            <FileText size={18} className="text-indigo-600" />
            <h1 className="text-[16px] font-bold text-slate-800 flex-1">{data.heading}</h1>
            {saveState !== "idle" && (
              <span className="flex items-center gap-1 text-[10px] text-slate-400 shrink-0">
                {saveState === "saving"
                  ? <><Loader2 size={10} className="animate-spin" /> Saving...</>
                  : <><Check size={10} className="text-emerald-500" /> Answers saved</>}
              </span>
            )}
          </div>
          {data.title && data.title !== data.heading && (
            <p className="text-[11px] text-slate-400 mt-0.5 ml-[26px]">{data.title}</p>
          )}
        </div>

        {/* Per-document tabs — only shown when more than one document is bundled */}
        {isMultiDoc && (
          <div className="flex items-center gap-1.5 flex-wrap">
            {data.documents.map(d => (
              <button key={d.id} onClick={() => setActiveDocId(d.id)}
                className={`px-3.5 py-2 rounded-full text-[11px] font-bold transition-colors ${
                  activeDocId === d.id ? "bg-slate-900 text-white" : "bg-white border border-slate-200 text-slate-500 hover:border-slate-300"
                }`}>
                {d.name}
              </button>
            ))}
          </div>
        )}

        {activeDoc?.description && (
          <div className="bg-white rounded-[24px] border border-slate-200 p-6 sm:p-8 space-y-4">
            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">About this document</p>
            <div className="text-[12px] text-slate-500 prose-sm [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4 [&_a]:text-indigo-600 [&_a]:underline"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(activeDoc.description) }} />
          </div>
        )}

        <div className="bg-white rounded-[24px] border border-slate-200 p-6 sm:p-8 space-y-5">
          {visibleFields.length === 0 && (
            <p className="text-center text-slate-300 text-[11px] uppercase font-bold tracking-widest py-8">No fields to fill</p>
          )}
          {visibleFields.map(f => {
            const isNa = naFields.has(f.tagKey);
            return (
              <div key={f.tagKey}>
                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">
                    {f.label}{f.isRequired && !isNa && <span className="text-indigo-500"> *</span>}
                    {f.autoFilled && !isNa && <span className="ml-2 text-slate-300 normal-case font-medium tracking-normal">pre-filled</span>}
                    {f.isDefault && !isNa && <span className="ml-2 text-slate-300 normal-case font-medium tracking-normal">default</span>}
                    {f.isRestored && !isNa && <span className="ml-2 text-emerald-500 normal-case font-medium tracking-normal">restored from your last visit</span>}
                  </p>
                  <button type="button" onClick={() => toggleNa(f.tagKey)}
                    className={`shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[9px] font-bold uppercase tracking-widest transition-colors ${
                      isNa ? "bg-slate-700 text-white" : "bg-slate-50 text-slate-400 hover:bg-slate-100"
                    }`}>
                    <Ban size={10} /> N/A
                  </button>
                </div>
                {isNa ? (
                  <div className="w-full px-4 py-2.5 border border-dashed border-slate-200 rounded-full text-[13px] text-slate-400 italic">
                    Not applicable — will be left blank
                  </div>
                ) : f.fieldType === "select" && Array.isArray(f.selectOptions) ? (
                  <select value={values[f.tagKey] || ""} onChange={e => setValue(f.tagKey, e.target.value)}
                    className="w-full px-4 py-2.5 border border-slate-200 rounded-full text-[13px] outline-none bg-white focus:border-indigo-400">
                    <option value="">— Select —</option>
                    {f.selectOptions.map((opt, i) => <option key={i} value={opt}>{opt}</option>)}
                  </select>
                ) : f.fieldType === "multiselect" && Array.isArray(f.selectOptions) ? (
                  <div className="flex flex-wrap gap-2">
                    {f.selectOptions.map((opt, i) => {
                      const selected = (values[f.tagKey] || "").split(", ").filter(Boolean).includes(opt);
                      return (
                        <label key={i}
                          className={`flex items-center gap-2 px-3 py-2 rounded-full border text-[12px] cursor-pointer transition-colors ${
                            selected ? "border-indigo-400 bg-indigo-50 text-indigo-700" : "border-slate-200 text-slate-600 hover:border-slate-300"
                          }`}>
                          <input type="checkbox" checked={selected} className="accent-indigo-600" onChange={() => {
                            const current = (values[f.tagKey] || "").split(", ").filter(Boolean);
                            const next = selected ? current.filter(o => o !== opt) : [...current, opt];
                            setValue(f.tagKey, next.join(", "));
                          }} />
                          {opt}
                        </label>
                      );
                    })}
                  </div>
                ) : (
                  <input
                    type={f.fieldType === "date" ? "date" : f.fieldType === "number" || f.fieldType === "currency" ? "number" : "text"}
                    value={values[f.tagKey] || ""}
                    onChange={e => setValue(f.tagKey, e.target.value)}
                    placeholder={f.fieldType === "currency" ? "0.00" : `Enter ${f.label.toLowerCase()}...`}
                    className="w-full px-4 py-2.5 border border-slate-200 rounded-full text-[13px] outline-none focus:border-indigo-400" />
                )}
              </div>
            );
          })}

          {submitError && <p className="text-[11px] text-red-500">{submitError}</p>}
        </div>

        <div className="flex flex-col sm:flex-row gap-2">
          {isMultiDoc && (
            <button onClick={handleGenerateOne} disabled={submitting !== null || !activeDoc}
              className="flex-1 py-3.5 bg-white border border-slate-300 text-slate-700 text-[12px] font-bold rounded-full hover:border-indigo-300 disabled:opacity-40 transition-colors flex items-center justify-center gap-2">
              {submitting === activeDocId
                ? <><Loader2 size={14} className="animate-spin" /> Generating...</>
                : <>Generate this document only</>}
            </button>
          )}
          <button onClick={handleGenerateAll} disabled={submitting !== null || data.fields.length === 0}
            className="flex-1 py-3.5 bg-indigo-600 text-white text-[12px] font-bold rounded-full hover:bg-indigo-700 disabled:opacity-40 transition-colors flex items-center justify-center gap-2">
            {submitting === "all"
              ? <><Loader2 size={14} className="animate-spin" /> Generating...</>
              : isMultiDoc ? <><Layers size={14} /> Generate all documents</> : <>Generate document</>}
          </button>
        </div>

        {/* Generated files accumulate here so the client can keep switching
            tabs and generating other documents without losing earlier results. */}
        {results.length > 0 && (
          <div className="space-y-3">
            {results.map((r, ri) => (
              <div key={ri} className="bg-white rounded-[24px] border border-emerald-200 p-6 space-y-3">
                <div className="flex items-center gap-2">
                  <Check size={16} className="text-emerald-500 shrink-0" />
                  <p className="text-[12px] font-bold text-slate-800">{r.label} — ready</p>
                </div>
                <div className="space-y-2">
                  {r.files.map((f, i) => (
                    <a key={i} href={f.url} target="_blank" rel="noopener noreferrer" download
                      className="flex items-center gap-3 px-4 py-3 border border-slate-200 rounded-2xl hover:border-indigo-300 transition-colors">
                      <FileText size={16} className="text-indigo-600 shrink-0" />
                      <span className="text-[12px] font-medium text-slate-700 flex-1 truncate">{f.name}</span>
                      <Download size={14} className="text-slate-400 shrink-0" />
                    </a>
                  ))}
                </div>
                {r.zipUrl && (
                  <a href={r.zipUrl} target="_blank" rel="noopener noreferrer" download
                    className="w-full py-2.5 bg-slate-900 text-white text-[11px] font-bold rounded-full hover:bg-slate-700 flex items-center justify-center gap-2">
                    <FileArchive size={13} /> Download all as .zip
                  </a>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
