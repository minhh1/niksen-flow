-- Optional client name shown on the public fill page's title, e.g.
-- "Documents Template - John Smith" instead of the generic default.
ALTER TABLE document_fill_pages ADD COLUMN IF NOT EXISTS client_name text;
