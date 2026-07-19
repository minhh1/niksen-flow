-- Running-time ledger for metered (pay-as-you-go) billing. A row opens
-- (ended_at = null) every time a VM transitions into 'running' (create, or
-- wake-from-hibernate) and closes when it transitions out
-- ('hibernated'/'destroyed'/'error'). hourly_usd_at_start captures the real
-- provider rate for that interval (mirrors virtual_computers.hourly_usd_at_creation,
-- but per-interval instead of once). Cost for a closed interval is computed
-- as duration_hours * (hourly_usd_at_start + payg service fee) -- see
-- lib/billing/plans.ts and app/api/virtual-computers/sweep/route.ts.
CREATE TABLE IF NOT EXISTS virtual_computer_usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vm_id uuid NOT NULL REFERENCES virtual_computers(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  hourly_usd_at_start numeric NOT NULL,
  reported_to_stripe_at timestamptz
);

CREATE INDEX IF NOT EXISTS virtual_computer_usage_events_vm_id_idx ON virtual_computer_usage_events(vm_id);
CREATE INDEX IF NOT EXISTS virtual_computer_usage_events_company_id_idx ON virtual_computer_usage_events(company_id);
CREATE INDEX IF NOT EXISTS virtual_computer_usage_events_open_idx ON virtual_computer_usage_events(vm_id) WHERE ended_at IS NULL;

ALTER TABLE virtual_computer_usage_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS virtual_computer_usage_events_company_members ON virtual_computer_usage_events;
CREATE POLICY virtual_computer_usage_events_company_members ON virtual_computer_usage_events
  FOR ALL
  USING (company_id IN (SELECT company_id FROM company_memberships WHERE user_id = auth.uid()))
  WITH CHECK (company_id IN (SELECT company_id FROM company_memberships WHERE user_id = auth.uid()));
