// app/api/public-tasks/[pageId]/route.ts
// Powers the embeddable public task report page. Requires a real signed-in
// session — access is scoped by the page's self/team/company configuration,
// enforced here (not via RLS) using the service-role key, same pattern as
// the Gmail add-on's /my-tasks and /team-tasks endpoints.
import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabaseServer";
import { createClient } from "@supabase/supabase-js";
import { loadPageAndAuthorize } from "@/lib/publicTaskPageAuth";
import { logTaskActivity } from "@/lib/taskActivityLog";
import { filterTasksByProjectAccess } from "@/lib/projectAccess";

export async function GET(req: NextRequest, { params }: { params: Promise<{ pageId: string }> }) {
  const { pageId } = await params;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const auth = await loadPageAndAuthorize(admin, pageId, user.id);
  if (auth.error) return auth.error;
  const { page, targetUserIds, isAdmin, scopeName } = auth;

  const TASK_SELECT = `
      id, name, due_date, due_time, is_completed, completed_at, estimated_cost, date_entered, assignee_id, project_id,
      status_id, assigned_team_id, is_monetary, created_by, awaiting_follow_up, follow_up_date, notes, source_message_id,
      source_email_subject, source_email_body,
      assignee:assignee_id(id, full_name, email),
      creator:created_by(id, full_name, email),
      project:project_id(id, name),
      task_statuses:status_id(label, color_hex),
      teams:assigned_team_id(team_name)
    `;

  const { data: rawTasks } = await admin
    .from("tasks")
    .select(TASK_SELECT)
    .in("assignee_id", targetUserIds.length ? targetUserIds : ["00000000-0000-0000-0000-000000000000"])
    .eq("company_id", page.company_id)
    .is("deleted_at", null)
    .order("due_date", { ascending: true, nullsFirst: false });

  // Being on the same team-scoped page doesn't grant access to a project
  // that's restricted to specific teams/members — filter those out for
  // whoever is actually viewing the page (not the task's assignee).
  // Admins can already see everything else in the app, so they're exempt.
  const assignedTasks = isAdmin ? rawTasks : await filterTasksByProjectAccess(admin, user.id, rawTasks || []);

  // ── Watched tasks ─────────────────────────────────────────────────
  // A task a target user is watching (but isn't the assignee of) should
  // also show up under their tab — fetch those separately since the query
  // above is scoped to assignee_id.
  const { data: watcherRows } = await admin
    .from("task_watchers")
    .select("task_id, profile_id")
    .in("profile_id", targetUserIds.length ? targetUserIds : ["00000000-0000-0000-0000-000000000000"]);

  const watchersByTask: Record<string, string[]> = {};
  for (const w of watcherRows || []) (watchersByTask[w.task_id] ||= []).push(w.profile_id);

  const assignedTaskIds = new Set((assignedTasks || []).map((t: any) => t.id));
  const extraWatchedIds = [...new Set(Object.keys(watchersByTask))].filter(id => !assignedTaskIds.has(id));

  let watchedTasks: any[] = [];
  if (extraWatchedIds.length) {
    const { data: rawWatched } = await admin
      .from("tasks")
      .select(TASK_SELECT)
      .in("id", extraWatchedIds)
      .eq("company_id", page.company_id)
      .is("deleted_at", null);
    watchedTasks = isAdmin ? (rawWatched || []) : await filterTasksByProjectAccess(admin, user.id, rawWatched || []);
  }

  const tasks = [...(assignedTasks || []), ...watchedTasks];

  // ── Follow-up log, grouped per task ──────────────────────────────
  let followUpsByTask: Record<string, { id: string; followedUpAt: string }[]> = {};
  if (tasks?.length) {
    const { data: followUps } = await admin
      .from("task_follow_ups").select("id, task_id, followed_up_at")
      .in("task_id", tasks.map((t: any) => t.id));
    for (const f of followUps || []) {
      (followUpsByTask[f.task_id] ||= []).push({ id: f.id, followedUpAt: String(f.followed_up_at).slice(0, 10) });
    }
  }

  // ── Matter numbers, if requested ────────────────────────────────
  let matterByProject: Record<string, string> = {};
  if ((page.columns || []).includes("matter_number") && tasks?.length) {
    const projectIds = [...new Set(tasks.map((t: any) => t.project_id).filter(Boolean))];
    const { data: matterField } = await admin
      .from("company_custom_fields").select("id")
      .eq("company_id", page.company_id).eq("table_name", "projects").eq("field_key", "matter_number").maybeSingle();
    if (matterField && projectIds.length) {
      const { data: values } = await admin
        .from("company_custom_field_values").select("record_id, value_text")
        .eq("field_id", matterField.id).in("record_id", projectIds);
      matterByProject = Object.fromEntries((values || []).map((v: any) => [v.record_id, v.value_text || ""]));
    }
  }

  // ── Organised-view classification, per (task, whose tab it's in) ──
  // The same task can be "Action" in the assignee's tab and "Watching" in
  // a watcher's tab, so this isn't a single value on the task itself.
  let taskGroupByTaskAndUser: Record<string, string> = {};
  if (tasks?.length) {
    const { data: overrides } = await admin
      .from("task_group_overrides").select("task_id, profile_id, task_group")
      .in("task_id", tasks.map((t: any) => t.id));
    for (const o of overrides || []) {
      taskGroupByTaskAndUser[`${o.task_id}:${o.profile_id}`] = o.task_group;
    }
  }

  // ── Group into tabs, one per target user ────────────────────────
  const { data: targetProfiles } = await admin
    .from("profiles").select("id, full_name, email").in("id", targetUserIds.length ? targetUserIds : ["00000000-0000-0000-0000-000000000000"]);

  const tabs = (targetProfiles || [])
    .map((p: any) => ({
      userId: p.id,
      userName: p.full_name || p.email || "Unknown",
      tasks: (tasks || [])
        .filter((t: any) => t.assignee_id === p.id || (watchersByTask[t.id] || []).includes(p.id))
        .map((t: any) => ({
          id: t.id, name: t.name, isCompleted: t.is_completed, completedAt: t.completed_at,
          dueDate: t.due_date ? String(t.due_date).slice(0, 10) : null,
          dueTime: t.due_time,
          projectId: t.project_id,
          projectName: t.project?.name || null,
          matterNumber: t.project_id ? matterByProject[t.project_id] || null : null,
          statusId: t.status_id,
          status: t.task_statuses?.label || null,
          statusColor: t.task_statuses?.color_hex || null,
          teamId: t.assigned_team_id,
          team: t.teams?.team_name || null,
          isMonetary: t.is_monetary,
          estimatedCost: t.estimated_cost,
          dateEntered: t.date_entered,
          createdBy: t.creator?.full_name || t.creator?.email || null,
          awaitingFollowUp: t.awaiting_follow_up,
          followUpDate: t.follow_up_date ? String(t.follow_up_date).slice(0, 10) : null,
          notes: t.notes,
          sourceMessageId: t.source_message_id,
          sourceEmailSubject: t.source_email_subject,
          sourceEmailBody: t.source_email_body,
          followUps: followUpsByTask[t.id] || [],
          isWatcher: t.assignee_id !== p.id,
          watcherIds: watchersByTask[t.id] || [],
          taskGroup: taskGroupByTaskAndUser[`${t.id}:${p.id}`] || null,
        })),
    }))
    .sort((a: any, b: any) => a.userName.localeCompare(b.userName));

  // ── Form options for "add/edit task" ────────────────────────────
  // Full project catalog is loaded once here (not searched per-keystroke) —
  // the picker filters it client-side, which is far faster than a network
  // round trip on every keystroke.
  const { data: allProjects } = await admin
    .from("projects").select("id, name").eq("company_id", page.company_id).is("deleted_at", null).order("name");
  const { data: matterFieldForCatalog } = await admin
    .from("company_custom_fields").select("id")
    .eq("company_id", page.company_id).eq("table_name", "projects").eq("field_key", "matter_number").maybeSingle();
  let matterByProjectCatalog: Record<string, string> = {};
  if (matterFieldForCatalog && allProjects?.length) {
    // Don't filter by .in(record_id, ...) with hundreds of IDs — hits URL
    // limits and silently returns nothing. Fetch all values for this field
    // (already scoped to this company via field_id) and map in memory.
    const { data: values } = await admin
      .from("company_custom_field_values").select("record_id, value_text")
      .eq("field_id", matterFieldForCatalog.id);
    matterByProjectCatalog = Object.fromEntries((values || []).map((v: any) => [v.record_id, v.value_text || ""]));
  }

  const { data: statuses } = await admin
    .from("task_statuses").select("id, label").eq("is_active", true).order("display_order");
  const { data: teams } = await admin
    .from("teams").select("id, team_name").eq("company_id", page.company_id).eq("is_active", true);

  return NextResponse.json({
    title: page.title,
    scopeName,
    scope: page.scope,
    columns: page.columns,
    companyId: page.company_id,
    tabs,
    formOptions: {
      projects: (allProjects || []).map((p: any) => ({ id: p.id, name: p.name, matterNumber: matterByProjectCatalog[p.id] || null })),
      statuses: statuses || [],
      teams: teams || [],
      assignees: (targetProfiles || []).map((p: any) => ({ id: p.id, name: p.full_name || p.email || "Unknown" })),
    },
  });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ pageId: string }> }) {
  const { pageId } = await params;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const auth = await loadPageAndAuthorize(admin, pageId, user.id);
  if (auth.error) return auth.error;
  const { page, targetUserIds } = auth;

  let body: any;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const { name, projectId, dueDate, dueTime, statusId, teamId, assigneeId, notes, watcherIds } = body;
  if (!name?.trim()) return NextResponse.json({ error: "Task name is required" }, { status: 400 });
  if (!projectId) return NextResponse.json({ error: "Project is required" }, { status: 400 });

  const { data: project } = await admin.from("projects").select("id, company_id").eq("id", projectId).maybeSingle();
  if (!project || project.company_id !== page.company_id) {
    return NextResponse.json({ error: "Invalid project" }, { status: 400 });
  }

  let finalAssigneeId: string | null = assigneeId || null;
  if (finalAssigneeId && !targetUserIds.includes(finalAssigneeId)) {
    return NextResponse.json({ error: "Assignee is outside this page's scope" }, { status: 400 });
  }
  if (!finalAssigneeId && targetUserIds.includes(user.id)) finalAssigneeId = user.id;

  const { data: task, error } = await admin.from("tasks").insert({
    project_id: projectId,
    company_id: page.company_id,
    name: name.trim(),
    due_date: dueDate || null,
    due_time: dueTime || null,
    status_id: statusId || null,
    assigned_team_id: teamId || null,
    assignee_id: finalAssigneeId,
    notes: notes || null,
    created_by: user.id,
    date_entered: new Date().toISOString().split("T")[0],
    is_completed: false,
  }).select().single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await logTaskActivity(admin, { taskId: task.id, companyId: page.company_id, actorId: user.id, action: "created" });

  if (Array.isArray(watcherIds) && watcherIds.length) {
    await admin.from("task_watchers").insert(watcherIds.map((profile_id: string) => ({ task_id: task.id, company_id: page.company_id, profile_id, created_by: user.id })));
  }

  return NextResponse.json({ ok: true, task });
}
