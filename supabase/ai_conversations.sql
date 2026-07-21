-- A conversation thread in the AI assistant (see app/dashboard/ai/page.tsx).
-- Personal, not company-shared -- scoped to the user who started it, same
-- way a normal chat app keeps your history separate from a teammate's,
-- even though the underlying data it's grounded in (ai_document_chunks) is
-- company-wide. id is client-generated (crypto.randomUUID()) so the first
-- chat message can create the row inline via upsert instead of a separate
-- round-trip.
CREATE TABLE IF NOT EXISTS ai_conversations (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_conversations_user_id_idx ON ai_conversations(user_id, updated_at DESC);

ALTER TABLE ai_conversations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_conversations_owner ON ai_conversations;
CREATE POLICY ai_conversations_owner ON ai_conversations
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid() AND company_id IN (SELECT company_id FROM company_memberships WHERE user_id = auth.uid()));
