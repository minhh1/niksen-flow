// components/Sidebar.tsx
"use client";

import { useState, useEffect, useMemo } from "react";
import {
  MapPin, Building2, Plus, LogOut, LayoutGrid,
  Settings, Shield, ChevronsUpDown, Loader2, Mail,
  Table2, Eye, EyeOff, X, Check, SlidersHorizontal, Network, PenSquare, Monitor, CreditCard,
  ChevronRight, Sparkles, Wrench, Store, Trash2, LayoutDashboard,
  Users, Activity, MessageCircle, Users2, Gauge, Clock, Database, Copy, Share2,
  Link as LinkIcon, HeartPulse, FolderOpen, Archive,
} from "lucide-react";
import * as LucideIcons from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import NewProjectModal from "./NewProjectModal";
import NewEntityModal from "./NewEntityModal";
import { useCustomTables } from "@/lib/hooks/useCustomTables";
import { useCustomDashboards } from "@/lib/hooks/useCustomDashboards";
import { useCompany } from "@/components/CompanyContext";
import type { ActiveFilter } from "@/lib/types/filters";
import { savedViewsService, DEFAULT_VIEW_NAME, type SavedView } from "@/lib/services/savedViewsService";
import { useProgressBar } from "@/components/TopProgressBar";
import { perfLog } from "@/lib/perfLog";
import { useCompanyCustomFields } from "@/lib/hooks/useCompanyCustomFields";

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

// ── Rail sections ──────────────────────────────────────────────────
// Four top-level categories on the always-visible icon rail. Each opens a
// second-level panel listing its own destinations, replacing what used to
// be a flat list of nav links (Tools) and, for Admin, a 12-item horizontal
// tab bar that had gotten too crowded to fit on one row.

type RailSection = 'tables' | 'tools' | 'settings' | 'admin';

const TOOLS_LINKS = [
  { href: '/dashboard/ai', icon: Sparkles, label: 'Ask AI' },
  { href: '/dashboard/gmail', icon: Mail, label: 'Gmail' },
  { href: '/dashboard/pdf-editor', icon: PenSquare, label: 'PDF editor' },
  { href: '/dashboard/virtual-computers', icon: Monitor, label: 'Virtual computers' },
  { href: '/dashboard/schema', icon: Network, label: 'Schema map' },
  { href: '/dashboard/new/builder', icon: LayoutDashboard, label: 'Custom dashboard' },
];

const SETTINGS_LINKS = [
  { href: '/dashboard/settings', icon: Settings, label: 'All settings', matchExact: true },
  { href: '/dashboard/billing', icon: CreditCard, label: 'Billing' },
  { href: '/dashboard/settings?view=history', icon: Clock, label: 'Import history' },
  { href: '/dashboard/settings?view=schema', icon: Database, label: 'Schema configuration' },
  { href: '/dashboard/settings?view=duplicates_menu', icon: Copy, label: 'Reconciliation tool' },
  { href: '/dashboard/settings?view=public_pages', icon: Share2, label: 'Public task pages' },
  { href: '/dashboard/settings/history', icon: Clock, label: 'Schema history' },
];

const ADMIN_LINKS = [
  { tab: 'members', icon: Users, label: 'Members' },
  { tab: 'teams', icon: Users, label: 'Teams' },
  { tab: 'views', icon: Settings, label: 'Default views' },
  { tab: 'invites', icon: LinkIcon, label: 'Invite links' },
  { tab: 'gmail', icon: Mail, label: 'Gmail' },
  { tab: 'gmailSync', icon: Activity, label: 'Gmail sync' },
  { tab: 'whatsapp', icon: MessageCircle, label: 'WhatsApp' },
  { tab: 'msTeams', icon: Users2, label: 'Microsoft Teams' },
  { tab: 'oneDrive', icon: FolderOpen, label: 'OneDrive' },
  { tab: 'aiAssistant', icon: Sparkles, label: 'AI Assistant' },
  { tab: 'virtualComputers', icon: Monitor, label: 'Virtual computers' },
  { tab: 'archiveRequests', icon: Archive, label: 'Archive requests' },
  { tab: 'company', icon: Settings, label: 'Company' },
] as const;

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
    <div className="absolute top-full left-0 right-0 mt-1 bg-white rounded-3xl border border-slate-200 shadow-xl z-50 p-4">
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
    <div className="absolute top-full left-0 right-0 mt-1 bg-white rounded-3xl border border-slate-200 shadow-2xl z-50 overflow-hidden">
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
  const { startNavigation } = useProgressBar();
  return (
    <Link
      href={href}
      onClick={() => { if (!active) startNavigation(); }}
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
  const { startNavigation } = useProgressBar();
  const currentId = searchParams.get("id");
  const activeViewId = searchParams.get("view");

  // Use shared company context — avoids duplicate auth call with GenericMasterTable
  const { companyId: ctxCompanyId, companyName: ctxCompanyName, userId: ctxUserId, isAdmin: ctxIsAdmin, isSiteAdmin: ctxIsSiteAdmin, loading: ctxLoading, tableLabelOverrides } = useCompany();

  // Per-company display-name overrides (e.g. a law firm renaming "Projects"
  // to "Matters") layered over the hardcoded defaults.
  const systemTables = useMemo(
    () => ALL_SYSTEM_TABLES.map(t => {
      const override = tableLabelOverrides[t.slug];
      return override?.plural ? { ...t, label: override.plural } : t;
    }),
    [tableLabelOverrides]
  );

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
  // Which table's records the tree section browses — independent of the
  // active page/tab, so switching e.g. Projects → Properties in the main
  // view doesn't yank the tree away from whatever the user picked there.
  // Defaults to the active page only on first-ever load (no saved pick yet).
  const [treeTableSlug, setTreeTableSlugState] = useState<string>(() => {
    try {
      const saved = localStorage.getItem('nk_sidebar_tree_table');
      if (saved && ALL_SYSTEM_TABLES.some(t => t.slug === saved)) return saved;
    } catch {}
    return pathname.includes('properties') ? 'properties' :
      pathname.includes('entities') ? 'entities' : 'projects';
  });
  const setTreeTableSlug = (slug: string) => {
    setTreeTableSlugState(slug);
    try { localStorage.setItem('nk_sidebar_tree_table', slug); } catch {}
  };
  const [treeConfig, setTreeConfig] = useState<TreeConfig>(() =>
    DEFAULT_TREE_CONFIG[treeTableSlug] || DEFAULT_TREE_CONFIG.projects
  );
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  const [treeOpen, setTreeOpen] = useState(false);
  const { tables: customTables } = useCustomTables();
  const { dashboards, refetch: refetchDashboards } = useCustomDashboards();

  const mode = pathname.includes("projects") ? "projects"
    : pathname.includes("properties") ? "properties"
    : "entities";

  // Which second-level panel is open, if any — independent of the current
  // page after mount (e.g. opening Tools while browsing Projects doesn't
  // navigate anywhere, it just shows Tools' destinations to pick from).
  // Seeded from the current page so landing on e.g. /dashboard/admin opens
  // straight to the Admin panel rather than defaulting to Tables.
  const [activeRailSection, setActiveRailSection] = useState<RailSection | null>(() => {
    // Marketplace is a plain link (no second-level panel of its own), so it
    // must seed no panel at all — otherwise landing here directly leaves
    // Tables' panel open behind it, and the two look simultaneously "active".
    if (pathname.startsWith('/dashboard/marketplace')) return null;
    if (pathname.includes('/admin')) return 'admin';
    if (pathname.includes('/settings') || pathname.includes('/billing')) return 'settings';
    if (
      pathname.includes('/dashboard/ai') || pathname.includes('/gmail') ||
      pathname.includes('/pdf-editor') || pathname.includes('/virtual-computers') ||
      pathname.includes('/schema')
    ) return 'tools';
    return 'tables';
  });
  const toggleRailSection = (section: RailSection) => {
    setActiveRailSection(prev => prev === section ? null : section);
  };
  const tablesPanelOpen = activeRailSection === 'tables';

  // Shared with GenericMasterTable via useCompanyCustomFields' module cache —
  // when the tree's table matches the active page's table, this fires once.
  // Skipped while the Tables panel itself isn't showing (e.g. browsing a
  // Tools/Settings/Admin page) — no point fetching data for a panel the
  // user hasn't opened.
  const { fields: customFieldCols } = useCompanyCustomFields(treeTableSlug, tablesPanelOpen);

  // Record list is opt-in — collapse it again whenever the tree's table changes
  useEffect(() => { setTreeOpen(false); }, [treeTableSlug]);

  // ── Load tree config from DB when the tree's table changes ──────
  useEffect(() => {
    if (!ctxUserId || !tablesPanelOpen) return;
    const load = async () => {
      perfLog(`Sidebar(${treeTableSlug}): treeConfig start`);
      const config = await loadTreeConfigFromDB(treeTableSlug, ctxUserId);
      perfLog(`Sidebar(${treeTableSlug}): treeConfig resolved`);
      setTreeConfig(config);
    };
    load();
  }, [treeTableSlug, ctxUserId, tablesPanelOpen]);

  // ── Load saved views for the active table ───────────────────────
  useEffect(() => {
    if (!ctxUserId || !ctxCompanyId || !tablesPanelOpen) return;
    perfLog(`Sidebar(${mode}): savedViews start`);
    savedViewsService.listByTable(ctxUserId, ctxCompanyId, mode).then(views => {
      perfLog(`Sidebar(${mode}): savedViews resolved`, `${views.length} views`);
      setSavedViews(views.filter(v => v.view_name !== DEFAULT_VIEW_NAME));
    });
  }, [mode, ctxUserId, ctxCompanyId, tablesPanelOpen]);

  // Deferred until the tree is actually expanded — this used to run
  // unconditionally on every mount/table-switch (rows + custom field values,
  // up to 2000 records), even for users who never open the tree. It also
  // fired twice per table switch: once with the synchronous default
  // treeConfig, again once the real config loaded from the DB a moment
  // later. Gating on treeOpen fixes both — closed trees do no work at all,
  // and opening one fetches once against whichever config has landed by then.
  useEffect(() => {
    if (!treeOpen) return;
    perfLog(`Sidebar(${treeTableSlug}): fetchTreeData start`);
    fetchTreeData().then(() => perfLog(`Sidebar(${treeTableSlug}): fetchTreeData resolved`));
  }, [treeTableSlug, treeConfig, treeOpen]);

  useEffect(() => {
    if (!ctxUserId) return;
    perfLog("Sidebar: fetchProfile start");
    fetchProfile().then(() => perfLog("Sidebar: fetchProfile resolved"));
    // Re-fetch on route change too, so edits made on /dashboard/profile (name, photo)
    // show up in the rail as soon as the user navigates back — this layout persists
    // across route changes so it wouldn't otherwise remount to pick them up.
  }, [ctxUserId, pathname]);

  useEffect(() => {
    // useCustomDashboards() here is a separate hook instance from the one the
    // builder/view pages use, so creating/deleting a dashboard elsewhere
    // doesn't update this list on its own — re-fetch on every route change
    // (the delete/save flows navigate away immediately after) instead of
    // requiring a full page reload to see the sidebar catch up.
    refetchDashboards();
  }, [pathname, refetchDashboards]);

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
    let avatarUrl: string | null = null;
    let visibleTablesData: any = null;

    const { data: profFull, error } = await supabase
      .from("profiles")
      .select("full_name, avatar_url, sidebar_visible_tables")
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
      avatarUrl = profFull?.avatar_url ?? null;
      visibleTablesData = profFull?.sidebar_visible_tables;
    }

    setProfile({ full_name: fullName, avatar_url: avatarUrl });

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
      .from(treeTableSlug)
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
      ...SYSTEM_TABLE_FIELDS[treeTableSlug] || [],
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
    await saveTreeConfigToDB(treeTableSlug, config, ctxUserId);
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
    startNavigation();
    router.push(`/dashboard/${mode}?view=${created.id}`);
  };

  const handleDeleteView = async (view: SavedView, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!window.confirm(`Delete the saved view "${view.view_name}"? This can't be undone.`)) return;
    await savedViewsService.remove(view.id);
    setSavedViews(prev => prev.filter(v => v.id !== view.id));
    if (activeViewId === view.id) { startNavigation(); router.push(`/dashboard/${mode}`); }
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
  const visibleSystemTables = systemTables.filter(t => visibleTables.includes(t.slug));
  const visibleCustomTables = customTables.filter(t => visibleTables.includes(t.slug));
  const isTableActive = (slug: string) =>
    pathname.includes(slug) &&
    !pathname.includes('gmail') &&
    !pathname.includes('settings') &&
    !pathname.includes('admin');

  const availableFields = SYSTEM_TABLE_FIELDS[treeTableSlug] || SYSTEM_TABLE_FIELDS.projects;
  const hasActiveFilters = treeConfig.filters.length > 0;
  const currentAdminTab = searchParams.get('tab') || 'members';
  const currentSettingsView = searchParams.get('view');

  // ── Render ─────────────────────────────────────────────────────
  return (
    <div className="flex h-screen shrink-0 font-sans select-none antialiased text-slate-600">

      {/* ── Rail (always visible, icon-only) ── */}
      <div className="w-16 shrink-0 flex flex-col h-screen bg-white border-r border-slate-100 items-center py-4">
        <div className="h-9 w-9 rounded-xl bg-slate-900 flex items-center justify-center shadow-sm shrink-0 mb-4">
          <div className="h-3.5 w-3.5 rounded-full border-2 border-white" />
        </div>

        <div className="flex flex-col gap-1 items-center">
          <button
            onClick={() => toggleRailSection('tables')}
            title="Tables" aria-label="Tables"
            className={`w-10 h-10 rounded-2xl flex items-center justify-center transition-all ${
              activeRailSection === 'tables' ? 'bg-slate-900 text-white' : 'text-slate-400 hover:bg-slate-50 hover:text-slate-700'
            }`}
          >
            <Table2 size={17} />
          </button>
          <button
            onClick={() => toggleRailSection('tools')}
            title="Tools" aria-label="Tools"
            className={`w-10 h-10 rounded-2xl flex items-center justify-center transition-all ${
              activeRailSection === 'tools' ? 'bg-slate-900 text-white' : 'text-slate-400 hover:bg-slate-50 hover:text-slate-700'
            }`}
          >
            <Wrench size={17} />
          </button>
          <Link
            href="/dashboard/marketplace"
            onClick={() => { if (!pathname.startsWith('/dashboard/marketplace')) startNavigation(); setActiveRailSection(null); }}
            title="Marketplace" aria-label="Marketplace"
            className={`w-10 h-10 rounded-2xl flex items-center justify-center transition-all ${
              pathname.startsWith('/dashboard/marketplace') && !activeRailSection ? 'bg-slate-900 text-white' : 'text-slate-400 hover:bg-slate-50 hover:text-slate-700'
            }`}
          >
            <Store size={17} />
          </Link>
          <button
            onClick={() => toggleRailSection('settings')}
            title="Settings" aria-label="Settings"
            className={`w-10 h-10 rounded-2xl flex items-center justify-center transition-all ${
              activeRailSection === 'settings' ? 'bg-slate-900 text-white' : 'text-slate-400 hover:bg-slate-50 hover:text-slate-700'
            }`}
          >
            <Settings size={17} />
          </button>
          {ctxIsAdmin && (
            <button
              onClick={() => toggleRailSection('admin')}
              title="Admin" aria-label="Admin"
              className={`w-10 h-10 rounded-2xl flex items-center justify-center transition-all ${
                activeRailSection === 'admin' ? 'bg-amber-600 text-white' : 'text-amber-600 hover:bg-amber-50'
              }`}
            >
              <Shield size={17} />
            </button>
          )}
        </div>

        <div className="flex-1" />

        <div className="relative" onClick={e => e.stopPropagation()}>
          {profileLoading ? (
            <div className="h-9 w-9 rounded-full bg-slate-200 animate-pulse" />
          ) : (
            <button
              onClick={() => setShowCompanySwitcher(p => !p)}
              title={profile?.full_name || 'Account'}
              aria-label="Account menu"
              className="w-9 h-9 rounded-2xl flex items-center justify-center hover:bg-slate-50 transition-all"
            >
              <div className="h-8 w-8 rounded-full bg-slate-900 flex items-center justify-center text-[10px] font-bold text-white uppercase shrink-0 overflow-hidden">
                {profile?.avatar_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={profile.avatar_url} alt="" className="h-full w-full object-cover" />
                ) : (
                  profile?.full_name?.substring(0, 2) || 'AD'
                )}
              </div>
            </button>
          )}

          {/* Account menu — fixed width so it stays readable even though the trigger sits in the narrow rail */}
          {showCompanySwitcher && (
            <div className="absolute bottom-0 left-full ml-2 w-72 bg-white rounded-3xl border border-slate-200 shadow-xl overflow-hidden z-50">
              <Link
                href="/dashboard/profile"
                onClick={() => setShowCompanySwitcher(false)}
                className="flex items-center gap-3 px-5 py-3.5 border-b border-slate-100 hover:bg-slate-50 transition-colors"
              >
                <div className="h-7 w-7 rounded-full bg-slate-900 flex items-center justify-center text-[9px] font-bold text-white uppercase shrink-0 overflow-hidden">
                  {profile?.avatar_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={profile.avatar_url} alt="" className="h-full w-full object-cover" />
                  ) : (
                    profile?.full_name?.substring(0, 2) || 'AD'
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[12px] font-bold text-slate-900 truncate">{profile?.full_name || 'My Profile'}</p>
                  <p className="text-[9px] text-slate-400 uppercase font-medium">View profile</p>
                </div>
              </Link>

              {memberships.length > 0 && (
                <>
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
                </>
              )}
            </div>
          )}
        </div>

        <button
          onClick={() => supabase.auth.signOut().then(() => window.location.replace("/login"))}
          title="Sign out"
          aria-label="Sign out"
          className="w-9 h-9 mt-1 rounded-2xl flex items-center justify-center text-slate-400 hover:text-red-500 hover:bg-red-50 transition-all"
        >
          <LogOut size={16} />
        </button>
      </div>

      {/* ── Second-level panel ── */}
      {activeRailSection && (
        <div className="w-72 shrink-0 flex flex-col h-screen bg-white border-r border-slate-100 overflow-hidden relative">

          {activeRailSection === 'tables' && (
            <nav className="flex-1 overflow-y-auto py-4 px-3 space-y-0.5">
              {/* Tables */}
              <div className="mb-2">
                <div className="relative" onClick={e => e.stopPropagation()}>
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

                  {/* Table visibility panel */}
                  {showTableSettings && (
                    <TableVisibilityPanel
                      visible={visibleTables}
                      systemTables={systemTables}
                      customTables={customTables}
                      onChange={handleVisibilityChange}
                      onClose={() => setShowTableSettings(false)}
                    />
                  )}
                </div>

                {profileLoading ? (
                  <div className="space-y-1 px-1">
                    {[1,2,3].map(i => (
                      <div key={i} className="flex items-center gap-3 px-3 py-2.5 rounded-2xl">
                        <div className="h-4 w-4 rounded bg-slate-100 animate-pulse shrink-0" />
                        <div className={`h-3 bg-slate-100 animate-pulse rounded-full ${i === 1 ? 'w-20' : i === 2 ? 'w-16' : 'w-24'}`} />
                      </div>
                    ))}
                  </div>
                ) : (
                  <>
                {visibleSystemTables.map(({ slug, label, icon: Icon }) => (
                  <button
                    key={slug}
                    onClick={() => { if (!isTableActive(slug)) { startNavigation(); router.push(`/dashboard/${slug}`); } }}
                    aria-label={label}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-2xl text-[13px] font-medium transition-all ${
                      isTableActive(slug)
                        ? 'bg-slate-900 text-white'
                        : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900'
                    }`}
                  >
                    <Icon size={16} className="shrink-0" />
                    <span className="truncate">{label}</span>
                  </button>
                ))}

                {visibleCustomTables.map(table => {
                  const Icon = (LucideIcons as any)[table.icon] || Table2;
                  return (
                    <button
                      key={table.id}
                      onClick={() => { if (!isTableActive(table.slug)) { startNavigation(); router.push(`/dashboard/${table.slug}`); } }}
                      aria-label={table.name}
                      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-2xl text-[13px] font-medium transition-all ${
                        isTableActive(table.slug)
                          ? 'bg-slate-900 text-white'
                          : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900'
                      }`}
                    >
                      <Icon size={16} className="shrink-0" />
                      <span className="truncate">{table.name}</span>
                    </button>
                  );
                })}
                  </>
                )}

                {!profileLoading && visibleSystemTables.length === 0 && visibleCustomTables.length === 0 && (
                  <button
                    onClick={() => setShowTableSettings(true)}
                    className="w-full px-3 py-2.5 text-[11px] text-slate-300 italic text-left"
                  >
                    No tables visible — click eye to configure
                  </button>
                )}
              </div>

              {/* Dashboards — custom, user-built screens bound to one
                  custom table (quick-add form + grid + stats + activity
                  chart). See lib/hooks/useCustomDashboards.ts. */}
              <div className="mb-2">
                <div className="flex items-center justify-between px-3 mb-1">
                  <p className="text-[9px] font-bold text-slate-300 uppercase tracking-widest">Dashboards</p>
                  <button
                    onClick={() => { startNavigation(); router.push('/dashboard/new/builder'); }}
                    className="p-1 text-slate-300 hover:text-slate-600 rounded-lg hover:bg-slate-50 transition-all"
                    title="New dashboard"
                    aria-label="New dashboard"
                  >
                    <Plus size={12} strokeWidth={3} />
                  </button>
                </div>
                {dashboards.map(d => {
                  const Icon = (LucideIcons as any)[d.icon] || LayoutDashboard;
                  const active = pathname === `/dashboard/${d.slug}`;
                  return (
                    <button
                      key={d.id}
                      onClick={() => { if (!active) { startNavigation(); router.push(`/dashboard/${d.slug}`); } }}
                      aria-label={d.name}
                      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-2xl text-[13px] font-medium transition-all ${
                        active ? 'bg-slate-900 text-white' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900'
                      }`}
                    >
                      <Icon size={16} className="shrink-0" />
                      <span className="truncate">{d.name}</span>
                    </button>
                  );
                })}
                {dashboards.length === 0 && (
                  <button
                    onClick={() => { startNavigation(); router.push('/dashboard/new/builder'); }}
                    className="w-full px-3 py-2.5 text-[11px] text-slate-300 italic text-left"
                  >
                    No dashboards yet — click + to build one
                  </button>
                )}
              </div>

              {/* Saved views — for the currently active table */}
              {isTableActive(mode) && (
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
                  {/* Not highlighted even when no named view is selected —
                      filters auto-save without one, so "no view selected"
                      doesn't mean "no filter active" and shouldn't look
                      like a selected/active state. Always navigates (not
                      gated on activeViewId) since it needs to clear ad-hoc
                      filters too, not just drop a named view selection. */}
                  <button
                    onClick={() => { startNavigation(); router.push(`/dashboard/${mode}?clearFilters=1`); }}
                    className="w-full flex items-center px-3 py-2 rounded-2xl text-[12px] transition-all text-slate-500 hover:bg-slate-50 hover:text-slate-900 font-medium"
                  >
                    All (no filter)
                  </button>
                  {savedViews.map(view => (
                    <div key={view.id} className="group/view flex items-center">
                      <button
                        onClick={() => { if (activeViewId !== view.id) { startNavigation(); router.push(`/dashboard/${mode}?view=${view.id}`); } }}
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
              <div className="h-px bg-slate-100 my-2 mx-3" />

              {/* Tree nav — record list is collapsed by default, opt-in via the disclosure toggle */}
              <div>
                <div className="relative" onClick={e => e.stopPropagation()}>
                  <div className="flex items-center justify-between px-3 mb-1">
                    <div className="flex items-center gap-1 -ml-1 pl-1 pr-2 py-1 rounded-lg hover:bg-slate-50 transition-all">
                      <button
                        onClick={() => setTreeOpen(p => !p)}
                        aria-expanded={treeOpen}
                        aria-label={treeOpen ? `Collapse ${treeTableSlug} list` : `Expand ${treeTableSlug} list`}
                        className="p-0.5 rounded hover:bg-slate-100 transition-all shrink-0"
                      >
                        <ChevronRight size={10} className={`text-slate-300 transition-transform ${treeOpen ? 'rotate-90' : ''}`} />
                      </button>
                      <select
                        value={treeTableSlug}
                        onChange={e => setTreeTableSlug(e.target.value)}
                        aria-label="Choose which table's records to browse"
                        title="Choose which table's records to browse"
                        className="text-[9px] font-bold text-slate-400 uppercase tracking-widest bg-transparent border-none outline-none cursor-pointer hover:text-slate-600 transition-all"
                      >
                        {visibleSystemTables.map(t => (
                          <option key={t.slug} value={t.slug}>{t.label}</option>
                        ))}
                      </select>
                      {hasActiveFilters && (
                        <span className="px-1.5 py-0.5 bg-indigo-600 text-white rounded-full text-[8px] font-bold">
                          {treeConfig.filters.length}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => treeTableSlug === 'entities' ? setIsEntOpen(true) : setIsProjOpen(true)}
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
                    href={`/dashboard/${treeTableSlug}?id=${item.id}`}
                    className={`flex items-center px-3 py-2 rounded-2xl text-[12px] transition-all ${
                      treeTableSlug === mode && currentId === item.id
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
            </nav>
          )}

          {activeRailSection === 'tools' && (
            <nav className="flex-1 overflow-y-auto py-4 px-3 space-y-0.5">
              <p className="px-3 mb-1 text-[9px] font-bold text-slate-300 uppercase tracking-widest">Tools</p>
              {TOOLS_LINKS.map(link => (
                <SidebarNavLink
                  key={link.href}
                  href={link.href}
                  icon={link.icon}
                  label={link.label}
                  active={pathname.startsWith(link.href)}
                  collapsed={false}
                />
              ))}
            </nav>
          )}

          {activeRailSection === 'settings' && (
            <nav className="flex-1 overflow-y-auto py-4 px-3 space-y-0.5">
              <p className="px-3 mb-1 text-[9px] font-bold text-slate-300 uppercase tracking-widest">Settings</p>
              {SETTINGS_LINKS.map(link => {
                const [linkPath, linkQuery] = link.href.split('?view=');
                const isActive = link.matchExact
                  ? pathname === linkPath && !currentSettingsView
                  : linkQuery
                    ? pathname === linkPath && currentSettingsView === linkQuery
                    : pathname === linkPath;
                return (
                  <SidebarNavLink
                    key={link.href}
                    href={link.href}
                    icon={link.icon}
                    label={link.label}
                    active={isActive}
                    collapsed={false}
                  />
                );
              })}
            </nav>
          )}

          {activeRailSection === 'admin' && ctxIsAdmin && (
            <nav className="flex-1 overflow-y-auto py-4 px-3 space-y-0.5">
              <p className="px-3 mb-1 text-[9px] font-bold text-slate-300 uppercase tracking-widest">Admin</p>
              {ADMIN_LINKS.map(link => (
                <SidebarNavLink
                  key={link.tab}
                  href={`/dashboard/admin?tab=${link.tab}`}
                  icon={link.icon}
                  label={link.label}
                  active={pathname.startsWith('/dashboard/admin') && currentAdminTab === link.tab}
                  collapsed={false}
                  activeClassName="bg-amber-600 text-white"
                />
              ))}
              <SidebarNavLink
                href="/dashboard/settings/trash"
                icon={Trash2}
                label="Trash"
                active={pathname === '/dashboard/settings/trash'}
                collapsed={false}
                activeClassName="bg-amber-600 text-white"
              />
              {ctxIsSiteAdmin && (
                <>
                  <SidebarNavLink
                    href="/dashboard/admin?tab=perf"
                    icon={Gauge}
                    label="Performance"
                    active={pathname.startsWith('/dashboard/admin') && currentAdminTab === 'perf'}
                    collapsed={false}
                    activeClassName="bg-amber-600 text-white"
                  />
                  <SidebarNavLink
                    href="/dashboard/admin?tab=platformHealth"
                    icon={HeartPulse}
                    label="Platform health"
                    active={pathname.startsWith('/dashboard/admin') && currentAdminTab === 'platformHealth'}
                    collapsed={false}
                    activeClassName="bg-amber-600 text-white"
                  />
                </>
              )}
            </nav>
          )}
        </div>
      )}

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