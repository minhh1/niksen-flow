// lib/projectAccess.ts
// Filters a list of tasks down to only those whose project the *viewer*
// (not the assignee) actually has access to — per-project access_mode can
// restrict a project to specific teams/members, and being on the same
// team-scoped public page doesn't override that. Uses the service-role
// client (RLS bypass is safe here since this function is the enforcement).
export async function filterTasksByProjectAccess<T extends { project_id: string | null }>(
  admin: any,
  userId: string,
  tasks: T[]
): Promise<T[]> {
  const projectIds = [...new Set(tasks.map(t => t.project_id).filter(Boolean))] as string[];
  if (!projectIds.length) return tasks;

  const { data: projects } = await admin.from("projects").select("id, access_mode").in("id", projectIds);
  const accessModeById: Record<string, string> = {};
  for (const p of projects || []) accessModeById[p.id] = p.access_mode || "all_members";

  const teamRestricted = projectIds.filter(id => accessModeById[id] === "specific_teams");
  const memberRestricted = projectIds.filter(id => accessModeById[id] === "specific_members");

  let accessibleViaTeam = new Set<string>();
  if (teamRestricted.length) {
    const { data: userTeams } = await admin.from("team_members").select("team_id").eq("profile_id", userId);
    const teamIds = (userTeams || []).map((t: any) => t.team_id);
    if (teamIds.length) {
      const { data: pt } = await admin.from("project_teams").select("project_id")
        .in("project_id", teamRestricted).in("team_id", teamIds);
      accessibleViaTeam = new Set((pt || []).map((r: any) => r.project_id));
    }
  }

  let accessibleViaMember = new Set<string>();
  if (memberRestricted.length) {
    const { data: pm } = await admin.from("project_members").select("project_id")
      .in("project_id", memberRestricted).eq("profile_id", userId);
    accessibleViaMember = new Set((pm || []).map((r: any) => r.project_id));
  }

  return tasks.filter(t => {
    if (!t.project_id) return true;
    const mode = accessModeById[t.project_id] || "all_members";
    if (mode === "specific_teams") return accessibleViaTeam.has(t.project_id);
    if (mode === "specific_members") return accessibleViaMember.has(t.project_id);
    return true; // all_members, or a project with no explicit restriction
  });
}
