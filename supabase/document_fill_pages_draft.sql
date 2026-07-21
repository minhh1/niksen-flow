-- Lets a client's in-progress answers survive closing the tab or switching
-- devices, so they don't have to retype everything to finish a long form
-- later. Scoped directly on the page row rather than a separate table —
-- document_fill_pages is already 1:1 with a single client link (see
-- document_fill_pages.sql), so there's no multi-client case to disambiguate.
-- Autosaved from the public client page (service-role only, same as the
-- rest of that flow — see lib/documentFillPageGate.ts); never cleared on
-- submit, so re-generating a different bundled document later still has
-- everything pre-filled.
ALTER TABLE document_fill_pages ADD COLUMN IF NOT EXISTS draft_values jsonb;
ALTER TABLE document_fill_pages ADD COLUMN IF NOT EXISTS draft_na_fields jsonb;
