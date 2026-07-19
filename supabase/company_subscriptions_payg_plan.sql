-- Adds the pay-as-you-go plan tier (see lib/billing/plans.ts) -- billed on
-- real VM uptime + a flat per-hour service fee instead of a fixed monthly
-- fee, so a company schedule (company_vm_schedules) isn't required for it
-- the way it is for the flat tiers.
ALTER TABLE company_subscriptions DROP CONSTRAINT IF EXISTS company_subscriptions_plan_id_check;
ALTER TABLE company_subscriptions ADD CONSTRAINT company_subscriptions_plan_id_check
  CHECK (plan_id IN ('starter', 'standard', 'pro', 'payg'));
