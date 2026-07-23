// app/api/whatsapp/groups/route.ts
// Admin-only: create a new WhatsApp group via Meta's official Groups API
// (see lib/whatsappBot/groups.ts) and list groups already created for this
// company. There is no way to add the bot's number to an *already-existing*
// end-user group on the official platform -- see the header comment in
// lib/whatsappBot/groups.ts. Requires the company's WhatsApp Business
// Account to be an Official Business Account (a Meta-side designation,
// not something this app can grant).
import { NextRequest, NextResponse } from "next/server";
import { authorizeCompanyMember } from "@/lib/documentTemplateAuth";
import { createWhatsAppGroup } from "@/lib/whatsappBot/groups";

export async function GET() {
  const auth = await authorizeCompanyMember();
  if (auth.error) return auth.error;
  const { admin, companyId } = auth;

  const { data, error } = await admin
    .from("whatsapp_bot_groups")
    .select("id, group_id, name, invite_link, created_at")
    .eq("company_id", companyId)
    .order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ groups: data ?? [] });
}

export async function POST(req: NextRequest) {
  const auth = await authorizeCompanyMember();
  if (auth.error) return auth.error;
  const { admin, companyId, user, isAdmin } = auth;
  if (!isAdmin) return NextResponse.json({ error: "Admin access required" }, { status: 403 });

  const body = await req.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });

  const { data: credRow } = await admin.from("company_whatsapp_credentials").select("credentials").eq("company_id", companyId).maybeSingle();
  if (!credRow) return NextResponse.json({ error: "Connect WhatsApp first" }, { status: 400 });

  let created;
  try {
    created = await createWhatsAppGroup(credRow.credentials, name, body?.description);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Group creation failed" }, { status: 502 });
  }

  const { data, error } = await admin
    .from("whatsapp_bot_groups")
    .insert({ company_id: companyId, group_id: created.id, name, invite_link: created.inviteLink, created_by: user.id })
    .select("id, group_id, name, invite_link, created_at")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ group: data });
}
