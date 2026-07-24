"use client";

import { useState, useEffect } from "react";
import { supabase } from "@/lib/supabase";
import { Plus, Trash2, Loader2, Check, X, Settings, Pencil, Store } from "lucide-react";
import * as LucideIcons from "lucide-react";
import { useCustomTables } from "@/lib/hooks/useCustomTables";
import { logSchemaChange } from "@/lib/services/schemaChangeLog";
import { useCompany } from "@/components/CompanyContext";
import { createArchiveRequest, usePendingArchiveRequests } from "@/lib/archiveRequests";

const ICON_OPTIONS = [
  'Table2', 'FileText', 'Briefcase', 'Users', 'Home',
  'Car', 'Truck', 'Package', 'ShoppingCart', 'CreditCard',
  'BarChart2', 'PieChart', 'Calendar', 'Clock', 'Globe',
  'Map', 'Layers', 'Database', 'Server', 'Cloud',
];

const COLOR_OPTIONS = [
  '#6366f1', '#8b5cf6', '#ec4899', '#ef4444',
  '#f97316', '#eab308', '#22c55e', '#14b8a6',
  '#06b6d4', '#3b82f6',
];

export default function CustomTableBuilder() {
  const { tables, loading, refetch } = useCustomTables();
  const { isAdmin, companyId } = useCompany();
  const { pendingIds: pendingArchiveIds, refreshPendingArchiveRequests } = usePendingArchiveRequests("company_tables", companyId);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newIcon, setNewIcon] = useState('Table2');
  const [newColor, setNewColor] = useState('#6366f1');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [limit, setLimit] = useState<number | null>(null);
  const [editingTable, setEditingTable] = useState<{ id: string; name: string; icon: string; color: string } | null>(null);
  const [editName, setEditName] = useState('');
  const [editIcon, setEditIcon] = useState('Table2');
  const [editColor, setEditColor] = useState('#6366f1');
  const [editSaving, setEditSaving] = useState(false);

  useEffect(() => {
    supabase
      .from('companies')
      .select('max_custom_tables')
      .eq('id', '00000000-0000-0000-0000-000000000000') // placeholder, resolved by RLS
      .single()
      .then(({ data }) => { if (data) setLimit(data.max_custom_tables); });
  }, []);

  const handleCreate = async () => {
    if (!newName.trim()) { setError('Name is required'); return; }
    setSaving(true);
    setError('');

    const slug = newName.toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-');

    const { data: { user } } = await supabase.auth.getUser();
    const { data: prof } = await supabase
      .from('profiles').select('active_company_id').eq('id', user?.id).single();
    const companyId = prof?.active_company_id;

    const { data: created, error: err } = await supabase.from('company_tables').insert({
      company_id: companyId,
      name: newName.trim(),
      slug,
      icon: newIcon,
      color: newColor,
      display_order: tables.length,
    }).select().single();

    setSaving(false);

    if (err) {
      setError(err.message.includes('limit') ? err.message : `Could not create table: ${err.message}`);
      return;
    }

    if (created && companyId) {
      logSchemaChange({
        companyId, actorId: user?.id ?? null, entityType: 'company_table',
        entityId: created.id, entityLabel: created.name, action: 'create', after: created,
      });
    }

    setCreating(false);
    setNewName('');
    refetch();
  };

  const handleDelete = async (tableId: string, tableName: string) => {
    if (!isAdmin) {
      if (!window.confirm(`Request deleting the "${tableName}" table? A company admin will need to approve it.`)) return;
      if (!companyId) return;
      const result = await createArchiveRequest("company_tables", tableId, `Custom table: ${tableName}`, companyId);
      if (!result.ok) { window.alert(result.error); return; }
      window.alert(result.alreadyPending ? "Already requested — waiting on admin review." : "Deletion requested — a company admin will review it.");
      refreshPendingArchiveRequests();
      return;
    }

    const { count } = await supabase
      .from('company_table_records')
      .select('id', { count: 'exact', head: true })
      .eq('table_id', tableId)
      .is('deleted_at', null);
    const recordCount = count ?? 0;

    const warning = recordCount > 0
      ? `Delete "${tableName}"? It has ${recordCount} record${recordCount === 1 ? '' : 's'}. This moves it to Trash — nothing is deleted permanently, and you can restore it (with its records) from there.`
      : `Delete "${tableName}"? This moves it to Trash and can be restored later.`;
    if (!window.confirm(warning)) return;

    const { data: { user } } = await supabase.auth.getUser();
    const { data: before } = await supabase.from('company_tables').select('*').eq('id', tableId).single();

    // Soft-delete — the table and its records/fields stay in the database
    // (nothing cascades), so this is fully reversible from Trash.
    await supabase.from('company_tables').update({ deleted_at: new Date().toISOString() }).eq('id', tableId);

    if (before) {
      logSchemaChange({
        companyId: before.company_id, actorId: user?.id ?? null, entityType: 'company_table',
        entityId: tableId, entityLabel: tableName, action: 'delete', before,
      });
    }

    refetch();
  };

  const openEdit = (table: { id: string; name: string; icon: string; color: string }) => {
    setEditingTable(table);
    setEditName(table.name);
    setEditIcon(table.icon);
    setEditColor(table.color);
  };

  const handleUpdate = async () => {
    if (!editingTable || !editName.trim()) return;
    setEditSaving(true);

    const { data: { user } } = await supabase.auth.getUser();
    const { data: before } = await supabase.from('company_tables').select('*').eq('id', editingTable.id).single();

    const { data: after, error: err } = await supabase
      .from('company_tables')
      .update({ name: editName.trim(), icon: editIcon, color: editColor })
      .eq('id', editingTable.id)
      .select()
      .single();

    setEditSaving(false);

    if (err) { setError(`Could not update table: ${err.message}`); return; }

    if (before && after) {
      logSchemaChange({
        companyId: before.company_id, actorId: user?.id ?? null, entityType: 'company_table',
        entityId: editingTable.id, entityLabel: after.name, action: 'update', before, after,
      });
    }

    setEditingTable(null);
    refetch();
  };

  // Snapshots this table's current shape into a brand-new draft template —
  // a one-time copy, not a live link (see supabase/template_marketplace.sql).
  // Cross-table relations to another *custom* table aren't carried over
  // (nothing to resolve them against outside this single table's export);
  // relations to a system table (entities/projects/properties) are kept.
  const handlePublish = async (table: { id: string; name: string; icon: string; color: string; slug: string; primary_field_key: string | null }) => {
    const templateName = window.prompt(`Publish "${table.name}" to the marketplace as a new template. Template name:`, table.name);
    if (!templateName?.trim()) return;

    const { data: { user } } = await supabase.auth.getUser();
    const { data: prof } = await supabase.from('profiles').select('active_company_id').eq('id', user?.id).single();
    const companyId = prof?.active_company_id;
    if (!companyId) return;

    const { data: fields } = await supabase.from('company_table_fields').select('*').eq('table_id', table.id).is('deleted_at', null).order('display_order');

    const slug = `${templateName.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, '-')}-${Date.now().toString(36)}`;
    const { data: template, error: tErr } = await supabase.from('template_definitions').insert({
      slug, name: templateName.trim(), owner_company_id: companyId, is_published: false,
    }).select().single();
    if (tErr || !template) { alert(tErr?.message || 'Could not create template'); return; }

    const { data: templateTable, error: ttErr } = await supabase.from('template_definition_tables').insert({
      template_id: template.id, slug: table.slug, name: table.name, icon: table.icon, color: table.color,
      primary_field_key: table.primary_field_key, display_order: 0,
    }).select().single();
    if (ttErr || !templateTable) { alert(ttErr?.message || 'Could not publish table'); return; }

    if (fields && fields.length > 0) {
      await supabase.from('template_definition_table_fields').insert(fields.map(f => ({
        template_table_id: templateTable.id, field_key: f.field_key, label: f.label, field_type: f.field_type,
        select_options: f.select_options, linked_system_table: f.linked_system_table, linked_display_field: f.linked_display_field,
        is_required: f.is_required, is_unique: f.is_unique, show_in_table: f.show_in_table,
        display_order: f.display_order, section_name: f.section_name, help_text: f.help_text,
      })));
    }

    logSchemaChange({ companyId, actorId: user?.id ?? null, entityType: 'template_definition', entityId: template.id, entityLabel: template.name, action: 'create', after: template });
    alert(`Published as a draft template. Find it under Marketplace → My templates to review and publish.`);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[13px] font-bold text-slate-800">Custom tables</p>
          <p className="text-[10px] text-slate-400 mt-0.5">
            {tables.length} table{tables.length !== 1 ? 's' : ''} created
            {limit && ` · ${limit - tables.length} remaining`}
          </p>
        </div>
        <button
          onClick={() => setCreating(true)}
          className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-full text-[11px] font-bold hover:bg-indigo-700 transition-all"
        >
          <Plus size={13} /> New table
        </button>
      </div>

      {/* Existing tables */}
      <div className="space-y-2">
        {tables.map(table => {
          const Icon = (LucideIcons as any)[table.icon] || LucideIcons.Table2;
          return (
            <div key={table.id} className="flex items-center gap-4 p-4 bg-white border border-slate-200 rounded-2xl">
              <div
                className="h-9 w-9 rounded-xl flex items-center justify-center shrink-0"
                style={{ backgroundColor: `${table.color}20` }}
              >
                <Icon size={16} style={{ color: table.color }} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[13px] font-bold text-slate-800">{table.name}</p>
                <p className="text-[10px] text-slate-400">/dashboard/{table.slug}</p>
              </div>
              {pendingArchiveIds.has(table.id) && (
                <span className="px-2 py-0.5 rounded-full text-[8px] font-bold uppercase bg-amber-50 text-amber-600 whitespace-nowrap">
                  Deletion requested
                </span>
              )}
              <button
                onClick={() => handlePublish(table)}
                className="p-1.5 text-slate-300 hover:text-emerald-500 hover:bg-emerald-50 rounded-full transition-all"
                title="Publish to marketplace"
              >
                <Store size={14} />
              </button>
              <button
                onClick={() => openEdit(table)}
                className="p-1.5 text-slate-300 hover:text-indigo-500 hover:bg-indigo-50 rounded-full transition-all"
                title="Rename / re-icon"
              >
                <Pencil size={14} />
              </button>
              <button
                onClick={() => handleDelete(table.id, table.name)}
                className="p-1.5 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-full transition-all"
              >
                <Trash2 size={14} />
              </button>
            </div>
          );
        })}
        {tables.length === 0 && !loading && (
          <p className="text-center text-[11px] text-slate-300 italic py-6">
            No custom tables yet — create one to get started
          </p>
        )}
      </div>

      {/* Create modal */}
      {creating && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-md p-6">
          <div className="bg-white rounded-[40px] p-8 w-full max-w-md shadow-2xl">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-lg font-light uppercase tracking-wide text-slate-900">New table</h3>
              <button onClick={() => setCreating(false)} className="p-2 text-slate-300 hover:text-black">
                <X size={18} />
              </button>
            </div>

            <div className="space-y-5">
              <div>
                <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block mb-1.5">
                  Table name
                </label>
                <input
                  autoFocus
                  value={newName}
                  onChange={e => { setNewName(e.target.value); setError(''); }}
                  onKeyDown={e => { if (e.key === 'Enter') handleCreate(); }}
                  placeholder="e.g. Leases, Clients, Invoices"
                  className="w-full bg-slate-50 border border-slate-200 rounded-full py-3 px-5 text-sm font-medium outline-none focus:ring-4 focus:ring-indigo-100"
                />
              </div>

              <div>
                <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block mb-2">
                  Icon
                </label>
                <div className="grid grid-cols-10 gap-1.5">
                  {ICON_OPTIONS.map(iconName => {
                    const Icon = (LucideIcons as any)[iconName];
                    return (
                      <button
                        key={iconName}
                        onClick={() => setNewIcon(iconName)}
                        className={`p-2 rounded-xl transition-all ${
                          newIcon === iconName
                            ? 'bg-indigo-100 text-indigo-600'
                            : 'hover:bg-slate-100 text-slate-400'
                        }`}
                      >
                        <Icon size={16} />
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block mb-2">
                  Colour
                </label>
                <div className="flex gap-2">
                  {COLOR_OPTIONS.map(color => (
                    <button
                      key={color}
                      onClick={() => setNewColor(color)}
                      className={`w-8 h-8 rounded-full transition-all ${
                        newColor === color ? 'ring-2 ring-offset-2 ring-slate-400 scale-110' : ''
                      }`}
                      style={{ backgroundColor: color }}
                    />
                  ))}
                </div>
              </div>

              {/* Preview */}
              <div className="flex items-center gap-3 p-3 bg-slate-50 rounded-2xl">
                {(() => {
                  const Icon = (LucideIcons as any)[newIcon] || LucideIcons.Table2;
                  return (
                    <>
                      <div
                        className="h-8 w-8 rounded-xl flex items-center justify-center"
                        style={{ backgroundColor: `${newColor}20` }}
                      >
                        <Icon size={16} style={{ color: newColor }} />
                      </div>
                      <span className="text-[13px] font-bold text-slate-700">
                        {newName || 'Table name'}
                      </span>
                    </>
                  );
                })()}
              </div>

              {error && (
                <p className="text-[11px] text-red-500 font-medium">{error}</p>
              )}

              <button
                onClick={handleCreate}
                disabled={saving || !newName.trim()}
                className="w-full py-3.5 bg-slate-900 text-white rounded-full text-[11px] font-bold uppercase tracking-widest disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {saving ? <Loader2 size={14} className="animate-spin" /> : 'Create table'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit modal — rename / re-icon / re-colour an existing table */}
      {editingTable && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-md p-6">
          <div className="bg-white rounded-[40px] p-8 w-full max-w-md shadow-2xl">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-lg font-light uppercase tracking-wide text-slate-900">Edit table</h3>
              <button onClick={() => setEditingTable(null)} className="p-2 text-slate-300 hover:text-black">
                <X size={18} />
              </button>
            </div>

            <div className="space-y-5">
              <div>
                <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block mb-1.5">
                  Table name
                </label>
                <input
                  autoFocus
                  value={editName}
                  onChange={e => { setEditName(e.target.value); setError(''); }}
                  onKeyDown={e => { if (e.key === 'Enter') handleUpdate(); }}
                  className="w-full bg-slate-50 border border-slate-200 rounded-full py-3 px-5 text-sm font-medium outline-none focus:ring-4 focus:ring-indigo-100"
                />
              </div>

              <div>
                <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block mb-2">
                  Icon
                </label>
                <div className="grid grid-cols-10 gap-1.5">
                  {ICON_OPTIONS.map(iconName => {
                    const Icon = (LucideIcons as any)[iconName];
                    return (
                      <button
                        key={iconName}
                        onClick={() => setEditIcon(iconName)}
                        className={`p-2 rounded-xl transition-all ${
                          editIcon === iconName
                            ? 'bg-indigo-100 text-indigo-600'
                            : 'hover:bg-slate-100 text-slate-400'
                        }`}
                      >
                        <Icon size={16} />
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block mb-2">
                  Colour
                </label>
                <div className="flex gap-2">
                  {COLOR_OPTIONS.map(color => (
                    <button
                      key={color}
                      onClick={() => setEditColor(color)}
                      className={`w-8 h-8 rounded-full transition-all ${
                        editColor === color ? 'ring-2 ring-offset-2 ring-slate-400 scale-110' : ''
                      }`}
                      style={{ backgroundColor: color }}
                    />
                  ))}
                </div>
              </div>

              {error && (
                <p className="text-[11px] text-red-500 font-medium">{error}</p>
              )}

              <button
                onClick={handleUpdate}
                disabled={editSaving || !editName.trim()}
                className="w-full py-3.5 bg-slate-900 text-white rounded-full text-[11px] font-bold uppercase tracking-widest disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {editSaving ? <Loader2 size={14} className="animate-spin" /> : 'Save changes'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}