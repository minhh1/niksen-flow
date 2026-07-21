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
const TOGETHER_API_KEY = process.env.TOGETHER_API_KEY;

export async function embedQuery(text: string, ollamaUrl: string | null): Promise<number[] | null> {
  if (TOGETHER_API_KEY) {
    const res = await fetch("https://api.together.xyz/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOGETHER_API_KEY}` },
      body: JSON.stringify({ model: "intfloat/multilingual-e5-large-instruct", input: [text] }),
    });
    if (!res.ok) throw new Error(`Together embeddings failed: ${res.status} ${await res.text()}`);
    const json = await res.json();
    return json.data[0]?.embedding ?? null;
  }

  if (ollamaUrl) {
    const res = await fetch(`${ollamaUrl}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "mxbai-embed-large", prompt: text }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json.embedding ?? null;
  }

  return null;
}
