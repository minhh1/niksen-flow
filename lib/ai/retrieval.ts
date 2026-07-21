// lib/ai/retrieval.ts
// Grounding-context retrieval shared by app/api/ai/chat/route.ts (web chat)
// and app/api/teams/bot/[companyId]/route.ts (Teams bot) -- both need the
// exact same embed-question -> nearest-neighbor-per-source-type -> build-
// prompt steps, and duplicating this intricate, easy-to-subtly-diverge
// logic across two routes would be a real maintenance risk.
import { embedQuery } from "@/lib/ai/embeddings";

export interface Citation {
  sourceType: string;
  sourceUrl: string | null;
  snippet: string;
}

interface MatchedChunk {
  source_type: string;
  source_url: string | null;
  content: string;
}

export interface RetrievalResult {
  citations: Citation[];
  contextBlock: string;
  retrievalError: string | null;
}

export function resolveSourceTypes(settings: {
  source_crm?: boolean;
  source_gmail?: boolean;
  source_whatsapp?: boolean;
  source_teams?: boolean;
} | null): string[] {
  return [
    settings?.source_crm !== false && "crm_record",
    settings?.source_gmail !== false && "gmail",
    settings?.source_whatsapp !== false && "whatsapp",
    settings?.source_teams !== false && "teams",
  ].filter(Boolean) as string[];
}

// Retrieval failures (bad embedding provider config, a dimension mismatch,
// Together/Ollama being briefly unreachable) shouldn't take down the whole
// chat request -- degrade to an ungrounded answer instead of a hard
// failure, but surface the error so it's visible rather than silently
// wrong.
export async function retrieveGroundingContext(
  admin: any,
  companyId: string,
  question: string,
  sourceTypes: string[],
  ollamaUrl: string | null
): Promise<RetrievalResult> {
  if (sourceTypes.length === 0) return { citations: [], contextBlock: "", retrievalError: null };

  try {
    const queryEmbedding = await embedQuery(question, ollamaUrl);
    if (!queryEmbedding) return { citations: [], contextBlock: "", retrievalError: null };

    const { data: matches, error: rpcError } = await admin.rpc("match_ai_document_chunks", {
      p_company_id: companyId,
      p_source_types: sourceTypes,
      p_query_embedding: queryEmbedding,
      p_match_count_per_type: 3,
    });
    if (rpcError) throw new Error(rpcError.message);

    const citations = (matches ?? []).map((m: MatchedChunk) => ({
      sourceType: m.source_type,
      sourceUrl: m.source_url,
      snippet: m.content.slice(0, 200),
    }));
    const contextBlock = (matches ?? [])
      .map((m: MatchedChunk, i: number) => `[${i + 1}] (${m.source_type}) ${m.content}`)
      .join("\n\n");
    return { citations, contextBlock, retrievalError: null };
  } catch (err) {
    const retrievalError = err instanceof Error ? err.message : String(err);
    console.error("AI chat retrieval failed, continuing without grounding context:", retrievalError);
    return { citations: [], contextBlock: "", retrievalError };
  }
}

export function buildSystemPrompt(contextBlock: string): string {
  return contextBlock
    ? `You are an assistant answering questions using the company's own CRM, email, WhatsApp, and Teams data below. Cite sources by their [n] number when you use them. If the answer isn't in the context, say so rather than guessing.\n\nContext:\n${contextBlock}`
    : `You are an assistant for this company. No relevant grounding context was found for this question -- answer generally and note that no company data matched.`;
}
