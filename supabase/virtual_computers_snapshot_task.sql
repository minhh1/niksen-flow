-- Tracks an in-progress snapshot across multiple sweep cron passes (a
-- snapshot can take far longer than one serverless invocation should
-- block for -- see startSnapshot/getSnapshotStatus in lib/vmProviders/types.ts).
-- Distinct from snapshot_id (virtual_computers_snapshot.sql), which only
-- gets set once the snapshot is confirmed complete.
ALTER TABLE virtual_computers ADD COLUMN IF NOT EXISTS snapshot_task_id text;
