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
-- Number field starts at 260001 with no prefix.
ALTER TABLE company_table_fields ADD COLUMN IF NOT EXISTS auto_number_start bigint;

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

  INSERT INTO company_table_field_sequences (field_id, company_id, next_value)
    VALUES (p_field_id, v_field.company_id, COALESCE(v_field.auto_number_start, 1) + 1)
  ON CONFLICT (field_id) DO UPDATE SET next_value = company_table_field_sequences.next_value + 1
  RETURNING next_value - 1 INTO v_seq;

  RETURN v_field.auto_number_prefix || lpad(v_seq::text, 6, '0');
END;
$$;
