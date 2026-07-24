"use client";

import { useState } from "react";
import {
  X, FileText, ListChecks, Calendar, Mail,
  FolderKanban, Table2, Loader2, Plus, FileSignature, LayoutDashboard
} from "lucide-react";
import type { CustomTable } from "@/lib/hooks/useCustomTables";

export type TabTemplate = {
  type: string;
  title: string;
  icon: string;
  description: string;
  color: string;
  iconComponent: React.ElementType;
};

const TEMPLATES: TabTemplate[] = [
  {
    type: 'fields',
    title: 'Details',
    icon: 'FileText',
    description: 'Custom field layout with drag-to-resize sections',
    color: 'bg-slate-50 text-slate-600',
    iconComponent: FileText,
  },
  {
    type: 'sub_projects',
    title: 'Sub-projects',
    icon: 'FolderKanban',
    description: 'Linked child projects under this record',
    color: 'bg-indigo-50 text-indigo-600',
    iconComponent: FolderKanban,
  },
  {
    type: 'checklist',
    title: 'Checklist',
    icon: 'ListChecks',
    description: 'Task checklist linked to this project',
    color: 'bg-emerald-50 text-emerald-600',
    iconComponent: ListChecks,
  },
  {
    type: 'calendar',
    title: 'Calendar',
    icon: 'Calendar',
    description: 'Calendar view of checklist due dates',
    color: 'bg-orange-50 text-orange-600',
    iconComponent: Calendar,
  },
  {
    type: 'emails',
    title: 'Emails',
    icon: 'Mail',
    description: 'Emails assigned to this project',
    color: 'bg-red-50 text-red-600',
    iconComponent: Mail,
  },
  {
    type: 'document_templates',
    title: 'Document templates',
    icon: 'FileSignature',
    description: 'Upload Word mail-merge docs and share client fill-in links',
    color: 'bg-violet-50 text-violet-600',
    iconComponent: FileSignature,
  },
];

interface Props {
  customTables: CustomTable[];
  onAdd: (type: string, title: string, icon: string, linkedTableId?: string) => Promise<void>;
  onClose: () => void;
}

const LINKED_TABLE_TAB_TYPES = ['custom_table', 'custom_dashboard'] as const;
type LinkedTableTabType = typeof LINKED_TABLE_TAB_TYPES[number];

const LINKED_TABLE_MODES: { type: LinkedTableTabType; label: string; description: string }[] = [
  { type: 'custom_table', label: 'Grid layout', description: 'Free-form static grid, one record per row' },
  { type: 'custom_dashboard', label: 'Dashboard widgets', description: 'Charts, summary tiles, grids — same builder as company dashboards' },
];

export default function AddTabModal({ customTables, onAdd, onClose }: Props) {
  const [selected, setSelected] = useState<string | null>(null);
  const [customTitle, setCustomTitle] = useState('');
  const [linkedTableId, setLinkedTableId] = useState('');
  const [linkedTableMode, setLinkedTableMode] = useState<LinkedTableTabType>('custom_table');
  const [saving, setSaving] = useState(false);

  const selectedTemplate = TEMPLATES.find(t => t.type === selected);
  const isLinkedTableType = (LINKED_TABLE_TAB_TYPES as readonly string[]).includes(selected || '');

  const handleAdd = async () => {
    if (!selected) return;
    setSaving(true);

    const title = customTitle.trim() ||
      selectedTemplate?.title ||
      customTables.find(t => t.id === linkedTableId)?.name ||
      'New tab';

    const icon = selectedTemplate?.icon || (selected === 'custom_dashboard' ? 'LayoutDashboard' : 'Table2');

    await onAdd(
      selected,
      title,
      icon,
      isLinkedTableType ? linkedTableId || undefined : undefined
    );
    setSaving(false);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-md p-6">
      <div className="bg-white rounded-[40px] p-8 w-full max-w-xl shadow-2xl">
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-lg font-light uppercase tracking-wide text-slate-900">
            Add tab
          </h3>
          <button onClick={onClose} className="p-2 text-slate-300 hover:text-black">
            <X size={18} />
          </button>
        </div>

        {/* Templates */}
        <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-3">
          Templates
        </p>
        <div className="grid grid-cols-2 gap-3 mb-4">
          {TEMPLATES.map(template => {
            const Icon = template.iconComponent;
            const isSelected = selected === template.type;
            return (
              <button
                key={template.type}
                onClick={() => {
                  setSelected(template.type);
                  setCustomTitle(template.title);
                }}
                className={`flex items-start gap-3 p-4 rounded-2xl border-2 text-left transition-all ${
                  isSelected
                    ? 'border-indigo-500 bg-indigo-50/50'
                    : 'border-slate-100 hover:border-slate-300'
                }`}
              >
                <div className={`p-2 rounded-xl shrink-0 ${template.color}`}>
                  <Icon size={16} />
                </div>
                <div className="min-w-0">
                  <p className="text-[13px] font-bold text-slate-800">{template.title}</p>
                  <p className="text-[10px] text-slate-400 mt-0.5 leading-relaxed">
                    {template.description}
                  </p>
                </div>
              </button>
            );
          })}
        </div>

        {/* Custom table option */}
        {customTables.length > 0 && (
          <>
            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-3">
              Custom tables
            </p>
            <div className="flex gap-2 mb-3">
              {LINKED_TABLE_MODES.map(mode => {
                const isActive = linkedTableMode === mode.type;
                return (
                  <button
                    key={mode.type}
                    title={mode.description}
                    onClick={() => {
                      setLinkedTableMode(mode.type);
                      if (isLinkedTableType && linkedTableId) setSelected(mode.type);
                    }}
                    className={`px-3 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-widest transition-all ${
                      isActive
                        ? 'bg-slate-900 text-white'
                        : 'bg-slate-50 text-slate-400 hover:text-slate-600'
                    }`}
                  >
                    {mode.label}
                  </button>
                );
              })}
            </div>
            <div className="grid grid-cols-2 gap-3 mb-4">
              {customTables.map(table => {
                const isSelected = selected === linkedTableMode && linkedTableId === table.id;
                const Icon = linkedTableMode === 'custom_dashboard' ? LayoutDashboard : Table2;
                return (
                  <button
                    key={table.id}
                    onClick={() => {
                      setSelected(linkedTableMode);
                      setLinkedTableId(table.id);
                      setCustomTitle(table.name);
                    }}
                    className={`flex items-center gap-3 p-4 rounded-2xl border-2 text-left transition-all ${
                      isSelected
                        ? 'border-indigo-500 bg-indigo-50/50'
                        : 'border-slate-100 hover:border-slate-300'
                    }`}
                  >
                    <div className="p-2 rounded-xl bg-slate-50 text-slate-600 shrink-0">
                      <Icon size={16} />
                    </div>
                    <p className="text-[13px] font-bold text-slate-800 truncate">
                      {table.name}
                    </p>
                  </button>
                );
              })}
            </div>
          </>
        )}

        {/* Tab title */}
        {selected && (
          <div className="mb-5">
            <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block mb-1.5">
              Tab title
            </label>
            <input
              value={customTitle}
              onChange={e => setCustomTitle(e.target.value)}
              placeholder="Tab name..."
              className="w-full bg-slate-50 border border-slate-200 rounded-full py-3 px-5 text-sm font-medium outline-none focus:ring-4 focus:ring-indigo-100"
            />
          </div>
        )}

        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 py-3 bg-slate-50 text-slate-600 rounded-full text-[11px] font-bold"
          >
            Cancel
          </button>
          <button
            onClick={handleAdd}
            disabled={!selected || saving}
            className="flex-1 py-3 bg-slate-900 text-white rounded-full text-[11px] font-bold disabled:opacity-40 flex items-center justify-center gap-2"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
            Add tab
          </button>
        </div>
      </div>
    </div>
  );
}