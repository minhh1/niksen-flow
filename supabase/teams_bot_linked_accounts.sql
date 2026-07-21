-- Maps a Microsoft Teams identity (Azure AD object ID) to a Diract user
-- account, per company, so the Teams bot can attach a real, persisted
-- multi-turn conversation to messages from that person (see
-- app/api/teams/bot/[companyId]/route.ts and app/link-teams/page.tsx for
-- how a row here gets created via the magic-link flow).
--
-- ai_conversation_id is the single ai_conversations thread reused across
-- every message this linked person sends the bot -- lazily created on
-- first linked message, not at link time.

CREATE TABLE IF NOT EXISTS teams_bot_linked_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  teams_aad_object_id text NOT NULL,
  teams_tenant_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  ai_conversation_id uuid REFERENCES ai_conversations(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, teams_aad_object_id)
);

CREATE INDEX IF NOT EXISTS teams_bot_linked_accounts_user_id_idx ON teams_bot_linked_accounts(user_id);

ALTER TABLE teams_bot_linked_accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS teams_bot_linked_accounts_owner ON teams_bot_linked_accounts;
CREATE POLICY teams_bot_linked_accounts_owner ON teams_bot_linked_accounts
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid() AND company_id IN (SELECT company_id FROM company_memberships WHERE user_id = auth.uid()));
