-- Adds a second way to run the Teams bot (see company_teams_bot_credentials.sql
-- and app/api/teams/bot/[companyId]/route.ts): instead of every company
-- registering its own Azure Bot resource ("byo"), a company can opt to use
-- Diract's own shared, multitenant bot ("shared") -- no Azure resource, app
-- registration, or client secret needed on their end. See
-- app/api/teams/bot/shared/route.ts, the single messaging endpoint every
-- "shared"-mode company's Teams org points at (via a Teams app package
-- sideloaded into their own tenant's app catalog, referencing the shared
-- bot's fixed App ID, kept as platform-level env vars --
-- TEAMS_SHARED_BOT_APP_ID / TEAMS_SHARED_BOT_APP_PASSWORD -- not stored per
-- company like credentials is for "byo").
--
-- teams_tenant_id is how an inbound activity (which carries
-- conversation.tenantId, but no companyId -- there's only one shared
-- messaging endpoint for every company using this mode) is mapped back to
-- the right Diract company; the admin finds their Microsoft 365 Tenant ID
-- in the Entra admin center and pastes it in, no consent flow needed since
-- a pure Bot Framework messaging bot requests no Graph permissions.
ALTER TABLE company_teams_bot_credentials
  ADD COLUMN IF NOT EXISTS bot_mode text NOT NULL DEFAULT 'byo' CHECK (bot_mode IN ('byo', 'shared')),
  ADD COLUMN IF NOT EXISTS teams_tenant_id text;

ALTER TABLE company_teams_bot_credentials ALTER COLUMN credentials DROP NOT NULL;

ALTER TABLE company_teams_bot_credentials DROP CONSTRAINT IF EXISTS company_teams_bot_credentials_mode_shape;
ALTER TABLE company_teams_bot_credentials ADD CONSTRAINT company_teams_bot_credentials_mode_shape CHECK (
  (bot_mode = 'byo' AND credentials IS NOT NULL) OR
  (bot_mode = 'shared' AND teams_tenant_id IS NOT NULL)
);

-- One company per Microsoft 365 tenant on the shared bot -- otherwise an
-- inbound activity's tenantId would resolve ambiguously.
CREATE UNIQUE INDEX IF NOT EXISTS company_teams_bot_credentials_shared_tenant_unique
  ON company_teams_bot_credentials (teams_tenant_id)
  WHERE bot_mode = 'shared';
