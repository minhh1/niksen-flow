-- Lets an admin configure a field to only appear on the client form once an
-- earlier field ("its trigger") has been answered — plain sequential reveal
-- when trigger_value is null, or a conditional branch (only when the
-- trigger's answer equals/includes trigger_value) when it's set. Unlike
-- joined_to_field_id (which merges two tags into one answer), a field with a
-- trigger still renders its own row/input — it's just hidden until the
-- condition is met. The chain of trigger links (A <- B <- C...) is the
-- "sequence"; there's no separate group table. Always scoped to the same
-- template as joined_to_field_id is — see document_template_fields_join.sql.
ALTER TABLE document_template_fields ADD COLUMN IF NOT EXISTS trigger_field_id uuid REFERENCES document_template_fields(id) ON DELETE SET NULL;
ALTER TABLE document_template_fields ADD COLUMN IF NOT EXISTS trigger_value text;
CREATE INDEX IF NOT EXISTS document_template_fields_trigger_field_id_idx ON document_template_fields(trigger_field_id);
