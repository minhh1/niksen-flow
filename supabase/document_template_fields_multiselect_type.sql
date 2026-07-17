-- Adds "multiselect" (checkbox group, multiple choices) alongside the
-- existing single-choice "select" dropdown field type.
ALTER TABLE document_template_fields DROP CONSTRAINT IF EXISTS document_template_fields_field_type_check;
ALTER TABLE document_template_fields ADD CONSTRAINT document_template_fields_field_type_check
  CHECK (field_type = ANY (ARRAY['text'::text, 'date'::text, 'number'::text, 'currency'::text, 'select'::text, 'multiselect'::text]));
