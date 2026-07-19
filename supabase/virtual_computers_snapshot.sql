-- Snapshot-based cost-saving VM lifecycle: when a user logs off (or an idle
-- fallback/midnight backstop decides they have), the running instance is
-- destroyed but a snapshot/image of its disk is kept so a later "wake"
-- recreates an instance with prior state intact instead of a fresh base
-- image. See lib/vmProviders/types.ts (createSnapshot, fromSnapshotId) and
-- app/api/virtual-computers/[id]/{logoff,heartbeat,extend,wake}/route.ts and
-- app/api/virtual-computers/sweep/route.ts.
ALTER TABLE virtual_computers ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
ALTER TABLE virtual_computers ADD COLUMN IF NOT EXISTS snapshot_id text;
ALTER TABLE virtual_computers ADD COLUMN IF NOT EXISTS hibernated_at timestamptz;

-- 'snapshotting': logoff detected, snapshot in progress, instance still up.
-- 'hibernated': snapshot complete, instance destroyed, no compute billing --
-- distinct from 'destroyed', which remains a permanent admin teardown.
ALTER TABLE virtual_computers DROP CONSTRAINT IF EXISTS virtual_computers_status_check;
ALTER TABLE virtual_computers ADD CONSTRAINT virtual_computers_status_check
  CHECK (status IN ('provisioning', 'running', 'error', 'destroying', 'destroyed', 'snapshotting', 'hibernated'));
