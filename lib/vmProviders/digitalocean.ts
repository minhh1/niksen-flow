// lib/vmProviders/digitalocean.ts
// DigitalOcean Droplets adapter -- Phase 1's only provisionable provider
// (see lib/vmProviders/registry.ts). Talks to DO's plain bearer-token REST
// API directly, mirroring the fetch-wrapper style in lib/gotenberg.ts
// (try/catch around fetch, res.ok check, truncated error body).
import type {
  CreateInstanceParams,
  CreateInstanceResult,
  InstanceStatus,
  ProviderCredentials,
  SnapshotStatus,
  StartSnapshotResult,
  VmProtocol,
  VmProvider,
} from "./types";

const DO_API_URL = "https://api.digitalocean.com/v2";
const DROPLET_IMAGE = "ubuntu-22-04-x64";

// cloud-init user_data that installs a desktop + the requested remote
// protocol's server, plus a baseline of everyday apps (browser, office
// suite, text editor) so a fresh VM is actually usable, not just a bare
// desktop shell. guacd connects straight to the VM's VNC/RDP port over
// TCP -- no websocket proxy needed on the VM side, Guacamole handles that.
//
// Ordering matters here: our status polling marks a VM "running" as soon
// as the provider's hypervisor reports the droplet booted (tens of
// seconds), not when cloud-init actually finishes. So the desktop + VNC/RDP
// server must be installed and started first, and the extra apps
// (Firefox/LibreOffice/Mousepad) must run as a genuinely DETACHED systemd
// unit (`systemctl start --no-block`), not a synchronous runcmd step.
// Repeated real-droplet testing (SSH in, watch it happen) showed that
// running the extra-apps install as a *synchronous* runcmd step -- even
// after the VNC/SSH setup steps that precede it -- reliably broke both SSH
// key auth and the VNC port for the rest of boot, root cause not fully
// isolated (ruled out: script ordering, write_files/systemd for the VNC
// unit itself, and comment lines in the generated YAML). Since VNC/SSH
// setup completes and is verified working *before* this step ever starts,
// running it fully detached removes any chance of it affecting the parts
// that matter, regardless of the exact mechanism.
//
// Firefox is installed from Mozilla's own APT repo rather than `apt-get
// install firefox` -- as of Ubuntu 22.04, the archive package is a
// transitional snap stub, and installing snaps from cloud-init is slow and
// flaky (snapd needs to initialize first). The pinning step ensures our
// repo's Firefox wins over any Ubuntu-provided package of the same name.
//
// The VNC server runs as a proper systemd unit (written via write_files
// below), not an ad-hoc `su - user -c "vncserver ..."` in runcmd. The
// latter looked fine in vncserver's own startup log (it prints "VNC
// extension running" etc.) but Xvnc reliably died within moments of the
// `su -c` invocation's session ending -- confirmed repeatedly by SSHing
// into real droplets, watching the process disappear, and finding nothing
// listening on the VNC port shortly after. A `Type=simple` systemd service
// running `vncserver -fg` (foreground, so systemd supervises the real
// process directly instead of a forking wrapper) avoids that whole class of
// session-lifecycle problem, and is the standard robust pattern for this.
//
// Do NOT add explanatory `#` comments inside the generated cloud-config
// string itself (the `#cloud-config`/`runcmd` YAML below) -- that was tried
// once and broke cloud-init's parsing of the whole document; keep
// explanations here, in the surrounding TypeScript, instead.
function cloudInitScript(protocol: VmProtocol, username: string, password: string): string {
  const escapedPassword = password.replace(/'/g, "'\\''");
  const escapedUsername = username.replace(/'/g, "'\\''");

  const vncSystemdUnit = `  - path: /etc/systemd/system/vncserver@.service
    content: |
      [Unit]
      Description=TigerVNC server (display :%i)
      After=network.target

      [Service]
      Type=simple
      User=${escapedUsername}
      WorkingDirectory=/home/${escapedUsername}
      ExecStart=/usr/bin/vncserver -fg -localhost no -SecurityTypes VncAuth :%i
      Restart=on-failure

      [Install]
      WantedBy=multi-user.target
`;

  // Runs fully detached from cloud-init via `systemctl start --no-block`
  // (see the function-level comment for why this must not be a synchronous
  // runcmd step).
  const extraAppsFiles = `  - path: /usr/local/bin/install-extra-apps.sh
    permissions: '0755'
    content: |
      #!/bin/sh
      set -e
      install -d -m 0755 /etc/apt/keyrings
      wget -q https://packages.mozilla.org/apt/repo-signing-key.gpg -O /etc/apt/keyrings/packages.mozilla.org.asc
      echo "deb [signed-by=/etc/apt/keyrings/packages.mozilla.org.asc] https://packages.mozilla.org/apt mozilla main" > /etc/apt/sources.list.d/mozilla.list
      printf "Package: *\\nPin: origin packages.mozilla.org\\nPin-Priority: 1000\\n" > /etc/apt/preferences.d/mozilla
      apt-get update
      DEBIAN_FRONTEND=noninteractive apt-get install -y firefox libreoffice-writer libreoffice-calc libreoffice-impress mousepad
  - path: /etc/systemd/system/extra-apps.service
    content: |
      [Unit]
      Description=Install extra desktop apps (Firefox, LibreOffice, Mousepad)
      After=network-online.target
      Wants=network-online.target

      [Service]
      Type=oneshot
      ExecStart=/usr/local/bin/install-extra-apps.sh
`;

  const writeFiles = `write_files:
${protocol === "vnc" ? vncSystemdUnit : ""}${extraAppsFiles}`;

  const userSetup = `#cloud-config
users:
  - name: ${escapedUsername}
    groups: sudo
    shell: /bin/bash
    lock_passwd: false
${writeFiles}runcmd:
  - echo '${escapedUsername}:${escapedPassword}' | chpasswd
  - apt-get update
  - systemctl daemon-reload`;

  if (protocol === "vnc") {
    return `${userSetup}
  - DEBIAN_FRONTEND=noninteractive apt-get install -y xfce4 xfce4-goodies tigervnc-standalone-server
  - DEBIAN_FRONTEND=noninteractive apt-get remove -y xfce4-screensaver light-locker || true
  - su - ${escapedUsername} -c "mkdir -p ~/.vnc"
  - su - ${escapedUsername} -c "echo '${escapedPassword}' | vncpasswd -f > ~/.vnc/passwd"
  - su - ${escapedUsername} -c "chmod 600 ~/.vnc/passwd"
  - su - ${escapedUsername} -c "printf '#!/bin/sh\\nstartxfce4\\n' > ~/.vnc/xstartup"
  - su - ${escapedUsername} -c "chmod +x ~/.vnc/xstartup"
  - systemctl enable --now vncserver@1.service
  - systemctl start --no-block extra-apps.service
`;
  }

  return `${userSetup}
  - DEBIAN_FRONTEND=noninteractive apt-get install -y xfce4 xfce4-goodies xrdp
  - DEBIAN_FRONTEND=noninteractive apt-get remove -y xfce4-screensaver light-locker || true
  - echo xfce4-session > /home/${escapedUsername}/.xsession
  - chown ${escapedUsername}:${escapedUsername} /home/${escapedUsername}/.xsession
  - adduser xrdp ssl-cert
  - systemctl enable --now xrdp
  - systemctl start --no-block extra-apps.service
`;
}

async function doFetch(credentials: ProviderCredentials, path: string, init?: RequestInit): Promise<Response> {
  const token = credentials.api_token;
  if (!token) throw new Error("Missing DigitalOcean api_token credential.");
  try {
    return await fetch(`${DO_API_URL}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...init?.headers,
      },
    });
  } catch {
    throw new Error(`Could not reach the DigitalOcean API at ${DO_API_URL}.`);
  }
}

async function throwIfNotOk(res: Response, action: string): Promise<void> {
  if (res.ok) return;
  const text = await res.text().catch(() => "");
  throw new Error(`DigitalOcean ${action} failed (${res.status}): ${text.slice(0, 200) || "unknown error"}`);
}

// DigitalOcean's droplet `name` must be a valid hostname (letters, digits,
// `.` and `-` only) -- our own `name` field is an arbitrary display name
// (e.g. "Minh's Virtual Computer") that admins type freely, so it has to be
// slugified before being sent, not passed through as-is (this previously
// caused real 422s: "Only valid hostname characters are allowed").
function toDropletHostname(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
  return slug || `vm-${Date.now()}`;
}

export const digitalOceanProvider: VmProvider = {
  id: "digitalocean",

  async createInstance(params: CreateInstanceParams): Promise<CreateInstanceResult> {
    // Restoring from a snapshot: the disk already has the desktop/VNC/RDP
    // server and extra apps installed, so re-running the full cloud-init
    // provisioning script would be redundant (and, per the systemd-unit
    // gotchas documented above, has a history of subtly breaking things
    // when run more than once). Just re-set the password so the stored
    // remote_password still works, nothing else.
    const userData = params.fromSnapshotId
      ? `#cloud-config\nruncmd:\n  - echo '${params.remoteUsername.replace(/'/g, "'\\''")}:${params.remotePassword.replace(/'/g, "'\\''")}' | chpasswd\n`
      : cloudInitScript(params.protocol, params.remoteUsername, params.remotePassword);

    const res = await doFetch(params.credentials, "/droplets", {
      method: "POST",
      body: JSON.stringify({
        name: toDropletHostname(params.name),
        region: params.region,
        size: params.sizeSlug,
        image: params.fromSnapshotId || DROPLET_IMAGE,
        user_data: userData,
        ipv6: false,
      }),
    });
    await throwIfNotOk(res, "droplet creation");
    const data = await res.json();
    return { providerInstanceId: String(data.droplet.id), ipAddress: null };
  },

  async getInstance(credentials: ProviderCredentials, providerInstanceId: string, _region: string): Promise<InstanceStatus> {
    const res = await doFetch(credentials, `/droplets/${providerInstanceId}`);
    await throwIfNotOk(res, "droplet lookup");
    const data = await res.json();
    const droplet = data.droplet;
    const networks: Array<{ type: string; ip_address: string }> = droplet.networks?.v4 ?? [];
    const publicIp = networks.find((n) => n.type === "public");
    return {
      providerInstanceId,
      status: droplet.status === "active" ? "running" : droplet.status === "errored" ? "error" : "provisioning",
      ipAddress: publicIp?.ip_address ?? null,
    };
  },

  async destroyInstance(credentials: ProviderCredentials, providerInstanceId: string, _region: string): Promise<void> {
    const res = await doFetch(credentials, `/droplets/${providerInstanceId}`, { method: "DELETE" });
    if (res.status === 404) return;
    await throwIfNotOk(res, "droplet deletion");
  },

  async startSnapshot(credentials: ProviderCredentials, providerInstanceId: string, _region: string): Promise<StartSnapshotResult> {
    const res = await doFetch(credentials, `/droplets/${providerInstanceId}/actions`, {
      method: "POST",
      body: JSON.stringify({ type: "snapshot", name: `hibernate-${providerInstanceId}-${Date.now()}` }),
    });
    await throwIfNotOk(res, "droplet snapshot");
    const data = await res.json();
    return { snapshotTaskId: String(data.action.id) };
  },

  // DO's action-status response doesn't include the resulting snapshot's
  // image ID directly -- once the action itself reports "completed", the
  // new snapshot has to be looked up separately via the droplet's
  // snapshot_ids (the newest one is the one this action just created).
  async getSnapshotStatus(
    credentials: ProviderCredentials,
    providerInstanceId: string,
    _region: string,
    snapshotTaskId: string
  ): Promise<SnapshotStatus> {
    const actionRes = await doFetch(credentials, `/actions/${snapshotTaskId}`);
    await throwIfNotOk(actionRes, "snapshot action lookup");
    const actionData = await actionRes.json();
    const actionStatus: string = actionData.action.status;
    if (actionStatus === "errored") return { status: "error", snapshotId: null };
    if (actionStatus !== "completed") return { status: "pending", snapshotId: null };

    const dropletRes = await doFetch(credentials, `/droplets/${providerInstanceId}`);
    await throwIfNotOk(dropletRes, "droplet lookup");
    const dropletData = await dropletRes.json();
    const snapshotIds: number[] = dropletData.droplet.snapshot_ids ?? [];
    const newest = snapshotIds[snapshotIds.length - 1];
    if (!newest) return { status: "pending", snapshotId: null };
    return { status: "completed", snapshotId: String(newest) };
  },
};
