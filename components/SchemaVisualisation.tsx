"use client";

import { useState, useEffect } from "react";
import { supabase } from "@/lib/supabase";
import { Plus, Store } from "lucide-react";
import { useCustomTables } from "@/lib/hooks/useCustomTables";
import { useProgressBarWhile } from "@/components/TopProgressBar";
import FieldConfigPanel from "./schema/FieldConfigPanel";
import FieldCard from "./schema/FieldCard";
import { FIELD_TYPES, SYSTEM_TABLES, getFieldTypeConfig } from "./schema/types";
import type { CustomField, FieldType } from "./schema/types";
import { logSchemaChange } from "@/lib/services/schemaChangeLog";
import { useCompany } from "@/components/CompanyContext";
import { createArchiveRequest } from "@/lib/archiveRequests";

export default function SchemaVisualisation() {
  const { tables: customTables } = useCustomTables();

  const { isAdmin } = useCompany();
  const [activeTable, setActiveTable] = useState<string>('properties');
  const [isCustomTable, setIsCustomTable] = useState(false);
  const [customTableId, setCustomTableId] = useState<string | null>(null);
  const [fields, setFields] = useState<CustomField[]>([]);
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null);
  const [draggedIdx, setDraggedIdx] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [showPalette, setShowPalette] = useState(false);

  useEffect(() => { loadFields(); }, [activeTable, isCustomTable, customTableId]);
  useProgressBarWhile(loading);

  const handleTableSelect = (slug: string, tableId?: string) => {
    setActiveTable(slug);
    setIsCustomTable(!!tableId);
    setCustomTableId(tableId || null);
    setSelectedFieldId(null);
  };

  const loadFields = async () => {
    setLoading(true);
    setSelectedFieldId(null);

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setLoading(false); return; }

    const { data: prof } = await supabase
      .from('profiles').select('active_company_id').eq('id', user.id).single();
    const cid = prof?.active_company_id || null;
    setCompanyId(cid);

    if (isCustomTable && customTableId) {
      const { data } = await supabase
        .from('company_table_fields')
        .select('*')
        .eq('table_id', customTableId)
        .is('deleted_at', null)
        .order('display_order');

      setFields((data || []).map(f => ({
        id: f.id,
        table_name: f.table_id,
        table_id: f.table_id,
        field_key: f.field_key,
        label: f.label,
        field_type: f.field_type as FieldType,
        select_options: f.select_options,
        is_required: f.is_required,
        is_unique: f.is_unique,
        display_order: f.display_order,
        default_value: null,
        validation_regex: null,
        validation_min: null,
        validation_max: null,
        auto_generate: false,
        auto_generate_type: null,
        auto_generate_prefix: null,
        linked_table: f.linked_system_table || null,
        linked_table_id: f.linked_table_id || null,
        linked_display_column: f.linked_display_field || null,
        linked_search_field_keys: f.linked_search_field_keys || null,
        linked_filter_column: f.linked_filter_column || null,
        linked_filter_value: f.linked_filter_value || null,
        section_name: f.section_name,
        grid_width: 2,
        show_in_table: f.show_in_table,
        help_text: f.help_text,
        isCustomTable: true,
        formula_type: f.formula_type,
        formula_field_a_id: f.formula_field_a_id,
        formula_field_b_id: f.formula_field_b_id,
        formula_percent: f.formula_percent,
      })));
    } else {
      const { data } = await supabase
        .from('company_custom_fields')
        .select('*')
        .eq('table_name', activeTable)
        .is('deleted_at', null)
        .order('display_order');
      setFields(data || []);
    }

    setLoading(false);
  };

  const handleAddField = async (fieldType: FieldType) => {
    if (!companyId) return;
    setAdding(true);
    setShowPalette(false);

    const { data: { user } } = await supabase.auth.getUser();
    const label = FIELD_TYPES.find(f => f.type === fieldType)?.label || 'New field';
    const field_key = `field_${Date.now()}`;

    if (isCustomTable && customTableId) {
      const { data, error } = await supabase
        .from('company_table_fields')
        .insert({
          company_id: companyId,
          table_id: customTableId,
          field_key,
          label,
          field_type: fieldType,
          is_required: false,
          is_unique: false,
          show_in_table: true,
          display_order: fields.length,
        })
        .select()
        .single();

      if (error) console.error('Add field error:', error);
      if (data) {
        const mapped: CustomField = {
          id: data.id,
          table_name: data.table_id,
          table_id: data.table_id,
          field_key: data.field_key,
          label: data.label,
          field_type: data.field_type as FieldType,
          select_options: null,
          is_required: false,
          is_unique: false,
          display_order: data.display_order,
          default_value: null,
          validation_regex: null,
          validation_min: null,
          validation_max: null,
          auto_generate: false,
          auto_generate_type: null,
          auto_generate_prefix: null,
          linked_table: null,
          linked_table_id: null,
          linked_display_column: null,
          linked_search_field_keys: null,
          linked_filter_column: null,
          linked_filter_value: null,
          section_name: null,
          grid_width: 2,
          show_in_table: true,
          help_text: null,
          isCustomTable: true,
          formula_type: null,
          formula_field_a_id: null,
          formula_field_b_id: null,
          formula_percent: null,
        };
        setFields(prev => [...prev, mapped]);
        setSelectedFieldId(data.id);
        logSchemaChange({
          companyId, actorId: user?.id ?? null, entityType: 'company_table_field',
          entityId: data.id, entityLabel: label, action: 'create', after: data,
        });
      }
    } else {
      const { data, error } = await supabase
        .from('company_custom_fields')
        .insert({
          company_id: companyId,
          table_name: activeTable,
          field_key,
          label,
          field_type: fieldType,
          display_order: fields.length,
          grid_width: 2,
          show_in_table: false,
          is_required: false,
          is_unique: false,
          auto_generate: fieldType === 'auto_id',
          auto_generate_type: fieldType === 'auto_id' ? 'sequential' : null,
        })
        .select()
        .single();

      if (error) console.error('Add field error:', error);
      if (data) {
        setFields(prev => [...prev, data]);
        setSelectedFieldId(data.id);
        logSchemaChange({
          companyId, actorId: user?.id ?? null, entityType: 'company_custom_field',
          entityId: data.id, entityLabel: label, action: 'create', after: data,
        });
      }
    }

    setAdding(false);
  };

const handleSaveField = async (updates: Partial<CustomField>) => {
  if (!selectedFieldId) return;
  const before = fields.find(f => f.id === selectedFieldId);
  const { data: { user } } = await supabase.auth.getUser();

  if (isCustomTable && customTableId) {
    // company_table_fields — uses linked_system_table + linked_table_id
    await supabase
      .from('company_table_fields')
      .update({
        label: updates.label,
        field_type: updates.field_type,
        select_options: updates.select_options,
        is_required: updates.is_required,
        is_unique: updates.is_unique,
        show_in_table: updates.show_in_table,
        section_name: updates.section_name,
        help_text: updates.help_text,
        linked_system_table: updates.linked_table || null,
        linked_table_id: updates.linked_table_id || null,
        linked_display_field: updates.linked_display_column || null,
        linked_search_field_keys: updates.linked_search_field_keys ?? null,
        linked_filter_column: updates.linked_filter_column ?? null,
        linked_filter_value: updates.linked_filter_value ?? null,
        formula_type: updates.formula_type ?? null,
        formula_field_a_id: updates.formula_field_a_id ?? null,
        formula_field_b_id: updates.formula_field_b_id ?? null,
        formula_percent: updates.formula_percent ?? null,
      })
      .eq('id', selectedFieldId);
  } else {
    // company_custom_fields — uses single linked_table column
    await supabase
      .from('company_custom_fields')
      .update({
        label: updates.label,
        field_type: updates.field_type,
        select_options: updates.select_options,
        is_required: updates.is_required,
        is_unique: updates.is_unique,
        show_in_table: updates.show_in_table,
        section_name: updates.section_name,
        help_text: updates.help_text,
        grid_width: updates.grid_width,
        default_value: updates.default_value,
        validation_regex: updates.validation_regex,
        validation_min: updates.validation_min,
        validation_max: updates.validation_max,
        auto_generate: updates.auto_generate,
        auto_generate_type: updates.auto_generate_type,
        auto_generate_prefix: updates.auto_generate_prefix,
        linked_table: updates.linked_table || null,          // ← single column
        linked_display_column: updates.linked_display_column || null,
      })
      .eq('id', selectedFieldId);
  }

  setFields(prev => prev.map(f =>
    f.id === selectedFieldId ? { ...f, ...updates } : f
  ));

  if (companyId && before) {
    logSchemaChange({
      companyId, actorId: user?.id ?? null,
      entityType: isCustomTable ? 'company_table_field' : 'company_custom_field',
      entityId: selectedFieldId, entityLabel: updates.label ?? before.label,
      action: 'update', before, after: { ...before, ...updates },
    });
  }
};

  const handleDeleteField = async () => {
    if (!selectedFieldId) return;
    const before = fields.find(f => f.id === selectedFieldId);
    if (!before) return;

    if (!isAdmin) {
      if (!window.confirm(`Request deleting the "${before.label}" field? A company admin will need to approve it.`)) return;
      if (!companyId) return;
      const entityTable = isCustomTable ? "company_table_fields" : "company_custom_fields";
      const result = await createArchiveRequest(entityTable, selectedFieldId, `Field: ${before.label}`, companyId);
      if (!result.ok) { window.alert(result.error); return; }
      window.alert(result.alreadyPending ? "Already requested — waiting on admin review." : "Deletion requested — a company admin will review it.");
      return;
    }

    const valueTable = isCustomTable ? 'company_table_values' : 'company_custom_field_values';
    const { count } = await supabase
      .from(valueTable)
      .select('field_id', { count: 'exact', head: true })
      .eq('field_id', selectedFieldId);
    const valueCount = count ?? 0;

    const warning = valueCount > 0
      ? `Delete "${before.label}"? It has data stored against ${valueCount} record${valueCount === 1 ? '' : 's'}. This moves it to Trash — nothing is deleted permanently, and you can restore it (with its data) from there.`
      : `Delete "${before.label}"? This moves it to Trash and can be restored later.`;
    if (!window.confirm(warning)) return;

    const { data: { user } } = await supabase.auth.getUser();

    // Soft-delete — the field's stored values are untouched, so this is
    // fully reversible from Trash.
    if (isCustomTable) {
      await supabase.from('company_table_fields').update({ deleted_at: new Date().toISOString() }).eq('id', selectedFieldId);
    } else {
      await supabase.from('company_custom_fields').update({ deleted_at: new Date().toISOString() }).eq('id', selectedFieldId);
    }

    setFields(prev => prev.filter(f => f.id !== selectedFieldId));
    setSelectedFieldId(null);

    if (companyId && before) {
      logSchemaChange({
        companyId, actorId: user?.id ?? null,
        entityType: isCustomTable ? 'company_table_field' : 'company_custom_field',
        entityId: selectedFieldId, entityLabel: before.label, action: 'delete', before,
      });
    }
  };

  const handleDrop = async (targetIdx: number) => {
    if (draggedIdx === null || draggedIdx === targetIdx) return;
    const reordered = [...fields];
    const [moved] = reordered.splice(draggedIdx, 1);
    reordered.splice(targetIdx, 0, moved);
    setFields(reordered.map((f, i) => ({ ...f, display_order: i })));
    setDraggedIdx(null);

    const table = isCustomTable ? 'company_table_fields' : 'company_custom_fields';
    await Promise.all(
      reordered.map((f, i) =>
        supabase.from(table).update({ display_order: i }).eq('id', f.id)
      )
    );
  };

  // Snapshots every custom field on the active system table (entities/
  // projects/properties) into a brand-new draft template — a one-time copy,
  // not a live link (see supabase/template_marketplace.sql).
  const handlePublishSystemFields = async () => {
    if (isCustomTable || !companyId || fields.length === 0) return;
    const templateName = window.prompt(
      `Publish these ${activeTable} custom fields to the marketplace as a new template. Template name:`,
      `${activeTable.charAt(0).toUpperCase()}${activeTable.slice(1)} fields`
    );
    if (!templateName?.trim()) return;

    const { data: { user } } = await supabase.auth.getUser();
    const slug = `${templateName.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, '-')}-${Date.now().toString(36)}`;
    const { data: template, error: tErr } = await supabase.from('template_definitions').insert({
      slug, name: templateName.trim(), owner_company_id: companyId, is_published: false,
    }).select().single();
    if (tErr || !template) { alert(tErr?.message || 'Could not create template'); return; }

    await supabase.from('template_definition_system_fields').insert(fields.map(f => ({
      template_id: template.id, table_name: activeTable, field_key: f.field_key, label: f.label, field_type: f.field_type,
      select_options: f.select_options, is_required: f.is_required, is_unique: f.is_unique,
      display_order: f.display_order, section_name: f.section_name, help_text: f.help_text,
      default_value: f.default_value, auto_generate: f.auto_generate, auto_generate_type: f.auto_generate_type,
      auto_generate_prefix: f.auto_generate_prefix, linked_table: f.linked_table, linked_display_column: f.linked_display_column,
    })));

    logSchemaChange({ companyId, actorId: user?.id ?? null, entityType: 'template_definition', entityId: template.id, entityLabel: template.name, action: 'create', after: template });
    alert(`Published as a draft template. Find it under Marketplace → My templates to review and publish.`);
  };

  const selectedField = fields.find(f => f.id === selectedFieldId) || null;

  const sections = fields.reduce<Record<string, CustomField[]>>((acc, field) => {
    const section = field.section_name || 'Fields';
    if (!acc[section]) acc[section] = [];
    acc[section].push(field);
    return acc;
  }, {});

  return (
    <div className="flex flex-col h-full min-h-0 animate-in fade-in">

      {/* Table selector */}
      <div className="mb-4 shrink-0">
        <div className="flex bg-slate-50 p-1 rounded-2xl border border-slate-100 mb-3">
          {SYSTEM_TABLES.map(t => (
            <button
              key={t}
              onClick={() => handleTableSelect(t)}
              className={`flex-1 py-3 rounded-xl text-xs font-bold capitalize transition-all ${
                activeTable === t && !isCustomTable
                  ? 'bg-white text-indigo-600 shadow-sm'
                  : 'text-slate-400 hover:text-slate-600'
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        {customTables.length > 0 && (
          <div>
            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest px-1 mb-2">
              Custom tables
            </p>
            <div className="flex flex-wrap gap-2">
              {customTables.map(t => (
                <button
                  key={t.id}
                  onClick={() => handleTableSelect(t.slug, t.id)}
                  className={`px-3 py-1.5 rounded-full text-[11px] font-bold transition-all ${
                    activeTable === t.slug && isCustomTable
                      ? 'text-white shadow-sm'
                      : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                  }`}
                  style={activeTable === t.slug && isCustomTable
                    ? { backgroundColor: t.color }
                    : undefined}
                >
                  {t.name}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Main layout */}
      <div className="flex gap-4 flex-1 min-h-0">
        <div className="flex-1 flex flex-col min-h-0">

          {/* Toolbar */}
          <div className="flex items-center justify-between mb-3 shrink-0">
            <div>
              <p className="text-[13px] font-bold text-slate-800">
                {isCustomTable
                  ? customTables.find(t => t.id === customTableId)?.name || 'Custom table'
                  : activeTable.charAt(0).toUpperCase() + activeTable.slice(1)
                } — {isCustomTable ? 'fields' : 'custom fields'}
              </p>
              <p className="text-[10px] text-slate-400 mt-0.5">
                {fields.length} field{fields.length !== 1 ? 's' : ''} · drag to reorder
              </p>
            </div>

            <div className="flex items-center gap-2">
              {!isCustomTable && fields.length > 0 && (
                <button
                  onClick={handlePublishSystemFields}
                  className="flex items-center gap-2 px-4 py-2 bg-white border border-slate-200 text-slate-600 rounded-full text-[11px] font-bold hover:bg-emerald-50 hover:text-emerald-600 hover:border-emerald-200 transition-all"
                  title="Publish these custom fields to the marketplace"
                >
                  <Store size={13} /> Publish to marketplace
                </button>
              )}
              <div className="relative">
              <button
                onClick={() => setShowPalette(p => !p)}
                className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-full text-[11px] font-bold hover:bg-indigo-700 transition-all"
              >
                <Plus size={14} /> Add field
              </button>

              {showPalette && (
                <div className="absolute top-full right-0 mt-2 bg-white rounded-3xl border border-slate-200 shadow-xl z-50 p-3 w-60">
                  <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest px-2 mb-2">
                    Choose field type
                  </p>
                  <div className="grid grid-cols-2 gap-1.5">
                    {FIELD_TYPES.map(ft => {
                      const Icon = ft.icon;
                      return (
                        <button
                          key={ft.type}
                          onClick={() => handleAddField(ft.type)}
                          disabled={adding}
                          className="flex items-center gap-2 px-3 py-2.5 rounded-2xl hover:bg-slate-50 transition-all text-left disabled:opacity-50"
                        >
                          <div className={`p-1.5 rounded-lg ${ft.color} shrink-0`}>
                            <Icon size={12} />
                          </div>
                          <span className="text-[11px] font-medium text-slate-700">{ft.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              </div>
            </div>
          </div>

          {/* Canvas */}
          <div className="flex-1 overflow-y-auto">
            {loading ? null : fields.length === 0 ? (
              <div
                className="flex flex-col items-center justify-center py-20 border-2 border-dashed border-slate-200 rounded-3xl cursor-pointer hover:border-indigo-300 transition-colors"
                onClick={() => setShowPalette(true)}
              >
                <Plus size={32} className="text-slate-300 mb-3" />
                <p className="text-[13px] font-bold text-slate-400">Add your first field</p>
                <p className="text-[11px] text-slate-300 mt-1">Click to choose a field type</p>
              </div>
            ) : (
              <div className="space-y-6">
                {Object.entries(sections).map(([sectionName, sectionFields]) => (
                  <div key={sectionName}>
                    {Object.keys(sections).length > 1 && (
                      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 px-1">
                        {sectionName}
                      </p>
                    )}
                    <div className="grid grid-cols-2 gap-3">
                      {sectionFields.map(field => {
                        const globalIdx = fields.findIndex(f => f.id === field.id);
                        return (
                          <FieldCard
                            key={field.id}
                            field={field}
                            isSelected={selectedFieldId === field.id}
                            onSelect={() => setSelectedFieldId(
                              selectedFieldId === field.id ? null : field.id
                            )}
                            onDragStart={() => setDraggedIdx(globalIdx)}
                            onDragOver={e => e.preventDefault()}
                            onDrop={() => handleDrop(globalIdx)}
                          />
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Legend */}
          {fields.length > 0 && (
            <div className="flex items-center gap-4 mt-3 pt-3 border-t border-slate-100 shrink-0 flex-wrap">
              {[
                { color: 'bg-red-400',    label: 'Required' },
                { color: 'bg-purple-400', label: 'Unique' },
                { color: 'bg-indigo-400', label: 'In table' },
                { color: 'bg-rose-400',   label: 'Auto-generated' },
              ].map(l => (
                <div key={l.label} className="flex items-center gap-1.5">
                  <span className={`w-2 h-2 rounded-full ${l.color}`} />
                  <span className="text-[10px] text-slate-400 font-medium">{l.label}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Config panel */}
        {selectedField && (
          <div className="w-72 shrink-0 bg-white border border-slate-200 rounded-3xl overflow-hidden shadow-sm flex flex-col">
            <FieldConfigPanel
              key={selectedField.id}
              field={selectedField}
              siblingFields={fields}
              onSave={handleSaveField}
              onDelete={handleDeleteField}
              onClose={() => setSelectedFieldId(null)}
            />
          </div>
        )}
      </div>
    </div>
  );
}