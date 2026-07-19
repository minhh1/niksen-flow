// app/api/virtual-computers/list/route.ts
// Admins see every virtual computer in the company; regular members see
// only the one(s) assigned to them.
import { NextResponse } from "next/server";
import { authorizeCompanyMember } from "@/lib/documentTemplateAuth";

export async function GET() {
  const auth = await authorizeCompanyMember();
  if (auth.error) return auth.error;
  const { admin, companyId, user, isAdmin } = auth;

  let query = admin
    .from("virtual_computers")
    .select(
      "id, name, provider, protocol, os, size_slug, region, status, error_message, assigned_user_id, billing_mode, hourly_usd_at_creation, created_at"
    )
    .eq("company_id", companyId)
    .neq("status", "destroyed")
    .order("created_at", { ascending: false });

  if (!isAdmin) query = query.eq("assigned_user_id", user.id);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ virtualComputers: data || [] });
}
