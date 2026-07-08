// components/gmail/LabelSettingsModal.tsx
"use client";

import { useState } from "react";
import { X, GripVertical, Plus, Trash2, Loader2, Check, AlertTriangle } from "lucide-react";
import type { LabelFormat } from "@/lib/gmail/types";

interface Props {
  parentLabel: string;
  format: LabelFormat;
  labelTokens?: string[];        // ordered list of token keys
  companyName: string;
  onSave: (parentLabel: string, format: LabelFormat, tokens: string[]) => void;
  onClose: () => void;
}

// ── Available token types ──────────────────────────────────────────

const AVAILABLE_TOKENS = [
  { key: 'company',       label: 'Company Name',   example: 'Huynh Lawyers',          color: 'bg-slate-100 text-slate-700' },
  { key: 'project_name',  label: 'Project Name',   example: 'Separation Agreement',   color: 'bg-indigo-100 text-indigo-700' },
  { key: 'matter_number', label: 'Matter Number',  example: 'MN-240204',              color: 'bg-violet-100 text-violet-700' },
  { key: 'matter_status', label: 'Matter Status',  example: 'Open',                   color: 'bg-emerald-100 text-emerald-700' },
  { key: 'year',          label: 'Year',           example: '2024',                   color: 'bg-amber-100 text-amber-700' },
];

const DEFAULT_TOKENS = ['company', 'project_name'];

function getTokenMeta(key: string) {
  return AVAILABLE_TOKENS.find(t => t.key === key) || {
    key, label: key, example: key, color: 'bg-slate-100 text-slate-700',
  };
}

export default function LabelSettingsModal({
  parentLabel, format, labelTokens, companyName, onSave, onClose,
}: Props) {
  const [draftParent, setDraftParent] = useState(parentLabel);
  const [tokens, setTokens] = useState<string[]>(
    labelTokens?.length ? labelTokens : DEFAULT_TOKENS
  );
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const [showTokenPicker, setShowTokenPicker] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Drag reorder ───────────────────────────────────────────────

  const handleDrop = (targetIdx: number) => {
    if (dragIdx === null || dragIdx === targetIdx) {
      setDragIdx(null); setDragOverIdx(null); return;
    }
    const next = [...tokens];
    const [moved] = next.splice(dragIdx, 1);
    next.splice(targetIdx, 0, moved);
    setTokens(next);
    setDragIdx(null); setDragOverIdx(null);
  };

  const removeToken = (idx: number) => {
    if (tokens.length <= 1) return; // keep at least one
    setTokens(prev => prev.filter((_, i) => i !== idx));
  };

  const addToken = (key: string) => {
    setTokens(prev => [...prev, key]);
    setShowTokenPicker(false);
  };

  // ── Build preview label ────────────────────────────────────────

  const buildPreview = () => {
    const parts = [draftParent || 'Shared Emails'];
    tokens.forEach(key => {
      const meta = getTokenMeta(key);
      parts.push(meta.example);
    });
    return parts.join('/');
  };

  // ── Derive legacy format for API compat ───────────────────────
  // Convert token array to LabelFormat for backward compat

  const derivedFormat = (): LabelFormat => {
    const hasProject = tokens.includes('project_name');
    const hasMatter = tokens.includes('matter_number');
    if (hasProject && hasMatter) return 'company_project';
    if (hasMatter) return 'matter_number';
    return 'project_name';
  };

  // Handle Save
  // In LabelSettingsModal, update handleSave:
  const handleSave = async () => {
    // Validate parent label isn't empty
    if (!draftParent.trim()) {
      setError('Parent label name is required');
      return;
    }

    setSaving(true);
    setError(null);

    try {
      // Check Gmail for existing labels with this parent name
      const checkRes = await fetch('/api/gmail/check-parent-label', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parentLabel: draftParent.trim() }),
      });
      const check = await checkRes.json();

      if (check.conflict) {
        setError(
          `A label named "${check.existingName}" already exists in Gmail — ` +
          `rename it first or use the same name here.`
        );
        setSaving(false);
        return;
      }

      await onSave(draftParent.trim(), derivedFormat(), tokens);
      setSaved(true);
      setTimeout(() => { setSaved(false); onClose(); }, 800);
    } catch (err) {
      setError('Failed to save — please try again');
    } finally {
      setSaving(false);
    }
  };

  const availableToAdd = AVAILABLE_TOKENS.filter(t => !tokens.includes(t.key));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-md p-6">
      <div className="bg-white rounded-[40px] p-8 w-full max-w-md shadow-2xl">

        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-lg font-light uppercase tracking-wide text-slate-900">
            Label settings
          </h3>
          <button onClick={onClose} className="p-2 text-slate-300 hover:text-black">
            <X size={18} />
          </button>
        </div>

        <div className="space-y-6">

          {/* Parent label */}
          <div>
            <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block mb-2">
              Parent label
            </label>
            <input
              value={draftParent}
              onChange={e => setDraftParent(e.target.value)}
              placeholder="Shared Emails"
              className="w-full bg-slate-50 border border-slate-200 rounded-full py-3 px-5 text-[13px] font-medium outline-none focus:ring-4 focus:ring-indigo-100"
            />
          </div>

          {/* Token builder */}
          <div>
            <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block mb-2">
              Sub-label parts — drag to reorder
            </label>

            <div className="space-y-2 mb-3">
              {tokens.map((key, idx) => {
                const meta = getTokenMeta(key);
                const isDragOver = dragOverIdx === idx && dragIdx !== idx;
                return (
                  <div
                    key={`${key}-${idx}`}
                    draggable
                    onDragStart={() => setDragIdx(idx)}
                    onDragOver={e => { e.preventDefault(); setDragOverIdx(idx); }}
                    onDrop={() => handleDrop(idx)}
                    onDragEnd={() => { setDragIdx(null); setDragOverIdx(null); }}
                    className={`flex items-center gap-3 px-3 py-2.5 rounded-2xl border-2 transition-all cursor-grab active:cursor-grabbing ${
                      isDragOver
                        ? 'border-indigo-400 bg-indigo-50'
                        : 'border-slate-100 bg-white hover:border-slate-200'
                    } ${dragIdx === idx ? 'opacity-40' : ''}`}
                  >
                    <GripVertical size={14} className="text-slate-300 shrink-0" />

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${meta.color}`}>
                          {meta.label}
                        </span>
                        <span className="text-[11px] text-slate-400 truncate">
                          e.g. {meta.example}
                        </span>
                      </div>
                    </div>

                    <button
                      onClick={() => removeToken(idx)}
                      disabled={tokens.length <= 1}
                      className="p-1 text-slate-300 hover:text-red-500 transition-colors disabled:opacity-20 shrink-0"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                );
              })}
            </div>

            {/* Add token */}
            {availableToAdd.length > 0 && (
              <div className="relative">
                <button
                  onClick={() => setShowTokenPicker(p => !p)}
                  className="flex items-center gap-2 px-4 py-2 border border-dashed border-slate-300 rounded-full text-[11px] font-bold text-slate-400 hover:border-indigo-400 hover:text-indigo-600 transition-all"
                >
                  <Plus size={13} /> Add part
                </button>

                {showTokenPicker && (
                  <div className="absolute top-full left-0 mt-1 bg-white border border-slate-200 rounded-2xl shadow-xl z-20 w-56 overflow-hidden">
                    {availableToAdd.map(t => (
                      <button
                        key={t.key}
                        onClick={() => addToken(t.key)}
                        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-slate-50 text-left transition-colors border-b border-slate-50 last:border-0"
                      >
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold shrink-0 ${t.color}`}>
                          {t.label}
                        </span>
                        <span className="text-[11px] text-slate-400 truncate">
                          {t.example}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {error && (
            <div className="p-3 bg-red-50 border border-red-100 rounded-2xl flex items-start gap-2">
              <AlertTriangle size={14} className="text-red-500 shrink-0 mt-0.5" />
              <p className="text-[11px] text-red-600 font-medium">{error}</p>
            </div>
          )}

          {/* Live preview */}
          <div className="bg-slate-50 border border-slate-100 rounded-2xl p-4">
            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-2">
              Preview
            </p>
            <div className="flex items-center flex-wrap gap-0.5">
              {/* Parent label */}
              <span className="px-2 py-1 bg-white border border-slate-200 rounded-lg text-[11px] font-bold text-slate-700">
                {draftParent || 'Shared Emails'}
              </span>
              {tokens.map((key, idx) => {
                const meta = getTokenMeta(key);
                return (
                  <span key={idx} className="flex items-center gap-0.5">
                    <span className="text-slate-400 text-[11px] font-bold px-0.5">/</span>
                    <span className={`px-2 py-1 rounded-lg text-[11px] font-bold ${meta.color}`}>
                      {meta.example}
                    </span>
                  </span>
                );
              })}
            </div>
            <p className="text-[9px] text-slate-400 mt-2 font-mono break-all">
              {buildPreview()}
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="flex gap-3 mt-6">
          <button
            onClick={onClose}
            className="flex-1 py-3 bg-slate-50 text-slate-600 rounded-full text-[11px] font-bold"
          >
            Cancel
          </button>
        <button
          onClick={handleSave}
          disabled={saving}
          className={`flex-1 py-3 rounded-full text-[11px] font-bold transition-all flex items-center justify-center gap-2 ${
            saved
              ? 'bg-emerald-500 text-white'
              : 'bg-slate-900 text-white hover:bg-black disabled:opacity-50'
          }`}
        >
          {saving ? (
            <>
              <Loader2 size={13} className="animate-spin" />
              Saving...
            </>
          ) : saved ? (
            <>
              <Check size={13} />
              Saved
            </>
          ) : (
            'Save'
          )}
        </button>
        </div>
      </div>
    </div>
  );
}
