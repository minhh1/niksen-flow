// lib/vmProviders/aws.ts
// AWS EC2 adapter -- Windows-only (see lib/vmProviders/registry.ts and the
// "AWS (Windows + Office)" label in pricing.ts). DigitalOcean's adapter
// avoids any SDK because its REST API is a simple bearer token; AWS requires
// SigV4 request signing, which isn't practical to hand-roll, so this uses
// the official @aws-sdk/client-ec2 / @aws-sdk/client-ssm packages instead.
// Credentials are passed inline per call (never read from env/~/.aws) since
// each request may be a different company's own BYO AWS keys -- see
// supabase/company_cloud_credentials.sql's documented `aws` credentials
// shape: { access_key_id, secret_access_key, region }.
import {
  EC2Client,
  RunInstancesCommand,
  DescribeInstancesCommand,
  TerminateInstancesCommand,
  DescribeSecurityGroupsCommand,
  CreateSecurityGroupCommand,
  AuthorizeSecurityGroupIngressCommand,
  CreateImageCommand,
  DescribeImagesCommand,
  DeregisterImageCommand,
  DeleteSnapshotCommand,
  type _InstanceType as InstanceType,
} from "@aws-sdk/client-ec2";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import type {
  CreateInstanceParams,
  CreateInstanceResult,
  InstanceStatus,
  ProviderCredentials,
  SnapshotStatus,
  StartSnapshotResult,
  VmProvider,
} from "./types";

// The standard, Microsoft-documented way to avoid hardcoding a Windows AMI
// ID (which differs per region and changes with every patch Tuesday) --
// this SSM public parameter always resolves to the latest Windows Server
// 2022 Base AMI in whichever region it's queried against.
const WINDOWS_AMI_SSM_PARAMETER = "/aws/service/ami-windows-latest/Windows_Server-2022-English-Full-Base";

const RDP_SECURITY_GROUP_NAME = "niksen-vm-rdp";

function ec2Client(credentials: ProviderCredentials, region: string): EC2Client {
  return new EC2Client({
    region,
    credentials: { accessKeyId: credentials.access_key_id, secretAccessKey: credentials.secret_access_key },
  });
}

async function resolveWindowsAmiId(credentials: ProviderCredentials, region: string): Promise<string> {
  const ssm = new SSMClient({
    region,
    credentials: { accessKeyId: credentials.access_key_id, secretAccessKey: credentials.secret_access_key },
  });
  const res = await ssm.send(new GetParameterCommand({ Name: WINDOWS_AMI_SSM_PARAMETER }));
  const amiId = res.Parameter?.Value;
  if (!amiId) throw new Error(`Could not resolve a Windows AMI in region "${region}".`);
  return amiId;
}

// EC2's default security group doesn't allow inbound RDP from the internet,
// so without this, Guacamole would never be able to reach the instance at
// all -- ensure a dedicated group exists (idempotent: reused across every
// Windows VM this company creates) rather than opening the account's
// default group, which may be used by unrelated resources.
async function ensureRdpSecurityGroup(client: EC2Client): Promise<string> {
  const existing = await client.send(
    new DescribeSecurityGroupsCommand({ Filters: [{ Name: "group-name", Values: [RDP_SECURITY_GROUP_NAME] }] })
  );
  const existingId = existing.SecurityGroups?.[0]?.GroupId;
  if (existingId) return existingId;

  const created = await client.send(
    new CreateSecurityGroupCommand({
      GroupName: RDP_SECURITY_GROUP_NAME,
      Description: "Inbound RDP (3389) for Diract Windows virtual computers",
    })
  );
  const groupId = created.GroupId;
  if (!groupId) throw new Error("AWS did not return a security group ID after creation.");

  await client.send(
    new AuthorizeSecurityGroupIngressCommand({
      GroupId: groupId,
      IpPermissions: [{ IpProtocol: "tcp", FromPort: 3389, ToPort: 3389, IpRanges: [{ CidrIp: "0.0.0.0/0" }] }],
    })
  );
  return groupId;
}

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
// its snapshot permanently, since waking from a snapshot otherwise skips
// this step entirely (see windowsRestoreUserData below) -- this makes every
// wake self-heal that instead of silently carrying the gap forward forever.
//
// Explicitly forces TLS 1.2 first: PowerShell's default
// [Net.ServicePointManager]::SecurityProtocol on a fresh Windows Server
// Base AMI doesn't reliably include it, which silently breaks
// Invoke-WebRequest against Microsoft's HTTPS-only endpoints (a
// well-documented, common failure mode for exactly this kind of
// automation) -- worth forcing defensively even without direct
// confirmation it's hit this specific case, since it's harmless otherwise.
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
const INSTALL_OFFICE_SNIPPET = `[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
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

// Windows EC2 instances run this automatically via EC2Launch v2 on first
// boot only (no <persist>true</persist>, so it won't re-run and reset the
// password on later reboots). Sets the built-in Administrator's password to
// one we generate and already know -- unlike the typical EC2 Windows flow
// (random password + keypair + GetPasswordData decryption), this keeps
// parity with the DigitalOcean adapter's UX where the password is simply
// known upfront. RDP + the firewall rule for it are enabled by default on
// the stock AMI; set explicitly anyway as a hedge against the base AMI's
// defaults ever changing. Also installs Office (see INSTALL_OFFICE_SNIPPET).
function windowsUserData(password: string): string {
  const escapedPassword = password.replace(/"/g, '`"').replace(/\$/g, "`$");
  const script = `<powershell>
net user Administrator "${escapedPassword}"
Enable-NetFirewallRule -DisplayGroup "Remote Desktop"
Set-ItemProperty -Path "HKLM:\\System\\CurrentControlSet\\Control\\Terminal Server" -Name "fDenyTSConnections" -Value 0

# Chrome's own high-DPI awareness defaults to off (registry key absent) --
# separate from anything Guacamole/RDP negotiates, and the actual cause of
# Chrome page content rendering blurry over RDP while natively DPI-aware
# apps (File Explorer) look fine (confirmed against Chromium developers'
# own description of this setting, since chrome://flags can't reach it --
# Chrome needs it before profiles/settings even initialize). This runs as
# SYSTEM before Administrator ever logs in and creates a real profile, so
# there's no HKCU to write to yet -- load the Default user template hive
# instead, which Windows copies into every new profile going forward.
reg load HKU\\DefaultUser "C:\\Users\\Default\\NTUSER.DAT"
reg add "HKU\\DefaultUser\\Software\\Google\\Chrome\\Profile" /v high-dpi-support /t REG_DWORD /d 1 /f
reg unload HKU\\DefaultUser

${INSTALL_OFFICE_SNIPPET}
</powershell>`;
  return Buffer.from(script, "utf-8").toString("base64");
}

// Used instead of windowsUserData() when waking a hibernated VM from a
// custom AMI. Every other first-boot step (Chrome's DPI fix, etc.) is
// already baked into the disk, so re-running the full script would be
// redundant at best -- but Office is deliberately re-checked (and
// self-healed if missing) on every wake, not treated as baked-in, since a
// snapshot taken before that ~5-10 minute install finished would otherwise
// carry the gap forward permanently. EC2 Launch v2 only runs plain
// <powershell> on an instance's tracked "first boot", which the source AMI
// already consumed -- without <persist>true</persist> this wouldn't even
// re-run the password/RDP steps, silently leaving them unset on the new
// instance -- so force it to run on every boot via <persist>.
function windowsRestoreUserData(password: string): string {
  const escapedPassword = password.replace(/"/g, '`"').replace(/\$/g, "`$");
  const script = `<powershell>
net user Administrator "${escapedPassword}"
Enable-NetFirewallRule -DisplayGroup "Remote Desktop"
Set-ItemProperty -Path "HKLM:\\System\\CurrentControlSet\\Control\\Terminal Server" -Name "fDenyTSConnections" -Value 0

${INSTALL_OFFICE_SNIPPET}
</powershell>
<persist>true</persist>`;
  return Buffer.from(script, "utf-8").toString("base64");
}

export const awsProvider: VmProvider = {
  id: "aws",

  async createInstance(params: CreateInstanceParams): Promise<CreateInstanceResult> {
    const client = ec2Client(params.credentials, params.region);
    const [amiId, securityGroupId] = await Promise.all([
      params.fromSnapshotId ? Promise.resolve(params.fromSnapshotId) : resolveWindowsAmiId(params.credentials, params.region),
      ensureRdpSecurityGroup(client),
    ]);

    const res = await client.send(
      new RunInstancesCommand({
        ImageId: amiId,
        InstanceType: params.sizeSlug as InstanceType,
        MinCount: 1,
        MaxCount: 1,
        SecurityGroupIds: [securityGroupId],
        UserData: params.fromSnapshotId
          ? windowsRestoreUserData(params.remotePassword)
          : windowsUserData(params.remotePassword),
        TagSpecifications: [{ ResourceType: "instance", Tags: [{ Key: "Name", Value: params.name }] }],
        // T-family sizes (the only ones this repo offers, see pricing.ts)
        // are burstable -- CPU performance above a per-size baseline draws
        // down a credit balance, and sustained interactive desktop use
        // (typing, video, Office) can exhaust it, hard-throttling the
        // instance back to baseline mid-session. "unlimited" lets it burst
        // past that baseline indefinitely (billed only for the extra
        // vCPU-hours actually used beyond baseline) instead of throttling.
        // Only valid for T-family instances -- AWS rejects this parameter
        // outright for non-burstable types like m5.2xlarge.
        ...(/^t\d/i.test(params.sizeSlug) ? { CreditSpecification: { CpuCredits: "unlimited" as const } } : {}),
      })
    );
    const instance = res.Instances?.[0];
    if (!instance?.InstanceId) throw new Error("AWS did not return an instance ID after launch.");
    return { providerInstanceId: instance.InstanceId, ipAddress: instance.PublicIpAddress ?? null };
  },

  async getInstance(credentials: ProviderCredentials, providerInstanceId: string, region: string): Promise<InstanceStatus> {
    const client = ec2Client(credentials, region);
    const res = await client.send(new DescribeInstancesCommand({ InstanceIds: [providerInstanceId] }));
    const instance = res.Reservations?.[0]?.Instances?.[0];
    if (!instance) throw new Error(`Instance "${providerInstanceId}" not found.`);

    const state = instance.State?.Name;
    return {
      providerInstanceId,
      status: state === "running" ? "running" : state === "pending" ? "provisioning" : "error",
      ipAddress: instance.PublicIpAddress ?? null,
    };
  },

  async destroyInstance(credentials: ProviderCredentials, providerInstanceId: string, region: string): Promise<void> {
    const client = ec2Client(credentials, region);
    try {
      await client.send(new TerminateInstancesCommand({ InstanceIds: [providerInstanceId] }));
    } catch (err) {
      // Mirrors the DigitalOcean adapter tolerating a 404 -- already gone is
      // a successful destroy, not an error.
      const code = (err as { name?: string })?.name;
      if (code === "InvalidInstanceID.NotFound") return;
      throw err;
    }
  },

  async startSnapshot(credentials: ProviderCredentials, providerInstanceId: string, region: string): Promise<StartSnapshotResult> {
    const client = ec2Client(credentials, region);
    // NoReboot defaults to false deliberately -- AWS reboots the instance
    // first to flush buffers before snapshotting, which is what guarantees
    // a filesystem-consistent image. NoReboot:true is explicitly not
    // integrity-guaranteed by AWS and isn't worth the risk for a full
    // desktop OS with Office and user files on it.
    const res = await client.send(
      new CreateImageCommand({ InstanceId: providerInstanceId, Name: `hibernate-${providerInstanceId}-${Date.now()}` })
    );
    if (!res.ImageId) throw new Error("AWS did not return an image ID after CreateImage.");
    // For AWS, the task handle and the eventual snapshot ID are the same
    // value -- DescribeImages polls the same ImageId CreateImage returned.
    return { snapshotTaskId: res.ImageId };
  },

  async getSnapshotStatus(
    credentials: ProviderCredentials,
    _providerInstanceId: string,
    region: string,
    snapshotTaskId: string
  ): Promise<SnapshotStatus> {
    const client = ec2Client(credentials, region);
    const res = await client.send(new DescribeImagesCommand({ ImageIds: [snapshotTaskId] }));
    const image = res.Images?.[0];
    if (!image) return { status: "pending", snapshotId: null };
    if (image.State === "available") return { status: "completed", snapshotId: snapshotTaskId };
    if (image.State === "failed" || image.State === "error") return { status: "error", snapshotId: null };
    return { status: "pending", snapshotId: null };
  },

  // An AMI has its own backing EBS snapshot(s), which keep costing storage
  // even after the AMI itself is deregistered -- both have to be deleted.
  // Tolerates the AMI already being gone (DescribeImages just returns no
  // match rather than throwing).
  async deleteSnapshot(credentials: ProviderCredentials, snapshotId: string, region: string): Promise<void> {
    const client = ec2Client(credentials, region);
    const described = await client.send(new DescribeImagesCommand({ ImageIds: [snapshotId] })).catch(() => null);
    const image = described?.Images?.[0];
    if (!image) return;

    const ebsSnapshotIds = (image.BlockDeviceMappings ?? [])
      .map((m) => m.Ebs?.SnapshotId)
      .filter((id): id is string => !!id);

    await client.send(new DeregisterImageCommand({ ImageId: snapshotId }));
    for (const ebsSnapshotId of ebsSnapshotIds) {
      await client.send(new DeleteSnapshotCommand({ SnapshotId: ebsSnapshotId })).catch(() => {
        // Best-effort -- a lingering EBS snapshot is a cost annoyance, not
        // worth failing the whole VM-destroy flow over.
      });
    }
  },
};
