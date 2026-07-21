// app/api/teams/bot/credentials/route.ts
// Admin-only read/write for company_teams_bot_credentials -- distinct from
// app/api/teams/credentials (the read-only Graph API polling creds). GET
// never returns the `credentials` column to the browser. One row per
// company -- POST upserts. PATCH flips `enabled`, the actual "if admin
// allows it" gate app/api/teams/bot/[companyId]/route.ts checks.
import { NextRequest, NextResponse } from "next/server";
import { authorizeCompanyMember } from "@/lib/documentTemplateAuth";

export async function GET() {
  const auth = await authorizeCompanyMember();
  if (auth.error) return auth.error;
  const { admin, companyId } = auth;

  const { data, error } = await admin
    .from("company_teams_bot_credentials")
    .select("id, enabled, created_at, credentials->bot_app_id, credentials->bot_tenant_id")
    .eq("company_id", companyId)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ connection: data });
}

export async function POST(req: NextRequest) {
  const auth = await authorizeCompanyMember();
  if (auth.error) return auth.error;
  const { admin, companyId, user, isAdmin } = auth;
  if (!isAdmin) return NextResponse.json({ error: "Admin access required" }, { status: 403 });

  const body = await req.json().catch(() => null);
  const { bot_app_id, bot_app_password, bot_tenant_id } = body ?? {};
  if (!bot_app_id || !bot_app_password || !bot_tenant_id) {
    return NextResponse.json({ error: "bot_app_id, bot_app_password, and bot_tenant_id are all required" }, { status: 400 });
  }

  const { data, error } = await admin
    .from("company_teams_bot_credentials")
    .upsert(
      {
        company_id: companyId,
        credentials: { bot_app_id, bot_app_password, bot_tenant_id },
        created_by: user.id,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "company_id" }
    )
    .select("id, created_at")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ connection: data });
}

export async function PATCH(req: NextRequest) {
  const auth = await authorizeCompanyMember();
  if (auth.error) return auth.error;
  const { admin, companyId, isAdmin } = auth;
  if (!isAdmin) return NextResponse.json({ error: "Admin access required" }, { status: 403 });

  const body = await req.json().catch(() => null);
  if (typeof body?.enabled !== "boolean") {
    return NextResponse.json({ error: "enabled (boolean) is required" }, { status: 400 });
  }

  const { error } = await admin.from("company_teams_bot_credentials").update({ enabled: body.enabled }).eq("company_id", companyId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ success: true });
}

export async function DELETE() {
  const auth = await authorizeCompanyMember();
  if (auth.error) return auth.error;
  const { admin, companyId, isAdmin } = auth;
  if (!isAdmin) return NextResponse.json({ error: "Admin access required" }, { status: 403 });

  const { error } = await admin.from("company_teams_bot_credentials").delete().eq("company_id", companyId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ success: true });
}
