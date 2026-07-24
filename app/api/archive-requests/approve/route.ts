// app/api/archive-requests/approve/route.ts
// Admin-only approval for archive_requests (see supabase/archive_requests.sql).
// Mirrors app/api/gmail/archive-requests/approve's admin-role-check pattern.
// Performs the real soft-delete on the target entity, then marks the
// request approved. Accepts multiple ids for the review tab's bulk action.
import { NextRequest, NextResponse } from "next/server";
import { authorizeCompanyMember } from "@/lib/documentTemplateAuth";

export async function POST(req: NextRequest) {
  const auth = await authorizeCompanyMember();
  if (auth.error) return auth.error;
  const { admin, companyId, user, isAdmin } = auth;
  if (!isAdmin) return NextResponse.json({ error: "Admin access required" }, { status: 403 });

  const body = await req.json().catch(() => null);
  const ids: string[] = Array.isArray(body?.ids) ? body.ids : [];
  if (ids.length === 0) return NextResponse.json({ error: "ids is required" }, { status: 400 });

  const { data: requests, error } = await admin
    .from("archive_requests")
    .select("id, entity_table, entity_id")
    .in("id", ids)
    .eq("company_id", companyId)
    .eq("status", "pending");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const results: Record<string, { ok: boolean; error?: string }> = {};
  for (const reqRow of requests || []) {
    const { error: delErr } = await admin
      .from(reqRow.entity_table)
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", reqRow.entity_id);
    if (delErr) {
      results[reqRow.id] = { ok: false, error: delErr.message };
      continue;
    }
    await admin.from("archive_requests").update({
      status: "approved", reviewed_by: user.id, reviewed_at: new Date().toISOString(),
    }).eq("id", reqRow.id);
    results[reqRow.id] = { ok: true };
  }

  return NextResponse.json({ results });
}
