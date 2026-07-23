-- WhatsApp equivalent of the Teams bot (see supabase/company_teams_bot_credentials.sql,
-- teams_bot_linked_accounts.sql, teams_bot_link_requests.sql,
-- teams_bot_pending_actions.sql, and app/api/teams/bot/[companyId]/route.ts).
-- The "bot brain" (lib/ai/*) is entirely channel-agnostic and unchanged --
-- this is only the WhatsApp-specific plumbing around it: identity is the
-- contact's wa_id instead of a Teams AAD object id, and there's no
-- Bot Framework token dance (the same Cloud API access_token already
-- stored in company_whatsapp_credentials is used directly as the bearer
-- token for outbound replies).

-- bot_enabled is the admin "if allowed" gate, mirroring
-- company_teams_bot_credentials.enabled -- checked before the webhook
-- does anything beyond ingestion (see app/api/whatsapp/webhook/[companyId]/route.ts).
-- app_secret (needed to verify Meta's X-Hub-Signature-256 header on every
-- inbound webhook call -- a different secret than access_token/
-- webhook_verify_token, found in the Meta App dashboard's Basic settings)
-- lives inside the existing `credentials` jsonb blob, not as its own column,
-- alongside access_token/phone_number_id/business_account_id/webhook_verify_token.
ALTER TABLE company_whatsapp_credentials
  ADD COLUMN IF NOT EXISTS bot_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS whatsapp_bot_linked_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  wa_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  ai_conversation_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, wa_id)
);

ALTER TABLE whatsapp_bot_linked_accounts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS whatsapp_bot_linked_accounts_company_members ON whatsapp_bot_linked_accounts;
CREATE POLICY whatsapp_bot_linked_accounts_company_members ON whatsapp_bot_linked_accounts
  FOR ALL
  USING (company_id IN (SELECT company_id FROM company_memberships WHERE user_id = auth.uid()))
  WITH CHECK (company_id IN (SELECT company_id FROM company_memberships WHERE user_id = auth.uid()));

-- One-time magic-link codes, same shape/lifetime as teams_bot_link_requests.
CREATE TABLE IF NOT EXISTS whatsapp_bot_link_requests (
  code text PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  wa_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '15 minutes')
);

ALTER TABLE whatsapp_bot_link_requests ENABLE ROW LEVEL SECURITY;
-- Service-role only, same as teams_bot_link_requests -- no policies.

-- Identical shape to teams_bot_pending_actions -- see that file's header
-- comment for the collecting/confirming state machine this drives.
CREATE TABLE IF NOT EXISTS whatsapp_bot_pending_actions (
  linked_account_id uuid PRIMARY KEY REFERENCES whatsapp_bot_linked_accounts(id) ON DELETE CASCADE,
  action_type text NOT NULL CHECK (action_type IN ('create_task', 'update_task', 'create_project', 'update_project')),
  status text NOT NULL DEFAULT 'confirming' CHECK (status IN ('collecting', 'confirming')),
  collected jsonb,
  next_fields jsonb,
  params jsonb,
  summary text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '10 minutes')
);

ALTER TABLE whatsapp_bot_pending_actions ENABLE ROW LEVEL SECURITY;

-- Groups this app has created via Meta's official Groups API (a business
-- creates its own new group; there is no way, on the official platform,
-- to add a number to an *existing* end-user group -- see the header
-- comment in app/api/whatsapp/groups/route.ts). group_id is Meta's id for
-- the group, used as the `to` value with recipient_type: "group" when
-- replying (see lib/whatsappBot/sendMessage.ts).
CREATE TABLE IF NOT EXISTS whatsapp_bot_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  group_id text NOT NULL UNIQUE,
  name text NOT NULL,
  invite_link text NOT NULL,
  created_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE whatsapp_bot_groups ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS whatsapp_bot_groups_company_members ON whatsapp_bot_groups;
CREATE POLICY whatsapp_bot_groups_company_members ON whatsapp_bot_groups
  FOR ALL
  USING (company_id IN (SELECT company_id FROM company_memberships WHERE user_id = auth.uid()))
  WITH CHECK (company_id IN (SELECT company_id FROM company_memberships WHERE user_id = auth.uid()));
