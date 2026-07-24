// app/api/teams/bot/shared/route.ts
// Single, company-agnostic messaging endpoint for every company using
// Diract's own shared Teams bot (company_teams_bot_credentials.sql's
// "shared" mode) -- the alternative to each company registering its own
// Azure Bot resource (app/api/teams/bot/[companyId]/route.ts's "byo" mode).
// A company on this path never creates any Azure resource: they just paste
// their Microsoft 365 Tenant ID into Diract's admin UI and sideload the one
// shared Teams app package (same for everyone, referencing this bot's
// fixed App ID) into their own tenant's app catalog.
//
// TEAMS_SHARED_BOT_APP_ID/TEAMS_SHARED_BOT_APP_PASSWORD are this shared
// bot's own Azure AD app registration -- a platform-level secret (like
// DIGITALOCEAN_PLATFORM_API_TOKEN), never stored per company. That app
// registration's "Supported account types" must be set to "Accounts in any
// organizational directory" (multitenant) in Azure so other orgs' tenants
// can use it at all; the Azure Bot resource itself stays "Single Tenant"
// (Microsoft deprecated *creating* new Multi Tenant-type bot resources, but
// a Single Tenant bot resource backed by a multitenant app registration is
// the current supported way to serve many tenants from one bot -- verified
// against Microsoft Q&A 2026-07-24). Because of that, outbound token
// requests must go through the generic /common/ endpoint rather than any
// one tenant's -- passing bot_tenant_id: "common" here reuses
// lib/msTeamsBot/connector.ts's existing getBotToken unchanged, since its
// URL template already just interpolates whatever tenant id it's given,
// and Microsoft's identity platform accepts the literal "common" segment
// there for exactly this purpose.
import { NextRequest, NextResponse, after } from "next/server";
import { adminClient } from "@/lib/documentTemplateAuth";
import { verifyIncomingBotRequest } from "@/lib/msTeamsBot/verifyIncomingToken";
import { getBotToken, sendReply, type BotCredentials } from "@/lib/msTeamsBot/connector";
import { parseIncomingActivity } from "@/lib/msTeamsBot/parseActivity";
import { handleMessage } from "@/lib/msTeamsBot/handleMessage";

function sharedBotCredentials(): BotCredentials {
  const bot_app_id = process.env.TEAMS_SHARED_BOT_APP_ID;
  const bot_app_password = process.env.TEAMS_SHARED_BOT_APP_PASSWORD;
  if (!bot_app_id || !bot_app_password) throw new Error("TEAMS_SHARED_BOT_APP_ID/TEAMS_SHARED_BOT_APP_PASSWORD are not configured.");
  return { bot_app_id, bot_app_password, bot_tenant_id: "common" };
}

export async function POST(req: NextRequest) {
  const admin = adminClient();
  const creds = sharedBotCredentials();

  const activity = await req.json().catch(() => null);
  if (!activity) return NextResponse.json({ error: "Invalid activity" }, { status: 400 });

  const verification = await verifyIncomingBotRequest(req.headers.get("authorization"), creds.bot_app_id, activity.serviceUrl);
  if (!verification.ok) {
    return NextResponse.json({ error: `Unauthorized: ${verification.reason}` }, { status: 403 });
  }

  const msg = parseIncomingActivity(activity);
  if (!msg) return NextResponse.json({ ok: true });

  // There's no URL path segment to carry a companyId here (that's the
  // whole point of a shared endpoint) -- the only thing every inbound
  // activity carries that identifies which Diract company it belongs to is
  // its Microsoft 365 tenant, so that's what a company registers ahead of
  // time via the admin UI.
  const { data: connection } = await admin
    .from("company_teams_bot_credentials")
    .select("company_id")
    .eq("bot_mode", "shared")
    .eq("teams_tenant_id", msg.tenantId)
    .eq("enabled", true)
    .maybeSingle();

  if (!connection) {
    // Unlike an unrecognized *person* (handleMessage's own magic-link
    // path), an unrecognized *tenant* has no company to link into at all --
    // this can still be answered directly since serviceUrl/conversationId/
    // activityId come from the activity itself, not from company config.
    after(async () => {
      try {
        const botToken = await getBotToken(creds);
        await sendReply(
          msg.serviceUrl,
          msg.conversationId,
          msg.activityId,
          botToken,
          "This Microsoft Teams organization isn't connected to a Diract company yet -- ask your Diract admin to enter this tenant's ID under Admin -> Microsoft Teams -> shared bot."
        );
      } catch (err) {
        console.error("Teams shared-bot unrecognized-tenant reply failed:", err);
      }
    });
    return NextResponse.json({ ok: true });
  }

  after(() =>
    handleMessage(admin, connection.company_id, creds, msg).catch((err) => console.error("Teams shared-bot message handling failed:", err))
  );

  return NextResponse.json({ ok: true });
}
