-- Multi-record relations: today every relation-type field
-- (table_relation/property/entity/project/link) holds exactly one linked
-- record, enforced structurally by company_table_values having a single
-- value_record_id column upserted on (record_id, field_id). This adds an
-- opt-in `allow_multiple` flag (relation-type fields only, default false --
-- every existing field keeps its current single-value behavior unchanged)
-- and a junction table to hold the extra links a multi field needs, rather
-- than reworking company_table_values' one-row-per-(record,field) shape.
--
-- Reading a multi field's value means unioning company_table_values (in
-- case a value was written before allow_multiple was turned on, or by
-- older code that doesn't know about the junction table) with
-- company_table_value_links -- see loadRecordValues in
-- lib/services/customTableService.ts.
ALTER TABLE company_table_fields ADD COLUMN IF NOT EXISTS allow_multiple boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS company_table_value_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  record_id uuid NOT NULL REFERENCES company_table_records(id) ON DELETE CASCADE,
  field_id uuid NOT NULL REFERENCES company_table_fields(id) ON DELETE CASCADE,
  value_record_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (record_id, field_id, value_record_id)
);

CREATE INDEX IF NOT EXISTS company_table_value_links_field_value_idx
  ON company_table_value_links (field_id, value_record_id);

ALTER TABLE company_table_value_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS company_table_value_links_company_members ON company_table_value_links;
CREATE POLICY company_table_value_links_company_members ON company_table_value_links
  FOR ALL
  USING (company_id IN (SELECT company_id FROM company_memberships WHERE user_id = auth.uid()))
  WITH CHECK (company_id IN (SELECT company_id FROM company_memberships WHERE user_id = auth.uid()));
