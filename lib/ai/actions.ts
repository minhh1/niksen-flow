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
import { getGraphAppToken, ensureFolderPath, uploadFile, updateFileContent } from "@/lib/msGraph/onedrive";

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

// Searches projects.name AND, per company, any additional custom fields an
// admin has nominated as project search fields (teams_bot_project_search_fields
// -- e.g. Huynh Lawyers wants "Matter Number" searchable, since staff refer
// to a matter by its number rather than the project's literal name).
// Candidates from both sources are merged (deduped by project id) before
// pickBestMatch decides found/ambiguous/not_found -- pickBestMatch's exact-
// name-wins tiebreak naturally falls through to "found on a single
// candidate" when the match came from a custom field value instead of the
// name column, which is exactly what's wanted there.
export async function resolveProjectByName(admin: any, companyId: string, name: string): Promise<ResolveResult> {
  const { data } = await admin
    .from("projects")
    .select("id, name")
    .eq("company_id", companyId)
    .is("deleted_at", null)
    .ilike("name", `%${name}%`);

  const candidates = new Map<string, ResolvedMatch>();
  for (const p of (data ?? []) as ResolvedMatch[]) candidates.set(p.id, p);

  const { data: searchFields } = await admin.from("teams_bot_project_search_fields").select("custom_field_id").eq("company_id", companyId);
  const fieldIds = (searchFields ?? []).map((f: { custom_field_id: string }) => f.custom_field_id);
  if (fieldIds.length) {
    const { data: values } = await admin
      .from("company_custom_field_values")
      .select("record_id")
      .eq("company_id", companyId)
      .eq("table_name", "projects")
      .in("field_id", fieldIds)
      .ilike("value_text", `%${name}%`);
    const recordIds = (values ?? []).map((v: { record_id: string }) => v.record_id);
    if (recordIds.length) {
      const { data: matched } = await admin.from("projects").select("id, name").eq("company_id", companyId).is("deleted_at", null).in("id", recordIds);
      for (const p of (matched ?? []) as ResolvedMatch[]) candidates.set(p.id, p);
    }
  }

  return pickBestMatch(name, Array.from(candidates.values()));
}

export async function resolveEntityByName(admin: any, companyId: string, name: string): Promise<ResolveResult> {
  const { data } = await admin
    .from("entities")
    .select("id, name")
    .eq("company_id", companyId)
    .is("deleted_at", null)
    .ilike("name", `%${name}%`);
  return pickBestMatch(name, (data ?? []) as ResolvedMatch[]);
}

// Minimal insert mirroring components/RecordCreatorField.tsx's shape --
// used when a "reference:entity" custom field value (see
// lib/ai/actionFields.ts, lib/ai/actionAdvance.ts) doesn't match any
// existing entity, so the bot creates one rather than just storing text.
export async function createEntity(admin: any, companyId: string, name: string, entityType: string = "Company"): Promise<ResolvedMatch> {
  const { data, error } = await admin
    .from("entities")
    .insert({ company_id: companyId, name: name.trim(), entity_type: entityType })
    .select("id, name")
    .single();
  if (error) throw new Error(error.message);
  return data;
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
  // Matches on full_name only -- matching against email too used to cause
  // false-positive "duplicates": every profile at a company shares the same
  // email domain (e.g. everyone @huynhco.com), so searching a first name
  // that happens to appear in the company's own domain (e.g. "Huy" inside
  // "huynhco.com") matched nearly every member, not just the actual person.
  // Assignees are referred to by name in chat, never by raw email, so
  // dropping the email fallback has no real downside here.
  const candidates: ResolvedMatch[] = (profiles ?? [])
    .filter((p: { full_name: string | null }) => (p.full_name ?? "").toLowerCase().includes(lower))
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

// Duplicate checks used by lib/ai/actionAdvance.ts before a create_task/
// create_project pending action is confirmed -- these are "does this exact
// name already exist" lookups, distinct from resolve*ByName's fuzzy partial
// match (which is for referencing an *existing* project/task/person, not
// guarding against creating a second one with the same name).
export async function findExistingProjectByName(admin: any, companyId: string, name: string): Promise<ResolvedMatch | null> {
  const { data } = await admin
    .from("projects")
    .select("id, name")
    .eq("company_id", companyId)
    .is("deleted_at", null)
    .ilike("name", name.trim());
  const exact = (data ?? []).find((p: ResolvedMatch) => p.name.trim().toLowerCase() === name.trim().toLowerCase());
  return exact ?? null;
}

// Task names only need to be unique within the same project -- the same
// task name recurring across different projects (e.g. "Kickoff call") is
// normal, unlike a project name repeating company-wide.
export async function findExistingTaskByName(admin: any, companyId: string, projectId: string, name: string): Promise<ResolvedMatch | null> {
  const { data } = await admin
    .from("tasks")
    .select("id, name")
    .eq("company_id", companyId)
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .ilike("name", name.trim());
  const exact = (data ?? []).find((t: ResolvedMatch) => t.name.trim().toLowerCase() === name.trim().toLowerCase());
  return exact ?? null;
}

export interface CustomFieldValueConflict {
  recordId: string;
  recordName: string;
}

// Checks whether a custom field flagged is_unique in company_custom_fields
// already has this value on another record, so the bot can say "X has
// already been created" instead of silently creating a duplicate matter
// number/reference code. Coerces the same way insertCustomFieldValues does,
// so the comparison uses the correct typed column.
export async function findExistingCustomFieldValue(
  admin: any,
  companyId: string,
  fieldId: string,
  fieldType: string,
  tableName: "projects" | "tasks",
  value: string
): Promise<CustomFieldValueConflict | null> {
  const column = fieldType === "number" || fieldType === "currency" ? "value_number" : fieldType === "boolean" ? "value_boolean" : fieldType === "date" ? "value_date" : "value_text";
  const coerced = column === "value_number" ? parseFloat(value) : column === "value_boolean" ? value === "true" : value;

  const { data } = await admin
    .from("company_custom_field_values")
    .select("record_id")
    .eq("company_id", companyId)
    .eq("field_id", fieldId)
    .eq("table_name", tableName)
    .eq(column, coerced)
    .limit(1)
    .maybeSingle();
  if (!data) return null;

  const { data: record } = await admin.from(tableName).select("name").eq("id", data.record_id).maybeSingle();
  return { recordId: data.record_id, recordName: record?.name ?? "an existing record" };
}

export interface CustomFieldValueInput {
  fieldId: string;
  fieldType: string;
  value: string;
  // Only meaningful when fieldType === "entity": the id of an existing
  // entities row already resolved by lib/ai/actionAdvance.ts, or null if
  // no match existed and a new entity should be created with `value` as
  // its name (see insertCustomFieldValues below).
  existingEntityId?: string | null;
}

// Same per-type coercion components/NewProjectModal.tsx:82-104 already uses
// when writing custom field values from the regular UI -- kept as one
// shared helper so a bot-created record's custom fields look identical to
// one entered by hand. "entity" fields get both value_text (the resolved
// name, so every existing renderer -- none of which read value_record_id --
// keeps displaying it correctly) and value_record_id (the real link).
export async function insertCustomFieldValues(
  admin: any,
  companyId: string,
  recordId: string,
  tableName: "projects" | "tasks",
  values: CustomFieldValueInput[]
): Promise<void> {
  if (!values.length) return;
  const rows: Record<string, unknown>[] = [];
  for (const v of values) {
    if (v.fieldType === "entity") {
      const entityId = v.existingEntityId ?? (await createEntity(admin, companyId, v.value)).id;
      rows.push({ company_id: companyId, record_id: recordId, field_id: v.fieldId, table_name: tableName, value_text: v.value, value_record_id: entityId });
      continue;
    }
    const isNum = v.fieldType === "number" || v.fieldType === "currency";
    const isBool = v.fieldType === "boolean";
    const isDate = v.fieldType === "date";
    rows.push({
      company_id: companyId,
      record_id: recordId,
      field_id: v.fieldId,
      table_name: tableName,
      ...(isNum
        ? { value_number: parseFloat(v.value) }
        : isBool
          ? { value_boolean: v.value === "true" }
          : isDate
            ? { value_date: v.value }
            : { value_text: v.value }),
    });
  }
  await admin.from("company_custom_field_values").insert(rows);
}

export interface CreateTaskParams {
  name: string;
  projectId: string;
  dueDate?: string | null;
  dueTime?: string | null;
  assigneeId?: string | null;
  notes?: string | null;
  customFieldValues?: CustomFieldValueInput[];
}

export async function createTask(admin: any, companyId: string, userId: string, params: CreateTaskParams) {
  const { data: task, error } = await admin
    .from("tasks")
    .insert({
      project_id: params.projectId,
      company_id: companyId,
      name: params.name.trim(),
      due_date: params.dueDate || null,
      due_time: params.dueTime || null,
      assignee_id: params.assigneeId || null,
      notes: params.notes || null,
      created_by: userId,
      date_entered: new Date().toISOString().split("T")[0],
      is_completed: false,
    })
    .select()
    .single();
  if (error) throw new Error(error.message);

  if (params.customFieldValues?.length) {
    await insertCustomFieldValues(admin, companyId, task.id, "tasks", params.customFieldValues);
  }
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
  customFieldValues?: CustomFieldValueInput[];
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

  if (params.customFieldValues?.length) {
    await insertCustomFieldValues(admin, companyId, project.id, "projects", params.customFieldValues);
  }
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

// Fuzzy match against files already synced in from OneDrive (onedrive_files,
// kept fresh by supabase/functions/onedrive-sync-worker) -- mirrors
// resolveTaskByName's found/ambiguous/not_found shape exactly.
export async function resolveOnedriveFileByName(admin: any, companyId: string, name: string): Promise<ResolveResult> {
  const { data } = await admin.from("onedrive_files").select("item_id, name").eq("company_id", companyId).ilike("name", `%${name}%`);
  const candidates: ResolvedMatch[] = (data ?? []).map((f: { item_id: string; name: string }) => ({ id: f.item_id, name: f.name }));
  return pickBestMatch(name, candidates);
}

async function getOnedriveGraphContext(admin: any, companyId: string): Promise<{ token: string; driveId: string }> {
  const { data: creds } = await admin.from("company_onedrive_credentials").select("credentials, drive_id").eq("company_id", companyId).maybeSingle();
  if (!creds?.drive_id) throw new Error("OneDrive isn't connected for this company -- ask an admin to connect it in Admin -> OneDrive.");
  const token = await getGraphAppToken(creds.credentials.tenant_id, creds.credentials.client_id, creds.credentials.client_secret);
  return { token, driveId: creds.drive_id };
}

export interface CreateOnedriveFileParams {
  name: string;
  projectName?: string | null;
  content: string;
}

// Files created via chat are organized under /Projects/{project name}/ when
// a project was mentioned, otherwise a default /Assistant Files/ folder --
// both created on demand. v1 writes plain text content (see lib/ai/fileDraft.ts's
// header comment on why this isn't real Word/.docx authoring yet).
export async function createOnedriveFile(admin: any, companyId: string, params: CreateOnedriveFileParams): Promise<{ name: string; webUrl: string }> {
  const { token, driveId } = await getOnedriveGraphContext(admin, companyId);
  const folderPath = params.projectName ? `Projects/${params.projectName}` : "Assistant Files";
  await ensureFolderPath(token, driveId, folderPath);
  const fileName = /\.[a-z0-9]+$/i.test(params.name) ? params.name : `${params.name}.txt`;
  const uploaded = await uploadFile(token, driveId, folderPath, fileName, params.content);
  return { name: fileName, webUrl: uploaded.webUrl };
}

export async function updateOnedriveFile(admin: any, companyId: string, itemId: string, content: string): Promise<{ webUrl: string }> {
  const { token, driveId } = await getOnedriveGraphContext(admin, companyId);
  const updated = await updateFileContent(token, driveId, itemId, content);
  return { webUrl: updated.webUrl };
}
