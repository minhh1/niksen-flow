// app/api/whatsapp/webhook/[companyId]/route.ts
// Meta calls this URL directly (no polling worker for WhatsApp, unlike
// Gmail/Teams). The webhook is scoped per-company via the URL path -- each
// company's Meta App is configured (by that company's admin, see
// AdminWhatsAppTab) to call its own /api/whatsapp/webhook/{companyId}, so
// GET verification can look up that company's webhook_verify_token without
// needing a single shared platform-wide secret.
//
// Beyond ingestion (unchanged from before), this now also gives the
// assistant the same "chat + act on the app" capability the Teams bot has
// (see app/api/teams/bot/[companyId]/route.ts) when a company has
// bot_enabled -- account linking, RAG chat, and create/update task/project
// via the same channel-agnostic lib/ai/* machinery. WhatsApp's protocol is
// simpler than Bot Framework: no JWT dance, just Meta's X-Hub-Signature-256
// (HMAC-SHA256 of the raw body using the app's App Secret) for inbound
// authenticity, and the stored access_token used directly as the bearer
// token for outbound replies (no token-exchange step).
import { NextRequest, NextResponse, after } from "next/server";
import { adminClient } from "@/lib/documentTemplateAuth";
import { verifyWhatsAppSignature } from "@/lib/whatsappBot/verifySignature";
import { sendWhatsAppReply, type WhatsAppDestination } from "@/lib/whatsappBot/sendMessage";
import { resolveSourceTypes, retrieveGroundingContext, buildSystemPrompt } from "@/lib/ai/retrieval";
import { callHostedModel, callHostedModelWithTools, callSelfHostedModel, type ToolCall } from "@/lib/ai/modelCall";
import { buildActionTools, buildMissingFieldsTool, translateFieldAnswers, TOOL_USE_GUARDRAILS, isConversationalOnly } from "@/lib/ai/actionTools";
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

interface WhatsAppCredentials {
  access_token: string;
  phone_number_id: string;
  business_account_id: string;
  webhook_verify_token: string;
  app_secret?: string;
}

const CONFIRM_WORDS = new Set(["yes", "y", "confirm", "confirmed", "do it", "go ahead", "yep", "yeah"]);
const CANCEL_EXACT_WORDS = new Set(["no", "n", "cancel", "nevermind", "never mind", "stop"]);
const CANCEL_PHRASES = ["don't create", "do not create", "don't bother", "forget it", "not now", "no thanks", "no thank you", "cancel that", "leave it"];

function isCancelMessage(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return CANCEL_EXACT_WORDS.has(normalized) || CANCEL_PHRASES.some((p) => normalized.includes(p));
}

const DEFAULT_HOSTED_MODEL_ID = HOSTED_MODELS[0].id;

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

// Meta's webhook subscription verification handshake -- unchanged.
export async function GET(req: NextRequest, { params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = await params;
  const mode = req.nextUrl.searchParams.get("hub.mode");
  const token = req.nextUrl.searchParams.get("hub.verify_token");
  const challenge = req.nextUrl.searchParams.get("hub.challenge");

  const admin = adminClient();
  const { data: row } = await admin.from("company_whatsapp_credentials").select("credentials").eq("company_id", companyId).maybeSingle();
  const credentials = row?.credentials as WhatsAppCredentials | undefined;

  if (mode === "subscribe" && credentials && token === credentials.webhook_verify_token) {
    return new NextResponse(challenge, { status: 200 });
  }
  return NextResponse.json({ error: "Verification failed" }, { status: 403 });
}

// Inbound message delivery. Meta's payload shape:
// entry[].changes[].value.{metadata.phone_number_id, messages[], contacts[]}
// A group message's `messages[].group_id` field distinguishes it from a
// 1:1 message; `from` is still the individual sender's own number either
// way (confirmed against Meta's Groups API docs, 2026-07-24).
export async function POST(req: NextRequest, { params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = await params;
  const admin = adminClient();

  const { data: row } = await admin.from("company_whatsapp_credentials").select("credentials, bot_enabled").eq("company_id", companyId).maybeSingle();
  const credentials = row?.credentials as WhatsAppCredentials | undefined;
  if (!credentials) {
    return NextResponse.json({ error: "WhatsApp not connected" }, { status: 404 });
  }

  // Must verify against the *raw* bytes -- req.json() would consume the
  // stream without exposing them, so read as text first and parse after.
  const rawBody = await req.text();
  if (!verifyWhatsAppSignature(rawBody, req.headers.get("x-hub-signature-256"), credentials.app_secret ?? "")) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 403 });
  }
  const payload = JSON.parse(rawBody);

  const rows: Record<string, unknown>[] = [];
  const botMessages: { waId: string; messageId: string; text: string; groupId: string | null; contactName: string | null; reactionTargetId?: string }[] = [];
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};
      if (value.metadata?.phone_number_id !== credentials.phone_number_id) continue;

      const contactsByWaId = new Map<string, string>(
        (value.contacts ?? []).map((c: { wa_id: string; profile?: { name?: string } }) => [c.wa_id, c.profile?.name ?? null])
      );

      for (const message of value.messages ?? []) {
        const contactName = contactsByWaId.get(message.from) ?? null;
        rows.push({
          company_id: companyId,
          wa_phone_number_id: credentials.phone_number_id,
          contact_wa_id: message.from,
          contact_name: contactName,
          direction: "inbound",
          message_type: message.type,
          body: message.text?.body ?? null,
          wa_message_id: message.id,
          created_at: new Date(Number(message.timestamp) * 1000).toISOString(),
        });

        if (message.type === "text" && message.text?.body) {
          botMessages.push({ waId: message.from, messageId: message.id, text: message.text.body, groupId: message.group_id ?? null, contactName });
        }
        // A 👍 reaction counts as a lightweight "yes" -- lets someone
        // confirm a pending create/update without typing a word. Verified
        // strictly: message.reaction.message_id is carried through as
        // reactionTargetId and only treated as a confirm if it matches the
        // prompt_message_id we actually stored for that pending action (see
        // handleMessage) -- a reaction on some unrelated older message is
        // ignored rather than blindly confirming whatever's pending. Matches
        // the base thumbs-up regardless of skin-tone modifier.
        if (message.type === "reaction" && message.reaction?.emoji?.startsWith("\u{1F44D}") && message.reaction?.message_id) {
          botMessages.push({ waId: message.from, messageId: message.id, text: "\u{1F44D}", groupId: message.group_id ?? null, contactName, reactionTargetId: message.reaction.message_id });
        }
      }
    }
  }

  if (rows.length > 0) {
    // wa_message_id is unique -- ignore duplicates Meta may redeliver.
    await admin.from("whatsapp_messages").upsert(rows, { onConflict: "wa_message_id", ignoreDuplicates: true });
  }

  // Same after()-not-bare-promise reasoning as the Teams bot route: once
  // this response is sent, Vercel can tear the invocation down immediately,
  // silently killing an un-awaited background promise mid-execution.
  if (row?.bot_enabled && botMessages.length > 0) {
    after(async () => {
      for (const m of botMessages) {
        await handleMessage(admin, companyId, credentials, m).catch((err) => console.error("WhatsApp bot message handling failed:", err));
      }
    });
  }

  // Meta requires a fast 200 response regardless of processing outcome,
  // or it will retry (and eventually disable) the webhook.
  return NextResponse.json({ received: true });
}

interface IncomingMessage {
  waId: string;
  messageId: string;
  text: string;
  groupId: string | null;
  contactName: string | null;
  reactionTargetId?: string;
}

interface LinkedAccount {
  id: string;
  user_id: string;
  ai_conversation_id: string | null;
}

function destinationFor(msg: IncomingMessage): WhatsAppDestination {
  return msg.groupId ? { type: "group", groupId: msg.groupId } : { type: "individual", waId: msg.waId };
}

// In a shared WhatsApp group, several people can have their own pending
// create/update flow going at once -- everything the bot posts is visible
// to the whole group with no other indication of who a prompt/result is
// for, which reads as one shared queue even though the underlying state
// (whatsapp_bot_pending_actions, keyed by linked_account_id) is already
// isolated per person. Prefixing with the sender's own WhatsApp display
// name (only needed in a group -- a 1:1 chat is unambiguous) makes that
// isolation visible instead of just real.
function attribute(text: string, msg: IncomingMessage): string {
  return msg.groupId && msg.contactName ? `${msg.contactName}: ${text}` : text;
}

async function handleMessage(admin: any, companyId: string, credentials: WhatsAppCredentials, msg: IncomingMessage) {
  const reply = (text: string) => sendWhatsAppReply(credentials, destinationFor(msg), msg.messageId, attribute(text, msg));

  const { data: linked } = await admin
    .from("whatsapp_bot_linked_accounts")
    .select("id, user_id, ai_conversation_id")
    .eq("company_id", companyId)
    .eq("wa_id", msg.waId)
    .maybeSingle();

  if (!linked) {
    const code = randomCode();
    await admin.from("whatsapp_bot_link_requests").insert({ code, company_id: companyId, wa_id: msg.waId });
    const linkUrl = `${APP_URL}/link-whatsapp?code=${code}`;
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

  const { data: pending } = await admin
    .from("whatsapp_bot_pending_actions")
    .select("action_type, params, summary, expires_at, status, collected, next_fields, prompt_message_id")
    .eq("linked_account_id", linked.id)
    .maybeSingle();

  if (msg.reactionTargetId) {
    if (pending && pending.status === "confirming" && pending.prompt_message_id === msg.reactionTargetId && new Date(pending.expires_at) > new Date()) {
      await admin.from("whatsapp_bot_pending_actions").delete().eq("linked_account_id", linked.id);
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
    const normalized = msg.text.trim().toLowerCase();
    if (isCancelMessage(msg.text)) {
      await admin.from("whatsapp_bot_pending_actions").delete().eq("linked_account_id", linked.id);
      await reply("Cancelled.");
      return;
    }

    if (pending.status === "collecting") {
      await continueCollecting(admin, companyId, linked, msg, credentials, sourceTypes, pending.action_type, pending.collected ?? {}, pending.next_fields ?? []);
      return;
    }

    await admin.from("whatsapp_bot_pending_actions").delete().eq("linked_account_id", linked.id);
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
    await admin.from("whatsapp_bot_linked_accounts").update({ ai_conversation_id: conversationId }).eq("id", linked.id);
  }
  await admin.from("ai_messages").insert({ conversation_id: conversationId, role: "user", content: msg.text });

  const { data: priorMessages } = await admin
    .from("ai_messages")
    .select("role, content")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });
  const history = (priorMessages ?? []).slice(0, -1).map((m: { role: string; content: string }) => ({ role: m.role, content: m.content }));

  const ollamaUrl = settings?.self_hosted_ollama_url ?? null;
  const { citations, contextBlock } = await retrieveGroundingContext(admin, companyId, msg.text, sourceTypes, ollamaUrl);
  const systemPrompt = buildSystemPrompt(contextBlock);
  const modelMessages = [{ role: "system", content: systemPrompt }, ...history, { role: "user", content: msg.text }];

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

  // Skipped for a greeting/filler-only message (see isConversationalOnly)
  // regardless of provider -- TOOL_USE_GUARDRAILS already tells the model
  // not to treat a bare "hi" as license to call a tool, but it doesn't
  // reliably honor that once conversation history contains reconstructable
  // field values (see lib/ai/actionTools.ts's header comment), so this is
  // a hard guarantee rather than another prompt-only attempt.
  if (provider === "hosted" && !isConversationalOnly(msg.text)) {
    let toolResult;
    try {
      const toolCallMessages = [modelMessages[0], { role: "system", content: TOOL_USE_GUARDRAILS }, todayContextMessage(), ...modelMessages.slice(1)];
      const [taskFields, projectFields] = await Promise.all([
        loadFieldConfig(admin, companyId, "create_task"),
        loadFieldConfig(admin, companyId, "create_project"),
      ]);
      toolResult = await callHostedModelWithTools(modelId, toolCallMessages, buildActionTools(taskFields, projectFields));
    } catch (err) {
      console.error("WhatsApp bot tool-calling call failed, falling back to plain chat:", err);
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
        await handleToolCall(admin, companyId, linked, msg, credentials, sourceTypes, toolResult.toolCall);
        return;
      }
      await admin.from("ai_messages").insert({ conversation_id: conversationId, role: "assistant", content: toolResult.content, citations });
      const citationLines = citations.length ? "\n\nSources: " + citations.map((c, i) => `[${i + 1}] ${c.sourceType}`).join(", ") : "";
      await reply(toolResult.content + citationLines);
      return;
    }
  }

  let usage;
  try {
    usage = provider === "hosted" ? await callHostedModel(modelId, modelMessages) : await callSelfHostedModel(ollamaUrl!, modelId, modelMessages);
  } catch (err) {
    await reply("Sorry, I couldn't get an answer just now -- please try again shortly.");
    console.error("WhatsApp bot model call failed:", err);
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

  const citationLines = citations.length ? "\n\nSources: " + citations.map((c, i) => `[${i + 1}] ${c.sourceType}`).join(", ") : "";
  await reply(usage.content + citationLines);
}

async function handleToolCall(
  admin: any,
  companyId: string,
  linked: LinkedAccount,
  msg: IncomingMessage,
  credentials: WhatsAppCredentials,
  sourceTypes: string[],
  toolCall: ToolCall
) {
  const reply = (text: string) => sendWhatsAppReply(credentials, destinationFor(msg), msg.messageId, attribute(text, msg));
  const args = toolCall.arguments as Record<string, string | boolean | undefined>;

  const askAbout = async (kind: string, result: { status: "ambiguous"; candidates: { name: string }[] } | { status: "not_found" }, name: string) => {
    if (result.status === "not_found") {
      await reply(`I couldn't find a ${kind} matching "${name}" -- can you clarify?`);
    } else {
      await reply(`I found multiple ${kind}s matching "${name}": ${result.candidates.map((c) => c.name).join(", ")}. Which one did you mean?`);
    }
  };

  const storePending = async (actionType: string, params: Record<string, unknown>, summary: string) => {
    const promptMessageId = await reply(`${summary}\n\nReply "yes" to confirm or "no" to cancel.`);
    await admin.from("whatsapp_bot_pending_actions").upsert(
      { linked_account_id: linked.id, action_type: actionType, status: "confirming", params, summary, collected: null, next_fields: null, prompt_message_id: promptMessageId, created_at: new Date().toISOString() },
      { onConflict: "linked_account_id" }
    );
  };

  if (toolCall.name === "create_task" || toolCall.name === "create_project") {
    const fields = await loadFieldConfig(admin, companyId, toolCall.name);
    const collected = translateFieldAnswers(fields, args);
    return applyAdvanceResult(admin, companyId, linked, msg, credentials, toolCall.name, await advanceAction(admin, companyId, toolCall.name, collected));
  }

  if (toolCall.name === "create_file" || toolCall.name === "update_file") {
    const collected: Record<string, string> = {};
    for (const [key, value] of Object.entries(args)) {
      if (value !== undefined && value !== null && String(value).trim() !== "") collected[key] = String(value);
    }
    const result = await advanceFileAction(admin, companyId, toolCall.name, DEFAULT_HOSTED_MODEL_ID, null, sourceTypes, collected);
    return applyFileAdvanceResult(admin, linked, msg, credentials, toolCall.name, result);
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

    return storePending("update_project", { projectId: project.match.id, name: args.new_name ?? undefined, description: args.description ?? undefined, status: args.status }, summary);
  }

  await reply("I didn't understand that request.");
}

async function applyAdvanceResult(
  admin: any,
  companyId: string,
  linked: LinkedAccount,
  msg: IncomingMessage,
  credentials: WhatsAppCredentials,
  actionType: string,
  result: Awaited<ReturnType<typeof advanceAction>>
) {
  const reply = (text: string) => sendWhatsAppReply(credentials, destinationFor(msg), msg.messageId, attribute(text, msg));
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  if (result.status === "collecting") {
    await admin.from("whatsapp_bot_pending_actions").upsert(
      { linked_account_id: linked.id, action_type: actionType, status: "collecting", collected: result.collected, next_fields: result.missingFields, params: null, summary: null, prompt_message_id: null, expires_at: expiresAt },
      { onConflict: "linked_account_id" }
    );
    return reply(result.question);
  }

  const promptMessageId = await reply(`${result.summary}\n\nReply "yes" to confirm or "no" to cancel.`);
  await admin.from("whatsapp_bot_pending_actions").upsert(
    { linked_account_id: linked.id, action_type: actionType, status: "confirming", params: result.params, summary: result.summary, collected: null, next_fields: null, prompt_message_id: promptMessageId, expires_at: expiresAt },
    { onConflict: "linked_account_id" }
  );
}

// Mirrors applyAdvanceResult, for lib/ai/fileActions.ts's FileAdvanceResult
// shape -- kept separate rather than unioning the two result types, since
// create_task/create_project's params/collected shapes and file actions'
// don't overlap meaningfully.
async function applyFileAdvanceResult(
  admin: any,
  linked: LinkedAccount,
  msg: IncomingMessage,
  credentials: WhatsAppCredentials,
  actionType: string,
  result: FileAdvanceResult
) {
  const reply = (text: string) => sendWhatsAppReply(credentials, destinationFor(msg), msg.messageId, attribute(text, msg));
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  if (result.status === "collecting") {
    await admin.from("whatsapp_bot_pending_actions").upsert(
      { linked_account_id: linked.id, action_type: actionType, status: "collecting", collected: result.collected, next_fields: result.missingFields, params: null, summary: null, prompt_message_id: null, expires_at: expiresAt },
      { onConflict: "linked_account_id" }
    );
    return reply(result.question);
  }

  const promptMessageId = await reply(`${result.summary}\n\nReply "yes" to confirm or "no" to cancel.`);
  await admin.from("whatsapp_bot_pending_actions").upsert(
    { linked_account_id: linked.id, action_type: actionType, status: "confirming", params: result.params, summary: result.summary, collected: null, next_fields: null, prompt_message_id: promptMessageId, expires_at: expiresAt },
    { onConflict: "linked_account_id" }
  );
}

async function continueCollecting(
  admin: any,
  companyId: string,
  linked: LinkedAccount,
  msg: IncomingMessage,
  credentials: WhatsAppCredentials,
  sourceTypes: string[],
  actionType: string,
  collectedSoFar: Record<string, string>,
  pendingFieldKeys: string[]
) {
  const reply = (text: string) => sendWhatsAppReply(credentials, destinationFor(msg), msg.messageId, attribute(text, msg));

  // Same hard guarantee as handleMessage's tool-calling gate -- a generic
  // free-text field (e.g. Notes) gives an extraction model just enough
  // rope to misread pure chit-chat ("i wanna say hi") as an intended
  // answer. Skip the extraction call entirely rather than trust it to
  // decline on its own; nothing changed, so expires_at isn't touched.
  if (isConversationalOnly(msg.text)) {
    await reply("Just checking in? I'm still waiting on a few more details before I create this -- let me know when you're ready.");
    return;
  }

  if (actionType === "create_file" || actionType === "update_file") {
    let extracted: Record<string, unknown> = {};
    let plainReply = "";
    try {
      const extraction = await callHostedModelWithTools(
        DEFAULT_HOSTED_MODEL_ID,
        [
          { role: "system", content: "Extract only the details the user's message actually answers. Never invent or guess a value for anything it doesn't address." },
          { role: "user", content: msg.text },
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
      else plainReply = extraction.content?.trim() ?? "";
    } catch (err) {
      console.error("WhatsApp bot file field-extraction call failed:", err);
    }

    // Nothing was actually answered -- tool_choice is "auto", so the model
    // was free to recognize this message wasn't an attempt to address the
    // pending question(s) and just replied to it directly instead (e.g. a
    // stray "hi are you there" hours later). Surface that reply rather
    // than silently re-asking the identical question with no
    // acknowledgment of what was actually said -- and, since nothing
    // changed, skip applyFileAdvanceResult so its upsert doesn't refresh
    // expires_at and keep an unrelated conversation alive indefinitely.
    if (!Object.keys(extracted).length && plainReply) {
      await reply(plainReply);
      return;
    }

    const merged = { ...collectedSoFar };
    for (const [key, value] of Object.entries(extracted)) {
      if (value !== undefined && value !== null && String(value).trim() !== "") merged[key] = String(value);
    }
    const result = await advanceFileAction(admin, companyId, actionType, DEFAULT_HOSTED_MODEL_ID, null, sourceTypes, merged);
    await applyFileAdvanceResult(admin, linked, msg, credentials, actionType, result);
    return;
  }

  const fieldsForAction = await loadFieldConfig(admin, companyId, actionType as ActionType);
  const pendingFields: FieldDef[] = fieldsForAction.filter((f) => pendingFieldKeys.includes(f.key));

  let extracted: Record<string, unknown> = {};
  let plainReply = "";
  try {
    const extraction = await callHostedModelWithTools(
      DEFAULT_HOSTED_MODEL_ID,
      [
        { role: "system", content: "Extract only the details the user's message actually answers. Never invent or guess a value for anything it doesn't address." },
        todayContextMessage(),
        { role: "user", content: msg.text },
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
    else plainReply = extraction.content?.trim() ?? "";
  } catch (err) {
    console.error("WhatsApp bot field-extraction call failed:", err);
  }

  // Same reasoning as the file-action branch above -- don't discard a real
  // conversational reply the model already produced, and don't refresh
  // expires_at (via applyAdvanceResult) when nothing was actually answered.
  if (!Object.keys(extracted).length && plainReply) {
    await reply(`${plainReply}\n\n(Still need ${pendingFields.map((f) => f.label).join(", ")} to finish creating this -- let me know when you're ready.)`);
    return;
  }

  const merged = { ...collectedSoFar, ...translateFieldAnswers(pendingFields, extracted) };
  await applyAdvanceResult(admin, companyId, linked, msg, credentials, actionType, await advanceAction(admin, companyId, actionType as ActionType, merged));
}

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
