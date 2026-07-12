// components/dashboard/FieldLayoutEditor.tsx
"use client";

import { useState, useEffect, useCallback } from "react";
import { GripVertical, X, Minus, Plus, Search, ExternalLink, Pencil, ArrowUpRight } from "lucide-react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

export interface FieldLayout {
  id: string;
  field_key: string;
  field_source: 'base' | 'custom';
  label: string;
  fieldType: string;
  col_start: number;
  col_span: number;
  row_order: number;
  selectOptions?: string[];
  relationTable?: string;          // for base relation fields e.g. 'properties', 'entities'
  relationDisplayColumn?: string;  // e.g. 'street_address', 'name'
}

interface Props {
  fields: FieldLayout[];
  recordValues: Record<string, any>;
  linkedItems?: Record<string, LinkedItem[]>; // fieldId → array of linked records
  isEditing: boolean;
  onSave: (fieldKey: string, value: any) => Promise<void>;
  onAddLinked?: (fieldKey: string, item: LinkedItem) => Promise<void>;
  onRemoveLinked?: (fieldKey: string, linkedId: string) => Promise<void>;
  onLayoutChange: (fields: FieldLayout[]) => void;
  onAddField: () => void;
  onRemoveField: (fieldKey: string) => void;
}

// ── LinkedRecordModal — multi-select (one row per linked record) ─

interface LinkedItem { id: string; name: string; }

interface LinkedRecordModalProps {
  field: FieldLayout;
  selected: LinkedItem[];
  companyId: string;
  onSave: (items: LinkedItem[]) => Promise<void>;
  onClose: () => void;
}

function LinkedRecordModal({ field, selected, companyId, onSave, onClose }: LinkedRecordModalProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<LinkedItem[]>(selected);
  const isEntity = field.fieldType === 'entity';
  // For base relation fields, use relationTable and relationDisplayColumn
  const table = field.fieldType === 'relation'
    ? (field.relationTable || 'entities')
    : isEntity ? 'entities' : 'properties';
  const nameCol = field.fieldType === 'relation'
    ? (field.relationDisplayColumn || 'name')
    : isEntity ? 'name' : 'street_address';

  useEffect(() => {
    if (!query.trim()) { setResults([]); return; }
    const timer = setTimeout(async () => {
      setSearching(true);
      const { data } = await supabase
        .from(table).select(`id, ${nameCol}`)
        .eq('company_id', companyId)
        .ilike(nameCol, `%${query}%`)
        .is('deleted_at', null).limit(10);
      setResults(data || []);
      setSearching(false);
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  const toggle = (item: any) => {
    const name = item[nameCol];
    const exists = draft.find(d => d.id === item.id);
    if (exists) {
      setDraft(draft.filter(d => d.id !== item.id));
    } else {
      setDraft([...draft, { id: item.id, name }]);
    }
  };

  const handleCreateNew = () => {
    if (!query.trim()) return;
    const exists = draft.find(d => d.name.toLowerCase() === query.toLowerCase());
    if (!exists) setDraft([...draft, { id: `__new__${query.trim()}`, name: query.trim() }]);
    setQuery('');
  };

  const handleSave = async () => {
    setSaving(true);
    await onSave(draft);
    setSaving(false);
    onClose();
  };

  const exactMatch = results.some(r => r[nameCol]?.toLowerCase() === query.toLowerCase());

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-sm">
      <div className="bg-white rounded-[32px] shadow-2xl w-full max-w-md mx-4 overflow-hidden flex flex-col max-h-[80vh]">
        <div className="px-6 pt-6 pb-4 border-b border-slate-100 shrink-0">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-[13px] font-bold text-slate-800 uppercase tracking-wide">
              {isEntity ? 'Link entities' : 'Link properties'}
            </h3>
            <button onClick={onClose} className="p-1.5 text-slate-300 hover:text-slate-700"><X size={16} /></button>
          </div>

          {/* Selected chips */}
          {draft.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-3">
              {draft.map(item => (
                <span key={item.id} className="flex items-center gap-1 px-3 py-1 bg-indigo-100 text-indigo-700 rounded-full text-[11px] font-medium">
                  {item.name}
                  <button onClick={() => setDraft(draft.filter(d => d.id !== item.id))} className="ml-0.5 text-indigo-400 hover:text-indigo-700">
                    <X size={10} />
                  </button>
                </span>
              ))}
            </div>
          )}

          <div className="relative">
            <Search size={14} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
            <input autoFocus value={query} onChange={e => setQuery(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !exactMatch && query.trim()) handleCreateNew(); }}
              placeholder={isEntity ? 'Search or create entity...' : 'Search or create property...'}
              className="w-full pl-10 pr-4 py-2.5 border border-slate-200 rounded-full text-[13px] outline-none focus:border-indigo-400" />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {searching && <p className="text-center py-6 text-[11px] text-slate-400">Searching...</p>}

          {!searching && results.map(item => {
            const isSelected = draft.some(d => d.id === item.id);
            return (
              <button key={item.id} onClick={() => toggle(item)}
                className={`w-full flex items-center gap-3 px-6 py-3.5 transition-colors text-left border-b border-slate-50 last:border-0 ${isSelected ? 'bg-indigo-50' : 'hover:bg-slate-50'}`}>
                <div className={`w-4 h-4 rounded border-2 shrink-0 flex items-center justify-center ${isSelected ? 'bg-indigo-600 border-indigo-600' : 'border-slate-300'}`}>
                  {isSelected && <svg width="10" height="8" viewBox="0 0 10 8" fill="none"><path d="M1 4L3.5 6.5L9 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                </div>
                <span className={`text-[13px] font-medium ${isSelected ? 'text-indigo-700' : 'text-slate-700'}`}>{item[nameCol]}</span>
              </button>
            );
          })}

          {!searching && query.trim() && !exactMatch && (
            <button onClick={handleCreateNew}
              className="w-full flex items-center gap-3 px-6 py-3.5 hover:bg-green-50 transition-colors text-left">
              <Plus size={12} className="text-green-500 shrink-0" />
              <span className="text-[13px] text-green-700 font-medium">Create "{query}" as new {isEntity ? 'entity' : 'property'}</span>
            </button>
          )}

          {!searching && !query.trim() && results.length === 0 && (
            <p className="text-center py-8 text-[11px] text-slate-300 italic">Type to search or create</p>
          )}
        </div>

        <div className="px-6 py-4 border-t border-slate-100 flex items-center justify-between shrink-0">
          <button onClick={onClose} className="text-[11px] text-slate-400 hover:text-slate-700">Cancel</button>
          <button onClick={handleSave} disabled={saving}
            className="px-5 py-2.5 bg-indigo-600 text-white text-[11px] font-bold rounded-full hover:bg-indigo-700 disabled:opacity-50 transition-colors">
            {saving ? 'Saving...' : `Save ${draft.length > 0 ? `(${draft.length})` : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── EditableValue ──────────────────────────────────────────────────

interface EditableValueProps {
  field: FieldLayout;
  value: any;
  linkedItems?: LinkedItem[];     // for entity/property/linked fields — array of linked records
  onSave: (v: any) => Promise<void>;
  onAddLinked?: (item: LinkedItem) => Promise<void>;
  onRemoveLinked?: (id: string) => Promise<void>;
  companyId?: string;
}

// linkedItems passed directly as array from parent — no JSON parsing needed

function EditableValue({ field, value, linkedItems = [], onSave, onAddLinked, onRemoveLinked, companyId }: EditableValueProps) {
  const router = useRouter();
  const [editing, setEditing]       = useState(false);
  const [draft, setDraft]           = useState(value ?? '');
  const [saving, setSaving]         = useState(false);
  const [showModal, setShowModal]   = useState(false);
  const [editingLinked, setEditingLinked] = useState<LinkedItem | null>(null);

  // Determine the dashboard path for a linked item
  const getLinkedPath = (item: LinkedItem) => {
    const table = field.fieldType === 'entity' ? 'entities'
      : field.fieldType === 'property' ? 'properties'
      : field.relationTable || 'entities';
    return `/dashboard/${table}?id=${item.id}`;
  };

  const isLinked = field.fieldType === 'entity' || field.fieldType === 'property' || field.fieldType === 'relation';

  const handleSave = async () => {
    setSaving(true);
    await onSave(draft);
    setSaving(false);
    setEditing(false);
  };

  const handleBlur = (e: React.FocusEvent) => {
    // Close without saving if focus moves outside the field editor
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setEditing(false);
      setDraft(value ?? '');
    }
  };

  const handleLinkedSave = async (items: LinkedItem[]) => {
    if (!onAddLinked || !onRemoveLinked) return;
    setSaving(true);
    // Add new items
    for (const item of items) {
      if (!linkedItems.find(li => li.id === item.id)) {
        await onAddLinked(item);
      }
    }
    // Remove deselected items
    for (const existing of linkedItems) {
      if (!items.find(i => i.id === existing.id)) {
        await onRemoveLinked(existing.id);
      }
    }
    setSaving(false);
  };

  const displayVal = (): string | null => {
    // For base relation fields (single linked record stored as UUID)
    if (field.fieldType === 'relation') {
      return linkedItems.length > 0 ? linkedItems[0].name : null;
    }
    if (isLinked) return linkedItems.length > 0 ? linkedItems.map(i => i.name).join(', ') : null;
    if (value === null || value === undefined || value === '') return null;
    if (field.fieldType === 'boolean') return value ? 'Yes' : 'No';
    if (field.fieldType === 'currency') return `$${Number(value).toLocaleString('en-AU')}`;
    if (field.fieldType === 'date') {
      try { return new Date(value).toLocaleDateString('en-AU'); } catch { return String(value); }
    }
    return String(value);
  };

  const dv = displayVal();

  const renderEditor = () => {
    switch (field.fieldType) {
      case 'boolean':
        return (
          <select autoFocus value={String(draft)} onChange={e => setDraft(e.target.value === 'true')}
            className="flex-1 bg-slate-50 border border-indigo-300 rounded-full px-4 py-2 text-[13px] outline-none">
            <option value="true">Yes</option>
            <option value="false">No</option>
          </select>
        );
      case 'select':
        return field.selectOptions?.length ? (
          <select autoFocus value={draft} onChange={e => setDraft(e.target.value)}
            className="flex-1 bg-slate-50 border border-indigo-300 rounded-full px-4 py-2 text-[13px] outline-none">
            <option value="">— Select —</option>
            {field.selectOptions.map(opt => <option key={opt} value={opt}>{opt}</option>)}
          </select>
        ) : (
          <input autoFocus type="text" value={draft} onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') { setEditing(false); setDraft(value ?? ''); } }}
            className="flex-1 bg-slate-50 border border-indigo-300 rounded-full px-4 py-2 text-[13px] outline-none" />
        );
      case 'date':
        return (
          <input autoFocus type="date" value={draft ? String(draft).slice(0, 10) : ''} onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') { setEditing(false); setDraft(value ?? ''); } }}
            className="flex-1 bg-slate-50 border border-indigo-300 rounded-full px-4 py-2 text-[13px] outline-none" />
        );
      case 'number':
      case 'currency':
        return (
          <div className="flex items-center flex-1 gap-2">
            {field.fieldType === 'currency' && <span className="text-slate-400 text-[13px]">$</span>}
            <input autoFocus type="number" value={draft} onChange={e => setDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') { setEditing(false); setDraft(value ?? ''); } }}
              className="flex-1 bg-slate-50 border border-indigo-300 rounded-full px-4 py-2 text-[13px] outline-none" />
          </div>
        );
      case 'email':
        return (
          <input autoFocus type="email" value={draft} onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') { setEditing(false); setDraft(value ?? ''); } }}
            className="flex-1 bg-slate-50 border border-indigo-300 rounded-full px-4 py-2 text-[13px] outline-none" />
        );
      case 'url':
        return (
          <input autoFocus type="url" value={draft} onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') { setEditing(false); setDraft(value ?? ''); } }}
            placeholder="https://"
            className="flex-1 bg-slate-50 border border-indigo-300 rounded-full px-4 py-2 text-[13px] outline-none" />
        );
      default:
        return (
          <input autoFocus type="text" value={draft} onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') { setEditing(false); setDraft(value ?? ''); } }}
            className="flex-1 bg-slate-50 border border-indigo-300 rounded-full px-4 py-2 text-[13px] outline-none" />
        );
    }
  };

  return (
    <div>
      <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">{field.label}</p>

      {isLinked ? (
        <>
          {/* Click anywhere to open modal */}
          {linkedItems.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {/* For relation (single) — click chip to change */}
              {field.fieldType === 'relation' ? (
                <div className="flex items-center gap-1.5">
                  <span className="px-3 py-1.5 bg-indigo-50 text-indigo-700 border border-indigo-100 rounded-full text-[12px] font-medium">
                    {linkedItems[0].name}
                  </span>
                  <button onClick={() => setShowModal(true)} title="Change"
                    className="p-1.5 text-slate-300 hover:text-indigo-600 transition-colors">
                    <Pencil size={12} />
                  </button>
                  <button onClick={() => router.push(getLinkedPath(linkedItems[0]))} title="Open record"
                    className="p-1.5 text-slate-300 hover:text-indigo-600 transition-colors">
                    <ArrowUpRight size={12} />
                  </button>
                </div>
              ) : (
                /* For multi (entity/property) — chips with actions + add more */
                <>
                  {linkedItems.map(item => (
                    <div key={item.id} className="flex items-center gap-0.5 pl-3 pr-1.5 py-1 bg-indigo-50 text-indigo-700 border border-indigo-100 rounded-full text-[11px] font-medium group">
                      <span>{item.name}</span>
                      {/* Edit inline */}
                      <button onClick={() => setEditingLinked(item)} title="Edit record"
                        className="ml-1 p-0.5 text-indigo-300 hover:text-indigo-600 transition-colors opacity-0 group-hover:opacity-100">
                        <Pencil size={10} />
                      </button>
                      {/* Open in dashboard */}
                      <button onClick={() => router.push(getLinkedPath(item))} title="Open record"
                        className="p-0.5 text-indigo-300 hover:text-indigo-600 transition-colors opacity-0 group-hover:opacity-100">
                        <ArrowUpRight size={10} />
                      </button>
                      {/* Remove */}
                      {onRemoveLinked && (
                        <button onClick={() => onRemoveLinked(item.id)} title="Remove link"
                          className="p-0.5 text-indigo-300 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100">
                          <X size={10} />
                        </button>
                      )}
                    </div>
                  ))}
                  <button onClick={() => setShowModal(true)}
                    className="flex items-center gap-1 px-3 py-1 border border-dashed border-indigo-300 text-indigo-400 rounded-full text-[11px] hover:border-indigo-500 hover:text-indigo-600 transition-colors">
                    <Plus size={10} /> Add
                  </button>
                </>
              )}
            </div>
          ) : (
            /* Empty state — same as regular fields */
            <button onClick={() => setShowModal(true)}
              className="flex items-center gap-2 group/field text-left w-full">
              <span className="text-[14px] font-medium text-slate-300 italic group-hover/field:text-indigo-400 transition-colors">
                Click to edit
              </span>
            </button>
          )}
          {showModal && (
            <LinkedRecordModal
              field={field}
              selected={linkedItems}
              companyId={companyId || ''}
              onSave={handleLinkedSave}
              onClose={() => setShowModal(false)}
            />
          )}
          {editingLinked && (
            <LinkedRecordEditModal
              item={editingLinked}
              field={field}
              companyId={companyId || ''}
              onClose={() => setEditingLinked(null)}
            />
          )}
        </>
      ) : editing ? (
        <div className="flex items-center gap-2" onBlur={handleBlur}>
          {renderEditor()}
          <button onClick={handleSave} disabled={saving}
            className="px-3 py-2 bg-indigo-600 text-white rounded-full text-[10px] font-bold disabled:opacity-50 shrink-0">
            {saving ? '...' : 'Save'}
          </button>
        </div>
      ) : (
        <button onClick={() => { setEditing(true); setDraft(value ?? ''); }}
          className="flex items-center gap-2 group/field text-left w-full">
          <span className={`text-[14px] font-medium transition-colors ${dv ? 'text-slate-800 group-hover/field:text-indigo-600' : 'text-slate-300 italic'}`}>
            {field.fieldType === 'url' && dv
              ? <a href={dv} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}
                  className="text-indigo-600 hover:underline text-[13px]">{dv}</a>
              : dv || 'Click to edit'}
          </span>
        </button>
      )}
    </div>
  );
}

// ── LinkedRecordEditModal — edit a linked record inline ──────────
interface LinkedRecordEditModalProps {
  item: LinkedItem;
  field: FieldLayout;
  companyId: string;
  onClose: () => void;
}

// Related table config
interface RelatedTableConfig {
  table: string;
  label: string;
  fkCol: string;
  displayCols: { key: string; label: string }[];
  editableCols: { key: string; label: string; type: string; options?: string[] }[];
}

const RELATED_TABLES: Record<string, RelatedTableConfig[]> = {
  entities: [
    {
      table: 'entity_officeholders',
      label: 'Officeholders',
      fkCol: 'entity_id',
      displayCols: [
        { key: 'name', label: 'Name' },
        { key: 'role', label: 'Role' },
        { key: 'appointed_date', label: 'Appointed' },
      ],
      editableCols: [
        { key: 'name', label: 'Name', type: 'text' },
        { key: 'role', label: 'Role', type: 'select', options: ['Director', 'Secretary', 'Public Officer', 'Shareholder', 'Trustee', 'Beneficiary', 'Other'] },
        { key: 'appointed_date', label: 'Appointed date', type: 'date' },
        { key: 'resigned_date', label: 'Resigned date', type: 'date' },
      ],
    },
    {
      table: 'entity_relationships',
      label: 'Relationships',
      fkCol: 'entity_id',
      displayCols: [
        { key: 'related_entity_name', label: 'Related entity' },
        { key: 'relationship_type', label: 'Type' },
      ],
      editableCols: [
        { key: 'related_entity_name', label: 'Related entity', type: 'text' },
        { key: 'relationship_type', label: 'Relationship type', type: 'text' },
      ],
    },
  ],
  properties: [],
};

// ── RelatedRowEditor — inline edit/add for a related table row ────
interface RelatedRowEditorProps {
  config: RelatedTableConfig;
  parentId: string;
  row?: any; // null = new row
  onSave: () => void;
  onBack: () => void;
}

function RelatedRowEditor({ config, parentId, row, onSave, onBack }: RelatedRowEditorProps) {
  const [draft, setDraft] = useState<Record<string, any>>(row ? { ...row } : {});
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    if (row?.id) {
      await supabase.from(config.table).update(draft).eq('id', row.id);
    } else {
      await supabase.from(config.table).insert({ ...draft, [config.fkCol]: parentId });
    }
    setSaving(false);
    onSave();
  };

  const handleDelete = async () => {
    if (!row?.id || !window.confirm('Delete this record?')) return;
    await supabase.from(config.table).delete().eq('id', row.id);
    onSave();
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-8 pt-8 pb-4 border-b border-slate-100 shrink-0">
        <button onClick={onBack} className="p-1.5 text-slate-400 hover:text-slate-700 transition-colors">
          ← Back
        </button>
        <h4 className="text-[13px] font-bold text-slate-800">
          {row ? 'Edit' : 'Add'} {config.label.slice(0, -1)}
        </h4>
        {row && (
          <button onClick={handleDelete} className="ml-auto text-[11px] text-red-400 hover:text-red-600">
            Delete
          </button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto px-8 py-6 space-y-5">
        {config.editableCols.map(col => (
          <div key={col.key}>
            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">{col.label}</p>
            {col.type === 'select' && col.options ? (
              <select
                value={draft[col.key] || ''}
                onChange={e => setDraft(p => ({ ...p, [col.key]: e.target.value }))}
                className="w-full px-4 py-2.5 border border-slate-200 rounded-full text-[13px] outline-none focus:border-indigo-400 bg-white">
                <option value="">— Select —</option>
                {col.options.map(o => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : (
              <input
                type={col.type === 'date' ? 'date' : 'text'}
                value={draft[col.key] || ''}
                onChange={e => setDraft(p => ({ ...p, [col.key]: e.target.value }))}
                className="w-full px-4 py-2.5 border border-slate-200 rounded-full text-[13px] outline-none focus:border-indigo-400"
              />
            )}
          </div>
        ))}
      </div>
      <div className="px-8 py-5 border-t border-slate-100 shrink-0">
        <button onClick={handleSave} disabled={saving}
          className="w-full py-3 bg-indigo-600 text-white text-[12px] font-bold rounded-full hover:bg-indigo-700 disabled:opacity-50 transition-colors">
          {saving ? 'Saving...' : row ? 'Save changes' : 'Add'}
        </button>
      </div>
    </div>
  );
}

function LinkedRecordEditModal({ item, field, companyId, onClose }: LinkedRecordEditModalProps) {
  const router = useRouter();
  const [record, setRecord] = useState<Record<string, any> | null>(null);
  const [schemaCols, setSchemaCols] = useState<any[]>([]);
  const [relatedData, setRelatedData] = useState<Record<string, any[]>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  // Navigation within modal: null = main view, else {config, row} for editing
  const [editingRelated, setEditingRelated] = useState<{ config: RelatedTableConfig; row?: any } | null>(null);

  const table = field.fieldType === 'entity' ? 'entities'
    : field.fieldType === 'property' ? 'properties'
    : field.relationTable || 'entities';

  const dashboardPath = `/dashboard/${table}?id=${item.id}`;
  const relatedTables = RELATED_TABLES[table] || [];

  const load = async () => {
    setLoading(true);
    const [{ data: rec }, { data: cols }, ...relatedResults] = await Promise.all([
      supabase.from(table).select('*').eq('id', item.id).single(),
      supabase.rpc('get_schema_metadata', { target_table: table, p_company_id: companyId }),
      ...relatedTables.map(rt =>
        supabase.from(rt.table)
          .select('*')
          .eq(rt.fkCol, item.id)
      ),
    ]);
    setRecord(rec);
    setSchemaCols((cols || []).filter((c: any) =>
      c.category === 'data' && !c.is_hidden &&
      !['deleted_at', 'company_id', 'created_at', 'access_mode'].includes(c.column_name)
    ));
    const relMap: Record<string, any[]> = {};
    relatedTables.forEach((rt, i) => { relMap[rt.table] = (relatedResults[i] as any)?.data || []; });
    setRelatedData(relMap);
    setLoading(false);
  };

  useEffect(() => { load(); }, [item.id]);

  const handleFieldSave = async (colKey: string, value: any) => {
    setSaving(colKey);
    await supabase.from(table).update({ [colKey]: value || null }).eq('id', item.id);
    setRecord(prev => prev ? { ...prev, [colKey]: value } : prev);
    setSaving(null);
  };

  const mapType = (col: any): string => {
    if (col.data_type === 'boolean') return 'boolean';
    if (col.data_type?.includes('timestamp')) return 'date';
    if (['numeric', 'integer'].includes(col.data_type)) return 'number';
    return 'text';
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/30 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-white rounded-t-[40px] sm:rounded-[40px] shadow-2xl w-full max-w-2xl mx-0 sm:mx-4 max-h-[90vh] flex flex-col overflow-hidden">

        {/* When editing a related row — show editor view */}
        {editingRelated ? (
          <RelatedRowEditor
            config={editingRelated.config}
            parentId={item.id}
            row={editingRelated.row}
            onBack={() => setEditingRelated(null)}
            onSave={() => { setEditingRelated(null); load(); }}
          />
        ) : (
          <>
            {/* Header */}
            <div className="flex items-center justify-between px-8 pt-8 pb-4 border-b border-slate-100 shrink-0">
              <div>
                <h3 className="text-[15px] font-light text-slate-900 tracking-tight">{item.name}</h3>
                <p className="text-[10px] text-slate-400 uppercase font-bold tracking-widest mt-0.5">{table}</p>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => router.push(dashboardPath)} title="Open full record"
                  className="p-2 text-slate-300 hover:text-indigo-600 transition-colors">
                  <ArrowUpRight size={16} />
                </button>
                <button onClick={onClose} className="p-2 text-slate-300 hover:text-slate-700 transition-colors">
                  <X size={16} />
                </button>
              </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto px-8 py-6 space-y-8">
              {loading ? (
                <p className="text-[11px] text-slate-400 text-center py-8">Loading...</p>
              ) : (
                <>
                  {/* Main fields */}
                  <div className="grid grid-cols-2 gap-x-8 gap-y-6">
                    {schemaCols.map(col => (
                      <EditableValue
                        key={col.column_name}
                        field={{
                          id: col.column_name,
                          field_key: col.column_name,
                          field_source: 'base',
                          label: col.label || col.column_name.replace(/_/g, ' '),
                          fieldType: mapType(col),
                          col_start: 1, col_span: 6, row_order: 0,
                        }}
                        value={record?.[col.column_name]}
                        onSave={v => handleFieldSave(col.column_name, v)}
                        companyId={companyId}
                      />
                    ))}
                  </div>

                  {/* Related tables */}
                  {relatedTables.map(rt => {
                    const rows = relatedData[rt.table] || [];
                    return (
                      <div key={rt.table}>
                        <div className="flex items-center justify-between mb-3">
                          <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">
                            {rt.label} ({rows.length})
                          </p>
                          <button
                            onClick={() => setEditingRelated({ config: rt })}
                            className="flex items-center gap-1 text-[11px] text-indigo-600 hover:text-indigo-800 font-medium">
                            <Plus size={11} /> Add
                          </button>
                        </div>
                        {rows.length === 0 ? (
                          <p className="text-[11px] text-slate-300 italic">None recorded</p>
                        ) : (
                          <div className="space-y-2">
                            {rows.map((row: any) => (
                              <button key={row.id}
                                onClick={() => setEditingRelated({ config: rt, row })}
                                className="w-full flex items-center gap-3 px-4 py-3 bg-slate-50 hover:bg-indigo-50 rounded-2xl text-left transition-colors group">
                                <div className="flex-1 flex flex-wrap gap-3">
                                  {rt.displayCols.map(col => row[col.key] && (
                                    <span key={col.key} className="text-[12px] text-slate-700">
                                      {col.key.includes('date')
                                        ? new Date(row[col.key]).toLocaleDateString('en-AU')
                                        : String(row[col.key])}
                                    </span>
                                  ))}
                                </div>
                                <Pencil size={12} className="text-slate-300 group-hover:text-indigo-400 shrink-0 opacity-0 group-hover:opacity-100 transition-all" />
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── FieldLayoutEditor ──────────────────────────────────────────────

export default function FieldLayoutEditor({
  fields, recordValues, linkedItems = {}, isEditing,
  onSave, onAddLinked, onRemoveLinked, onLayoutChange, onAddField, onRemoveField,
}: Props) {
  const [draggedKey, setDraggedKey]   = useState<string | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  const [companyId, setCompanyId]     = useState('');

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) return;
      supabase.from('profiles').select('active_company_id').eq('id', user.id).single()
        .then(({ data }) => { if (data?.active_company_id) setCompanyId(data.active_company_id); });
    });
  }, []);

  const handleDrop = (targetKey: string) => {
    if (!draggedKey || draggedKey === targetKey) { setDraggedKey(null); setDragOverKey(null); return; }
    const reordered = [...fields];
    const fromIdx = reordered.findIndex(f => f.field_key === draggedKey);
    const toIdx   = reordered.findIndex(f => f.field_key === targetKey);
    const [moved] = reordered.splice(fromIdx, 1);
    reordered.splice(toIdx, 0, moved);
    onLayoutChange(reordered.map((f, i) => ({ ...f, row_order: i })));
    setDraggedKey(null); setDragOverKey(null);
  };

  const changeSpan = (fieldKey: string, delta: number) => {
    onLayoutChange(fields.map(f =>
      f.field_key === fieldKey
        ? { ...f, col_span: Math.min(12, Math.max(3, f.col_span + delta)) }
        : f
    ));
  };

  // Pack into 12-col rows
  const rows: FieldLayout[][] = [];
  let currentRow: FieldLayout[] = [];
  let currentWidth = 0;
  const sorted = [...fields].sort((a, b) => a.row_order - b.row_order);

  sorted.forEach(field => {
    if (currentWidth + field.col_span > 12) {
      if (currentRow.length) rows.push(currentRow);
      currentRow = [field];
      currentWidth = field.col_span;
    } else {
      currentRow.push(field);
      currentWidth += field.col_span;
    }
  });
  if (currentRow.length) rows.push(currentRow);

  const getFieldValue = (field: FieldLayout) =>
    field.field_source === 'custom'
      ? recordValues[field.id] ?? recordValues[field.field_key] ?? null
      : recordValues[field.field_key] ?? null;

  const getSaveKey = (field: FieldLayout) =>
    field.field_source === 'custom' ? field.id : field.field_key;

  if (fields.length === 0 && !isEditing) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-3">
        <p className="text-[11px] text-slate-300 font-bold uppercase tracking-widest">No fields in this tab</p>
        <button onClick={onAddField} className="text-indigo-600 text-[11px] font-bold hover:underline">Add a field</button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {rows.map((row, rowIdx) => (
        <div key={rowIdx} className="grid grid-cols-12 gap-5">
          {row.map(field => {
            const isDragOver = dragOverKey === field.field_key;
            return (
              <div
                key={field.field_key}
                draggable={isEditing}
                onDragStart={() => setDraggedKey(field.field_key)}
                onDragOver={e => { e.preventDefault(); setDragOverKey(field.field_key); }}
                onDrop={() => handleDrop(field.field_key)}
                onDragEnd={() => { setDraggedKey(null); setDragOverKey(null); }}
                style={{ gridColumn: `span ${field.col_span}` }}
                className={`relative group/field transition-all ${
                  isEditing
                    ? `border-2 rounded-2xl p-4 ${isDragOver ? 'border-indigo-500 bg-indigo-50/30' : 'border-dashed border-slate-200 hover:border-slate-300'}`
                    : 'py-2'
                }`}
              >
                {isEditing && (
                  <div className="flex items-center justify-between mb-2">
                    <GripVertical size={14} className="text-slate-300 cursor-grab active:cursor-grabbing" />
                    <div className="flex items-center gap-1">
                      <button onClick={() => changeSpan(field.field_key, -3)} disabled={field.col_span <= 3}
                        className="p-1 text-slate-300 hover:text-slate-600 disabled:opacity-30 transition-colors">
                        <Minus size={12} />
                      </button>
                      <span className="text-[9px] text-slate-300 font-mono w-8 text-center">{field.col_span}/12</span>
                      <button onClick={() => changeSpan(field.field_key, 3)} disabled={field.col_span >= 12}
                        className="p-1 text-slate-300 hover:text-slate-600 disabled:opacity-30 transition-colors">
                        <Plus size={12} />
                      </button>
                      <button onClick={() => onRemoveField(field.field_key)}
                        className="p-1 text-slate-300 hover:text-red-500 transition-colors ml-1">
                        <X size={12} />
                      </button>
                    </div>
                  </div>
                )}

                <EditableValue
                  field={field}
                  value={getFieldValue(field)}
                  linkedItems={linkedItems[field.id] || linkedItems[field.field_key] || []}
                  onSave={v => onSave(getSaveKey(field), v)}
                  onAddLinked={onAddLinked ? (item) => onAddLinked(field.field_source === 'base' ? field.field_key : field.id, item) : undefined}
                  onRemoveLinked={onRemoveLinked ? (id) => onRemoveLinked(field.field_source === 'base' ? field.field_key : field.id, id) : undefined}
                  companyId={companyId}
                />
              </div>
            );
          })}
        </div>
      ))}

      {isEditing && (
        <button onClick={onAddField}
          className="w-full py-4 border-2 border-dashed border-slate-200 rounded-2xl text-[11px] font-bold text-slate-400 hover:border-indigo-300 hover:text-indigo-600 transition-all">
          + Add field
        </button>
      )}
    </div>
  );
}