-- Lets an admin add a fresh question that exists purely to gate other
-- fields (e.g. "Is the borrower a trust?") without it needing to already
-- exist as a {{tag}} placeholder in the uploaded document. It's a normal
-- document_template_fields row like any other (same type system, same
-- trigger_field_id/trigger_value wiring) — is_branch_only just means its
-- tag_key is synthetic (never matches a real placeholder), so docxtemplater
-- simply never substitutes it into any generated document. The client still
-- answers it like any other question; other fields can still combine with it.
ALTER TABLE document_template_fields ADD COLUMN IF NOT EXISTS is_branch_only boolean NOT NULL DEFAULT false;
