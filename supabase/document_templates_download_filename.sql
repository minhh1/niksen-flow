-- Optional custom base filename for the generated .docx download; defaults
-- to the template's own name (document_templates.name) when unset.
ALTER TABLE document_templates ADD COLUMN IF NOT EXISTS download_filename text;
