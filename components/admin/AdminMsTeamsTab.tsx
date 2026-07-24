// components/admin/AdminMsTeamsTab.tsx
// Admin-only: connect the company's Microsoft Teams tenant via an Azure AD
// app registration (company-wide app-only access, one org admin consent --
// no per-user connect flow). Distinct from AdminTeamsTab.tsx, which
// manages this app's internal user-teams and has nothing to do with
// Microsoft Teams.
"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Users2, Trash2, Loader2, ExternalLink, CheckCircle2, HelpCircle, Bot, Copy, Check } from "lucide-react";
import CredentialsHelpDrawer from "./CredentialsHelpDrawer";
import { useProgressBarWhile } from "@/components/TopProgressBar";
import { APP_URL } from "@/lib/config";

const CONSENT_CALLBACK_URL = `${APP_URL}/api/teams/admin-consent-callback`;

// Last verified against learn.microsoft.com's "Register a Bot Framework bot
// with Azure", "Configure an Azure AI Bot Service bot to run on one or more
// channels", and "Connect a Bot Framework bot to Microsoft Teams" docs on
// 2026-07-21. Important: multi-tenant bot creation was deprecated after
// 2025-07-31 -- only "Single Tenant" or "User-Assigned Managed Identity" can
// be created now (this integration only supports Single Tenant, hence the
// Tenant ID field below; see lib/msTeamsBot/connector.ts).
const BOT_HELP_STEPS = [
  {
    title: "Create an Azure Bot resource (Single Tenant)",
    description:
      "In the Azure Portal, select Create a resource, search \"bot\", choose the Azure Bot card, and Create. This is a separate resource from the Azure AD app registration used for the read-only sync above. Fill in Project details, then under \"Microsoft App ID\" choose to create a new app ID and select type Single Tenant -- Multi Tenant can no longer be created (deprecated by Microsoft since mid-2025) and User-Assigned Managed Identity isn't supported by this integration.",
    linkLabel: "portal.azure.com",
    linkUrl: "https://portal.azure.com",
  },
  {
    title: "Find the App ID and Tenant ID, generate a password",
    description:
      "On the bot resource's Configuration page, the Microsoft App ID and App Tenant ID are both shown directly. Click \"Manage\" next to Microsoft App ID to jump to Certificates & secrets, then New client secret -- copy the Value immediately, Azure only shows it once.",
  },
  {
    title: "Set the messaging endpoint",
    description:
      "Still on the Configuration page, set \"Messaging endpoint\" to the URL shown below (once you've saved credentials here, it includes this company's ID).",
  },
  {
    title: "Enable the Microsoft Teams channel",
    description:
      "On the bot resource's Channels page (under Settings), select the Microsoft Teams icon, accept the terms of service, pick a cloud environment on the Messaging tab, and Apply. Without this step the bot can never receive a message from Teams no matter how it's configured elsewhere.",
  },
  {
    title: "Create and sideload a Teams app package",
    description:
      "A bot only reaches real users in Teams as part of a Teams app package (manifest + icons) referencing this bot's Application ID -- the Teams Developer Portal is the simplest way to build one. Sideload it into your tenant or publish it to your org's app catalog. This is a one-time manual step for your Microsoft 365 admin -- it can't be pushed here automatically.",
    linkLabel: "dev.teams.microsoft.com",
    linkUrl: "https://dev.teams.microsoft.com",
  },
];

// Last verified against learn.microsoft.com's Azure AD app registration +
// v2 admin-consent-endpoint docs on 2026-07-21 -- if a step no longer
// matches the Azure Portal, re-check and update this array rather than
// guessing.
const TEAMS_HELP_STEPS = [
  {
    title: "Register an app in Azure AD (Microsoft Entra ID)",
    description:
      `In the Azure Portal, go to Microsoft Entra ID → App registrations → New registration. Any name is fine. Even though there's no interactive sign-in here, the admin-consent step later is itself redirect-based and requires at least one Redirect URI registered, or it fails with AADSTS500113 ("No reply address is registered"). Add ${CONSENT_CALLBACK_URL} as a Web redirect URI under Authentication (either during creation, or after via Authentication → Add a platform → Web).`,
    linkLabel: "portal.azure.com",
    linkUrl: "https://portal.azure.com",
  },
  {
    title: "Find the tenant ID and client ID",
    description:
      "After registering, the app's Overview page shows both directly: \"Directory (tenant) ID\" and \"Application (client) ID\". Copy each one exactly as shown.",
  },
  {
    title: "Generate a client secret",
    description:
      "On the same app, go to Certificates & secrets → Client secrets → New client secret. Copy the Value column immediately after creating it — Azure only displays it once, and the field named \"Secret ID\" next to it is not the value you need.",
  },
  {
    title: "Add API permissions and grant admin consent",
    description:
      "Go to API permissions → Add a permission → Microsoft Graph → Application permissions, and add ChannelMessage.Read.All, Chat.Read.All, and Team.ReadBasic.All. After saving the credentials below, use the \"Grant admin consent\" link this app shows you — it needs to be clicked by someone with Microsoft 365 admin rights for your organization. Once they approve, Azure redirects back here and this connects automatically -- the button below is just a manual fallback in case that redirect doesn't land back in this browser.",
  },
];

interface Props {
  companyId: string;
}

interface Connection {
  id: string;
  admin_consent_granted: boolean;
  last_synced_at: string | null;
  last_sync_error: string | null;
  created_at: string;
  tenant_id: string;
  client_id: string;
  secret_expires_at: string | null;
}

interface BotConnection {
  id: string;
  enabled: boolean;
  created_at: string;
  bot_mode: "byo" | "shared";
  teams_tenant_id: string | null;
  bot_app_id: string | null;
  bot_tenant_id: string | null;
  secret_expires_at: string | null;
}

// Last verified against Microsoft Q&A guidance on multitenant Azure Bot
// configuration, 2026-07-24: multi-tenant *bot resource* creation is
// deprecated, but a Single Tenant bot resource backed by a multitenant
// *app registration* is the current supported way to serve many Microsoft
// 365 tenants from one bot -- see app/api/teams/bot/shared/route.ts.
const SHARED_BOT_HELP_STEPS = [
  {
    title: "Find your Microsoft 365 Tenant ID",
    description:
      "In the Microsoft Entra admin center, your organization's overview page shows \"Tenant ID\" directly. Any Microsoft 365 global admin can find this -- no app registration or client secret needed on your end.",
    linkLabel: "entra.microsoft.com",
    linkUrl: "https://entra.microsoft.com",
  },
  {
    title: "Paste it in below and enable the bot",
    description:
      "Once saved, Diract's shared bot recognizes messages coming from your organization and routes them to your company -- nothing else to configure on the Azure side.",
  },
  {
    title: "Add the shared Teams app to your organization",
    description:
      "Ask Diract for the shared Teams app package (one package works for every company on this shared bot, since it references the same fixed bot App ID). In the Teams Admin Center, go to Manage apps and Upload a custom app -- after that one-time upload, anyone in your organization can find and add it from Teams' \"Built for your org\" section.",
  },
];

// Mirrors lib/ai/actionFields.ts's FieldDef -- what the Teams bot must ask
// about before creating a task/project (required) and what to fall back to
// silently when a field is left out (defaultValue). alwaysRequired fields
// (name, and project_name for tasks) aren't configurable here.
interface ActionField {
  key: string;
  label: string;
  kind: string;
  alwaysRequired: boolean;
  required: boolean;
  defaultValue: string | null;
  isCustom: boolean;
  selectOptions?: string[];
}

interface ProjectSearchField {
  id: string;
  fieldKey: string;
  label: string;
  enabled: boolean;
}

export default function AdminMsTeamsTab({ companyId }: Props) {
  const searchParams = useSearchParams();
  const [connection, setConnection] = useState<Connection | null>(null);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [tenantId, setTenantId] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [clientSecretExpiresAt, setClientSecretExpiresAt] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);

  const [botConnection, setBotConnection] = useState<BotConnection | null>(null);
  const [botLoading, setBotLoading] = useState(true);
  const [showBotForm, setShowBotForm] = useState(false);
  const [botFormMode, setBotFormMode] = useState<"byo" | "shared">("byo");
  const [botAppId, setBotAppId] = useState("");
  const [botAppPassword, setBotAppPassword] = useState("");
  const [botTenantId, setBotTenantId] = useState("");
  const [botSecretExpiresAt, setBotSecretExpiresAt] = useState("");
  const [botSaving, setBotSaving] = useState(false);
  const [botError, setBotError] = useState<string | null>(null);
  const [botHelpOpen, setBotHelpOpen] = useState(false);
  const [sharedTenantId, setSharedTenantId] = useState("");
  const [sharedBotHelpOpen, setSharedBotHelpOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const [actionFieldsTab, setActionFieldsTab] = useState<"create_project" | "create_task">("create_project");
  const [actionFields, setActionFields] = useState<ActionField[]>([]);
  const [actionFieldsLoading, setActionFieldsLoading] = useState(false);

  const [requireUniqueTaskNames, setRequireUniqueTaskNames] = useState(false);
  const [projectSearchFields, setProjectSearchFields] = useState<ProjectSearchField[]>([]);
  const [projectSearchFieldsLoading, setProjectSearchFieldsLoading] = useState(false);

  const consentResult = searchParams.get("msTeamsConsent");
  const consentMessage = searchParams.get("message");
  const messagingEndpointUrl = `${APP_URL}/api/teams/bot/${companyId}`;
  const sharedMessagingEndpointUrl = `${APP_URL}/api/teams/bot/shared`;

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/teams/credentials");
    const json = await res.json();
    setConnection(json.connection ?? null);
    setLoading(false);
  }, []);

  const loadBot = useCallback(async () => {
    setBotLoading(true);
    const res = await fetch("/api/teams/bot/credentials");
    const json = await res.json();
    setBotConnection(json.connection ?? null);
    setBotLoading(false);
  }, []);

  const connectBot = async () => {
    setBotError(null);
    if (!botAppId.trim() || !botAppPassword.trim() || !botTenantId.trim()) {
      setBotError("All three fields are required");
      return;
    }
    setBotSaving(true);
    const res = await fetch("/api/teams/bot/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bot_app_id: botAppId.trim(),
        bot_app_password: botAppPassword.trim(),
        bot_tenant_id: botTenantId.trim(),
        secret_expires_at: botSecretExpiresAt || null,
      }),
    });
    const json = await res.json();
    setBotSaving(false);
    if (!res.ok) {
      setBotError(json.error || "Failed to save");
      return;
    }
    setBotAppId("");
    setBotAppPassword("");
    setBotTenantId("");
    setBotSecretExpiresAt("");
    setShowBotForm(false);
    loadBot();
  };

  const connectSharedBot = async () => {
    setBotError(null);
    if (!sharedTenantId.trim()) {
      setBotError("Tenant ID is required");
      return;
    }
    setBotSaving(true);
    const res = await fetch("/api/teams/bot/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bot_mode: "shared", teams_tenant_id: sharedTenantId.trim() }),
    });
    const json = await res.json();
    setBotSaving(false);
    if (!res.ok) {
      setBotError(json.error || "Failed to save");
      return;
    }
    setSharedTenantId("");
    setShowBotForm(false);
    loadBot();
  };

  const toggleBotEnabled = async (enabled: boolean) => {
    await fetch("/api/teams/bot/credentials", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    loadBot();
  };

  const disconnectBot = async () => {
    if (!confirm("Disconnect the Teams bot? Linked accounts and conversation history will be kept.")) return;
    await fetch("/api/teams/bot/credentials", { method: "DELETE" });
    loadBot();
  };

  const copyEndpoint = () => {
    navigator.clipboard.writeText(messagingEndpointUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const loadActionFields = useCallback(async (actionType: "create_project" | "create_task") => {
    setActionFieldsLoading(true);
    const res = await fetch(`/api/teams/bot/action-fields?actionType=${actionType}`);
    const json = await res.json();
    setActionFields(json.fields ?? []);
    setActionFieldsLoading(false);
  }, []);

  const updateActionField = async (field: ActionField, patch: { required?: boolean; default_value?: string | null }) => {
    await fetch("/api/teams/bot/action-fields", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action_type: actionFieldsTab,
        field_key: field.key,
        required: patch.required ?? field.required,
        default_value: patch.default_value !== undefined ? patch.default_value : field.defaultValue,
      }),
    });
  };

  const loadProjectSearchFields = useCallback(async () => {
    setProjectSearchFieldsLoading(true);
    const res = await fetch("/api/teams/bot/project-search-fields");
    const json = await res.json();
    setProjectSearchFields(json.fields ?? []);
    setProjectSearchFieldsLoading(false);
  }, []);

  const toggleProjectSearchField = async (field: ProjectSearchField) => {
    const enabled = !field.enabled;
    setProjectSearchFields((prev) => prev.map((f) => (f.id === field.id ? { ...f, enabled } : f)));
    await fetch("/api/teams/bot/project-search-fields", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ custom_field_id: field.id, enabled }),
    });
  };

  const loadRequireUniqueTaskNames = useCallback(async () => {
    const res = await fetch("/api/ai/settings");
    const json = await res.json();
    setRequireUniqueTaskNames(!!json.settings?.require_unique_task_names);
  }, []);

  const toggleRequireUniqueTaskNames = async (value: boolean) => {
    setRequireUniqueTaskNames(value);
    await fetch("/api/ai/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ require_unique_task_names: value }),
    });
  };

  useEffect(() => {
    load();
    loadBot();
  }, [load, loadBot]);
  useEffect(() => {
    if (botConnection) loadActionFields(actionFieldsTab);
  }, [botConnection, actionFieldsTab, loadActionFields]);
  useEffect(() => {
    if (botConnection) {
      loadProjectSearchFields();
      loadRequireUniqueTaskNames();
    }
  }, [botConnection, loadProjectSearchFields, loadRequireUniqueTaskNames]);
  useProgressBarWhile(loading);

  const connect = async () => {
    setError(null);
    if (!tenantId.trim() || !clientId.trim() || !clientSecret.trim()) {
      setError("All fields are required");
      return;
    }
    setSaving(true);
    const res = await fetch("/api/teams/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tenant_id: tenantId.trim(), client_id: clientId.trim(), client_secret: clientSecret.trim(),
        secret_expires_at: clientSecretExpiresAt || null,
      }),
    });
    const json = await res.json();
    setSaving(false);
    if (!res.ok) {
      setError(json.error || "Failed to save");
      return;
    }
    setTenantId("");
    setClientId("");
    setClientSecret("");
    setClientSecretExpiresAt("");
    setShowForm(false);
    load();
  };

  const confirmConsent = async () => {
    await fetch("/api/teams/credentials", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ admin_consent_granted: true }),
    });
    load();
  };

  const disconnect = async () => {
    if (!confirm("Disconnect Microsoft Teams? Messages already synced will be kept.")) return;
    await fetch("/api/teams/credentials", { method: "DELETE" });
    load();
  };

  const adminConsentUrl = connection
    ? `https://login.microsoftonline.com/${connection.tenant_id}/adminconsent?client_id=${connection.client_id}` +
      `&state=${companyId}&redirect_uri=${encodeURIComponent(CONSENT_CALLBACK_URL)}`
    : null;

  if (loading) {
    return null;
  }

  return (
    <div className="space-y-6">
      <div className="bg-white border border-slate-200 rounded-[32px] p-6">
        <div className="flex items-center justify-between mb-4">
          <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">Microsoft Teams sync</p>
          {!connection && (
            <button onClick={() => setShowForm((v) => !v)} className="p-1.5 text-slate-300 hover:text-indigo-600 transition-colors">
              <Users2 size={14} />
            </button>
          )}
        </div>

        {consentResult === "success" && (
          <p className="flex items-center gap-1.5 text-[11px] text-emerald-700 bg-emerald-50 rounded-2xl px-4 py-2 mb-3">
            <CheckCircle2 size={12} /> Admin consent granted -- Teams sync will start on its next run.
          </p>
        )}
        {consentResult === "error" && (
          <p className="text-[11px] text-red-600 bg-red-50 rounded-2xl px-4 py-2 mb-3">
            Admin consent failed{consentMessage ? `: ${consentMessage}` : ""}. Check that the redirect URI is registered on the app, then try again.
          </p>
        )}

        {!connection && !showForm && (
          <p className="text-[12px] text-slate-400">
            Not connected. Requires an Azure AD app registration with application permissions
            (ChannelMessage.Read.All, Chat.Read.All, Team.ReadBasic.All) and org admin consent --
            reads chats/channels across the whole tenant, not just one user&apos;s.
          </p>
        )}

        {connection && (
          <div className="space-y-2 mb-2">
            <div className="flex items-center gap-3 px-4 py-2.5 bg-slate-50 rounded-2xl">
              <Users2 size={13} className={connection.admin_consent_granted ? "text-emerald-500 shrink-0" : "text-amber-500 shrink-0"} />
              <p className="text-[12px] font-medium text-slate-700 flex-1">
                Tenant {connection.tenant_id}
                {connection.last_synced_at && ` — last synced ${new Date(connection.last_synced_at).toLocaleString()}`}
              </p>
              <button onClick={disconnect} className="p-1 text-slate-300 hover:text-red-500 transition-colors">
                <Trash2 size={12} />
              </button>
            </div>

            {connection.last_sync_error && (
              <p className="text-[11px] text-red-500 px-4">{connection.last_sync_error}</p>
            )}

            {connection.secret_expires_at && (
              <p className={`text-[11px] px-4 ${
                new Date(connection.secret_expires_at).getTime() < Date.now() + 30 * 24 * 60 * 60 * 1000
                  ? "text-amber-600 font-bold" : "text-slate-400"
              }`}>
                Client secret expires {new Date(connection.secret_expires_at).toLocaleDateString()}
              </p>
            )}

            {!connection.admin_consent_granted && (
              <div className="px-4 py-3 bg-amber-50 rounded-2xl space-y-2">
                <p className="text-[12px] text-amber-800">
                  Have your Microsoft 365 admin grant org-wide consent for this app, then confirm below.
                </p>
                <a
                  href={adminConsentUrl!}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-[12px] font-bold text-indigo-600 hover:underline"
                >
                  Grant admin consent <ExternalLink size={12} />
                </a>
                <button
                  onClick={confirmConsent}
                  className="flex items-center gap-1.5 px-4 py-1.5 bg-slate-900 text-white text-[11px] font-bold rounded-full hover:bg-slate-800 transition-colors"
                >
                  <CheckCircle2 size={12} /> Consent granted, start syncing
                </button>
              </div>
            )}
          </div>
        )}

        {showForm && !connection && (
          <div className="space-y-3 pt-3 border-t border-slate-100">
            <button
              type="button"
              onClick={() => setHelpOpen(true)}
              className="flex items-center gap-1.5 text-[11px] font-bold text-indigo-600 hover:underline"
            >
              <HelpCircle size={12} /> Where do I find these?
            </button>
            <input
              value={tenantId}
              onChange={(e) => setTenantId(e.target.value)}
              placeholder="Directory (tenant) ID"
              className="w-full px-4 py-2 border border-slate-200 rounded-full text-[12px] outline-none focus:border-indigo-400"
            />
            <input
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="Application (client) ID"
              className="w-full px-4 py-2 border border-slate-200 rounded-full text-[12px] outline-none focus:border-indigo-400"
            />
            <input
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder="Client secret"
              className="w-full px-4 py-2 border border-slate-200 rounded-full text-[12px] outline-none focus:border-indigo-400"
            />
            <div>
              <label className="text-[10px] text-slate-400 block mb-1 ml-1">
                Secret expires on (from Azure AD -- Certificates &amp; secrets)
              </label>
              <input
                type="date"
                value={clientSecretExpiresAt}
                onChange={(e) => setClientSecretExpiresAt(e.target.value)}
                className="w-full px-4 py-2 border border-slate-200 rounded-full text-[12px] outline-none focus:border-indigo-400"
              />
            </div>
            {error && <p className="text-[11px] text-red-500">{error}</p>}
            <div className="flex gap-2">
              <button
                onClick={connect}
                disabled={saving}
                className="px-5 py-2 bg-indigo-600 text-white text-[12px] font-bold rounded-full hover:bg-indigo-700 disabled:opacity-40 transition-colors"
              >
                {saving ? "Saving..." : "Connect"}
              </button>
              <button onClick={() => setShowForm(false)} className="px-4 py-2 text-[12px] text-slate-400 hover:text-slate-700">
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── Teams bot (chat inside Teams) ── */}
      <div className="bg-white border border-slate-200 rounded-[32px] p-6">
        <div className="flex items-center justify-between mb-4">
          <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">Teams bot (chat inside Teams)</p>
          {!botConnection && !botLoading && (
            <button onClick={() => setShowBotForm((v) => !v)} className="p-1.5 text-slate-300 hover:text-indigo-600 transition-colors">
              <Bot size={14} />
            </button>
          )}
        </div>

        {botLoading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 size={16} className="animate-spin text-slate-300" />
          </div>
        ) : (
          <>
            {!botConnection && !showBotForm && (
              <p className="text-[12px] text-slate-400">
                Not connected. This is a separate Azure Bot resource from the sync app above -- lets people
                @mention or DM the assistant directly inside Microsoft Teams, with real conversation memory
                tied to a linked Diract account.
              </p>
            )}

            {botConnection && botConnection.bot_mode === "byo" && (
              <div className="space-y-2 mb-2">
                <div className="flex items-center gap-3 px-4 py-2.5 bg-slate-50 rounded-2xl">
                  <Bot size={13} className={botConnection.enabled ? "text-emerald-500 shrink-0" : "text-slate-400 shrink-0"} />
                  <p className="text-[12px] font-medium text-slate-700 flex-1">
                    Bot App ID {botConnection.bot_app_id} — tenant {botConnection.bot_tenant_id}
                  </p>
                  <button
                    onClick={() => toggleBotEnabled(!botConnection.enabled)}
                    className={`px-3 py-1 text-[10px] font-bold rounded-full transition-colors ${
                      botConnection.enabled ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-500"
                    }`}
                  >
                    {botConnection.enabled ? "Enabled" : "Disabled"}
                  </button>
                  <button onClick={disconnectBot} className="p-1 text-slate-300 hover:text-red-500 transition-colors">
                    <Trash2 size={12} />
                  </button>
                </div>
                {botConnection.secret_expires_at && (
                  <p className={`text-[11px] px-4 ${
                    new Date(botConnection.secret_expires_at).getTime() < Date.now() + 30 * 24 * 60 * 60 * 1000
                      ? "text-amber-600 font-bold" : "text-slate-400"
                  }`}>
                    Bot secret expires {new Date(botConnection.secret_expires_at).toLocaleDateString()}
                  </p>
                )}
              </div>
            )}

            {botConnection && botConnection.bot_mode === "shared" && (
              <div className="space-y-2 mb-2">
                <div className="flex items-center gap-3 px-4 py-2.5 bg-slate-50 rounded-2xl">
                  <Bot size={13} className={botConnection.enabled ? "text-emerald-500 shrink-0" : "text-slate-400 shrink-0"} />
                  <p className="text-[12px] font-medium text-slate-700 flex-1">
                    Using Diract&apos;s shared bot — tenant {botConnection.teams_tenant_id}
                  </p>
                  <button
                    onClick={() => toggleBotEnabled(!botConnection.enabled)}
                    className={`px-3 py-1 text-[10px] font-bold rounded-full transition-colors ${
                      botConnection.enabled ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-500"
                    }`}
                  >
                    {botConnection.enabled ? "Enabled" : "Disabled"}
                  </button>
                  <button onClick={disconnectBot} className="p-1 text-slate-300 hover:text-red-500 transition-colors">
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            )}

            {showBotForm && !botConnection && (
              <div className="flex gap-2 pt-3 border-t border-slate-100">
                {(["byo", "shared"] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setBotFormMode(m)}
                    className={`px-4 py-1.5 text-[11px] font-bold rounded-full transition-colors ${
                      botFormMode === m ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-500"
                    }`}
                  >
                    {m === "byo" ? "Bring your own Azure Bot" : "Use Diract's shared bot"}
                  </button>
                ))}
              </div>
            )}

            {((showBotForm && botFormMode === "byo") || botConnection?.bot_mode === "byo") && (
              <div className="space-y-3 pt-3">
                <div className="px-4 py-3 bg-slate-50 rounded-2xl">
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wide mb-1.5">
                    Messaging endpoint — paste into the Azure Bot resource&apos;s Configuration page
                  </p>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 text-[11px] text-slate-600 truncate">{messagingEndpointUrl}</code>
                    <button onClick={copyEndpoint} className="p-1 text-slate-400 hover:text-indigo-600 transition-colors shrink-0">
                      {copied ? <Check size={13} /> : <Copy size={13} />}
                    </button>
                  </div>
                </div>

                {!botConnection && (
                  <>
                    <button
                      type="button"
                      onClick={() => setBotHelpOpen(true)}
                      className="flex items-center gap-1.5 text-[11px] font-bold text-indigo-600 hover:underline"
                    >
                      <HelpCircle size={12} /> Where do I find these?
                    </button>
                    <input
                      value={botAppId}
                      onChange={(e) => setBotAppId(e.target.value)}
                      placeholder="Bot Application (client) ID"
                      className="w-full px-4 py-2 border border-slate-200 rounded-full text-[12px] outline-none focus:border-indigo-400"
                    />
                    <input
                      value={botTenantId}
                      onChange={(e) => setBotTenantId(e.target.value)}
                      placeholder="Bot App Tenant ID"
                      className="w-full px-4 py-2 border border-slate-200 rounded-full text-[12px] outline-none focus:border-indigo-400"
                    />
                    <input
                      type="password"
                      value={botAppPassword}
                      onChange={(e) => setBotAppPassword(e.target.value)}
                      placeholder="Bot client secret"
                      className="w-full px-4 py-2 border border-slate-200 rounded-full text-[12px] outline-none focus:border-indigo-400"
                    />
                    <div>
                      <label className="text-[10px] text-slate-400 block mb-1 ml-1">
                        Secret expires on (from Azure AD -- Certificates &amp; secrets)
                      </label>
                      <input
                        type="date"
                        value={botSecretExpiresAt}
                        onChange={(e) => setBotSecretExpiresAt(e.target.value)}
                        className="w-full px-4 py-2 border border-slate-200 rounded-full text-[12px] outline-none focus:border-indigo-400"
                      />
                    </div>
                    {botError && <p className="text-[11px] text-red-500">{botError}</p>}
                    <div className="flex gap-2">
                      <button
                        onClick={connectBot}
                        disabled={botSaving}
                        className="px-5 py-2 bg-indigo-600 text-white text-[12px] font-bold rounded-full hover:bg-indigo-700 disabled:opacity-40 transition-colors"
                      >
                        {botSaving ? "Saving..." : "Connect"}
                      </button>
                      <button onClick={() => setShowBotForm(false)} className="px-4 py-2 text-[12px] text-slate-400 hover:text-slate-700">
                        Cancel
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}

            {showBotForm && !botConnection && botFormMode === "shared" && (
              <div className="space-y-3 pt-3">
                <div className="px-4 py-3 bg-slate-50 rounded-2xl">
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wide mb-1.5">Shared messaging endpoint</p>
                  <code className="text-[11px] text-slate-600">{sharedMessagingEndpointUrl}</code>
                  <p className="text-[11px] text-slate-400 mt-1">
                    Already configured on Diract&apos;s side -- nothing to paste anywhere for this, shown for reference only.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setSharedBotHelpOpen(true)}
                  className="flex items-center gap-1.5 text-[11px] font-bold text-indigo-600 hover:underline"
                >
                  <HelpCircle size={12} /> How do I set this up?
                </button>
                <input
                  value={sharedTenantId}
                  onChange={(e) => setSharedTenantId(e.target.value)}
                  placeholder="Your Microsoft 365 Tenant ID"
                  className="w-full px-4 py-2 border border-slate-200 rounded-full text-[12px] outline-none focus:border-indigo-400"
                />
                {botError && <p className="text-[11px] text-red-500">{botError}</p>}
                <div className="flex gap-2">
                  <button
                    onClick={connectSharedBot}
                    disabled={botSaving}
                    className="px-5 py-2 bg-indigo-600 text-white text-[12px] font-bold rounded-full hover:bg-indigo-700 disabled:opacity-40 transition-colors"
                  >
                    {botSaving ? "Saving..." : "Connect"}
                  </button>
                  <button onClick={() => setShowBotForm(false)} className="px-4 py-2 text-[12px] text-slate-400 hover:text-slate-700">
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {botConnection && (
        <div className="bg-white border border-slate-200 rounded-[32px] p-6">
          <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-2">Bot action fields</p>
          <p className="text-[12px] text-slate-400 mb-4">
            Choose which fields the bot must ask about before creating a task or project, and what to fill in silently
            when a field is left out (used as-is unless the user says otherwise).
          </p>
          <div className="flex gap-2 mb-4">
            {(["create_project", "create_task"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setActionFieldsTab(t)}
                className={`px-4 py-1.5 text-[11px] font-bold rounded-full transition-colors ${
                  actionFieldsTab === t ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-500"
                }`}
              >
                {t === "create_project" ? "Create Project" : "Create Task"}
              </button>
            ))}
          </div>

          {actionFieldsLoading ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 size={16} className="animate-spin text-slate-300" />
            </div>
          ) : (
            <div className="space-y-2">
              {actionFields.map((field) => (
                <div key={field.key} className="flex items-center gap-3 px-4 py-2.5 bg-slate-50 rounded-2xl">
                  <div className="flex-1 min-w-0">
                    <p className="text-[12px] font-medium text-slate-700 flex items-center gap-1.5">
                      {field.label}
                      {field.isCustom && (
                        <span className="text-[9px] font-bold text-violet-400 uppercase tracking-wide">Custom</span>
                      )}
                    </p>
                    {!field.alwaysRequired && (
                      <input
                        defaultValue={field.defaultValue ?? ""}
                        onBlur={(e) => updateActionField(field, { default_value: e.target.value || null })}
                        placeholder="Default value (used if left out)"
                        className="mt-1.5 w-full bg-white border border-slate-200 rounded-full py-1.5 px-3 text-[11px] outline-none focus:border-indigo-400"
                      />
                    )}
                  </div>
                  {field.alwaysRequired ? (
                    <span className="px-3 py-1 text-[10px] font-bold rounded-full bg-slate-200 text-slate-500 shrink-0">
                      Always required
                    </span>
                  ) : (
                    <button
                      onClick={() => {
                        const required = !field.required;
                        setActionFields((prev) => prev.map((f) => (f.key === field.key ? { ...f, required } : f)));
                        updateActionField(field, { required });
                      }}
                      className={`px-3 py-1 text-[10px] font-bold rounded-full transition-colors shrink-0 ${
                        field.required ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-500"
                      }`}
                    >
                      {field.required ? "Required" : "Optional"}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {botConnection && (
        <div className="bg-white border border-slate-200 rounded-[32px] p-6">
          <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-2">Bot behavior</p>

          <div className="flex items-center gap-3 px-4 py-2.5 bg-slate-50 rounded-2xl mb-4">
            <p className="text-[12px] font-medium text-slate-700 flex-1">
              Require unique task names within a project
            </p>
            <button
              onClick={() => toggleRequireUniqueTaskNames(!requireUniqueTaskNames)}
              className={`px-3 py-1 text-[10px] font-bold rounded-full transition-colors shrink-0 ${
                requireUniqueTaskNames ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-500"
              }`}
            >
              {requireUniqueTaskNames ? "On" : "Off"}
            </button>
          </div>

          <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-2">Project search fields</p>
          <p className="text-[12px] text-slate-400 mb-4">
            Beyond a project&apos;s name, which custom fields can also be used to find it (e.g. a matter number)?
          </p>
          {projectSearchFieldsLoading ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 size={16} className="animate-spin text-slate-300" />
            </div>
          ) : projectSearchFields.length === 0 ? (
            <p className="text-[12px] text-slate-400">No custom fields on Projects yet.</p>
          ) : (
            <div className="space-y-2">
              {projectSearchFields.map((field) => (
                <div key={field.id} className="flex items-center gap-3 px-4 py-2.5 bg-slate-50 rounded-2xl">
                  <p className="text-[12px] font-medium text-slate-700 flex-1">{field.label}</p>
                  <button
                    onClick={() => toggleProjectSearchField(field)}
                    className={`px-3 py-1 text-[10px] font-bold rounded-full transition-colors shrink-0 ${
                      field.enabled ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-500"
                    }`}
                  >
                    {field.enabled ? "Searchable" : "Not searchable"}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <CredentialsHelpDrawer
        isOpen={helpOpen}
        onClose={() => setHelpOpen(false)}
        title="Finding your Azure AD credentials"
        intro="All three values below come from an Azure AD app registration in the Azure Portal — your company's Microsoft 365 admin will need to complete the last step."
        steps={TEAMS_HELP_STEPS}
      />
      <CredentialsHelpDrawer
        isOpen={botHelpOpen}
        onClose={() => setBotHelpOpen(false)}
        title="Setting up the Teams bot"
        intro="This is a separate Azure resource from the sync app above -- a real Bot Framework bot registration. The last step needs your Microsoft 365 admin."
        steps={BOT_HELP_STEPS}
      />
      <CredentialsHelpDrawer
        isOpen={sharedBotHelpOpen}
        onClose={() => setSharedBotHelpOpen(false)}
        title="Connecting to Diract's shared bot"
        intro="No Azure Bot resource, app registration, or client secret needed on your end -- just your organization's Tenant ID and a one-time app upload."
        steps={SHARED_BOT_HELP_STEPS}
      />
    </div>
  );
}
