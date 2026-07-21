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
import { CHROME_DPI_FIX_SNIPPET, INSTALL_OFFICE_SNIPPET } from "./windowsProvisioning";

const DO_API_URL = "https://api.digitalocean.com/v2";

interface UbuntuImage {
  slug: string;
  // e.g. "26.04" -- used for provider repos that key by Ubuntu version
  // (OneDrive's openSUSE Build Service repo below needs an exact
  // "xUbuntu_XX.XX" path, so the resolved version has to flow all the way
  // through to the cloud-init script, not just the droplet's own image slug).
  versionDots: string;
}

// DigitalOcean has no "latest" alias the way AWS SSM does for Windows AMIs
// (see resolveWindowsAmiId in lib/vmProviders/aws.ts) -- resolve it by
// listing distribution images and picking the highest-numbered Ubuntu LTS
// slug. LTS releases are always April of even years, so filtering for the
// "-04-" pattern naturally excludes interim non-LTS releases (e.g. 25.10).
async function resolveLatestUbuntuLts(credentials: ProviderCredentials): Promise<UbuntuImage> {
  const res = await doFetch(credentials, "/images?type=distribution&per_page=200");
  await throwIfNotOk(res, "image lookup");
  const data = await res.json();
  const images: Array<{ slug: string | null }> = data.images ?? [];
  const ltsSlugs = images
    .map((img) => img.slug)
    .filter((slug): slug is string => !!slug && /^ubuntu-\d+-04-x64$/.test(slug));
  if (ltsSlugs.length === 0) throw new Error("Could not resolve a current Ubuntu LTS image from DigitalOcean.");
  ltsSlugs.sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
  const slug = ltsSlugs[0];
  const major = slug.split("-")[1];
  return { slug, versionDots: `${major}.04` };
}

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
function cloudInitScript(protocol: VmProtocol, username: string, password: string, ubuntuVersionDots: string): string {
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
  // Teams and OneDrive are both unofficial/community clients -- Microsoft
  // discontinued the official Linux Teams app in Dec 2022 and has never
  // shipped an official Linux OneDrive client. teams-for-linux (an
  // Electron wrapper around Teams' own web app) and abraunegg/onedrive
  // (the de facto standard open-source sync client, distributed via the
  // openSUSE Build Service since the old community PPA went defunct) are
  // the closest real equivalents. OneDrive's repo path is keyed by exact
  // Ubuntu version ("xUbuntu_XX.XX"), hence threading ubuntuVersionDots
  // in from the resolved-latest-LTS lookup rather than hardcoding it.
  const extraAppsFiles = `  - path: /usr/local/bin/install-extra-apps.sh
    permissions: '0755'
    content: |
      #!/bin/sh
      set -e
      DEBIAN_FRONTEND=noninteractive apt-get install -y gnupg wget
      install -d -m 0755 /etc/apt/keyrings
      wget -q https://packages.mozilla.org/apt/repo-signing-key.gpg -O /etc/apt/keyrings/packages.mozilla.org.asc
      echo "deb [signed-by=/etc/apt/keyrings/packages.mozilla.org.asc] https://packages.mozilla.org/apt mozilla main" > /etc/apt/sources.list.d/mozilla.list
      printf "Package: *\\nPin: origin packages.mozilla.org\\nPin-Priority: 1000\\n" > /etc/apt/preferences.d/mozilla
      wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /etc/apt/keyrings/google-chrome.gpg
      echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list
      wget -q -O /etc/apt/keyrings/teams-for-linux.asc https://repo.teamsforlinux.de/teams-for-linux.asc
      printf "Types: deb\\nURIs: https://repo.teamsforlinux.de/debian/\\nSuites: stable\\nComponents: main\\nArchitectures: amd64 arm64\\nSigned-By: /etc/apt/keyrings/teams-for-linux.asc\\n" > /etc/apt/sources.list.d/teams-for-linux.sources
      wget -q -O - "https://download.opensuse.org/repositories/home:/npreining:/debian-ubuntu-onedrive/xUbuntu_${ubuntuVersionDots}/Release.key" | gpg --dearmor -o /etc/apt/keyrings/obs-onedrive.gpg
      echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/obs-onedrive.gpg] https://download.opensuse.org/repositories/home:/npreining:/debian-ubuntu-onedrive/xUbuntu_${ubuntuVersionDots}/ ./" > /etc/apt/sources.list.d/onedrive.list
      apt-get update
      DEBIAN_FRONTEND=noninteractive apt-get install -y firefox google-chrome-stable teams-for-linux onedrive libreoffice-writer libreoffice-calc libreoffice-impress mousepad
  - path: /etc/systemd/system/extra-apps.service
    content: |
      [Unit]
      Description=Install extra desktop apps (Firefox, Chrome, Teams, OneDrive, LibreOffice, Mousepad)
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

function parseSizeSlug(sizeSlug: string): { vcpus: number; memoryGb: number } {
  const match = /^s-(\d+)vcpu-(\d+)gb$/.exec(sizeSlug);
  if (!match) throw new Error(`Cannot size a Windows 11 VM from unrecognized slug "${sizeSlug}".`);
  return { vcpus: Number(match[1]), memoryGb: Number(match[2]) };
}

// A genuine Windows 11 install, running inside nested KVM on the droplet's
// own Ubuntu host via dockur/windows (ghcr.io/dockur/windows) -- Guacamole
// connects straight to its exposed RDP port (3389) the same way it already
// connects to a native Windows Server EC2 instance or this file's own
// Linux-desktop xrdp/VNC server above. No RemoteApp/individual-app-window
// layer is involved here -- that's WinBoat's own wrapper around this same
// image, built for a different use case (surfacing individual floating app
// windows on someone's own Linux desktop), not needed for a full remote
// desktop session.
//
// Confirmed directly, this session, on a real droplet: nested KVM works on
// standard DO Basic droplets (DO doesn't officially support/recommend this,
// though), and dockur/windows's OEM folder mechanism (mounted at ./oem,
// copied to C:\OEM inside the guest) natively auto-executes
// oem/install.bat once Windows finishes its own unattended setup -- reused
// here to run the same Office install + Chrome DPI fix already used for
// the AWS Windows path (see windowsProvisioning.ts), via a companion
// PowerShell script the batch file just invokes.
//
// Sizing reserves 1 vCPU / 2GB for the Ubuntu host itself (Docker/QEMU
// overhead is real even though no desktop is installed on the host side),
// giving the rest to the Windows guest. DISK_SIZE is fixed at 80G -- safely
// within either Windows-capable droplet size's actual disk allocation
// (160GB/320GB on DO's s-4vcpu-8gb/s-8vcpu-16gb Basic tiers).
//
// Only ever called for a fresh create, never a snapshot restore -- see the
// comment on the `fromSnapshotId` branch in createInstance below for why
// waking from a snapshot needs no equivalent script at all.
function windowsCloudInitScript(username: string, password: string, sizeSlug: string): string {
  const { vcpus, memoryGb } = parseSizeSlug(sizeSlug);
  const guestVcpus = Math.max(2, vcpus - 1);
  const guestRamGb = Math.max(4, memoryGb - 2);
  const escapedUsername = username.replace(/"/g, '\\"');
  const escapedPassword = password.replace(/"/g, '\\"');

  const provisionPs1 = `${CHROME_DPI_FIX_SNIPPET}

${INSTALL_OFFICE_SNIPPET}`;
  const provisionPs1B64 = Buffer.from(provisionPs1, "utf-8").toString("base64");

  const composeFile = `  - path: /root/windows-vm/docker-compose.yml
    content: |
      services:
        windows:
          image: ghcr.io/dockur/windows:5.14
          container_name: windows
          environment:
            VERSION: "11"
            RAM_SIZE: "${guestRamGb}G"
            CPU_CORES: "${guestVcpus}"
            DISK_SIZE: "80G"
            USERNAME: "${escapedUsername}"
            PASSWORD: "${escapedPassword}"
            LANGUAGE: "English"
          cap_add:
            - NET_ADMIN
          devices:
            - /dev/kvm
          ports:
            - "3389:3389/tcp"
            - "3389:3389/udp"
            - "8006:8006"
          volumes:
            - /root/windows-vm/data:/storage
            - /root/windows-vm/oem:/oem
          restart: unless-stopped
          stop_grace_period: 2m
`;

  const installBat = `  - path: /root/windows-vm/oem/install.bat
    content: |
      @echo off
      powershell -ExecutionPolicy Bypass -File C:\\OEM\\provision.ps1
`;

  const provisionScript = `  - path: /root/windows-vm/oem/provision.ps1
    encoding: b64
    content: ${provisionPs1B64}
`;

  return `#cloud-config
write_files:
${composeFile}${installBat}${provisionScript}runcmd:
  - mkdir -p /root/windows-vm/data /root/windows-vm/oem
  - curl -fsSL https://get.docker.com | sh
  - systemctl enable --now docker
  - docker compose -f /root/windows-vm/docker-compose.yml up -d
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
    let image: string;
    let userData: string;
    if (params.os === "windows") {
      // Restoring from a snapshot: the disk already has Docker + the
      // dockur/windows container's compose file (with its USERNAME/PASSWORD
      // env vars already baked in from the original create) on it, and
      // Docker's `restart: unless-stopped` plus a systemd-enabled Docker
      // daemon bring the container back automatically once the droplet
      // itself boots -- unlike the Linux desktop path below, there's no
      // Linux user account here matching remoteUsername/remotePassword to
      // re-sync (those are the *Windows guest's* credentials, set once
      // during its own unattended install, not a host-level account), so
      // no user_data is needed at all on restore.
      if (params.fromSnapshotId) {
        image = params.fromSnapshotId;
        userData = "#cloud-config\n";
      } else {
        const ubuntu = await resolveLatestUbuntuLts(params.credentials);
        image = ubuntu.slug;
        userData = windowsCloudInitScript(params.remoteUsername, params.remotePassword, params.sizeSlug);
      }
    } else if (params.fromSnapshotId) {
      // Restoring from a snapshot: the disk already has the desktop/VNC/RDP
      // server and extra apps installed, so re-running the full cloud-init
      // provisioning script would be redundant (and, per the systemd-unit
      // gotchas documented above, has a history of subtly breaking things
      // when run more than once). Just re-set the password so the stored
      // remote_password still works, nothing else.
      image = params.fromSnapshotId;
      userData = `#cloud-config\nruncmd:\n  - echo '${params.remoteUsername.replace(/'/g, "'\\''")}:${params.remotePassword.replace(/'/g, "'\\''")}' | chpasswd\n`;
    } else {
      const ubuntu = await resolveLatestUbuntuLts(params.credentials);
      image = ubuntu.slug;
      userData = cloudInitScript(params.protocol, params.remoteUsername, params.remotePassword, ubuntu.versionDots);
    }

    const res = await doFetch(params.credentials, "/droplets", {
      method: "POST",
      body: JSON.stringify({
        name: toDropletHostname(params.name),
        region: params.region,
        size: params.sizeSlug,
        image,
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

  // A droplet snapshot is represented as a custom/snapshot-type Image --
  // deleted via the Images resource's own DELETE endpoint.
  async deleteSnapshot(credentials: ProviderCredentials, snapshotId: string, _region: string): Promise<void> {
    const res = await doFetch(credentials, `/images/${snapshotId}`, { method: "DELETE" });
    if (res.status === 404) return;
    await throwIfNotOk(res, "snapshot deletion");
  },
};
