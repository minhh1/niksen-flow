// lib/ai/embeddings.ts
// Embeds a single piece of text (a user's chat question) for nearest-
// neighbor retrieval against ai_document_chunks. Mirrors the embedding
// logic in supabase/functions/ai-embed-worker/index.ts -- kept as a
// separate copy rather than shared, since Edge Functions (Deno) can't
// import this app's lib/ files. Keep both in sync if the embedding model
// ever changes.
//
// intfloat/multilingual-e5-large-instruct is Together AI's only serverless
// embedding model as of 2026-07-21 (confirmed against
// docs.together.ai/docs/serverless-models -- the earlier BAAI/bge-base-en-v1.5
// wasn't a real Together model at all, which is what caused chat requests
// to fail outright). It outputs 1024-dim vectors, which is why
// ai_document_chunks.embedding is vector(1024).
//
// The self-hosted default (mxbai-embed-large) is NOT independently
// dimension-verified the same way -- if a company's Ollama instance
// produces a different dimension, the pgvector insert/query below will
// throw, which app/api/ai/chat/route.ts now catches and surfaces as a
// clean chat error rather than crashing the request.
//
// Both models are asymmetric retrieval models: the query side needs an
// instruction prefix the document side doesn't (confirmed against each
// model's own card on 2026-07-21 -- e5-instruct's is
// "Instruct: {task}\nQuery: {query}", mxbai-embed-large-v1's is
// "Represent this sentence for searching relevant passages: {query}").
// Embedding the question with no prefix, the same way plain document text
// is embedded in ai-embed-worker, put queries and documents in different
// (and only loosely comparable) regions of the embedding space -- nearest-
// neighbor search still returned *something*, but ranking quality was
// degraded enough that retrieval looked essentially broken (e.g. favoring
// short generic CRM field/value text over content that actually answered
// the question). Documents themselves need no prefix on either model, so
// ai-embed-worker's embedTexts() is unaffected.
const TOGETHER_API_KEY = process.env.TOGETHER_API_KEY;
const TOGETHER_QUERY_INSTRUCTION =
  "Given a question, retrieve relevant passages from the company's CRM records, emails, and chat messages that answer it";

export async function embedQuery(text: string, ollamaUrl: string | null): Promise<number[] | null> {
  if (TOGETHER_API_KEY) {
    const instructedQuery = `Instruct: ${TOGETHER_QUERY_INSTRUCTION}\nQuery: ${text}`;
    const res = await fetch("https://api.together.xyz/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOGETHER_API_KEY}` },
      body: JSON.stringify({ model: "intfloat/multilingual-e5-large-instruct", input: [instructedQuery] }),
    });
    if (!res.ok) throw new Error(`Together embeddings failed: ${res.status} ${await res.text()}`);
    const json = await res.json();
    return json.data[0]?.embedding ?? null;
  }

  if (ollamaUrl) {
    const prefixedQuery = `Represent this sentence for searching relevant passages: ${text}`;
    const res = await fetch(`${ollamaUrl}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "mxbai-embed-large", prompt: prefixedQuery }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json.embedding ?? null;
  }

  return null;
}
