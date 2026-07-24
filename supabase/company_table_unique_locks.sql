-- Closes a real race condition found while stress-testing bulk record
-- creation: lib/services/customTableService.ts's is_unique check
-- (findConflictingUniqueValue) reads "does anyone else have this value?"
-- then writes, as two separate requests -- under concurrent writes (e.g. a
-- double-submit, or two staff racing to create the same trust Account
-- link), both requests can read "no conflict" before either has written,
-- and both succeed, silently violating uniqueness. Confirmed: 8 parallel
-- creates with the same is_unique value all succeeded.
--
-- A real fix needs one atomic statement, not read-then-write from the
-- client -- Postgres's own unique index is the only thing that actually
-- serializes concurrent writers. This table's PRIMARY KEY (field_id,
-- value_hash) is that index; claim_unique_value() does the
-- check-and-claim as a single INSERT ... ON CONFLICT ... DO UPDATE, so two
-- concurrent callers for the same value genuinely race on one row lock --
-- exactly one wins.
--
-- Reclaiming: a slot's lock row is only overwritten by a new claimant if it
-- currently points at ITSELF or at a record that's since been soft-deleted
-- -- so deleting the record holding a unique value frees it up again
-- without any separate cleanup step (see the ON CONFLICT ... WHERE guard).
-- A record whose unique value is edited to something else still "squats"
-- on its old lock row until customTableService.ts explicitly releases it
-- (see release_unique_value below) -- claim_unique_value alone doesn't know
-- a value change happened, only that a new one is being claimed.

CREATE TABLE IF NOT EXISTS company_table_unique_locks (
  field_id   uuid NOT NULL REFERENCES company_table_fields(id) ON DELETE CASCADE,
  value_hash text NOT NULL,
  record_id  uuid NOT NULL REFERENCES company_table_records(id) ON DELETE CASCADE,
  PRIMARY KEY (field_id, value_hash)
);

-- Internal bookkeeping only -- never queried or written directly by
-- clients, always through the SECURITY DEFINER functions below.
ALTER TABLE company_table_unique_locks ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION claim_unique_value(p_field_id uuid, p_record_id uuid, p_value text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_winner uuid;
BEGIN
  INSERT INTO company_table_unique_locks (field_id, value_hash, record_id)
  VALUES (p_field_id, p_value, p_record_id)
  ON CONFLICT (field_id, value_hash) DO UPDATE
    SET record_id = p_record_id
    WHERE company_table_unique_locks.record_id = p_record_id
       OR NOT EXISTS (
         SELECT 1 FROM company_table_records r
         WHERE r.id = company_table_unique_locks.record_id AND r.deleted_at IS NULL
       )
  RETURNING record_id INTO v_winner;

  -- NULL means the ON CONFLICT UPDATE's WHERE guard didn't match -- the
  -- slot is held by a different, still-live record.
  RETURN v_winner IS NOT NULL;
END;
$$;

-- Releases a value this record no longer holds (its unique field was
-- edited to something else) -- only removes the lock row if it still
-- points at THIS record and THIS value, so it's safe to call speculatively
-- without re-checking who currently owns it.
CREATE OR REPLACE FUNCTION release_unique_value(p_field_id uuid, p_record_id uuid, p_value text)
RETURNS void LANGUAGE sql SECURITY DEFINER AS $$
  DELETE FROM company_table_unique_locks
  WHERE field_id = p_field_id AND value_hash = p_value AND record_id = p_record_id;
$$;

-- Backfill: seed locks from every currently-unique field's existing live
-- values, so a record created the moment after this migration runs can't
-- silently claim a value that pre-existing (pre-migration) data already
-- holds -- the lock table starts empty otherwise.
INSERT INTO company_table_unique_locks (field_id, value_hash, record_id)
SELECT v.field_id, coalesce(v.value_text, v.value_number::text, v.value_date::text, v.value_boolean::text, v.value_record_id::text), v.record_id
FROM company_table_values v
JOIN company_table_fields f ON f.id = v.field_id
JOIN company_table_records r ON r.id = v.record_id
WHERE f.is_unique = true
  AND f.deleted_at IS NULL
  AND r.deleted_at IS NULL
  AND coalesce(v.value_text, v.value_number::text, v.value_date::text, v.value_boolean::text, v.value_record_id::text) IS NOT NULL
ON CONFLICT (field_id, value_hash) DO NOTHING;
