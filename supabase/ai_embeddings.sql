-- Vector store for the RAG assistant (see app/api/ai/chat/route.ts). One
-- row per chunk of source content, embedded so nearest-neighbor search can
-- retrieve grounding context for a question. Populated by the
-- ai-embed-worker Edge Function (see ai_embed_cursors.sql for its
-- incremental-sync cursor).
--
-- source_type spans the four data sources the user asked for:
--   'crm_record' -> a row in properties/entities/projects (source_id = that row's id)
--   'gmail'      -> a gmail_activity_log 'new_email' row (subject + snippet, not full body --
--                   this repo doesn't store full email bodies, they're fetched live from Gmail)
--   'whatsapp'   -> a whatsapp_messages row
--   'teams'      -> a teams_messages row
--
-- source_url is a deep link back into the app so chat answers can cite
-- their source (e.g. /dashboard/projects?id=... ).
--
-- Embedding dimension is fixed at 1024, matching Together AI's only
-- serverless embedding model (intfloat/multilingual-e5-large-instruct,
-- confirmed 2026-07-21 against docs.together.ai/docs/serverless-models --
-- an earlier version of this comment claimed BAAI/bge-base-en-v1.5, which
-- was never a real Together model and caused every chat request to crash).
-- The self-hosted default (mxbai-embed-large, see lib/ai/embeddings.ts) is
-- assumed to also produce 1024-dim vectors, but isn't independently
-- verified the same way -- a mismatched self-hosted model fails the
-- embed/insert cleanly (caught in app/api/ai/chat/route.ts and per-company
-- in ai-embed-worker) rather than corrupting data. If the configured
-- embedding model ever changes dimension, this column and its index must
-- be recreated to match (pgvector requires a fixed size).
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS ai_document_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  source_type text NOT NULL CHECK (source_type IN ('crm_record', 'gmail', 'whatsapp', 'teams')),
  source_id text NOT NULL,
  source_url text,
  content text NOT NULL,
  embedding vector(1024) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, source_type, source_id)
);

CREATE INDEX IF NOT EXISTS ai_document_chunks_company_id_idx ON ai_document_chunks(company_id);
CREATE INDEX IF NOT EXISTS ai_document_chunks_embedding_idx ON ai_document_chunks
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

ALTER TABLE ai_document_chunks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_document_chunks_company_members ON ai_document_chunks;
CREATE POLICY ai_document_chunks_company_members ON ai_document_chunks
  FOR ALL
  USING (company_id IN (SELECT company_id FROM company_memberships WHERE user_id = auth.uid()))
  WITH CHECK (company_id IN (SELECT company_id FROM company_memberships WHERE user_id = auth.uid()));
