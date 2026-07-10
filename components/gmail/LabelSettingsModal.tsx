// components/gmail/LabelSettingsModal.tsx
"use client";

import { useState } from "react";
import { X, GripVertical, Info, Tag } from "lucide-react";

interface Props {
  parentLabel: string;
  parentCode: string;
  sublabelTokens: string[];
  sublabelSeparator: string;
  format: string;
  onSave: (
    parentLabel: string,
    parentCode: string,
    tokens: string[],
    separator: string
  ) => void;
  onClose: () => void;
}

const AVAILABLE_TOKENS = [
  { id: 'matter_number', label: 'Matter Number', example: '260541' },
  { id: 'project_name',  label: 'Project Name',  example: '33 Moore Street' },
  { id: 'year',          label: 'Year',           example: '2026' },
];

const SEPARATORS = [
  { value: ' — ', label: 'Em dash  ( — )' },
  { value: ' - ', label: 'Hyphen   ( - )' },
  { value: '/',   label: 'Slash    ( / )' },
  { value: ' | ', label: 'Pipe     ( | )' },
  { value: ' ',   label: 'Space' },
];

export default function LabelSettingsModal({
  parentLabel: initParent,
  parentCode: initCode,
  sublabelTokens: initTokens,
  sublabelSeparator: initSep,
  onSave,
  onClose,
}: Props) {
  const [parentLabel, setParentLabel] = useState(initParent);
  const [parentCode, setParentCode]   = useState(initCode);
  const [tokens, setTokens]           = useState<string[]>(initTokens);
  const [separator, setSeparator]     = useState(initSep);
  const [dragIdx, setDragIdx]         = useState<number | null>(null);

  // Build live preview
  const parentFull = parentCode.trim()
    ? `${parentLabel} #${parentCode}`
    : parentLabel;

  const sublabelParts = tokens.map(t => {
    const tok = AVAILABLE_TOKENS.find(a => a.id === t);
    return tok?.example || t;
  });
  const sublabel = sublabelParts.join(separator);
  const preview = `${parentFull}/${sublabel} [AB12C]`;

  const unusedTokens = AVAILABLE_TOKENS.filter(t => !tokens.includes(t.id));

  const addToken = (id: string) => setTokens(prev => [...prev, id]);
  const removeToken = (id: string) => setTokens(prev => prev.filter(t => t !== id));

  const handleDragStart = (idx: number) => setDragIdx(idx);
  const handleDrop = (idx: number) => {
    if (dragIdx === null || dragIdx === idx) return;
    const next = [...tokens];
    const [moved] = next.splice(dragIdx, 1);
    next.splice(idx, 0, moved);
    setTokens(next);
    setDragIdx(null);
  };

  const handleSave = () => {
    onSave(parentLabel, parentCode, tokens, separator);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm">
      <div className="bg-white rounded-[40px] shadow-2xl w-full max-w-lg mx-4 overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-8 pt-8 pb-4">
          <div>
            <h2 className="text-lg font-light uppercase tracking-tight text-slate-800">
              Label Settings
            </h2>
            <p className="text-[11px] text-slate-400 mt-0.5">
              Configure how Gmail labels are structured for this company
            </p>
          </div>
          <button onClick={onClose} className="p-2 text-slate-400 hover:text-slate-700 rounded-full hover:bg-slate-100">
            <X size={16} />
          </button>
        </div>

        <div className="px-8 pb-8 space-y-6 max-h-[70vh] overflow-y-auto">

          {/* How it works */}
          <div className="flex gap-3 p-4 bg-indigo-50 border border-indigo-100 rounded-2xl">
            <Info size={14} className="text-indigo-500 shrink-0 mt-0.5" />
            <div className="text-[11px] text-indigo-700 leading-relaxed space-y-1">
              <p><strong>How labels work:</strong></p>
              <p>Each project gets a Gmail label in exactly 2 levels: <strong>Parent / Sublabel [CODE]</strong></p>
              <p>The <strong>[CODE]</strong> (e.g. <code>[AB12C]</code>) is a unique 5-character ID automatically assigned to each label. It lets the system track and sync labels across all users even if the label is renamed or deleted.</p>
              <p>When you assign an email to a project, the label is created in Gmail and synced to all company members every 5 minutes.</p>
            </div>
          </div>

          {/* Parent label */}
          <div className="space-y-2">
            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">
              Parent label name
            </p>
            <input
              value={parentLabel}
              onChange={e => setParentLabel(e.target.value)}
              className="w-full px-4 py-3 border border-slate-200 rounded-2xl text-sm font-light focus:outline-none focus:border-indigo-400"
              placeholder="e.g. Huynh Lawyers"
            />
          </div>

          {/* Company code */}
          <div className="space-y-2">
            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">
              Company code <span className="text-slate-300 font-normal">(optional)</span>
            </p>
            <p className="text-[11px] text-slate-400">
              Appended to parent as <code>#CODE</code>. E.g. <code>HL26</code> → <code>Huynh Lawyers #HL26</code>
            </p>
            <input
              value={parentCode}
              onChange={e => setParentCode(e.target.value.toUpperCase())}
              maxLength={6}
              className="w-full px-4 py-3 border border-slate-200 rounded-2xl text-sm font-light focus:outline-none focus:border-indigo-400 uppercase"
              placeholder="e.g. HL26"
            />
          </div>

          {/* Sublabel tokens */}
          <div className="space-y-3">
            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">
              Sublabel fields
            </p>
            <p className="text-[11px] text-slate-400">
              Drag to reorder. These fields are joined with the separator below to form the sublabel.
            </p>

            {/* Active tokens */}
            <div className="space-y-1.5">
              {tokens.map((id, idx) => {
                const tok = AVAILABLE_TOKENS.find(a => a.id === id);
                return (
                  <div
                    key={id}
                    draggable
                    onDragStart={() => handleDragStart(idx)}
                    onDragOver={e => e.preventDefault()}
                    onDrop={() => handleDrop(idx)}
                    className="flex items-center gap-3 px-4 py-3 bg-indigo-50 border border-indigo-100 rounded-2xl cursor-grab active:cursor-grabbing"
                  >
                    <GripVertical size={14} className="text-indigo-300 shrink-0" />
                    <div className="flex-1">
                      <p className="text-[12px] font-bold text-indigo-800">{tok?.label || id}</p>
                      <p className="text-[10px] text-indigo-400">e.g. {tok?.example}</p>
                    </div>
                    <button
                      onClick={() => removeToken(id)}
                      className="text-indigo-300 hover:text-red-500 transition-colors"
                    >
                      <X size={13} />
                    </button>
                  </div>
                );
              })}
            </div>

            {/* Add tokens */}
            {unusedTokens.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {unusedTokens.map(tok => (
                  <button
                    key={tok.id}
                    onClick={() => addToken(tok.id)}
                    className="flex items-center gap-1.5 px-3 py-1.5 border border-dashed border-slate-300 rounded-full text-[11px] text-slate-500 hover:border-indigo-400 hover:text-indigo-600 hover:bg-indigo-50 transition-all"
                  >
                    + {tok.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Separator */}
          <div className="space-y-2">
            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">
              Separator between fields
            </p>
            <div className="flex flex-wrap gap-2">
              {SEPARATORS.map(s => (
                <button
                  key={s.value}
                  onClick={() => setSeparator(s.value)}
                  className={`px-3 py-1.5 rounded-full text-[11px] font-mono border transition-all ${
                    separator === s.value
                      ? 'bg-indigo-600 text-white border-indigo-600'
                      : 'bg-white text-slate-500 border-slate-200 hover:border-indigo-300'
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          {/* Live preview */}
          <div className="space-y-2">
            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">
              Label preview
            </p>
            <div className="px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl">
              <div className="flex items-center gap-2">
                <Tag size={11} className="text-indigo-500 shrink-0" />
                <code className="text-[12px] text-slate-700 break-all">{preview}</code>
              </div>
              <p className="text-[10px] text-slate-400 mt-1.5">
                <span className="text-indigo-600">{parentFull}</span>
                {' / '}
                <span className="text-slate-600">{sublabel}</span>
                {' '}
                <span className="text-slate-400">[AB12C] — unique code auto-generated per project</span>
              </p>
            </div>
          </div>

          {/* Warning about existing labels */}
          <div className="flex gap-3 p-4 bg-amber-50 border border-amber-100 rounded-2xl">
            <Info size={13} className="text-amber-500 shrink-0 mt-0.5" />
            <p className="text-[11px] text-amber-700 leading-relaxed">
              Changing these settings only affects <strong>new</strong> labels. Existing labels keep their original format — the unique code ensures the system can still track them.
            </p>
          </div>

          {/* Save */}
          <button
            onClick={handleSave}
            className="w-full py-3.5 bg-slate-900 text-white rounded-[40px] text-[12px] font-bold uppercase tracking-tight hover:bg-slate-700 transition-colors"
          >
            Save settings
          </button>
        </div>
      </div>
    </div>
  );
}