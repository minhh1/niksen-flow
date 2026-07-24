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
import { NextRequest, NextResponse, after } from "next/server";
import { adminClient } from "@/lib/documentTemplateAuth";
import { verifyIncomingBotRequest } from "@/lib/msTeamsBot/verifyIncomingToken";
import { getBotToken, sendReply, type BotCredentials } from "@/lib/msTeamsBot/connector";
import { resolveSourceTypes, retrieveGroundingContext, buildSystemPrompt } from "@/lib/ai/retrieval";
import { callHostedModel, callHostedModelWithTools, callSelfHostedModel, type ToolCall } from "@/lib/ai/modelCall";
import { buildActionTools, buildMissingFieldsTool, translateFieldAnswers, TOOL_USE_GUARDRAILS } from "@/lib/ai/actionTools";
import { loadFieldConfig, type ActionType, type FieldDef } from "@/lib/ai/actionFields";
import { advanceAction } from "@/lib/ai/actionAdvance";
import {
  resolveTaskByName, resolveStatusByLabel, resolveProjectByName, resolveProfileByName,
  createTask, updateTask, createProject, updateProject,
  createOnedriveFile, updateOnedriveFile,
} from "@/lib/ai/actions";
import { advanceFileAction, buildFileMissingFieldsTool, type FileAdvanceResult } from "@/lib/ai/fileActions";
import { costUsd, HOSTED_MODELS } from "@/lib/billing/aiModels";
import { isTokenCapReached } from "@/lib/billing/aiUsageCap";
import { APP_URL } from "@/lib/config";

const CONFIRM_WORDS = new Set(["yes", "y", "confirm", "confirmed", "do it", "go ahead", "yep", "yeah"]);

// Exact-match only -- these are short/ambiguous enough that matching them
// as a substring would false-positive on unrelated answers (e.g. "no" is a
// substring of "Notary", "stop" of "laptop").
const CANCEL_EXACT_WORDS = new Set(["no", "n", "cancel", "nevermind", "never mind", "stop"]);
// Longer, distinctive phrases -- safe to match anywhere in a natural
// sentence. Observed in testing: a real reply like "it's fine, don't
// create, I'll test again tomorrow, good night" isn't equal to any single
// short word, so it fell through and got mistaken for an answer to the
// pending question, and the bot just re-asked it.
const CANCEL_PHRASES = ["don't create", "do not create", "don't bother", "forget it", "not now", "no thanks", "no thank you", "cancel that", "leave it"];

function isCancelMessage(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return CANCEL_EXACT_WORDS.has(normalized) || CANCEL_PHRASES.some((p) => normalized.includes(p));
}

// No per-message model picker in Teams (unlike the web chat) -- defaults
// to the same model the web chat UI defaults to on load (models[0]).
const DEFAULT_HOSTED_MODEL_ID = HOSTED_MODELS[0].id;

// The model has no real-time clock during inference -- without being told
// today's actual date, it can't resolve a relative phrase like "tomorrow"
// or "next Wednesday" into an absolute date at all (observed in testing:
// it correctly said it "couldn't understand the date 'tomorrow'"). Included
// in every tool-calling/extraction call so due_date can be given in natural
// language, not just literal YYYY-MM-DD.
function todayContextMessage() {
  const today = new Date();
  const weekday = today.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  return {
    role: "system",
    content: `Today is ${weekday}, ${today.toISOString().slice(0, 10)} (YYYY-MM-DD). If the user gives a relative date (e.g. "today", "tomorrow", "next Wednesday", "in 3 days"), convert it to an absolute YYYY-MM-DD date yourself before returning it. A bare weekday name with no qualifier (e.g. just "Monday", not "next Monday" or "this Monday") means the closest upcoming occurrence of that weekday -- today itself if today already is that weekday, otherwise the next one ahead, never one in the past.`,
  };
}

function randomCode(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

function stripMentionMarkup(text: string): string {
  return text.replace(/<at>.*?<\/at>/g, "").trim();
}

// Bot Framework activities carry a "mention" entity referencing whoever was
// @mentioned; `mentioned.id` is compared against `recipient.id` (the bot's
// own id as seen in this specific conversation) rather than the literal
// <at> text, since a channel message might @mention a different user/bot
// entirely.
function wasBotMentioned(activity: any): boolean {
  const entities = activity.entities as Array<{ type?: string; mentioned?: { id?: string } }> | undefined;
  return !!entities?.some((e) => e.type === "mention" && e.mentioned?.id === activity.recipient?.id);
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

  // A "like" reaction on the bot's own confirmation message counts as a
  // "yes" -- lets someone confirm a pending create/update without typing a
  // word. `replyToId` on a messageReaction activity identifies exactly
  // which message was reacted to (the Connector API's standard reply
  // property), verified in handleMessage against the prompt_message_id
  // captured when that confirmation was sent -- see sendReply's return
  // value and applyAdvanceResult/applyFileAdvanceResult/storePending below.
  const isLikeReaction = activity.type === "messageReaction" && (activity.reactionsAdded ?? []).some((r: { type?: string }) => r.type === "like" || r.type === "plusOne");
  const reactionTargetId: string | undefined = isLikeReaction ? activity.replyToId : undefined;

  // Only real user messages (or a like-reaction confirm) need a reply --
  // conversationUpdate (bot added/removed), typing indicators, other
  // reaction types, etc. are just acked.
  if (!isLikeReaction && (activity.type !== "message" || !activity.text)) {
    return NextResponse.json({ ok: true });
  }

  // In a group chat or channel, only respond when actually @mentioned --
  // replying to every unrelated message in a team channel would be noisy
  // and wrong. A 1:1 (personal) conversation has no one else to mention it
  // for, so every message there gets a reply. Reactions skip this check --
  // reacting to a specific message is inherently unambiguous about intent.
  const conversationType: string | undefined = activity.conversation?.conversationType;
  if (!isLikeReaction && activity.type === "message" && conversationType !== "personal" && !wasBotMentioned(activity)) {
    return NextResponse.json({ ok: true });
  }

  const question = isLikeReaction ? "\u{1F44D}" : stripMentionMarkup(activity.text);
  const aadObjectId: string | undefined = activity.from?.aadObjectId;
  const tenantId: string | undefined = activity.conversation?.tenantId ?? activity.channelData?.tenant?.id;
  const serviceUrl: string = activity.serviceUrl;
  const conversationId: string = activity.conversation?.id;
  const activityId: string = activity.id;
  // Several people can have their own pending create/update flow going at
  // once in a shared channel/group chat -- everything the bot posts there
  // is visible to everyone with no other indication of who a prompt/result
  // is for, which reads as one shared queue even though the underlying
  // state (teams_bot_pending_actions, keyed by linked_account_id) is
  // already isolated per person. senderName (only needed outside a 1:1,
  // which is unambiguous on its own) is used to prefix the bot's replies --
  // see attribute() below.
  const isGroup = conversationType !== "personal";
  const senderName: string | undefined = activity.from?.name;

  if (!aadObjectId || !tenantId || !question) {
    return NextResponse.json({ ok: true });
  }

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
  after(() =>
    handleMessage(admin, companyId, creds, { aadObjectId, tenantId, serviceUrl, conversationId, activityId, question, reactionTargetId, isGroup, senderName }).catch((err) =>
      console.error("Teams bot message handling failed:", err)
    )
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
  reactionTargetId?: string;
  isGroup: boolean;
  senderName?: string;
}

function attribute(text: string, msg: IncomingMessage): string {
  return msg.isGroup && msg.senderName ? `${msg.senderName}: ${text}` : text;
}

async function handleMessage(admin: any, companyId: string, botCreds: BotCredentials, msg: IncomingMessage) {
  const { data: linked } = await admin
    .from("teams_bot_linked_accounts")
    .select("id, user_id, ai_conversation_id")
    .eq("company_id", companyId)
    .eq("teams_aad_object_id", msg.aadObjectId)
    .maybeSingle();

  const botToken = await getBotToken(botCreds);
  const reply = (text: string) => sendReply(msg.serviceUrl, msg.conversationId, msg.activityId, botToken, attribute(text, msg));

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
    await reply(`I don't recognize your account yet. Link it to Diract first, then send your question again: ${linkUrl}`);
    return;
  }

  // Loaded before the pending-action check (not just before the RAG path
  // further down) because continuing a "collecting" create_file/update_file
  // action needs sourceTypes for the drafting call's grounding context --
  // see lib/ai/fileActions.ts's advanceFileAction.
  const { data: settings } = await admin
    .from("ai_chat_settings")
    .select("source_crm, source_gmail, source_whatsapp, source_teams, source_onedrive, self_hosted_ollama_url, monthly_token_cap")
    .eq("company_id", companyId)
    .maybeSingle();
  const sourceTypes = resolveSourceTypes(settings);

  // A pending create/update-task/project/file action takes priority over
  // everything else -- see supabase/teams_bot_pending_actions.sql. Two
  // sub-states: "collecting" (still gathering required fields for a
  // create_task/create_project/create_file/update_file, see
  // lib/ai/actionAdvance.ts/lib/ai/fileActions.ts) and "confirming" (fully
  // resolved, just needs yes/no). Anything other than a clear confirm/cancel
  // word during "confirming" falls through and is treated as a brand new
  // message instead (the stale pending action is simply discarded rather
  // than left to confuse a later confirmation).
  const { data: pending } = await admin
    .from("teams_bot_pending_actions")
    .select("action_type, params, summary, expires_at, status, collected, next_fields, prompt_message_id")
    .eq("linked_account_id", linked.id)
    .maybeSingle();

  // A "like" reaction only ever means "confirm" -- and only when it's on
  // the exact confirmation message this pending action's prompt_message_id
  // points at (not just any reaction from this person). No match -> ignore
  // silently rather than guessing; there's nothing sensible to fall
  // through to for a reaction (unlike a mistyped text reply).
  if (msg.reactionTargetId) {
    if (pending && pending.status === "confirming" && pending.prompt_message_id === msg.reactionTargetId && new Date(pending.expires_at) > new Date()) {
      await admin.from("teams_bot_pending_actions").delete().eq("linked_account_id", linked.id);
      let resultText: string;
      try {
        resultText = await executeAction(admin, companyId, linked.user_id, pending.action_type, pending.params);
      } catch (err) {
        resultText = `Sorry, that didn't work: ${err instanceof Error ? err.message : String(err)}`;
      }
      await reply(resultText);
    }
    return;
  }

  if (pending && new Date(pending.expires_at) > new Date()) {
    const normalized = msg.question.trim().toLowerCase();
    if (isCancelMessage(msg.question)) {
      await admin.from("teams_bot_pending_actions").delete().eq("linked_account_id", linked.id);
      await reply("Cancelled.");
      return;
    }

    if (pending.status === "collecting") {
      await continueCollecting(admin, companyId, linked, msg, botToken, sourceTypes, pending.action_type, pending.collected ?? {}, pending.next_fields ?? []);
      return;
    }

    // status === "confirming" -- any reply other than yes/no discards the
    // pending row and falls through to be treated as a brand-new message
    // (same as before this phase: don't leave a stale confirmation lying
    // around to confuse a later one).
    await admin.from("teams_bot_pending_actions").delete().eq("linked_account_id", linked.id);
    if (CONFIRM_WORDS.has(normalized)) {
      let resultText: string;
      try {
        resultText = await executeAction(admin, companyId, linked.user_id, pending.action_type, pending.params);
      } catch (err) {
        resultText = `Sorry, that didn't work: ${err instanceof Error ? err.message : String(err)}`;
      }
      await reply(resultText);
      return;
    }
  }

  const tokenCap = settings?.monthly_token_cap ?? 2000000;
  if (await isTokenCapReached(admin, companyId, tokenCap)) {
    await reply("This company's monthly AI token cap has been reached -- ask a company admin to raise it in Admin -> AI Assistant.");
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
      await reply("No self-hosted model is currently available -- ask a company admin to check the Ollama connection in Admin -> AI Assistant.");
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
      // A separate system message, appended only for this call -- the
      // plain RAG path (modelMessages as built above) has no tools to
      // misuse, so it doesn't need this and stays as-is.
      const toolCallMessages = [
        modelMessages[0],
        { role: "system", content: TOOL_USE_GUARDRAILS },
        todayContextMessage(),
        ...modelMessages.slice(1),
      ];
      const [taskFields, projectFields] = await Promise.all([
        loadFieldConfig(admin, companyId, "create_task"),
        loadFieldConfig(admin, companyId, "create_project"),
      ]);
      toolResult = await callHostedModelWithTools(modelId, toolCallMessages, buildActionTools(taskFields, projectFields));
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
        await handleToolCall(admin, companyId, linked, msg, botToken, sourceTypes, toolResult.toolCall);
        return;
      }
      // No tool call -- treat the model's own response as the answer and
      // skip the plain-RAG call below (would otherwise ask the model the
      // same question twice).
      await admin.from("ai_messages").insert({ conversation_id: conversationId, role: "assistant", content: toolResult.content, citations });
      const citationLines = citations.length ? "\n\nSources: " + citations.map((c, i) => `[${i + 1}] ${c.sourceType}`).join(", ") : "";
      await reply(toolResult.content + citationLines);
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
    await reply("Sorry, I couldn't get an answer just now -- please try again shortly.");
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
  await reply(usage.content + citationLines);
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
  sourceTypes: string[],
  toolCall: ToolCall
) {
  const reply = (text: string) => sendReply(msg.serviceUrl, msg.conversationId, msg.activityId, botToken, attribute(text, msg));
  const args = toolCall.arguments as Record<string, string | boolean | undefined>;

  const askAbout = async (kind: string, result: { status: "ambiguous"; candidates: { name: string }[] } | { status: "not_found" }, name: string) => {
    if (result.status === "not_found") {
      await reply(`I couldn't find a ${kind} matching "${name}" -- can you clarify?`);
    } else {
      await reply(`I found multiple ${kind}s matching "${name}": ${result.candidates.map((c) => c.name).join(", ")}. Which one did you mean?`);
    }
  };

  // update_task/update_project stay single-shot (resolve + confirm) --
  // Phase G's required-field gathering only applies to creation. Always
  // resets status/collected/next_fields explicitly: Supabase's upsert only
  // overwrites the columns present in the payload, so an update_* upsert
  // that omitted these could otherwise leave a stale "collecting" state
  // from an unrelated abandoned create_task/create_project lingering.
  const storePending = async (actionType: string, params: Record<string, unknown>, summary: string) => {
    // Sent first so the returned activity id can be stored as
    // prompt_message_id -- a later "like" reaction is only honored as a
    // confirm when it targets this exact message (see handleMessage).
    const promptMessageId = await reply(`${summary}\n\nReply "yes" to confirm or "no" to cancel.`);
    await admin.from("teams_bot_pending_actions").upsert(
      {
        linked_account_id: linked.id,
        action_type: actionType,
        status: "confirming",
        params,
        summary,
        collected: null,
        next_fields: null,
        prompt_message_id: promptMessageId,
        created_at: new Date().toISOString(),
      },
      { onConflict: "linked_account_id" }
    );
  };

  if (toolCall.name === "create_task" || toolCall.name === "create_project") {
    // args is keyed by whatever buildActionTools exposed -- built-in
    // properties directly, custom fields by a label slug (see
    // lib/ai/actionTools.ts's propertyKeysForFields) -- translateFieldAnswers
    // maps those back to each field's real .key before storing in "collected".
    const fields = await loadFieldConfig(admin, companyId, toolCall.name);
    const collected = translateFieldAnswers(fields, args);
    return applyAdvanceResult(admin, companyId, linked, msg, botToken, toolCall.name, await advanceAction(admin, companyId, toolCall.name, collected));
  }

  if (toolCall.name === "create_file" || toolCall.name === "update_file") {
    const collected: Record<string, string> = {};
    for (const [key, value] of Object.entries(args)) {
      if (value !== undefined && value !== null && String(value).trim() !== "") collected[key] = String(value);
    }
    const result = await advanceFileAction(admin, companyId, toolCall.name, DEFAULT_HOSTED_MODEL_ID, null, sourceTypes, collected);
    return applyFileAdvanceResult(admin, linked, msg, botToken, toolCall.name, result);
  }

  if (toolCall.name === "update_task") {
    const taskName = args.task_name as string | undefined;
    if (!taskName) return reply("Which task should I update?");

    // A project qualifier (e.g. "task X for project lot 39") scopes the
    // search so the right task is found even when the same task name
    // recurs across projects -- see resolveTaskByName's projectId param.
    let scopeProjectId: string | undefined;
    if (args.project_name) {
      const project = await resolveProjectByName(admin, companyId, args.project_name as string);
      if (project.status !== "found") return askAbout("project", project, args.project_name as string);
      scopeProjectId = project.match.id;
    }

    const task = await resolveTaskByName(admin, companyId, taskName, scopeProjectId);
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
    let moveToProjectId: string | undefined;
    if (args.new_project_name) {
      const newProject = await resolveProjectByName(admin, companyId, args.new_project_name as string);
      if (newProject.status !== "found") return askAbout("project", newProject, args.new_project_name as string);
      moveToProjectId = newProject.match.id;
    }

    const changes: string[] = [];
    if (args.new_name) changes.push(`rename to "${args.new_name}"`);
    if (args.due_date) changes.push(`due date to ${args.due_date}`);
    if (assigneeId) changes.push(`assignee to ${args.assignee_name}`);
    if (statusId) changes.push(`status to ${args.status}`);
    if (moveToProjectId) changes.push(`move to project ${args.new_project_name}`);
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
        projectId: moveToProjectId,
      },
      summary
    );
  }

  if (toolCall.name === "update_project") {
    const projectName = args.project_name as string | undefined;
    if (!projectName) return reply("Which project should I update? (name or matter number)");
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

// Persists an advanceAction result (either "still need these fields,
// asked in one combined message" or "fully resolved, ready to confirm")
// and sends the corresponding reply. Shared by handleToolCall's first pass
// and continueCollecting's follow-up passes below -- one place that knows
// how a lib/ai/actionAdvance.ts result maps onto teams_bot_pending_actions.
async function applyAdvanceResult(
  admin: any,
  companyId: string,
  linked: LinkedAccount,
  msg: IncomingMessage,
  botToken: string,
  actionType: string,
  result: Awaited<ReturnType<typeof advanceAction>>
) {
  const reply = (text: string) => sendReply(msg.serviceUrl, msg.conversationId, msg.activityId, botToken, attribute(text, msg));
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  if (result.status === "collecting") {
    await admin.from("teams_bot_pending_actions").upsert(
      {
        linked_account_id: linked.id,
        action_type: actionType,
        status: "collecting",
        collected: result.collected,
        next_fields: result.missingFields,
        params: null,
        summary: null,
        prompt_message_id: null,
        expires_at: expiresAt,
      },
      { onConflict: "linked_account_id" }
    );
    return reply(result.question);
  }

  const promptMessageId = await reply(`${result.summary}\n\nReply "yes" to confirm or "no" to cancel.`);
  await admin.from("teams_bot_pending_actions").upsert(
    {
      linked_account_id: linked.id,
      action_type: actionType,
      status: "confirming",
      params: result.params,
      summary: result.summary,
      collected: null,
      next_fields: null,
      prompt_message_id: promptMessageId,
      expires_at: expiresAt,
    },
    { onConflict: "linked_account_id" }
  );
}

// Mirrors applyAdvanceResult exactly, for lib/ai/fileActions.ts's
// FileAdvanceResult shape -- kept separate rather than unioning the two
// result types, since create_task/create_project's params/collected shapes
// and file actions' don't overlap meaningfully.
async function applyFileAdvanceResult(
  admin: any,
  linked: LinkedAccount,
  msg: IncomingMessage,
  botToken: string,
  actionType: string,
  result: FileAdvanceResult
) {
  const reply = (text: string) => sendReply(msg.serviceUrl, msg.conversationId, msg.activityId, botToken, attribute(text, msg));
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  if (result.status === "collecting") {
    await admin.from("teams_bot_pending_actions").upsert(
      { linked_account_id: linked.id, action_type: actionType, status: "collecting", collected: result.collected, next_fields: result.missingFields, params: null, summary: null, prompt_message_id: null, expires_at: expiresAt },
      { onConflict: "linked_account_id" }
    );
    return reply(result.question);
  }

  const promptMessageId = await reply(`${result.summary}\n\nReply "yes" to confirm or "no" to cancel.`);
  await admin.from("teams_bot_pending_actions").upsert(
    { linked_account_id: linked.id, action_type: actionType, status: "confirming", params: result.params, summary: result.summary, collected: null, next_fields: null, prompt_message_id: promptMessageId, expires_at: expiresAt },
    { onConflict: "linked_account_id" }
  );
}

// Handles a reply that arrives while a create_task/create_project is still
// "collecting" (see the pending-action check in handleMessage). Since the
// bot always asks for everything still missing in one combined message,
// the reply might answer several of those fields in free text at once --
// buildMissingFieldsTool + callHostedModelWithTools extracts whichever of
// `pendingFieldKeys` the reply actually addresses (never all of them, and
// never invented), then advanceAction is re-run with the merged answers.
async function continueCollecting(
  admin: any,
  companyId: string,
  linked: LinkedAccount,
  msg: IncomingMessage,
  botToken: string,
  sourceTypes: string[],
  actionType: string,
  collectedSoFar: Record<string, string>,
  pendingFieldKeys: string[]
) {
  if (actionType === "create_file" || actionType === "update_file") {
    let extracted: Record<string, unknown> = {};
    try {
      const extraction = await callHostedModelWithTools(
        DEFAULT_HOSTED_MODEL_ID,
        [
          { role: "system", content: "Extract only the details the user's message actually answers. Never invent or guess a value for anything it doesn't address." },
          { role: "user", content: msg.question },
        ],
        buildFileMissingFieldsTool(actionType, pendingFieldKeys)
      );
      const cost = costUsd("hosted", DEFAULT_HOSTED_MODEL_ID, extraction);
      await admin.from("ai_usage_events").insert({
        company_id: companyId,
        user_id: linked.user_id,
        model_id: DEFAULT_HOSTED_MODEL_ID,
        provider: "hosted",
        input_tokens: extraction.inputTokens,
        output_tokens: extraction.outputTokens,
        cost_usd: cost,
      });
      if (extraction.toolCall) extracted = extraction.toolCall.arguments;
    } catch (err) {
      console.error("Teams bot file field-extraction call failed:", err);
    }
    const merged = { ...collectedSoFar };
    for (const [key, value] of Object.entries(extracted)) {
      if (value !== undefined && value !== null && String(value).trim() !== "") merged[key] = String(value);
    }
    const result = await advanceFileAction(admin, companyId, actionType, DEFAULT_HOSTED_MODEL_ID, null, sourceTypes, merged);
    await applyFileAdvanceResult(admin, linked, msg, botToken, actionType, result);
    return;
  }

  const fieldsForAction = await loadFieldConfig(admin, companyId, actionType as ActionType);
  const pendingFields: FieldDef[] = fieldsForAction.filter((f) => pendingFieldKeys.includes(f.key));

  let extracted: Record<string, unknown> = {};
  try {
    const extraction = await callHostedModelWithTools(
      DEFAULT_HOSTED_MODEL_ID,
      [
        { role: "system", content: "Extract only the details the user's message actually answers. Never invent or guess a value for anything it doesn't address." },
        todayContextMessage(),
        { role: "user", content: msg.question },
      ],
      buildMissingFieldsTool(pendingFields)
    );
    const cost = costUsd("hosted", DEFAULT_HOSTED_MODEL_ID, extraction);
    await admin.from("ai_usage_events").insert({
      company_id: companyId,
      user_id: linked.user_id,
      model_id: DEFAULT_HOSTED_MODEL_ID,
      provider: "hosted",
      input_tokens: extraction.inputTokens,
      output_tokens: extraction.outputTokens,
      cost_usd: cost,
    });
    if (extraction.toolCall) extracted = extraction.toolCall.arguments;
  } catch (err) {
    console.error("Teams bot field-extraction call failed:", err);
  }

  // extracted is keyed by whatever buildMissingFieldsTool exposed (built-in
  // keys directly, custom fields by a label slug) -- translate back to real
  // field.key before merging, same as the initial tool call's args.
  const merged = { ...collectedSoFar, ...translateFieldAnswers(pendingFields, extracted) };

  await applyAdvanceResult(admin, companyId, linked, msg, botToken, actionType, await advanceAction(admin, companyId, actionType as ActionType, merged));
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
  if (actionType === "create_file") {
    const file = await createOnedriveFile(admin, companyId, params);
    return `Done — created "${file.name}": ${file.webUrl}`;
  }
  if (actionType === "update_file") {
    const file = await updateOnedriveFile(admin, companyId, params.itemId, params.content);
    return `Done — updated the file: ${file.webUrl}`;
  }
  return "Unknown action type.";
}
