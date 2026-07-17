-- Lets an admin mark two fields within the same uploaded document as "the
-- same answer" — the client is asked once, and that single value is
-- substituted into every joined tag in that document.
-- A field with joined_to_field_id set is an "alias": it's hidden from the
-- client form and doesn't carry its own label/type/required/etc (the target
-- field's settings are what's shown/used). Always one hop deep — see the
-- resolveRoot() helper in the join API route, which flattens any chain
-- before writing so joined_to_field_id never points at another alias.
ALTER TABLE document_template_fields ADD COLUMN IF NOT EXISTS joined_to_field_id uuid REFERENCES document_template_fields(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS document_template_fields_joined_to_field_id_idx ON document_template_fields(joined_to_field_id);
