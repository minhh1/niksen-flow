// app/api/ai/chat/route.ts
// RAG chat endpoint backing app/dashboard/ai/page.tsx. Retrieval, prompt
// building, and model-calling are shared with the Teams bot (see
// app/api/teams/bot/[companyId]/route.ts) via lib/ai/retrieval.ts and
// lib/ai/modelCall.ts -- this route just adds the streaming response shape
// the web chat UI expects.
//
// Response body is newline-delimited JSON: one `{"citations": [...]}` line
// first, then `{"delta": "..."}` lines as tokens arrive, ending with
// `{"done": true}`.
import { NextRequest } from "next/server";
import { authorizeCompanyMember } from "@/lib/documentTemplateAuth";
import { resolveSourceTypes, retrieveGroundingContext, buildSystemPrompt } from "@/lib/ai/retrieval";
import { callHostedModel, callSelfHostedModel, type TokenUsage } from "@/lib/ai/modelCall";
import { findHostedModel, costUsd } from "@/lib/billing/aiModels";
import { isTokenCapReached } from "@/lib/billing/aiUsageCap";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

function ndjson(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj) + "\n");
}

export async function POST(req: NextRequest) {
  const auth = await authorizeCompanyMember();
  if (auth.error) return auth.error;
  const { admin, companyId, user } = auth;

  const body = await req.json().catch(() => null);
  const question: string | undefined = body?.question;
  const modelId: string | undefined = body?.modelId;
  const provider: "hosted" | "self_hosted" | undefined = body?.provider;
  const history: ChatMessage[] = Array.isArray(body?.history) ? body.history : [];
  const conversationId: string | undefined = body?.conversationId;

  if (!question || !modelId || !provider) {
    return new Response(JSON.stringify({ error: "question, modelId, and provider are required" }), { status: 400 });
  }

  // Persisted so a conversation survives a refresh/reopen (see
  // supabase/ai_conversations.sql, supabase/ai_messages.sql) -- the id is
  // client-generated, so the first message in a new chat creates the
  // conversation row here rather than needing a separate create call.
  //
  // Never blindly upserts company_id/user_id onto an existing row -- a
  // user who belongs to more than one company and switches between them
  // (see components/Sidebar.tsx's handleSwitchCompany) gets a fresh page
  // load, but a stale conversationId reused across that switch (e.g. a
  // replayed/retried request) must not silently reassign an existing
  // conversation from one company to another. Reject instead.
  if (conversationId) {
    const { data: existing } = await admin
      .from("ai_conversations")
      .select("company_id, user_id")
      .eq("id", conversationId)
      .maybeSingle();
    if (existing && (existing.company_id !== companyId || existing.user_id !== user.id)) {
      return new Response(JSON.stringify({ error: "This conversation belongs to a different company or user" }), { status: 403 });
    }
    if (existing) {
      await admin.from("ai_conversations").update({ updated_at: new Date().toISOString() }).eq("id", conversationId);
    } else {
      await admin.from("ai_conversations").insert({ id: conversationId, company_id: companyId, user_id: user.id });
    }
    await admin.from("ai_messages").insert({ conversation_id: conversationId, role: "user", content: question });
  }

  const { data: settings } = await admin
    .from("ai_chat_settings")
    .select("source_crm, source_gmail, source_whatsapp, source_teams, self_hosted_ollama_url, monthly_token_cap")
    .eq("company_id", companyId)
    .maybeSingle();

  const ollamaUrl = settings?.self_hosted_ollama_url ?? null;
  if (provider === "self_hosted" && !ollamaUrl) {
    return new Response(JSON.stringify({ error: "No self-hosted Ollama URL configured for this company" }), { status: 400 });
  }
  if (provider === "hosted" && !findHostedModel(modelId)) {
    return new Response(JSON.stringify({ error: "Unknown hosted model" }), { status: 400 });
  }

  const tokenCap = settings?.monthly_token_cap ?? 2000000;
  if (await isTokenCapReached(admin, companyId, tokenCap)) {
    return new Response(JSON.stringify({ error: "Monthly token cap reached for this company" }), { status: 429 });
  }

  const sourceTypes = resolveSourceTypes(settings);
  const { citations, contextBlock, retrievalError } = await retrieveGroundingContext(
    admin,
    companyId,
    question,
    sourceTypes,
    ollamaUrl
  );

  const systemPrompt = buildSystemPrompt(contextBlock);
  const messages = [{ role: "system", content: systemPrompt }, ...history, { role: "user", content: question }];

  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(ndjson({ citations, retrievalError }));
      let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, content: "" };
      try {
        const onDelta = (delta: string) => controller.enqueue(ndjson({ delta }));
        usage =
          provider === "hosted"
            ? await callHostedModel(modelId, messages, onDelta)
            : await callSelfHostedModel(ollamaUrl!, modelId, messages, onDelta);
      } catch (err) {
        controller.enqueue(ndjson({ error: err instanceof Error ? err.message : String(err) }));
      }

      if (conversationId && usage.content) {
        await admin
          .from("ai_messages")
          .insert({ conversation_id: conversationId, role: "assistant", content: usage.content, citations });
      }

      const cost = costUsd(provider, modelId, usage);
      await admin.from("ai_usage_events").insert({
        company_id: companyId,
        user_id: user.id,
        model_id: modelId,
        provider,
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        cost_usd: cost,
      });

      controller.enqueue(ndjson({ done: true, usage, costUsd: cost }));
      controller.close();
    },
  });

  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson" } });
}
