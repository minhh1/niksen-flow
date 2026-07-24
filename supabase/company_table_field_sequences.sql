-- Consecutive server-side numbering for custom-table fields (e.g. trust
-- receipt numbers under Uniform General Rules 2015 r 36, invoice numbers).
-- A field opts in via company_table_fields.auto_number_prefix; the number is
-- assigned inside the insert path (lib/services/customTableService.ts's
-- createRecord for ordinary tables, insert_ledger_record in
-- supabase/company_table_ledger.sql for ledger tables) via
-- next_field_sequence(), never client-side, so the sequence stays strictly
-- consecutive under concurrent writers.

ALTER TABLE company_table_fields ADD COLUMN IF NOT EXISTS auto_number_prefix text;

-- Optional starting value for the counter (default 1). The prefix may be ''
-- (empty, non-NULL) for bare numbers -- e.g. the Law Firm template's Lead
-- Number field starts at 260001 with no prefix. The start acts as a FLOOR:
-- raising it later jumps the next issued number forward (never backward, so
-- already-issued numbers can't be duplicated). Note for ledger tables: a
-- mid-stream jump breaks receipt-number consecutiveness (r 36) -- only
-- change the start on a ledger field before any numbers are issued.
ALTER TABLE company_table_fields ADD COLUMN IF NOT EXISTS auto_number_start bigint;

-- Zero-pad width for the counter part (default 6, matching the original
-- hard-coded lpad). 1 means no padding. The prefix may contain the tokens
-- {YY}, {YYYY} and {MM}, resolved against the current date when each number
-- is issued -- so '{YY}' + pad 4 yields 260001-style year codes that roll
-- over to 27xxxx automatically (the counter itself does NOT reset).
ALTER TABLE company_table_fields ADD COLUMN IF NOT EXISTS auto_number_pad int;

CREATE TABLE IF NOT EXISTS company_table_field_sequences (
  field_id uuid PRIMARY KEY REFERENCES company_table_fields(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  next_value bigint NOT NULL DEFAULT 1
);

-- No client policies on purpose: RLS enabled with no policy denies all
-- direct access -- the counter is only readable/writable through the
-- SECURITY DEFINER functions below.
ALTER TABLE company_table_field_sequences ENABLE ROW LEVEL SECURITY;

-- Returns the next formatted number (prefix + zero-padded counter) for an
-- auto-numbered field, incrementing the counter. The row lock taken by the
-- upsert serialises concurrent callers on the same field.
CREATE OR REPLACE FUNCTION next_field_sequence(p_field_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  p_actor uuid := auth.uid();
  v_field company_table_fields%ROWTYPE;
  v_seq bigint;
  v_pad int;
  v_prefix text;
BEGIN
  SELECT * INTO v_field FROM company_table_fields WHERE id = p_field_id;
  IF NOT FOUND OR v_field.auto_number_prefix IS NULL THEN
    RAISE EXCEPTION 'field is not auto-numbered';
  END IF;

  IF p_actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM company_memberships WHERE company_id = v_field.company_id AND user_id = p_actor
  ) THEN
    RAISE EXCEPTION 'not a member of this company';
  END IF;

  -- GREATEST applies auto_number_start as a floor on the conflict path too,
  -- so raising the start after numbers have been issued jumps the sequence
  -- forward instead of being silently ignored.
  INSERT INTO company_table_field_sequences (field_id, company_id, next_value)
    VALUES (p_field_id, v_field.company_id, COALESCE(v_field.auto_number_start, 1) + 1)
  ON CONFLICT (field_id) DO UPDATE
    SET next_value = GREATEST(company_table_field_sequences.next_value, COALESCE(v_field.auto_number_start, 1)) + 1
  RETURNING next_value - 1 INTO v_seq;

  v_prefix := replace(replace(replace(v_field.auto_number_prefix,
    '{YYYY}', to_char(now(), 'YYYY')),
    '{YY}',   to_char(now(), 'YY')),
    '{MM}',   to_char(now(), 'MM'));

  -- GREATEST with the number's own length so a small pad never truncates
  -- (lpad cuts text when the target length is shorter than the input).
  v_pad := COALESCE(v_field.auto_number_pad, 6);
  RETURN v_prefix || lpad(v_seq::text, GREATEST(v_pad, length(v_seq::text)), '0');
END;
$$;
