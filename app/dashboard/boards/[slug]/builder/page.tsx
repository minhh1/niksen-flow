"use client";

// Dashboard builder: pick a source custom table, then build the dashboard's
// widgets either visually (Canvas, drag/resize via react-grid-layout) or as
// text (Code, a small line-based DSL) -- both authoring modes read/write the
// same canonical `widgets` array, so switching between them never loses
// work. slug === 'new' creates a fresh company_dashboards row; any other
// slug edits that dashboard. See lib/hooks/useDashboardData.ts for how a
// saved dashboard's widgets get rendered on the view page.
import { useState, useEffect, useCallback, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import { Loader2, Trash2, LayoutGrid, Code2 } from "lucide-react";
import { useProgressBarWhile } from "@/components/TopProgressBar";
import { supabase } from "@/lib/supabase";
import { useCompany } from "@/components/CompanyContext";
import { useCustomTables } from "@/lib/hooks/useCustomTables";
import { useCustomTable } from "@/lib/hooks/useCustomTable";
import { logSchemaChange } from "@/lib/services/schemaChangeLog";
import { ensureDashboardWidgetsMigrated, type RawCompanyDashboardRow } from "@/lib/dashboardWidgets/ensureMigrated";
import { parseDSL, serializeToDSL, type DslParseError } from "@/lib/dashboardWidgets/dsl";
import type { DashboardWidget } from "@/lib/dashboardWidgets/types";
import CanvasEditor from "@/components/dashboard/builder/CanvasEditor";
import CodeEditor from "@/components/dashboard/builder/CodeEditor";

const ICON_OPTIONS = ['LayoutDashboard', 'Clock', 'Receipt', 'BarChart2', 'Table2', 'Briefcase'];
const COLOR_OPTIONS = ['#6366f1', '#8b5cf6', '#ec4899', '#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#06b6d4', '#3b82f6'];

export default function DashboardBuilderPage() {
  const params = useParams();
  const router = useRouter();
  const slugParam = params.slug as string;
  const isNew = slugParam === 'new';
  const { companyId, userId } = useCompany();
  const { tables } = useCustomTables();

  const [loading, setLoading] = useState(!isNew);
  const [dashboardId, setDashboardId] = useState<string | null>(null);
  const [before, setBefore] = useState<any>(null);
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('LayoutDashboard');
  const [color, setColor] = useState('#6366f1');
  const [sourceTableId, setSourceTableId] = useState('');
  const [widgets, setWidgets] = useState<DashboardWidget[]>([]);
  const [codeSource, setCodeSource] = useState('');
  const [codeWidgets, setCodeWidgets] = useState<DashboardWidget[]>([]);
  const [codeErrors, setCodeErrors] = useState<DslParseError[]>([]);
  const [builderMode, setBuilderMode] = useState<'canvas' | 'code'>('canvas');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const sourceTableSlug = useMemo(() => tables.find(t => t.id === sourceTableId)?.slug || null, [tables, sourceTableId]);
  const { fields, records } = useCustomTable(sourceTableSlug);
  const fieldById = useMemo(() => new Map(fields.map(f => [f.id, f])), [fields]);

  useEffect(() => {
    if (isNew) return;
    (async () => {
      const { data } = await supabase.from('company_dashboards').select('*').eq('slug', slugParam).maybeSingle();
      if (data) {
        let row = data as RawCompanyDashboardRow & { name: string; icon: string; color: string; source_table_id: string; code_source: string | null; builder_mode: 'canvas' | 'code' };
        if (!row.widgets_migrated_at) {
          const migrated = await ensureDashboardWidgetsMigrated(row);
          row = { ...row, widgets: migrated, widgets_migrated_at: new Date().toISOString() };
        }
        setDashboardId(row.id);
        setBefore(row);
        setName(row.name);
        setIcon(row.icon);
        setColor(row.color);
        setSourceTableId(row.source_table_id);
        setWidgets(row.widgets || []);
        setCodeSource(row.code_source || '');
        setBuilderMode(row.builder_mode || 'canvas');
      }
      setLoading(false);
    })();
  }, [isNew, slugParam]);

  useProgressBarWhile(loading);

  const handleSourceTableChange = (tableId: string) => {
    setSourceTableId(tableId);
    setWidgets([]);
    setCodeSource('');
  };

  const switchMode = (mode: 'canvas' | 'code') => {
    if (mode === builderMode) return;
    if (mode === 'code') {
      setCodeSource(serializeToDSL(widgets, fields));
      setBuilderMode('code');
      return;
    }
    // code -> canvas
    if (codeErrors.length > 0) {
      alert('Fix the errors in your code before switching to Canvas mode.');
      return;
    }
    setWidgets(codeWidgets);
    setBuilderMode('canvas');
  };

  const handleSave = async () => {
    if (!name.trim() || !sourceTableId || !companyId) return;
    if (builderMode === 'code' && codeErrors.length > 0) return;
    setSaving(true);
    setError('');

    const finalWidgets = builderMode === 'code' ? codeWidgets : widgets;
    const payload = {
      company_id: companyId,
      name: name.trim(),
      icon,
      color,
      source_table_id: sourceTableId,
      widgets: finalWidgets,
      code_source: builderMode === 'code' ? codeSource : serializeToDSL(finalWidgets, fields),
      builder_mode: builderMode,
    };

    if (isNew) {
      const slug = `${name.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, '-')}-${Date.now().toString(36)}`;
      // A brand-new dashboard is never a legacy pre-widgets row -- mark it
      // migrated immediately so ensureDashboardWidgetsMigrated (which treats
      // widgets_migrated_at IS NULL as "convert from the empty legacy
      // columns") never overwrites these real, just-built widgets with an
      // empty array the first time the dashboard is opened. Also covered by
      // the column's DB default (see
      // supabase/company_dashboards_widgets_default_fix.sql) -- set
      // explicitly here too for clarity at the call site.
      const { data, error: err } = await supabase.from('company_dashboards').insert({ ...payload, slug, widgets_migrated_at: new Date().toISOString() }).select().single();
      setSaving(false);
      if (err) { setError(err.message); return; }
      if (data) {
        logSchemaChange({ companyId, actorId: userId, entityType: 'company_dashboard', entityId: data.id, entityLabel: data.name, action: 'create', after: data });
        router.push(`/dashboard/dashboards/${data.slug}`);
      }
      return;
    }

    const { data, error: err } = await supabase.from('company_dashboards').update(payload).eq('id', dashboardId).select().single();
    setSaving(false);
    if (err) { setError(err.message); return; }
    if (data && before) {
      logSchemaChange({ companyId, actorId: userId, entityType: 'company_dashboard', entityId: dashboardId!, entityLabel: data.name, action: 'update', before, after: data });
      router.push(`/dashboard/dashboards/${data.slug}`);
    }
  };

  const handleDelete = async () => {
    if (!dashboardId || !companyId || !before) return;
    if (!window.confirm(`Delete "${name}"? This moves it to Trash and can be restored later.`)) return;
    await supabase.from('company_dashboards').update({ deleted_at: new Date().toISOString() }).eq('id', dashboardId);
    logSchemaChange({ companyId, actorId: userId, entityType: 'company_dashboard', entityId: dashboardId, entityLabel: name, action: 'delete', before });
    router.push('/dashboard/properties');
  };

  if (loading) {
    return null;
  }

  const canSave = !saving && !!name.trim() && !!sourceTableId && !(builderMode === 'code' && codeErrors.length > 0);

  return (
    <div className="max-w-5xl mx-auto p-8 space-y-6">
      <h1 className="text-xl font-light uppercase tracking-tight text-slate-900">
        {isNew ? 'New dashboard' : `Edit "${name}"`}
      </h1>

      <div className="p-5 bg-white border border-slate-200 rounded-2xl space-y-4">
        <div>
          <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block mb-1.5">Name</label>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Time Entry" className="w-full bg-slate-50 border border-slate-200 rounded-full py-3 px-5 text-sm font-medium outline-none focus:ring-4 focus:ring-indigo-100" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block mb-1.5">Icon</label>
            <select value={icon} onChange={e => setIcon(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-full py-2.5 px-4 text-sm font-medium outline-none appearance-none">
              {ICON_OPTIONS.map(i => <option key={i} value={i}>{i}</option>)}
            </select>
          </div>
          <div>
            <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block mb-2">Colour</label>
            <div className="flex gap-1.5 pt-1.5">
              {COLOR_OPTIONS.map(c => (
                <button key={c} onClick={() => setColor(c)} className={`w-6 h-6 rounded-full ${color === c ? 'ring-2 ring-offset-1 ring-slate-400' : ''}`} style={{ backgroundColor: c }} />
              ))}
            </div>
          </div>
        </div>
        <div>
          <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block mb-1.5">Source table</label>
          <select
            value={sourceTableId}
            onChange={e => handleSourceTableChange(e.target.value)}
            disabled={!isNew && !!dashboardId}
            className="w-full bg-slate-50 border border-slate-200 rounded-full py-3 px-5 text-sm font-medium outline-none appearance-none disabled:opacity-60"
          >
            <option value="">Select a custom table...</option>
            {tables.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          {!isNew && <p className="text-[10px] text-slate-400 mt-1 px-1">Can't be changed after creation — delete and recreate to switch tables.</p>}
        </div>
      </div>

      {sourceTableId && companyId && userId && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 p-1 bg-slate-100 rounded-full w-fit">
            <button
              onClick={() => switchMode('canvas')}
              className={`flex items-center gap-2 px-4 py-2 rounded-full text-[11px] font-bold transition-all ${builderMode === 'canvas' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-400'}`}
            >
              <LayoutGrid size={13} /> Canvas
            </button>
            <button
              onClick={() => switchMode('code')}
              className={`flex items-center gap-2 px-4 py-2 rounded-full text-[11px] font-bold transition-all ${builderMode === 'code' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-400'}`}
            >
              <Code2 size={13} /> Code
            </button>
          </div>

          {builderMode === 'canvas' ? (
            <CanvasEditor
              widgets={widgets}
              onChange={setWidgets}
              fields={fields}
              fieldById={fieldById}
              records={records}
              tableId={sourceTableId}
              companyId={companyId}
              userId={userId}
            />
          ) : (
            <CodeEditor
              source={codeSource}
              onSourceChange={setCodeSource}
              onWidgetsChange={setCodeWidgets}
              onErrorsChange={setCodeErrors}
              fields={fields}
              fieldById={fieldById}
              records={records}
              tableId={sourceTableId}
              companyId={companyId}
              userId={userId}
            />
          )}
        </div>
      )}

      {error && <p className="text-[11px] text-red-500 font-medium">{error}</p>}

      <div className="flex gap-3">
        <button onClick={handleSave} disabled={!canSave} className="flex-1 py-3.5 bg-indigo-600 text-white rounded-full text-[11px] font-bold uppercase tracking-widest disabled:opacity-50 flex items-center justify-center gap-2">
          {saving ? <Loader2 size={14} className="animate-spin" /> : 'Save dashboard'}
        </button>
        {!isNew && (
          <button onClick={handleDelete} className="p-3.5 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-full transition-all"><Trash2 size={16} /></button>
        )}
      </div>
    </div>
  );
}
