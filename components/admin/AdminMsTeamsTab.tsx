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
}

interface BotConnection {
  id: string;
  enabled: boolean;
  created_at: string;
  bot_app_id: string;
  bot_tenant_id: string;
}

export default function AdminMsTeamsTab({ companyId }: Props) {
  const searchParams = useSearchParams();
  const [connection, setConnection] = useState<Connection | null>(null);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [tenantId, setTenantId] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);

  const [botConnection, setBotConnection] = useState<BotConnection | null>(null);
  const [botLoading, setBotLoading] = useState(true);
  const [showBotForm, setShowBotForm] = useState(false);
  const [botAppId, setBotAppId] = useState("");
  const [botAppPassword, setBotAppPassword] = useState("");
  const [botTenantId, setBotTenantId] = useState("");
  const [botSaving, setBotSaving] = useState(false);
  const [botError, setBotError] = useState<string | null>(null);
  const [botHelpOpen, setBotHelpOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const consentResult = searchParams.get("msTeamsConsent");
  const consentMessage = searchParams.get("message");
  const messagingEndpointUrl = `${APP_URL}/api/teams/bot/${companyId}`;

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

  useEffect(() => {
    load();
    loadBot();
  }, [load, loadBot]);

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
      body: JSON.stringify({ tenant_id: tenantId.trim(), client_id: clientId.trim(), client_secret: clientSecret.trim() }),
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
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 size={20} className="animate-spin text-slate-300" />
      </div>
    );
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

            {botConnection && (
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
              </div>
            )}

            {(showBotForm || botConnection) && (
              <div className="space-y-3 pt-3 border-t border-slate-100">
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
          </>
        )}
      </div>

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
    </div>
  );
}
