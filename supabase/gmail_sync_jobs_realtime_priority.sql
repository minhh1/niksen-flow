-- Lets gmail-push flag a job as "realtime" (triggered by an actual new
-- email, deletion, or newly-created label arriving right now) so the
-- dispatchers process it ahead of the ordinary backlog, instead of
-- competing on equal footing with hundreds of routine/backlog jobs.
alter table gmail_sync_jobs add column if not exists is_realtime boolean not null default false;

create index if not exists idx_gmail_sync_jobs_realtime
  on gmail_sync_jobs (job_type, is_realtime, status);
