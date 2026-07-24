-- Company-wide Gmail label name for lead-generating emails, alongside the
-- shared-emails parent (gmail_parent_label) and the archive parent
-- (gmail_archive_label -- see supabase/gmail_archive.sql). All three are
-- configured together in the Label Settings modal
-- (components/gmail/LabelSettingsModal.tsx). NULL falls back to 'Leads'.
-- No worker consumes gmail_leads_label yet -- it's configured ahead of the
-- Gmail -> Leads intake feature.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS gmail_leads_label text;
