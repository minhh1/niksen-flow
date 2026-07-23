-- One pending create/update-task/project action awaiting a yes/no
-- confirmation from a linked Teams user (see
-- app/api/teams/bot/[companyId]/route.ts and lib/ai/actions.ts). At most
-- one per linked account -- a new command simply replaces any stale
-- unconfirmed one (PRIMARY KEY on linked_account_id, upserted).
--
-- params is already fully resolved (real project_id/assignee_id, never raw
-- names the model extracted) by the time this row exists -- resolution
-- happens once, before the confirmation prompt is shown, not re-done at
-- confirm time.

CREATE TABLE IF NOT EXISTS teams_bot_pending_actions (
  linked_account_id uuid PRIMARY KEY REFERENCES teams_bot_linked_accounts(id) ON DELETE CASCADE,
  action_type text NOT NULL CHECK (action_type IN ('create_task', 'update_task', 'create_project', 'update_project')),
  params jsonb NOT NULL,
  summary text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '10 minutes')
);

ALTER TABLE teams_bot_pending_actions ENABLE ROW LEVEL SECURITY;
