// app/api/virtual-computers/schedule/route.ts
// Company-wide business-hours schedule (see supabase/company_vm_schedules.sql
// and app/api/virtual-computers/sweep/route.ts). Admin-only to read/write.
import { NextRequest, NextResponse } from "next/server";
import { authorizeCompanyMember } from "@/lib/documentTemplateAuth";

export async function GET() {
  const auth = await authorizeCompanyMember();
  if (auth.error) return auth.error;
  const { admin, companyId } = auth;

  const { data } = await admin.from("company_vm_schedules").select("*").eq("company_id", companyId).maybeSingle();
  return NextResponse.json({
    schedule: data || {
      enabled: false,
      days: [1, 2, 3, 4, 5],
      start_time: "09:00",
      end_time: "17:00",
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      enforce_end_time: false,
    },
  });
}

export async function POST(req: NextRequest) {
  const auth = await authorizeCompanyMember();
  if (auth.error) return auth.error;
  const { admin, companyId, isAdmin } = auth;
  if (!isAdmin) return NextResponse.json({ error: "Admin access required" }, { status: 403 });

  const body = await req.json().catch(() => null);
  const { enabled, days, startTime, endTime, timezone, enforceEndTime } = body || {};
  if (!Array.isArray(days) || !startTime || !endTime || !timezone) {
    return NextResponse.json({ error: "days, startTime, endTime, and timezone are required" }, { status: 400 });
  }

  const { error } = await admin.from("company_vm_schedules").upsert(
    {
      company_id: companyId,
      enabled: !!enabled,
      days,
      start_time: startTime,
      end_time: endTime,
      timezone,
      enforce_end_time: !!enforceEndTime,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "company_id" }
  );
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
