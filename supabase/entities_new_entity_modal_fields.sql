-- components/NewEntityModal.tsx inserts email, phone and
-- registered_address_text directly into `entities`, but none of these
-- columns existed -- confirmed broken: creating a Company/Trust entity with
-- any of these fields filled in would fail outright (PostgREST rejects an
-- insert referencing an unknown column), for every company, not just one.
-- (`mobile_phone` already exists via entities_contact_fields.sql, but that's
-- a distinct field for a person's mobile -- `phone` here is a general
-- contact number, meaningful on a Company/Trust entity too.)
--
-- Checked first (see conversation, not repeated here as SQL) that no
-- company already has a company_custom_fields row for table_name='entities'
-- with field_key in ('email','phone','registered_address_text') -- these
-- are genuinely new, not a rename/conflict of something a company already
-- configured for itself.

ALTER TABLE entities ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE entities ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE entities ADD COLUMN IF NOT EXISTS registered_address_text text;
