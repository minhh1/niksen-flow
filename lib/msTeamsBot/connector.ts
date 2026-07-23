// lib/msTeamsBot/connector.ts
// Outbound side of the Bot Framework Connector protocol -- getting a bot
// bearer token and sending a reply activity back into the Teams
// conversation the inbound message came from.
//
// getBotToken uses the *single-tenant* token endpoint
// (login.microsoftonline.com/{tenant_id}/...) rather than the generic
// multi-tenant botframework.com one -- verified 2026-07-21 against
// Microsoft's "Register a Bot Framework bot with Azure" doc, which states
// multi-tenant bot creation was deprecated after 2025-07-31 (existing
// multi-tenant bots still work, but no new one can be created that way,
// and this integration is new as of 2026). Azure Bot resources created
// today are single-tenant or user-assigned-managed-identity; this only
// supports single-tenant (app ID + password + tenant ID), matching what
// AdminMsTeamsTab.tsx's bot connect form collects.
export interface BotCredentials {
  bot_app_id: string;
  bot_app_password: string;
  bot_tenant_id: string;
}

// Module-level cache, keyed by app ID -- the token is valid for roughly an
// hour (whatever `expires_in` the token endpoint returns), so re-fetching
// it on every single incoming message was a wasted network round trip most
// of the time. Only helps on a warm serverless invocation (reset on cold
// start), but that's the common case for a few-minutes-apart conversation.
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export async function getBotToken(creds: BotCredentials): Promise<string> {
  const cached = tokenCache.get(creds.bot_app_id);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const res = await fetch(`https://login.microsoftonline.com/${creds.bot_tenant_id}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: creds.bot_app_id,
      client_secret: creds.bot_app_password,
      scope: "https://api.botframework.com/.default",
    }),
  });
  if (!res.ok) throw new Error(`Failed to get bot token: ${res.status} ${await res.text()}`);
  const json = await res.json();

  // 5-minute safety margin before actual expiry, same buffer style used
  // elsewhere in this codebase for token refresh (see lib/gmail/client.ts).
  tokenCache.set(creds.bot_app_id, { token: json.access_token, expiresAt: Date.now() + (json.expires_in - 300) * 1000 });
  return json.access_token;
}

// Replies to a specific inbound activity within its conversation --
// {serviceUrl}/v3/conversations/{conversationId}/activities/{activityId}
// per the Bot Connector REST API. serviceUrl and conversationId/activityId
// all come from the inbound Activity the bot is responding to.
export async function sendReply(
  serviceUrl: string,
  conversationId: string,
  activityId: string,
  botToken: string,
  text: string
): Promise<void> {
  const url = `${serviceUrl.replace(/\/$/, "")}/v3/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(activityId)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${botToken}` },
    body: JSON.stringify({ type: "message", text }),
  });
  if (!res.ok) throw new Error(`Failed to send Teams bot reply: ${res.status} ${await res.text()}`);
}
