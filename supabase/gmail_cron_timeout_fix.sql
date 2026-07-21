-- pg_net's net.http_post defaults timeout_milliseconds to 5000. Three Gmail
-- jobs fire in the same second every minute (gmail-archive-worker,
-- gmail-email-sync-worker, gmail-label-sync-worker). Confirmed by direct
-- observation: with all three firing at once, exactly one succeeds and the
-- other two time out on DNS resolution alone (TCP/SSL handshake never even
-- starts) — even after raising timeout_milliseconds to 25000, the other two
-- still never complete. That rules out "timeout too short": pg_net's
-- outbound worker concurrency itself can't serve more than one of these at
-- the same instant. Fix: stagger the actual net.http_post call inside each
-- job by a few seconds via pg_sleep so only one fires into pg_net at a time
-- — this works regardless of pg_cron version, since it doesn't rely on any
-- sub-minute schedule syntax.
SELECT cron.schedule('gmail-label-sync-worker', '* * * * *', $$
  SELECT pg_sleep(5);
  SELECT net.http_post(
    url := 'https://txzzgtwrrokomiphairy.supabase.co/functions/v1/gmail-label-sync-worker',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 25000)
$$);

SELECT cron.schedule('gmail-email-sync-worker', '* * * * *', $$
  SELECT pg_sleep(15);
  SELECT net.http_post(
    url := 'https://txzzgtwrrokomiphairy.supabase.co/functions/v1/gmail-email-sync-worker',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 25000)
$$);

SELECT cron.schedule('gmail-archive-worker', '* * * * *', $$
  SELECT pg_sleep(30);
  SELECT net.http_post(
    url := 'https://txzzgtwrrokomiphairy.supabase.co/functions/v1/gmail-archive-worker',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 25000)
$$);

SELECT cron.schedule('gmail-sync-recovery-worker', '*/15 * * * *', $$
  SELECT net.http_post(
    url := 'https://txzzgtwrrokomiphairy.supabase.co/functions/v1/gmail-sync-recovery-worker',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 25000)
$$);

SELECT cron.schedule('gmail-label-sync-cron', '*/15 * * * *', $$
  SELECT net.http_post(
    url := 'https://txzzgtwrrokomiphairy.supabase.co/functions/v1/gmail-label-sync-cron',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 25000)
$$);

SELECT cron.schedule('gmail-email-sync-cron', '7,22,37,52 * * * *', $$
  SELECT net.http_post(
    url := 'https://txzzgtwrrokomiphairy.supabase.co/functions/v1/gmail-email-sync-cron',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 25000)
$$);

SELECT cron.schedule('gmail-watch-renewal', '0 21 * * *', $$
  SELECT net.http_post(
    url := 'https://txzzgtwrrokomiphairy.supabase.co/functions/v1/gmail-watch-renewal',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 25000)
$$);
