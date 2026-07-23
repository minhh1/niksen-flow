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
import { callHostedModel, callHostedModelWithTools, callSelfHostedModel, type ToolCall } from "@/lib/ai/modelCall";
import { ACTION_TOOLS } from "@/lib/ai/actionTools";
import {
  resolveProjectByName, resolveProfileByName, resolveTaskByName, resolveStatusByLabel,
  createTask, updateTask, createProject, updateProject,
} from "@/lib/ai/actions";
import { costUsd, HOSTED_MODELS } from "@/lib/billing/aiModels";
import { isTokenCapReached } from "@/lib/billing/aiUsageCap";
import { APP_URL } from "@/lib/config";

const CONFIRM_WORDS = new Set(["yes", "y", "confirm", "confirmed", "do it", "go ahead", "yep", "yeah"]);
const CANCEL_WORDS = new Set(["no", "n", "cancel", "nevermind", "never mind", "stop"]);

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

  // A pending create/update-task/project action awaiting yes/no takes
  // priority over everything else -- see supabase/teams_bot_pending_actions.sql.
  // Anything other than a clear confirm/cancel word falls through and is
  // treated as a brand new message instead (the stale pending action is
  // simply discarded rather than left to confuse a later confirmation).
  const { data: pending } = await admin
    .from("teams_bot_pending_actions")
    .select("action_type, params, expires_at")
    .eq("linked_account_id", linked.id)
    .maybeSingle();
  if (pending && new Date(pending.expires_at) > new Date()) {
    const normalized = msg.question.trim().toLowerCase();
    await admin.from("teams_bot_pending_actions").delete().eq("linked_account_id", linked.id);
    if (CONFIRM_WORDS.has(normalized)) {
      let resultText: string;
      try {
        resultText = await executeAction(admin, companyId, linked.user_id, pending.action_type, pending.params);
      } catch (err) {
        resultText = `Sorry, that didn't work: ${err instanceof Error ? err.message : String(err)}`;
      }
      await sendReply(msg.serviceUrl, msg.conversationId, msg.activityId, botToken, resultText);
      return;
    }
    if (CANCEL_WORDS.has(normalized)) {
      await sendReply(msg.serviceUrl, msg.conversationId, msg.activityId, botToken, "Cancelled.");
      return;
    }
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

  // Tool-calling ("act on the app") is hosted-only -- self-hosted Ollama
  // models vary too much in tool-calling reliability to build real data
  // mutations on top of, so self-hosted just skips straight to plain RAG
  // below (same as before this feature existed).
  if (provider === "hosted") {
    let toolResult;
    try {
      toolResult = await callHostedModelWithTools(modelId, modelMessages, ACTION_TOOLS);
    } catch (err) {
      console.error("Teams bot tool-calling call failed, falling back to plain chat:", err);
      toolResult = null;
    }
    if (toolResult) {
      const cost = costUsd(provider, modelId, toolResult);
      await admin.from("ai_usage_events").insert({
        company_id: companyId,
        user_id: linked.user_id,
        model_id: modelId,
        provider,
        input_tokens: toolResult.inputTokens,
        output_tokens: toolResult.outputTokens,
        cost_usd: cost,
      });
      if (toolResult.toolCall) {
        await handleToolCall(admin, companyId, linked, msg, botToken, toolResult.toolCall);
        return;
      }
      // No tool call -- treat the model's own response as the answer and
      // skip the plain-RAG call below (would otherwise ask the model the
      // same question twice).
      await admin.from("ai_messages").insert({ conversation_id: conversationId, role: "assistant", content: toolResult.content, citations });
      const citationLines = citations.length ? "\n\nSources: " + citations.map((c, i) => `[${i + 1}] ${c.sourceType}`).join(", ") : "";
      await sendReply(msg.serviceUrl, msg.conversationId, msg.activityId, botToken, toolResult.content + citationLines);
      return;
    }
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

interface LinkedAccount {
  id: string;
  user_id: string;
  ai_conversation_id: string | null;
}

// Resolves the tool call's human-readable references (project/task/
// assignee/status names) to real IDs, and either asks for clarification
// (zero or multiple matches) or stores a teams_bot_pending_actions row and
// replies with a plain-language confirmation summary -- nothing is written
// to tasks/projects yet, that only happens once the user confirms (see the
// pending-action check earlier in handleMessage).
async function handleToolCall(
  admin: any,
  companyId: string,
  linked: LinkedAccount,
  msg: IncomingMessage,
  botToken: string,
  toolCall: ToolCall
) {
  const reply = (text: string) => sendReply(msg.serviceUrl, msg.conversationId, msg.activityId, botToken, text);
  const args = toolCall.arguments as Record<string, string | boolean | undefined>;

  const askAbout = async (kind: string, result: { status: "ambiguous"; candidates: { name: string }[] } | { status: "not_found" }, name: string) => {
    if (result.status === "not_found") {
      await reply(`I couldn't find a ${kind} matching "${name}" -- can you clarify?`);
    } else {
      await reply(`I found multiple ${kind}s matching "${name}": ${result.candidates.map((c) => c.name).join(", ")}. Which one did you mean?`);
    }
  };

  const storePending = async (actionType: string, params: Record<string, unknown>, summary: string) => {
    await admin.from("teams_bot_pending_actions").upsert(
      { linked_account_id: linked.id, action_type: actionType, params, summary, created_at: new Date().toISOString() },
      { onConflict: "linked_account_id" }
    );
    await reply(`${summary}\n\nReply "yes" to confirm or "no" to cancel.`);
  };

  if (toolCall.name === "create_task") {
    const projectName = args.project_name as string | undefined;
    if (!projectName) return reply("Which project should this task go in?");
    const project = await resolveProjectByName(admin, companyId, projectName);
    if (project.status !== "found") return askAbout("project", project, projectName);

    let assigneeId: string | null = null;
    let assigneeName: string | null = null;
    if (args.assignee_name) {
      const assignee = await resolveProfileByName(admin, companyId, args.assignee_name as string);
      if (assignee.status !== "found") return askAbout("person", assignee, args.assignee_name as string);
      assigneeId = assignee.match.id;
      assigneeName = assignee.match.name;
    }

    const summary =
      `I'll create a task "${args.name}" in project ${project.match.name}` +
      (args.due_date ? `, due ${args.due_date}` : "") +
      (assigneeName ? `, assigned to ${assigneeName}` : "") +
      ".";
    return storePending(
      "create_task",
      { name: args.name, projectId: project.match.id, dueDate: args.due_date ?? null, assigneeId, notes: args.notes ?? null },
      summary
    );
  }

  if (toolCall.name === "update_task") {
    const taskName = args.task_name as string | undefined;
    if (!taskName) return reply("Which task should I update?");
    const task = await resolveTaskByName(admin, companyId, taskName);
    if (task.status !== "found") return askAbout("task", task, taskName);

    let assigneeId: string | null | undefined;
    if (args.assignee_name) {
      const assignee = await resolveProfileByName(admin, companyId, args.assignee_name as string);
      if (assignee.status !== "found") return askAbout("person", assignee, args.assignee_name as string);
      assigneeId = assignee.match.id;
    }
    let statusId: string | null | undefined;
    if (args.status) {
      const status = await resolveStatusByLabel(admin, args.status as string);
      if (status.status !== "found") return askAbout("status", status, args.status as string);
      statusId = status.match.id;
    }

    const changes: string[] = [];
    if (args.new_name) changes.push(`rename to "${args.new_name}"`);
    if (args.due_date) changes.push(`due date to ${args.due_date}`);
    if (assigneeId) changes.push(`assignee to ${args.assignee_name}`);
    if (statusId) changes.push(`status to ${args.status}`);
    if (args.is_completed !== undefined) changes.push(args.is_completed ? "mark complete" : "reopen");
    if (args.notes) changes.push("update notes");
    const summary = `I'll update task "${task.match.name}": ${changes.join(", ") || "no changes recognized"}.`;

    return storePending(
      "update_task",
      {
        taskId: task.match.id,
        name: args.new_name ?? undefined,
        dueDate: args.due_date ?? undefined,
        assigneeId,
        statusId,
        isCompleted: args.is_completed,
        notes: args.notes ?? undefined,
      },
      summary
    );
  }

  if (toolCall.name === "create_project") {
    if (!args.name) return reply("What should the project be called?");
    const summary = `I'll create a project "${args.name}"${args.status ? ` with status ${args.status}` : ""}.`;
    return storePending("create_project", { name: args.name, description: args.description ?? null, status: args.status }, summary);
  }

  if (toolCall.name === "update_project") {
    const projectName = args.project_name as string | undefined;
    if (!projectName) return reply("Which project should I update?");
    const project = await resolveProjectByName(admin, companyId, projectName);
    if (project.status !== "found") return askAbout("project", project, projectName);

    const changes: string[] = [];
    if (args.new_name) changes.push(`rename to "${args.new_name}"`);
    if (args.status) changes.push(`status to ${args.status}`);
    if (args.description) changes.push("update description");
    const summary = `I'll update project "${project.match.name}": ${changes.join(", ") || "no changes recognized"}.`;

    return storePending(
      "update_project",
      { projectId: project.match.id, name: args.new_name ?? undefined, description: args.description ?? undefined, status: args.status },
      summary
    );
  }

  await reply("I didn't understand that request.");
}

// Runs the actual mutation once a pending action has been confirmed. Never
// called with unresolved names -- params were already fully resolved to
// real IDs when the pending action was stored (see handleToolCall above).
async function executeAction(admin: any, companyId: string, userId: string, actionType: string, params: any): Promise<string> {
  if (actionType === "create_task") {
    const task = await createTask(admin, companyId, userId, params);
    return `Done — created task "${task.name}".`;
  }
  if (actionType === "update_task") {
    await updateTask(admin, companyId, userId, params);
    return "Done — updated the task.";
  }
  if (actionType === "create_project") {
    const project = await createProject(admin, companyId, userId, params);
    return `Done — created project "${project.name}".`;
  }
  if (actionType === "update_project") {
    await updateProject(admin, companyId, params);
    return "Done — updated the project.";
  }
  return "Unknown action type.";
}
