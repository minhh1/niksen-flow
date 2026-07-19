-- Distinguishes Linux (DigitalOcean, VNC/RDP into XFCE) from Windows (AWS
-- EC2, RDP into a real Windows desktop with Microsoft Office preinstalled --
-- see lib/vmProviders/aws.ts) virtual computers. Derived server-side from
-- `provider` at creation time (app/api/virtual-computers/create/route.ts),
-- never client-supplied.
ALTER TABLE virtual_computers ADD COLUMN IF NOT EXISTS os text NOT NULL DEFAULT 'linux'
  CHECK (os IN ('linux', 'windows'));
