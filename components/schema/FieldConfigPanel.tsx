"use client";

import { useState, useEffect } from "react";
import { X, Check, Loader2, Trash2 } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useCustomTables } from "@/lib/hooks/useCustomTables";
import type { CustomField, FieldType } from "./types";
import { getFieldTypeConfig } from "./types"

const RELATION_TYPES: FieldType[] = ['table_relation', 'property', 'entity', 'project', 'link'];

// Native, text-ish columns worth offering as extra search fields or a
// restrict-to filter for a relation linked to a system table (see
// lib/columnDefinitions.ts for the full column lists -- these are the
// subset that make sense to ilike/eq against from a picker).
const SEARCH_COLUMNS: Record<string, string[]> = {
  properties: ['street_address', 'suburb', 'postcode', 'folio_identifier'],
  entities: ['name', 'entity_type', 'acn', 'abn'],
  projects: ['name', 'description'],
};
const FILTER_COLUMNS: Record<string, string[]> = {
  properties: ['is_sold'],
  entities: ['entity_type', 'linked_profile_id'],
  projects: [],
};
// Sentinel linked_filter_value for linked_profile_id -- resolved to the
// actual signed-in user's id at query time in RelationPicker (there's no
// meaningful static value an admin could type in for "whoever is signed
// in"). Also drives RelationPicker's auto-select: since this filter can
// only ever match zero or one row (an entity's linked_profile_id is the
// current user's own), it's picked automatically instead of making the
// user search for themselves.
const CURRENT_USER_SENTINEL = '$current_user';
// Mirrors components/NewEntityModal.tsx's ENTITY_TYPES -- offered as a
// convenience dropdown when filtering entities by entity_type (e.g. a
// "Staff" field restricted to entity_type = 'Staff').
const ENTITY_TYPE_VALUES = [
  'Company', 'Individual', 'Discretionary Family Trust', 'Fixed Unit Trust',
  'Lawyer', 'Accountant', 'Mortgage Broker', 'Real Estate Agent',
  'Local Council', 'Bank', 'Staff', 'Other',
];

function prettifyColumn(col: string): string {
  return col.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// True if `fromFieldId` (transitively, via its own formula_field_a_id/b_id)
// depends on `targetFieldId` -- used to keep a field's Field A/B pickers
// from offering anything that would create a circular formula (e.g. A = 50%
// of B, B = 50% of A). The picker already excludes the field itself
// (direct self-reference); this catches indirect cycles through any chain
// length. computeFormulaFields (lib/services/customTableService.ts) can't
// infinite-loop on a cycle -- it's a single forward pass, not recursive --
// but it silently produces one-step-stale, order-dependent numbers, which
// is confusing enough to prevent at configuration time instead.
function dependsOnField(fromFieldId: string, targetFieldId: string, fields: CustomField[], visited: Set<string> = new Set()): boolean {
  if (visited.has(fromFieldId)) return false;
  visited.add(fromFieldId);
  const field = fields.find(f => f.id === fromFieldId);
  if (!field) return false;
  const deps = [field.formula_field_a_id, field.formula_field_b_id].filter((id): id is string => !!id);
  if (deps.includes(targetFieldId)) return true;
  return deps.some(depId => dependsOnField(depId, targetFieldId, fields, visited));
}

// ── Auto numbering (custom tables) ──────────────────────────────────
// Server-side sequences on company_table_fields (see
// supabase/company_table_field_sequences.sql) -- distinct from the
// auto_generate/auto_id system used by the system tables above. A preset is
// just a (prefix, pad) pair; the counter start is set separately.
const AUTO_NUMBER_PRESETS = [
  { v: 'plain',    label: 'Sequential — 1, 2, 3…',              prefix: '',        pad: 1 },
  { v: 'padded',   label: 'Padded number — 000001',             prefix: '',        pad: 6 },
  { v: 'year',     label: 'Year code — 260001 (yy + counter)',  prefix: '{YY}',    pad: 4 },
  { v: 'fullyear', label: 'Full year — 2026-0001',              prefix: '{YYYY}-', pad: 4 },
  { v: 'prefixed', label: 'Prefix — LD-0001',                   prefix: 'LD-',     pad: 4 },
];

function detectAutoNumberPreset(f: CustomField): string {
  if (f.auto_number_prefix == null) return 'off';
  const pad = f.auto_number_pad ?? 6;
  const match = AUTO_NUMBER_PRESETS.find(p => p.prefix === f.auto_number_prefix && p.pad === pad);
  return match ? match.v : 'custom';
}

function autoNumberExample(f: CustomField): string {
  const now = new Date();
  const prefix = (f.auto_number_prefix || '')
    .replace('{YYYY}', String(now.getFullYear()))
    .replace('{YY}', String(now.getFullYear()).slice(-2))
    .replace('{MM}', String(now.getMonth() + 1).padStart(2, '0'));
  const n = String(f.auto_number_start ?? 1);
  return prefix + n.padStart(Math.max(f.auto_number_pad ?? 6, n.length), '0');
}

interface Props {
  field: CustomField;
  siblingFields?: CustomField[];
  onSave: (updates: Partial<CustomField>) => Promise<void>;
  onDelete: () => Promise<void>;
  onClose: () => void;
}

export default function FieldConfigPanel({ field, siblingFields = [], onSave, onDelete, onClose }: Props) {
  const { tables: customTables } = useCustomTables();
  const [draft, setDraft] = useState<CustomField>({ ...field });
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [selectOptionsText, setSelectOptionsText] = useState(
    field.select_options?.join('\n') || ''
  );
  const [customFieldOptions, setCustomFieldOptions] = useState<{ id: string; label: string }[]>([]);

  const update = (key: keyof CustomField, value: any) =>
    setDraft(prev => ({ ...prev, [key]: value }));

  // Candidate custom fields (e.g. "Matter Number" on projects) that can be
  // added as an extra search field alongside the display field.
  useEffect(() => {
    const table = draft.linked_table;
    if (!table || !SEARCH_COLUMNS[table]) { setCustomFieldOptions([]); return; }
    let active = true;
    supabase
      .from('company_custom_fields')
      .select('id, label')
      .eq('table_name', table)
      .is('deleted_at', null)
      .order('display_order')
      .then(({ data }) => { if (active) setCustomFieldOptions(data || []); });
    return () => { active = false; };
  }, [draft.linked_table]);

  const toggleSearchField = (key: string) => {
    const current = draft.linked_search_field_keys || [];
    update('linked_search_field_keys', current.includes(key) ? current.filter(k => k !== key) : [...current, key]);
  };

  const applyAutoNumberPreset = (v: string) => {
    if (v === 'off') { update('auto_number_prefix', null); return; }
    const preset = AUTO_NUMBER_PRESETS.find(p => p.v === v);
    if (!preset) {
      // 'custom' -- keep whatever's there, just make sure numbering is on
      if (draft.auto_number_prefix == null) update('auto_number_prefix', '');
      return;
    }
    setDraft(prev => ({ ...prev, auto_number_prefix: preset.prefix, auto_number_pad: preset.pad }));
  };

  const handleSave = async () => {
    setSaving(true);
    const updates = { ...draft };
    if (updates.field_type === 'select') {
      updates.select_options = selectOptionsText
        .split('\n').map(s => s.trim()).filter(Boolean);
    }
    await onSave(updates);
    setSaving(false);
  };

  const ftConfig = getFieldTypeConfig(draft.field_type);
  const FtIcon = ftConfig.icon;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between p-5 border-b border-slate-100">
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-xl ${ftConfig.color}`}>
            <FtIcon size={16} />
          </div>
          <div>
            <p className="text-[13px] font-bold text-slate-800 truncate max-w-[140px]">
              {draft.label || 'Untitled field'}
            </p>
            <p className="text-[10px] text-slate-400 uppercase font-bold">{ftConfig.label}</p>
          </div>
        </div>
        <button onClick={onClose} className="p-1.5 text-slate-300 hover:text-slate-600 transition-colors">
          <X size={16} />
        </button>
      </div>

      {/* Config form */}
      <div className="flex-1 overflow-y-auto p-5 space-y-5">

        {/* Label */}
        <div>
          <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block mb-1.5">
            Field label
          </label>
          <input
            value={draft.label}
            onChange={e => update('label', e.target.value)}
            className="w-full bg-slate-50 border border-slate-200 rounded-full py-2.5 px-4 text-sm font-medium outline-none focus:ring-2 focus:ring-indigo-100"
          />
        </div>

        {/* Help text */}
        <div>
          <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block mb-1.5">
            Help text
          </label>
          <input
            value={draft.help_text || ''}
            onChange={e => update('help_text', e.target.value || null)}
            placeholder="Shown below the field"
            className="w-full bg-slate-50 border border-slate-200 rounded-full py-2.5 px-4 text-sm font-medium outline-none focus:ring-2 focus:ring-indigo-100"
          />
        </div>

        {/* Section */}
        <div>
          <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block mb-1.5">
            Section / group
          </label>
          <input
            value={draft.section_name || ''}
            onChange={e => update('section_name', e.target.value || null)}
            placeholder="e.g. Financial details"
            className="w-full bg-slate-50 border border-slate-200 rounded-full py-2.5 px-4 text-sm font-medium outline-none focus:ring-2 focus:ring-indigo-100"
          />
        </div>

        {/* Grid width — system tables only */}
        {!field.isCustomTable && (
          <div>
            <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block mb-1.5">
              Width
            </label>
            <div className="flex gap-2">
              {[{ v: 1, l: 'Full' }, { v: 2, l: 'Half' }, { v: 3, l: 'Third' }].map(opt => (
                <button
                  key={opt.v}
                  onClick={() => update('grid_width', opt.v)}
                  className={`flex-1 py-2 rounded-full text-[10px] font-bold transition-all ${
                    draft.grid_width === opt.v
                      ? 'bg-indigo-600 text-white'
                      : 'bg-slate-50 text-slate-500 hover:bg-slate-100'
                  }`}
                >
                  {opt.l}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Select options */}
        {draft.field_type === 'select' && (
          <div>
            <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block mb-1.5">
              Options (one per line)
            </label>
            <textarea
              value={selectOptionsText}
              onChange={e => setSelectOptionsText(e.target.value)}
              rows={5}
              placeholder={"Option A\nOption B\nOption C"}
              className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-2.5 px-4 text-sm font-medium outline-none focus:ring-2 focus:ring-indigo-100 resize-none"
            />
          </div>
        )}

        {/* Relation config */}
        {RELATION_TYPES.includes(draft.field_type) && (
          <div className="space-y-3">
            <div>
              <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block mb-1.5">
                Link to table
              </label>
              <select
                value={draft.linked_table || draft.linked_table_id || ''}
                onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {  // ← HERE
                  const val = e.target.value;
                  const isSystem = ['properties', 'entities', 'projects'].includes(val);
                  if (isSystem) {
                    update('linked_table', val);
                    update('linked_table_id', null);
                    update('linked_display_column',
                      val === 'properties' ? 'street_address' : 'name'
                    );
                  } else if (val) {
                    update('linked_table', null);
                    update('linked_table_id', val);
                    update('linked_display_column', 'name');
                  } else {
                    update('linked_table', null);
                    update('linked_table_id', null);
                  }

                }}
                className="w-full bg-slate-50 border border-slate-200 rounded-full py-2.5 px-4 text-sm font-medium outline-none appearance-none"
              >
                <option value="">Select a table...</option>
                <optgroup label="System tables">
                  <option value="properties">Properties</option>
                  <option value="entities">Entities</option>
                  <option value="projects">Projects</option>
                </optgroup>
                {customTables.length > 0 && (
                  <optgroup label="Custom tables">
                    {customTables.map(t => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </optgroup>
                )}
              </select>
            </div>

            <div>
              <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block mb-1.5">
                Display field
              </label>
              <input
                value={draft.linked_display_column || ''}
                onChange={e => update('linked_display_column', e.target.value || null)}
                placeholder={draft.linked_table === 'properties' ? 'street_address' : 'name'}
                className="w-full bg-slate-50 border border-slate-200 rounded-full py-2.5 px-4 text-sm font-medium outline-none focus:ring-2 focus:ring-indigo-100"
              />
              <p className="text-[10px] text-slate-400 mt-1 px-1">
                Which field from the linked record to display
              </p>
            </div>

            {/* Search fields + restrict-to filter -- system-table relations
                on custom-table fields only (see
                supabase/company_table_fields_relation_config.sql). */}
            {draft.isCustomTable && draft.linked_table && SEARCH_COLUMNS[draft.linked_table] && (
              <>
                <div>
                  <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block mb-1.5">
                    Also search by
                  </label>
                  <div className="space-y-1.5">
                    {SEARCH_COLUMNS[draft.linked_table].map(col => (
                      <label key={col} className="flex items-center gap-2.5 cursor-pointer group">
                        <div
                          onClick={() => toggleSearchField(col)}
                          className={`w-4 h-4 rounded border-2 flex items-center justify-center transition-all cursor-pointer shrink-0 ${
                            (draft.linked_search_field_keys || []).includes(col)
                              ? 'bg-indigo-600 border-indigo-600'
                              : 'border-slate-200 group-hover:border-indigo-300'
                          }`}
                        >
                          {(draft.linked_search_field_keys || []).includes(col) && <Check size={10} className="text-white" />}
                        </div>
                        <span className="text-[12px] font-medium text-slate-600">{prettifyColumn(col)}</span>
                      </label>
                    ))}
                    {customFieldOptions.map(cf => {
                      const key = `cf:${cf.id}`;
                      return (
                        <label key={key} className="flex items-center gap-2.5 cursor-pointer group">
                          <div
                            onClick={() => toggleSearchField(key)}
                            className={`w-4 h-4 rounded border-2 flex items-center justify-center transition-all cursor-pointer shrink-0 ${
                              (draft.linked_search_field_keys || []).includes(key)
                                ? 'bg-indigo-600 border-indigo-600'
                                : 'border-slate-200 group-hover:border-indigo-300'
                            }`}
                          >
                            {(draft.linked_search_field_keys || []).includes(key) && <Check size={10} className="text-white" />}
                          </div>
                          <span className="text-[12px] font-medium text-slate-600">{cf.label}</span>
                        </label>
                      );
                    })}
                  </div>
                  <p className="text-[10px] text-slate-400 mt-1.5 px-1">
                    Typing in the picker also matches these, e.g. a Matter Number
                  </p>
                </div>

                {FILTER_COLUMNS[draft.linked_table].length > 0 && (
                  <div>
                    <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block mb-1.5">
                      Restrict to
                    </label>
                    <select
                      value={draft.linked_filter_column || ''}
                      onChange={e => {
                        const col = e.target.value || null;
                        update('linked_filter_column', col);
                        update('linked_filter_value', col === 'linked_profile_id' ? CURRENT_USER_SENTINEL : null);
                      }}
                      className="w-full bg-slate-50 border border-slate-200 rounded-full py-2.5 px-4 text-sm font-medium outline-none appearance-none"
                    >
                      <option value="">No restriction — show all</option>
                      {FILTER_COLUMNS[draft.linked_table].map(col => (
                        <option key={col} value={col}>{col === 'linked_profile_id' ? 'Signed-in user only' : prettifyColumn(col)}</option>
                      ))}
                    </select>
                    {draft.linked_filter_column === 'entity_type' ? (
                      <select
                        value={draft.linked_filter_value || ''}
                        onChange={e => update('linked_filter_value', e.target.value || null)}
                        className="w-full mt-2 bg-slate-50 border border-slate-200 rounded-full py-2.5 px-4 text-sm font-medium outline-none appearance-none"
                      >
                        <option value="">Select a value...</option>
                        {ENTITY_TYPE_VALUES.map(v => <option key={v} value={v}>{v}</option>)}
                      </select>
                    ) : draft.linked_filter_column === 'linked_profile_id' ? (
                      <p className="mt-2 bg-indigo-50 border border-indigo-100 rounded-2xl py-2 px-3 text-[11px] font-medium text-indigo-700">
                        Only shows (and auto-fills) the entity linked to whoever is signed in — each person only sees their own, via the entity&rsquo;s &ldquo;Link to a team member&rdquo; on its detail page.
                      </p>
                    ) : draft.linked_filter_column ? (
                      <input
                        value={draft.linked_filter_value || ''}
                        onChange={e => update('linked_filter_value', e.target.value || null)}
                        placeholder="Value to match"
                        className="w-full mt-2 bg-slate-50 border border-slate-200 rounded-full py-2.5 px-4 text-sm font-medium outline-none focus:ring-2 focus:ring-indigo-100"
                      />
                    ) : null}
                    {draft.linked_filter_column && draft.linked_filter_column !== 'linked_profile_id' && (
                      <p className="text-[10px] text-slate-400 mt-1.5 px-1">
                        Only show records where {prettifyColumn(draft.linked_filter_column)} matches this
                      </p>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* Auto ID config */}
        {draft.field_type === 'auto_id' && (
          <div className="space-y-3">
            <div>
              <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block mb-1.5">
                ID format
              </label>
              <select
                value={draft.auto_generate_type || 'sequential'}
                onChange={e => update('auto_generate_type', e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 rounded-full py-2.5 px-4 text-sm font-medium outline-none appearance-none"
              >
                <option value="sequential">Sequential (1, 2, 3...)</option>
                <option value="custom_prefix">Custom prefix (e.g. PROP-001)</option>
                <option value="date_prefix">Date prefix (e.g. 2024-001)</option>
                <option value="uuid">UUID</option>
              </select>
            </div>
            {(['custom_prefix', 'date_prefix'] as string[]).includes(draft.auto_generate_type || '') && (
              <div>
                <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block mb-1.5">
                  Prefix
                </label>
                <input
                  value={draft.auto_generate_prefix || ''}
                  onChange={e => update('auto_generate_prefix', e.target.value || null)}
                  placeholder="e.g. PROP-"
                  className="w-full bg-slate-50 border border-slate-200 rounded-full py-2.5 px-4 text-sm font-medium outline-none focus:ring-2 focus:ring-indigo-100"
                />
              </div>
            )}
          </div>
        )}

        {/* Auto numbering — custom-table text fields (server-side sequence,
            see supabase/company_table_field_sequences.sql) */}
        {field.isCustomTable && draft.field_type === 'text' && !draft.formula_type && (
          <div className="space-y-3">
            <div>
              <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block mb-1.5">
                Auto numbering
              </label>
              <select
                value={detectAutoNumberPreset(draft)}
                onChange={e => applyAutoNumberPreset(e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 rounded-full py-2.5 px-4 text-sm font-medium outline-none appearance-none"
              >
                <option value="off">Off — typed by hand</option>
                {AUTO_NUMBER_PRESETS.map(p => (
                  <option key={p.v} value={p.v}>{p.label}</option>
                ))}
                <option value="custom">Custom format</option>
              </select>
            </div>
            {draft.auto_number_prefix != null && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block mb-1.5">
                      Prefix
                    </label>
                    <input
                      value={draft.auto_number_prefix}
                      onChange={e => update('auto_number_prefix', e.target.value)}
                      placeholder={'e.g. LD- or {YY}'}
                      className="w-full bg-slate-50 border border-slate-200 rounded-full py-2.5 px-4 text-sm font-medium outline-none focus:ring-2 focus:ring-indigo-100"
                    />
                  </div>
                  <div>
                    <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block mb-1.5">
                      Counter digits
                    </label>
                    <select
                      value={draft.auto_number_pad ?? 6}
                      onChange={e => update('auto_number_pad', Number(e.target.value))}
                      className="w-full bg-slate-50 border border-slate-200 rounded-full py-2.5 px-4 text-sm font-medium outline-none appearance-none"
                    >
                      {[1, 2, 3, 4, 5, 6, 7, 8].map(n => (
                        <option key={n} value={n}>{n === 1 ? 'No padding' : `${n} digits`}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <div>
                  <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block mb-1.5">
                    Starting number
                  </label>
                  <input
                    type="number"
                    min={1}
                    value={draft.auto_number_start ?? ''}
                    onChange={e => update('auto_number_start', e.target.value ? Number(e.target.value) : null)}
                    placeholder="1"
                    className="w-full bg-slate-50 border border-slate-200 rounded-full py-2.5 px-4 text-sm font-medium outline-none focus:ring-2 focus:ring-indigo-100"
                  />
                </div>
                <p className="text-[10px] text-slate-400 px-1">
                  Next number will look like{' '}
                  <span className="font-bold text-slate-600">{autoNumberExample(draft)}</span>.
                  Assigned when a record is created with this field left blank — an
                  assigned number can still be edited (tick Unique below to block
                  duplicates). The prefix understands {'{YY}'}, {'{YYYY}'} and {'{MM}'}{' '}
                  date tokens; raising the starting number jumps future numbers
                  forward, never backward.
                </p>
              </>
            )}
          </div>
        )}

        {/* Number / currency min/max */}
        {(['number', 'currency'] as FieldType[]).includes(draft.field_type) && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block mb-1.5">
                Min value
              </label>
              <input
                type="number"
                value={draft.validation_min ?? ''}
                onChange={e => update('validation_min', e.target.value ? Number(e.target.value) : null)}
                className="w-full bg-slate-50 border border-slate-200 rounded-full py-2.5 px-4 text-sm font-medium outline-none focus:ring-2 focus:ring-indigo-100"
              />
            </div>
            <div>
              <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block mb-1.5">
                Max value
              </label>
              <input
                type="number"
                value={draft.validation_max ?? ''}
                onChange={e => update('validation_max', e.target.value ? Number(e.target.value) : null)}
                className="w-full bg-slate-50 border border-slate-200 rounded-full py-2.5 px-4 text-sm font-medium outline-none focus:ring-2 focus:ring-indigo-100"
              />
            </div>
          </div>
        )}

        {/* Computed value — custom-table number/currency fields only */}
        {draft.isCustomTable && (['number', 'currency'] as FieldType[]).includes(draft.field_type) && (() => {
          // Excludes the field itself (direct self-reference) and anything
          // that already transitively depends on it (would close a cycle --
          // e.g. this field can't pick B as a dependency if B already
          // computes off this field, directly or through a longer chain).
          const numericSiblings = siblingFields.filter(
            f => f.id !== draft.id
              && (['number', 'currency'] as FieldType[]).includes(f.field_type)
              && !dependsOnField(f.id, draft.id, siblingFields)
          );
          return (
            <div className="space-y-3">
              <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block">
                Computed value
              </label>
              <div className="flex gap-2">
                {[
                  { v: null, l: 'Typed in' },
                  { v: 'multiply', l: 'Multiply' },
                  { v: 'percentage_of', l: '% of' },
                ].map(opt => (
                  <button
                    key={String(opt.v)}
                    onClick={() => {
                      update('formula_type', opt.v);
                      if (!opt.v) {
                        update('formula_field_a_id', null);
                        update('formula_field_b_id', null);
                        update('formula_percent', null);
                      }
                    }}
                    className={`flex-1 py-2 rounded-full text-[10px] font-bold transition-all ${
                      (draft.formula_type ?? null) === opt.v
                        ? 'bg-indigo-600 text-white'
                        : 'bg-slate-50 text-slate-500 hover:bg-slate-100'
                    }`}
                  >
                    {opt.l}
                  </button>
                ))}
              </div>

              {draft.formula_type === 'multiply' && (
                <div className="grid grid-cols-2 gap-2">
                  <select
                    value={draft.formula_field_a_id || ''}
                    onChange={e => update('formula_field_a_id', e.target.value || null)}
                    className="bg-slate-50 border border-slate-200 rounded-full py-2.5 px-4 text-sm font-medium outline-none appearance-none"
                  >
                    <option value="">Field A...</option>
                    {numericSiblings.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
                  </select>
                  <select
                    value={draft.formula_field_b_id || ''}
                    onChange={e => update('formula_field_b_id', e.target.value || null)}
                    className="bg-slate-50 border border-slate-200 rounded-full py-2.5 px-4 text-sm font-medium outline-none appearance-none"
                  >
                    <option value="">Field B...</option>
                    {numericSiblings.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
                  </select>
                </div>
              )}

              {draft.formula_type === 'percentage_of' && (
                <div className="grid grid-cols-2 gap-2">
                  <select
                    value={draft.formula_field_a_id || ''}
                    onChange={e => update('formula_field_a_id', e.target.value || null)}
                    className="bg-slate-50 border border-slate-200 rounded-full py-2.5 px-4 text-sm font-medium outline-none appearance-none"
                  >
                    <option value="">Of field...</option>
                    {numericSiblings.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
                  </select>
                  <div className="relative">
                    <input
                      type="number"
                      value={draft.formula_percent ?? ''}
                      onChange={e => update('formula_percent', e.target.value ? Number(e.target.value) : null)}
                      placeholder="10"
                      className="w-full bg-slate-50 border border-slate-200 rounded-full py-2.5 pl-4 pr-8 text-sm font-medium outline-none focus:ring-2 focus:ring-indigo-100"
                    />
                    <span className="absolute right-4 top-1/2 -translate-y-1/2 text-[12px] text-slate-400">%</span>
                  </div>
                </div>
              )}

              {draft.formula_type && (
                <p className="text-[10px] text-slate-400 px-1">
                  Auto-calculated — not editable by hand once saved.
                </p>
              )}
            </div>
          );
        })()}

        {/* Text regex validation -- system-table fields only, see the
            min/max comment above; same non-functional-on-custom-tables issue. */}
        {!draft.isCustomTable && draft.field_type === 'text' && (
          <div>
            <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block mb-1.5">
              Validation pattern (regex)
            </label>
            <input
              value={draft.validation_regex || ''}
              onChange={e => update('validation_regex', e.target.value || null)}
              placeholder="e.g. ^[A-Z]{2}\d{4}$"
              className="w-full bg-slate-50 border border-slate-200 rounded-full py-2.5 px-4 text-sm font-mono text-[12px] outline-none focus:ring-2 focus:ring-indigo-100"
            />
          </div>
        )}

        {/* Default value -- system-table fields only, see the min/max
            comment above; same non-functional-on-custom-tables issue. */}
        {!draft.isCustomTable && !(['auto_id', 'link', 'boolean', 'property', 'entity', 'table_relation'] as FieldType[]).includes(draft.field_type) && (
          <div>
            <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block mb-1.5">
              Default value
            </label>
            <input
              value={draft.default_value || ''}
              onChange={e => update('default_value', e.target.value || null)}
              className="w-full bg-slate-50 border border-slate-200 rounded-full py-2.5 px-4 text-sm font-medium outline-none focus:ring-2 focus:ring-indigo-100"
            />
          </div>
        )}

        {/* Constraints */}
        <div className="space-y-2">
          <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block">
            Constraints
          </label>
          {[
            { key: 'is_required',   label: 'Required — must have a value' },
            { key: 'is_unique',     label: 'Unique — no two records can share this value' },
            { key: 'show_in_table', label: 'Show in master table columns' },
          ].map(constraint => (
            <label key={constraint.key} className="flex items-center gap-3 cursor-pointer group">
              <div
                onClick={() => update(
                  constraint.key as keyof CustomField,
                  !draft[constraint.key as keyof CustomField]
                )}
                className={`w-5 h-5 rounded-md border-2 flex items-center justify-center transition-all cursor-pointer ${
                  draft[constraint.key as keyof CustomField]
                    ? 'bg-indigo-600 border-indigo-600'
                    : 'border-slate-200 group-hover:border-indigo-300'
                }`}
              >
                {draft[constraint.key as keyof CustomField] && (
                  <Check size={12} className="text-white" />
                )}
              </div>
              <span className="text-[12px] font-medium text-slate-600">{constraint.label}</span>
            </label>
          ))}
        </div>
      </div>

      {/* Footer */}
      <div className="p-5 border-t border-slate-100 flex gap-3">
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex-1 py-3 bg-slate-900 text-white rounded-full text-[11px] font-bold disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {saving ? <Loader2 size={12} className="animate-spin" /> : 'Save field'}
        </button>
        <button
          onClick={async () => {
            // onDelete (SchemaVisualisation.handleDeleteField) does its own
            // confirm with the real count of populated values, since this
            // panel has no way to know that count itself. Reset `deleting`
            // if it returns without actually deleting (user cancelled),
            // otherwise the button would spin forever.
            setDeleting(true);
            try {
              await onDelete();
            } finally {
              setDeleting(false);
            }
          }}
          disabled={deleting}
          className="p-3 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-full transition-all"
        >
          {deleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
        </button>
      </div>
    </div>
  );
}