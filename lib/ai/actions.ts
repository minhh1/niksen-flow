// lib/ai/actions.ts
// Task/project mutation logic for the Teams bot's "act on the app"
// capability (see app/api/teams/bot/[companyId]/route.ts). Modeled
// directly on the existing server-side precedents for creating/updating
// tasks and projects -- app/api/public-tasks/[pageId]/route.ts,
// .../tasks/[taskId]/route.ts, and app/api/gmail/addon/create-project/route.ts
// -- reusing the same side-effect helpers (logTaskActivity,
// triggerCalendarSync) so a bot-created task behaves identically to one
// created through the UI, rather than reinventing task/project mutation
// from scratch.
import { logTaskActivity } from "@/lib/taskActivityLog";
import { triggerCalendarSync } from "@/lib/triggerCalendarSync";

export interface ResolvedMatch {
  id: string;
  name: string;
}

export type ResolveResult =
  | { status: "found"; match: ResolvedMatch }
  | { status: "ambiguous"; candidates: ResolvedMatch[] }
  | { status: "not_found" };

function pickBestMatch(name: string, candidates: ResolvedMatch[]): ResolveResult {
  if (candidates.length === 0) return { status: "not_found" };
  if (candidates.length === 1) return { status: "found", match: candidates[0] };
  const exact = candidates.find((c) => c.name.toLowerCase() === name.toLowerCase());
  if (exact) return { status: "found", match: exact };
  return { status: "ambiguous", candidates };
}

export async function resolveProjectByName(admin: any, companyId: string, name: string): Promise<ResolveResult> {
  const { data } = await admin
    .from("projects")
    .select("id, name")
    .eq("company_id", companyId)
    .is("deleted_at", null)
    .ilike("name", `%${name}%`);
  return pickBestMatch(name, (data ?? []) as ResolvedMatch[]);
}

export async function resolveTaskByName(admin: any, companyId: string, name: string): Promise<ResolveResult> {
  const { data } = await admin
    .from("tasks")
    .select("id, name")
    .eq("company_id", companyId)
    .is("deleted_at", null)
    .ilike("name", `%${name}%`);
  return pickBestMatch(name, (data ?? []) as ResolvedMatch[]);
}

// Scoped to this company's members (not every profile in the system) --
// same company_memberships join app/api/public-tasks/.../route.ts uses to
// build its assignee picker.
export async function resolveProfileByName(admin: any, companyId: string, name: string): Promise<ResolveResult> {
  const { data: memberships } = await admin.from("company_memberships").select("user_id").eq("company_id", companyId);
  const memberIds = (memberships ?? []).map((m: { user_id: string }) => m.user_id);
  if (!memberIds.length) return { status: "not_found" };

  const { data: profiles } = await admin.from("profiles").select("id, full_name, email").in("id", memberIds);
  const lower = name.toLowerCase();
  const candidates: ResolvedMatch[] = (profiles ?? [])
    .filter((p: { full_name: string | null; email: string | null }) =>
      (p.full_name ?? "").toLowerCase().includes(lower) || (p.email ?? "").toLowerCase().includes(lower)
    )
    .map((p: { id: string; full_name: string | null; email: string | null }) => ({ id: p.id, name: p.full_name || p.email || "Unknown" }));
  return pickBestMatch(name, candidates);
}

// task_statuses is a global lookup table (no company_id column) -- verified
// against the live schema 2026-07-23.
export async function resolveStatusByLabel(admin: any, label: string): Promise<ResolveResult> {
  const { data } = await admin.from("task_statuses").select("id, label").eq("is_active", true).ilike("label", `%${label}%`);
  const candidates: ResolvedMatch[] = (data ?? []).map((s: { id: string; label: string }) => ({ id: s.id, name: s.label }));
  return pickBestMatch(label, candidates);
}

export interface CreateTaskParams {
  name: string;
  projectId: string;
  dueDate?: string | null;
  assigneeId?: string | null;
  notes?: string | null;
}

export async function createTask(admin: any, companyId: string, userId: string, params: CreateTaskParams) {
  const { data: task, error } = await admin
    .from("tasks")
    .insert({
      project_id: params.projectId,
      company_id: companyId,
      name: params.name.trim(),
      due_date: params.dueDate || null,
      assignee_id: params.assigneeId || null,
      notes: params.notes || null,
      created_by: userId,
      date_entered: new Date().toISOString().split("T")[0],
      is_completed: false,
    })
    .select()
    .single();
  if (error) throw new Error(error.message);

  await logTaskActivity(admin, { taskId: task.id, companyId, actorId: userId, action: "created" });
  if (task.due_date) triggerCalendarSync(task.id, "upsert");
  return task;
}

export interface UpdateTaskParams {
  taskId: string;
  name?: string;
  dueDate?: string | null;
  assigneeId?: string | null;
  notes?: string | null;
  statusId?: string | null;
  isCompleted?: boolean;
}

export async function updateTask(admin: any, companyId: string, userId: string, params: UpdateTaskParams) {
  const update: Record<string, unknown> = {};
  if (params.name !== undefined) update.name = params.name.trim();
  if (params.dueDate !== undefined) update.due_date = params.dueDate || null;
  if (params.assigneeId !== undefined) update.assignee_id = params.assigneeId || null;
  if (params.notes !== undefined) update.notes = params.notes || null;
  if (params.statusId !== undefined) update.status_id = params.statusId || null;
  if (params.isCompleted !== undefined) update.is_completed = params.isCompleted;

  const { error } = await admin.from("tasks").update(update).eq("id", params.taskId).eq("company_id", companyId);
  if (error) throw new Error(error.message);

  triggerCalendarSync(params.taskId, params.isCompleted === true ? "complete" : "upsert");
  await logTaskActivity(admin, { taskId: params.taskId, companyId, actorId: userId, action: "updated" });
}

export interface CreateProjectParams {
  name: string;
  description?: string | null;
  status?: string;
}

export async function createProject(admin: any, companyId: string, userId: string, params: CreateProjectParams) {
  const { data: project, error } = await admin
    .from("projects")
    .insert({
      company_id: companyId,
      name: params.name.trim(),
      status: params.status || "Open",
      description: params.description || null,
      created_by: userId,
    })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return project;
}

export interface UpdateProjectParams {
  projectId: string;
  name?: string;
  description?: string | null;
  status?: string;
}

export async function updateProject(admin: any, companyId: string, params: UpdateProjectParams) {
  const update: Record<string, unknown> = {};
  if (params.name !== undefined) update.name = params.name.trim();
  if (params.description !== undefined) update.description = params.description || null;
  if (params.status !== undefined) update.status = params.status;

  const { error } = await admin.from("projects").update(update).eq("id", params.projectId).eq("company_id", companyId);
  if (error) throw new Error(error.message);
}
