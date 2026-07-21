-- Tracks per-(job, user) sync failures separately from gmail_sync_jobs.
-- Root cause of the 2026-07-21 incident: outbound Gmail/OAuth fetch() calls
-- had no timeout, so one rate-limited or slow account could hang an entire
-- worker invocation, blocking every other job in that batch. Fix: the fast
-- workers (gmail-label-sync-worker, gmail-email-sync-worker) now quarantine
-- a user here the FIRST time their per-user step fails, and never retry
-- them directly again — retries are owned exclusively by the slower
-- gmail-sync-recovery-worker (every 15 min), so a broken account can never
-- block the fast queue again.
CREATE TABLE IF NOT EXISTS gmail_sync_failures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES gmail_sync_jobs(id) ON DELETE CASCADE,
  job_type text NOT NULL,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  user_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending_retry' CHECK (status IN ('pending_retry', 'resolved', 'persistent_failure')),
  attempts int NOT NULL DEFAULT 0, -- recovery-worker attempts only, not fast-worker encounters
  last_error text,
  first_failed_at timestamptz NOT NULL DEFAULT now(),
  last_attempted_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS gmail_sync_failures_job_user_idx ON gmail_sync_failures(job_id, user_id);
CREATE INDEX IF NOT EXISTS gmail_sync_failures_company_status_idx ON gmail_sync_failures(company_id, status, created_at DESC);

ALTER TABLE gmail_sync_failures ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS gmail_sync_failures_company ON gmail_sync_failures;
CREATE POLICY gmail_sync_failures_company ON gmail_sync_failures
  FOR ALL USING (company_id = active_company_id()) WITH CHECK (company_id = active_company_id());

-- Retry quarantined failures on a slow, deliberate cadence — 15x less often
-- than the fast workers — so a rate-limited account gets breathing room
-- instead of being hammered every minute.
SELECT cron.schedule(
  'gmail-sync-recovery-worker',
  '*/15 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://txzzgtwrrokomiphairy.supabase.co/functions/v1/gmail-sync-recovery-worker',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb)
  $$
);
