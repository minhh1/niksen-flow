-- gmail-label-sync-worker and gmail-email-sync-worker are cron-triggered
-- every 1 minute, but a single dispatch tick can take well over 60s (up to
-- the 150s platform ceiling) once there's enough backlog. Without a lock,
-- overlapping ticks each open their own DISPATCH_CONCURRENCY-wide pool
-- against the same processor function, compounding pressure on Supabase's
-- own function-gateway rate limit far beyond what one instance's pacing can
-- account for (observed retry-after growing past 40s under overlap).
create table if not exists dispatcher_locks (
  name text primary key,
  locked_until timestamptz not null default now()
);

insert into dispatcher_locks (name, locked_until) values
  ('gmail-label-sync-worker', now() - interval '1 minute'),
  ('gmail-email-sync-worker', now() - interval '1 minute')
on conflict (name) do nothing;
