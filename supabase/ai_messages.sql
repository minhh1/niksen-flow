-- Persisted turns within an ai_conversations thread (see
-- app/api/ai/chat/route.ts). No dedicated "title" column on
-- ai_conversations -- the conversation list derives a display label from
-- each thread's first user message instead (see app/api/ai/conversations).

CREATE TABLE IF NOT EXISTS ai_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  citations jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_messages_conversation_id_idx ON ai_messages(conversation_id, created_at);

ALTER TABLE ai_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_messages_owner ON ai_messages;
CREATE POLICY ai_messages_owner ON ai_messages
  FOR ALL
  USING (conversation_id IN (SELECT id FROM ai_conversations WHERE user_id = auth.uid()))
  WITH CHECK (conversation_id IN (SELECT id FROM ai_conversations WHERE user_id = auth.uid()));
