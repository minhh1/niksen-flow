// app/api/teams/bot/[companyId]/route.ts
// Messaging endpoint for a company's own BYO Teams bot (see
// company_teams_bot_credentials.sql's "byo" mode) -- this is what gets
// pasted into that company's own Azure Bot resource's "Messaging endpoint"
// field. Called directly by the Bot Framework Connector service (or the
// Bot Framework Emulator for local testing), never by a logged-in Diract
// user, hence adminClient() rather than authorizeCompanyMember().
//
// The actual bot logic (account linking, RAG chat, create/update
// task/project/file) is channel-agnostic and shared with
// app/api/teams/bot/shared/route.ts -- see lib/msTeamsBot/handleMessage.ts
// and lib/msTeamsBot/parseActivity.ts. This route only owns what's
// different about the BYO path: looking up this specific company's Azure
// Bot credentials by companyId and verifying the inbound JWT against them.
import { NextRequest, NextResponse, after } from "next/server";
import { adminClient } from "@/lib/documentTemplateAuth";
import { verifyIncomingBotRequest } from "@/lib/msTeamsBot/verifyIncomingToken";
import { type BotCredentials } from "@/lib/msTeamsBot/connector";
import { parseIncomingActivity } from "@/lib/msTeamsBot/parseActivity";
import { handleMessage } from "@/lib/msTeamsBot/handleMessage";

export async function POST(req: NextRequest, { params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = await params;
  const admin = adminClient();

  const { data: botCreds } = await admin
    .from("company_teams_bot_credentials")
    .select("credentials, enabled, bot_mode")
    .eq("company_id", companyId)
    .maybeSingle();
  if (!botCreds || !botCreds.enabled || botCreds.bot_mode !== "byo") {
    return NextResponse.json({ error: "Teams bot not enabled for this company" }, { status: 403 });
  }
  const creds = botCreds.credentials as BotCredentials;

  const activity = await req.json().catch(() => null);
  if (!activity) return NextResponse.json({ error: "Invalid activity" }, { status: 400 });

  const verification = await verifyIncomingBotRequest(req.headers.get("authorization"), creds.bot_app_id, activity.serviceUrl);
  if (!verification.ok) {
    return NextResponse.json({ error: `Unauthorized: ${verification.reason}` }, { status: 403 });
  }

  const msg = parseIncomingActivity(activity);
  if (!msg) return NextResponse.json({ ok: true });

  // The reply goes back via a separate outbound call to the Connector, not
  // the response body of this request -- Bot Framework wants a fast ack.
  // Using next/server's after() (not a bare detached promise) matters on
  // Vercel's serverless platform: once this response is sent, the function
  // invocation can be frozen/torn down immediately, silently killing an
  // un-awaited background promise mid-execution. after() (backed by
  // Vercel's waitUntil) keeps the invocation alive until the work actually
  // finishes. An un-awaited handleMessage() call here previously caused
  // exactly that -- inconsistent/slow replies and Bot Framework redelivering
  // the same message when it didn't see a timely-enough response (observed
  // as duplicate teams_bot_link_requests rows for the same identity).
  after(() => handleMessage(admin, companyId, creds, msg).catch((err) => console.error("Teams bot message handling failed:", err)));

  return NextResponse.json({ ok: true });
}
