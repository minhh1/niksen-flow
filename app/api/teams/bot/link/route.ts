// app/api/teams/bot/link/route.ts
// Consumes a Teams-bot magic-link code (see
// app/api/teams/bot/[companyId]/route.ts, which creates one for an
// unrecognized sender, and app/link-teams/page.tsx, which calls this once
// the logged-in user confirms). Requires a real Diract session -- this is
// the actual identity-proving step, not the bot webhook.
import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabaseServer";
import { adminClient } from "@/lib/documentTemplateAuth";

export async function POST(req: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const code: string | undefined = body?.code;
  if (!code) return NextResponse.json({ error: "code is required" }, { status: 400 });

  const admin = adminClient();
  const { data: request } = await admin
    .from("teams_bot_link_requests")
    .select("company_id, teams_aad_object_id, teams_tenant_id")
    .eq("code", code)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (!request) return NextResponse.json({ error: "This link has expired or was already used" }, { status: 404 });

  const { data: membership } = await admin
    .from("company_memberships")
    .select("company_id")
    .eq("user_id", user.id)
    .eq("company_id", request.company_id)
    .maybeSingle();
  if (!membership) return NextResponse.json({ error: "You're not a member of the company this bot belongs to" }, { status: 403 });

  const { error } = await admin.from("teams_bot_linked_accounts").upsert(
    {
      company_id: request.company_id,
      teams_aad_object_id: request.teams_aad_object_id,
      teams_tenant_id: request.teams_tenant_id,
      user_id: user.id,
    },
    { onConflict: "company_id,teams_aad_object_id" }
  );
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await admin.from("teams_bot_link_requests").delete().eq("code", code);

  return NextResponse.json({ success: true });
}
