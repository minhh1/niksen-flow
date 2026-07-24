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
import { CHROME_DPI_FIX_SNIPPET, ENABLE_AUDIO_SNIPPET, INSTALL_OFFICE_SNIPPET, REDUCE_BACKGROUND_LOAD_SNIPPET } from "./windowsProvisioning";
import { PRICING } from "./pricing";

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
// The two protocols now install two different desktops:
//
//   rdp (preferred) -- stock Ubuntu GNOME served by gnome-remote-desktop's
//   single-user headless mode (GNOME 46+, so Ubuntu 24.04+). This is the
//   modern-looking option: the real Yaru-themed Ubuntu desktop, not the
//   dated stock-XFCE look the old xrdp path had. gnome-remote-desktop is
//   also the future-proof choice -- it's Wayland-native and maintained by
//   GNOME, whereas xrdp needs an X11 session and KDE/GNOME are both
//   retiring X11 (xrdp+XFCE keeps working but is a visual dead end).
//   Single-user headless mode (grdctl --headless + the per-user
//   gnome-remote-desktop-headless.service) is deliberately chosen over the
//   system-level remote-login mode (grdctl --system): system mode lands
//   connections on a GDM login screen (a second, interactive login our
//   Guacamole flow can't fill in), while headless mode authenticates with
//   the user's own RDP credentials and drops straight into their session.
//   Details that make this work unattended:
//     - The RDP backend refuses to start without a TLS key/cert, so a
//       self-signed pair is generated with openssl; lib/guacamole.ts
//       already sends ignore-cert=true for RDP (it always had to -- xrdp's
//       certs were self-signed too).
//     - grdctl --headless stores credentials in a plain file instead of
//       the GNOME keyring (which doesn't exist in a session that hasn't
//       started yet) -- that's the whole point of the flag.
//     - The headless daemon runs from the user's own systemd instance, so
//       the user manager must exist without an interactive login:
//       loginctl enable-linger starts it, a poll waits for the user bus
//       socket to appear (enable-linger returns before the manager is up),
//       and systemctl --user is then invoked via su with XDG_RUNTIME_DIR/
//       DBUS_SESSION_BUS_ADDRESS set by hand (su alone doesn't set them).
//     - gdm3 gets pulled in as a dependency but is disabled: nothing ever
//       looks at the droplet's virtual console, and GDM just burns RAM.
//     - Droplets have no GPU (llvmpipe software rendering), so GNOME
//       animations are turned off system-wide via a dconf database, along
//       with screen lock/blank and idle suspend -- a remote session that
//       locks or suspends itself just looks like a dead VM. dconf-cli is
//       installed explicitly: it's what `dconf update` comes from and
//       --no-install-recommends would otherwise skip it.
//   A 4GB swapfile is created because DO's Ubuntu images ship with ZERO
//   swap, and a desktop workload (GNOME + Chrome + Teams + optionally a
//   4GB Windows guest) on a swapless box doesn't degrade gracefully -- it
//   thrash-freezes: the kernel evicts executable pages and re-reads them
//   from disk in a loop. Observed live on a real droplet (memory PSI 72%,
//   session frozen, no OOM kill); adding the swapfile dropped PSI to ~11%
//   within seconds and unfroze the session.
//
//   ubuntu-desktop-minimal is installed with --no-install-recommends
//   because its recommends are exactly the seeded snaps (Firefox etc.),
//   and snap installs from cloud-init are slow and flaky (same reasoning
//   as the Mozilla-repo Firefox note below). The GNOME core bits that
//   matter (shell, session, Yaru, pipewire for gnome-remote-desktop's
//   screen/audio streaming, portal/settings apps) are listed explicitly so
//   skipping recommends can't silently drop them.
//
//   vnc (legacy/lightweight) -- the original XFCE + TigerVNC setup,
//   unchanged. gnome-remote-desktop's VNC backend is deprecated upstream
//   and GNOME-under-Xvnc is fragile, so VNC machines keep XFCE.
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
function cloudInitScript(
  protocol: VmProtocol,
  username: string,
  password: string,
  ubuntuVersionDots: string,
  // Set to the droplet's size slug to also provision the WinApps/Office
  // guest (see officeGuestCloudInit below); null for a plain Linux desktop.
  officeSizeSlug: string | null
): string {
  const escapedPassword = password.replace(/'/g, "'\\''");
  const escapedUsername = username.replace(/'/g, "'\\''");
  const office = protocol === "rdp" && officeSizeSlug ? officeGuestCloudInit(escapedUsername, escapedPassword, officeSizeSlug) : null;

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

  // System-wide dconf defaults for the GNOME/RDP path (see the function
  // comment): no animations (no GPU on a droplet), no screen lock/blank/
  // idle-suspend (all of which read as "the VM died" through a remote
  // session). Written as a dconf system database rather than per-user
  // gsettings calls because gsettings needs a running session bus at a
  // point in provisioning where none exists yet.
  //
  // The wallpaper is pre-scaled to a 1080p JPEG (make-vc-wallpaper.py) and
  // the background default pointed at it, because the stock Ubuntu default
  // is a multi-MB 4K PNG that gnome-shell decodes through its sandboxed
  // glycin loader on every monitor-layout change -- and every RDP
  // reconnect/resize IS a monitor change here. On a real droplet that
  // decode pegged a full core for minutes (stuck, not just slow) while the
  // user stared at the solid dark-blue fallback color instead of a
  // wallpaper. A 128KB 1080p JPEG decodes instantly and looks identical
  // over RDP. If the scaler fails it falls back to trying every PNG in
  // /usr/share/backgrounds, and if all fail the only cost is the same blue
  // fallback background.
  //
  // gnome-headless-shell.service exists because gnome-remote-desktop's
  // headless daemon does NOT start a session itself -- it sits silently on
  // the user bus waiting for mutter's remote-desktop API to appear, and
  // never binds its RDP port until one does (confirmed directly on a real
  // Ubuntu 26.04/GNOME 50 droplet: daemon active, config all correct,
  // nothing listening on 3389; the moment `gnome-shell --headless` came up,
  // the daemon bound the port and a full RDP session worked). Upstream's
  // README hints at this with "an independently configured headless
  // graphical session", but ships no unit for it -- so this is that unit.
  // The drop-in makes enabling gnome-remote-desktop-headless pull the shell
  // in with it (Wants=) rather than relying on two separate enables.
  //
  // Two details of that unit, both learned from a live connection test:
  //   - No --virtual-monitor flag: with a pre-created monitor, the shell
  //     UI lives on it and a connecting RDP client gets a SECOND, empty
  //     virtual monitor -- the user sees only the background fill color (a
  //     solid dark-blue screen, no top bar). With zero monitors at start,
  //     the client's own monitor becomes primary and gets the real desktop
  //     at the client's resolution.
  //   - The ubuntu:GNOME/GNOME_SHELL_SESSION_MODE env: Ubuntu's whole look
  //     (Yaru wallpaper defaults, dock, appindicators) is applied through
  //     session-scoped gschema overrides ([...:ubuntu] in ubuntu-settings)
  //     that only apply when the session declares itself "ubuntu" -- a bare
  //     gnome-shell gets upstream-GNOME defaults instead, including a
  //     wallpaper file that only exists in gnome-backgrounds (hence that
  //     package, ubuntu-settings, and ibus in the install list).
  const gnomeDconfFiles = `  - path: /etc/systemd/user/gnome-headless-shell.service
    content: |
      [Unit]
      Description=GNOME Shell (headless) for gnome-remote-desktop

      [Service]
      Environment=XDG_SESSION_TYPE=wayland
      Environment=XDG_CURRENT_DESKTOP=ubuntu:GNOME
      Environment=XDG_SESSION_DESKTOP=ubuntu
      Environment=GNOME_SHELL_SESSION_MODE=ubuntu
      ExecStart=/usr/bin/gnome-shell --headless
      Restart=on-failure

      [Install]
      WantedBy=default.target
  - path: /etc/systemd/user/gnome-remote-desktop-headless.service.d/10-headless-shell.conf
    content: |
      [Unit]
      Wants=gnome-headless-shell.service
      After=gnome-headless-shell.service
  - path: /etc/dconf/profile/user
    content: |
      user-db:user
      system-db:local
  - path: /usr/local/bin/make-vc-wallpaper.py
    permissions: '0755'
    content: |
      #!/usr/bin/python3
      import gi
      gi.require_version('GdkPixbuf', '2.0')
      from gi.repository import GdkPixbuf
      import glob, sys
      candidates = ['/usr/share/backgrounds/warty-final-ubuntu.png'] + sorted(glob.glob('/usr/share/backgrounds/*.png'))
      for src in candidates:
          try:
              pb = GdkPixbuf.Pixbuf.new_from_file_at_scale(src, 1920, -1, True)
              pb.savev('/usr/share/backgrounds/vc-wallpaper.jpg', 'jpeg', ['quality'], ['90'])
              sys.exit(0)
          except Exception:
              continue
      sys.exit(1)
  - path: /etc/dconf/db/local.d/00-virtual-computer
    content: |
      [org/gnome/desktop/background]
      picture-uri='file:///usr/share/backgrounds/vc-wallpaper.jpg'
      picture-uri-dark='file:///usr/share/backgrounds/vc-wallpaper.jpg'
      picture-options='zoom'
      [org/gnome/desktop/interface]
      enable-animations=false
      [org/gnome/desktop/session]
      idle-delay=uint32 0
      [org/gnome/desktop/screensaver]
      lock-enabled=false
      [org/gnome/desktop/lockdown]
      disable-lock-screen=true
      [org/gnome/settings-daemon/plugins/power]
      sleep-inactive-ac-type='nothing'
      sleep-inactive-battery-type='nothing'
`;

  const writeFiles = `write_files:
${protocol === "vnc" ? vncSystemdUnit : gnomeDconfFiles}${extraAppsFiles}${office?.writeFiles ?? ""}`;

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

  const grdDir = `/home/${escapedUsername}/.local/share/gnome-remote-desktop`;
  return `${userSetup}
  - DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ubuntu-desktop-minimal gnome-remote-desktop pipewire pipewire-pulse wireplumber dbus-user-session dconf-cli xdg-desktop-portal-gnome nautilus gnome-console gnome-text-editor gnome-control-center yaru-theme-gnome-shell yaru-theme-gtk yaru-theme-icon fonts-ubuntu ubuntu-settings gnome-backgrounds ibus python3-gi gir1.2-gdkpixbuf-2.0
  - systemctl disable --now gdm3 || true
  - systemctl set-default multi-user.target
  - fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  - echo '/swapfile none swap sw 0 0' >> /etc/fstab
  - /usr/local/bin/make-vc-wallpaper.py || true
  - dconf update
  - su - ${escapedUsername} -c "mkdir -p ~/.config && echo yes > ~/.config/gnome-initial-setup-done"
  - install -d -m 700 -o ${escapedUsername} -g ${escapedUsername} /home/${escapedUsername}/.local /home/${escapedUsername}/.local/share ${grdDir}
  - openssl req -x509 -newkey rsa:4096 -nodes -days 3650 -subj /CN=virtual-computer -keyout ${grdDir}/tls.key -out ${grdDir}/tls.crt
  - chown ${escapedUsername}:${escapedUsername} ${grdDir}/tls.key ${grdDir}/tls.crt
  - chmod 600 ${grdDir}/tls.key
  - su - ${escapedUsername} -c "grdctl --headless rdp set-tls-key ~/.local/share/gnome-remote-desktop/tls.key"
  - su - ${escapedUsername} -c "grdctl --headless rdp set-tls-cert ~/.local/share/gnome-remote-desktop/tls.crt"
  - su - ${escapedUsername} -c "grdctl --headless rdp set-credentials '${escapedUsername}' '${escapedPassword}'"
  - su - ${escapedUsername} -c "grdctl --headless rdp enable"
  - loginctl enable-linger ${escapedUsername}
  - for i in $(seq 1 60); do test -S /run/user/$(id -u ${escapedUsername})/bus && break; sleep 1; done
  - su - ${escapedUsername} -c "XDG_RUNTIME_DIR=/run/user/$(id -u ${escapedUsername}) DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u ${escapedUsername})/bus systemctl --user enable --now gnome-headless-shell.service gnome-remote-desktop-headless.service"
  - systemctl start --no-block extra-apps.service
${office?.runcmd ?? ""}`;
}

// The "Microsoft Office on Ubuntu" add-on (virtual_computers.with_office):
// a minimal Windows 11 guest runs invisibly in Docker on the same droplet
// (dockur/windows, same image as the full Windows-on-DO path below), Office
// gets installed into it via the same OEM mechanism, and WinApps
// (https://github.com/winapps-org/winapps) projects the individual Office
// app windows onto the GNOME desktop via FreeRDP RemoteApp -- launcher
// icons, file associations, floating windows; the user never sees Windows.
//
// Differences from the full Windows path (windowsCloudInitScript):
//   - The host RDP port 3389 belongs to gnome-remote-desktop, so the guest
//     maps to 3390 -- and binds to 127.0.0.1 only. Nothing about the guest
//     is reachable from outside; only WinApps' local FreeRDP talks to it.
//     (Same for dockur's 8006 web viewer -- SSH-tunnel to it for debugging.)
//   - Sizing splits the droplet with a running desktop instead of a bare
//     Docker host: the guest gets everything above 2 vCPU / 4GB (so on the
//     s-4vcpu-8gb tiers: 2 vCPU / 4GB each side). Guest disk is a fixed
//     64GB (dockur's own default, ample for Windows + Office) rather than
//     guestDiskGb() -- the *host* is the user's actual computer here and
//     keeps the rest of the disk. On 8GB droplets (the biggest this
//     platform account can currently create -- larger sizes need a DO
//     limit increase), the guest additionally shrinks from its 4GB install
//     allocation to 3GB once WinApps setup succeeds: Windows needs the
//     4GB to install cleanly, but runs Office fine in 3GB, and the freed
//     GB matters a lot to the desktop side (measured: the guest's RSS is
//     by far the largest single memory holder on the box).
//   - The guest's Windows account reuses the row's remoteUsername/
//     remotePassword (Linux creds) so WinApps' stored config matches what's
//     in the DB. Local Windows accounts don't enforce complexity at
//     unattended-install time, so the short Linux-style password is fine.
//   - The guest is CPU-contained two ways, both learned from real-droplet
//     testing (its initial Windows install visibly lagged the GNOME
//     session): cpuset pins it to the LAST guestVcpus cores, so the first
//     two cores are always uncontended for the desktop -- weights alone
//     (cpu_shares 256 + user.slice CPUWeight=400, kept as a second line
//     of defense) reduced but did not eliminate desktop stalls while QEMU
//     was bursting across all cores. The guest only ever gets CPU_CORES=
//     guestVcpus anyway, so pinning costs it nothing it was entitled to.
//   - provision.ps1 additionally sets TSAppAllowList\\fDisabledAllowList=1,
//     which lets any installed program be launched as a RemoteApp -- this
//     is the core of WinApps' own RDPApps.reg, which its docker flavor
//     normally applies itself; with WAFLAVOR=manual we own the guest, so
//     we apply it ourselves.
//
// Everything runs from one detached oneshot unit (office-apps.service),
// for the same reason extra-apps.service is detached (see cloudInitScript's
// comment) -- and it's ordered After=extra-apps.service so two apt runs
// never fight over the dpkg lock (belt-and-suspenders: DPkg::Lock::Timeout
// too, since get.docker.com's own apt calls are outside our control).
// Type=oneshot has no start timeout by default, which matters: the script
// legitimately runs for hours (Windows unattended install + Office
// download inside the guest) before winapps-setup can succeed. There is
// deliberately no port-probe "wait for Windows" phase: docker-proxy
// accepts TCP on the mapped port from the moment the container starts, so
// a nc/port check passes long before Windows inside is actually up
// (learned on a real droplet, where exactly that gate burned the retry
// budget during the install). winapps-setup's own connection test is the
// only reliable readiness probe, so the retry loop (120 x ~2.5min, ~4-5h
// worst case) IS the wait. The ~2min spacing between attempts is load-
// bearing, not just politeness: WinApps' test ends by killing its FreeRDP
// client, which leaves the guest's session in a busy/disconnecting state
// that makes an immediately-following attempt fail with
// LOGON_MSG_SESSION_BUSY (observed live -- rapid manual retries kept
// failing where spaced ones succeeded). RDP_TIMEOUT=120 and
// APP_SCAN_TIMEOUT=300 in winapps.conf exist for the same slow-nested-VM
// reason: their defaults (30s/60s) are too short for the first RemoteApp
// session spin-up and for the installed-app registry scan that has to
// reconnect through the connection test's own fresh tsdiscon -- the full
// end-to-end setup was only ever observed succeeding with both raised. WinApps
// setup runs under xvfb-run because its FreeRDP invocations expect an X
// display and the unit has none; the launchers it creates run later inside
// the user's real GNOME session (Xwayland) instead. RDP_FLAGS uses
// /cert:ignore, not WinApps' usual /cert:tofu -- tofu means "ask the user
// to accept the self-signed cert on first connect", and there is no user
// in a headless unit, so every unattended connection died at certificate
// verification (observed live). The connection never leaves 127.0.0.1, so
// ignoring the guest's self-signed cert costs nothing. WAFLAVOR=manual tells
// WinApps the VM lifecycle is not its problem (our compose + Docker's
// restart policy own that, surviving reboots and snapshot restores).
function officeGuestCloudInit(
  escapedUsername: string,
  escapedPassword: string,
  sizeSlug: string
): { writeFiles: string; runcmd: string } {
  const { vcpus, memoryGb } = parseSizeSlug(sizeSlug);
  const guestVcpus = Math.max(2, vcpus - 2);
  const guestRamGb = Math.max(4, memoryGb - 4);

  // The RemoteApp allowlist tweak runs BEFORE the Office install: WinApps'
  // setup probe launches a RemoteApp over RDP, and Windows rejects that
  // until this key is set -- with the Office install (30-90 min) first,
  // every WinApps retry during that window failed for no good reason
  // (observed live). Launchers appearing minutes before Office's binaries
  // finish installing is the acceptable side of that trade.
  const provisionPs1 = `${REDUCE_BACKGROUND_LOAD_SNIPPET}

reg add "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Terminal Server\\TSAppAllowList" /v fDisabledAllowList /t REG_DWORD /d 1 /f

${ENABLE_AUDIO_SNIPPET}

${INSTALL_OFFICE_SNIPPET}`;
  const provisionPs1B64 = Buffer.from(provisionPs1, "utf-8").toString("base64");

  const writeFiles = `  - path: /root/office-vm/docker-compose.yml
    content: |
      services:
        windows:
          image: ghcr.io/dockur/windows:5.14
          container_name: office-windows
          cpu_shares: 256
          cpuset: "${vcpus - guestVcpus}-${vcpus - 1}"
          environment:
            VERSION: "11"
            RAM_SIZE: "${guestRamGb}G"
            CPU_CORES: "${guestVcpus}"
            DISK_SIZE: "64G"
            USERNAME: "${escapedUsername}"
            PASSWORD: "${escapedPassword}"
            LANGUAGE: "English"
          cap_add:
            - NET_ADMIN
          devices:
            - /dev/kvm
          ports:
            - "127.0.0.1:3390:3389/tcp"
            - "127.0.0.1:3390:3389/udp"
            - "127.0.0.1:8006:8006"
          volumes:
            - /root/office-vm/data:/storage
            - /root/office-vm/oem:/oem
          restart: unless-stopped
          stop_grace_period: 2m
  - path: /root/office-vm/oem/install.bat
    content: |
      @echo off
      powershell -ExecutionPolicy Bypass -File C:\\OEM\\provision.ps1
  - path: /root/office-vm/oem/provision.ps1
    encoding: b64
    content: ${provisionPs1B64}
  - path: /usr/local/bin/setup-office-apps.sh
    permissions: '0755'
    content: |
      #!/bin/bash
      set -e
      export DEBIAN_FRONTEND=noninteractive
      APT="apt-get -o DPkg::Lock::Timeout=600"
      $APT update
      $APT install -y ca-certificates curl
      curl -fsSL https://get.docker.com | sh
      systemctl enable --now docker
      docker compose -f /root/office-vm/docker-compose.yml up -d
      $APT install -y dialog freerdp3-x11 git iproute2 libnotify-bin netcat-openbsd xvfb
      curl -fsSL https://raw.githubusercontent.com/winapps-org/winapps/main/setup.sh -o /usr/local/share/winapps-setup.sh
      su - ${escapedUsername} -c "mkdir -p ~/.config/winapps"
      su - ${escapedUsername} -c "cat > ~/.config/winapps/winapps.conf && chmod 600 ~/.config/winapps/winapps.conf" <<'WACONF'
      RDP_USER="${escapedUsername}"
      RDP_PASS="${escapedPassword}"
      RDP_IP="127.0.0.1"
      RDP_PORT="3390"
      WAFLAVOR="manual"
      RDP_SCALE="100"
      RDP_FLAGS="/cert:ignore"
      RDP_TIMEOUT="120"
      APP_SCAN_TIMEOUT="300"
      WACONF
      for i in $(seq 1 120); do
        if su - ${escapedUsername} -c "xvfb-run -a bash /usr/local/share/winapps-setup.sh --user --setupAllOfficiallySupportedApps"; then
${guestRamGb <= 4 ? `          sed -i 's/RAM_SIZE: "${guestRamGb}G"/RAM_SIZE: "3G"/' /root/office-vm/docker-compose.yml
          docker compose -f /root/office-vm/docker-compose.yml up -d
` : ""}          exit 0
        fi
        sleep 120
      done
      echo "WinApps setup did not complete; run setup-office-apps.sh again or /usr/local/share/winapps-setup.sh manually" >&2
      exit 1
  - path: /etc/systemd/system/office-apps.service
    content: |
      [Unit]
      Description=Provision embedded Windows guest (Microsoft Office via WinApps)
      After=network-online.target extra-apps.service
      Wants=network-online.target

      [Service]
      Type=oneshot
      ExecStart=/usr/local/bin/setup-office-apps.sh
`;

  const runcmd = `  - mkdir -p /root/office-vm/data /root/office-vm/oem
  - systemctl set-property user.slice CPUWeight=400
  - systemctl start --no-block office-apps.service
`;

  return { writeFiles, runcmd };
}

// Not anchored at the end -- deliberately matches slugs with a dedicated-CPU
// suffix too (e.g. "s-4vcpu-8gb-intel", "s-4vcpu-8gb-240gb-intel"), which all
// share the same "s-<vcpus>vcpu-<memoryGb>gb" prefix regardless of tier.
function parseSizeSlug(sizeSlug: string): { vcpus: number; memoryGb: number } {
  const match = /^s-(\d+)vcpu-(\d+)gb/.exec(sizeSlug);
  if (!match) throw new Error(`Cannot size a Windows 11 VM from unrecognized slug "${sizeSlug}".`);
  return { vcpus: Number(match[1]), memoryGb: Number(match[2]) };
}

// The droplet's real disk allocation (see lib/vmProviders/pricing.ts's
// diskGb) minus headroom for the Ubuntu host OS + Docker images -- 10GB is
// comfortably more than a minimal Ubuntu server + Docker daemon actually
// needs. Falls back to the smallest Windows-capable tier's disk size if a
// slug somehow isn't in the pricing table, rather than throwing.
function guestDiskGb(sizeSlug: string): number {
  const size = PRICING.digitalocean.find((s) => s.slug === sizeSlug);
  const diskGb = size?.diskGb ?? 160;
  return Math.max(40, diskGb - 10);
}

// A genuine Windows 11 install, running inside nested KVM on the droplet's
// own Ubuntu host via dockur/windows (ghcr.io/dockur/windows) -- Guacamole
// connects straight to its exposed RDP port (3389) the same way it already
// connects to a native Windows Server EC2 instance or this file's own
// Linux-desktop RDP/VNC server above. No RemoteApp/individual-app-window
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
// Sizing reserves 1 vCPU / 1GB for the Ubuntu host itself (Docker/QEMU
// overhead is real even though no desktop is installed on the host side) --
// trimmed down from an earlier, overly conservative 2GB reservation, since a
// minimal Ubuntu server running just the Docker daemon + QEMU's own process
// doesn't need that much headroom, and every GB kept from the guest matters
// for comparison against a staff member's previous Windows Cloud PC spec.
// DISK_SIZE scales with the droplet's real disk allocation (see
// guestDiskGb above) instead of a value fixed regardless of size/tier.
//
// Only ever called for a fresh create, never a snapshot restore -- see the
// comment on the `fromSnapshotId` branch in createInstance below for why
// waking from a snapshot needs no equivalent script at all.
function windowsCloudInitScript(username: string, password: string, sizeSlug: string): string {
  const { vcpus, memoryGb } = parseSizeSlug(sizeSlug);
  const guestVcpus = Math.max(2, vcpus - 1);
  const guestRamGb = Math.max(4, memoryGb - 1);
  const diskGb = guestDiskGb(sizeSlug);
  const escapedUsername = username.replace(/"/g, '\\"');
  const escapedPassword = password.replace(/"/g, '\\"');

  const provisionPs1 = `${CHROME_DPI_FIX_SNIPPET}

${REDUCE_BACKGROUND_LOAD_SNIPPET}

${ENABLE_AUDIO_SNIPPET}

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
            DISK_SIZE: "${diskGb}G"
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
      userData = cloudInitScript(
        params.protocol,
        params.remoteUsername,
        params.remotePassword,
        ubuntu.versionDots,
        params.withOffice ? params.sizeSlug : null
      );
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
        ...(params.sshKeyIds?.length ? { ssh_keys: params.sshKeyIds } : {}),
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
