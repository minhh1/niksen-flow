// components/admin/AdminWhatsAppTab.tsx
// Admin-only: connect the company's WhatsApp Business Platform (Meta Cloud
// API) number. There is no per-user OAuth here -- one System User token per
// company, entered directly (see company_whatsapp_credentials.sql). Only
// business-number messages are ever visible this way, never a user's
// personal WhatsApp history.
"use client";

import { useCallback, useEffect, useState } from "react";
import { MessageCircle, Trash2, Copy, Check, HelpCircle, Bot, Users2, Loader2, ExternalLink } from "lucide-react";
import { APP_URL } from "@/lib/config";
import CredentialsHelpDrawer from "./CredentialsHelpDrawer";
import { useProgressBarWhile } from "@/components/TopProgressBar";

// Meta periodically restructures this console (e.g. the old "Add Product ->
// WhatsApp" flow was replaced by a use-case-based flow), so these steps can
// go stale. Last verified against developers.facebook.com/docs/whatsapp/
// cloud-api/get-started on 2026-07-21 -- if a step no longer matches what
// Meta shows, re-check that URL and update this array rather than guessing.
const WHATSAPP_HELP_STEPS = [
  {
    title: "Add the WhatsApp use case to your app",
    description:
      "Open your app in the Meta App Dashboard and click \"Use cases\" in the left sidebar (existing apps created for something else, like Facebook Login, don't have WhatsApp attached automatically). Add \"Connect with customers through WhatsApp\" as a use case, then complete the prompted steps -- choosing or creating a Business Portfolio and confirming publishing requirements. A new \"WhatsApp\" item then appears in the left sidebar.",
    linkLabel: "developers.facebook.com/apps",
    linkUrl: "https://developers.facebook.com/apps",
  },
  {
    title: "Find the phone number ID and business account ID",
    description:
      "Open your app → WhatsApp → API Setup. Once a WhatsApp Business Account is connected, this page shows the WhatsApp Business Account ID and, directly beneath the \"From\" phone number, the Phone number ID.",
  },
  {
    title: "Generate a System User access token",
    description:
      "In Business Settings → System users, add a system user, assign it your app and WhatsApp account with \"Full control\", then generate a token granting business_management, whatsapp_business_messaging, and whatsapp_business_management. Copy it immediately -- Meta only shows it once. Use this System User token, not the short-lived temporary token shown on the API Setup page -- Meta's own docs note that one isn't meant for production use.",
    linkLabel: "business.facebook.com/latest/settings",
    linkUrl: "https://business.facebook.com/latest/settings",
  },
  {
    title: "Make up a webhook verify token",
    description:
      "This one isn't from Meta — pick any random string yourself, paste it into the field below, and paste the same value into your Meta App → WhatsApp → Configuration → Webhooks \"Verify token\" field alongside the webhook URL shown here.",
  },
  {
    title: "Find your App Secret",
    description:
      "In the Meta App Dashboard, go to App settings → Basic. \"App secret\" is shown there (click Show and re-enter your password) — this is used to verify that webhook calls really come from Meta, and is different from the System User token above.",
  },
];

interface Props {
  companyId: string;
}

interface Connection {
  id: string;
  created_at: string;
  updated_at: string;
  phone_number_id: string;
  bot_enabled: boolean;
}

interface WhatsAppGroup {
  id: string;
  group_id: string;
  name: string;
  invite_link: string;
  created_at: string;
}

export default function AdminWhatsAppTab({ companyId }: Props) {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [accessToken, setAccessToken] = useState("");
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [businessAccountId, setBusinessAccountId] = useState("");
  const [webhookVerifyToken, setWebhookVerifyToken] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  const [groups, setGroups] = useState<WhatsAppGroup[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [groupError, setGroupError] = useState<string | null>(null);

  useProgressBarWhile(loading);

  const webhookUrl = `${APP_URL}/api/whatsapp/webhook/${companyId}`;

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/whatsapp/credentials");
    const json = await res.json();
    setConnection(json.connection ?? null);
    setLoading(false);
  }, []);

  const loadGroups = useCallback(async () => {
    setGroupsLoading(true);
    const res = await fetch("/api/whatsapp/groups");
    const json = await res.json();
    setGroups(json.groups ?? []);
    setGroupsLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    if (connection) loadGroups();
  }, [connection, loadGroups]);

  const connect = async () => {
    setError(null);
    if (!accessToken.trim() || !phoneNumberId.trim() || !businessAccountId.trim() || !webhookVerifyToken.trim() || !appSecret.trim()) {
      setError("All fields are required");
      return;
    }
    setSaving(true);
    const res = await fetch("/api/whatsapp/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        access_token: accessToken.trim(),
        phone_number_id: phoneNumberId.trim(),
        business_account_id: businessAccountId.trim(),
        webhook_verify_token: webhookVerifyToken.trim(),
        app_secret: appSecret.trim(),
      }),
    });
    const json = await res.json();
    setSaving(false);
    if (!res.ok) {
      setError(json.error || "Failed to save");
      return;
    }
    setAccessToken("");
    setPhoneNumberId("");
    setBusinessAccountId("");
    setWebhookVerifyToken("");
    setAppSecret("");
    setShowForm(false);
    load();
  };

  const disconnect = async () => {
    if (!confirm("Disconnect WhatsApp? Messages already synced will be kept.")) return;
    await fetch("/api/whatsapp/credentials", { method: "DELETE" });
    load();
  };

  const toggleBotEnabled = async (enabled: boolean) => {
    await fetch("/api/whatsapp/credentials", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bot_enabled: enabled }),
    });
    load();
  };

  const createGroup = async () => {
    setGroupError(null);
    if (!newGroupName.trim()) return;
    setCreatingGroup(true);
    const res = await fetch("/api/whatsapp/groups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newGroupName.trim() }),
    });
    const json = await res.json();
    setCreatingGroup(false);
    if (!res.ok) {
      setGroupError(json.error || "Failed to create group");
      return;
    }
    setNewGroupName("");
    loadGroups();
  };

  const copyWebhookUrl = () => {
    navigator.clipboard.writeText(webhookUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  if (loading) return null;

  return (
    <div className="space-y-6">
      <div className="bg-white border border-slate-200 rounded-[32px] p-6">
        <div className="flex items-center justify-between mb-4">
          <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">WhatsApp Business Platform</p>
          {!connection && (
            <button onClick={() => setShowForm((v) => !v)} className="p-1.5 text-slate-300 hover:text-indigo-600 transition-colors">
              <MessageCircle size={14} />
            </button>
          )}
        </div>

        {connection && (
          <div className="flex items-center gap-3 px-4 py-2.5 bg-slate-50 rounded-2xl mb-2">
            <MessageCircle size={13} className="text-emerald-500 shrink-0" />
            <p className="text-[12px] font-medium text-slate-700 flex-1">
              Connected — phone number ID {connection.phone_number_id}
            </p>
            <button onClick={disconnect} className="p-1 text-slate-300 hover:text-red-500 transition-colors">
              <Trash2 size={12} />
            </button>
          </div>
        )}

        {!connection && !showForm && (
          <p className="text-[12px] text-slate-400">
            Not connected. Requires a Meta Business Platform app with a WhatsApp Business phone number
            and a System User access token — only messages sent to/from that business number are visible here,
            not anyone&apos;s personal WhatsApp history.
          </p>
        )}

        {(showForm || connection) && (
          <div className="space-y-3 pt-3 border-t border-slate-100">
            <div className="px-4 py-3 bg-slate-50 rounded-2xl">
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wide mb-1.5">
                Webhook URL — paste into Meta App → WhatsApp → Configuration
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-[11px] text-slate-600 truncate">{webhookUrl}</code>
                <button onClick={copyWebhookUrl} className="p-1 text-slate-400 hover:text-indigo-600 transition-colors shrink-0">
                  {copied ? <Check size={13} /> : <Copy size={13} />}
                </button>
              </div>
            </div>

            {!connection && (
              <>
                <button
                  type="button"
                  onClick={() => setHelpOpen(true)}
                  className="flex items-center gap-1.5 text-[11px] font-bold text-indigo-600 hover:underline"
                >
                  <HelpCircle size={12} /> Where do I find these?
                </button>
                <input
                  type="password"
                  value={accessToken}
                  onChange={(e) => setAccessToken(e.target.value)}
                  placeholder="System User access token"
                  className="w-full px-4 py-2 border border-slate-200 rounded-full text-[12px] outline-none focus:border-indigo-400"
                />
                <input
                  value={phoneNumberId}
                  onChange={(e) => setPhoneNumberId(e.target.value)}
                  placeholder="Phone number ID"
                  className="w-full px-4 py-2 border border-slate-200 rounded-full text-[12px] outline-none focus:border-indigo-400"
                />
                <input
                  value={businessAccountId}
                  onChange={(e) => setBusinessAccountId(e.target.value)}
                  placeholder="Business account ID"
                  className="w-full px-4 py-2 border border-slate-200 rounded-full text-[12px] outline-none focus:border-indigo-400"
                />
                <input
                  value={webhookVerifyToken}
                  onChange={(e) => setWebhookVerifyToken(e.target.value)}
                  placeholder="Webhook verify token (make one up, paste it in Meta's config too)"
                  className="w-full px-4 py-2 border border-slate-200 rounded-full text-[12px] outline-none focus:border-indigo-400"
                />
                <input
                  type="password"
                  value={appSecret}
                  onChange={(e) => setAppSecret(e.target.value)}
                  placeholder="App secret"
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
              </>
            )}
          </div>
        )}
      </div>

      {connection && (
        <div className="bg-white border border-slate-200 rounded-[32px] p-6">
          <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-4">WhatsApp bot (chat with the assistant)</p>
          <div className="flex items-center gap-3 px-4 py-2.5 bg-slate-50 rounded-2xl">
            <Bot size={13} className={connection.bot_enabled ? "text-emerald-500 shrink-0" : "text-slate-400 shrink-0"} />
            <p className="text-[12px] font-medium text-slate-700 flex-1">
              Let people chat with the AI assistant and create/update tasks and projects over WhatsApp
            </p>
            <button
              onClick={() => toggleBotEnabled(!connection.bot_enabled)}
              className={`px-3 py-1 text-[10px] font-bold rounded-full transition-colors ${
                connection.bot_enabled ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-500"
              }`}
            >
              {connection.bot_enabled ? "Enabled" : "Disabled"}
            </button>
          </div>
        </div>
      )}

      {connection && (
        <div className="bg-white border border-slate-200 rounded-[32px] p-6">
          <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-2">WhatsApp groups</p>
          <p className="text-[12px] text-slate-400 mb-4">
            The business number can&apos;t be added to a group you already have — WhatsApp&apos;s official platform doesn&apos;t
            allow that for any integration. It can create its own new group instead; your team joins via the invite link.
            Requires your WhatsApp Business Account to be an Official Business Account.
          </p>

          {groupsLoading ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 size={16} className="animate-spin text-slate-300" />
            </div>
          ) : (
            <div className="space-y-2 mb-4">
              {groups.map((g) => (
                <div key={g.id} className="flex items-center gap-3 px-4 py-2.5 bg-slate-50 rounded-2xl">
                  <Users2 size={13} className="text-indigo-500 shrink-0" />
                  <p className="text-[12px] font-medium text-slate-700 flex-1">{g.name}</p>
                  <a
                    href={g.invite_link}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-[11px] font-bold text-indigo-600 hover:underline shrink-0"
                  >
                    Invite link <ExternalLink size={11} />
                  </a>
                </div>
              ))}
              {groups.length === 0 && <p className="text-[12px] text-slate-400">No groups created yet.</p>}
            </div>
          )}

          <div className="flex gap-2">
            <input
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              placeholder="New group name (e.g. Diract Assistant Team)"
              className="flex-1 px-4 py-2 border border-slate-200 rounded-full text-[12px] outline-none focus:border-indigo-400"
            />
            <button
              onClick={createGroup}
              disabled={creatingGroup || !newGroupName.trim()}
              className="px-5 py-2 bg-indigo-600 text-white text-[12px] font-bold rounded-full hover:bg-indigo-700 disabled:opacity-40 transition-colors shrink-0"
            >
              {creatingGroup ? "Creating..." : "Create group"}
            </button>
          </div>
          {groupError && <p className="text-[11px] text-red-500 mt-2">{groupError}</p>}
        </div>
      )}

      <CredentialsHelpDrawer
        isOpen={helpOpen}
        onClose={() => setHelpOpen(false)}
        title="Finding your WhatsApp credentials"
        intro="All five values below come from Meta's Business Platform tools, except the verify token, which you make up yourself."
        steps={WHATSAPP_HELP_STEPS}
      />
    </div>
  );
}
