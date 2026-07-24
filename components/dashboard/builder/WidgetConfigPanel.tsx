"use client";

// Per-widget configuration modal, opened from a widget's gear icon in
// CanvasEditor. Reuses the same controls the old fixed-form builder page
// had for each config type (quick-add/grid/filter field pickers, summary
// tile label/field/aggregate/condition, chart date/value/aggregate) --
// just scoped to one widget at a time instead of one long form.
import { useState } from "react";
import { X, Plus } from "lucide-react";
import FieldPickerList from "./FieldPickerList";
import RelationPicker from "../RelationPicker";
import type { CustomTableField } from "@/lib/hooks/useCustomTable";
import type { DashboardWidget, SummaryTileWidget, TileCondition, ChartSeriesConfig } from "@/lib/dashboardWidgets/types";
import { isRelationType, isNumericType, isDateType, operatorsForType, aggregatesForType } from "@/lib/schema/fieldCapabilities";

interface Props {
  widget: DashboardWidget;
  fields: CustomTableField[];
  onSave: (widget: DashboardWidget) => void;
  onClose: () => void;
}

function conditionNeedsValue(operator: TileCondition['operator']): boolean {
  return operator !== 'is_set' && operator !== 'is_empty';
}

// One "<field> <operator> <value>" row. The value control is type-aware --
// a Yes/No select for booleans, the real option list for selects, a
// RelationPicker for relation types, plain text/number/date inputs
// otherwise -- and hidden entirely for is_set/is_empty, which don't take one.
function ConditionRow({
  condition, fields, onChange, onRemove,
}: {
  condition: TileCondition;
  fields: CustomTableField[];
  onChange: (patch: Partial<TileCondition>) => void;
  onRemove: () => void;
}) {
  const field = fields.find(f => f.id === condition.fieldId);
  const operators = field ? operatorsForType(field.field_type) : [];

  const handleFieldChange = (fieldId: string) => {
    const nextField = fields.find(f => f.id === fieldId);
    const nextOperators = nextField ? operatorsForType(nextField.field_type) : [];
    // Switching to a field whose type doesn't support the current operator
    // (e.g. was "contains" on text, new field is a number) resets to that
    // type's first operator rather than silently keeping an invalid one.
    const stillValid = nextOperators.some(o => o.value === condition.operator);
    onChange({ fieldId, operator: stillValid ? condition.operator : (nextOperators[0]?.value ?? 'eq'), value: undefined });
  };

  return (
    <div className="flex items-center gap-1.5">
      <select
        value={condition.fieldId}
        onChange={e => handleFieldChange(e.target.value)}
        className="flex-1 min-w-0 bg-slate-50 border border-slate-200 rounded-full py-2 px-3 text-[12px] font-medium outline-none appearance-none"
      >
        <option value="">Field...</option>
        {fields.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
      </select>
      <select
        value={condition.operator}
        onChange={e => onChange({ operator: e.target.value as TileCondition['operator'], value: undefined })}
        disabled={!field}
        className="shrink-0 bg-slate-50 border border-slate-200 rounded-full py-2 px-2.5 text-[12px] font-medium outline-none appearance-none disabled:opacity-50"
      >
        {operators.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {field && conditionNeedsValue(condition.operator) && (
        <div className="flex-1 min-w-0">
          {field.field_type === 'boolean' ? (
            <select
              value={condition.value === false ? 'false' : 'true'}
              onChange={e => onChange({ value: e.target.value === 'true' })}
              className="w-full bg-slate-50 border border-slate-200 rounded-full py-2 px-3 text-[12px] font-medium outline-none appearance-none"
            >
              <option value="true">Yes</option>
              <option value="false">No</option>
            </select>
          ) : field.field_type === 'select' ? (
            <select
              value={condition.value ?? ''}
              onChange={e => onChange({ value: e.target.value })}
              className="w-full bg-slate-50 border border-slate-200 rounded-full py-2 px-3 text-[12px] font-medium outline-none appearance-none"
            >
              <option value="">Value...</option>
              {(field.select_options || []).map(opt => <option key={opt} value={opt}>{opt}</option>)}
            </select>
          ) : isRelationType(field.field_type) ? (
            <RelationPicker
              linkedSystemTable={field.linked_system_table}
              linkedTableId={field.linked_system_table ? null : field.linked_table_id}
              displayField={field.linked_display_field}
              value={condition.value ?? null}
              onSelect={id => onChange({ value: id })}
              placeholder="Value..."
            />
          ) : field.field_type === 'date' ? (
            <input
              type="date"
              value={condition.value ?? ''}
              onChange={e => onChange({ value: e.target.value })}
              className="w-full bg-slate-50 border border-slate-200 rounded-full py-2 px-3 text-[12px] font-medium outline-none"
            />
          ) : isNumericType(field.field_type) ? (
            <input
              type="number"
              value={condition.value ?? ''}
              onChange={e => onChange({ value: e.target.value === '' ? undefined : Number(e.target.value) })}
              placeholder="Value..."
              className="w-full bg-slate-50 border border-slate-200 rounded-full py-2 px-3 text-[12px] font-medium outline-none"
            />
          ) : (
            <input
              value={condition.value ?? ''}
              onChange={e => onChange({ value: e.target.value })}
              placeholder="Value..."
              className="w-full bg-slate-50 border border-slate-200 rounded-full py-2 px-3 text-[12px] font-medium outline-none"
            />
          )}
        </div>
      )}
      <button onClick={onRemove} className="shrink-0 p-1.5 text-slate-300 hover:text-red-500"><X size={13} /></button>
    </div>
  );
}

// A tile saved before multi-condition support only has the old singular
// filterFieldId/filterValue -- normalized into the new array shape the
// moment the panel opens so the rest of this component only ever deals
// with `conditions`. computeSummaryTileValue/serializeToDSL have the same
// fallback for tiles that get read/serialized without ever being reopened
// here (see lib/dashboardWidgets/compute.ts and dsl.ts).
function normalizeWidget(widget: DashboardWidget): DashboardWidget {
  if (widget.type === 'summary_tile') {
    if (widget.config.conditions) return widget;
    const conditions: TileCondition[] = widget.config.filterFieldId
      ? [{ fieldId: widget.config.filterFieldId, operator: 'eq', value: widget.config.filterValue ?? true }]
      : [];
    return { ...widget, config: { ...widget.config, conditions } };
  }
  if (widget.type === 'chart') {
    const granularity = widget.config.granularity ?? 'day';
    const series: ChartSeriesConfig[] = widget.config.series?.length
      ? widget.config.series
      : [{ label: '', valueFieldId: widget.config.valueFieldId ?? null, aggregate: widget.config.aggregate ?? 'sum', conditions: [] }];
    return { ...widget, config: { ...widget.config, granularity, series } };
  }
  return widget;
}

export default function WidgetConfigPanel({ widget, fields, onSave, onClose }: Props) {
  const [draft, setDraft] = useState<DashboardWidget>(() => normalizeWidget(widget));

  const numericFields = fields.filter(f => isNumericType(f.field_type));
  const dateFields = fields.filter(f => isDateType(f.field_type));

  const updateConfig = (patch: Record<string, any>) => {
    setDraft(prev => ({ ...prev, config: { ...prev.config, ...patch } } as DashboardWidget));
  };

  // Shared by summary_tile's "only count/sum when..." and grid's "only show
  // rows when..." -- same TileCondition[] shape, same semantics (every
  // condition ANDed), just filtering summed rows vs. displayed rows.
  const addCondition = () => {
    if (draft.type !== 'summary_tile' && draft.type !== 'grid') return;
    const conditions = [...(draft.config.conditions || []), { fieldId: '', operator: 'eq' as const, value: undefined }];
    updateConfig({ conditions });
  };
  const updateCondition = (index: number, patch: Partial<TileCondition>) => {
    if (draft.type !== 'summary_tile' && draft.type !== 'grid') return;
    const conditions = (draft.config.conditions || []).map((c, i) => i === index ? { ...c, ...patch } : c);
    updateConfig({ conditions });
  };
  const removeCondition = (index: number) => {
    if (draft.type !== 'summary_tile' && draft.type !== 'grid') return;
    updateConfig({ conditions: (draft.config.conditions || []).filter((_, i) => i !== index) });
  };

  // Per-column highlight (grid only) -- one optional condition+color per
  // field id. Toggling "off" clears the entry entirely rather than leaving
  // a disabled rule around.
  const setColumnHighlight = (fieldId: string, rule: { condition: TileCondition; color: 'red' | 'amber' | 'emerald' } | null) => {
    if (draft.type !== 'grid') return;
    const next = { ...(draft.config.columnHighlights || {}) };
    if (rule) next[fieldId] = rule; else delete next[fieldId];
    updateConfig({ columnHighlights: next });
  };

  // Chart's series live one level deeper than a tile's conditions
  // (draft.config.series[i].conditions -- addressed by a (seriesIndex,
  // conditionIndex) pair), so these are parallel functions rather than a
  // generalization of add/update/removeCondition above.
  const addSeries = () => {
    if (draft.type !== 'chart') return;
    updateConfig({ series: [...(draft.config.series || []), { label: '', valueFieldId: null, aggregate: 'sum' as const, conditions: [] }] });
  };
  const updateSeries = (index: number, patch: Partial<ChartSeriesConfig>) => {
    if (draft.type !== 'chart') return;
    updateConfig({ series: (draft.config.series || []).map((s, i) => i === index ? { ...s, ...patch } : s) });
  };
  const removeSeries = (index: number) => {
    if (draft.type !== 'chart') return;
    updateConfig({ series: (draft.config.series || []).filter((_, i) => i !== index) });
  };
  const addSeriesCondition = (seriesIndex: number) => {
    if (draft.type !== 'chart') return;
    const series = draft.config.series || [];
    updateSeries(seriesIndex, { conditions: [...(series[seriesIndex]?.conditions || []), { fieldId: '', operator: 'eq' as const, value: undefined }] });
  };
  const updateSeriesCondition = (seriesIndex: number, condIndex: number, patch: Partial<TileCondition>) => {
    if (draft.type !== 'chart') return;
    const series = draft.config.series || [];
    updateSeries(seriesIndex, { conditions: (series[seriesIndex]?.conditions || []).map((c, i) => i === condIndex ? { ...c, ...patch } : c) });
  };
  const removeSeriesCondition = (seriesIndex: number, condIndex: number) => {
    if (draft.type !== 'chart') return;
    const series = draft.config.series || [];
    updateSeries(seriesIndex, { conditions: (series[seriesIndex]?.conditions || []).filter((_, i) => i !== condIndex) });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-4">
      <div className="bg-white rounded-[28px] shadow-2xl w-full max-w-md max-h-[85vh] overflow-y-auto p-6 space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-[13px] font-bold text-slate-800 capitalize">{widget.type.replace(/_/g, ' ')} settings</p>
          <button onClick={onClose} className="p-1.5 text-slate-300 hover:text-slate-600 rounded-lg hover:bg-slate-50"><X size={16} /></button>
        </div>

        {draft.type === 'heading' && (
          <div className="space-y-3">
            <div>
              <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block mb-1.5">Text</label>
              <input
                value={draft.config.text}
                onChange={e => updateConfig({ text: e.target.value })}
                className="w-full bg-slate-50 border border-slate-200 rounded-full py-2.5 px-4 text-sm font-medium outline-none focus:ring-4 focus:ring-indigo-100"
              />
            </div>
            <div>
              <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block mb-1.5">Size</label>
              <select
                value={draft.config.level}
                onChange={e => updateConfig({ level: parseInt(e.target.value, 10) })}
                className="w-full bg-slate-50 border border-slate-200 rounded-full py-2.5 px-4 text-sm font-medium outline-none appearance-none"
              >
                <option value={1}>Large</option>
                <option value={2}>Medium</option>
                <option value={3}>Small</option>
              </select>
            </div>
          </div>
        )}

        {draft.type === 'text' && (
          <div>
            <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block mb-1.5">Text</label>
            <textarea
              value={draft.config.text}
              onChange={e => updateConfig({ text: e.target.value })}
              rows={4}
              className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-2.5 px-4 text-sm font-medium outline-none focus:ring-4 focus:ring-indigo-100 resize-none"
            />
          </div>
        )}

        {draft.type === 'filter_bar' && (
          <FieldPickerList title="Filter fields" fields={fields} selectedIds={draft.config.fieldIds} onChange={ids => updateConfig({ fieldIds: ids })} max={2} />
        )}

        {draft.type === 'quick_add_form' && (
          <FieldPickerList title="Quick-add fields" fields={fields} selectedIds={draft.config.fieldIds} onChange={ids => updateConfig({ fieldIds: ids })} />
        )}

        {draft.type === 'grid' && (
          <div className="space-y-3">
            <FieldPickerList title="Grid columns" fields={fields} selectedIds={draft.config.fieldIds} onChange={ids => updateConfig({ fieldIds: ids })} />
            <div>
              <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block mb-1.5">
                Extra empty rows
              </label>
              <input
                type="number"
                min={0}
                max={20}
                value={draft.config.emptyRowCount || 0}
                onChange={e => updateConfig({ emptyRowCount: Math.max(0, Math.min(20, parseInt(e.target.value, 10) || 0)) })}
                className="w-full bg-slate-50 border border-slate-200 rounded-full py-2.5 px-4 text-sm font-medium outline-none focus:ring-4 focus:ring-indigo-100"
              />
              <p className="text-[10px] text-slate-400 mt-1 px-1">
                Blank rows kept at the bottom for fast entry -- typing into one creates a new record
              </p>
            </div>

            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={!!draft.config.showTotalsRow}
                onChange={e => updateConfig({ showTotalsRow: e.target.checked })}
                className="rounded"
              />
              <span className="text-[11px] font-medium text-slate-600">Show a totals row (sums every number/currency column)</span>
            </label>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">
                  Only show rows when... (all must match)
                </label>
                <button
                  onClick={addCondition}
                  className="flex items-center gap-1 text-[10px] font-bold text-indigo-600 hover:text-indigo-700"
                >
                  <Plus size={11} /> Add condition
                </button>
              </div>
              {(draft.config.conditions || []).map((cond, i) => (
                <ConditionRow
                  key={i}
                  condition={cond}
                  fields={fields}
                  onChange={patch => updateCondition(i, patch)}
                  onRemove={() => removeCondition(i)}
                />
              ))}
              {(!draft.config.conditions || draft.config.conditions.length === 0) && (
                <p className="text-[11px] text-slate-300 italic py-1">No conditions — shows every record (still narrowed by the filter bar, if any)</p>
              )}
            </div>

            {draft.config.fieldIds.length > 0 && (
              <div className="space-y-2">
                <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block">
                  Column highlights
                </label>
                <div className="space-y-2">
                  {draft.config.fieldIds.map(fieldId => {
                    const field = fields.find(f => f.id === fieldId);
                    if (!field) return null;
                    const rule = draft.config.columnHighlights?.[fieldId];
                    return (
                      <div key={fieldId} className="bg-slate-50 border border-slate-200 rounded-2xl p-2.5 space-y-1.5">
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] font-bold text-slate-600 px-1">{field.label}</span>
                          {!rule ? (
                            <button
                              onClick={() => setColumnHighlight(fieldId, { condition: { fieldId: '', operator: 'eq', value: undefined }, color: 'red' })}
                              className="flex items-center gap-1 text-[10px] font-bold text-indigo-600 hover:text-indigo-700 shrink-0"
                            >
                              <Plus size={11} /> Add highlight
                            </button>
                          ) : (
                            <button onClick={() => setColumnHighlight(fieldId, null)} className="p-1 text-slate-300 hover:text-red-500 shrink-0">
                              <X size={13} />
                            </button>
                          )}
                        </div>
                        {rule && (
                          <div className="flex items-center gap-1.5">
                            <div className="flex-1 min-w-0">
                              <ConditionRow
                                condition={rule.condition}
                                fields={fields}
                                onChange={patch => setColumnHighlight(fieldId, { ...rule, condition: { ...rule.condition, ...patch } })}
                                onRemove={() => setColumnHighlight(fieldId, null)}
                              />
                            </div>
                            <select
                              value={rule.color}
                              onChange={e => setColumnHighlight(fieldId, { ...rule, color: e.target.value as 'red' | 'amber' | 'emerald' })}
                              className="shrink-0 bg-white border border-slate-200 rounded-full py-2 px-2.5 text-[12px] font-medium outline-none appearance-none"
                            >
                              <option value="red">Red</option>
                              <option value="amber">Amber</option>
                              <option value="emerald">Green</option>
                            </select>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                <p className="text-[10px] text-slate-400 px-1">
                  Highlights a cell's background when its row matches the condition -- the condition can reference any field, not just this column (e.g. highlight Amount when Status is Overdue)
                </p>
              </div>
            )}
          </div>
        )}

        {draft.type === 'summary_tile' && (
          <div className="space-y-3">
            <div>
              <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block mb-1.5">Label</label>
              <input
                value={draft.config.label}
                onChange={e => updateConfig({ label: e.target.value })}
                placeholder="e.g. Time Logged"
                className="w-full bg-slate-50 border border-slate-200 rounded-full py-2.5 px-4 text-sm font-medium outline-none focus:ring-4 focus:ring-indigo-100"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <select
                value={draft.config.fieldId || ''}
                onChange={e => {
                  const nextField = fields.find(f => f.id === e.target.value);
                  const nextAggregates = aggregatesForType(nextField?.field_type || 'text');
                  const stillValid = nextAggregates.some(a => a.value === draft.config.aggregate);
                  updateConfig({
                    fieldId: e.target.value || null,
                    aggregate: stillValid ? draft.config.aggregate : nextAggregates[0].value,
                  });
                }}
                className="bg-slate-50 border border-slate-200 rounded-full py-2.5 px-4 text-sm font-medium outline-none appearance-none"
              >
                <option value="">Field...</option>
                {fields.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
              </select>
              <select
                value={draft.config.aggregate}
                onChange={e => updateConfig({ aggregate: e.target.value as SummaryTileWidget['config']['aggregate'] })}
                className="bg-slate-50 border border-slate-200 rounded-full py-2.5 px-4 text-sm font-medium outline-none appearance-none"
              >
                {aggregatesForType(fields.find(f => f.id === draft.config.fieldId)?.field_type || 'text').map(a => (
                  <option key={a.value} value={a.value}>{a.label}</option>
                ))}
              </select>
            </div>
            {draft.config.aggregate === 'net' && (
              <select
                value={draft.config.fieldBId || ''}
                onChange={e => updateConfig({ fieldBId: e.target.value || null })}
                className="w-full bg-slate-50 border border-slate-200 rounded-full py-2.5 px-4 text-sm font-medium outline-none appearance-none"
              >
                <option value="">Minus field... (e.g. Amount Out)</option>
                {numericFields.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
              </select>
            )}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">
                  Only count/sum when... (all must match)
                </label>
                <button
                  onClick={addCondition}
                  className="flex items-center gap-1 text-[10px] font-bold text-indigo-600 hover:text-indigo-700"
                >
                  <Plus size={11} /> Add condition
                </button>
              </div>
              {(draft.config.conditions || []).map((cond, i) => (
                <ConditionRow
                  key={i}
                  condition={cond}
                  fields={fields}
                  onChange={patch => updateCondition(i, patch)}
                  onRemove={() => removeCondition(i)}
                />
              ))}
              {(!draft.config.conditions || draft.config.conditions.length === 0) && (
                <p className="text-[11px] text-slate-300 italic py-1">No conditions — counts/sums every record</p>
              )}
            </div>
          </div>
        )}

        {draft.type === 'chart' && (
          <div className="space-y-3">
            <select
              value={draft.config.dateFieldId}
              onChange={e => updateConfig({ dateFieldId: e.target.value })}
              className="w-full bg-slate-50 border border-slate-200 rounded-full py-2.5 px-4 text-sm font-medium outline-none appearance-none"
            >
              <option value="">Date field...</option>
              {dateFields.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>

            <div>
              <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block mb-1.5">Group by</label>
              <div className="grid grid-cols-3 gap-1.5">
                {(['day', 'week', 'month'] as const).map(g => (
                  <button
                    key={g}
                    onClick={() => updateConfig({ granularity: g })}
                    className={`py-2 rounded-full text-[11px] font-bold capitalize transition-all ${
                      (draft.config.granularity || 'day') === g ? 'bg-indigo-600 text-white' : 'bg-slate-50 text-slate-500 hover:bg-slate-100'
                    }`}
                  >
                    {g}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">Series</label>
                {(draft.config.series?.length || 0) < 8 && (
                  <button onClick={addSeries} className="flex items-center gap-1 text-[10px] font-bold text-indigo-600 hover:text-indigo-700">
                    <Plus size={11} /> Add series
                  </button>
                )}
              </div>
              {(draft.config.series || []).map((s, si) => (
                <div key={si} className="p-3 bg-slate-50/60 border border-slate-200 rounded-2xl space-y-2">
                  <div className="flex items-center gap-1.5">
                    <input
                      value={s.label}
                      onChange={e => updateSeries(si, { label: e.target.value })}
                      placeholder="Series label (e.g. Billable Hours)"
                      className="flex-1 bg-white border border-slate-200 rounded-full py-2 px-3 text-[12px] font-medium outline-none"
                    />
                    <button onClick={() => removeSeries(si)} className="shrink-0 p-1.5 text-slate-300 hover:text-red-500"><X size={13} /></button>
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    <select
                      value={s.aggregate}
                      onChange={e => updateSeries(si, { aggregate: e.target.value as ChartSeriesConfig['aggregate'] })}
                      className="bg-white border border-slate-200 rounded-full py-2 px-3 text-[12px] font-medium outline-none appearance-none"
                    >
                      <option value="sum">Sum a field</option>
                      <option value="count">Count entries</option>
                      <option value="count-distinct">Count distinct values</option>
                    </select>
                    {(s.aggregate === 'sum' || s.aggregate === 'count-distinct') && (
                      <select
                        value={s.valueFieldId || ''}
                        onChange={e => updateSeries(si, { valueFieldId: e.target.value || null })}
                        className="bg-white border border-slate-200 rounded-full py-2 px-3 text-[12px] font-medium outline-none appearance-none"
                      >
                        <option value="">Value field...</option>
                        {(s.aggregate === 'sum' ? numericFields : fields).map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
                      </select>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">Only when... (all must match)</label>
                      <button onClick={() => addSeriesCondition(si)} className="flex items-center gap-1 text-[10px] font-bold text-indigo-600 hover:text-indigo-700">
                        <Plus size={11} /> Add condition
                      </button>
                    </div>
                    {(s.conditions || []).map((cond, ci) => (
                      <ConditionRow
                        key={ci}
                        condition={cond}
                        fields={fields}
                        onChange={patch => updateSeriesCondition(si, ci, patch)}
                        onRemove={() => removeSeriesCondition(si, ci)}
                      />
                    ))}
                  </div>
                </div>
              ))}
              {(!draft.config.series || draft.config.series.length === 0) && (
                <p className="text-[11px] text-slate-300 italic py-1">No series yet — add one to plot a measure</p>
              )}
            </div>

            <p className="text-[10px] text-slate-400 px-1">
              Tip: plot multiple series of the SAME unit on one chart (e.g. billable vs non-billable hours). For different units, use separate chart widgets.
            </p>
          </div>
        )}

        {(draft.type === 'trust_reconciliation' || draft.type === 'ledes_export'
          || draft.type === 'trust_ledger_statement' || draft.type === 'trust_cash_book') && (
          <p className="text-[11px] text-slate-400 italic">No settings — it always reads this dashboard's own table.</p>
        )}

        {draft.type === 'trust_aged_balances' && (
          <div>
            <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block mb-1.5">Flag dormant after (days)</label>
            <input
              type="number"
              min={1}
              value={draft.config.dormantDays}
              onChange={e => updateConfig({ dormantDays: Math.max(1, parseInt(e.target.value, 10) || 365) })}
              className="w-full bg-slate-50 border border-slate-200 rounded-full py-2.5 px-4 text-sm font-medium outline-none focus:ring-4 focus:ring-indigo-100"
            />
          </div>
        )}

        <div className="flex gap-2 pt-2">
          <button onClick={onClose} className="flex-1 py-2.5 bg-slate-50 text-slate-600 rounded-full text-[11px] font-bold hover:bg-slate-100 transition-all">Cancel</button>
          <button onClick={() => onSave(draft)} className="flex-1 py-2.5 bg-indigo-600 text-white rounded-full text-[11px] font-bold hover:bg-indigo-700 transition-all">Done</button>
        </div>
      </div>
    </div>
  );
}
