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
  StopInstancesCommand,
  StartInstancesCommand,
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
import { CHROME_DPI_FIX_SNIPPET, ENABLE_AUDIO_SNIPPET, INSTALL_OFFICE_SNIPPET, REDUCE_BACKGROUND_LOAD_SNIPPET } from "./windowsProvisioning";

// The standard, Microsoft-documented way to avoid hardcoding a Windows AMI
// ID (which differs per region and changes with every patch Tuesday) --
// this SSM public parameter always resolves to the latest Windows Server
// 2022 Base AMI in whichever region it's queried against.
const WINDOWS_AMI_SSM_PARAMETER = "/aws/service/ami-windows-latest/Windows_Server-2022-English-Full-Base";

const RDP_SECURITY_GROUP_NAME = "niksen-vm-rdp";

// EC2 hibernation caps a Windows instance's RAM at 16 GiB (see
// https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/hibernating-prerequisites.html)
// -- t3.medium/large/xlarge (4/8/16 GB) all fit; m5.2xlarge (32 GB) doesn't
// and falls back to the older CreateImage-snapshot-and-terminate approach
// (still fully supported, just slower to wake from). Windows Server 2022
// AMIs released 2023.09.13 or later support hibernation, which the
// SSM "latest" parameter above always resolves to.
const HIBERNATION_ELIGIBLE_SIZES = new Set(["t3.medium", "t3.large", "t3.xlarge"]);

// AWS requires the root volume to be encrypted for hibernation (so the RAM
// contents written to it at hibernate time are protected) and reserves
// space on it at launch for the RAM dump -- 50 GB comfortably covers a
// Windows Server 2022 + Office install (well above the base AMI's own
// ~30 GB root snapshot, so RunInstances' volume-size floor is never hit)
// plus the largest eligible RAM size (16 GB, t3.xlarge) it might need to
// reserve.
const HIBERNATION_ROOT_VOLUME_GB = 50;

function ec2Client(credentials: ProviderCredentials, region: string): EC2Client {
  return new EC2Client({
    region,
    credentials: { accessKeyId: credentials.access_key_id, secretAccessKey: credentials.secret_access_key },
  });
}

async function resolveWindowsAmi(credentials: ProviderCredentials, region: string): Promise<{ amiId: string; rootDeviceName: string }> {
  const ssm = new SSMClient({
    region,
    credentials: { accessKeyId: credentials.access_key_id, secretAccessKey: credentials.secret_access_key },
  });
  const res = await ssm.send(new GetParameterCommand({ Name: WINDOWS_AMI_SSM_PARAMETER }));
  const amiId = res.Parameter?.Value;
  if (!amiId) throw new Error(`Could not resolve a Windows AMI in region "${region}".`);

  // Needed to correctly target the *root* volume's BlockDeviceMappings entry
  // when enabling hibernation below -- Windows AMIs conventionally use
  // /dev/sda1, but reading the AMI's own declared root device rather than
  // assuming it avoids silently attaching an extra, unencrypted volume
  // instead of actually encrypting the root one.
  const ec2 = ec2Client(credentials, region);
  const described = await ec2.send(new DescribeImagesCommand({ ImageIds: [amiId] }));
  const rootDeviceName = described.Images?.[0]?.RootDeviceName || "/dev/sda1";
  return { amiId, rootDeviceName };
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

${CHROME_DPI_FIX_SNIPPET}

${REDUCE_BACKGROUND_LOAD_SNIPPET}

${ENABLE_AUDIO_SNIPPET}

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

${REDUCE_BACKGROUND_LOAD_SNIPPET}

${ENABLE_AUDIO_SNIPPET}

${INSTALL_OFFICE_SNIPPET}
</powershell>
<persist>true</persist>`;
  return Buffer.from(script, "utf-8").toString("base64");
}

export const awsProvider: VmProvider = {
  id: "aws",

  async createInstance(params: CreateInstanceParams): Promise<CreateInstanceResult> {
    const client = ec2Client(params.credentials, params.region);

    // A native-hibernate wake (see startSnapshot/getSnapshotStatus below):
    // fromSnapshotId is the *same instance* that was stopped, not a
    // separate AMI -- resuming it means starting it back up, not relaunching
    // a fresh one, which is what actually preserves its exact running state
    // (open apps, in-progress work) instead of a fresh boot. Distinguished
    // from the older AMI-based restore path (fromSnapshotId is an "ami-..."
    // id) purely by AWS's own resource-id prefix, so no extra state needs to
    // be threaded through the shared VmProvider interface for this.
    if (params.fromSnapshotId?.startsWith("i-")) {
      await client.send(new StartInstancesCommand({ InstanceIds: [params.fromSnapshotId] }));
      const described = await client.send(new DescribeInstancesCommand({ InstanceIds: [params.fromSnapshotId] }));
      const instance = described.Reservations?.[0]?.Instances?.[0];
      return { providerInstanceId: params.fromSnapshotId, ipAddress: instance?.PublicIpAddress ?? null };
    }

    const isFreshCreate = !params.fromSnapshotId;
    const hibernationEligible = isFreshCreate && HIBERNATION_ELIGIBLE_SIZES.has(params.sizeSlug);

    const [amiInfo, securityGroupId] = await Promise.all([
      params.fromSnapshotId
        ? Promise.resolve({ amiId: params.fromSnapshotId, rootDeviceName: null })
        : resolveWindowsAmi(params.credentials, params.region),
      ensureRdpSecurityGroup(client),
    ]);

    const res = await client.send(
      new RunInstancesCommand({
        ImageId: amiInfo.amiId,
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
        // Enables real EC2 hibernation (RAM suspended to the encrypted root
        // volume, same instance resumed on wake) instead of the slower
        // snapshot-AMI-and-terminate fallback -- see startSnapshot below and
        // HIBERNATION_ELIGIBLE_SIZES's comment for why this is only offered
        // for sizes under Windows's 16 GiB hibernation RAM cap. Can only be
        // set at launch, never added to an already-running instance.
        ...(hibernationEligible
          ? {
              HibernationOptions: { Configured: true },
              BlockDeviceMappings: [
                {
                  DeviceName: amiInfo.rootDeviceName!,
                  Ebs: { Encrypted: true, VolumeSize: HIBERNATION_ROOT_VOLUME_GB, VolumeType: "gp3", DeleteOnTermination: true },
                },
              ],
            }
          : {}),
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

    // Whether *this specific instance* was actually launched with
    // hibernation enabled (see HIBERNATION_ELIGIBLE_SIZES/createInstance
    // above) -- read back from AWS itself rather than re-deriving from
    // sizeSlug, since that isn't passed into this function and the
    // instance's own HibernationOptions is the authoritative answer anyway.
    const described = await client.send(new DescribeInstancesCommand({ InstanceIds: [providerInstanceId] }));
    const instance = described.Reservations?.[0]?.Instances?.[0];
    if (instance?.HibernationOptions?.Configured) {
      // Real EC2 hibernation: suspend RAM to the (encrypted) root volume and
      // keep this exact instance rather than producing a separate AMI --
      // reusing the instance ID itself as both the poll handle and the
      // eventual "snapshot" pointer lets getSnapshotStatus/createInstance
      // (on wake) distinguish this from the older AMI-based path purely by
      // AWS's own "i-" vs "ami-" id prefixes, with no other state needed.
      await client.send(new StopInstancesCommand({ InstanceIds: [providerInstanceId], Hibernate: true }));
      return { snapshotTaskId: providerInstanceId };
    }

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
    providerInstanceId: string,
    region: string,
    snapshotTaskId: string
  ): Promise<SnapshotStatus> {
    const client = ec2Client(credentials, region);

    // Native-hibernate path (see startSnapshot above): snapshotTaskId is the
    // instance's own id, so poll its instance state instead of an AMI.
    if (snapshotTaskId === providerInstanceId) {
      const res = await client.send(new DescribeInstancesCommand({ InstanceIds: [providerInstanceId] }));
      const instance = res.Reservations?.[0]?.Instances?.[0];
      const state = instance?.State?.Name;
      if (state === "stopped") return { status: "completed", snapshotId: providerInstanceId };
      if (state === "stopping" || state === "pending") return { status: "pending", snapshotId: null };
      return { status: "error", snapshotId: null };
    }

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
  // match rather than throwing). No-ops for a native-hibernate "snapshot"
  // (an "i-..." id, not an "ami-..." one) -- that's just the stopped
  // instance itself, still needed on the next wake, not something to clean
  // up (see getSnapshotStatus/createInstance above).
  async deleteSnapshot(credentials: ProviderCredentials, snapshotId: string, region: string): Promise<void> {
    if (snapshotId.startsWith("i-")) return;
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
