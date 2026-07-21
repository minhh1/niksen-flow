// app/api/ai/chat/route.ts
// RAG chat endpoint backing app/dashboard/ai/page.tsx. Embeds the
// question, retrieves the company's nearest chunks from ai_document_chunks
// (via the match_ai_document_chunks SQL function, see
// supabase/ai_chat_settings.sql), builds a grounded prompt, and streams
// the completion back.
//
// Response body is newline-delimited JSON: one `{"citations": [...]}` line
// first, then `{"delta": "..."}` lines as tokens arrive, ending with
// `{"done": true}`.
import { NextRequest } from "next/server";
import { authorizeCompanyMember } from "@/lib/documentTemplateAuth";
import { embedQuery } from "@/lib/ai/embeddings";
import { findHostedModel } from "@/lib/billing/aiModels";
import { PLATFORM_AI_SERVICE_FEE_USD_PER_1K_TOKENS } from "@/lib/billing/plans";

const TOGETHER_API_KEY = process.env.TOGETHER_API_KEY;

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  content: string;
}

interface MatchedChunk {
  source_type: string;
  source_url: string | null;
  content: string;
}

function ndjson(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj) + "\n");
}

function costUsd(provider: "hosted" | "self_hosted", modelId: string, usage: TokenUsage): number {
  if (provider === "self_hosted") {
    return ((usage.inputTokens + usage.outputTokens) / 1000) * PLATFORM_AI_SERVICE_FEE_USD_PER_1K_TOKENS;
  }
  const model = findHostedModel(modelId);
  if (!model) return 0;
  return (usage.inputTokens / 1000) * model.inputUsdPer1kTokens + (usage.outputTokens / 1000) * model.outputUsdPer1kTokens;
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
  if (conversationId) {
    await admin
      .from("ai_conversations")
      .upsert(
        { id: conversationId, company_id: companyId, user_id: user.id, updated_at: new Date().toISOString() },
        { onConflict: "id", ignoreDuplicates: false }
      );
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
  const periodStart = new Date();
  periodStart.setDate(1);
  periodStart.setHours(0, 0, 0, 0);
  const { data: periodEvents } = await admin
    .from("ai_usage_events")
    .select("input_tokens, output_tokens")
    .eq("company_id", companyId)
    .gte("created_at", periodStart.toISOString());
  const tokensUsed = (periodEvents ?? []).reduce((sum, e) => sum + e.input_tokens + e.output_tokens, 0);
  if (tokensUsed >= tokenCap) {
    return new Response(JSON.stringify({ error: "Monthly token cap reached for this company" }), { status: 429 });
  }

  const sourceTypes = [
    settings?.source_crm !== false && "crm_record",
    settings?.source_gmail !== false && "gmail",
    settings?.source_whatsapp !== false && "whatsapp",
    settings?.source_teams !== false && "teams",
  ].filter(Boolean) as string[];

  let citations: { sourceType: string; sourceUrl: string | null; snippet: string }[] = [];
  let contextBlock = "";
  let retrievalError: string | null = null;

  // Retrieval failures (bad embedding provider config, a dimension
  // mismatch, Together/Ollama being briefly unreachable) shouldn't take
  // down the whole chat request -- degrade to an ungrounded answer instead
  // of a hard failure, but surface the error so it's visible rather than
  // silently wrong.
  if (sourceTypes.length > 0) {
    try {
      const queryEmbedding = await embedQuery(question, ollamaUrl);
      if (queryEmbedding) {
        const { data: matches, error: rpcError } = await admin.rpc("match_ai_document_chunks", {
          p_company_id: companyId,
          p_source_types: sourceTypes,
          p_query_embedding: queryEmbedding,
          p_match_count: 8,
        });
        if (rpcError) throw new Error(rpcError.message);
        citations = (matches ?? []).map((m: MatchedChunk) => ({
          sourceType: m.source_type,
          sourceUrl: m.source_url,
          snippet: m.content.slice(0, 200),
        }));
        contextBlock = (matches ?? [])
          .map((m: MatchedChunk, i: number) => `[${i + 1}] (${m.source_type}) ${m.content}`)
          .join("\n\n");
      }
    } catch (err) {
      retrievalError = err instanceof Error ? err.message : String(err);
      console.error("AI chat retrieval failed, continuing without grounding context:", retrievalError);
    }
  }

  const systemPrompt = contextBlock
    ? `You are an assistant answering questions using the company's own CRM, email, WhatsApp, and Teams data below. Cite sources by their [n] number when you use them. If the answer isn't in the context, say so rather than guessing.\n\nContext:\n${contextBlock}`
    : `You are an assistant for this company. No relevant grounding context was found for this question -- answer generally and note that no company data matched.`;

  const messages = [{ role: "system", content: systemPrompt }, ...history, { role: "user", content: question }];

  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(ndjson({ citations, retrievalError }));
      let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, content: "" };
      try {
        usage =
          provider === "hosted"
            ? await streamHosted(modelId, messages, controller)
            : await streamSelfHosted(ollamaUrl!, modelId, messages, controller);
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

async function streamHosted(modelId: string, messages: unknown[], controller: ReadableStreamDefaultController): Promise<TokenUsage> {
  const res = await fetch("https://api.together.xyz/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOGETHER_API_KEY}` },
    body: JSON.stringify({ model: modelId, messages, stream: true, stream_options: { include_usage: true } }),
  });
  if (!res.ok || !res.body) throw new Error(`Together chat completion failed: ${res.status} ${await res.text()}`);

  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, content: "" };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") return usage;
      const json = JSON.parse(payload);
      const delta = json.choices?.[0]?.delta?.content;
      if (delta) {
        controller.enqueue(ndjson({ delta }));
        usage.content += delta;
      }
      if (json.usage) {
        usage.inputTokens = json.usage.prompt_tokens ?? 0;
        usage.outputTokens = json.usage.completion_tokens ?? 0;
      }
    }
  }
  return usage;
}

async function streamSelfHosted(ollamaUrl: string, modelId: string, messages: unknown[], controller: ReadableStreamDefaultController): Promise<TokenUsage> {
  const res = await fetch(`${ollamaUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: modelId, messages, stream: true }),
  });
  if (!res.ok || !res.body) throw new Error(`Ollama chat completion failed: ${res.status} ${await res.text()}`);

  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, content: "" };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const json = JSON.parse(line);
      const delta = json.message?.content;
      if (delta) {
        controller.enqueue(ndjson({ delta }));
        usage.content += delta;
      }
      if (json.done) {
        usage.inputTokens = json.prompt_eval_count ?? 0;
        usage.outputTokens = json.eval_count ?? 0;
        return usage;
      }
    }
  }
  return usage;
}
