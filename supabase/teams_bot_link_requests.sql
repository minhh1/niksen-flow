-- Short-lived one-time codes for the Teams-bot account-linking magic link
-- (see app/api/teams/bot/[companyId]/route.ts, which creates a row and
-- messages the link back to an unrecognized Teams sender, and
-- app/api/teams/bot/link/route.ts, which consumes it). Rows are deleted on
-- consumption or once expired -- nothing here is meant to be queried by
-- anything other than the server-side admin client, so RLS is enabled with
-- no policies (locked to the service role only, same as any table no
-- browser client should ever touch directly).

CREATE TABLE IF NOT EXISTS teams_bot_link_requests (
  code text PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  teams_aad_object_id text NOT NULL,
  teams_conversation_id text NOT NULL,
  teams_tenant_id text NOT NULL,
  teams_service_url text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '15 minutes')
);

ALTER TABLE teams_bot_link_requests ENABLE ROW LEVEL SECURITY;
