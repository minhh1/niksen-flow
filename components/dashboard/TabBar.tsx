"use client";

import { useState } from "react";
import {
  Plus, Pencil, Trash2, GripVertical, Check, X,
  FileText, ListChecks, Calendar, Mail, FolderKanban, Table2, ShieldCheck
} from "lucide-react";
import * as LucideIcons from "lucide-react";

export interface RecordTab {
  id: string;
  title: string;
  icon: string;
  tab_type: string;
  linked_table_id: string | null;
  display_order: number;
}

const TAB_TYPE_ICONS: Record<string, React.ElementType> = {
  fields: FileText,
  sub_projects: FolderKanban,
  checklist: ListChecks,
  calendar: Calendar,
  emails: Mail,
  custom_table: Table2,
};

interface ExtraTab {
  id: string;
  label: string;
  icon?: React.ElementType;
}

interface Props {
  tabs: RecordTab[];
  activeTabId: string | null;
  onSelect: (tabId: string) => void;
  onAdd: () => void;
  onRename: (tabId: string, title: string) => void;
  onDelete: (tabId: string) => void;
  onReorder: (tabs: RecordTab[]) => void;
  isEditing: boolean;
  onToggleEdit: () => void;
  extraTabs?: ExtraTab[];
  onSelectExtra?: (tabId: string) => void;
}

export default function TabBar({
  tabs, activeTabId, onSelect, onAdd,
  onRename, onDelete, onReorder,
  isEditing, onToggleEdit,
  extraTabs = [], onSelectExtra,
}: Props) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

  const handleRenameStart = (tab: RecordTab) => {
    setRenamingId(tab.id);
    setRenameValue(tab.title);
  };

  const handleRenameConfirm = () => {
    if (renamingId && renameValue.trim()) {
      onRename(renamingId, renameValue.trim());
    }
    setRenamingId(null);
  };

  const handleDrop = (targetIdx: number) => {
    if (dragIdx === null || dragIdx === targetIdx) {
      setDragIdx(null); setDragOverIdx(null); return;
    }
    const reordered = [...tabs];
    const [moved] = reordered.splice(dragIdx, 1);
    reordered.splice(targetIdx, 0, moved);
    onReorder(reordered.map((t, i) => ({ ...t, display_order: i })));
    setDragIdx(null); setDragOverIdx(null);
  };

  return (
    <div className="flex items-center gap-1 border-b border-slate-100 px-6 bg-white overflow-x-auto">
      {tabs.map((tab, idx) => {
        const Icon = (LucideIcons as any)[tab.icon] || TAB_TYPE_ICONS[tab.tab_type] || FileText;
        const isActive = activeTabId === tab.id;
        const isRenaming = renamingId === tab.id;
        const isDragOver = dragOverIdx === idx && dragIdx !== idx;

        return (
          <div
            key={tab.id}
            draggable={isEditing}
            onDragStart={() => setDragIdx(idx)}
            onDragOver={e => { e.preventDefault(); setDragOverIdx(idx); }}
            onDrop={() => handleDrop(idx)}
            onDragEnd={() => { setDragIdx(null); setDragOverIdx(null); }}
            className={`flex items-center gap-2 px-4 py-3.5 border-b-2 transition-all shrink-0 cursor-pointer ${
              isActive
                ? 'border-indigo-600 text-indigo-600'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            } ${isDragOver ? 'bg-indigo-50 rounded-t-lg' : ''}`}
            onClick={() => !isRenaming && onSelect(tab.id)}
          >
            {isEditing && (
              <GripVertical size={12} className="text-slate-300 cursor-grab shrink-0" />
            )}

            <Icon size={14} className="shrink-0" />

            {isRenaming ? (
              <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
                <input
                  autoFocus
                  value={renameValue}
                  onChange={e => setRenameValue(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') handleRenameConfirm();
                    if (e.key === 'Escape') setRenamingId(null);
                  }}
                  className="text-[12px] font-medium border border-indigo-300 rounded px-1.5 py-0.5 outline-none w-24"
                />
                <button onClick={handleRenameConfirm} className="text-emerald-500 hover:text-emerald-700">
                  <Check size={12} />
                </button>
                <button onClick={() => setRenamingId(null)} className="text-slate-300 hover:text-slate-600">
                  <X size={12} />
                </button>
              </div>
            ) : (
              <span className="text-[12px] font-medium whitespace-nowrap">{tab.title}</span>
            )}

            {isEditing && !isRenaming && (
              <div className="flex items-center gap-1 ml-1" onClick={e => e.stopPropagation()}>
                <button
                  onClick={() => handleRenameStart(tab)}
                  className="p-0.5 text-slate-300 hover:text-slate-600 transition-colors"
                >
                  <Pencil size={10} />
                </button>
                <button
                  onClick={() => onDelete(tab.id)}
                  className="p-0.5 text-slate-300 hover:text-red-500 transition-colors"
                >
                  <Trash2 size={10} />
                </button>
              </div>
            )}
          </div>
        );
      })}

      {/* Add tab */}
      <button
        onClick={onAdd}
        className="flex items-center gap-1.5 px-3 py-3.5 text-slate-400 hover:text-indigo-600 transition-colors shrink-0"
      >
        <Plus size={14} />
        <span className="text-[12px] font-medium">Add tab</span>
      </button>

      {/* Fixed extra tabs (e.g. Access) — non-removable, always at end */}
      {extraTabs.map(et => {
        const isActive = activeTabId === et.id;
        const EtIcon = et.icon;
        return (
          <div
            key={et.id}
            onClick={() => onSelectExtra?.(et.id)}
            className={`flex items-center gap-2 px-4 py-3.5 border-b-2 transition-all shrink-0 cursor-pointer ${
              isActive
                ? 'border-indigo-600 text-indigo-600'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            {EtIcon && <EtIcon size={14} className="shrink-0" />}
            <span className="text-[12px] font-medium whitespace-nowrap">{et.label}</span>
          </div>
        );
      })}

      {/* Edit toggle */}
      {tabs.length > 0 && (
        <button
          onClick={onToggleEdit}
          className={`ml-auto px-3 py-2 rounded-full text-[10px] font-bold transition-all shrink-0 ${
            isEditing
              ? 'bg-indigo-600 text-white'
              : 'text-slate-400 hover:text-slate-700'
          }`}
        >
          {isEditing ? 'Done' : 'Edit tabs'}
        </button>
      )}
    </div>
  );
}