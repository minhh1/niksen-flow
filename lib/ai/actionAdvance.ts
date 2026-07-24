// lib/ai/actionAdvance.ts
// The slot-filling state machine behind the Teams bot's create_task/
// create_project flow (see app/api/teams/bot/[companyId]/route.ts). Given
// whatever field values have been gathered so far ("collected", keyed by
// lib/ai/actionFields.ts's FieldDef.key, raw human-readable strings), this
// either says what's still missing (asked for in one combined message, not
// one field per turn) or that everything's ready to confirm.
//
// A field that fails validation (an unresolvable project/assignee name, an
// invalid select option, an unparseable date, a duplicate unique value) is
// simply cleared and folded back into "still needs an answer" -- the exact
// same path a field that was never answered at all takes. This is why
// there's one shared loop instead of separate "missing" vs "invalid"
// handling.
import { loadFieldConfig, type FieldDef, type ActionType } from "./actionFields";
import {
  resolveProjectByName,
  resolveProfileByName,
  resolveEntityByName,
  findExistingProjectByName,
  findExistingTaskByName,
  findExistingCustomFieldValue,
  type CustomFieldValueInput,
} from "./actions";

export interface CollectingResult {
  status: "collecting";
  collected: Record<string, string>;
  missingFields: string[];
  question: string;
}

export interface ConfirmingResult {
  status: "confirming";
  summary: string;
  params: Record<string, unknown>;
}

export type AdvanceResult = CollectingResult | ConfirmingResult;

function questionForField(field: FieldDef): string {
  if (field.kind === "select" && field.selectOptions?.length) {
    return `${field.label} (one of: ${field.selectOptions.join(", ")})`;
  }
  return field.label;
}

function cleanLabel(label: string): string {
  return label.replace(/\s*\([^)]*\)\s*/g, "").trim();
}

function buildCombinedQuestion(fields: FieldDef[], notes: string[]): string {
  const prefix = notes.length ? notes.join(" ") + "\n\n" : "";
  const lines = fields.map((f) => `- ${questionForField(f)}`);
  return `${prefix}I need a few more details before I create this:\n${lines.join("\n")}`;
}

export async function advanceAction(
  admin: any,
  companyId: string,
  actionType: ActionType,
  collectedIn: Record<string, string>
): Promise<AdvanceResult> {
  const fields = await loadFieldConfig(admin, companyId, actionType);
  const collected: Record<string, string> = { ...collectedIn };

  // Step 1: anything required with no value at all yet?
  const missingRequired = fields.filter((f) => (f.alwaysRequired || f.required) && !collected[f.key]?.trim());
  if (missingRequired.length) {
    return {
      status: "collecting",
      collected,
      missingFields: missingRequired.map((f) => f.key),
      question: buildCombinedQuestion(missingRequired, []),
    };
  }

  // Step 2: fill in defaults for anything optional and still unset -- do
  // this before validation so a configured default also gets normalized/
  // resolved the same way a user-supplied value would.
  const wasDefaulted = new Set<string>();
  for (const f of fields) {
    if (!collected[f.key]?.trim() && f.defaultValue) {
      collected[f.key] = f.defaultValue;
      wasDefaulted.add(f.key);
    }
  }

  // Step 3: validate/resolve every field that has a value.
  const needsReask: FieldDef[] = [];
  const conflictNotes: string[] = [];
  let projectMatch: { id: string; name: string } | null = null;
  let assigneeMatch: { id: string; name: string } | null = null;
  // Keyed by field.key -- the matched existing entity, or null meaning "no
  // match, a new entity will be created with this name" (see step 4).
  const entityMatches = new Map<string, { id: string; name: string } | null>();

  for (const field of fields) {
    const raw = collected[field.key]?.trim();
    if (!raw) continue;

    if (field.kind === "reference:project") {
      const result = await resolveProjectByName(admin, companyId, raw);
      if (result.status !== "found") {
        delete collected[field.key];
        needsReask.push(field);
        conflictNotes.push(
          result.status === "ambiguous"
            ? `I found multiple projects matching "${raw}": ${result.candidates.map((c) => c.name).join(", ")}.`
            : `I couldn't find a project matching "${raw}".`
        );
        continue;
      }
      projectMatch = result.match;
    } else if (field.kind === "reference:profile") {
      const result = await resolveProfileByName(admin, companyId, raw);
      if (result.status !== "found") {
        delete collected[field.key];
        needsReask.push(field);
        conflictNotes.push(
          result.status === "ambiguous"
            ? `I found multiple people matching "${raw}": ${result.candidates.map((c) => c.name).join(", ")}.`
            : `I couldn't find anyone matching "${raw}".`
        );
        continue;
      }
      assigneeMatch = result.match;
    } else if (field.kind === "reference:entity") {
      // entities enforces UNIQUE(company_id, name) -- a second entity with
      // the exact same name literally can't be created, so an exact match
      // is simply reused (flagged in the summary, not blocked on a second
      // question the DB would reject anyway). No match -- a brand new
      // entity will be created with this name at execute time, also fine
      // without asking. Only a genuinely ambiguous partial match (e.g.
      // "Minh" matching "Minh Huynh") needs clarification.
      const result = await resolveEntityByName(admin, companyId, raw);
      if (result.status === "ambiguous") {
        delete collected[field.key];
        needsReask.push(field);
        conflictNotes.push(
          `I found multiple existing entities matching "${raw}": ${result.candidates.map((c) => c.name).join(", ")}. Can you give the exact/full name?`
        );
        continue;
      }
      entityMatches.set(field.key, result.status === "found" ? result.match : null);
    } else if (field.kind === "select") {
      const options = field.selectOptions ?? [];
      const matchedOption = options.find((o) => o.toLowerCase() === raw.toLowerCase());
      if (!matchedOption) {
        delete collected[field.key];
        needsReask.push(field);
        conflictNotes.push(`"${raw}" isn't a valid ${field.label} -- valid options are ${options.join(", ")}.`);
        continue;
      }
      collected[field.key] = matchedOption;
    } else if (field.kind === "date") {
      const parsed = Date.parse(raw);
      if (Number.isNaN(parsed)) {
        delete collected[field.key];
        needsReask.push(field);
        conflictNotes.push(`I couldn't understand the date "${raw}" -- please use YYYY-MM-DD.`);
        continue;
      }
      collected[field.key] = new Date(parsed).toISOString().slice(0, 10);
    } else if (field.kind === "time") {
      const match = raw.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
      if (!match) {
        delete collected[field.key];
        needsReask.push(field);
        conflictNotes.push(`I couldn't understand the time "${raw}" -- please use 24-hour HH:MM (e.g. 14:30).`);
        continue;
      }
      collected[field.key] = `${match[1].padStart(2, "0")}:${match[2]}`;
    }
  }

  // Uniqueness checks only run once everything else validates cleanly, so
  // a duplicate-name message doesn't show up alongside an unrelated typo
  // in the same breath.
  if (!needsReask.length) {
    const nameField = fields.find((f) => f.key === "name")!;
    const nameValue = collected.name?.trim();
    if (nameValue) {
      // Project names are always checked (companies expect them unique).
      // Task names are NOT, by default -- the same task name recurring
      // across projects (e.g. "Kickoff call") is normal, so this only runs
      // when a company has explicitly opted in via ai_chat_settings.
      let existing = null;
      if (actionType === "create_project") {
        existing = await findExistingProjectByName(admin, companyId, nameValue);
      } else if (projectMatch) {
        const { data: settings } = await admin.from("ai_chat_settings").select("require_unique_task_names").eq("company_id", companyId).maybeSingle();
        if (settings?.require_unique_task_names) {
          existing = await findExistingTaskByName(admin, companyId, projectMatch.id, nameValue);
        }
      }
      if (existing) {
        delete collected.name;
        needsReask.push(nameField);
        const noun = actionType === "create_project" ? "project" : "task";
        conflictNotes.push(`A ${noun} called "${existing.name}" already exists -- I won't create a duplicate.`);
      }
    }

    const tableName = actionType === "create_task" ? "tasks" : "projects";
    for (const field of fields) {
      if (!field.isCustom || !field.isUnique || !field.customFieldId) continue;
      const raw = collected[field.key]?.trim();
      if (!raw) continue;
      const conflict = await findExistingCustomFieldValue(admin, companyId, field.customFieldId, field.fieldType ?? "text", tableName, raw);
      if (conflict) {
        delete collected[field.key];
        needsReask.push(field);
        conflictNotes.push(`${field.label} "${raw}" is already used (on "${conflict.recordName}").`);
      }
    }
  }

  if (needsReask.length) {
    return {
      status: "collecting",
      collected,
      missingFields: needsReask.map((f) => f.key),
      question: buildCombinedQuestion(needsReask, conflictNotes),
    };
  }

  // Step 4: everything validated -- build the confirmation summary + the
  // fully-resolved params lib/ai/actions.ts's createTask/createProject expect.
  const customFieldValues: CustomFieldValueInput[] = [];
  for (const field of fields) {
    if (field.isCustom && field.customFieldId && collected[field.key]) {
      const entry: CustomFieldValueInput = { fieldId: field.customFieldId, fieldType: field.fieldType ?? "text", value: collected[field.key] };
      if (field.kind === "reference:entity") entry.existingEntityId = entityMatches.get(field.key)?.id ?? null;
      customFieldValues.push(entry);
    }
  }

  const summaryParts: string[] = [];
  for (const field of fields) {
    if (field.key === "name" || field.kind === "reference:project" || field.kind === "reference:profile") continue;
    const value = collected[field.key];
    if (!value) continue;
    const tag = field.kind === "reference:entity" ? (entityMatches.get(field.key) ? " (existing entity)" : " (new entity)") : wasDefaulted.has(field.key) ? " (default)" : "";
    // Show the weekday alongside a date value (e.g. "Monday, 2026-07-27")
    // so a mis-guessed relative date ("Monday" meant as this week vs next)
    // is obvious at a glance in the confirmation, not something the user
    // has to mentally calculate before replying "yes".
    const displayValue = field.kind === "date" ? `${new Date(`${value}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" })}, ${value}` : value;
    summaryParts.push(`${cleanLabel(field.label).toLowerCase()}: ${displayValue}${tag}`);
  }

  let summary: string;
  let params: Record<string, unknown>;
  if (actionType === "create_task") {
    summary =
      `I'll create a task "${collected.name}" in project ${projectMatch!.name}` +
      (assigneeMatch ? `, assigned to ${assigneeMatch.name}` : "") +
      (summaryParts.length ? `, ${summaryParts.join(", ")}` : "") +
      ".";
    params = {
      name: collected.name,
      projectId: projectMatch!.id,
      dueDate: collected.due_date ?? null,
      dueTime: collected.due_time ?? null,
      assigneeId: assigneeMatch?.id ?? null,
      notes: collected.notes ?? null,
      customFieldValues,
    };
  } else {
    summary = `I'll create a project "${collected.name}"${summaryParts.length ? `, ${summaryParts.join(", ")}` : ""}.`;
    params = {
      name: collected.name,
      description: collected.description ?? null,
      status: collected.status ?? undefined,
      customFieldValues,
    };
  }

  return { status: "confirming", summary, params };
}
