"use client";

// Trash: soft-deleted custom tables/fields (see supabase/schema_soft_delete.sql)
// plus soft-deleted records (custom table rows, and entities/projects/properties,
// which have used their own deleted_at for archiving since before this page
// existed). Deleting any of these just sets deleted_at -- nothing is actually
// touched until "Delete permanently" (a real DELETE, cascading to dependent rows).
//
// Record sections show the 50 most recently deleted rows per type, not every
// row ever archived -- companies can accumulate a lot of archived data over
// time, and this page has no pagination. Older archived records still exist
// and can be restored directly (`update company_table_records/entities/
// projects/properties set deleted_at = null where id = ...`), just not
// through this list.
//
// All six item types are normalised into one TrashItem shape so a single
// search box / time filter / sorted list can work across everything --
// "who deleted it" only exists for the four schema-level types (via
// schema_change_log, which is shape history, not data history -- see
// supabase/schema_change_log.sql), and "created by" only exists where the
// underlying table actually has a created_by column (table records,
// projects). Every field that isn't available for a given item is simply
// omitted rather than shown as a placeholder.
import { useState, useEffect, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Trash2, RotateCcw, Loader2, Table2, AlertTriangle, Search, Shield } from "lucide-react";
import * as LucideIcons from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useCompany } from "@/components/CompanyContext";
import { logSchemaChange } from "@/lib/services/schemaChangeLog";
import { useProgressBarWhile } from "@/components/TopProgressBar";

const RECORD_LIMIT = 50;

type Category = "table" | "table_field" | "system_field" | "dashboard" | "table_record" | "system_record";

const CATEGORY_META: Record<Category, { label: string; className: string }> = {
  table: { label: "Table", className: "bg-indigo-50 text-indigo-600" },
  table_field: { label: "Field", className: "bg-blue-50 text-blue-600" },
  system_field: { label: "Field", className: "bg-purple-50 text-purple-600" },
  dashboard: { label: "Dashboard", className: "bg-pink-50 text-pink-600" },
  table_record: { label: "Record", className: "bg-emerald-50 text-emerald-600" },
  system_record: { label: "Record", className: "bg-amber-50 text-amber-600" },
};

const TIME_RANGES = [
  { key: "all", label: "All time", ms: null },
  { key: "1h", label: "Last hour", ms: 60 * 60 * 1000 },
  { key: "24h", label: "Last 24 hours", ms: 24 * 60 * 60 * 1000 },
  { key: "3d", label: "Last 3 days", ms: 3 * 24 * 60 * 60 * 1000 },
] as const;
type TimeRangeKey = (typeof TIME_RANGES)[number]["key"];

interface TrashItem {
  id: string;
  category: Category;
  label: string;
  detailLine: string; // context + counts, e.g. "Test Contacts · 2 values"
  icon?: string;
  color?: string;
  deletedAt: string;
  deletedBy: string | null;
  createdAt: string | null;
  createdBy: string | null;
  restore: () => Promise<void>;
  purge: () => Promise<void>;
}

function fmtDate(iso: string | null) {
  return iso ? new Date(iso).toLocaleString() : null;
}

export default function TrashPage() {
  const router = useRouter();
  const { companyId, userId, isAdmin, loading: companyLoading } = useCompany();
  const [items, setItems] = useState<TrashItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [timeRange, setTimeRange] = useState<TimeRangeKey>("all");

  const load = useCallback(async () => {
    if (!companyId) return;
    setLoading(true);

    // ── Who deleted each schema-level item — most recent 'delete' log entry
    // per entity, resolved to a name. Record-level deletes aren't logged
    // here (see file header), so this only ever covers the four schema types.
    const { data: deleteLogs } = await supabase
      .from("schema_change_log")
      .select("entity_id, actor_id")
      .eq("company_id", companyId)
      .eq("action", "delete")
      .in("entity_type", ["company_table", "company_table_field", "company_custom_field", "company_dashboard"])
      .order("created_at", { ascending: false });

    const actorIds = Array.from(new Set((deleteLogs || []).map(l => l.actor_id).filter((v): v is string => !!v)));
    const { data: actorProfiles } = actorIds.length
      ? await supabase.from("profiles").select("id, full_name").in("id", actorIds)
      : { data: [] as { id: string; full_name: string | null }[] };
    const actorNameById = new Map((actorProfiles || []).map(p => [p.id, p.full_name || "Unknown"]));

    const deleterByEntityId = new Map<string, string>();
    (deleteLogs || []).forEach(log => {
      if (!deleterByEntityId.has(log.entity_id) && log.actor_id) {
        deleterByEntityId.set(log.entity_id, actorNameById.get(log.actor_id) || "Unknown");
      }
    });

    const results: TrashItem[] = [];

    // ── Tables ───────────────────────────────────────────────────
    const { data: trashedTables } = await supabase
      .from("company_tables").select("id, name, slug, icon, color, created_at, deleted_at")
      .eq("company_id", companyId).not("deleted_at", "is", null).order("deleted_at", { ascending: false });

    await Promise.all((trashedTables || []).map(async t => {
      const [{ count: recordCount }, { count: dashboardCount }] = await Promise.all([
        supabase.from("company_table_records").select("id", { count: "exact", head: true }).eq("table_id", t.id).is("deleted_at", null),
        supabase.from("company_dashboards").select("id", { count: "exact", head: true }).eq("source_table_id", t.id).is("deleted_at", null),
      ]);
      const rc = recordCount ?? 0, dc = dashboardCount ?? 0;
      results.push({
        id: t.id, category: "table", label: t.name,
        detailLine: `/${t.slug} · ${rc} record${rc === 1 ? "" : "s"}${dc > 0 ? ` · ${dc} dashboard${dc === 1 ? "" : "s"} depend on it` : ""}`,
        icon: t.icon, color: t.color, deletedAt: t.deleted_at, deletedBy: deleterByEntityId.get(t.id) || null,
        createdAt: t.created_at, createdBy: null,
        restore: async () => {
          const { data: before } = await supabase.from("company_tables").select("*").eq("id", t.id).single();
          const { data: after } = await supabase.from("company_tables").update({ deleted_at: null }).eq("id", t.id).select().single();
          if (companyId && before && after) logSchemaChange({ companyId, actorId: userId, entityType: "company_table", entityId: t.id, entityLabel: t.name, action: "update", before, after });
        },
        purge: async () => {
          const warning = dc > 0 ? ` This will also permanently delete ${dc} dashboard${dc === 1 ? "" : "s"} built on this table.` : "";
          if (!window.confirm(`Permanently delete "${t.name}"? This cannot be undone — it will delete the table, its fields, and all ${rc} record(s) forever.${warning}`)) return;
          await supabase.from("company_tables").delete().eq("id", t.id);
        },
      });
    }));

    // ── Custom table fields ─────────────────────────────────────
    const { data: trashedFields } = await supabase
      .from("company_table_fields").select("id, label, field_key, field_type, table_id, created_at, deleted_at")
      .not("deleted_at", "is", null).order("deleted_at", { ascending: false });
    await Promise.all((trashedFields || []).map(async f => {
      const [{ data: parentTable }, { count }] = await Promise.all([
        supabase.from("company_tables").select("name").eq("id", f.table_id).maybeSingle(),
        supabase.from("company_table_values").select("field_id", { count: "exact", head: true }).eq("field_id", f.id),
      ]);
      const vc = count ?? 0;
      results.push({
        id: f.id, category: "table_field", label: f.label,
        detailLine: `${parentTable?.name || "Unknown table"} · ${f.field_type} · ${f.field_key} · ${vc} value${vc === 1 ? "" : "s"}`,
        deletedAt: f.deleted_at, deletedBy: deleterByEntityId.get(f.id) || null,
        createdAt: f.created_at, createdBy: null,
        restore: async () => {
          const { data: before } = await supabase.from("company_table_fields").select("*").eq("id", f.id).single();
          const { data: after } = await supabase.from("company_table_fields").update({ deleted_at: null }).eq("id", f.id).select().single();
          if (companyId && before && after) logSchemaChange({ companyId, actorId: userId, entityType: "company_table_field", entityId: f.id, entityLabel: f.label, action: "update", before, after });
        },
        purge: async () => {
          if (!window.confirm(`Permanently delete "${f.label}"? This cannot be undone — it will delete the field and all data stored in it for ${vc} record(s) forever.`)) return;
          await supabase.from("company_table_fields").delete().eq("id", f.id);
        },
      });
    }));

    // ── Entity / project / property fields ──────────────────────
    const { data: trashedSystemFields } = await supabase
      .from("company_custom_fields").select("id, label, field_key, field_type, table_name, created_at, deleted_at")
      .eq("company_id", companyId).not("deleted_at", "is", null).order("deleted_at", { ascending: false });
    await Promise.all((trashedSystemFields || []).map(async f => {
      const { count } = await supabase.from("company_custom_field_values").select("field_id", { count: "exact", head: true }).eq("field_id", f.id);
      const vc = count ?? 0;
      results.push({
        id: f.id, category: "system_field", label: f.label,
        detailLine: `${f.table_name} · ${f.field_type} · ${f.field_key} · ${vc} value${vc === 1 ? "" : "s"}`,
        deletedAt: f.deleted_at, deletedBy: deleterByEntityId.get(f.id) || null,
        createdAt: f.created_at, createdBy: null,
        restore: async () => {
          const { data: before } = await supabase.from("company_custom_fields").select("*").eq("id", f.id).single();
          const { data: after } = await supabase.from("company_custom_fields").update({ deleted_at: null }).eq("id", f.id).select().single();
          if (companyId && before && after) logSchemaChange({ companyId, actorId: userId, entityType: "company_custom_field", entityId: f.id, entityLabel: f.label, action: "update", before, after });
        },
        purge: async () => {
          if (!window.confirm(`Permanently delete "${f.label}"? This cannot be undone — it will delete the field and all data stored in it for ${vc} record(s) forever.`)) return;
          await supabase.from("company_custom_fields").delete().eq("id", f.id);
        },
      });
    }));

    // ── Dashboards ───────────────────────────────────────────────
    const { data: trashedDashboards } = await supabase
      .from("company_dashboards").select("id, name, slug, icon, color, source_table_id, created_at, deleted_at")
      .eq("company_id", companyId).not("deleted_at", "is", null).order("deleted_at", { ascending: false });
    await Promise.all((trashedDashboards || []).map(async d => {
      const { data: sourceTable } = await supabase.from("company_tables").select("name").eq("id", d.source_table_id).maybeSingle();
      results.push({
        id: d.id, category: "dashboard", label: d.name,
        detailLine: `/${d.slug}${sourceTable?.name ? ` · source: ${sourceTable.name}` : ""}`,
        icon: d.icon, color: d.color, deletedAt: d.deleted_at, deletedBy: deleterByEntityId.get(d.id) || null,
        createdAt: d.created_at, createdBy: null,
        restore: async () => {
          const { data: before } = await supabase.from("company_dashboards").select("*").eq("id", d.id).single();
          const { data: after } = await supabase.from("company_dashboards").update({ deleted_at: null }).eq("id", d.id).select().single();
          if (companyId && before && after) logSchemaChange({ companyId, actorId: userId, entityType: "company_dashboard", entityId: d.id, entityLabel: d.name, action: "update", before, after });
        },
        purge: async () => {
          if (!window.confirm(`Permanently delete "${d.name}"? This cannot be undone.`)) return;
          await supabase.from("company_dashboards").delete().eq("id", d.id);
        },
      });
    }));

    // ── Custom table records ─────────────────────────────────────
    const { data: trashedRecords } = await supabase
      .from("company_table_records").select("id, table_id, created_at, created_by, deleted_at")
      .eq("company_id", companyId).not("deleted_at", "is", null)
      .order("deleted_at", { ascending: false }).limit(RECORD_LIMIT);

    const recordTableIds = Array.from(new Set((trashedRecords || []).map(r => r.table_id)));
    const [{ data: parentTables }, { data: parentFields }] = await Promise.all([
      recordTableIds.length ? supabase.from("company_tables").select("id, name, primary_field_key").in("id", recordTableIds) : Promise.resolve({ data: [] as any[] }),
      recordTableIds.length ? supabase.from("company_table_fields").select("id, table_id, field_key").in("table_id", recordTableIds).is("deleted_at", null) : Promise.resolve({ data: [] as any[] }),
    ]);
    const tableById = new Map((parentTables || []).map(t => [t.id, t]));
    const primaryFieldIdByTable = new Map<string, string>();
    recordTableIds.forEach(tid => {
      const t = tableById.get(tid);
      const fieldsForTable = (parentFields || []).filter(f => f.table_id === tid);
      const primary = fieldsForTable.find(f => f.field_key === t?.primary_field_key) || fieldsForTable[0];
      if (primary) primaryFieldIdByTable.set(tid, primary.id);
    });

    const creatorIds = Array.from(new Set((trashedRecords || []).map(r => r.created_by).filter((v): v is string => !!v)));
    const { data: creatorProfiles } = creatorIds.length
      ? await supabase.from("profiles").select("id, full_name").in("id", creatorIds)
      : { data: [] as { id: string; full_name: string | null }[] };
    const creatorNameById = new Map((creatorProfiles || []).map(p => [p.id, p.full_name || "Unknown"]));

    await Promise.all((trashedRecords || []).map(async r => {
      const fieldId = primaryFieldIdByTable.get(r.table_id);
      let label = "Untitled";
      if (fieldId) {
        const { data: v } = await supabase
          .from("company_table_values").select("value_text, value_number, value_date, value_boolean")
          .eq("record_id", r.id).eq("field_id", fieldId).maybeSingle();
        const raw = v?.value_text ?? v?.value_number ?? v?.value_date ?? (v?.value_boolean != null ? String(v.value_boolean) : null);
        if (raw !== null && raw !== undefined && raw !== "") label = String(raw);
      }
      const tableName = tableById.get(r.table_id)?.name || "Unknown table";
      results.push({
        id: r.id, category: "table_record", label,
        detailLine: tableName, deletedAt: r.deleted_at, deletedBy: null,
        createdAt: r.created_at, createdBy: r.created_by ? (creatorNameById.get(r.created_by) || "Unknown") : null,
        restore: async () => { await supabase.from("company_table_records").update({ deleted_at: null }).eq("id", r.id); },
        purge: async () => {
          if (!window.confirm(`Permanently delete this record from "${tableName}"? This cannot be undone.`)) return;
          await supabase.from("company_table_records").delete().eq("id", r.id);
        },
      });
    }));

    // ── Entity / project / property records ─────────────────────
    const [{ data: delEntities }, { data: delProjects }, { data: delProperties }] = await Promise.all([
      supabase.from("entities").select("id, name, entity_type, created_at, deleted_at").eq("company_id", companyId).not("deleted_at", "is", null).order("deleted_at", { ascending: false }).limit(RECORD_LIMIT),
      supabase.from("projects").select("id, name, created_at, created_by, deleted_at").eq("company_id", companyId).not("deleted_at", "is", null).order("deleted_at", { ascending: false }).limit(RECORD_LIMIT),
      supabase.from("properties").select("id, street_address, suburb, deleted_at").eq("company_id", companyId).not("deleted_at", "is", null).order("deleted_at", { ascending: false }).limit(RECORD_LIMIT),
    ]);

    const projectCreatorIds = Array.from(new Set((delProjects || []).map(p => p.created_by).filter((v): v is string => !!v)));
    const { data: projectCreatorProfiles } = projectCreatorIds.length
      ? await supabase.from("profiles").select("id, full_name").in("id", projectCreatorIds)
      : { data: [] as { id: string; full_name: string | null }[] };
    const projectCreatorNameById = new Map((projectCreatorProfiles || []).map(p => [p.id, p.full_name || "Unknown"]));

    (delEntities || []).forEach(e => results.push({
      id: e.id, category: "system_record", label: e.name || "Unnamed entity",
      detailLine: `Entity${e.entity_type ? ` · ${e.entity_type}` : ""}`,
      deletedAt: e.deleted_at, deletedBy: null, createdAt: e.created_at, createdBy: null,
      restore: async () => { await supabase.from("entities").update({ deleted_at: null }).eq("id", e.id); },
      purge: async () => {
        if (!window.confirm(`Permanently delete "${e.name || "this entity"}"? This cannot be undone.`)) return;
        await supabase.from("entities").delete().eq("id", e.id);
      },
    }));
    (delProjects || []).forEach(p => results.push({
      id: p.id, category: "system_record", label: p.name || "Unnamed project",
      detailLine: "Project",
      deletedAt: p.deleted_at, deletedBy: null, createdAt: p.created_at,
      createdBy: p.created_by ? (projectCreatorNameById.get(p.created_by) || "Unknown") : null,
      restore: async () => { await supabase.from("projects").update({ deleted_at: null }).eq("id", p.id); },
      purge: async () => {
        if (!window.confirm(`Permanently delete "${p.name || "this project"}"? This cannot be undone.`)) return;
        await supabase.from("projects").delete().eq("id", p.id);
      },
    }));
    (delProperties || []).forEach(p => results.push({
      id: p.id, category: "system_record", label: p.street_address || "Unnamed property",
      detailLine: `Property${p.suburb ? ` · ${p.suburb}` : ""}`,
      deletedAt: p.deleted_at, deletedBy: null, createdAt: null, createdBy: null,
      restore: async () => { await supabase.from("properties").update({ deleted_at: null }).eq("id", p.id); },
      purge: async () => {
        if (!window.confirm(`Permanently delete "${p.street_address || "this property"}"? This cannot be undone.`)) return;
        await supabase.from("properties").delete().eq("id", p.id);
      },
    }));

    results.sort((a, b) => new Date(b.deletedAt).getTime() - new Date(a.deletedAt).getTime());
    setItems(results);
    setLoading(false);
  }, [companyId, userId]);

  useEffect(() => { load(); }, [load]);

  useProgressBarWhile(loading);

  const filtered = useMemo(() => {
    const range = TIME_RANGES.find(r => r.key === timeRange);
    // "Last N hours" is inherently relative to wall-clock time -- reading it
    // here (rather than threading a `now` value through state) is the
    // intentional impurity; it only affects which items pass the filter,
    // recomputed whenever the filter's own inputs change.
    // eslint-disable-next-line react-hooks/purity
    const cutoff = range?.ms ? Date.now() - range.ms : null;
    const q = search.trim().toLowerCase();
    return items.filter(item => {
      if (cutoff !== null && new Date(item.deletedAt).getTime() < cutoff) return false;
      if (!q) return true;
      return item.label.toLowerCase().includes(q) || item.detailLine.toLowerCase().includes(q);
    });
  }, [items, search, timeRange]);

  const handleRestore = async (item: TrashItem) => {
    setBusyId(item.id);
    await item.restore();
    setBusyId(null);
    load();
  };

  const handlePurge = async (item: TrashItem) => {
    setBusyId(item.id);
    await item.purge();
    setBusyId(null);
    load();
  };

  const isEmpty = !loading && items.length === 0;
  const noResults = !loading && items.length > 0 && filtered.length === 0;

  if (companyLoading) return null;

  if (!isAdmin) return (
    <div className="flex flex-col items-center justify-center h-screen gap-3">
      <Shield size={32} className="text-slate-200" />
      <p className="text-slate-400 font-bold text-[11px] uppercase tracking-widest">
        Admin access required
      </p>
      <button
        onClick={() => router.back()}
        className="text-[11px] text-indigo-600 font-bold hover:underline"
      >
        Go back
      </button>
    </div>
  );

  return (
    <div className="max-w-3xl mx-auto p-8 space-y-6">
      <div className="flex items-center gap-3">
        <Trash2 size={22} className="text-indigo-600" />
        <div>
          <h1 className="text-xl font-light uppercase tracking-tight text-slate-900">Trash</h1>
          <p className="text-[11px] text-slate-400">Deleted tables, fields, dashboards, and records — nothing here is gone for good until you permanently delete it.</p>
        </div>
      </div>

      {!isEmpty && (
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-300" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search trash..."
              className="w-full bg-white border border-slate-200 rounded-full py-2.5 pl-10 pr-4 text-[13px] font-medium outline-none focus:ring-4 focus:ring-indigo-100 transition-all"
            />
          </div>
          <div className="flex items-center gap-1 bg-slate-100 rounded-full p-1 w-fit">
            {TIME_RANGES.map(r => (
              <button
                key={r.key}
                onClick={() => setTimeRange(r.key)}
                className={`px-3 py-1.5 rounded-full text-[11px] font-bold whitespace-nowrap transition-all ${
                  timeRange === r.key ? "bg-white text-slate-900 shadow-sm" : "text-slate-400 hover:text-slate-600"
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {loading ? null : isEmpty ? (
        <p className="text-center text-[11px] text-slate-300 italic py-8">Trash is empty</p>
      ) : noResults ? (
        <p className="text-center text-[11px] text-slate-300 italic py-8">No trashed items match your search</p>
      ) : (
        <>
          <div className="space-y-2">
            {filtered.map(item => {
              const meta = CATEGORY_META[item.category];
              const Icon = item.icon ? ((LucideIcons as any)[item.icon] || Table2) : null;
              return (
                <div key={item.id} className="flex items-start gap-4 p-4 bg-white border border-slate-200 rounded-2xl">
                  {Icon ? (
                    <div className="h-9 w-9 rounded-xl flex items-center justify-center shrink-0 mt-0.5" style={{ backgroundColor: `${item.color}20` }}>
                      <Icon size={16} style={{ color: item.color }} />
                    </div>
                  ) : (
                    <div className="h-9 w-9 rounded-xl flex items-center justify-center shrink-0 mt-0.5 bg-slate-50 text-slate-400">
                      <Table2 size={16} />
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-[13px] font-bold text-slate-800 truncate">{item.label}</p>
                      <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wide shrink-0 ${meta.className}`}>{meta.label}</span>
                    </div>
                    <p className="text-[10px] text-slate-400 mt-0.5">{item.detailLine}</p>
                    <p className="text-[10px] text-slate-400 mt-0.5">
                      Deleted {fmtDate(item.deletedAt)}{item.deletedBy ? ` by ${item.deletedBy}` : ""}
                      {item.createdAt ? ` · Created ${fmtDate(item.createdAt)}${item.createdBy ? ` by ${item.createdBy}` : ""}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button onClick={() => handleRestore(item)} disabled={busyId === item.id} className="flex items-center gap-2 px-3 py-2 bg-slate-50 text-slate-600 rounded-full text-[10px] font-bold hover:bg-slate-900 hover:text-white transition-all disabled:opacity-50">
                      {busyId === item.id ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />} Restore
                    </button>
                    <button onClick={() => handlePurge(item)} disabled={busyId === item.id} className="p-2 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-full transition-all"><Trash2 size={14} /></button>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="flex items-start gap-2 p-4 bg-amber-50 border border-amber-100 rounded-2xl">
            <AlertTriangle size={14} className="text-amber-500 shrink-0 mt-0.5" />
            <p className="text-[11px] text-amber-700">&ldquo;Delete permanently&rdquo; cannot be undone — it removes the item and all data stored against it for good. Everything else here is just hidden and can be restored.</p>
          </div>
        </>
      )}
    </div>
  );
}
