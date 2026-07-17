// app/public/documents/[pageId]/page.tsx
// GENUINELY UNAUTHENTICATED client-facing document-fill page. Unlike
// app/public/tasks/[pageId]/page.tsx (which requires a signed-in session), this page
// is for external clients/customers who have NO account in this system — so there are
// NO supabase.auth calls anywhere in this file or the API routes it talks to. Access
// is gated purely server-side by the page being active + unexpired.
"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams } from "next/navigation";
import { Loader2, FileText, Download, Check, FileArchive, Lock, Ban } from "lucide-react";
import { renderMarkdown } from "@/lib/renderMarkdown";

interface Field {
  tagKey: string;
  label: string;
  fieldType: "text" | "date" | "number" | "currency" | "select" | "multiselect";
  selectOptions: string[] | null;
  isRequired: boolean;
  autoFilled: boolean;
  isDefault: boolean;
  value: string;
}
interface DocumentInfo { id: string; name: string; description: string | null; }
interface PageData { title: string; requiresCode: boolean; documents: DocumentInfo[]; fields: Field[]; }
interface GeneratedFile { name: string; url: string; }

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
  const [values, setValues] = useState<Record<string, string>>({});
  const [naFields, setNaFields] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<{ files: GeneratedFile[]; zipUrl: string | null } | null>(null);

  const fetchPage = useCallback(async (code?: string) => {
    const url = code
      ? `/api/document-templates/public/${pageId}?code=${encodeURIComponent(code)}`
      : `/api/document-templates/public/${pageId}`;
    const res = await fetch(url);
    const json = await res.json();
    return { ok: res.ok, json };
  }, [pageId]);

  const load = useCallback(async () => {
    setLoading(true);
    const { ok, json } = await fetchPage();
    if (!ok) { setError(json.error || "This page is not available"); setLoading(false); return; }
    if (json.requiresCode) {
      setData(json);
      setNeedsCode(true);
      setLoading(false);
      return;
    }
    setData(json);
    const initial: Record<string, string> = {};
    (json.fields || []).forEach((f: Field) => { initial[f.tagKey] = f.value || ""; });
    setValues(initial);
    setLoading(false);
  }, [fetchPage]);

  useEffect(() => { load(); }, [load]);

  const handleCodeSubmit = async () => {
    if (!codeInput.trim()) return;
    setCheckingCode(true);
    setCodeError(null);
    const { ok, json } = await fetchPage(codeInput.trim());
    setCheckingCode(false);
    if (!ok) { setCodeError(json.error || "Incorrect access code"); return; }
    setVerifiedCode(codeInput.trim());
    setData(json);
    setNeedsCode(false);
    const initial: Record<string, string> = {};
    (json.fields || []).forEach((f: Field) => { initial[f.tagKey] = f.value || ""; });
    setValues(initial);
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

  const handleSubmit = async () => {
    if (!data) return;
    for (const f of data.fields) {
      if (f.isRequired && !naFields.has(f.tagKey) && !(values[f.tagKey] || "").trim()) {
        setSubmitError(`"${f.label}" is required`);
        return;
      }
    }
    setSubmitting(true);
    setSubmitError(null);
    const res = await fetch(`/api/document-templates/public/${pageId}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values, naFields: [...naFields], code: verifiedCode }),
    });
    const json = await res.json();
    setSubmitting(false);
    if (!res.ok) { setSubmitError(json.error || "Failed to generate documents"); return; }
    setResult({ files: json.files || [], zipUrl: json.zipUrl || null });
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
            <p className="text-[15px] font-bold text-slate-800">{data.title}</p>
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

  // ── Success — generated files ready to download ──────────────────
  if (result) {
    return (
      <div className="min-h-screen bg-slate-50 p-4 sm:p-6">
        <div className="max-w-lg mx-auto">
          <div className="bg-white rounded-[32px] border border-slate-200 p-8 text-center space-y-5">
            <Check size={32} className="text-emerald-500 mx-auto" />
            <div>
              <p className="text-[15px] font-bold text-slate-800">Documents ready</p>
              <p className="text-[12px] text-slate-500 mt-1">Download your completed document{result.files.length !== 1 ? "s" : ""} below. These links are time-limited.</p>
            </div>
            <div className="space-y-2 text-left">
              {result.files.map((f, i) => (
                <a key={i} href={f.url} target="_blank" rel="noopener noreferrer" download
                  className="flex items-center gap-3 px-4 py-3 border border-slate-200 rounded-2xl hover:border-indigo-300 transition-colors">
                  <FileText size={16} className="text-indigo-600 shrink-0" />
                  <span className="text-[12px] font-medium text-slate-700 flex-1 truncate">{f.name}</span>
                  <Download size={14} className="text-slate-400 shrink-0" />
                </a>
              ))}
            </div>
            {result.zipUrl && (
              <a href={result.zipUrl} target="_blank" rel="noopener noreferrer" download
                className="w-full py-3 bg-slate-900 text-white text-[12px] font-bold rounded-full hover:bg-slate-700 flex items-center justify-center gap-2">
                <FileArchive size={14} /> Download all as .zip
              </a>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── Fill form ────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6">
      <div className="max-w-lg mx-auto space-y-4">
        <div className="flex items-center gap-2">
          <FileText size={18} className="text-indigo-600" />
          <h1 className="text-[16px] font-bold text-slate-800">{data.title}</h1>
        </div>

        {data.documents.some(d => d.description) && (
          <div className="bg-white rounded-[24px] border border-slate-200 p-6 sm:p-8 space-y-4">
            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">
              {data.documents.length > 1 ? "Documents in this pack" : "About this document"}
            </p>
            {data.documents.map(d => (
              <div key={d.id}>
                <p className="text-[13px] font-bold text-slate-700">{d.name}</p>
                {d.description && (
                  <div className="text-[12px] text-slate-500 mt-1 prose-sm [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4 [&_a]:text-indigo-600 [&_a]:underline"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(d.description) }} />
                )}
              </div>
            ))}
          </div>
        )}

        <div className="bg-white rounded-[24px] border border-slate-200 p-6 sm:p-8 space-y-5">
          {data.fields.length === 0 && (
            <p className="text-center text-slate-300 text-[11px] uppercase font-bold tracking-widest py-8">No fields to fill</p>
          )}
          {data.fields.map(f => {
            const isNa = naFields.has(f.tagKey);
            return (
              <div key={f.tagKey}>
                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">
                    {f.label}{f.isRequired && !isNa && <span className="text-indigo-500"> *</span>}
                    {f.autoFilled && !isNa && <span className="ml-2 text-slate-300 normal-case font-medium tracking-normal">pre-filled</span>}
                    {f.isDefault && !isNa && <span className="ml-2 text-slate-300 normal-case font-medium tracking-normal">default</span>}
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

        <button onClick={handleSubmit} disabled={submitting || data.fields.length === 0}
          className="w-full py-3.5 bg-indigo-600 text-white text-[12px] font-bold rounded-full hover:bg-indigo-700 disabled:opacity-40 transition-colors flex items-center justify-center gap-2">
          {submitting ? <><Loader2 size={14} className="animate-spin" /> Generating...</> : <>Generate documents</>}
        </button>
      </div>
    </div>
  );
}
