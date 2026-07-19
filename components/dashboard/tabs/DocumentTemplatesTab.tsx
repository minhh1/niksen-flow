// components/dashboard/tabs/DocumentTemplatesTab.tsx
// Admin-facing tab (rendered inside a project). Upload .docx mail-merge templates,
// label/type each detected {{tag}} and optionally bind it to a project custom field
// for auto-fill, then generate shareable unauthenticated client-fill links.
"use client";

import { useState, useEffect, useCallback, useRef, type DragEvent } from "react";
import {
  Loader2, Upload, FileText, Plus, Copy, Check, Trash2, ExternalLink, X, Link2, Lock, RefreshCw, Bold, Italic, List,
  ChevronUp, ChevronDown, Combine,
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
  trigger_field_id: string | null;
  trigger_value: string | null;
  is_branch_only: boolean;
  display_order: number;
}
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

// A "combined group" is every field transitively linked to `fieldId` via
// trigger_field_id, walked in both directions (who I show after, and who
// shows after me) — the flat pool that free reordering happens within.
// Returned in `list`'s current order. A field with no links of its own
// (never combined) is a group of one. Always filters out joined_to_field_id
// aliases first, whatever `list` is passed — an aliased field never renders
// its own row, so it can't sit "inside" a visible chain. Without this, a
// field that gets Linked away while it's mid-chain would silently stay
// wired into the graph as an invisible member, breaking the visible
// adjacency buildFieldBlocks relies on for whoever came after it.
function groupOf(list: TemplateField[], fieldId: string): TemplateField[] {
  const visible = list.filter(f => !f.joined_to_field_id);
  const byId = new Map(visible.map(f => [f.id, f]));
  const seen = new Set<string>();
  const queue = [fieldId];
  while (queue.length) {
    const id = queue.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const f = byId.get(id);
    if (f?.trigger_field_id && byId.has(f.trigger_field_id)) queue.push(f.trigger_field_id);
    for (const other of visible) {
      if (other.trigger_field_id === id) queue.push(other.id);
    }
  }
  return visible.filter(f => seen.has(f.id));
}

// Rewrites trigger_field_id for every member of a group to match its
// current array order — a combined group is always a strict order-of-
// appearance sequence, so after any reorder the first member has no
// trigger and each later member's trigger becomes whoever now sits right
// before it. trigger_value only survives on a member whose immediate
// predecessor didn't actually change — otherwise a leftover "= Yes"
// condition could end up describing a completely different question.
function relinkGroup(list: TemplateField[], memberIds: Set<string>): TemplateField[] {
  const ordered = list.filter(f => memberIds.has(f.id));
  return list.map(f => {
    if (!memberIds.has(f.id)) return f;
    const idx = ordered.findIndex(m => m.id === f.id);
    const newTrigger = idx === 0 ? null : ordered[idx - 1].id;
    if (newTrigger === f.trigger_field_id) return f;
    return { ...f, trigger_field_id: newTrigger, trigger_value: null };
  });
}

// Splits the field list into blocks for rendering: a run of consecutive
// fields that all belong to the same combined group becomes one block
// (rendered together in a shaded area), everything else is its own block of
// one. Deliberately goes off the CURRENT array order rather than the
// trigger_field_id graph directly — combining always keeps both fields
// contiguous (see setTrigger), so this only matters as a fallback for an
// edge case like a stale/imported chain that isn't actually adjacent.
function buildFieldBlocks(list: TemplateField[]): TemplateField[][] {
  const blocks: TemplateField[][] = [];
  for (const f of list) {
    const prevBlock = blocks[blocks.length - 1];
    const prevField = prevBlock?.[prevBlock.length - 1];
    const directlyLinked = !!prevField && (f.trigger_field_id === prevField.id || prevField.trigger_field_id === f.id);
    if (prevBlock && directlyLinked) prevBlock.push(f);
    else blocks.push([f]);
  }
  return blocks;
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

  // Called both on mount and after every save/join/upload/revoke — only the
  // initial call should show the full-tab spinner (`loading` starts true).
  // Re-fetching afterwards must NOT flip it back to true, or every join/save
  // would unmount the whole tab to a bare spinner and swallow the "Saved"
  // checkmark before the user ever sees it.
  const load = useCallback(async () => {
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
  const [saveError, setSaveError] = useState<string | null>(null);
  // Which row's "link a field" search popover is open, and its search text.
  const [linkFieldId, setLinkFieldId] = useState<string | null>(null);
  const [linkQuery, setLinkQuery] = useState("");
  // Which row's "combine" search popover is open, and its search text.
  const [triggerFieldId, setTriggerFieldId] = useState<string | null>(null);
  const [triggerQuery, setTriggerQuery] = useState("");
  // The inline "new branching question" mini-form inside the Combine
  // popover — only one can be open at a time, alongside triggerFieldId.
  const [newQuestionOpen, setNewQuestionOpen] = useState(false);
  const [newQuestionLabel, setNewQuestionLabel] = useState("");
  const [newQuestionType, setNewQuestionType] = useState<TemplateField["field_type"]>("select");
  const [newQuestionOptions, setNewQuestionOptions] = useState("Yes, No");
  // After attaching a field under a select/multiselect anchor, this holds
  // the attached field's id while the Combine popover shows a follow-up
  // step to pick which of the anchor's answers should reveal it.
  const [pendingConditionFor, setPendingConditionFor] = useState<string | null>(null);
  const [pendingConditionValues, setPendingConditionValues] = useState<string[]>([]);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);

  // Aliased fields (joined_to_field_id set) never render their own row —
  // they show up as a chip on their root's row instead. Reorder only
  // operates over what's visible. Linking is scoped to this one document:
  // fields never leave `fields` to search across other templates.
  const visibleFields = fields.filter(f => !f.joined_to_field_id);
  const chipsFor = (fieldId: string) => fields.filter(f => f.joined_to_field_id === fieldId);
  // A field can only be picked to link if it's currently standalone (not
  // itself an alias, and not already a root with its own followers) — that
  // keeps every link/unlink a single-field mutation with no multi-field
  // group-merge case to reconcile.
  const linkCandidates = (excludeId: string) => fields.filter(f =>
    f.id !== excludeId && !f.joined_to_field_id && !fields.some(other => other.joined_to_field_id === f.id)
  );

  const update = (id: string, patch: Partial<TemplateField>) =>
    setFields(prev => prev.map(f => f.id === id ? { ...f, ...patch } : f));

  // Candidates for "combine with" from excludeId's popover — anything NOT
  // already in excludeId's own group. Picking something from excludeId's
  // own group would cycle: setTrigger moves the picked field's whole group
  // to sit after excludeId's tail, and excludeId can't sit both before AND
  // inside the block being moved.
  const triggerCandidates = (excludeId: string) => {
    const ownGroupIds = new Set(groupOf(visibleFields, excludeId).map(g => g.id));
    return visibleFields.filter(f => !ownGroupIds.has(f.id));
  };

  // Combining keeps the anchor field (the one whose Combine button was
  // clicked) exactly where it is, and moves the picked/created field to sit
  // directly after it, joining its group. Always attaches after the
  // anchor's current group TAIL rather than literally right after the
  // anchor itself, so an anchor that already has followers gets this
  // appended to the end of its sequence instead of forking a branch. If the
  // field being attached already has its own followers, that whole block
  // moves together so their relative order survives the move.
  const setTrigger = (movingFieldId: string, anchorFieldId: string) => {
    setFields(prev => {
      const tail = groupOf(prev, anchorFieldId).at(-1)!;
      const moving = groupOf(prev, movingFieldId);
      const movingIds = new Set(moving.map(m => m.id));
      const withNewLink = prev.map(f => f.id === movingFieldId ? { ...f, trigger_field_id: tail.id, trigger_value: null } : f);
      const movingBlock = moving.map(m => withNewLink.find(f => f.id === m.id)!);
      const rest = withNewLink.filter(f => !movingIds.has(f.id));
      const tailIdx = rest.findIndex(f => f.id === tail.id);
      rest.splice(tailIdx + 1, 0, ...movingBlock);
      return rest;
    });
  };
  // Creates a fresh question that exists purely to gate `forFieldId` — not
  // detected from the uploaded document (no real {{tag}} backs it), so its
  // tag_key is synthetic and prefixed to never collide with a real
  // placeholder. Otherwise it's a normal field: same type system, answered
  // by the client like anything else, and other fields can combine with it
  // too. Lands immediately below forFieldId, in the same group — same as
  // picking an existing field from the Combine search would do.
  const addBranchOnlyQuestion = (forFieldId: string, label: string, fieldType: TemplateField["field_type"], optionsText: string): string => {
    const id = crypto.randomUUID();
    const isChoice = fieldType === "select" || fieldType === "multiselect";
    const newField: TemplateField = {
      id, tag_key: `_branch_${id.slice(0, 8)}`, label: label.trim() || "Question", field_type: fieldType,
      select_options: isChoice ? optionsText.split(",").map(s => s.trim()).filter(Boolean) : null,
      is_required: false, auto_fill_field_id: null, default_value: null, joined_to_field_id: null,
      trigger_field_id: null, trigger_value: null, is_branch_only: true, display_order: 0,
    };
    setFields(prev => [...prev, newField]);
    setTrigger(id, forFieldId);
    return id;
  };
  // After attaching attachedId under a select/multiselect anchor, records
  // which of the anchor's answers should reveal it (empty = any answer).
  const finishCondition = (attachedId: string, values: string[]) => {
    update(attachedId, { trigger_value: values.length ? values.join("||") : null });
    setPendingConditionFor(null); setPendingConditionValues([]);
    setTriggerFieldId(null); setTriggerQuery("");
  };
  // The one field (in a strict combined group, there's normally at most
  // one) that shows right after fieldId is answered.
  const followerOf = (fieldId: string) => fields.find(x => x.trigger_field_id === fieldId) || null;
  const setRevealCondition = (fieldId: string, values: string[]) => {
    const follower = followerOf(fieldId);
    if (!follower) return;
    update(follower.id, { trigger_value: values.length ? values.join("||") : null });
  };
  // Only branch-only questions can be deleted outright — a real,
  // document-detected field must stay in sync with its {{tag}}, but a
  // branch-only one has no such tie and was authored purely in this UI.
  // Whatever was following it gets reattached to its own predecessor first,
  // same as clearTrigger, so removing a mid-chain question doesn't strand
  // the rest of the sequence. Takes effect on the next Save, like every
  // other local edit here.
  const deleteBranchOnlyField = (fieldId: string) => {
    if (!window.confirm("Delete this branching question? This can't be undone.")) return;
    setFields(prev => {
      const f = prev.find(x => x.id === fieldId);
      const predecessor = f?.trigger_field_id ?? null;
      return prev
        .filter(x => x.id !== fieldId)
        .map(x => x.trigger_field_id === fieldId ? { ...x, trigger_field_id: predecessor, trigger_value: null } : x);
    });
  };
  // Detaches a field from its group. Anything that was following it gets
  // reattached to whatever came before it, so the rest of the sequence
  // stays intact instead of losing its place in the order.
  const clearTrigger = (fieldId: string) => {
    setFields(prev => {
      const f = prev.find(x => x.id === fieldId);
      if (!f) return prev;
      const predecessor = f.trigger_field_id;
      return prev.map(x => {
        if (x.id === fieldId) return { ...x, trigger_field_id: null, trigger_value: null };
        if (x.trigger_field_id === fieldId) return { ...x, trigger_field_id: predecessor, trigger_value: null };
        return x;
      });
    });
  };

  // Reordering happens within the field's whole combined group (every field
  // it's transitively linked to) so any member — including the original
  // first one — can move freely. A field that isn't combined with anything
  // reorders among the other standalone/group-head fields instead, matching
  // how plain (uncombined) fields always worked.
  const siblingsOf = (f: TemplateField) => {
    const grp = groupOf(visibleFields, f.id);
    return grp.length > 1 ? grp : visibleFields.filter(x => !x.trigger_field_id);
  };

  const moveField = (fieldId: string, dir: -1 | 1) => {
    const f = fields.find(x => x.id === fieldId);
    if (!f) return;
    const siblings = siblingsOf(f);
    const sIdx = siblings.findIndex(s => s.id === fieldId);
    const target = siblings[sIdx + dir];
    if (!target) return;
    setFields(prev => {
      const next = [...prev];
      const i = next.findIndex(f => f.id === fieldId);
      const j = next.findIndex(f => f.id === target.id);
      [next[i], next[j]] = [next[j], next[i]];
      const grp = groupOf(next, fieldId);
      return grp.length > 1 ? relinkGroup(next, new Set(grp.map(g => g.id))) : next;
    });
  };

  // Moves an entire combined group (or a standalone field) as a single unit
  // past whichever block sits next to it, swapping the two blocks' whole
  // ranges — separate from moveField, which only reorders within a group.
  // Membership-based rather than index-based so any alias fields riding
  // along elsewhere in `fields` just stay wherever they were, unaffected.
  const moveBlock = (block: TemplateField[], dir: -1 | 1) => {
    const blocks = buildFieldBlocks(visibleFields);
    const idx = blocks.findIndex(b => b[0].id === block[0].id);
    const target = blocks[idx + dir];
    if (!target) return;
    setFields(prev => {
      const aIds = new Set(block.map(f => f.id));
      const bIds = new Set(target.map(f => f.id));
      const firstIdx = prev.findIndex(f => aIds.has(f.id) || bIds.has(f.id));
      let restBefore = 0;
      for (let i = 0; i < firstIdx; i++) if (!aIds.has(prev[i].id) && !bIds.has(prev[i].id)) restBefore++;
      const rest = prev.filter(f => !aIds.has(f.id) && !bIds.has(f.id));
      const ordered = dir === -1 ? [...block, ...target] : [...target, ...block];
      const next = [...rest];
      next.splice(restBefore, 0, ...ordered);
      return next;
    });
  };

  // Optimistic: the row updates immediately: the API call happens in the
  // background and only touches local state again if it fails.
  // A field that gets Linked away (aliased) never renders its own row again,
  // so if it was mid-combine-chain it needs detaching first — same as
  // clearTrigger — or whatever was following it would be left pointing at a
  // now-invisible predecessor and fall out of the visible group.
  const handleLink = async (memberFieldId: string, rootFieldId: string) => {
    setFields(prev => {
      const f = prev.find(x => x.id === memberFieldId);
      const predecessor = f?.trigger_field_id ?? null;
      return prev.map(x => {
        if (x.id === memberFieldId) return { ...x, joined_to_field_id: rootFieldId, trigger_field_id: null, trigger_value: null };
        if (x.trigger_field_id === memberFieldId) return { ...x, trigger_field_id: predecessor, trigger_value: null };
        return x;
      });
    });
    const res = await fetch("/api/document-templates/fields/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fieldId: memberFieldId, joinTargetFieldId: rootFieldId }),
    });
    if (!res.ok) update(memberFieldId, { joined_to_field_id: null });
  };
  const handleUnlink = async (memberFieldId: string) => {
    const prevRoot = fields.find(f => f.id === memberFieldId)?.joined_to_field_id ?? null;
    update(memberFieldId, { joined_to_field_id: null });
    const res = await fetch("/api/document-templates/fields/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fieldId: memberFieldId, joinTargetFieldId: null }),
    });
    if (!res.ok) update(memberFieldId, { joined_to_field_id: prevRoot });
  };

  const handleChipDragStart = (e: DragEvent, fieldId: string) => {
    e.dataTransfer.setData("text/plain", fieldId);
    e.dataTransfer.effectAllowed = "move";
  };
  // Dropping a dragged chip onto a (different) field's row merges it there.
  const handleRowDrop = (e: DragEvent, rootId: string) => {
    e.preventDefault();
    e.stopPropagation();
    const draggedId = e.dataTransfer.getData("text/plain");
    if (draggedId && draggedId !== rootId) handleLink(draggedId, rootId);
  };
  // Dropping anywhere else in the list (not on a specific row —
  // handleRowDrop stops propagation so this only fires for "empty space")
  // unlinks the dragged chip, returning it to its own row.
  const handleContainerDrop = (e: DragEvent) => {
    const draggedId = e.dataTransfer.getData("text/plain");
    if (draggedId) handleUnlink(draggedId);
  };

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

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    setSaveError(null);
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
            trigger_field_id: f.trigger_field_id, trigger_value: f.trigger_value, is_branch_only: f.is_branch_only,
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
    if (fieldsRes.ok) { setSaved(true); setTimeout(() => setSaved(false), 1500); onSaved(); return; }
    // Surface the failure — a save that silently does nothing is worse than
    // no save at all, since the admin has no way to tell their edits (and
    // anything downstream, like combine/branching setup) never persisted.
    let message = "Failed to save";
    try { message = (await fieldsRes.json())?.error || message; } catch { /* non-JSON error body */ }
    setSaveError(message);
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
        <div className="space-y-2 mb-3" onDragOver={e => e.preventDefault()} onDrop={handleContainerDrop}>
          {(() => {
            const allBlocks = buildFieldBlocks(visibleFields);
            return allBlocks.map((block, bi) => (
            <div key={block[0].id} className={block.length > 1 ? "space-y-2 bg-slate-50 rounded-2xl p-3" : undefined}>
              {block.length > 1 && (
                <div className="flex items-center gap-2 px-1">
                  <div className="flex flex-col shrink-0">
                    <button onClick={() => moveBlock(block, -1)} disabled={bi === 0} title="Move this whole combined group up"
                      className="text-slate-300 hover:text-indigo-600 disabled:opacity-20 transition-colors"><ChevronUp size={12} /></button>
                    <button onClick={() => moveBlock(block, 1)} disabled={bi === allBlocks.length - 1} title="Move this whole combined group down"
                      className="text-slate-300 hover:text-indigo-600 disabled:opacity-20 transition-colors"><ChevronDown size={12} /></button>
                  </div>
                  <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">
                    Combined group · {block.length} fields
                  </p>
                </div>
              )}
              {block.map(f => {
                const chips = chipsFor(f.id);
                const siblings = siblingsOf(f);
                const sIdx = siblings.findIndex(s => s.id === f.id);
                const triggerField = f.trigger_field_id ? fields.find(t => t.id === f.trigger_field_id) : null;
                return (
                  <div key={f.id} className="space-y-1.5" onDragOver={e => e.preventDefault()} onDrop={e => handleRowDrop(e, f.id)}>
                    <div className="flex items-center gap-2 flex-wrap">
                  <div className="flex flex-col shrink-0">
                    <button onClick={() => moveField(f.id, -1)} disabled={sIdx === 0} title="Move up"
                      className="text-slate-300 hover:text-indigo-600 disabled:opacity-20 transition-colors"><ChevronUp size={12} /></button>
                    <button onClick={() => moveField(f.id, 1)} disabled={sIdx === siblings.length - 1} title="Move down"
                      className="text-slate-300 hover:text-indigo-600 disabled:opacity-20 transition-colors"><ChevronDown size={12} /></button>
                  </div>
                  {f.is_branch_only ? (
                    <span title="Not in the document — used only to decide what to show next"
                      className="shrink-0 px-2 py-1 bg-amber-50 text-amber-600 rounded-full text-[9px] font-bold uppercase tracking-widest">
                      Branching only
                    </span>
                  ) : (
                    <code className="text-[11px] text-indigo-500 shrink-0 max-w-[120px] truncate" title={f.tag_key}>{`{{${f.tag_key}}}`}</code>
                  )}
                  <input value={f.label} onChange={e => update(f.id, { label: e.target.value })}
                    placeholder="Label"
                    className="flex-1 min-w-[140px] px-3 py-2 border border-slate-200 rounded-full text-[12px] outline-none focus:border-indigo-400" />
                  <select value={f.field_type} onChange={e => update(f.id, { field_type: e.target.value as TemplateField["field_type"] })}
                    className="w-44 shrink-0 px-3 py-2 border border-slate-200 rounded-full text-[12px] outline-none bg-white">
                    {FIELD_TYPES.map(t => <option key={t} value={t}>{FIELD_TYPE_LABELS[t]}</option>)}
                  </select>
                  <select value={f.auto_fill_field_id || ""} onChange={e => update(f.id, { auto_fill_field_id: e.target.value || null })}
                    className="w-40 shrink-0 px-3 py-2 border border-slate-200 rounded-full text-[12px] outline-none bg-white">
                    <option value="">No auto-fill</option>
                    {customFields.map(cf => <option key={cf.id} value={cf.id}>Auto: {cf.label}</option>)}
                  </select>
                  <label className="shrink-0 flex items-center gap-1.5 text-[11px] text-slate-500 cursor-pointer">
                    <input type="checkbox" checked={f.is_required} onChange={e => update(f.id, { is_required: e.target.checked })} />
                    Required
                  </label>

                  {chips.map(c => (
                    <span key={c.id} draggable onDragStart={e => handleChipDragStart(e, c.id)}
                      title="Drag out, or click × to unlink"
                      className="shrink-0 flex items-center gap-1 pl-2 pr-1 py-1 bg-indigo-50 border border-indigo-100 rounded-full text-[10px] text-indigo-600 cursor-grab active:cursor-grabbing">
                      <code>{`{{${c.tag_key}}}`}</code>
                      <button onClick={() => handleUnlink(c.id)} className="p-0.5 hover:text-red-500 rounded-full"><X size={10} /></button>
                    </span>
                  ))}

                  <div className="relative shrink-0">
                    <button onClick={() => { setLinkFieldId(linkFieldId === f.id ? null : f.id); setLinkQuery(""); }}
                      title="Link with another field in this document, so the client is only asked once and the same answer fills both"
                      className={`p-1.5 rounded-lg transition-colors ${linkFieldId === f.id || chips.length > 0 ? "bg-indigo-100 text-indigo-600" : "text-slate-400 hover:text-indigo-600 hover:bg-slate-50"}`}>
                      <Link2 size={13} />
                    </button>
                    {linkFieldId === f.id && (
                      <>
                        <div className="fixed inset-0 z-10" onClick={() => setLinkFieldId(null)} />
                        <div className="absolute right-0 z-20 mt-1 w-72 bg-white border border-slate-200 rounded-2xl shadow-xl p-2">
                          <input autoFocus value={linkQuery} onChange={e => setLinkQuery(e.target.value)}
                            placeholder="Search fields to link..."
                            className="w-full px-3 py-2 border border-slate-200 rounded-full text-[12px] outline-none focus:border-indigo-400 mb-1" />
                          <div className="max-h-48 overflow-y-auto">
                            {linkCandidates(f.id)
                              .filter(c => !linkQuery.trim() || c.label.toLowerCase().includes(linkQuery.toLowerCase()) || c.tag_key.toLowerCase().includes(linkQuery.toLowerCase()))
                              .map(c => (
                                <button key={c.id} onClick={() => { handleLink(c.id, f.id); setLinkFieldId(null); setLinkQuery(""); }}
                                  className="w-full text-left px-3 py-2 text-[12px] text-slate-600 hover:bg-indigo-50 hover:text-indigo-700 rounded-xl truncate">
                                  <code className="text-indigo-400">{`{{${c.tag_key}}}`}</code> — {c.label}
                                </button>
                              ))}
                            {linkCandidates(f.id).length === 0 && (
                              <p className="px-3 py-2 text-[11px] text-slate-300">No other fields in this document to link</p>
                            )}
                          </div>
                        </div>
                      </>
                    )}
                  </div>

                  <div className="relative shrink-0">
                    <button onClick={() => { setTriggerFieldId(triggerFieldId === f.id ? null : f.id); setTriggerQuery(""); }}
                      title={f.trigger_field_id
                        ? `Combined with {{${triggerField?.tag_key ?? "?"}}}${f.trigger_value ? ` — only shown when that's ${f.trigger_value.split("||").map(v => `"${v}"`).join(" or ")}` : " — only shown once that's answered"}. Click to change.`
                        : "Combine with another field in this document, so this one only appears once the other is answered"}
                      className={`p-1.5 rounded-lg transition-colors ${f.trigger_field_id || triggerFieldId === f.id ? "bg-indigo-100 text-indigo-600" : "text-slate-400 hover:text-indigo-600 hover:bg-slate-50"}`}>
                      <Combine size={13} />
                    </button>
                    {triggerFieldId === f.id && (
                      <>
                        <div className="fixed inset-0 z-10" onClick={() => {
                          setTriggerFieldId(null); setNewQuestionOpen(false);
                          setPendingConditionFor(null); setPendingConditionValues([]);
                        }} />
                        <div className="absolute right-0 z-20 mt-1 w-72 bg-white border border-slate-200 rounded-2xl shadow-xl p-2">
                          {pendingConditionFor ? (
                            <div className="space-y-1.5 p-1">
                              <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest px-1">
                                Which answer to &quot;{f.label || f.tag_key}&quot; reveals this?
                              </p>
                              <button onClick={() => finishCondition(pendingConditionFor, [])}
                                className={`w-full text-left px-3 py-2 rounded-xl text-[12px] transition-colors ${!pendingConditionValues.length ? "bg-indigo-100 text-indigo-700" : "bg-slate-50 text-slate-600 hover:bg-indigo-50"}`}>
                                Any answer
                              </button>
                              <div className="max-h-40 overflow-y-auto space-y-1">
                                {(f.select_options || []).map((opt, i) => {
                                  const checked = pendingConditionValues.includes(opt);
                                  return (
                                    <label key={i} className="flex items-center gap-2 px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-xl text-[12px] text-slate-600 cursor-pointer">
                                      <input type="checkbox" checked={checked}
                                        onChange={() => setPendingConditionValues(checked ? pendingConditionValues.filter(v => v !== opt) : [...pendingConditionValues, opt])} />
                                      {opt}
                                    </label>
                                  );
                                })}
                              </div>
                              <button onClick={() => finishCondition(pendingConditionFor, pendingConditionValues)}
                                disabled={!pendingConditionValues.length}
                                className="w-full py-2 bg-indigo-600 text-white text-[11px] font-bold rounded-full hover:bg-indigo-700 disabled:opacity-40">
                                Done
                              </button>
                            </div>
                          ) : newQuestionOpen ? (
                            <div className="space-y-1.5 p-1">
                              <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest px-1">
                                New question, just for branching
                              </p>
                              <input autoFocus value={newQuestionLabel} onChange={e => setNewQuestionLabel(e.target.value)}
                                placeholder="e.g. Is the borrower a trust?"
                                className="w-full px-3 py-2 border border-slate-200 rounded-full text-[12px] outline-none focus:border-indigo-400" />
                              <select value={newQuestionType} onChange={e => setNewQuestionType(e.target.value as TemplateField["field_type"])}
                                className="w-full px-3 py-2 border border-slate-200 rounded-full text-[12px] outline-none bg-white">
                                {FIELD_TYPES.map(t => <option key={t} value={t}>{FIELD_TYPE_LABELS[t]}</option>)}
                              </select>
                              {(newQuestionType === "select" || newQuestionType === "multiselect") && (
                                <input value={newQuestionOptions} onChange={e => setNewQuestionOptions(e.target.value)}
                                  placeholder="Options (comma-separated)"
                                  className="w-full px-3 py-2 border border-slate-200 rounded-full text-[12px] outline-none focus:border-indigo-400" />
                              )}
                              <p className="text-[9px] text-slate-300 px-1">Not in the document — used only to decide what to show next.</p>
                              <div className="flex gap-1.5 pt-1">
                                <button onClick={() => { setNewQuestionOpen(false); setTriggerFieldId(null); }}
                                  className="flex-1 py-2 text-[11px] text-slate-500 hover:bg-slate-50 rounded-full">Cancel</button>
                                <button onClick={() => {
                                  const newId = addBranchOnlyQuestion(f.id, newQuestionLabel, newQuestionType, newQuestionOptions);
                                  setNewQuestionOpen(false); setTriggerQuery("");
                                  setNewQuestionLabel(""); setNewQuestionType("select"); setNewQuestionOptions("Yes, No");
                                  // The question just created shows after f — if f itself is a
                                  // choice question, ask which of its answers should reveal it,
                                  // same as picking an existing field would.
                                  if (f.field_type === "select" || f.field_type === "multiselect") {
                                    setPendingConditionFor(newId); setPendingConditionValues([]);
                                  } else {
                                    setTriggerFieldId(null);
                                  }
                                }} disabled={!newQuestionLabel.trim()}
                                  className="flex-1 py-2 bg-indigo-600 text-white text-[11px] font-bold rounded-full hover:bg-indigo-700 disabled:opacity-40">
                                  Create
                                </button>
                              </div>
                            </div>
                          ) : (
                            <>
                              <button onClick={() => setNewQuestionOpen(true)}
                                className="w-full flex items-center gap-1.5 text-left px-3 py-2 text-[12px] text-indigo-600 hover:bg-indigo-50 rounded-xl mb-1">
                                <Plus size={12} /> New branching question...
                              </button>
                              <input autoFocus value={triggerQuery} onChange={e => setTriggerQuery(e.target.value)}
                                placeholder="Or search fields to combine..."
                                className="w-full px-3 py-2 border border-slate-200 rounded-full text-[12px] outline-none focus:border-indigo-400 mb-1" />
                              <div className="max-h-48 overflow-y-auto">
                                {triggerCandidates(f.id)
                                  .filter(c => !triggerQuery.trim() || c.label.toLowerCase().includes(triggerQuery.toLowerCase()) || c.tag_key.toLowerCase().includes(triggerQuery.toLowerCase()))
                                  .map(c => (
                                    // f stays put; the picked field (c) moves to sit directly
                                    // below it and joins its group (see setTrigger). If f is a
                                    // choice question, ask which answer reveals c instead of
                                    // closing immediately.
                                    <button key={c.id} onClick={() => {
                                      setTrigger(c.id, f.id);
                                      if (f.field_type === "select" || f.field_type === "multiselect") {
                                        setPendingConditionFor(c.id); setPendingConditionValues([]);
                                      } else {
                                        setTriggerFieldId(null); setTriggerQuery("");
                                      }
                                    }}
                                      className="w-full text-left px-3 py-2 text-[12px] text-slate-600 hover:bg-indigo-50 hover:text-indigo-700 rounded-xl truncate">
                                      <code className="text-indigo-400">{`{{${c.tag_key}}}`}</code> — {c.label}
                                    </button>
                                  ))}
                                {triggerCandidates(f.id).length === 0 && (
                                  <p className="px-3 py-2 text-[11px] text-slate-300">No other fields in this document to combine with</p>
                                )}
                              </div>
                            </>
                          )}
                        </div>
                      </>
                    )}
                  </div>

                  {f.trigger_field_id && (
                    <button onClick={() => clearTrigger(f.id)} title="Remove from this combined group"
                      className="p-1.5 text-slate-300 hover:text-red-500 rounded-full shrink-0"><X size={13} /></button>
                  )}
                  {f.is_branch_only && (
                    <button onClick={() => deleteBranchOnlyField(f.id)} title="Delete this branching question"
                      className="p-1.5 text-slate-300 hover:text-red-500 rounded-full shrink-0"><Trash2 size={13} /></button>
                  )}
                </div>

                {(f.field_type === "select" || f.field_type === "multiselect") && (
                  <input
                    value={Array.isArray(f.select_options) ? f.select_options.join(", ") : (f.select_options || "")}
                    onChange={e => update(f.id, { select_options: e.target.value as any })}
                    placeholder="Options (comma-separated)"
                    className="w-full ml-6 px-3 py-2 border border-slate-200 rounded-full text-[12px] outline-none focus:border-indigo-400" />
                )}
                {f.is_branch_only ? (() => {
                  // A branch-only question exists purely to gate what comes
                  // next, so a "default value" (which prefills what gets
                  // written into a document it isn't even part of) isn't
                  // useful here — this replaces it with the condition that
                  // actually matters: which answer reveals its follower.
                  const follower = followerOf(f.id);
                  if (!follower) {
                    return <p className="ml-6 text-[10px] text-slate-300 italic">Combine this with another field to reveal it based on the answer</p>;
                  }
                  const selected = follower.trigger_value ? follower.trigger_value.split("||") : [];
                  const opts = (f.field_type === "select" || f.field_type === "multiselect") && Array.isArray(f.select_options)
                    ? f.select_options : null;
                  return (
                    <div className="ml-6 flex flex-wrap items-center gap-2 px-3 py-2 border border-dashed border-slate-200 rounded-full text-[11px] text-slate-500">
                      <span className="shrink-0">If answer is</span>
                      {opts ? opts.map((opt, i) => {
                        const checked = selected.includes(opt);
                        return (
                          <label key={i} className="flex items-center gap-1 shrink-0 cursor-pointer">
                            <input type="checkbox" checked={checked}
                              onChange={() => setRevealCondition(f.id, checked ? selected.filter(v => v !== opt) : [...selected, opt])} />
                            {opt}
                          </label>
                        );
                      }) : (
                        <input value={selected.join(", ")}
                          onChange={e => setRevealCondition(f.id, e.target.value.split(",").map(s => s.trim()).filter(Boolean))}
                          placeholder="any answer"
                          className="flex-1 min-w-[100px] px-2 py-1 border border-slate-200 rounded-full text-[11px] outline-none focus:border-indigo-400" />
                      )}
                      <span className="shrink-0 text-slate-400">reveal the next field{!selected.length && " (currently: any answer)"}</span>
                    </div>
                  );
                })() : !f.auto_fill_field_id && (
                  <input
                    value={f.default_value || ""}
                    onChange={e => update(f.id, { default_value: e.target.value })}
                    placeholder="Default value if the client leaves this blank (optional)"
                    className="w-full ml-6 px-3 py-2 border border-dashed border-slate-200 rounded-full text-[12px] outline-none focus:border-indigo-400" />
                )}
                  </div>
                );
              })}
            </div>
            ));
          })()}
        </div>
      )}

      <div className="flex items-center justify-end gap-3 pt-2">
        {saveError && <p className="text-[11px] text-red-500">{saveError}</p>}
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
