// lib/ai/modelCall.ts
// Calls the hosted (Together) or self-hosted (Ollama) chat completion
// endpoint and accumulates the full response, token usage included.
// Shared by app/api/ai/chat/route.ts (streams each delta to the browser
// via onDelta) and app/api/teams/bot/[companyId]/route.ts (omits onDelta --
// Teams has no use for token-by-token deltas, just the final text).
const TOGETHER_API_KEY = process.env.TOGETHER_API_KEY;

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  content: string;
}

export async function callHostedModel(
  modelId: string,
  messages: unknown[],
  onDelta?: (delta: string) => void
): Promise<TokenUsage> {
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
        onDelta?.(delta);
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

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolCallResult extends TokenUsage {
  toolCall: ToolCall | null;
}

// Non-streaming tool-calling variant, used only by the Teams bot's
// "act on the app" capability (see app/api/teams/bot/[companyId]/route.ts,
// lib/ai/actionTools.ts) -- a tool-call decision isn't meaningfully
// streamed token-by-token, and the bot is already non-streaming. Hosted
// (Together) only: self-hosted Ollama models vary too much in tool-calling
// reliability to build data-mutating actions on top of, so the bot skips
// straight to plain RAG chat (callHostedModel/callSelfHostedModel above)
// for self-hosted companies.
export async function callHostedModelWithTools(
  modelId: string,
  messages: unknown[],
  tools: unknown[]
): Promise<ToolCallResult> {
  const res = await fetch("https://api.together.xyz/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOGETHER_API_KEY}` },
    body: JSON.stringify({ model: modelId, messages, tools, tool_choice: "auto", stream: false }),
  });
  if (!res.ok) throw new Error(`Together tool-calling completion failed: ${res.status} ${await res.text()}`);

  const json = await res.json();
  const message = json.choices?.[0]?.message ?? {};
  const rawToolCall = message.tool_calls?.[0];

  let toolCall: ToolCall | null = null;
  if (rawToolCall?.function?.name) {
    try {
      toolCall = { name: rawToolCall.function.name, arguments: JSON.parse(rawToolCall.function.arguments || "{}") };
    } catch {
      toolCall = null;
    }
  }

  return {
    toolCall,
    content: message.content ?? "",
    inputTokens: json.usage?.prompt_tokens ?? 0,
    outputTokens: json.usage?.completion_tokens ?? 0,
  };
}

export async function callSelfHostedModel(
  ollamaUrl: string,
  modelId: string,
  messages: unknown[],
  onDelta?: (delta: string) => void
): Promise<TokenUsage> {
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
        onDelta?.(delta);
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
