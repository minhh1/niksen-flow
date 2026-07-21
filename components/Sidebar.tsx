// components/Sidebar.tsx
"use client";

import { useState, useEffect } from "react";
import {
  MapPin, Building2, Plus, LogOut, LayoutGrid,
  Settings, Shield, ChevronsUpDown, Loader2, Mail,
  Table2, Eye, EyeOff, X, Check, SlidersHorizontal, Network, PenSquare, Monitor, CreditCard,
  ChevronsLeft, ChevronsRight, ChevronRight,
} from "lucide-react";
import * as LucideIcons from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import NewProjectModal from "./NewProjectModal";
import NewEntityModal from "./NewEntityModal";
import { useCustomTables } from "@/lib/hooks/useCustomTables";
import { useCompany } from "@/components/CompanyContext";
import type { ActiveFilter } from "@/lib/types/filters";
import { savedViewsService, type SavedView } from "@/lib/services/savedViewsService";

// ── Types ──────────────────────────────────────────────────────────

interface TreeConfig {
  displayFields: string[];
  separator: string;
  sortField: string;
  sortDirection: 'asc' | 'desc';
  filters: ActiveFilter[];
}

// ── Constants ──────────────────────────────────────────────────────

const ALL_SYSTEM_TABLES = [
  { slug: 'projects',   label: 'Projects',   icon: LayoutGrid },
  { slug: 'properties', label: 'Properties', icon: MapPin },
  { slug: 'entities',   label: 'Entities',   icon: Building2 },
];

const SYSTEM_TABLE_FIELDS: Record<string, { key: string; label: string }[]> = {
  projects: [
    { key: 'name',       label: 'Project Name' },
    { key: 'status',     label: 'Status' },
    { key: 'created_at', label: 'Date Created' },
  ],
  properties: [
    { key: 'street_address', label: 'Street Address' },
    { key: 'suburb',          label: 'Suburb' },
    { key: 'state',           label: 'State' },
    { key: 'postcode',        label: 'Postcode' },
  ],
  entities: [
    { key: 'name',        label: 'Name' },
    { key: 'entity_type', label: 'Entity Type' },
    { key: 'abn',         label: 'ABN' },
  ],
};

const DEFAULT_TREE_CONFIG: Record<string, TreeConfig> = {
  projects:   { displayFields: ['name'],           separator: ' — ', sortField: 'name',           sortDirection: 'asc', filters: [] },
  properties: { displayFields: ['street_address'], separator: ' — ', sortField: 'street_address', sortDirection: 'asc', filters: [] },
  entities:   { displayFields: ['name'],           separator: ' — ', sortField: 'name',           sortDirection: 'asc', filters: [] },
};

const SEPARATORS = [
  { value: ' — ', label: 'Dash (—)' },
  { value: ' / ', label: 'Slash (/)' },
  { value: ' | ', label: 'Pipe (|)' },
  { value: ' · ', label: 'Dot (·)' },
  { value: ' ',   label: 'Space' },
  { value: ', ',  label: 'Comma' },
];

// ── DB helpers ─────────────────────────────────────────────────────

async function loadTreeConfigFromDB(tableSlug: string, userId: string | null): Promise<TreeConfig> {
  if (!userId) return DEFAULT_TREE_CONFIG[tableSlug] || DEFAULT_TREE_CONFIG.projects;
  try {
    const { data, error } = await supabase
      .from('sidebar_tree_config')
      .select('config')
      .eq('user_id', userId)
      .eq('table_slug', tableSlug)
      .maybeSingle();

    if (error || !data?.config) {
      return DEFAULT_TREE_CONFIG[tableSlug] || DEFAULT_TREE_CONFIG.projects;
    }

    return {
      ...(DEFAULT_TREE_CONFIG[tableSlug] || DEFAULT_TREE_CONFIG.projects),
      ...data.config,
    };
  } catch {
    return DEFAULT_TREE_CONFIG[tableSlug] || DEFAULT_TREE_CONFIG.projects;
  }
}

async function saveTreeConfigToDB(tableSlug: string, config: TreeConfig, userId: string | null): Promise<void> {
  if (!userId) return;
  await supabase
    .from('sidebar_tree_config')
    .upsert({
      user_id: userId,
      table_slug: tableSlug,
      config,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,table_slug' });
}

// ── Table visibility panel ─────────────────────────────────────────

function TableVisibilityPanel({
  visible, systemTables, customTables, onChange, onClose,
}: {
  visible: string[];
  systemTables: typeof ALL_SYSTEM_TABLES;
  customTables: { id: string; slug: string; name: string; icon: string }[];
  onChange: (slugs: string[]) => void;
  onClose: () => void;
}) {
  const toggle = (slug: string) => {
    const next = visible.includes(slug)
      ? visible.filter(s => s !== slug)
      : [...visible, slug];
    if (next.length === 0) return;
    onChange(next);
  };

  const Row = ({
    slug, label, icon: Icon,
  }: { slug: string; label: string; icon: React.ElementType }) => {
    const isVisible = visible.includes(slug);
    return (
      <button
        onClick={() => toggle(slug)}
        className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-2xl transition-all text-left ${
          isVisible ? 'bg-slate-900 text-white' : 'bg-slate-50 text-slate-400'
        }`}
      >
        <Icon size={14} />
        <span className="text-[12px] font-bold flex-1">{label}</span>
        {isVisible
          ? <Check size={12} className="shrink-0" />
          : <EyeOff size={12} className="shrink-0 opacity-40" />
        }
      </button>
    );
  };

  return (
    <div className="absolute bottom-full left-0 right-0 mb-2 bg-white rounded-3xl border border-slate-200 shadow-xl z-50 p-4">
      <div className="flex items-center justify-between mb-3">
        <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">
          Visible tables
        </p>
        <button onClick={onClose} className="p-1 text-slate-300 hover:text-slate-600">
          <X size={14} />
        </button>
      </div>

      <p className="text-[9px] font-bold text-slate-300 uppercase tracking-widest px-1 mb-1.5">
        System
      </p>
      <div className="space-y-1 mb-3">
        {systemTables.map(t => <Row key={t.slug} slug={t.slug} label={t.label} icon={t.icon} />)}
      </div>

      {customTables.length > 0 && (
        <>
          <p className="text-[9px] font-bold text-slate-300 uppercase tracking-widest px-1 mb-1.5">
            Custom
          </p>
          <div className="space-y-1">
            {customTables.map(t => {
              const Icon = (LucideIcons as any)[t.icon] || Table2;
              return <Row key={t.slug} slug={t.slug} label={t.name} icon={Icon} />;
            })}
          </div>
        </>
      )}
    </div>
  );
}

// ── Tree config panel ──────────────────────────────────────────────

function TreeConfigPanel({
  config, availableFields, customFields, onChange, onClose,
}: {
  config: TreeConfig;
  availableFields: { key: string; label: string }[];
  customFields: any[];
  onChange: (config: TreeConfig) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<TreeConfig>({ ...config });
  const [activeTab, setActiveTab] = useState<'display' | 'sort' | 'filter'>('display');

  const allFields = [
    ...availableFields,
    ...customFields.map(f => ({ key: `cf:${f.id}`, label: f.label })),
  ];

  const toggleDisplayField = (key: string) => {
    const current = draft.displayFields;
    if (current.includes(key)) {
      setDraft({ ...draft, displayFields: current.filter(k => k !== key) });
    } else if (current.length < 2) {
      setDraft({ ...draft, displayFields: [...current, key] });
    }
  };

  const handleSave = () => {
    onChange(draft);
    onClose();
  };

  const TABS = [
    { key: 'display' as const, label: 'Display' },
    { key: 'sort'    as const, label: 'Sort' },
    { key: 'filter'  as const, label: 'Filter' },
  ];

  return (
    <div className="absolute bottom-full left-0 right-0 mb-2 bg-white rounded-3xl border border-slate-200 shadow-2xl z-50 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-4 pb-2">
        <p className="text-[11px] font-bold text-slate-700 uppercase tracking-widest">
          Tree settings
        </p>
        <button onClick={onClose} className="p-1 text-slate-300 hover:text-slate-600">
          <X size={13} />
        </button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-slate-100 px-4">
        {TABS.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`pb-2.5 pt-1.5 mr-4 text-[10px] font-bold uppercase tracking-widest border-b-2 transition-colors ${
              activeTab === tab.key
                ? 'border-indigo-600 text-indigo-600'
                : 'border-transparent text-slate-400 hover:text-slate-700'
            }`}
          >
            {tab.label}
            {tab.key === 'filter' && draft.filters.length > 0 && (
              <span className="ml-1 px-1 py-0.5 bg-indigo-600 text-white rounded-full text-[7px] font-bold align-middle">
                {draft.filters.length}
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="p-4 max-h-80 overflow-y-auto space-y-4">

        {/* ── Display tab ── */}
        {activeTab === 'display' && (
          <>
            <div>
              <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-2">
                Show fields (up to 2 — numbered in order)
              </p>
              <div className="space-y-1">
                {allFields.map(f => {
                  const selected = draft.displayFields.includes(f.key);
                  const idx = draft.displayFields.indexOf(f.key);
                  const disabled = !selected && draft.displayFields.length >= 2;
                  return (
                    <button
                      key={f.key}
                      onClick={() => !disabled && toggleDisplayField(f.key)}
                      disabled={disabled}
                      className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl text-left transition-all ${
                        selected
                          ? 'bg-indigo-50 border border-indigo-200'
                          : disabled
                          ? 'opacity-30 cursor-not-allowed border border-transparent'
                          : 'hover:bg-slate-50 border border-transparent'
                      }`}
                    >
                      <div className={`h-5 w-5 rounded-full border-2 flex items-center justify-center shrink-0 text-[9px] font-bold ${
                        selected
                          ? 'bg-indigo-600 border-indigo-600 text-white'
                          : 'border-slate-300'
                      }`}>
                        {selected ? idx + 1 : ''}
                      </div>
                      <span className="text-[12px] font-medium text-slate-700 flex-1 truncate">
                        {f.label}
                      </span>
                      {f.key.startsWith('cf:') && (
                        <span className="text-[9px] font-bold text-violet-400 uppercase shrink-0">
                          custom
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {draft.displayFields.length === 2 && (
              <div>
                <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-2">
                  Separator
                </p>
                <div className="grid grid-cols-3 gap-1.5">
                  {SEPARATORS.map(sep => (
                    <button
                      key={sep.value}
                      onClick={() => setDraft({ ...draft, separator: sep.value })}
                      className={`px-2 py-1.5 rounded-lg text-[10px] font-bold transition-all ${
                        draft.separator === sep.value
                          ? 'bg-indigo-600 text-white'
                          : 'bg-slate-50 text-slate-500 hover:bg-slate-100'
                      }`}
                    >
                      {sep.label}
                    </button>
                  ))}
                </div>

                {/* Preview */}
                <div className="mt-3 px-3 py-2 bg-slate-50 rounded-xl border border-slate-100">
                  <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1">
                    Preview
                  </p>
                  <p className="text-[12px] font-medium text-slate-700 truncate">
                    <span className="text-slate-800">
                      {allFields.find(f => f.key === draft.displayFields[0])?.label || 'Field 1'}
                    </span>
                    <span className="text-indigo-400">{draft.separator}</span>
                    <span className="text-slate-800">
                      {allFields.find(f => f.key === draft.displayFields[1])?.label || 'Field 2'}
                    </span>
                  </p>
                </div>
              </div>
            )}
          </>
        )}

        {/* ── Sort tab ── */}
        {activeTab === 'sort' && (
          <>
            <div>
              <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-2">
                Sort by
              </p>
              <div className="space-y-1">
                {allFields.map(f => (
                  <button
                    key={f.key}
                    onClick={() => setDraft({ ...draft, sortField: f.key })}
                    className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl text-left transition-all ${
                      draft.sortField === f.key
                        ? 'bg-indigo-50 border border-indigo-200'
                        : 'hover:bg-slate-50 border border-transparent'
                    }`}
                  >
                    <div className={`h-4 w-4 rounded-full border-2 shrink-0 ${
                      draft.sortField === f.key
                        ? 'bg-indigo-600 border-indigo-600'
                        : 'border-slate-300'
                    }`} />
                    <span className="text-[12px] font-medium text-slate-700 flex-1 truncate">
                      {f.label}
                    </span>
                    {f.key.startsWith('cf:') && (
                      <span className="text-[9px] font-bold text-violet-400 uppercase shrink-0">
                        custom
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-2">
                Direction
              </p>
              <div className="flex gap-2">
                {([
                  { value: 'asc'  as const, label: 'A → Z' },
                  { value: 'desc' as const, label: 'Z → A' },
                ]).map(opt => (
                  <button
                    key={opt.value}
                    onClick={() => setDraft({ ...draft, sortDirection: opt.value })}
                    className={`flex-1 py-2 rounded-full text-[10px] font-bold transition-all ${
                      draft.sortDirection === opt.value
                        ? 'bg-indigo-600 text-white'
                        : 'bg-slate-50 text-slate-500 hover:bg-slate-100'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}

        {/* ── Filter tab ── */}
        {activeTab === 'filter' && (
          <>
            {draft.filters.length === 0 && (
              <p className="text-[11px] text-slate-400 italic">
                No filters — all records shown
              </p>
            )}

            {draft.filters.map((filter, idx) => (
              <div
                key={idx}
                className="flex items-center gap-2 p-2 bg-slate-50 rounded-xl border border-slate-100"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-[10px] font-bold text-slate-700 truncate">{filter.label}</p>
                  <p className="text-[9px] text-slate-400">
                    {filter.operator.replace(/_/g, ' ')}
                    {filter.value ? ` "${filter.value}"` : ''}
                  </p>
                </div>
                <button
                  onClick={() => setDraft({
                    ...draft,
                    filters: draft.filters.filter((_, i) => i !== idx),
                  })}
                  className="p-1 text-slate-300 hover:text-red-500 transition-colors shrink-0"
                >
                  <X size={12} />
                </button>
              </div>
            ))}

            <div>
              <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-2">
                Add filter — press Enter to apply
              </p>
              {allFields.map(f => (
                <div key={f.key} className="flex items-center gap-2 mb-2">
                  <span className="text-[11px] text-slate-500 w-24 shrink-0 truncate">
                    {f.label}
                  </span>
                  <input
                    type="text"
                    placeholder="Value..."
                    className="flex-1 bg-slate-50 border border-slate-200 rounded-full px-3 py-1.5 text-[11px] font-medium outline-none focus:ring-2 focus:ring-indigo-100"
                    onKeyDown={e => {
                      if (e.key !== 'Enter') return;
                      const val = (e.target as HTMLInputElement).value.trim();
                      if (!val) return;
                      setDraft({
                        ...draft,
                        filters: [
                          ...draft.filters,
                          {
                            fieldId: f.key,
                            label: f.label,
                            operator: 'contains',
                            value: val,
                            fieldType: 'text',
                          },
                        ],
                      });
                      (e.target as HTMLInputElement).value = '';
                    }}
                  />
                </div>
              ))}
            </div>

            {draft.filters.length > 0 && (
              <button
                onClick={() => setDraft({ ...draft, filters: [] })}
                className="text-[10px] font-bold text-red-400 hover:text-red-600 transition-colors"
              >
                Clear all filters
              </button>
            )}
          </>
        )}
      </div>

      {/* Footer */}
      <div className="px-4 pb-4 flex gap-2">
        <button
          onClick={onClose}
          className="flex-1 py-2.5 bg-slate-50 text-slate-500 rounded-full text-[10px] font-bold hover:bg-slate-100 transition-all"
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          className="flex-1 py-2.5 bg-slate-900 text-white rounded-full text-[10px] font-bold hover:bg-black transition-all"
        >
          Save
        </button>
      </div>
    </div>
  );
}

// ── Nav link (collapses to icon-only) ───────────────────────────────

function SidebarNavLink({
  href, icon: Icon, label, active, collapsed,
  activeClassName = 'bg-slate-900 text-white',
  idleClassName = 'text-slate-500 hover:bg-slate-50 hover:text-slate-900',
}: {
  href: string;
  icon: React.ElementType;
  label: string;
  active: boolean;
  collapsed: boolean;
  activeClassName?: string;
  idleClassName?: string;
}) {
  return (
    <Link
      href={href}
      title={collapsed ? label : undefined}
      aria-label={label}
      className={`flex items-center rounded-2xl text-[13px] font-medium transition-all ${
        collapsed ? 'w-9 h-9 mx-auto justify-center' : 'w-full gap-3 px-3 py-2.5'
      } ${active ? activeClassName : idleClassName}`}
    >
      <Icon size={16} className="shrink-0" />
      {!collapsed && <span className="truncate">{label}</span>}
    </Link>
  );
}

// ── Main Sidebar ───────────────────────────────────────────────────

export default function Sidebar() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const currentId = searchParams.get("id");
  const activeViewId = searchParams.get("view");

  // Use shared company context — avoids duplicate auth call with GenericMasterTable
  const { companyId: ctxCompanyId, companyName: ctxCompanyName, userId: ctxUserId, isAdmin: ctxIsAdmin, loading: ctxLoading } = useCompany();

  const [profile, setProfile] = useState<any>(null);
  const [profileLoading, setProfileLoading] = useState(true);
  const [memberships, setMemberships] = useState<any[]>([]);
  const [showCompanySwitcher, setShowCompanySwitcher] = useState(false);
  const [switchingCompany, setSwitchingCompany] = useState(false);
  const [items, setItems] = useState<any[]>([]);
  const [itemsLoading, setItemsLoading] = useState(true);
  const [isProjOpen, setIsProjOpen] = useState(false);
  const [isEntOpen, setIsEntOpen] = useState(false);
  const [visibleTables, setVisibleTables] = useState<string[]>([]);
  const [showTableSettings, setShowTableSettings] = useState(false);
  const [showTreeConfig, setShowTreeConfig] = useState(false);
  const [treeConfig, setTreeConfig] = useState<TreeConfig>(() => DEFAULT_TREE_CONFIG[
    pathname.includes('properties') ? 'properties' :
    pathname.includes('entities') ? 'entities' : 'projects'
  ] || DEFAULT_TREE_CONFIG.projects);
  const [customFieldCols, setCustomFieldCols] = useState<any[]>([]);
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [treeOpen, setTreeOpen] = useState(false);
  const { tables: customTables } = useCustomTables();

  const mode = pathname.includes("projects") ? "projects"
    : pathname.includes("properties") ? "properties"
    : "entities";

  // ── Restore collapsed state ──────────────────────────────────────
  useEffect(() => {
    try {
      if (localStorage.getItem('nk_sidebar_collapsed') === '1') setCollapsed(true);
    } catch {}
  }, []);

  const toggleCollapsed = () => {
    setCollapsed(prev => {
      const next = !prev;
      try { localStorage.setItem('nk_sidebar_collapsed', next ? '1' : '0'); } catch {}
      return next;
    });
  };

  // Record list is opt-in — collapse it again whenever the active table changes
  useEffect(() => { setTreeOpen(false); }, [mode]);

  // ── Load tree config from DB when mode changes ─────────────────
  useEffect(() => {
    if (!ctxUserId) return;
    const load = async () => {
      const config = await loadTreeConfigFromDB(mode, ctxUserId);
      setTreeConfig(config);
    };
    load();
  }, [mode, ctxUserId]);

  // ── Load saved views for the active table ───────────────────────
  useEffect(() => {
    if (!ctxUserId || !ctxCompanyId) return;
    savedViewsService.listByTable(ctxUserId, ctxCompanyId, mode).then(setSavedViews);
  }, [mode, ctxUserId, ctxCompanyId]);

  // ── Load custom fields for current mode ────────────────────────
  useEffect(() => {
    const loadCF = async () => {
      const { data } = await supabase
        .from('company_custom_fields')
        .select('id, field_key, label, field_type')
        .eq('table_name', mode)
        .order('display_order');
      setCustomFieldCols(data || []);
    };
    loadCF();
  }, [mode]);

  useEffect(() => {
    fetchTreeData();
  }, [mode, treeConfig]);

  useEffect(() => {
    if (!ctxUserId) return;
    fetchProfile();
  }, [ctxUserId]);

  useEffect(() => {
    if (!showCompanySwitcher) return;
    const handleClick = () => setShowCompanySwitcher(false);
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [showCompanySwitcher]);

  // ── Profile + visibility ───────────────────────────────────────
  // companyId/isAdmin come from CompanyContext (shared with GenericMasterTable) —
  // this only fetches the extra fields that context doesn't carry.
  const fetchProfile = async () => {
    if (!ctxUserId) return;

    // Try with sidebar_visible_tables first, fall back if column doesn't exist
    let fullName: string | null = null;
    let visibleTablesData: any = null;

    const { data: profFull, error } = await supabase
      .from("profiles")
      .select("full_name, sidebar_visible_tables")
      .eq("id", ctxUserId)
      .single();

    if (error) {
      // Column might not exist yet — fetch without it
      const { data: profBasic } = await supabase
        .from("profiles")
        .select("full_name")
        .eq("id", ctxUserId)
        .single();
      fullName = profBasic?.full_name ?? null;
    } else {
      fullName = profFull?.full_name ?? null;
      visibleTablesData = profFull?.sidebar_visible_tables;
    }

    setProfile({ full_name: fullName });

    // Set visible tables
    setVisibleTables(visibleTablesData || ALL_SYSTEM_TABLES.map(t => t.slug));

    // Get memberships
    const { data: ms } = await supabase
      .from("company_memberships")
      .select("company_id, role, company:company_id(id, name, status)")
      .eq("user_id", ctxUserId);
    setMemberships(ms || []);

    // Mark profile fully loaded only after all data is set
    setProfileLoading(false);
  };

  // ── Tree data fetch ────────────────────────────────────────────
  const fetchTreeData = async () => {
    setItemsLoading(true);
    const config = treeConfig;
    const cfIds: string[] = [];
    const baseColsSet = new Set<string>(['id']);

    [...config.displayFields, config.sortField].forEach(key => {
      if (!key) return;
      if (key.startsWith('cf:')) {
        cfIds.push(key.replace('cf:', ''));
      } else {
        baseColsSet.add(key);
      }
    });

    const selectCols = [...baseColsSet].join(', ');

    let query = supabase
      .from(mode)
      .select(selectCols)
      .is('deleted_at', null);

    // Apply base field filters
    config.filters
      .filter(f => !f.fieldId.startsWith('cf:'))
      .forEach(filter => {
        if (!filter.value && !['is_empty', 'is_not_empty', 'is_true', 'is_false'].includes(filter.operator)) return;
        switch (filter.operator) {
          case 'equals':       query = (query as any).eq(filter.fieldId, filter.value); break;
          case 'not_equals':   query = (query as any).neq(filter.fieldId, filter.value); break;
          case 'contains':     query = (query as any).ilike(filter.fieldId, `%${filter.value}%`); break;
          case 'not_contains': query = (query as any).not(filter.fieldId, 'ilike', `%${filter.value}%`); break;
          case 'starts_with':  query = (query as any).ilike(filter.fieldId, `${filter.value}%`); break;
          case 'is_empty':     query = (query as any).is(filter.fieldId, null); break;
          case 'is_not_empty': query = (query as any).not(filter.fieldId, 'is', null); break;
        }
      });

    // Sort base fields on DB side
    if (!config.sortField.startsWith('cf:') && config.sortField) {
      query = (query as any).order(config.sortField, { ascending: config.sortDirection === 'asc' });
    }

    // 100 was silently hiding records once a table grew past it (e.g. 521 matters) —
    // raised well above current table sizes; the list only renders when expanded.
    query = (query as any).limit(2000);

    const { data: baseItems } = await query;
    let items = baseItems || [];

    // Load custom field values if needed
    if (cfIds.length > 0 && items.length > 0) {
      const { data: cfValues } = await supabase
        .from('company_custom_field_values')
        .select('record_id, field_id, value_text')
        .in('record_id', items.map((i: any) => i.id))
        .in('field_id', cfIds);

      const byRecord: Record<string, Record<string, string>> = {};
      (cfValues || []).forEach((v: any) => {
        if (!byRecord[v.record_id]) byRecord[v.record_id] = {};
        byRecord[v.record_id][v.field_id] = v.value_text || '';
      });

      items = items.map((item: any) => ({ ...item, __cf: byRecord[item.id] || {} }));

      // Sort by custom field in memory
      if (config.sortField.startsWith('cf:')) {
        const cfId = config.sortField.replace('cf:', '');
        items.sort((a: any, b: any) => {
          const va = a.__cf?.[cfId] || '';
          const vb = b.__cf?.[cfId] || '';
          const cmp = va.localeCompare(vb, undefined, { numeric: true, sensitivity: 'base' });
          return config.sortDirection === 'asc' ? cmp : -cmp;
        });
      }

      // Apply custom field filters in memory
      config.filters
        .filter(f => f.fieldId.startsWith('cf:'))
        .forEach(filter => {
          const cfId = filter.fieldId.replace('cf:', '');
          items = items.filter((item: any) => {
            const val = (item.__cf?.[cfId] || '').toLowerCase();
            const fval = filter.value.toLowerCase();
            switch (filter.operator) {
              case 'contains':     return val.includes(fval);
              case 'equals':       return val === fval;
              case 'not_equals':   return val !== fval;
              case 'starts_with':  return val.startsWith(fval);
              case 'is_empty':     return val === '';
              case 'is_not_empty': return val !== '';
              default:             return true;
            }
          });
        });
    }

    setItems(items);
    setItemsLoading(false);
  };

  // ── Resolve display label ──────────────────────────────────────
  const getItemLabel = (item: any): string => {
    const allFields = [
      ...SYSTEM_TABLE_FIELDS[mode] || [],
      ...customFieldCols.map(f => ({ key: `cf:${f.id}`, label: f.label })),
    ];

    const resolve = (key: string): string => {
      if (!key) return '';
      if (key.startsWith('cf:')) {
        const cfId = key.replace('cf:', '');
        return item.__cf?.[cfId] || '';
      }
      return String(item[key] || '');
    };

    const [f1, f2] = treeConfig.displayFields;
    const v1 = resolve(f1);
    const v2 = f2 ? resolve(f2) : '';

    if (v1 && v2) return `${v1}${treeConfig.separator}${v2}`;
    return v1 || v2 || item.name || item.street_address || 'Untitled';
  };

  // ── Handlers ───────────────────────────────────────────────────
  const handleTreeConfigChange = async (config: TreeConfig) => {
    setTreeConfig(config);
    await saveTreeConfigToDB(mode, config, ctxUserId);
  };

  const handleVisibilityChange = async (slugs: string[]) => {
    setVisibleTables(slugs);
    if (!ctxUserId) return;
    await supabase
      .from('profiles')
      .update({ sidebar_visible_tables: slugs })
      .eq('id', ctxUserId);
  };

  const handleNewView = async () => {
    const name = prompt("Name for this new view:");
    if (!name || !ctxUserId || !ctxCompanyId) return;
    const created = await savedViewsService.create({
      user_id: ctxUserId, company_id: ctxCompanyId, table_slug: mode, view_name: name, filters: [],
    });
    if (!created) return;
    setSavedViews(prev => [...prev, created].sort((a, b) => a.view_name.localeCompare(b.view_name)));
    router.push(`/dashboard/${mode}?view=${created.id}`);
  };

  const handleDeleteView = async (view: SavedView, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!window.confirm(`Delete the saved view "${view.view_name}"? This can't be undone.`)) return;
    await savedViewsService.remove(view.id);
    setSavedViews(prev => prev.filter(v => v.id !== view.id));
    if (activeViewId === view.id) router.push(`/dashboard/${mode}`);
  };

  const handleSwitchCompany = async (companyId: string) => {
    if (companyId === ctxCompanyId) return;
    if (!ctxUserId) return;
    setSwitchingCompany(true);
    await supabase.from('profiles').update({ active_company_id: companyId }).eq('id', ctxUserId);
    const { invalidateSchemaCache, clearCompanyIdCache } = await import('@/lib/services/schemaService');
    invalidateSchemaCache();
    clearCompanyIdCache();
    setSwitchingCompany(false);
    setShowCompanySwitcher(false);
    window.location.replace('/dashboard/properties');
  };

  // ── Derived ────────────────────────────────────────────────────
  const visibleSystemTables = ALL_SYSTEM_TABLES.filter(t => visibleTables.includes(t.slug));
  const visibleCustomTables = customTables.filter(t => visibleTables.includes(t.slug));
  const isTableActive = (slug: string) =>
    pathname.includes(slug) &&
    !pathname.includes('gmail') &&
    !pathname.includes('settings') &&
    !pathname.includes('admin');

  const availableFields = SYSTEM_TABLE_FIELDS[mode] || SYSTEM_TABLE_FIELDS.projects;
  const hasActiveFilters = treeConfig.filters.length > 0;

  // ── Render ─────────────────────────────────────────────────────
  return (
    <div className={`flex flex-col h-screen bg-white border-r border-slate-100 font-sans select-none antialiased text-slate-600 overflow-hidden transition-[width] duration-200 ${collapsed ? 'w-16' : 'w-72'}`}>

      {/* Logo */}
      <div className={`flex items-center border-b border-slate-100 shrink-0 ${collapsed ? 'flex-col gap-2 px-2 py-4' : 'gap-3 px-6 py-6'}`}>
        <div className="h-9 w-9 rounded-xl bg-slate-900 flex items-center justify-center shadow-sm shrink-0">
          <div className="h-3.5 w-3.5 rounded-full border-2 border-white" />
        </div>
        {!collapsed && (
          <span className="font-bold text-[15px] tracking-tighter text-slate-900 uppercase flex-1">
            niksen
          </span>
        )}
        <button
          onClick={toggleCollapsed}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="p-1.5 text-slate-300 hover:text-slate-600 hover:bg-slate-50 rounded-lg transition-all shrink-0"
        >
          {collapsed ? <ChevronsRight size={14} /> : <ChevronsLeft size={14} />}
        </button>
      </div>

      {/* Nav */}
      <nav className={`flex-1 overflow-y-auto py-4 space-y-0.5 ${collapsed ? 'px-2' : 'px-3'}`}>

        {/* Tables */}
        <div className="mb-2">
          {!collapsed && (
            <div className="flex items-center justify-between px-3 mb-1">
              <p className="text-[9px] font-bold text-slate-300 uppercase tracking-widest">Tables</p>
              <button
                onClick={() => setShowTableSettings(p => !p)}
                className="p-1 text-slate-300 hover:text-slate-600 rounded-lg hover:bg-slate-50 transition-all"
                title="Configure visible tables"
                aria-label="Configure visible tables"
              >
                <Eye size={12} />
              </button>
            </div>
          )}

          {profileLoading ? (
            // Skeleton for table nav items
            <div className={collapsed ? 'space-y-1 flex flex-col items-center' : 'space-y-1 px-1'}>
              {[1,2,3].map(i => (
                collapsed ? (
                  <div key={i} className="h-9 w-9 rounded-2xl bg-slate-100 animate-pulse" />
                ) : (
                  <div key={i} className="flex items-center gap-3 px-3 py-2.5 rounded-2xl">
                    <div className="h-4 w-4 rounded bg-slate-100 animate-pulse shrink-0" />
                    <div className={`h-3 bg-slate-100 animate-pulse rounded-full ${i === 1 ? 'w-20' : i === 2 ? 'w-16' : 'w-24'}`} />
                  </div>
                )
              ))}
            </div>
          ) : (
            <>
          {visibleSystemTables.map(({ slug, label, icon: Icon }) => (
            <button
              key={slug}
              onClick={() => router.push(`/dashboard/${slug}`)}
              title={collapsed ? label : undefined}
              aria-label={label}
              className={`flex items-center rounded-2xl text-[13px] font-medium transition-all ${
                collapsed ? 'w-9 h-9 mx-auto justify-center mb-1' : 'w-full gap-3 px-3 py-2.5'
              } ${
                isTableActive(slug)
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900'
              }`}
            >
              <Icon size={16} className="shrink-0" />
              {!collapsed && <span className="truncate">{label}</span>}
            </button>
          ))}

          {visibleCustomTables.map(table => {
            const Icon = (LucideIcons as any)[table.icon] || Table2;
            return (
              <button
                key={table.id}
                onClick={() => router.push(`/dashboard/${table.slug}`)}
                title={collapsed ? table.name : undefined}
                aria-label={table.name}
                className={`flex items-center rounded-2xl text-[13px] font-medium transition-all ${
                  collapsed ? 'w-9 h-9 mx-auto justify-center mb-1' : 'w-full gap-3 px-3 py-2.5'
                } ${
                  isTableActive(table.slug)
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900'
                }`}
              >
                <Icon size={16} className="shrink-0" />
                {!collapsed && <span className="truncate">{table.name}</span>}
              </button>
            );
          })}
            </>
          )}

          {!collapsed && !profileLoading && visibleSystemTables.length === 0 && visibleCustomTables.length === 0 && (
            <button
              onClick={() => setShowTableSettings(true)}
              className="w-full px-3 py-2.5 text-[11px] text-slate-300 italic text-left"
            >
              No tables visible — click eye to configure
            </button>
          )}
        </div>

        {/* Saved views — for the currently active table */}
        {!collapsed && isTableActive(mode) && (
          <div className="mb-2">
            <div className="flex items-center justify-between px-3 mb-1">
              <p className="text-[9px] font-bold text-slate-300 uppercase tracking-widest">Saved views</p>
              <button
                onClick={handleNewView}
                className="p-1 text-slate-300 hover:text-slate-600 rounded-lg hover:bg-slate-50 transition-all"
                title="New saved view"
              >
                <Plus size={12} strokeWidth={3} />
              </button>
            </div>
            <button
              onClick={() => router.push(`/dashboard/${mode}`)}
              className={`w-full flex items-center px-3 py-2 rounded-2xl text-[12px] transition-all ${
                !activeViewId
                  ? 'bg-indigo-50 text-indigo-700 font-bold'
                  : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900 font-medium'
              }`}
            >
              All (no filter)
            </button>
            {savedViews.map(view => (
              <div key={view.id} className="group/view flex items-center">
                <button
                  onClick={() => router.push(`/dashboard/${mode}?view=${view.id}`)}
                  className={`flex-1 min-w-0 flex items-center px-3 py-2 rounded-2xl text-[12px] transition-all text-left ${
                    activeViewId === view.id
                      ? 'bg-indigo-50 text-indigo-700 font-bold'
                      : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900 font-medium'
                  }`}
                >
                  <span className="truncate">{view.view_name}</span>
                  {view.filters.length > 0 && (
                    <span className="ml-1.5 text-[9px] text-slate-300 shrink-0">({view.filters.length})</span>
                  )}
                </button>
                <button
                  onClick={(e) => handleDeleteView(view, e)}
                  title={`Delete "${view.view_name}"`}
                  className="p-1 mr-1 text-slate-300 hover:text-red-500 opacity-0 group-hover/view:opacity-100 transition-all shrink-0"
                >
                  <X size={11} strokeWidth={3} />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Divider */}
        <div className={`h-px bg-slate-100 my-2 ${collapsed ? 'mx-2' : 'mx-3'}`} />

        <SidebarNavLink href="/dashboard/gmail" icon={Mail} label="Gmail" active={pathname.includes('/gmail')} collapsed={collapsed} />
        <SidebarNavLink href="/dashboard/pdf-editor" icon={PenSquare} label="PDF editor" active={pathname.includes('/pdf-editor')} collapsed={collapsed} />
        <SidebarNavLink href="/dashboard/virtual-computers" icon={Monitor} label="Virtual computers" active={pathname.includes('/virtual-computers')} collapsed={collapsed} />
        <SidebarNavLink href="/dashboard/schema" icon={Network} label="Schema map" active={pathname.includes('/schema')} collapsed={collapsed} />
        <SidebarNavLink href="/dashboard/settings" icon={Settings} label="Settings" active={pathname.includes('/settings')} collapsed={collapsed} />

        {ctxIsAdmin && (
          <SidebarNavLink
            href="/dashboard/admin" icon={Shield} label="Admin" collapsed={collapsed}
            active={pathname.includes('/admin')}
            activeClassName="bg-amber-600 text-white"
            idleClassName="text-amber-600 hover:bg-amber-50"
          />
        )}

        {ctxIsAdmin && (
          <SidebarNavLink href="/dashboard/billing" icon={CreditCard} label="Billing" active={pathname.includes('/billing')} collapsed={collapsed} />
        )}

        {/* Divider */}
        <div className={`h-px bg-slate-100 my-2 ${collapsed ? 'mx-2' : 'mx-3'}`} />

        {/* Tree nav — record list is collapsed by default, opt-in via the disclosure toggle */}
        {!collapsed && (
        <div>
          <div className="flex items-center justify-between px-3 mb-1">
            <button
              onClick={() => setTreeOpen(p => !p)}
              aria-expanded={treeOpen}
              aria-label={treeOpen ? `Collapse ${mode} list` : `Expand ${mode} list`}
              className="flex items-center gap-1.5 -ml-1 pl-1 pr-2 py-1 rounded-lg hover:bg-slate-50 transition-all"
            >
              <ChevronRight size={10} className={`text-slate-300 shrink-0 transition-transform ${treeOpen ? 'rotate-90' : ''}`} />
              <p className="text-[9px] font-bold text-slate-300 uppercase tracking-widest">
                {mode}
              </p>
              {hasActiveFilters && (
                <span className="px-1.5 py-0.5 bg-indigo-600 text-white rounded-full text-[8px] font-bold">
                  {treeConfig.filters.length}
                </span>
              )}
            </button>
            <div className="flex items-center gap-1">
              <button
                onClick={() => mode === 'entities' ? setIsEntOpen(true) : setIsProjOpen(true)}
                className="p-1 text-slate-300 hover:text-slate-600 rounded-lg hover:bg-slate-50 transition-all"
                title="New record"
                aria-label="New record"
              >
                <Plus size={12} strokeWidth={3} />
              </button>
              <button
                onClick={() => setShowTreeConfig(p => !p)}
                title="Tree settings"
                aria-label="Tree settings"
                className={`p-1 rounded-lg transition-all ${
                  showTreeConfig || hasActiveFilters
                    ? 'text-indigo-600 bg-indigo-50'
                    : 'text-slate-300 hover:text-slate-600 hover:bg-slate-50'
                }`}
              >
                <SlidersHorizontal size={12} />
              </button>
            </div>
          </div>

          {treeOpen && (
            <>
          {/* Active config hints */}
          {(treeConfig.displayFields.length > 1 ||
            treeConfig.sortField !== availableFields[0]?.key) && (
            <div className="px-3 mb-1.5 flex items-center justify-between gap-2">
              <span className="text-[9px] text-slate-400 truncate">
                {treeConfig.displayFields.map(f => {
                  const all = [
                    ...availableFields,
                    ...customFieldCols.map(cf => ({ key: `cf:${cf.id}`, label: cf.label })),
                  ];
                  return all.find(af => af.key === f)?.label || f;
                }).join(treeConfig.separator)}
              </span>
              <span className="text-[9px] text-slate-400 shrink-0">
                ↕ {[
                  ...availableFields,
                  ...customFieldCols.map(cf => ({ key: `cf:${cf.id}`, label: cf.label })),
                ].find(f => f.key === treeConfig.sortField)?.label || treeConfig.sortField}
              </span>
            </div>
          )}

          {/* Tree items */}
          {itemsLoading ? (
            <div className="space-y-0.5 px-1">
              {[1,2,3,4,5].map(i => (
                <div key={i} className="flex items-center px-3 py-2 rounded-2xl">
                  <div className={`h-3 bg-slate-100 animate-pulse rounded-full ${
                    i % 3 === 0 ? 'w-32' : i % 3 === 1 ? 'w-40' : 'w-28'
                  }`} />
                </div>
              ))}
            </div>
          ) : (
            <>
          {items.map((item: any) => (
            <Link
              key={item.id}
              href={`/dashboard/${mode}?id=${item.id}`}
              className={`flex items-center px-3 py-2 rounded-2xl text-[12px] transition-all ${
                currentId === item.id
                  ? 'bg-indigo-600 text-white font-bold'
                  : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900 font-medium'
              }`}
            >
              <span className="truncate">{getItemLabel(item)}</span>
            </Link>
          ))}

          {!itemsLoading && items.length === 0 && (
            <p className="px-3 py-2 text-[11px] text-slate-300 italic">
              No records
              {hasActiveFilters && ' — filters active'}
            </p>
          )}
            </>
          )}
            </>
          )}
        </div>
        )}
      </nav>

      {/* Footer */}
      <div className={`border-t border-slate-100 space-y-1 py-4 ${collapsed ? 'px-2' : 'px-3'}`}>
        <div className="relative" onClick={e => e.stopPropagation()}>

          {/* Table visibility panel */}
          {showTableSettings && (
            <TableVisibilityPanel
              visible={visibleTables}
              systemTables={ALL_SYSTEM_TABLES}
              customTables={customTables}
              onChange={handleVisibilityChange}
              onClose={() => setShowTableSettings(false)}
            />
          )}

          {/* Tree config panel */}
          {showTreeConfig && (
            <TreeConfigPanel
              config={treeConfig}
              availableFields={availableFields}
              customFields={customFieldCols}
              onChange={handleTreeConfigChange}
              onClose={() => setShowTreeConfig(false)}
            />
          )}

          {/* Profile card */}
          {profileLoading ? (
            collapsed ? (
              <div className="h-9 w-9 rounded-full bg-slate-200 animate-pulse mx-auto" />
            ) : (
              <div className="w-full flex items-center gap-3 px-3 py-3 rounded-2xl">
                <div className="h-8 w-8 rounded-full bg-slate-200 animate-pulse shrink-0" />
                <div className="flex flex-col gap-1.5 flex-1">
                  <div className="h-3 w-24 bg-slate-200 animate-pulse rounded-full" />
                  <div className="h-2.5 w-16 bg-slate-100 animate-pulse rounded-full" />
                </div>
              </div>
            )
          ) : (
          <button
            onClick={() => setShowCompanySwitcher(p => !p)}
            title={collapsed ? (profile?.full_name || 'Account') : undefined}
            aria-label="Account menu"
            className={`flex items-center rounded-2xl hover:bg-slate-50 transition-all ${
              collapsed ? 'w-9 h-9 mx-auto justify-center' : 'w-full gap-3 px-3 py-3 text-left'
            }`}
          >
            <div className="h-8 w-8 rounded-full bg-slate-900 flex items-center justify-center text-[10px] font-bold text-white uppercase shrink-0">
              {profile?.full_name?.substring(0, 2) || 'AD'}
            </div>
            {!collapsed && (
              <>
                <div className="flex flex-col min-w-0 flex-1">
                  <p className="text-[12px] font-bold text-slate-900 truncate">
                    {ctxCompanyName || 'No company'}
                  </p>
                  <p className="text-[10px] text-slate-400 truncate">
                    {profile?.full_name || 'User'}
                  </p>
                </div>
                {memberships.length > 1 && (
                  <ChevronsUpDown size={14} className="text-slate-300 shrink-0" />
                )}
              </>
            )}
          </button>
          )}

          {/* Company switcher — fixed width so it stays readable even when the trigger sits in the collapsed rail */}
          {showCompanySwitcher && memberships.length > 0 && (
            <div className="absolute bottom-full left-0 mb-2 w-72 bg-white rounded-3xl border border-slate-200 shadow-xl overflow-hidden z-50">
              <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest px-5 pt-4 pb-2">
                {memberships.length > 1 ? 'Switch company' : 'Your company'}
              </p>
              {memberships.map(m => {
                const isActive = m.company_id === ctxCompanyId;
                return (
                  <button
                    key={m.company_id}
                    onClick={() => handleSwitchCompany(m.company_id)}
                    disabled={isActive || switchingCompany}
                    className={`w-full flex items-center gap-3 px-5 py-3 text-left transition-colors disabled:cursor-default ${
                      isActive ? 'bg-slate-50' : 'hover:bg-slate-50'
                    }`}
                  >
                    <div className={`h-7 w-7 rounded-full flex items-center justify-center text-[9px] font-bold shrink-0 ${
                      isActive ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-500'
                    }`}>
                      {m.company?.name?.substring(0, 2)?.toUpperCase() || '??'}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className={`text-[12px] font-bold truncate ${
                        isActive ? 'text-slate-900' : 'text-slate-600'
                      }`}>
                        {m.company?.name || 'Unknown'}
                      </p>
                      <p className="text-[9px] text-slate-400 uppercase font-medium">
                        {m.role?.replace('_', ' ')}
                      </p>
                    </div>
                    {isActive && (
                      <div className="h-2 w-2 rounded-full bg-slate-900 shrink-0" />
                    )}
                    {!isActive && switchingCompany && (
                      <Loader2 size={12} className="animate-spin text-slate-300 shrink-0" />
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Sign out */}
        <button
          onClick={() => supabase.auth.signOut().then(() => window.location.replace("/login"))}
          title={collapsed ? 'Sign out' : undefined}
          aria-label="Sign out"
          className={`flex items-center rounded-2xl text-[12px] font-medium text-slate-400 hover:text-red-500 hover:bg-red-50 transition-all ${
            collapsed ? 'w-9 h-9 mx-auto justify-center' : 'w-full gap-3 px-3 py-2.5'
          }`}
        >
          <LogOut size={15} className="shrink-0" />
          {!collapsed && 'Sign out'}
        </button>
      </div>

      <NewProjectModal
        isOpen={isProjOpen}
        onClose={() => setIsProjOpen(false)}
        onRefresh={fetchTreeData}
      />
      <NewEntityModal
        isOpen={isEntOpen}
        onClose={() => setIsEntOpen(false)}
        onRefresh={fetchTreeData}
      />
    </div>
  );
}