// lib/publicTaskPageAuth.ts
// Shared authorization for public task page API routes — loads the page,
// checks it's active/not expired, and determines which users' tasks the
// requester is allowed to see/act on based on the page's self/team/company
// scope. Uses the service-role client (RLS bypass is safe here because
// authorization is fully enforced in this function).
import { NextResponse } from "next/server";

export async function loadPageAndAuthorize(admin: any, pageId: string, userId: string) {
  const { data: page } = await admin
    .from("public_task_pages")
    .select("id, company_id, created_by, title, scope, team_id, columns, expires_at, is_active")
    .eq("id", pageId).maybeSingle();

  if (!page) return { error: NextResponse.json({ error: "Page not found" }, { status: 404 }) };
  if (!page.is_active) return { error: NextResponse.json({ error: "This page has been revoked" }, { status: 410 }) };
  if (page.expires_at && new Date(page.expires_at) < new Date()) {
    return { error: NextResponse.json({ error: "This page has expired" }, { status: 410 }) };
  }

  const { data: membership } = await admin
    .from("company_memberships").select("role").eq("company_id", page.company_id).eq("user_id", userId).maybeSingle();
  if (!membership) return { error: NextResponse.json({ error: "You don't have access to this company" }, { status: 403 }) };
  const isAdmin = membership.role === "company_admin";

  let targetUserIds: string[] = [];
  if (page.scope === "self") {
    targetUserIds = [page.created_by];
    if (!isAdmin && userId !== page.created_by) {
      return { error: NextResponse.json({ error: "This page is private to its creator" }, { status: 403 }) };
    }
  } else if (page.scope === "team") {
    const { data: team } = await admin.from("teams").select("leader_id").eq("id", page.team_id).maybeSingle();
    const { data: members } = await admin.from("team_members").select("profile_id").eq("team_id", page.team_id);
    targetUserIds = (members || []).map((m: any) => m.profile_id);
    const isTeamMember = targetUserIds.includes(userId) || team?.leader_id === userId;
    if (!isAdmin && !isTeamMember) {
      return { error: NextResponse.json({ error: "You're not a member of this team" }, { status: 403 }) };
    }
  } else {
    const { data: members } = await admin.from("company_memberships").select("user_id").eq("company_id", page.company_id);
    targetUserIds = (members || []).map((m: any) => m.user_id);
  }

  // What the public page's header shows after "Tasks - " — the team name
  // for a team-scoped page, the creator's name for a self-scoped page, or
  // the company name for a company-wide page.
  let scopeName = "";
  if (page.scope === "team") {
    const { data: team } = await admin.from("teams").select("team_name").eq("id", page.team_id).maybeSingle();
    scopeName = team?.team_name || "Team";
  } else if (page.scope === "self") {
    const { data: creator } = await admin.from("profiles").select("full_name, email").eq("id", page.created_by).maybeSingle();
    scopeName = creator?.full_name || creator?.email || "Me";
  } else {
    const { data: company } = await admin.from("companies").select("name").eq("id", page.company_id).maybeSingle();
    scopeName = company?.name || "Company";
  }

  return { page, isAdmin, targetUserIds, scopeName };
}
