-- Per-company configuration for the AI assistant (see
-- components/admin/AdminAiAssistantTab.tsx and app/dashboard/ai/page.tsx).
-- One row per company, created lazily on first visit to the admin tab.
--
-- self_hosted_ollama_url is BYO per company (like company_cloud_credentials)
-- -- if set, the model picker also offers whatever models that Ollama
-- instance reports live, and ai-embed-worker/app/api/ai/chat fall back to
-- it for embeddings/completions when no platform-hosted provider is
-- configured (see lib/billing/plans.ts for how self-hosted still gets a
-- flat per-token platform fee, same shape as the PAYG VM service fee).
--
-- monthly_token_cap is enforced in app/api/ai/chat/route.ts against the
-- current billing period's sum of ai_usage_events (see ai_usage_events.sql).

CREATE TABLE IF NOT EXISTS ai_chat_settings (
  company_id uuid PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  source_crm boolean NOT NULL DEFAULT true,
  source_gmail boolean NOT NULL DEFAULT true,
  source_whatsapp boolean NOT NULL DEFAULT true,
  source_teams boolean NOT NULL DEFAULT true,
  self_hosted_ollama_url text,
  monthly_token_cap integer NOT NULL DEFAULT 2000000,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE ai_chat_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_chat_settings_company_members ON ai_chat_settings;
CREATE POLICY ai_chat_settings_company_members ON ai_chat_settings
  FOR ALL
  USING (company_id IN (SELECT company_id FROM company_memberships WHERE user_id = auth.uid()))
  WITH CHECK (company_id IN (SELECT company_id FROM company_memberships WHERE user_id = auth.uid()));

-- Nearest-neighbor retrieval scoped to one company and a set of enabled
-- source types, called from app/api/ai/chat/route.ts via .rpc(). Plain
-- PostgREST queries can't express the `<->` operator or a LIMIT on
-- distance ordering, so this is a SQL function instead.
CREATE OR REPLACE FUNCTION match_ai_document_chunks(
  p_company_id uuid,
  p_source_types text[],
  p_query_embedding vector(1024),
  p_match_count int DEFAULT 8
) RETURNS TABLE (
  id uuid,
  source_type text,
  source_id text,
  source_url text,
  content text,
  similarity float
) LANGUAGE sql STABLE AS $$
  SELECT id, source_type, source_id, source_url, content,
         1 - (embedding <=> p_query_embedding) AS similarity
  FROM ai_document_chunks
  WHERE company_id = p_company_id
    AND source_type = ANY(p_source_types)
  ORDER BY embedding <=> p_query_embedding
  LIMIT p_match_count;
$$;
