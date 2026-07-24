// lib/vmProviders/windowsProvisioning.ts
// Shared post-boot Windows provisioning PowerShell, reused by every provider
// that produces a Windows VM (currently AWS's EC2 UserData path and
// DigitalOcean's dockur/windows-in-nested-KVM path). Each provider wraps
// this in its own delivery mechanism (EC2 UserData's <powershell> tags vs.
// dockur/windows's OEM install.bat), but the actual provisioning logic --
// what to install and how -- is identical regardless of which cloud it's
// running on.

// Chrome's own high-DPI awareness defaults to off (registry key absent) --
// separate from anything Guacamole/RDP negotiates, and the actual cause of
// Chrome page content rendering blurry over RDP while natively DPI-aware
// apps (File Explorer) look fine (confirmed against Chromium developers'
// own description of this setting, since chrome://flags can't reach it --
// Chrome needs it before profiles/settings even initialize). This runs as
// SYSTEM before any real user profile is created, so there's no HKCU to
// write to yet -- load the Default user template hive instead, which
// Windows copies into every new profile going forward.
export const CHROME_DPI_FIX_SNIPPET = `reg load HKU\\DefaultUser "C:\\Users\\Default\\NTUSER.DAT"
reg add "HKU\\DefaultUser\\Software\\Google\\Chrome\\Profile" /v high-dpi-support /t REG_DWORD /d 1 /f
reg unload HKU\\DefaultUser`;

// A brand-new Windows install spends its first hours doing expensive
// background work -- Windows Update scanning/downloading, Search Indexer
// crawling the entire fresh disk, Delivery Optimization pulling update
// payloads peer-to-peer -- that's a background annoyance on real hardware
// but pins the CPU near 100% for hours on top of nested virtualization
// (confirmed directly: both a shared-CPU and a dedicated-CPU DO droplet hit
// 80-100% CPU on a literally idle desktop right after install, ruling out
// CPU contention as the cause). None of these are needed for a one-person
// remote-desktop VM, so this just sets them to manual/disabled start and
// stops them now -- reversible any time (`sc config <svc> start= auto` +
// start it) if someone actually wants them. Defender's real-time
// protection is deliberately left alone -- security-relevant, and wasn't
// implicated by the CPU numbers observed.
//
// Guarded by a marker file so this only ever applies once per VM, the same
// reasoning as INSTALL_OFFICE_SNIPPET's WINWORD.EXE check but inverted:
// there, the guard exists so a repeat run doesn't redo finished work; here,
// it exists so a repeat run (every wake-from-snapshot) doesn't silently
// undo an admin's own choice to turn one of these back on later.
export const REDUCE_BACKGROUND_LOAD_SNIPPET = `if (!(Test-Path "C:\\ProvisionMarkers\\reduce-background-load.done")) {
  sc.exe config wuauserv start= demand
  sc.exe stop wuauserv
  sc.exe config WSearch start= disabled
  sc.exe stop WSearch
  sc.exe config DoSvc start= demand
  sc.exe stop DoSvc
  New-Item -ItemType Directory -Path "C:\\ProvisionMarkers" -Force | Out-Null
  New-Item -ItemType File -Path "C:\\ProvisionMarkers\\reduce-background-load.done" -Force | Out-Null
}`;

// Windows Server AMIs ship with the Windows Audio service (Audiosrv) set to
// Disabled -- there's no physical audio hardware on a server SKU, so it's
// off by default. RDP's audio-playback redirection (the rdpsnd virtual
// channel Guacamole/FreeRDP negotiates automatically) doesn't need real
// hardware, but it does need this service actually running to expose an
// endpoint for the redirected stream -- with it disabled, RDP audio has
// nothing to attach to and silently produces no sound at all, independent
// of anything Guacamole itself is configured to do. AudioEndpointBuilder is
// Audiosrv's own dependency and needs the same treatment. Idempotent (safe
// to call every boot); dockur/windows's desktop Windows 11 guest normally
// ships with this already enabled, but setting it here too is harmless.
export const ENABLE_AUDIO_SNIPPET = `Set-Service -Name AudioEndpointBuilder -StartupType Automatic
Start-Service -Name AudioEndpointBuilder
Set-Service -Name Audiosrv -StartupType Automatic
Start-Service -Name Audiosrv`;

// Silently installs Microsoft Office via the Office Deployment Tool. Product
// ID O365ProPlusRetail is "Microsoft 365 Apps for enterprise" -- standard
// (non-shared) licensing, since each VM here is assigned to exactly one
// person, the same one-VM-per-user model the existing Ubuntu VMs use.
// Whoever's assigned the VM activates Office with their own Microsoft 365
// account the first time they open an Office app, same as on any fresh PC
// -- nothing here stores or injects Microsoft credentials.
//
// Guarded by a WINWORD.EXE existence check so it's safe to run on every
// boot, not just first boot: without that, a VM hibernated (snapshotted)
// before this ~5-10 minute install finished would have Office missing from
// its snapshot permanently, since a from-snapshot restore otherwise skips
// this step entirely -- this makes every wake self-heal that instead of
// silently carrying the gap forward forever.
//
// Explicitly forces TLS 1.2 first: PowerShell's default
// [Net.ServicePointManager]::SecurityProtocol on a fresh Windows install
// doesn't reliably include it, which silently breaks Invoke-WebRequest
// against Microsoft's HTTPS-only endpoints (a well-documented, common
// failure mode for exactly this kind of automation) -- worth forcing
// defensively even without direct confirmation it's hit this specific case,
// since it's harmless otherwise.
//
// The ODT installer itself is resolved by scraping the current real
// download.microsoft.com URL out of the stable Download Center page
// (id=49117) rather than hardcoding either a version-specific
// download.microsoft.com URL (goes stale every time Microsoft ships a new
// ODT build -- confirmed directly: the URL changed between two lookups
// made minutes apart) or the old https://aka.ms/ODT shortlink (confirmed
// directly, on a real VM: this now redirects to a Microsoft Learn *docs*
// page, not the binary -- Invoke-WebRequest silently downloaded that HTML
// as if it were the installer, and Start-Process then failed with "not a
// valid application for this OS platform" since the ~65KB "exe" was
// actually a webpage). The real link is present in the page's static
// server-rendered HTML (confirmed via a plain curl, no JS execution
// needed), so a regex match on the fetched content is enough.
export const INSTALL_OFFICE_SNIPPET = `[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
if (!(Test-Path "$env:ProgramFiles\\Microsoft Office\\root\\Office16\\WINWORD.EXE")) {
  $officeDir = "C:\\OfficeDeploy"
  New-Item -ItemType Directory -Path $officeDir -Force | Out-Null
  $odtPage = Invoke-WebRequest -Uri "https://www.microsoft.com/en-us/download/details.aspx?id=49117" -UseBasicParsing
  $odtUrl = ([regex]'https://download\\.microsoft\\.com/download/[^"]*officedeploymenttool[^"]*\\.exe').Match($odtPage.Content).Value
  Invoke-WebRequest -Uri $odtUrl -OutFile "$officeDir\\odtsetup.exe"
  Start-Process -FilePath "$officeDir\\odtsetup.exe" -ArgumentList "/quiet /extract:$officeDir" -Wait
  @'
<Configuration>
  <Add OfficeClientEdition="64" Channel="Current">
    <Product ID="O365ProPlusRetail">
      <Language ID="en-us" />
    </Product>
  </Add>
  <Display Level="None" AcceptEULA="TRUE" />
</Configuration>
'@ | Out-File -FilePath "$officeDir\\configuration.xml" -Encoding ascii
  Start-Process -FilePath "$officeDir\\setup.exe" -ArgumentList "/configure \`"$officeDir\\configuration.xml\`"" -Wait
}`;
