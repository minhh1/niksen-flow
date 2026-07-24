// Hand-rolled, line-based "code mode" syntax for authoring a dashboard's
// widgets as text instead of dragging them on a canvas. Deliberately NOT
// real HTML/JS and never eval'd -- one widget keyword + key=value pairs per
// line, parsed with plain regex/string splitting. Field references are
// field_key (or label, case-insensitively) text, resolved against the real,
// live CustomTableField[] for the dashboard's bound source table at parse
// time -- an unresolved reference is a line-numbered error, not a crash.
//
// Grammar (one widget per non-blank, non-comment line; `#` starts a line
// comment; any line may end with `width=6` for half-width, default full/12):
//   heading "<text>" [level=1|2|3]
//   text "<text>"
//   filter_bar fields=<key>[,<key>...]
//   quick_add_form fields=<key>[,<key>...]
//   grid fields=<key>[,<key>...] [empty_rows=<n>] [when=<cond>[,<cond>...]] [totals=true]
//   tile "<label>" field=<key> agg=sum|count|net|count-distinct [field_b=<key>] [when=<cond>[,<cond>...]]
//   chart date=<key> [value=<key> agg=sum|count] [group=day|week|month]
//   series ["<label>"] field=<key> agg=sum|count|count-distinct [when=<cond>[,<cond>...]]
//   trust_reconciliation
//   ledes_export
//   trust_ledger_statement
//   trust_cash_book
//   trust_aged_balances [dormant_days=<n>]
//
// One or more `series` lines directly after a `chart` line add measures to
// it (a multi-series chart) instead of starting new widgets -- e.g.
//   chart date=due_date group=month
//   series "Billable Hours" field=duration_hours agg=sum when=billable:eq:true
//   series "Non-billable Hours" field=duration_hours agg=sum when=billable:eq:false
// `series` is recognized by keyword alone, NOT by indentation (indenting it
// is a purely cosmetic convention the serializer follows, not something the
// parser checks) -- blank lines between `chart` and its `series` lines are
// fine, but any OTHER widget line in between breaks the chain and makes a
// later `series` line an "orphan" error. The label quote is optional for
// `series` (unlike tile/heading) since a series often needs no label. A
// bare `chart` line with no following `series` lines still works standalone
// as one implicit series, for backward compatibility with every dashboard
// saved before multi-series support.
//
// A tile's `when=` is a comma-separated list of conditions, every one of
// which must match (AND) -- <cond> is `<key>:<op>:<value>`, e.g.
// `when=billable:eq:false` or `when=billable:eq:false,type:eq:TimeBased`
// for "non-billable time entries". <op> is one of eq/neq/contains/gt/gte/
// lt/lte/is_set/is_empty (is_set and is_empty take no value: `matter:is_set`).
// Bare `when=<key>` (no colon) is shorthand for `<key>:eq:true`, kept for
// backward compatibility with the original boolean-only syntax.
//
// Whitespace is tolerated around `=` and around the `:`/`,` separators
// *inside* an already-captured value (`title : eq : B` parses the same as
// `title:eq:B`) but NOT as part of what delimits that value in the first
// place: every unquoted value (fields=, when=, etc.) is still "the next
// run of non-whitespace characters" -- `fields=a, b, c` (space after each
// comma) truncates at the first space, capturing only `a,` for `fields=`
// and silently leaving `b, c` as unconsumed text with no error. Don't put
// a space after a comma inside an unquoted list.
//
// Position is never expressed in text -- widgets stack top-to-bottom in
// write order (see DEFAULT_LAYOUT_BY_TYPE for each type's default height).
import type { CustomTableField } from "@/lib/hooks/useCustomTable";
import type { DashboardWidget, DashboardWidgetType, ChartWidget, TileCondition } from "./types";
import { DEFAULT_LAYOUT_BY_TYPE } from "./defaults";

export interface DslParseError { line: number; message: string }
export interface DslParseResult { widgets: DashboardWidget[]; errors: DslParseError[] }

const QUOTED_LEADING_TYPES = new Set<DashboardWidgetType>(['heading', 'text', 'summary_tile']);
const KEYWORD_TO_TYPE: Record<string, DashboardWidgetType> = {
  heading: 'heading',
  text: 'text',
  filter_bar: 'filter_bar',
  quick_add_form: 'quick_add_form',
  grid: 'grid',
  tile: 'summary_tile',
  chart: 'chart',
  trust_reconciliation: 'trust_reconciliation',
  ledes_export: 'ledes_export',
  trust_ledger_statement: 'trust_ledger_statement',
  trust_cash_book: 'trust_cash_book',
  trust_aged_balances: 'trust_aged_balances',
};

function buildFieldLookup(fields: CustomTableField[]) {
  const byLabel = new Map<string, CustomTableField>();
  const byKey = new Map<string, CustomTableField>();
  for (const f of fields) {
    byLabel.set(f.label.toLowerCase(), f);
    byKey.set(f.field_key.toLowerCase(), f);
  }
  return (token: string): CustomTableField | undefined => {
    const t = token.trim().toLowerCase();
    return byKey.get(t) || byLabel.get(t);
  };
}

// Strips a trailing ` # comment`, respecting simple double-quoted strings
// (a `#` inside quotes is just text, e.g. a heading whose text mentions one).
function stripComment(line: string): string {
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') inQuotes = !inQuotes;
    else if (line[i] === '#' && !inQuotes) return line.slice(0, i);
  }
  return line;
}

// \s* around `=` tolerates `key = value` (spaces either side) -- without
// it, a space right after `=` made \S+ fail to match at all, silently
// dropping that entire key=value pair (confirmed: `when= amount:gt:100`
// parsed as if `when=` were never written, with no error).
function parseKeyValues(str: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /(\w+)\s*=\s*("([^"]*)"|\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(str))) {
    out[m[1]] = m[3] !== undefined ? m[3] : m[2];
  }
  return out;
}

export function parseDSL(source: string, fields: CustomTableField[]): DslParseResult {
  const lookupField = buildFieldLookup(fields);
  const widgets: DashboardWidget[] = [];
  const errors: DslParseError[] = [];
  let y = 0;
  // The chart a `series` line (see the grammar comment) attaches to. Set
  // whenever a `chart` line parses successfully; cleared by ANY other
  // line (including one that errors) so a `series` line separated from
  // its chart by something else is an orphan, not a silent mis-attach to
  // an earlier chart several lines up.
  let currentChartWidget: ChartWidget | null = null;

  const resolveFieldToken = (token: string, lineNo: number): string | null => {
    const field = lookupField(token);
    if (!field) {
      errors.push({ line: lineNo, message: `Unknown field "${token}"` });
      return null;
    }
    return field.id;
  };

  // Parses a tile's `when=` value into TileCondition[] -- see the grammar
  // comment above for the `<key>:<op>:<value>` format and the bare-`<key>`
  // backward-compat shorthand. Unresolved field tokens are dropped (the
  // "Unknown field" error already came from resolveFieldToken above), so a
  // typo in one condition doesn't discard every other condition on the line.
  const VALID_OPERATORS = new Set(['eq', 'neq', 'contains', 'gt', 'gte', 'lt', 'lte', 'is_set', 'is_empty']);
  const parseConditions = (whenStr: string | undefined, lineNo: number): TileCondition[] => {
    if (!whenStr) return [];
    const conditions: TileCondition[] = [];
    for (const piece of whenStr.split(',').map(s => s.trim()).filter(Boolean)) {
      // Each `:`-separated part is trimmed individually -- resolveFieldToken
      // already trims the field part internally, but the operator/value
      // parts weren't, so `title : eq : B` (spaces around the colons) used
      // to fail VALID_OPERATORS.has(" eq ") and silently drop the condition.
      const parts = piece.split(':').map(p => p.trim());
      const fieldId = resolveFieldToken(parts[0], lineNo);
      if (!fieldId) continue;
      if (parts.length === 1) {
        conditions.push({ fieldId, operator: 'eq', value: true });
        continue;
      }
      const rawOperator = parts[1] || 'eq';
      if (!VALID_OPERATORS.has(rawOperator)) {
        errors.push({ line: lineNo, message: `Unknown condition operator "${rawOperator}"` });
        continue;
      }
      const operator = rawOperator as TileCondition['operator'];
      const rawValue = parts.length > 2 ? parts.slice(2).join(':') : undefined;
      let value: any = rawValue;
      if (rawValue === 'true') value = true;
      else if (rawValue === 'false') value = false;
      else if (rawValue !== undefined && rawValue.trim() !== '' && !Number.isNaN(Number(rawValue))) value = Number(rawValue);
      conditions.push({ fieldId, operator, value });
    }
    return conditions;
  };

  const lines = source.split('\n');
  lines.forEach((rawLine, idx) => {
    const lineNo = idx + 1;
    const line = stripComment(rawLine).trim();
    if (!line) return;

    const kwMatch = line.match(/^(\w+)\s*([\s\S]*)$/);
    if (!kwMatch) { currentChartWidget = null; return; }
    const [, keyword, rest] = kwMatch;

    if (keyword === 'series') {
      if (!currentChartWidget) {
        errors.push({ line: lineNo, message: `"series" must directly follow a chart widget (no other widget line in between)` });
        return;
      }
      let remainder = rest;
      let label = '';
      // Quote is OPTIONAL here (unlike tile/heading) -- a series often
      // needs no label; computeChartSeries already falls back to the
      // value field's own label when one isn't given.
      const qMatch = remainder.match(/^"([^"]*)"\s*([\s\S]*)$/);
      if (qMatch) { label = qMatch[1]; remainder = qMatch[2]; }
      const kv = parseKeyValues(remainder);
      const aggregate = kv.agg === 'count' ? 'count' : kv.agg === 'count-distinct' ? 'count-distinct' : 'sum';
      if (aggregate !== 'count' && !kv.field) {
        errors.push({ line: lineNo, message: `series with agg=sum or agg=count-distinct requires a valid field=<field> (or agg=count)` });
        return;
      }
      const valueFieldId = kv.field ? resolveFieldToken(kv.field, lineNo) : null;
      const conditions = parseConditions(kv.when, lineNo);
      (currentChartWidget.config.series ||= []).push({ label, valueFieldId, aggregate, conditions });
      return; // no y increment, no new widget -- this line augments the chart, doesn't push one
    }
    currentChartWidget = null; // any other keyword line breaks the series-attachment chain

    const type = KEYWORD_TO_TYPE[keyword];
    if (!type) {
      errors.push({ line: lineNo, message: `Unknown widget type "${keyword}"` });
      return;
    }

    let remainder = rest;
    let quoted = '';
    if (QUOTED_LEADING_TYPES.has(type)) {
      const qMatch = remainder.match(/^"([^"]*)"\s*([\s\S]*)$/);
      if (!qMatch) {
        errors.push({ line: lineNo, message: `Expected a quoted "text" after "${keyword}"` });
        return;
      }
      quoted = qMatch[1];
      remainder = qMatch[2];
    }

    const kv = parseKeyValues(remainder);
    const w = kv.width ? parseInt(kv.width, 10) : DEFAULT_LAYOUT_BY_TYPE[type].w;
    const h = DEFAULT_LAYOUT_BY_TYPE[type].h;
    const layout = { x: 0, y, w: Number.isFinite(w) && w > 0 ? Math.min(w, 12) : 12, h };
    const id = crypto.randomUUID();

    // Deduplicates by resolved field id (not raw token text), so
    // `fields=Title,title` -- same field, different case -- collapses to
    // one entry just like a literal repeat does; a repeated column would
    // otherwise render twice and collide on React key in DashboardGrid.
    const resolveFieldsList = (csv: string | undefined): string[] => {
      if (!csv) return [];
      const seen = new Set<string>();
      const ids: string[] = [];
      for (const tok of csv.split(',').map(s => s.trim()).filter(Boolean)) {
        const id = resolveFieldToken(tok, lineNo);
        if (id && !seen.has(id)) { seen.add(id); ids.push(id); }
      }
      return ids;
    };

    switch (type) {
      case 'heading':
        widgets.push({ id, type, layout, config: { text: quoted, level: (kv.level ? parseInt(kv.level, 10) : 2) as 1 | 2 | 3 } });
        break;
      case 'text':
        widgets.push({ id, type, layout, config: { text: quoted } });
        break;
      case 'filter_bar':
        widgets.push({ id, type, layout, config: { fieldIds: resolveFieldsList(kv.fields) } });
        break;
      case 'quick_add_form':
        widgets.push({ id, type, layout, config: { fieldIds: resolveFieldsList(kv.fields) } });
        break;
      case 'grid': {
        const emptyRowCount = kv.empty_rows ? Math.max(0, Math.min(20, parseInt(kv.empty_rows, 10) || 0)) : undefined;
        const conditions = parseConditions(kv.when, lineNo);
        const showTotalsRow = kv.totals === 'true' ? true : undefined;
        widgets.push({ id, type, layout, config: { fieldIds: resolveFieldsList(kv.fields), emptyRowCount, conditions, showTotalsRow } });
        break;
      }
      case 'summary_tile': {
        const aggregate = kv.agg === 'count' ? 'count' : kv.agg === 'net' ? 'net' : kv.agg === 'count-distinct' ? 'count-distinct' : 'sum';
        // A count doesn't need a field at all; sum/net are meaningless
        // without one -- mirrors chart's `date=` requirement below (a tile
        // silently defaulting to showing 0 forever, with no error, was the
        // inconsistency: chart already required its key field, tile didn't).
        // Checked against the raw token, not the resolved id, so a genuinely
        // missing field= gets this message while an invalid one still gets
        // resolveFieldToken's own "Unknown field" error instead of both.
        if (aggregate !== 'count' && !kv.field) {
          errors.push({ line: lineNo, message: `tile requires a valid field=<field> (or agg=count)` });
          break;
        }
        if (aggregate === 'net' && !kv.field_b) {
          errors.push({ line: lineNo, message: `tile with agg=net requires a valid field_b=<field>` });
          break;
        }
        const fieldId = kv.field ? resolveFieldToken(kv.field, lineNo) : null;
        const fieldBId = kv.field_b ? resolveFieldToken(kv.field_b, lineNo) : null;
        const conditions = parseConditions(kv.when, lineNo);
        widgets.push({
          id, type, layout,
          config: { label: quoted, fieldId, aggregate, fieldBId, conditions },
        });
        break;
      }
      case 'chart': {
        const dateFieldId = kv.date ? resolveFieldToken(kv.date, lineNo) : null;
        if (!dateFieldId) {
          errors.push({ line: lineNo, message: `chart requires a valid date=<field>` });
          break;
        }
        const valueFieldId = kv.value ? resolveFieldToken(kv.value, lineNo) : null;
        const granularity = kv.group === 'week' ? 'week' as const : kv.group === 'month' ? 'month' as const : 'day' as const;
        const widget: ChartWidget = {
          id, type, layout,
          config: { dateFieldId, valueFieldId, aggregate: kv.agg === 'count' ? 'count' : 'sum', granularity, series: [] },
        };
        widgets.push(widget);
        currentChartWidget = widget; // subsequent `series` lines attach here until something else breaks the chain
        break;
      }
      case 'trust_reconciliation':
        widgets.push({ id, type, layout, config: {} });
        break;
      case 'ledes_export':
        widgets.push({ id, type, layout, config: {} });
        break;
      case 'trust_ledger_statement':
        widgets.push({ id, type, layout, config: {} });
        break;
      case 'trust_cash_book':
        widgets.push({ id, type, layout, config: {} });
        break;
      case 'trust_aged_balances': {
        const dormantDays = kv.dormant_days ? Math.max(1, parseInt(kv.dormant_days, 10) || 365) : 365;
        widgets.push({ id, type, layout, config: { dormantDays } });
        break;
      }
    }

    y += h;
  });

  return { widgets, errors };
}

export function serializeToDSL(widgets: DashboardWidget[], fields: CustomTableField[]): string {
  const fieldById = new Map(fields.map(f => [f.id, f]));
  const fieldKey = (id: string | null | undefined) => (id ? (fieldById.get(id)?.field_key ?? id) : '');
  const fieldKeys = (ids: string[]) => ids.map(fieldKey).filter(Boolean).join(',');
  const widthSuffix = (w: number) => (w <= 6 ? ` width=${w}` : '');

  return [...widgets]
    .sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x)
    .map(w => {
      switch (w.type) {
        case 'heading':
          return `heading "${w.config.text}" level=${w.config.level}${widthSuffix(w.layout.w)}`;
        case 'text':
          return `text "${w.config.text}"${widthSuffix(w.layout.w)}`;
        case 'filter_bar':
          return `filter_bar fields=${fieldKeys(w.config.fieldIds)}${widthSuffix(w.layout.w)}`;
        case 'quick_add_form':
          return `quick_add_form fields=${fieldKeys(w.config.fieldIds)}${widthSuffix(w.layout.w)}`;
        case 'grid': {
          const emptyRows = w.config.emptyRowCount ? ` empty_rows=${w.config.emptyRowCount}` : '';
          const when = w.config.conditions?.length
            ? ` when=${w.config.conditions.map(c => {
                const key = fieldKey(c.fieldId);
                return (c.operator === 'is_set' || c.operator === 'is_empty') ? `${key}:${c.operator}` : `${key}:${c.operator}:${c.value}`;
              }).join(',')}`
            : '';
          const totals = w.config.showTotalsRow ? ` totals=true` : '';
          return `grid fields=${fieldKeys(w.config.fieldIds)}${emptyRows}${when}${totals}${widthSuffix(w.layout.w)}`;
        }
        case 'summary_tile': {
          // Falls back to the deprecated single filterFieldId/filterValue
          // shape (as one implicit `eq` condition) for a tile saved before
          // multi-condition support -- matches computeSummaryTileValue's
          // same fallback in lib/dashboardWidgets/compute.ts.
          const conditions = w.config.conditions?.length
            ? w.config.conditions
            : (w.config.filterFieldId ? [{ fieldId: w.config.filterFieldId, operator: 'eq' as const, value: w.config.filterValue ?? true }] : []);
          const when = conditions.length
            ? ` when=${conditions.map(c => {
                const key = fieldKey(c.fieldId);
                return (c.operator === 'is_set' || c.operator === 'is_empty') ? `${key}:${c.operator}` : `${key}:${c.operator}:${c.value}`;
              }).join(',')}`
            : '';
          const fieldB = w.config.aggregate === 'net' && w.config.fieldBId ? ` field_b=${fieldKey(w.config.fieldBId)}` : '';
          return `tile "${w.config.label}" field=${fieldKey(w.config.fieldId)} agg=${w.config.aggregate}${fieldB}${when}${widthSuffix(w.layout.w)}`;
        }
        case 'chart': {
          // group=day (the default) is always omitted, keeping serialization
          // minimal/stable -- matters for the parse->serialize->parse
          // idempotency contract other widgets are held to.
          const group = w.config.granularity && w.config.granularity !== 'day' ? ` group=${w.config.granularity}` : '';
          if (!w.config.series?.length) {
            // Compact single-line form -- only for a widget the new UI has
            // never touched (config.series empty/absent). Once a chart has
            // any series, always emit the multi-line form below, even for
            // exactly one series, since a series can carry a label/
            // conditions this compact line has no syntax for.
            return `chart date=${fieldKey(w.config.dateFieldId)} value=${fieldKey(w.config.valueFieldId)} agg=${w.config.aggregate ?? 'sum'}${group}${widthSuffix(w.layout.w)}`;
          }
          const lines = [`chart date=${fieldKey(w.config.dateFieldId)}${group}${widthSuffix(w.layout.w)}`];
          for (const s of w.config.series) {
            const labelPart = s.label ? `"${s.label}" ` : '';
            const when = s.conditions?.length
              ? ` when=${s.conditions.map(c => {
                  const key = fieldKey(c.fieldId);
                  return (c.operator === 'is_set' || c.operator === 'is_empty') ? `${key}:${c.operator}` : `${key}:${c.operator}:${c.value}`;
                }).join(',')}`
              : '';
            lines.push(`  series ${labelPart}field=${fieldKey(s.valueFieldId)} agg=${s.aggregate}${when}`);
          }
          return lines.join('\n');
        }
        case 'trust_reconciliation':
          return `trust_reconciliation${widthSuffix(w.layout.w)}`;
        case 'ledes_export':
          return `ledes_export${widthSuffix(w.layout.w)}`;
        case 'trust_ledger_statement':
          return `trust_ledger_statement${widthSuffix(w.layout.w)}`;
        case 'trust_cash_book':
          return `trust_cash_book${widthSuffix(w.layout.w)}`;
        case 'trust_aged_balances':
          return `trust_aged_balances dormant_days=${w.config.dormantDays}${widthSuffix(w.layout.w)}`;
      }
    })
    .join('\n');
}
