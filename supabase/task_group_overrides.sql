-- Organised-view classification is per (task, viewed-in-whose-tab) — the
-- same task can be "Action" in the assignee's tab and "Watching" in a
-- watcher's tab, so this can't live as a single column on tasks.
ALTER TABLE tasks DROP COLUMN IF EXISTS task_group;

CREATE TABLE IF NOT EXISTS task_group_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  task_group text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, profile_id)
);

CREATE INDEX IF NOT EXISTS task_group_overrides_task_id_idx ON task_group_overrides(task_id);

ALTER TABLE task_group_overrides ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS task_group_overrides_company_members ON task_group_overrides;
CREATE POLICY task_group_overrides_company_members ON task_group_overrides
  FOR ALL
  USING (company_id IN (SELECT company_id FROM company_memberships WHERE user_id = auth.uid()))
  WITH CHECK (company_id IN (SELECT company_id FROM company_memberships WHERE user_id = auth.uid()));
