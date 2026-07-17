// components/dashboard/tabs/DocumentTemplatesTab.tsx
// Admin-facing tab (rendered inside a project). Upload .docx mail-merge templates,
// label/type each detected {{tag}} and optionally bind it to a project custom field
// for auto-fill, then generate shareable unauthenticated client-fill links.
"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  Loader2, Upload, FileText, Plus, Copy, Check, Trash2, ExternalLink, X, Link2, Lock, RefreshCw, Bold, Italic, List,
  ChevronUp, ChevronDown,
} from "lucide-react";

interface TemplateField {
  id: string;
  tag_key: string;
  label: string;
  field_type: "text" | "date" | "number" | "currency" | "select" | "multiselect";
  select_options: string[] | null;
  is_required: boolean;
  auto_fill_field_id: string | null;
  default_value: string | null;
  joined_to_field_id: string | null;
  display_order: number;
}
// A field annotated with which document it came from — used to offer
// "join with..." candidates from OTHER uploaded documents in this project,
// which is the whole point (preventing the client re-entering the same
// answer once per document).
interface FlatField extends TemplateField { templateId: string; templateName: string; }
interface Template {
  id: string;
  name: string;
  description: string | null;
  download_filename: string | null;
  storage_path: string;
  created_at: string;
  fields: TemplateField[];
}
interface FillPage {
  id: string;
  title: string;
  clientName: string | null;
  expiresAt: string | null;
  isActive: boolean;
  accessCode: string | null;
  createdAt: string;
  templateIds: string[];
}

function randomCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I — easy to read aloud
  let out = "";
  for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
interface CustomField { id: string; field_key: string; label: string; field_type: string; }

interface Props { recordId: string; companyId: string; }

const FIELD_TYPES: TemplateField["field_type"][] = ["text", "date", "number", "currency", "select", "multiselect"];
const FIELD_TYPE_LABELS: Record<TemplateField["field_type"], string> = {
  text: "text", date: "date", number: "number", currency: "currency",
  select: "dropdown (one choice)", multiselect: "checkboxes (multiple choices)",
};

function defaultExpiry(): string {
  const d = new Date();
  d.setDate(d.getDate() + 30);
  return d.toISOString().slice(0, 10);
}

export default function DocumentTemplatesTab({ recordId }: Props) {
  const [loading, setLoading] = useState(true);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [pages, setPages] = useState<FillPage[]>([]);
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/document-templates/list?projectId=${recordId}`);
    const json = await res.json();
    setTemplates(json.templates || []);
    setPages(json.pages || []);
    setCustomFields(json.customFields || []);
    setLoading(false);
  }, [recordId]);

  useEffect(() => { load(); }, [load]);

  const uploadOne = async (file: File): Promise<string | null> => {
    const lower = file.name.toLowerCase();
    if (!lower.endsWith(".docx") && !lower.endsWith(".doc")) {
      return `"${file.name}": please upload a .docx or .doc file.`;
    }
    const form = new FormData();
    form.append("file", file);
    form.append("projectId", recordId);
    form.append("name", file.name.replace(/\.docx?$/i, ""));
    const res = await fetch("/api/document-templates/upload", { method: "POST", body: form });
    const json = await res.json();
    if (!res.ok) return `"${file.name}": ${json.error || "upload failed"}`;
    return null;
  };

  // Uploads sequentially (not in parallel) — the .doc -> .docx conversion
  // step shells out to a single-threaded LibreOffice instance server-side,
  // so parallel uploads would just queue up behind each other anyway.
  const handleFiles = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length) return;
    setUploadError(null);
    setUploading(true);
    setUploadProgress({ done: 0, total: list.length });
    const errors: string[] = [];
    for (let i = 0; i < list.length; i++) {
      const err = await uploadOne(list[i]);
      if (err) errors.push(err);
      setUploadProgress({ done: i + 1, total: list.length });
    }
    setUploading(false);
    setUploadProgress(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (errors.length) setUploadError(errors.join(" · "));
    load();
  };

  const handleRevoke = async (id: string) => {
    if (!window.confirm("Revoke this link? It will stop working immediately.")) return;
    await fetch(`/api/document-templates/${id}/revoke`, { method: "PATCH" });
    load();
  };

  const handleDeleteTemplate = async (id: string) => {
    if (!window.confirm("Delete this template? Any client links that include it will drop it from their document set.")) return;
    await fetch(`/api/document-templates/${id}`, { method: "DELETE" });
    load();
  };

  const copyLink = (id: string) => {
    const url = `${window.location.origin}/public/documents/${id}`;
    navigator.clipboard.writeText(url);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  const allFields: FlatField[] = templates.flatMap(t =>
    t.fields.map(f => ({ ...f, templateId: t.id, templateName: t.name }))
  );

  if (loading) return <div className="flex justify-center p-20"><Loader2 className="animate-spin text-slate-300" /></div>;

  return (
    <div className="space-y-8 animate-in fade-in p-1">
      {/* Upload */}
      <div>
        <p className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-3">Templates</p>
        <input ref={fileInputRef} type="file" accept=".docx,.doc" multiple className="hidden"
          onChange={e => { const f = e.target.files; if (f && f.length) handleFiles(f); }} />
        <button onClick={() => fileInputRef.current?.click()} disabled={uploading}
          className="flex items-center gap-2 px-5 py-3 bg-indigo-600 text-white text-[11px] font-bold rounded-full hover:bg-indigo-700 disabled:opacity-40 transition-colors">
          {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
          {uploading && uploadProgress ? `Uploading ${uploadProgress.done}/${uploadProgress.total}...` : "Upload Word templates"}
        </button>
        <p className="text-[10px] text-slate-400 mt-2">
          Word documents (.docx or .doc) with <code className="text-indigo-500">{"{{tag}}"}</code> mail-merge placeholders. Tags are detected automatically. Older .doc files are converted automatically. You can select multiple files at once.
        </p>
        {uploadError && <p className="text-[11px] text-red-500 mt-2">{uploadError}</p>}
      </div>

      {/* Template list */}
      <div className="space-y-4">
        {templates.length === 0 && (
          <p className="text-center text-slate-300 text-[11px] uppercase font-bold tracking-widest p-8">No templates yet</p>
        )}
        {templates.map(t => (
          <TemplateCard key={t.id} template={t} customFields={customFields} onSaved={load} onDelete={() => handleDeleteTemplate(t.id)} />
        ))}
      </div>

      {/* Client links */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <p className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">Client links</p>
          <button onClick={() => setShowCreate(true)} disabled={templates.length === 0}
            className="flex items-center gap-2 px-4 py-2 bg-slate-900 text-white text-[11px] font-bold rounded-full hover:bg-slate-700 disabled:opacity-40 transition-colors">
            <Link2 size={13} /> Generate client link
          </button>
        </div>
        <div className="space-y-3">
          {pages.length === 0 && (
            <p className="text-center text-slate-300 text-[11px] uppercase font-bold tracking-widest p-8">No links yet</p>
          )}
          {pages.map(p => (
            <div key={p.id} className="flex items-center gap-4 p-5 bg-white border border-slate-200 rounded-[24px]">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-[13px] font-bold text-slate-800">{p.title}{p.clientName ? ` — ${p.clientName}` : ""}</p>
                  <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold uppercase ${p.isActive ? "bg-emerald-50 text-emerald-600" : "bg-slate-100 text-slate-400"}`}>
                    {p.isActive ? "Active" : "Revoked"}
                  </span>
                </div>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  {p.templateIds.length} document{p.templateIds.length !== 1 ? "s" : ""}
                  {p.expiresAt ? ` · expires ${new Date(p.expiresAt).toLocaleDateString()}` : " · no expiry"}
                  {p.accessCode && (
                    <span className="inline-flex items-center gap-1 ml-1">
                      · <Lock size={9} className="inline" /> code: <code className="text-slate-500 font-bold">{p.accessCode}</code>
                    </span>
                  )}
                </p>
              </div>
              {p.isActive && (
                <>
                  <button onClick={() => copyLink(p.id)} title="Copy link"
                    className="p-2 text-slate-400 hover:text-indigo-600 transition-colors shrink-0">
                    {copiedId === p.id ? <Check size={15} className="text-emerald-500" /> : <Copy size={15} />}
                  </button>
                  <a href={`/public/documents/${p.id}`} target="_blank" rel="noopener noreferrer" title="Open"
                    className="p-2 text-slate-400 hover:text-indigo-600 transition-colors shrink-0">
                    <ExternalLink size={15} />
                  </a>
                  <button onClick={() => handleRevoke(p.id)} title="Revoke"
                    className="p-2 text-slate-400 hover:text-red-500 transition-colors shrink-0">
                    <Trash2 size={15} />
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      </div>

      {showCreate && (
        <CreateLinkModal
          projectId={recordId}
          templates={templates}
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); load(); }}
        />
      )}
    </div>
  );
}

// ── Template card with editable fields ──────────────────────────────
function TemplateCard({ template, customFields, onSaved, onDelete }: {
  template: Template; customFields: CustomField[]; onSaved: () => void; onDelete: () => void;
}) {
  const [fields, setFields] = useState<TemplateField[]>(template.fields);
  const [description, setDescription] = useState(template.description || "");
  const [downloadFilename, setDownloadFilename] = useState(template.download_filename || template.name);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);

  // Wraps the current selection in markdown syntax (or inserts a
  // placeholder if nothing's selected), matching the toolbar buttons below.
  const wrapDescriptionSelection = (before: string, after: string, placeholder: string) => {
    const el = descriptionRef.current;
    if (!el) return;
    const start = el.selectionStart ?? description.length;
    const end = el.selectionEnd ?? description.length;
    const selected = description.slice(start, end) || placeholder;
    const next = description.slice(0, start) + before + selected + after + description.slice(end);
    setDescription(next);
    requestAnimationFrame(() => {
      el.focus();
      const cursor = start + before.length + selected.length + after.length;
      el.setSelectionRange(cursor, cursor);
    });
  };

  useEffect(() => { setFields(template.fields); }, [template.fields]);
  useEffect(() => { setDescription(template.description || ""); }, [template.description]);
  useEffect(() => { setDownloadFilename(template.download_filename || template.name); }, [template.download_filename, template.name]);

  const update = (id: string, patch: Partial<TemplateField>) =>
    setFields(prev => prev.map(f => f.id === id ? { ...f, ...patch } : f));

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    const [fieldsRes] = await Promise.all([
      fetch(`/api/document-templates/${template.id}/fields`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fields: fields.map(f => ({
            id: f.id, tag_key: f.tag_key, label: f.label, field_type: f.field_type,
            select_options: (f.field_type === "select" || f.field_type === "multiselect")
              ? (Array.isArray(f.select_options) ? f.select_options : String(f.select_options || "").split(",").map(s => s.trim()).filter(Boolean))
              : null,
            is_required: f.is_required, auto_fill_field_id: f.auto_fill_field_id, default_value: f.default_value,
          })),
        }),
      }),
      fetch(`/api/document-templates/${template.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description,
          // Blank input just means "use the template name" — send null
          // rather than persisting a redundant copy of the name.
          download_filename: downloadFilename.trim() === template.name.trim() ? null : downloadFilename,
        }),
      }),
    ]);
    setSaving(false);
    if (fieldsRes.ok) { setSaved(true); setTimeout(() => setSaved(false), 1500); onSaved(); }
  };

  return (
    <div className="bg-white border border-slate-200 rounded-[24px] p-6">
      <div className="flex items-center gap-2 mb-4">
        <FileText size={16} className="text-indigo-600 shrink-0" />
        <p className="text-[13px] font-bold text-slate-800 flex-1 truncate">{template.name}</p>
        <span className="text-[10px] text-slate-400">{fields.length} tag{fields.length !== 1 ? "s" : ""}</span>
        <button onClick={onDelete} title="Delete template" className="p-1.5 text-slate-300 hover:text-red-500 transition-colors shrink-0">
          <Trash2 size={14} />
        </button>
      </div>

      <div className="mb-4">
        <div className="flex items-center justify-between mb-1.5">
          <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">
            Explanation for the client <span className="text-slate-300 normal-case font-normal">(optional, shown on the client link)</span>
          </p>
          <div className="flex items-center gap-1">
            <button type="button" title="Bold" onClick={() => wrapDescriptionSelection("**", "**", "bold text")}
              className="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-slate-50 rounded-lg transition-colors"><Bold size={12} /></button>
            <button type="button" title="Italic" onClick={() => wrapDescriptionSelection("*", "*", "italic text")}
              className="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-slate-50 rounded-lg transition-colors"><Italic size={12} /></button>
            <button type="button" title="Bullet list" onClick={() => wrapDescriptionSelection("\n- ", "", "list item")}
              className="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-slate-50 rounded-lg transition-colors"><List size={12} /></button>
          </div>
        </div>
        <textarea ref={descriptionRef} value={description} onChange={e => setDescription(e.target.value)} rows={3}
          placeholder="e.g. This is the loan agreement between the company and the shareholder..."
          className="w-full px-4 py-2.5 border border-slate-200 rounded-2xl text-[12px] outline-none focus:border-indigo-400 resize-none" />
        <p className="text-[9px] text-slate-300 mt-1">Supports basic formatting: **bold**, *italic*, - bullet lists, [links](https://...)</p>
      </div>

      <div className="mb-4">
        <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">
          Download file name <span className="text-slate-300 normal-case font-normal">(defaults to the document's name)</span>
        </p>
        <div className="flex items-center gap-2">
          <input value={downloadFilename} onChange={e => setDownloadFilename(e.target.value)}
            className="flex-1 px-4 py-2.5 border border-slate-200 rounded-full text-[12px] outline-none focus:border-indigo-400" />
          <span className="text-[11px] text-slate-400 shrink-0">.docx</span>
        </div>
      </div>

      {fields.length === 0 ? (
        <p className="text-[11px] text-slate-300 italic mb-3">No {"{{tags}}"} detected in this document.</p>
      ) : (
        <div className="space-y-3 mb-3">
          {fields.map(f => (
            <div key={f.id} className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-center">
              <code className="sm:col-span-2 text-[11px] text-indigo-500 truncate">{`{{${f.tag_key}}}`}</code>
              <input value={f.label} onChange={e => update(f.id, { label: e.target.value })}
                placeholder="Label"
                className="sm:col-span-3 px-3 py-2 border border-slate-200 rounded-full text-[12px] outline-none focus:border-indigo-400" />
              <select value={f.field_type} onChange={e => update(f.id, { field_type: e.target.value as TemplateField["field_type"] })}
                className="sm:col-span-2 px-3 py-2 border border-slate-200 rounded-full text-[12px] outline-none bg-white">
                {FIELD_TYPES.map(t => <option key={t} value={t}>{FIELD_TYPE_LABELS[t]}</option>)}
              </select>
              <select value={f.auto_fill_field_id || ""} onChange={e => update(f.id, { auto_fill_field_id: e.target.value || null })}
                className="sm:col-span-3 px-3 py-2 border border-slate-200 rounded-full text-[12px] outline-none bg-white">
                <option value="">No auto-fill</option>
                {customFields.map(cf => <option key={cf.id} value={cf.id}>Auto: {cf.label}</option>)}
              </select>
              <label className="sm:col-span-2 flex items-center gap-1.5 text-[11px] text-slate-500 cursor-pointer">
                <input type="checkbox" checked={f.is_required} onChange={e => update(f.id, { is_required: e.target.checked })} />
                Required
              </label>
              {(f.field_type === "select" || f.field_type === "multiselect") && (
                <input
                  value={Array.isArray(f.select_options) ? f.select_options.join(", ") : (f.select_options || "")}
                  onChange={e => update(f.id, { select_options: e.target.value as any })}
                  placeholder="Options (comma-separated)"
                  className="sm:col-span-12 px-3 py-2 border border-slate-200 rounded-full text-[12px] outline-none focus:border-indigo-400" />
              )}
              {!f.auto_fill_field_id && (
                <input
                  value={f.default_value || ""}
                  onChange={e => update(f.id, { default_value: e.target.value })}
                  placeholder="Default value if the client leaves this blank (optional)"
                  className="sm:col-span-12 px-3 py-2 border border-dashed border-slate-200 rounded-full text-[12px] outline-none focus:border-indigo-400" />
              )}
            </div>
          ))}
        </div>
      )}

      <div className="flex justify-end pt-2">
        <button onClick={handleSave} disabled={saving}
          className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-[11px] font-bold rounded-full hover:bg-indigo-700 disabled:opacity-40 transition-colors">
          {saving ? <Loader2 size={13} className="animate-spin" /> : saved ? <Check size={13} /> : null}
          {saved ? "Saved" : "Save"}
        </button>
      </div>
    </div>
  );
}

// ── Generate client link modal ──────────────────────────────────────
function CreateLinkModal({ projectId, templates, onClose, onCreated }: {
  projectId: string; templates: Template[]; onClose: () => void; onCreated: () => void;
}) {
  const [title, setTitle] = useState("");
  const [clientName, setClientName] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>(templates.length === 1 ? [templates[0].id] : []);
  const [noExpiry, setNoExpiry] = useState(false);
  const [expiresAt, setExpiresAt] = useState(defaultExpiry());
  const [requireCode, setRequireCode] = useState(false);
  const [accessCode, setAccessCode] = useState(randomCode());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);
  const [createdCode, setCreatedCode] = useState<string | null>(null);

  const toggle = (id: string) => setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);

  const handleCreate = async () => {
    if (!title.trim()) { setError("Title is required"); return; }
    if (selectedIds.length === 0) { setError("Select at least one template"); return; }
    if (requireCode && !accessCode.trim()) { setError("Enter an access code, or turn the toggle off"); return; }
    setSaving(true);
    setError(null);
    const res = await fetch("/api/document-templates/create-page", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title, projectId, templateIds: selectedIds,
        expiresAt: noExpiry ? null : expiresAt,
        accessCode: requireCode ? accessCode.trim() : null,
        clientName: clientName.trim() || null,
      }),
    });
    const json = await res.json();
    setSaving(false);
    if (!res.ok) { setError(json.error || "Failed to create link"); return; }
    setCreatedUrl(`${window.location.origin}/public/documents/${json.pageId}`);
    setCreatedCode(requireCode ? accessCode.trim() : null);
  };

  if (createdUrl) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm">
        <div className="bg-white rounded-[32px] shadow-2xl w-full max-w-md mx-4 p-8 text-center space-y-4">
          <Check size={32} className="text-emerald-500 mx-auto" />
          <p className="text-[14px] font-bold text-slate-800">Link created</p>
          <div className="px-4 py-3 bg-slate-50 rounded-2xl">
            <code className="text-[11px] text-slate-600 break-all">{createdUrl}</code>
          </div>
          <button onClick={() => navigator.clipboard.writeText(createdUrl)}
            className="w-full py-3 bg-slate-900 text-white text-[12px] font-bold rounded-full hover:bg-slate-700 flex items-center justify-center gap-2">
            <Copy size={13} /> Copy link
          </button>
          {createdCode && (
            <div className="px-4 py-3 bg-amber-50 border border-amber-200 rounded-2xl text-left">
              <p className="text-[9px] font-bold text-amber-700 uppercase tracking-widest mb-1">Access code</p>
              <p className="text-[11px] text-amber-800">
                Share this <code className="font-bold">{createdCode}</code> code with the client through a different
                channel than the link (e.g. a phone call or separate email) so a copy of the link alone isn't enough.
              </p>
            </div>
          )}
          <button onClick={onCreated} className="w-full py-3 border border-slate-200 text-slate-600 text-[12px] font-bold rounded-full hover:bg-slate-50">
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/30 backdrop-blur-sm" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-white rounded-t-[32px] sm:rounded-[32px] shadow-2xl w-full max-w-lg mx-0 sm:mx-4 max-h-[90vh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-8 pt-8 pb-4 border-b border-slate-100 shrink-0">
          <h3 className="text-[14px] font-bold text-slate-800 uppercase tracking-wide">Generate client link</h3>
          <button onClick={onClose} className="p-2 text-slate-300 hover:text-slate-700"><X size={16} /></button>
        </div>
        <div className="flex-1 overflow-y-auto px-8 py-6 space-y-5">
          <div>
            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">Title</p>
            <input value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Sale contract pack"
              className="w-full px-4 py-2.5 border border-slate-200 rounded-full text-[13px] outline-none focus:border-indigo-400" />
          </div>

          <div>
            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">
              Client name <span className="text-slate-300 normal-case font-normal">(optional, shown in the page title)</span>
            </p>
            <input value={clientName} onChange={e => setClientName(e.target.value)} placeholder="e.g. John Smith"
              className="w-full px-4 py-2.5 border border-slate-200 rounded-full text-[13px] outline-none focus:border-indigo-400" />
          </div>

          <div>
            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-2">Documents to include</p>
            <div className="space-y-2">
              {templates.map(t => (
                <label key={t.id} className="flex items-center gap-3 p-3 border border-slate-200 rounded-2xl cursor-pointer has-[:checked]:border-indigo-400 has-[:checked]:bg-indigo-50">
                  <input type="checkbox" checked={selectedIds.includes(t.id)} onChange={() => toggle(t.id)} />
                  <span className="text-[12px] text-slate-700 flex-1 truncate">{t.name}</span>
                  <span className="text-[10px] text-slate-400">{t.fields.length} tags</span>
                </label>
              ))}
            </div>
          </div>

          <div>
            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">Expiry date <span className="text-indigo-500 normal-case font-normal">(strongly recommended)</span></p>
            <input type="date" value={expiresAt} onChange={e => setExpiresAt(e.target.value)} disabled={noExpiry}
              className="w-full px-4 py-2.5 border border-slate-200 rounded-full text-[13px] outline-none disabled:opacity-40" />
            <label className="flex items-center gap-2 mt-2 cursor-pointer">
              <input type="checkbox" checked={noExpiry} onChange={e => setNoExpiry(e.target.checked)} />
              <span className="text-[11px] text-slate-500">No expiry (not recommended)</span>
            </label>
          </div>

          <div>
            <label className="flex items-center gap-2 cursor-pointer mb-2">
              <input type="checkbox" checked={requireCode} onChange={e => setRequireCode(e.target.checked)} />
              <span className="text-[12px] text-slate-700 font-medium flex items-center gap-1.5">
                <Lock size={12} className="text-slate-400" /> Require an access code
              </span>
            </label>
            {requireCode && (
              <div className="flex items-center gap-2">
                <input value={accessCode} onChange={e => setAccessCode(e.target.value.toUpperCase())}
                  placeholder="e.g. ABC123"
                  className="flex-1 px-4 py-2.5 border border-slate-200 rounded-full text-[13px] font-bold tracking-wider outline-none focus:border-indigo-400" />
                <button type="button" onClick={() => setAccessCode(randomCode())} title="Generate a new code"
                  className="p-2.5 border border-slate-200 rounded-full text-slate-400 hover:text-indigo-600 hover:border-indigo-300 transition-colors">
                  <RefreshCw size={14} />
                </button>
              </div>
            )}
            <p className="text-[10px] text-slate-400 mt-1.5">
              The client must enter this code before they can view or submit the form — share it separately from the link itself.
            </p>
          </div>

          {error && <p className="text-[11px] text-red-500">{error}</p>}
        </div>
        <div className="px-8 py-5 border-t border-slate-100 shrink-0">
          <button onClick={handleCreate} disabled={saving}
            className="w-full py-3 bg-indigo-600 text-white text-[12px] font-bold rounded-full hover:bg-indigo-700 disabled:opacity-40 transition-colors flex items-center justify-center gap-2">
            {saving ? <><Loader2 size={14} className="animate-spin" /> Creating...</> : <><Plus size={14} /> Create link</>}
          </button>
        </div>
      </div>
    </div>
  );
}
