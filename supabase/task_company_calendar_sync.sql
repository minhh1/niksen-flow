-- Optional company-wide setting: also add every task's calendar event to
-- the company's nominated source-of-truth Gmail account's calendar,
-- alongside (not instead of) the assignee's own calendar sync.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS sync_tasks_to_company_calendar boolean NOT NULL DEFAULT false;

-- The company account's copy is a separate event resource on a separate
-- calendar from the assignee's copy, so it needs its own id column.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS company_calendar_event_id text;
