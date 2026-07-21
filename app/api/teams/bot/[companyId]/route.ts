// app/api/teams/bot/[companyId]/route.ts
// Messaging endpoint for the per-company Teams bot (see
// company_teams_bot_credentials.sql) -- this is what gets pasted into the
// Azure Bot resource's "Messaging endpoint" field. Called directly by the
// Bot Framework Connector service (or the Bot Framework Emulator for local
// testing), never by a logged-in Diract user, hence adminClient() rather
// than authorizeCompanyMember().
//
// First-time senders get a magic link to /link-teams instead of an answer
// -- there's no usable link between a Teams identity and a Diract account
// until that's completed (see teams_bot_link_requests.sql). Once linked,
// every message reuses the same ai_conversations thread, sharing the exact
// retrieval/model-calling/billing code paths the web chat uses (see
// lib/ai/retrieval.ts, lib/ai/modelCall.ts, lib/billing/aiUsageCap.ts) so
// behavior and cost never diverges between the two surfaces.
import { NextRequest, NextResponse } from "next/server";
import { adminClient } from "@/lib/documentTemplateAuth";
import { verifyIncomingBotRequest } from "@/lib/msTeamsBot/verifyIncomingToken";
import { getBotToken, sendReply, type BotCredentials } from "@/lib/msTeamsBot/connector";
import { resolveSourceTypes, retrieveGroundingContext, buildSystemPrompt } from "@/lib/ai/retrieval";
import { callHostedModel, callSelfHostedModel } from "@/lib/ai/modelCall";
import { costUsd, HOSTED_MODELS } from "@/lib/billing/aiModels";
import { isTokenCapReached } from "@/lib/billing/aiUsageCap";
import { APP_URL } from "@/lib/config";

// No per-message model picker in Teams (unlike the web chat) -- defaults
// to the same model the web chat UI defaults to on load (models[0]).
const DEFAULT_HOSTED_MODEL_ID = HOSTED_MODELS[0].id;

function randomCode(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

function stripMentionMarkup(text: string): string {
  return text.replace(/<at>.*?<\/at>/g, "").trim();
}

// Same live-discovery GET /api/tags call app/api/ai/models makes for the
// web chat's self-hosted dropdown -- there's no stored "default self-hosted
// model" setting, so this just picks whatever the company's Ollama
// instance reports as available.
async function resolveDefaultSelfHostedModel(ollamaUrl: string): Promise<string | null> {
  try {
    const res = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const json = await res.json();
    return json.models?.[0]?.name ?? null;
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = await params;
  const admin = adminClient();

  const { data: botCreds } = await admin
    .from("company_teams_bot_credentials")
    .select("credentials, enabled")
    .eq("company_id", companyId)
    .maybeSingle();
  if (!botCreds || !botCreds.enabled) {
    return NextResponse.json({ error: "Teams bot not enabled for this company" }, { status: 403 });
  }
  const creds = botCreds.credentials as BotCredentials;

  const activity = await req.json().catch(() => null);
  if (!activity) return NextResponse.json({ error: "Invalid activity" }, { status: 400 });

  const verification = await verifyIncomingBotRequest(req.headers.get("authorization"), creds.bot_app_id, activity.serviceUrl);
  if (!verification.ok) {
    return NextResponse.json({ error: `Unauthorized: ${verification.reason}` }, { status: 403 });
  }

  // Only real user messages need a reply -- conversationUpdate (bot
  // added/removed), typing indicators, reactions, etc. are just acked.
  if (activity.type !== "message" || !activity.text) {
    return NextResponse.json({ ok: true });
  }

  const question = stripMentionMarkup(activity.text);
  const aadObjectId: string | undefined = activity.from?.aadObjectId;
  const tenantId: string | undefined = activity.conversation?.tenantId ?? activity.channelData?.tenant?.id;
  const serviceUrl: string = activity.serviceUrl;
  const conversationId: string = activity.conversation?.id;
  const activityId: string = activity.id;

  if (!aadObjectId || !tenantId || !question) {
    return NextResponse.json({ ok: true });
  }

  // Fire the reply asynchronously from here on -- Bot Framework wants a
  // fast ack, and the actual answer goes back via a separate outbound
  // call to the Connector, not the response body of this request.
  handleMessage(admin, companyId, creds, { aadObjectId, tenantId, serviceUrl, conversationId, activityId, question }).catch(
    (err) => console.error("Teams bot message handling failed:", err)
  );

  return NextResponse.json({ ok: true });
}

interface IncomingMessage {
  aadObjectId: string;
  tenantId: string;
  serviceUrl: string;
  conversationId: string;
  activityId: string;
  question: string;
}

async function handleMessage(admin: any, companyId: string, botCreds: BotCredentials, msg: IncomingMessage) {
  const { data: linked } = await admin
    .from("teams_bot_linked_accounts")
    .select("id, user_id, ai_conversation_id")
    .eq("company_id", companyId)
    .eq("teams_aad_object_id", msg.aadObjectId)
    .maybeSingle();

  const botToken = await getBotToken(botCreds);

  if (!linked) {
    const code = randomCode();
    await admin.from("teams_bot_link_requests").insert({
      code,
      company_id: companyId,
      teams_aad_object_id: msg.aadObjectId,
      teams_conversation_id: msg.conversationId,
      teams_tenant_id: msg.tenantId,
      teams_service_url: msg.serviceUrl,
    });
    const linkUrl = `${APP_URL}/link-teams?code=${code}`;
    await sendReply(
      msg.serviceUrl,
      msg.conversationId,
      msg.activityId,
      botToken,
      `I don't recognize your account yet. Link it to Diract first, then send your question again: ${linkUrl}`
    );
    return;
  }

  const { data: settings } = await admin
    .from("ai_chat_settings")
    .select("source_crm, source_gmail, source_whatsapp, source_teams, self_hosted_ollama_url, monthly_token_cap")
    .eq("company_id", companyId)
    .maybeSingle();

  const tokenCap = settings?.monthly_token_cap ?? 2000000;
  if (await isTokenCapReached(admin, companyId, tokenCap)) {
    await sendReply(
      msg.serviceUrl,
      msg.conversationId,
      msg.activityId,
      botToken,
      "This company's monthly AI token cap has been reached -- ask a company admin to raise it in Admin -> AI Assistant."
    );
    return;
  }

  let conversationId = linked.ai_conversation_id as string | null;
  if (!conversationId) {
    conversationId = crypto.randomUUID();
    await admin.from("ai_conversations").insert({ id: conversationId, company_id: companyId, user_id: linked.user_id });
    await admin.from("teams_bot_linked_accounts").update({ ai_conversation_id: conversationId }).eq("id", linked.id);
  }
  await admin.from("ai_messages").insert({ conversation_id: conversationId, role: "user", content: msg.question });

  const { data: priorMessages } = await admin
    .from("ai_messages")
    .select("role, content")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });
  const history = (priorMessages ?? []).slice(0, -1).map((m: { role: string; content: string }) => ({ role: m.role, content: m.content }));

  const ollamaUrl = settings?.self_hosted_ollama_url ?? null;
  const sourceTypes = resolveSourceTypes(settings);
  const { citations, contextBlock } = await retrieveGroundingContext(admin, companyId, msg.question, sourceTypes, ollamaUrl);
  const systemPrompt = buildSystemPrompt(contextBlock);
  const modelMessages = [{ role: "system", content: systemPrompt }, ...history, { role: "user", content: msg.question }];

  // No per-message model picker in Teams -- hosted defaults to the same
  // model the web chat UI defaults to, self-hosted discovers whatever the
  // company's Ollama actually has live (GET /api/tags, same as
  // app/api/ai/models does for the web chat's dropdown), since there's no
  // stored "default self-hosted model" setting to fall back to.
  const provider: "hosted" | "self_hosted" = ollamaUrl ? "self_hosted" : "hosted";
  let modelId = DEFAULT_HOSTED_MODEL_ID;
  if (provider === "self_hosted") {
    const discovered = await resolveDefaultSelfHostedModel(ollamaUrl!);
    if (!discovered) {
      await sendReply(
        msg.serviceUrl,
        msg.conversationId,
        msg.activityId,
        botToken,
        "No self-hosted model is currently available -- ask a company admin to check the Ollama connection in Admin -> AI Assistant."
      );
      return;
    }
    modelId = discovered;
  }

  let usage;
  try {
    usage =
      provider === "hosted"
        ? await callHostedModel(modelId, modelMessages)
        : await callSelfHostedModel(ollamaUrl!, modelId, modelMessages);
  } catch (err) {
    await sendReply(msg.serviceUrl, msg.conversationId, msg.activityId, botToken, "Sorry, I couldn't get an answer just now -- please try again shortly.");
    console.error("Teams bot model call failed:", err);
    return;
  }

  await admin.from("ai_messages").insert({ conversation_id: conversationId, role: "assistant", content: usage.content, citations });

  const cost = costUsd(provider, modelId, usage);
  await admin.from("ai_usage_events").insert({
    company_id: companyId,
    user_id: linked.user_id,
    model_id: modelId,
    provider,
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cost_usd: cost,
  });

  const citationLines = citations.length
    ? "\n\nSources: " + citations.map((c, i) => `[${i + 1}] ${c.sourceType}`).join(", ")
    : "";
  await sendReply(msg.serviceUrl, msg.conversationId, msg.activityId, botToken, usage.content + citationLines);
}
