// app/api/public-tasks/[pageId]/tasks/[taskId]/route.ts
// Update (including toggle-complete) or soft-delete a task from the public
// task page. Authorization mirrors app/api/public-tasks/[pageId]/route.ts.
import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabaseServer";
import { createClient } from "@supabase/supabase-js";
import { loadPageAndAuthorize } from "@/lib/publicTaskPageAuth";
import { describeTaskChanges, logTaskActivity } from "@/lib/taskActivityLog";
import { saveTaskWatchers } from "@/lib/taskWatchers";
import { TASK_GROUP_LABELS, type TaskGroup } from "@/lib/taskGroup";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ pageId: string; taskId: string }> }) {
  const { pageId, taskId } = await params;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const auth = await loadPageAndAuthorize(admin, pageId, user.id);
  if (auth.error) return auth.error;
  const { page, targetUserIds } = auth;

  const { data: existing } = await admin.from("tasks").select(
    "id, company_id, name, due_date, due_time, assignee_id, assigned_team_id, is_monetary, estimated_cost, notes, is_completed, awaiting_follow_up, follow_up_date"
  ).eq("id", taskId).maybeSingle();
  if (!existing || existing.company_id !== page.company_id) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  let body: any;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const update: Record<string, any> = {};
  if (body.name !== undefined) {
    if (!body.name.trim()) return NextResponse.json({ error: "Task name is required" }, { status: 400 });
    update.name = body.name.trim();
  }
  if (body.dueDate !== undefined) update.due_date = body.dueDate || null;
  if (body.dueTime !== undefined) update.due_time = body.dueTime || null;
  if (body.statusId !== undefined) update.status_id = body.statusId || null;
  if (body.teamId !== undefined) update.assigned_team_id = body.teamId || null;
  if (body.isMonetary !== undefined) update.is_monetary = !!body.isMonetary;
  if (body.estimatedCost !== undefined) update.estimated_cost = body.estimatedCost || null;
  if (body.isCompleted !== undefined) update.is_completed = !!body.isCompleted;
  if (body.awaitingFollowUp !== undefined) update.awaiting_follow_up = !!body.awaitingFollowUp;
  if (body.followUpDate !== undefined) update.follow_up_date = body.followUpDate || null;
  if (body.notes !== undefined) update.notes = body.notes || null;
  if (body.assigneeId !== undefined) {
    if (body.assigneeId && !targetUserIds.includes(body.assigneeId)) {
      return NextResponse.json({ error: "Assignee is outside this page's scope" }, { status: 400 });
    }
    update.assignee_id = body.assigneeId || null;
  }

  if (Object.keys(update).length === 0 && body.watcherIds === undefined && body.taskGroup === undefined) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  if (Object.keys(update).length > 0) {
    const { error } = await admin.from("tasks").update(update).eq("id", taskId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (Array.isArray(body.watcherIds)) {
    await saveTaskWatchers(admin, { taskId, companyId: page.company_id, newIds: body.watcherIds, actorId: user.id });
  }

  // Organised-view classification — scoped to whichever tab (assignee or
  // watcher) it was moved in, not the task globally, so the same task can
  // sit in different buckets for different people.
  if (body.taskGroup !== undefined) {
    const forUserId = body.forUserId;
    if (!forUserId || !targetUserIds.includes(forUserId)) {
      return NextResponse.json({ error: "Missing or invalid forUserId" }, { status: 400 });
    }
    if (body.taskGroup) {
      await admin.from("task_group_overrides")
        .upsert({ task_id: taskId, company_id: page.company_id, profile_id: forUserId, task_group: body.taskGroup, updated_at: new Date().toISOString() }, { onConflict: "task_id,profile_id" });
    } else {
      await admin.from("task_group_overrides").delete().eq("task_id", taskId).eq("profile_id", forUserId);
    }
  }

  const bodyKeys = Object.keys(body);
  if (bodyKeys.length === 1 && body.isCompleted !== undefined) {
    await logTaskActivity(admin, { taskId, companyId: page.company_id, actorId: user.id, action: body.isCompleted ? "completed" : "reopened" });
  } else if (body.name === undefined && body.awaitingFollowUp !== undefined) {
    await logTaskActivity(admin, {
      taskId, companyId: page.company_id, actorId: user.id,
      action: body.awaitingFollowUp ? "follow_up_set" : "follow_up_cleared",
      detail: body.awaitingFollowUp && body.followUpDate ? `follow-up date: ${body.followUpDate}` : null,
    });
  } else if (bodyKeys.length === 2 && body.taskGroup !== undefined && body.forUserId !== undefined) {
    const label = body.taskGroup ? TASK_GROUP_LABELS[body.taskGroup as TaskGroup] || body.taskGroup : "auto";
    await logTaskActivity(admin, { taskId, companyId: page.company_id, actorId: user.id, action: "updated", detail: `moved to "${label}"` });
  } else {
    const after: any = {};
    if (update.name !== undefined) after.name = update.name;
    if (update.due_date !== undefined) after.due_date = update.due_date;
    if (update.due_time !== undefined) after.due_time = update.due_time;
    if (update.assignee_id !== undefined) after.assignee_id = update.assignee_id;
    if (update.assigned_team_id !== undefined) after.assigned_team_id = update.assigned_team_id;
    if (update.is_monetary !== undefined) after.is_monetary = update.is_monetary;
    if (update.estimated_cost !== undefined) after.estimated_cost = update.estimated_cost;
    if (update.notes !== undefined) after.notes = update.notes;

    let lookupProfiles: { id: string; full_name: string | null; email: string | null }[] = [];
    let lookupTeams: { id: string; team_name: string }[] = [];
    if (after.assignee_id !== undefined) {
      const { data: memberships } = await admin.from("company_memberships").select("user_id").eq("company_id", page.company_id);
      const memberIds = (memberships || []).map((m: any) => m.user_id);
      if (memberIds.length) {
        const { data } = await admin.from("profiles").select("id, full_name, email").in("id", memberIds);
        lookupProfiles = data || [];
      }
    }
    if (after.assigned_team_id !== undefined) {
      const { data } = await admin.from("teams").select("id, team_name").eq("is_active", true);
      lookupTeams = data || [];
    }
    const changes = describeTaskChanges(existing, after, { profiles: lookupProfiles, teams: lookupTeams });
    if (changes.length) {
      await logTaskActivity(admin, { taskId, companyId: page.company_id, actorId: user.id, action: "updated", detail: changes.join(", ") });
    }
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ pageId: string; taskId: string }> }) {
  const { pageId, taskId } = await params;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const auth = await loadPageAndAuthorize(admin, pageId, user.id);
  if (auth.error) return auth.error;
  const { page } = auth;

  const { data: existing } = await admin.from("tasks").select("id, company_id").eq("id", taskId).maybeSingle();
  if (!existing || existing.company_id !== page.company_id) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  const { error } = await admin.from("tasks").update({ deleted_at: new Date().toISOString() }).eq("id", taskId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await logTaskActivity(admin, { taskId, companyId: page.company_id, actorId: user.id, action: "deleted" });

  return NextResponse.json({ ok: true });
}
