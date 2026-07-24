// app/api/virtual-computers/[id]/reset-password/route.ts
// Assigned member or admin -- lets whoever's using a VM set their own login
// password (same access level as connection-info, since it's their own VM
// and they already have full interactive control of it). There's no live
// channel into a running instance's guest OS (no SSM/WinRM/dockur API wired
// up), so this only updates the stored credential -- it takes effect the
// next time the VM goes through a hibernate-then-wake cycle, since both
// providers' restore paths re-apply whatever remote_password is stored at
// that time (see wakeVm in ../../_lib.ts and the provider-specific restore
// UserData/cloud-init in lib/vmProviders/aws.ts and digitalocean.ts).
//
// The one combination this can never apply to: Windows 11 on DigitalOcean
// (dockur/windows). dockur/windows only ever consults its USERNAME/PASSWORD
// env vars during the guest's very first unattended install -- confirmed
// directly in digitalocean.ts's own restore-path comment, restoring from a
// snapshot deliberately sends no user_data at all because there's nothing
// for it to do. A changed remote_password there would update our own
// records but would never actually reach the guest, silently leaving
// whoever resets it locked out instead of helped -- so this is rejected
// outright for that combination rather than pretending to support it.
import { NextRequest, NextResponse } from "next/server";
import { authorizeCompanyMember } from "@/lib/documentTemplateAuth";
import { loadVm } from "../../_lib";

const UNSAFE_WINDOWS_CHARS = /["`$\\]/; // see generateWindowsPassword's own comment for why these are excluded

function validatePassword(password: string, os: "linux" | "windows", protocol: string): string | null {
  if (typeof password !== "string" || password.length < 8) return "Password must be at least 8 characters.";
  if (os === "windows") {
    if (password.length > 127) return "Password must be 127 characters or fewer.";
    if (UNSAFE_WINDOWS_CHARS.test(password)) return `Password can't contain ", \`, $, or \\.`;
    const classes = [/[A-Z]/, /[a-z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
    if (classes < 3) return "Password needs at least 3 of: uppercase, lowercase, digit, symbol.";
  } else if (protocol === "vnc" && password.length > 8) {
    // Classic VNC auth (TigerVNC) silently truncates to 8 characters -- see
    // generateRemotePassword's own comment -- so anything longer would look
    // accepted here but not actually be the password that works.
    return "This computer connects over VNC, which only supports passwords up to 8 characters.";
  }
  return null;
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await authorizeCompanyMember();
  if (auth.error) return auth.error;
  const { admin, companyId, user, isAdmin } = auth;

  const vm = await loadVm(admin, companyId, id);
  if (!vm) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!isAdmin && vm.assigned_user_id !== user.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  if (vm.provider === "digitalocean" && vm.os === "windows") {
    return NextResponse.json(
      {
        error:
          "Windows 11 on this VM type only applies its password once, during the very first install -- changing it here would never actually reach the computer. Ask an admin to reinstall Windows if you need the login reset.",
      },
      { status: 400 }
    );
  }

  const body = await req.json().catch(() => null);
  const password = body?.password;
  const validationError = validatePassword(password, vm.os, vm.protocol);
  if (validationError) return NextResponse.json({ error: validationError }, { status: 400 });

  await admin
    .from("virtual_computers")
    .update({ remote_password: password, updated_at: new Date().toISOString() })
    .eq("id", id);

  return NextResponse.json({
    ok: true,
    message:
      vm.status === "hibernated"
        ? "Saved -- this password will be in effect the next time this computer wakes up."
        : "Saved -- this password will take effect the next time this computer goes to sleep and wakes back up. It isn't applied to the current session.",
  });
}
