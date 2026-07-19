-- Hard backstop deadline (see lib/vmProviders/scheduling.ts and
-- app/api/virtual-computers/sweep/route.ts): set to local midnight in the
-- company's schedule timezone whenever a VM becomes 'running' (create or
-- wake), and pushed forward by app/api/virtual-computers/[id]/extend/route.ts
-- when a user clicks "Still working?" near the deadline. The sweep force-
-- hibernates any running VM past this timestamp regardless of activity, so a
-- stuck heartbeat or forgotten tab can never run up cost indefinitely.
ALTER TABLE virtual_computers ADD COLUMN IF NOT EXISTS hibernate_deadline timestamptz;
