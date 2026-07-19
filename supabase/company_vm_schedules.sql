-- Company-wide business-hours schedule for virtual computers. Mandatory for
-- flat-fee plans (starter/standard/pro) -- flat pricing assumes bounded
-- business-hours usage, so a schedule is what keeps that pricing viable, not
-- an optional convenience. Optional for the pay-as-you-go plan, which bills
-- real hours regardless. See app/api/virtual-computers/sweep/route.ts for
-- the wake-ahead/end-of-day enforcement and
-- components/admin/AdminVirtualComputersTab.tsx for the editor.
CREATE TABLE IF NOT EXISTS company_vm_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  days smallint[] NOT NULL DEFAULT '{1,2,3,4,5}',
  start_time time NOT NULL DEFAULT '09:00',
  end_time time NOT NULL DEFAULT '17:00',
  timezone text NOT NULL DEFAULT 'UTC',
  enforce_end_time boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE company_vm_schedules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS company_vm_schedules_company_members ON company_vm_schedules;
CREATE POLICY company_vm_schedules_company_members ON company_vm_schedules
  FOR ALL
  USING (company_id IN (SELECT company_id FROM company_memberships WHERE user_id = auth.uid()))
  WITH CHECK (company_id IN (SELECT company_id FROM company_memberships WHERE user_id = auth.uid()));
