-- Generalizes the existing gmail_archive_requests pattern (a non-admin
-- requests, only a company_admin approves) to records and schema structure.
-- Before this, every delete/archive across the app -- projects, tasks,
-- entities, properties, custom-table rows, and even custom table/field
-- definitions -- was an unguarded client-side call reachable by any company
-- member. App-layer checks alone aren't a real guarantee (anything the
-- browser's Supabase client can reach, the REST API can reach directly,
-- bypassing whatever button gates it) so the actual enforcement is the
-- trigger below, not just the UI.

CREATE TABLE IF NOT EXISTS archive_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  entity_table text NOT NULL,
  entity_id uuid NOT NULL,
  entity_label text NOT NULL,
  requested_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS archive_requests_pending_idx ON archive_requests (entity_table, entity_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS archive_requests_company_idx ON archive_requests (company_id, status);

ALTER TABLE archive_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY archive_requests_select ON archive_requests
  FOR SELECT USING (company_id = active_company_id());

-- Any company member can submit a request for themselves, always starting
-- pending -- but only an admin can ever flip status (see the UPDATE policy
-- below). This is stricter than gmail_archive_requests, whose blanket
-- FOR ALL policy lets a non-admin update their own request's status
-- directly; worth tightening there too at some point, but out of scope here.
CREATE POLICY archive_requests_insert ON archive_requests
  FOR INSERT WITH CHECK (company_id = active_company_id() AND requested_by = auth.uid() AND status = 'pending');

CREATE POLICY archive_requests_update ON archive_requests
  FOR UPDATE USING (company_id = active_company_id() AND is_current_user_admin())
  WITH CHECK (company_id = active_company_id() AND is_current_user_admin());

-- ── Enforcement: the trigger, not the UI ────────────────────────────────
-- service_role bypass covers the approval API route (app/api/archive-requests/
-- approve, reject) and any background job; a real admin's own session
-- already satisfies is_current_user_admin(), so today's direct-delete UX
-- for admins is completely unchanged. Blocking DELETE too (not just the
-- deleted_at UPDATE) closes the Trash page's purge gap at the same time,
-- and blocking any deleted_at change also blocks a non-admin restoring a
-- record from Trash -- consistent with Trash itself becoming admin-only.
CREATE OR REPLACE FUNCTION prevent_non_admin_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.role() = 'service_role' OR is_current_user_admin() THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Only a company admin can permanently delete this record.' USING ERRCODE = '42501';
  END IF;

  IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RAISE EXCEPTION 'Only a company admin can archive this record directly. Submit an archive request instead.' USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['projects', 'tasks', 'entities', 'properties', 'company_table_records', 'company_tables', 'company_table_fields', 'company_custom_fields']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_prevent_non_admin_delete ON %I;', t);
    EXECUTE format('CREATE TRIGGER trg_prevent_non_admin_delete BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION prevent_non_admin_delete();', t);
  END LOOP;
END $$;
