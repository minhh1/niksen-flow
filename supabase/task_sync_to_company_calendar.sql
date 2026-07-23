-- Per-task opt-in to also sync this task's event to the company calendar,
-- independent of the company-wide sync_tasks_to_company_calendar setting —
-- lets someone add a specific task to the company calendar even when the
-- company-wide setting is off.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS sync_to_company_calendar boolean NOT NULL DEFAULT false;
