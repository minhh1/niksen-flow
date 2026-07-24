-- Server-side guarantee that no empty custom-table record survives.
-- The client already refuses valueless creates (createRecord in
-- lib/services/customTableService.ts + the NewRecordModal prompt), but a
-- record is written in two requests -- the record row first, its values
-- second -- so a direct API caller, or a client that dies between the two,
-- can still leave a row with no values behind. This sweep hard-deletes any
-- non-ledger record older than an hour (grace period for in-flight
-- creates) that has no meaningful value in any column.
--
-- Ledger tables are excluded: their append-only trigger refuses DELETEs
-- outright (see company_table_ledger.sql), and insert_ledger_record
-- already rejects empty payloads, so nothing empty can exist there anyway.
--
-- Same pg_cron shape as ai_embed_cron.sql.

CREATE OR REPLACE FUNCTION sweep_empty_table_records() RETURNS int
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_count int;
BEGIN
  -- Runs under pg_cron with no JWT, so assert the service_role claim the
  -- prevent_non_admin_delete trigger (archive_requests.sql) already
  -- trusts -- this sweep is exactly the kind of system actor that bypass
  -- exists for. Transaction-local, so nothing leaks past this job.
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);

  WITH empties AS (
    SELECT r.id
    FROM company_table_records r
    JOIN company_tables t ON t.id = r.table_id
    WHERE COALESCE(t.is_ledger, false) = false
      AND r.created_at < now() - interval '1 hour'
      AND NOT EXISTS (
        SELECT 1 FROM company_table_values v
        WHERE v.record_id = r.id
          AND (NULLIF(v.value_text, '') IS NOT NULL
            OR v.value_number IS NOT NULL
            OR v.value_date IS NOT NULL
            OR v.value_boolean IS NOT NULL
            OR v.value_record_id IS NOT NULL)
      )
  ),
  purged_values AS (
    -- all-empty value rows (e.g. a saved '' text) go first so the record
    -- delete never trips a FK, regardless of cascade configuration
    DELETE FROM company_table_values WHERE record_id IN (SELECT id FROM empties)
  )
  DELETE FROM company_table_records WHERE id IN (SELECT id FROM empties);

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

SELECT cron.schedule(
  'empty-records-sweep',
  '23 * * * *',
  $$ SELECT sweep_empty_table_records() $$
);
