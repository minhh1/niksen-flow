ALTER TABLE tasks ADD COLUMN IF NOT EXISTS source_email_subject text;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS source_email_body text;
