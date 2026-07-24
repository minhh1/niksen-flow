"use client";

import { useState, useEffect, useRef } from "react";
import { Loader2, X } from "lucide-react";
import { supabase } from "@/lib/supabase";

interface RelationOption { id: string; label: string }

// Sentinel filterValue set by FieldConfigPanel when an admin restricts a
// relation to "Signed-in user only" -- there's no static value to type in
// for "whoever is signed in", so it's resolved to the real auth uid here at
// query time instead.
const CURRENT_USER_SENTINEL = '$current_user';

// Module-level (not per-component) dedup + short-lived cache for the two
// mount-time fetches below (label resolution, "signed-in user" auto-select).
// A dashboard commonly renders the SAME field (e.g. Staff) in more than one
// widget at once -- the filter bar and the quick-add form both mount their
// own RelationPicker for it -- and with no sharing between instances, each
// independently fires the identical request the moment it mounts (confirmed
// live: two concurrent, byte-for-byte identical queries for one page load).
// `inFlight` collapses concurrent callers onto one real request; `cache`
// then serves the same key again for a short window after -- e.g.
// navigating back to a dashboard right after leaving it, or two widgets
// that don't happen to mount in the exact same tick. 30s: long enough to
// cover realistic mount timing and quick re-navigation, short enough that
// something like a newly-linked team member doesn't stay stale for long.
// Deliberately NOT used for the search-on-open query below -- that's a
// direct user action that should always hit fresh data, not a mount-time
// stampede.
const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { value: unknown; expiresAt: number }>();
const inFlight = new Map<string, Promise<unknown>>();

function dedupedFetch<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.value as T);
  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T>;
  const promise = fetcher()
    .then(value => {
      inFlight.delete(key);
      // Prune expired entries here rather than on a timer -- cache stays
      // small in practice (a handful of relation fields per dashboard) so
      // this is cheap, and it means no cleanup interval to leak/forget.
      const now = Date.now();
      for (const [k, v] of cache) if (v.expiresAt <= now) cache.delete(k);
      cache.set(key, { value, expiresAt: now + CACHE_TTL_MS });
      return value;
    })
    .catch(err => { inFlight.delete(key); throw err; });
  inFlight.set(key, promise);
  return promise;
}

async function resolveFilterValue(filterValue: string | null | undefined): Promise<string | null> {
  if (filterValue !== CURRENT_USER_SENTINEL) return filterValue ?? null;
  // Keyed on nothing but "current user" -- every field needing this shares
  // one cached/in-flight lookup regardless of which table/filter it's for.
  return dedupedFetch('current-user-id', async () => {
    const { data: { user } } = await supabase.auth.getUser();
    return user?.id ?? null;
  });
}

interface Props {
  // Exactly one of these identifies the target — a system table (entities/
  // projects/properties) or a sibling custom table.
  linkedSystemTable?: string | null;
  linkedTableId?: string | null;
  displayField?: string | null; // system-table column to search/show, default 'name'
  // Extra fields to match the search query against, besides displayField --
  // native column names, or 'cf:<company_custom_fields.id>' for a custom
  // field (e.g. Matter Number on projects). System table only. Configured
  // per-field in components/schema/FieldConfigPanel.tsx.
  searchFieldKeys?: string[] | null;
  // Restricts results to rows where this native column equals this value
  // (e.g. entity_type = 'Staff'). System table only. Never applied when
  // resolving the *current* value's label, so an out-of-filter selection
  // still displays correctly.
  filterColumn?: string | null;
  filterValue?: string | null;
  value: string | null;
  onSelect: (id: string | null, label: string | null) => void;
  disabled?: boolean;
  placeholder?: string;
  // Already-resolved label for `value`, when the caller has one (e.g. a
  // grid row's CustomTableRecord.displayValues, batched once per relation
  // field for the whole record set -- see resolveRelationLabels in
  // lib/hooks/useCustomTable.ts). When given, skips this component's own
  // per-instance label fetch entirely -- without it, a grid of N rows each
  // mounting their own RelationPicker independently re-fetches the same
  // label N times over, which at real volume (hundreds/thousands of rows)
  // floods the browser with concurrent requests until it starts failing
  // with ERR_INSUFFICIENT_RESOURCES (confirmed on a 1000-row trust ledger
  // grid). Only ever used to seed the initial label -- if `value` changes
  // later without a matching prop update, the normal fetch path resolves it.
  initialLabel?: string;
}

// Resolves the primary display field's value for one record of a custom
// (company_tables) table -- used both to label the currently-selected value
// and to build the search results list.
async function fetchCustomTableRecordLabels(tableId: string, recordIds?: string[]): Promise<RelationOption[]> {
  const { data: tableRow } = await supabase.from('company_tables').select('primary_field_key').eq('id', tableId).maybeSingle();
  const { data: fieldsData } = await supabase.from('company_table_fields').select('id, field_key').eq('table_id', tableId).is('deleted_at', null);
  const primaryField = (fieldsData || []).find(f => f.field_key === tableRow?.primary_field_key) || (fieldsData || [])[0];
  if (!primaryField) return [];

  let query = supabase
    .from('company_table_records')
    .select('id, values:company_table_values(field_id, value_text, value_number, value_date, value_boolean)')
    .eq('table_id', tableId)
    .is('deleted_at', null);
  if (recordIds) query = query.in('id', recordIds);
  else query = query.limit(200);

  const { data: records } = await query;
  return (records || []).map((r: any) => {
    const v = (r.values || []).find((val: any) => val.field_id === primaryField.id);
    const label = v ? (v.value_text ?? v.value_number ?? v.value_date ?? '') : '';
    return { id: r.id, label: String(label || 'Untitled') };
  });
}

export default function RelationPicker({
  linkedSystemTable, linkedTableId, displayField, searchFieldKeys, filterColumn, filterValue,
  value, onSelect, disabled, placeholder, initialLabel,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<RelationOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [currentLabel, setCurrentLabel] = useState(initialLabel ?? '');
  const containerRef = useRef<HTMLDivElement>(null);
  // Which value id `currentLabel` is already known-correct for -- set
  // synchronously by the picker's own click handler (it already knows the
  // label of whatever it just clicked) so the resolution effect below can
  // skip a redundant round-trip for a selection that was just made here.
  // Seeded from `initialLabel` too, for the same reason -- a caller-supplied
  // label is just as "already known-correct" as a just-made selection.
  const resolvedForRef = useRef<string | null>(initialLabel !== undefined && value ? value : null);
  // Set only by the picker's own clear (X) button, never by the auto-select
  // effect below -- lets a "Signed-in user only" field actually stay empty
  // after a deliberate clear, instead of the effect immediately refilling
  // it the moment `value` goes back to null.
  const userClearedRef = useRef(false);

  // Resolve the current value's display label whenever it changes.
  useEffect(() => {
    if (!value) { setCurrentLabel(''); resolvedForRef.current = null; return; }
    if (resolvedForRef.current === value) return;
    let active = true;
    const cacheKey = `label:${linkedSystemTable ?? ''}:${linkedTableId ?? ''}:${displayField ?? ''}:${value}`;
    dedupedFetch(cacheKey, async () => {
      let label = '';
      if (linkedSystemTable) {
        const col = displayField || 'name';
        // .is('deleted_at', null) matches the linkedTableId branch below
        // (fetchCustomTableRecordLabels always filters it) -- without this,
        // a relation pointing at a soft-deleted entity/project/property
        // would keep showing its stale label forever, inconsistently with
        // how a deleted custom-table record's relation goes blank instead.
        const { data } = await supabase.from(linkedSystemTable).select(`id, ${col}`).eq('id', value).is('deleted_at', null).maybeSingle();
        return data ? String((data as any)[col] ?? '') : '';
      } else if (linkedTableId) {
        const [opt] = await fetchCustomTableRecordLabels(linkedTableId, [value]);
        return opt?.label || '';
      }
      return label;
    }).then(label => {
      if (active) { setCurrentLabel(label); resolvedForRef.current = value; }
    });
    return () => { active = false; };
  }, [value, linkedSystemTable, linkedTableId, displayField]);

  // Auto-fills a "Signed-in user only" field the moment it mounts empty --
  // that filter can only ever match zero or one row (the entity linked to
  // the current auth user), so there's nothing to pick from a list; picking
  // it automatically is the point ("map the time entry to the team member"
  // without an extra click every time). No separate "only once" ref guard --
  // the `if (value || ...) return` below already stops it from re-running
  // once a value is set, and a plain boolean ref turned out to be actively
  // harmful: React's dev-mode StrictMode double-invokes this effect
  // (mount -> cleanup -> mount again) on the SAME ref instance, so a
  // "have I already tried" flag set by the first (deliberately-cancelled)
  // invocation was still `true` on the second, real one -- permanently
  // skipping the fetch that would have actually landed. Confirmed live: the
  // request always resolved with the right row, just always into an
  // `active === false` closure.
  useEffect(() => {
    if (value || userClearedRef.current || !linkedSystemTable || filterColumn !== 'linked_profile_id' || filterValue !== CURRENT_USER_SENTINEL) return;
    let active = true;
    const col = displayField || 'name';
    const cacheKey = `autoSelect:${linkedSystemTable}:${filterColumn}:${filterValue}:${col}`;
    dedupedFetch(cacheKey, async () => {
      const userId = await resolveFilterValue(filterValue);
      if (!userId) return null;
      const { data } = await supabase.from(linkedSystemTable).select(`id, ${col}`).eq('linked_profile_id', userId).is('deleted_at', null).maybeSingle();
      return data as { id: string; [key: string]: unknown } | null;
    }).then(row => {
      if (active && row) {
        const label = String(row[col] ?? '');
        setCurrentLabel(label);
        resolvedForRef.current = row.id;
        onSelect(row.id, label);
      }
    });
    return () => { active = false; };
    // onSelect deliberately excluded -- callers pass a fresh inline function
    // every render (e.g. FieldValueInput's `id => onCommit(id)`), so
    // including it here re-ran this effect (and cancelled the in-flight
    // fetch via the cleanup's `active = false`) on every unrelated parent
    // re-render, before the request had a chance to resolve. Matches the
    // same omission already made in the label-resolution effect above.
  }, [value, linkedSystemTable, filterColumn, filterValue, displayField]);

  // Search as the dropdown is open / query changes.
  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    const timer = setTimeout(async () => {
      let results: RelationOption[] = [];
      if (linkedSystemTable) {
        const col = displayField || 'name';
        const nativeExtra = (searchFieldKeys || []).filter(k => !k.startsWith('cf:'));
        const cfIds = (searchFieldKeys || []).filter(k => k.startsWith('cf:')).map(k => k.slice(3));

        if (nativeExtra.length === 0 && cfIds.length === 0 && !filterColumn) {
          // Common case, unchanged: one column, server-side ilike + limit.
          let q = supabase.from(linkedSystemTable).select(`id, ${col}`).is('deleted_at', null).order(col).limit(20);
          if (query.trim()) q = q.ilike(col, `%${query.trim()}%`);
          const { data } = await q;
          results = (data || []).map((r: any) => ({ id: r.id, label: String(r[col] ?? 'Untitled') }));
        } else {
          // Extra search fields and/or a restrict-to filter -- fetch a
          // wider candidate set and match client-side, same scale
          // assumption RelationPicker already makes for custom tables.
          const nativeCols = Array.from(new Set([col, ...nativeExtra]));
          let rowsQuery = supabase.from(linkedSystemTable).select(`id, ${nativeCols.join(', ')}`).is('deleted_at', null).order(col).limit(200);
          if (filterColumn) {
            const resolvedValue = await resolveFilterValue(filterValue);
            rowsQuery = resolvedValue ? rowsQuery.eq(filterColumn, resolvedValue) : rowsQuery.eq(filterColumn, '__none__');
          }
          const { data: rows } = await rowsQuery;

          const cfTextByRecord = new Map<string, string[]>();
          if (cfIds.length && rows?.length) {
            const { data: cfRows } = await supabase
              .from('company_custom_field_values')
              .select('record_id, value_text')
              .in('field_id', cfIds)
              .in('record_id', rows.map((r: any) => r.id));
            (cfRows || []).forEach((v: any) => {
              const list = cfTextByRecord.get(v.record_id) || [];
              list.push(v.value_text || '');
              cfTextByRecord.set(v.record_id, list);
            });
          }

          const q = query.trim().toLowerCase();
          const candidates = (rows || []).map((r: any) => {
            const searchText = [...nativeCols.map(c => r[c]), ...(cfTextByRecord.get(r.id) || [])]
              .filter(Boolean).join(' ').toLowerCase();
            return { id: r.id, label: String(r[col] ?? 'Untitled'), searchText };
          });
          results = (q ? candidates.filter(c => c.searchText.includes(q)) : candidates)
            .slice(0, 20)
            .map(({ id, label }) => ({ id, label }));
        }
      } else if (linkedTableId) {
        const all = await fetchCustomTableRecordLabels(linkedTableId);
        const q = query.trim().toLowerCase();
        results = (q ? all.filter(o => o.label.toLowerCase().includes(q)) : all).slice(0, 20);
      }
      if (active) { setOptions(results); setLoading(false); }
    }, 200);
    return () => { active = false; clearTimeout(timer); };
  }, [open, query, linkedSystemTable, linkedTableId, displayField, searchFieldKeys, filterColumn, filterValue]);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) { setOpen(false); setQuery(''); }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  if (disabled) {
    return (
      <div className="w-full bg-slate-50 border border-slate-200 rounded-full py-2 px-3.5 text-[13px] font-medium text-slate-500 truncate">
        {currentLabel || '—'}
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative w-full">
      <div
        onClick={() => setOpen(true)}
        className="w-full bg-slate-50 border border-slate-200 rounded-full py-2 px-3.5 text-[13px] font-medium outline-none cursor-pointer flex items-center justify-between gap-2 focus-within:ring-2 focus-within:ring-indigo-100"
      >
        {open ? (
          <input
            autoFocus
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={placeholder || 'Search...'}
            className="w-full bg-transparent outline-none"
          />
        ) : (
          <span className={`truncate ${currentLabel ? 'text-slate-700' : 'text-slate-400'}`}>
            {currentLabel || placeholder || 'Select...'}
          </span>
        )}
        {currentLabel && !open && (
          <button
            type="button"
            onClick={e => { e.stopPropagation(); setCurrentLabel(''); resolvedForRef.current = null; userClearedRef.current = true; onSelect(null, null); }}
            className="text-slate-300 hover:text-red-500 shrink-0"
          >
            <X size={12} />
          </button>
        )}
      </div>

      {open && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-slate-200 rounded-2xl shadow-xl z-50 max-h-60 overflow-y-auto">
          {loading ? (
            <div className="flex justify-center py-4"><Loader2 size={14} className="animate-spin text-slate-300" /></div>
          ) : options.length === 0 ? (
            <p className="text-[11px] text-slate-300 italic text-center py-4">No matches</p>
          ) : (
            options.map(opt => (
              <button
                key={opt.id}
                type="button"
                onClick={() => {
                  // Already know the label from the option clicked -- set it
                  // immediately instead of waiting on the value-resolution
                  // effect below to re-fetch it from the server, which was
                  // the visible lag on every relation pick.
                  setCurrentLabel(opt.label);
                  resolvedForRef.current = opt.id;
                  onSelect(opt.id, opt.label);
                  setQuery('');
                  setOpen(false);
                }}
                className="w-full text-left px-4 py-2 text-[12px] font-medium text-slate-700 hover:bg-indigo-50 transition-colors"
              >
                {opt.label}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
