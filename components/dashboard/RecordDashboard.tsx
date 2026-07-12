// components/dashboard/RecordDashboard.tsx
"use client";

import { useState, useEffect, useRef } from "react";
import { supabase } from "@/lib/supabase";
import {
  Loader2, AlertCircle, ArrowLeft, Trash2,
  Pencil, FolderKanban, Plus, X, ShieldCheck
} from "lucide-react";
import TabBar, { type RecordTab } from "./TabBar";
import AddTabModal from "./AddTabModal";
import FieldLayoutEditor, { type FieldLayout } from "./FieldLayoutEditor";
import SubProjectsTab from "./tabs/SubProjectsTab";
import ChecklistTab from "./tabs/ChecklistTab";
import CalendarTab from "./tabs/CalendarTab";
import EmailsTab from "./tabs/EmailsTab";
import { useCustomTables } from "@/lib/hooks/useCustomTables";
import { getCompanyId } from "@/lib/services/schemaService";
import ProjectAccessPanel from "@/components/projects/ProjectAccessPanel";

// ── Types ──────────────────────────────────────────────────────────

interface Props {
  systemTable?: 'properties' | 'entities' | 'projects';
  tableId?: string;
  tableSlug?: string;
  tableName?: string;
  recordId: string;
  onBack: () => void;
  embedded?: boolean;
}

// ── Main component ─────────────────────────────────────────────────

export default function RecordDashboard({
  systemTable, tableId, tableName,
  recordId, onBack, embedded = false,
}: Props) {
  const { tables: customTables } = useCustomTables();

  const [record, setRecord] = useState<Record<string, any> | null>(null);
  const [fields, setFields] = useState<FieldLayout[]>([]);
  const [tabs, setTabs] = useState<RecordTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [tabFieldLayouts, setTabFieldLayouts] = useState<Record<string, FieldLayout[]>>({});
  const [loading, setLoading] = useState(true);
  const [isEditingTabs, setIsEditingTabs] = useState(false);
  const [isEditingLayout, setIsEditingLayout] = useState(false);
  const [showAddTab, setShowAddTab] = useState(false);
  const [companyId, setCompanyId] = useState('');
  const [subProjects, setSubProjects] = useState<any[]>([]);
  const [activeSubProjectId, setActiveSubProjectId] = useState<string | null>(null);
  const [parentRecord, setParentRecord] = useState<any | null>(null);
  const [showFieldPicker, setShowFieldPicker] = useState(false);
  const [fieldPickerTabId, setFieldPickerTabId] = useState<string | null>(null);
  const [subProjectHeight, setSubProjectHeight] = useState(400);
  const resizingRef = useRef<{ startY: number; startH: number } | null>(null);
  const [linkedEntityNames, setLinkedEntityNames] = useState<Record<string, string>>({});
  const [isAdmin, setIsAdmin] = useState(false);


  const recordTable = systemTable || tableId || '';

  // ── Effects ────────────────────────────────────────────────────

  useEffect(() => { loadAll(); }, [recordId]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!resizingRef.current) return;
      const delta = e.clientY - resizingRef.current.startY;
      const newH = Math.max(
        200,
        Math.min(window.innerHeight - 300, resizingRef.current.startH - delta)
      );
      setSubProjectHeight(newH);
    };
    const onUp = () => { resizingRef.current = null; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  // ── Data loaders ───────────────────────────────────────────────

  const loadAll = async () => {
    setLoading(true);
    const cid = await getCompanyId();
    if (!cid) { setLoading(false); return; }
    setCompanyId(cid);
    // Check admin status
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      const { data: mem } = await supabase
        .from('company_memberships')
        .select('role')
        .eq('user_id', user.id)
        .eq('company_id', cid)
        .single();
      setIsAdmin(mem?.role === 'company_admin');
    }
    await Promise.all([loadRecord(cid), loadTabs(cid), loadFields(cid), loadSubProjects(), loadParent()]);
    setLoading(false);
  };

  const loadRecord = async (cid: string) => {
    if (systemTable) {
      // Load base record
      const { data } = await supabase
        .from(systemTable)
        .select('*')
        .eq('id', recordId)
        .single();

      if (!data) return;

      // Also load custom field values
      const { data: cfValues } = await supabase
        .from('company_custom_field_values')
        .select('field_id, value_text, value_number, value_date, value_boolean')
        .eq('record_id', recordId)
        .eq('table_name', systemTable);

      // Merge custom field values into record using field_id as key
      const customValues: Record<string, any> = {};
      (cfValues || []).forEach(v => {
        customValues[v.field_id] =
          v.value_text ?? v.value_number ?? v.value_date ?? v.value_boolean;
      });

      setRecord({ ...data, ...customValues });
    } else if (tableId) {
      const { data: rec } = await supabase
        .from('company_table_records')
        .select('*, values:company_table_values(field_id, value_text, value_number, value_date, value_boolean)')
        .eq('id', recordId)
        .single();

      if (rec) {
        const values: Record<string, any> = {};
        (rec.values || []).forEach((v: any) => {
          values[v.field_id] =
            v.value_text ?? v.value_number ?? v.value_date ?? v.value_boolean;
        });
        setRecord({ id: rec.id, created_at: rec.created_at, ...values });
      }
    }
  };

  // After loadRecord, resolve entity/property names for display:
  const resolveLinkedNames = async (rec: Record<string, any>) => {
    const entityFields = fields.filter(f =>
      f.field_source === 'custom' &&
      (f.fieldType === 'entity' || f.fieldType === 'property')
    );

    const names: Record<string, string> = {};

    await Promise.all(entityFields.map(async f => {
      const storedValue = rec[f.id];
      if (!storedValue) return;

      // Check if it looks like a UUID — if so resolve the name
      const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(String(storedValue));
      if (!isUUID) { names[f.id] = storedValue; return; }

      if (f.fieldType === 'entity') {
        const { data } = await supabase
          .from('entities')
          .select('name')
          .eq('id', storedValue)
          .single();
        if (data?.name) names[f.id] = data.name;
      } else if (f.fieldType === 'property') {
        const { data } = await supabase
          .from('properties')
          .select('street_address')
          .eq('id', storedValue)
          .single();
        if (data?.street_address) names[f.id] = data.street_address;
      }
    }));

    setLinkedEntityNames(names);
  };
  const loadFields = async (cid: string) => {
    if (systemTable) {
      const { data: schemaCols } = await supabase.rpc('get_schema_metadata', {
        target_table: systemTable,
        p_company_id: cid,
      });
      const { data: customFields } = await supabase
        .from('company_custom_fields')
        .select('*')
        .eq('table_name', systemTable)
        .order('display_order');

      const baseFields: FieldLayout[] = (schemaCols || [])
        .filter((c: any) => ['data', 'relation'].includes(c.category) && !c.is_hidden)
        .map((c: any, i: number) => ({
          id: c.column_name,
          field_key: c.column_name,
          field_source: 'base' as const,
          label: c.label || c.column_name.replace(/_/g, ' '),
          fieldType:
            c.data_type === 'boolean' ? 'boolean'
            : c.data_type?.includes('timestamp') ? 'date'
            : ['numeric', 'integer'].includes(c.data_type) ? 'number'
            : 'text',
          col_start: 1,
          col_span: 6,
          row_order: i,
        }));

      const cfFields: FieldLayout[] = (customFields || []).map((cf: any, i: number) => ({
        id: cf.id,
        field_key: cf.id,
        field_source: 'custom' as const,
        label: cf.label,
        fieldType: cf.field_type,
        col_start: 1,
        col_span: 6,
        row_order: baseFields.length + i,
      }));

      setFields([...baseFields, ...cfFields]);
    } else if (tableId) {
      const { data: tableFields } = await supabase
        .from('company_table_fields')
        .select('*')
        .eq('table_id', tableId)
        .order('display_order');

      setFields((tableFields || []).map((f: any, i: number) => ({
        id: f.id,
        field_key: f.id,
        field_source: 'custom' as const,
        label: f.label,
        fieldType: f.field_type,
        col_start: 1,
        col_span: 6,
        row_order: i,
      })));
    }
  };

  const loadTabs = async (cid: string) => {
    const { data: tabData } = await supabase
      .from('record_tabs')
      .select('*')
      .eq('record_id', recordId)
      .eq('record_table', recordTable)
      .order('display_order');

    if (tabData && tabData.length > 0) {
      setTabs(tabData);
      setActiveTabId(tabData[0].id);

      const fieldTabIds = tabData
        .filter(t => t.tab_type === 'fields')
        .map(t => t.id);

      if (fieldTabIds.length > 0) {
        const { data: layouts } = await supabase
          .from('record_tab_fields')
          .select('*')
          .in('tab_id', fieldTabIds)
          .order('row_order');

        const byTab: Record<string, FieldLayout[]> = {};
        (layouts || []).forEach((l: any) => {
          if (!byTab[l.tab_id]) byTab[l.tab_id] = [];
          byTab[l.tab_id].push(l);
        });
        setTabFieldLayouts(byTab);
      }
    } else {
      const { data: newTab } = await supabase
        .from('record_tabs')
        .insert({
          company_id: cid,
          record_id: recordId,
          record_table: recordTable,
          title: 'Details',
          icon: 'FileText',
          tab_type: 'fields',
          display_order: 0,
        })
        .select()
        .single();

      if (newTab) {
        setTabs([newTab]);
        setActiveTabId(newTab.id);
      }
    }
  };

  const loadSubProjects = async () => {
    if (systemTable !== 'projects') return;
    const { data } = await supabase
      .from('projects')
      .select('id, name')
      .eq('parent_project_id', recordId)
      .is('deleted_at', null)
      .order('created_at');
    setSubProjects(data || []);
  };

  const loadParent = async () => {
    if (systemTable !== 'projects') return;
    const { data } = await supabase
      .from('projects')
      .select('id, name, parent_project_id')
      .eq('id', recordId)
      .single();
    if (data?.parent_project_id) {
      const { data: parent } = await supabase
        .from('projects')
        .select('id, name')
        .eq('id', data.parent_project_id)
        .single();
      setParentRecord(parent || null);
    } else {
      setParentRecord(null);
    }
  };

  // ── Tab handlers ───────────────────────────────────────────────

  const handleAddTab = async (
    type: string, title: string, icon: string, linkedTableId?: string
  ) => {
    const { data } = await supabase
      .from('record_tabs')
      .insert({
        company_id: companyId,
        record_id: recordId,
        record_table: recordTable,
        title,
        icon,
        tab_type: type,
        linked_table_id: linkedTableId || null,
        display_order: tabs.length,
      })
      .select()
      .single();

    if (data) {
      setTabs(prev => [...prev, data]);
      setActiveTabId(data.id);
    }
  };

  const handleRenameTab = async (tabId: string, title: string) => {
    await supabase.from('record_tabs').update({ title }).eq('id', tabId);
    setTabs(prev => prev.map(t => t.id === tabId ? { ...t, title } : t));
  };

  const handleDeleteTab = async (tabId: string) => {
    if (!window.confirm('Remove this tab?')) return;
    await supabase.from('record_tabs').delete().eq('id', tabId);
    setTabs(prev => {
      const next = prev.filter(t => t.id !== tabId);
      if (activeTabId === tabId && next.length > 0) setActiveTabId(next[0].id);
      return next;
    });
  };

  const handleReorderTabs = async (reordered: RecordTab[]) => {
    setTabs(reordered);
    await Promise.all(
      reordered.map(t =>
        supabase.from('record_tabs')
          .update({ display_order: t.display_order })
          .eq('id', t.id)
      )
    );
  };

  // ── Field save ─────────────────────────────────────────────────

  const handleFieldSave = async (fieldKey: string, value: any) => {
  if (!record) return;

  if (systemTable) {
    const field = fields.find(f => f.field_key === fieldKey || f.id === fieldKey);
    const isCustom = field?.field_source === 'custom';

    if (isCustom && field) {
      let saveValue = value;

      // ── Entity type — find or create entity, store ID ──────────
      if (field.fieldType === 'entity' && value) {
        const { data: existing } = await supabase
          .from('entities')
          .select('id')
          .eq('company_id', companyId)
          .ilike('name', value.trim())
          .is('deleted_at', null)
          .limit(1)
          .single();

        if (existing) {
          saveValue = existing.id;
        } else {
          const { data: newEnt } = await supabase
            .from('entities')
            .insert({
              company_id: companyId,
              name: value.trim(),
              entity_type: 'Person', // default — user can change in entity record
            })
            .select('id')
            .single();
          saveValue = newEnt?.id || value;
        }
      }

      // ── Property type — find or create property, store ID ──────
      if (field.fieldType === 'property' && value) {
        const { data: existing } = await supabase
          .from('properties')
          .select('id')
          .eq('company_id', companyId)
          .ilike('street_address', value.trim())
          .is('deleted_at', null)
          .limit(1)
          .single();

        if (existing) {
          saveValue = existing.id;
        } else {
          const { data: newProp } = await supabase
            .from('properties')
            .insert({
              company_id: companyId,
              street_address: value.trim(),
            })
            .select('id')
            .single();
          saveValue = newProp?.id || value;
        }
      }

      // Save to custom_field_values
      const fieldType = field.fieldType;
      const valueCol =
        ['number', 'currency'].includes(fieldType) ? 'value_number'
        : fieldType === 'date' ? 'value_date'
        : fieldType === 'boolean' ? 'value_boolean'
        : 'value_text';

      await supabase.from('company_custom_field_values').upsert({
        company_id: companyId,
        field_id: field.id,
        record_id: recordId,
        table_name: systemTable,
        [valueCol]: saveValue,
      }, { onConflict: 'field_id,record_id' });

      setRecord(prev => prev ? { ...prev, [field.id]: saveValue } : prev);

    } else {
      // Base column
      await supabase
        .from(systemTable)
        .update({ [fieldKey]: value || null })
        .eq('id', recordId);
      setRecord(prev => prev ? { ...prev, [fieldKey]: value } : prev);
    }

  } else if (tableId) {
    await supabase.from('company_table_values').upsert({
      company_id: companyId,
      table_id: tableId,
      record_id: recordId,
      field_id: fieldKey,
      value_text: value,
    }, { onConflict: 'record_id,field_id' });
    setRecord(prev => prev ? { ...prev, [fieldKey]: value } : prev);
  }
};
  // ── Field layout ───────────────────────────────────────────────

  const getTabFieldLayout = (tabId: string): FieldLayout[] => {
    const saved = tabFieldLayouts[tabId];
    if (saved && saved.length > 0) {
      return saved.map(s => {
        const meta = fields.find(f => f.field_key === s.field_key);
        return { ...s, ...meta, col_span: s.col_span, row_order: s.row_order };
      });
    }
    return fields;
  };

  const saveTabFieldLayout = async (tabId: string, layout: FieldLayout[]) => {
    const upserts = layout.map(f => ({
      tab_id: tabId,
      field_key: f.field_key,
      field_source: f.field_source,
      col_start: f.col_start,
      col_span: f.col_span,
      row_order: f.row_order,
    }));
    await supabase
      .from('record_tab_fields')
      .upsert(upserts, { onConflict: 'tab_id,field_key' });
    setTabFieldLayouts(prev => ({ ...prev, [tabId]: layout }));
  };

  const handleLayoutChange = (tabId: string, layout: FieldLayout[]) => {
    setTabFieldLayouts(prev => ({ ...prev, [tabId]: layout }));
  };

  const handleRemoveFieldFromTab = async (tabId: string, fieldKey: string) => {
    await supabase
      .from('record_tab_fields')
      .delete()
      .eq('tab_id', tabId)
      .eq('field_key', fieldKey);
    setTabFieldLayouts(prev => ({
      ...prev,
      [tabId]: (prev[tabId] || []).filter(f => f.field_key !== fieldKey),
    }));
  };

  const handleAddFieldToTab = (tabId: string) => {
    setFieldPickerTabId(tabId);
    setShowFieldPicker(true);
  };

  const handlePickField = async (fieldKey: string) => {
    if (!fieldPickerTabId) return;
    const currentLayout = tabFieldLayouts[fieldPickerTabId] || fields;
    const usedKeys = new Set(currentLayout.map(f => f.field_key));
    if (usedKeys.has(fieldKey)) return;
    const field = fields.find(f => f.field_key === fieldKey);
    if (!field) return;
    const newLayout = [
      ...currentLayout,
      { ...field, col_span: 6, row_order: currentLayout.length },
    ];
    await saveTabFieldLayout(fieldPickerTabId, newLayout);
    setShowFieldPicker(false);
    setFieldPickerTabId(null);
  };

  // ── Sub-project handlers ───────────────────────────────────────

  const handleCreateSubProject = async () => {
    const parentName = record?.name || '';
    const baseName = parentName.includes('/')
      ? parentName.split('/').slice(-1)[0].trim()
      : parentName;
    const { data: newSub } = await supabase
      .from('projects')
      .insert({
        company_id: companyId,
        parent_project_id: recordId,
        name: `${baseName}/New sub-project`,
      })
      .select('id, name')
      .single();
    if (newSub) {
      setSubProjects(prev => [...prev, newSub]);
      setActiveSubProjectId(newSub.id);
    }
  };

  // ── Delete ─────────────────────────────────────────────────────

  const handleDelete = async () => {
    if (!window.confirm('Archive this record?')) return;
    if (systemTable) {
      await supabase
        .from(systemTable)
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', recordId);
    } else if (tableId) {
      await supabase
        .from('company_table_records')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', recordId);
    }
    onBack();
  };

  useEffect(() => {
    if (record && fields.length > 0) {
      resolveLinkedNames(record);
    }
  }, [record, fields]);

  // ── Derived ────────────────────────────────────────────────────

  const primaryValue = record
    ? systemTable === 'properties'
      ? record.street_address
      : record.name || record[fields[0]?.field_key] || 'Untitled'
    : 'Loading...';

  const activeTab = tabs.find(t => t.id === activeTabId);

  // ── Shared tab content renderer ────────────────────────────────

  const renderTabContent = () => (
    <>
      {activeTab?.tab_type === 'fields' && (
        <FieldLayoutEditor
          fields={getTabFieldLayout(activeTab.id)}
          recordValues={record || {}}
          isEditing={isEditingLayout}
          onSave={handleFieldSave}
          linkedNames={linkedEntityNames}
          onLayoutChange={layout => {
            handleLayoutChange(activeTab.id, layout);
            saveTabFieldLayout(activeTab.id, layout);
          }}
          onAddField={() => handleAddFieldToTab(activeTab.id)}
          onRemoveField={fieldKey =>
            handleRemoveFieldFromTab(activeTab.id, fieldKey)
          }
        />
      )}
      {activeTab?.tab_type === 'sub_projects' && (
        <SubProjectsTab recordId={recordId} />
      )}
      {activeTab?.tab_type === 'checklist' && (
        <ChecklistTab recordId={recordId} companyId={companyId} />
      )}
      {activeTab?.tab_type === 'calendar' && (
        <CalendarTab recordId={recordId} />
      )}
      {activeTab?.tab_type === 'emails' && (
        <EmailsTab recordId={recordId} />
      )}
      {activeTab?.tab_type === 'custom_table' && activeTab.linked_table_id && (
        <div className="text-center py-20 text-slate-300 text-[11px] font-bold uppercase tracking-widest">
          Custom table view — coming soon
        </div>
      )}
      {activeTabId === '__access__' && systemTable === 'projects' && (
        <ProjectAccessPanel
          projectId={recordId}
          companyId={companyId}
          isAdmin={isAdmin}
        />
      )}
      {!activeTab && tabs.length === 0 && (
        <div
          className="flex flex-col items-center justify-center py-20 gap-4 cursor-pointer"
          onClick={() => setShowAddTab(true)}
        >
          <p className="text-slate-300 text-[11px] font-bold uppercase tracking-widest">
            No tabs yet
          </p>
          <button className="px-5 py-2.5 bg-slate-900 text-white rounded-full text-[11px] font-bold">
            Add first tab
          </button>
        </div>
      )}
    </>
  );

  // ── Shared modals ──────────────────────────────────────────────

  const renderModals = () => (
    <>
      {showAddTab && (
        <AddTabModal
          customTables={customTables}
          onAdd={handleAddTab}
          onClose={() => setShowAddTab(false)}
        />
      )}

      {showFieldPicker && fieldPickerTabId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-md p-6">
          <div className="bg-white rounded-[40px] p-8 w-full max-w-md shadow-2xl">
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-lg font-light uppercase tracking-wide text-slate-900">
                Add field
              </h3>
              <button
                onClick={() => {
                  setShowFieldPicker(false);
                  setFieldPickerTabId(null);
                }}
                className="p-2 text-slate-300 hover:text-black"
              >
                <X size={18} />
              </button>
            </div>
            <div className="space-y-1 max-h-80 overflow-y-auto">
              {fields
                .filter(f => {
                  const used = new Set(
                    (tabFieldLayouts[fieldPickerTabId] || fields).map(l => l.field_key)
                  );
                  return !used.has(f.field_key);
                })
                .map(field => (
                  <button
                    key={field.field_key}
                    onClick={() => handlePickField(field.field_key)}
                    className="w-full flex items-center gap-3 px-4 py-3 rounded-2xl hover:bg-indigo-50 border border-transparent hover:border-indigo-100 transition-all text-left"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] font-medium text-slate-700">
                        {field.label}
                      </p>
                      <p className="text-[10px] text-slate-400">{field.fieldType}</p>
                    </div>
                  </button>
                ))
              }
              {fields.filter(f => {
                const used = new Set(
                  (tabFieldLayouts[fieldPickerTabId] || fields).map(l => l.field_key)
                );
                return !used.has(f.field_key);
              }).length === 0 && (
                <p className="text-center text-[11px] text-slate-300 italic py-6">
                  All fields already added
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );

  // ── Early returns ──────────────────────────────────────────────

  if (loading) return (
    <div className="flex items-center justify-center h-screen">
      <Loader2 className="animate-spin text-slate-300" size={24} />
    </div>
  );

  if (!record) return (
    <div className="flex flex-col items-center justify-center h-screen gap-3">
      <AlertCircle size={32} className="text-slate-300" />
      <p className="text-[11px] text-slate-400 font-bold uppercase tracking-widest">
        Record not found
      </p>
      <button
        onClick={onBack}
        className="text-indigo-600 text-[11px] font-bold hover:underline"
      >
        Go back
      </button>
    </div>
  );

  // ── Embedded view ──────────────────────────────────────────────

  if (embedded) {
    return (
      <div className="font-sans antialiased">
        <div className="px-8 pt-6 pb-0 border-b border-slate-100 bg-white">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-xl font-light text-slate-900 tracking-tight uppercase truncate">
              {primaryValue}
            </h2>
            <div className="flex items-center gap-2">
              {activeTab?.tab_type === 'fields' && (
                <button
                  onClick={() => setIsEditingLayout(p => !p)}
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-[10px] font-bold transition-all ${
                    isEditingLayout
                      ? 'bg-indigo-600 text-white'
                      : 'bg-slate-50 border border-slate-200 text-slate-600'
                  }`}
                >
                  <Pencil size={12} />
                  {isEditingLayout ? 'Done' : 'Edit layout'}
                </button>
              )}
            </div>
          </div>
          <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-3">
            {tableName || systemTable}
            {record.created_at && (
              <span className="ml-2">
                · {new Date(record.created_at).toLocaleDateString('en-AU')}
              </span>
            )}
          </p>
          <TabBar
            tabs={tabs}
            activeTabId={activeTabId}
            onSelect={setActiveTabId}
            onAdd={() => setShowAddTab(true)}
            onRename={handleRenameTab}
            onDelete={handleDeleteTab}
            onReorder={handleReorderTabs}
            isEditing={isEditingTabs}
            onToggleEdit={() => setIsEditingTabs(p => !p)}
          />
        </div>
        <div className="p-8 bg-[#F9FAFB]">
          <div className="max-w-4xl mx-auto">
            {renderTabContent()}
          </div>
        </div>
        {renderModals()}
      </div>
    );
  }

  // ── Full view ──────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-screen bg-white font-sans antialiased overflow-hidden">

      {/* ── Header ── */}
      <header className="px-8 pt-6 pb-0 border-b border-slate-100 shrink-0 bg-white">

        {/* Back + breadcrumb + actions */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2 min-w-0">
            <button
              onClick={onBack}
              className="flex items-center gap-2 text-[10px] font-bold text-slate-400 uppercase hover:text-black transition-all tracking-widest shrink-0"
            >
              <ArrowLeft size={14} />
              {parentRecord ? parentRecord.name : 'Back'}
            </button>
            {parentRecord && (
              <>
                <span className="text-slate-300 shrink-0">/</span>
                <span className="text-[10px] font-bold text-slate-600 uppercase tracking-widest truncate">
                  {primaryValue}
                </span>
              </>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {activeTab?.tab_type === 'fields' && (
              <button
                onClick={() => setIsEditingLayout(p => !p)}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-[10px] font-bold transition-all ${
                  isEditingLayout
                    ? 'bg-indigo-600 text-white'
                    : 'bg-slate-50 border border-slate-200 text-slate-600 hover:border-indigo-300'
                }`}
              >
                <Pencil size={12} />
                {isEditingLayout ? 'Done' : 'Edit layout'}
              </button>
            )}
            <button
              onClick={handleDelete}
              className="p-2 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-full transition-all"
            >
              <Trash2 size={16} />
            </button>
          </div>
        </div>

        {/* Title */}
        <h1 className="text-3xl font-light text-slate-900 tracking-tight uppercase truncate mb-1">
          {primaryValue}
        </h1>
        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-4">
          {tableName || systemTable}
          {record.created_at && (
            <span className="ml-2">
              · {new Date(record.created_at).toLocaleDateString('en-AU')}
            </span>
          )}
        </p>

        {/* Sub-projects row — projects only */}
        {systemTable === 'projects' && (
          <div className="flex items-center gap-2 mb-4 flex-wrap">
            <span className="text-[9px] font-bold text-slate-300 uppercase tracking-widest shrink-0">
              Sub-projects
            </span>

            {subProjects.map(sp => {
              const displayName = sp.name.includes('/')
                ? sp.name.split('/').slice(-1)[0].trim()
                : sp.name;
              const isActive = activeSubProjectId === sp.id;
              return (
                <button
                  key={sp.id}
                  onClick={() => setActiveSubProjectId(isActive ? null : sp.id)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-bold transition-all border ${
                    isActive
                      ? 'bg-slate-900 text-white border-slate-900'
                      : 'bg-white text-slate-600 border-slate-200 hover:border-indigo-300 hover:text-indigo-600'
                  }`}
                >
                  <FolderKanban size={12} />
                  {displayName}
                </button>
              );
            })}

            <button
              onClick={handleCreateSubProject}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-bold text-slate-400 hover:text-indigo-600 border border-dashed border-slate-200 hover:border-indigo-300 transition-all"
            >
              <Plus size={12} /> Add sub-project
            </button>
          </div>
        )}

        {/* Tab bar */}
        <TabBar
          tabs={tabs}
          activeTabId={activeTabId === '__access__' ? null : activeTabId}
          onSelect={setActiveTabId}
          onAdd={() => setShowAddTab(true)}
          onRename={handleRenameTab}
          onDelete={handleDeleteTab}
          onReorder={handleReorderTabs}
          isEditing={isEditingTabs}
          onToggleEdit={() => setIsEditingTabs(p => !p)}
          extraTabs={systemTable === 'projects' && isAdmin ? [{ id: '__access__', label: 'Access', icon: ShieldCheck }] : []}
          onSelectExtra={setActiveTabId}
        />
      </header>

      {/* ── Main content ── */}
      <main className="flex-1 overflow-hidden bg-[#F9FAFB] flex flex-col min-h-0">

        {/* Parent record content */}
        <div className={`p-8 ${
          activeSubProjectId ? 'overflow-y-auto' : 'flex-1 overflow-y-auto'
        }`}>
          <div className="max-w-4xl mx-auto">
            {renderTabContent()}
          </div>
        </div>

        {/* Sub-project panel — resizable */}
        {activeSubProjectId && (
          <div
            className="flex flex-col border-t-2 border-indigo-100 bg-white shrink-0 relative"
            style={{ height: subProjectHeight }}
          >
            {/* Drag handle */}
            <div
              className="h-5 flex items-center justify-center cursor-row-resize bg-indigo-50/80 border-b border-indigo-100 hover:bg-indigo-100 transition-colors group shrink-0 relative"
              onMouseDown={e => {
                resizingRef.current = {
                  startY: e.clientY,
                  startH: subProjectHeight,
                };
              }}
            >
              {/* Visual handle + label */}
              <div className="flex items-center gap-3 pointer-events-none">
                <div className="h-1 w-8 bg-indigo-300 rounded-full group-hover:bg-indigo-500 transition-colors" />
                <div className="flex items-center gap-1.5">
                  <FolderKanban size={12} className="text-indigo-500" />
                  <p className="text-[9px] font-bold text-indigo-500 uppercase tracking-widest">
                    Sub-project
                  </p>
                </div>
                <div className="h-1 w-8 bg-indigo-300 rounded-full group-hover:bg-indigo-500 transition-colors" />
              </div>

              {/* Size presets */}
              <div className="absolute right-16 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                {[
                  { label: 'S', h: 250 },
                  { label: 'M', h: 400 },
                  { label: 'L', h: 600 },
                ].map(preset => (
                  <button
                    key={preset.label}
                    onClick={e => {
                      e.stopPropagation();
                      setSubProjectHeight(preset.h);
                    }}
                    onMouseDown={e => e.stopPropagation()}
                    className={`px-2 py-0.5 rounded text-[9px] font-bold transition-all ${
                      Math.abs(subProjectHeight - preset.h) < 50
                        ? 'bg-indigo-500 text-white'
                        : 'bg-white text-indigo-400 hover:bg-indigo-100'
                    }`}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>

              {/* Close */}
              <button
                onClick={() => setActiveSubProjectId(null)}
                onMouseDown={e => e.stopPropagation()}
                className="absolute right-4 p-1 text-indigo-300 hover:text-indigo-700 transition-colors"
              >
                <X size={14} />
              </button>
            </div>

            {/* Sub-project content */}
            <div className="flex-1 overflow-y-auto">
              <RecordDashboard
                systemTable="projects"
                recordId={activeSubProjectId}
                onBack={() => setActiveSubProjectId(null)}
                embedded={true}
              />
            </div>
          </div>
        )}
      </main>

      {renderModals()}
    </div>
  );
}