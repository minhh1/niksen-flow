// lib/msTeamsBot/connector.ts
// Outbound side of the Bot Framework Connector protocol -- getting a bot
// bearer token and sending a reply activity back into the Teams
// conversation the inbound message came from. Verified 2026-07-21 against
// Microsoft's "Authenticate requests with the Bot Connector API" doc:
// plain OAuth2 client-credentials + a REST POST, no SDK needed.
export interface BotCredentials {
  bot_app_id: string;
  bot_app_password: string;
}

export async function getBotToken(creds: BotCredentials): Promise<string> {
  const res = await fetch("https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token", {
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
