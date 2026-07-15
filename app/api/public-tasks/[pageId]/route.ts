// app/api/public-tasks/[pageId]/route.ts
// Powers the embeddable public task report page. Requires a real signed-in
// session — access is scoped by the page's self/team/company configuration,
// enforced here (not via RLS) using the service-role key, same pattern as
// the Gmail add-on's /my-tasks and /team-tasks endpoints.
import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabaseServer";
import { createClient } from "@supabase/supabase-js";
import { loadPageAndAuthorize } from "@/lib/publicTaskPageAuth";

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
  const { page, targetUserIds } = auth;

  const { data: tasks } = await admin
    .from("tasks")
    .select(`
      id, name, due_date, due_time, is_completed, estimated_cost, date_entered, assignee_id, project_id,
      status_id, assigned_team_id, is_monetary, created_by,
      assignee:assignee_id(id, full_name, email),
      creator:created_by(id, full_name, email),
      project:project_id(id, name),
      task_statuses:status_id(label, color_hex),
      teams:assigned_team_id(team_name)
    `)
    .in("assignee_id", targetUserIds.length ? targetUserIds : ["00000000-0000-0000-0000-000000000000"])
    .eq("company_id", page.company_id)
    .is("deleted_at", null)
    .order("due_date", { ascending: true, nullsFirst: false });

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

  // ── Group into tabs, one per target user ────────────────────────
  const { data: targetProfiles } = await admin
    .from("profiles").select("id, full_name, email").in("id", targetUserIds.length ? targetUserIds : ["00000000-0000-0000-0000-000000000000"]);

  const tabs = (targetProfiles || [])
    .map((p: any) => ({
      userId: p.id,
      userName: p.full_name || p.email || "Unknown",
      tasks: (tasks || [])
        .filter((t: any) => t.assignee_id === p.id)
        .map((t: any) => ({
          id: t.id, name: t.name, isCompleted: t.is_completed,
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
  const { name, projectId, dueDate, dueTime, statusId, teamId, assigneeId } = body;
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
    created_by: user.id,
    date_entered: new Date().toISOString().split("T")[0],
    is_completed: false,
  }).select().single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, task });
}
