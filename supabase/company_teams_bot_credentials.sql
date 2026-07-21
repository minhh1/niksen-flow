-- Bot Framework bot credentials for the "chat with the assistant inside
-- Microsoft Teams" feature (see app/api/teams/bot/[companyId]/route.ts).
-- This is a *separate* Azure resource/App ID from company_teams_credentials
-- (which is a plain Entra app used only for app-only Graph API polling into
-- teams_messages) -- a Bot Framework bot is registered as its own "Azure
-- Bot" resource with its own App ID + password.
--
-- credentials is a jsonb blob:
--   { "bot_app_id": "...", "bot_app_password": "...", "bot_tenant_id": "..." }
-- bot_tenant_id is required -- Microsoft deprecated creating new
-- multi-tenant bots after 2025-07-31 (existing ones still work, but this
-- integration is new as of 2026), so every Azure Bot resource created now
-- is single-tenant (or user-assigned-managed-identity, unsupported here),
-- and single-tenant bot token requests must go through
-- login.microsoftonline.com/{tenant_id}/... , not the generic multi-tenant
-- botframework.com endpoint (see lib/msTeamsBot/connector.ts).
--
-- enabled is the actual "if admin allows it" gate -- the messaging endpoint
-- checks this before doing anything beyond JWT-validating and acking, so a
-- company can have credentials saved but the bot switched off.
--
-- API routes must NEVER select the `credentials` column into a response that
-- reaches the browser (same rule as every other BYO-credentials table).

CREATE TABLE IF NOT EXISTS company_teams_bot_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
  credentials jsonb NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE company_teams_bot_credentials ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS company_teams_bot_credentials_company_members ON company_teams_bot_credentials;
CREATE POLICY company_teams_bot_credentials_company_members ON company_teams_bot_credentials
  FOR ALL
  USING (company_id IN (SELECT company_id FROM company_memberships WHERE user_id = auth.uid()))
  WITH CHECK (company_id IN (SELECT company_id FROM company_memberships WHERE user_id = auth.uid()));
