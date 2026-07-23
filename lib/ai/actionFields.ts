// lib/ai/actionFields.ts
// Merges the hardcoded built-in field catalog for create_task/create_project
// with a company's custom fields (company_custom_fields) and its
// teams_bot_action_field_settings overrides into one ordered list the
// Teams bot's slot-filling state machine (lib/ai/actionAdvance.ts) and tool
// schemas (lib/ai/actionTools.ts) both consume -- see
// app/api/teams/bot/[companyId]/route.ts.
//
// "name" (both actions) and "project_name" (create_task only) are always
// required and are not configurable here -- they're the minimum needed to
// even identify what's being created, unrelated to this per-company
// required/default mechanism.
export type ActionType = "create_task" | "create_project";
export type FieldKind = "text" | "date" | "time" | "reference:project" | "reference:profile" | "reference:entity" | "select";

export interface FieldDef {
  key: string;
  label: string;
  kind: FieldKind;
  alwaysRequired: boolean;
  required: boolean;
  defaultValue: string | null;
  isCustom: boolean;
  customFieldId?: string;
  fieldType?: string; // company_custom_fields.field_type, custom fields only
  selectOptions?: string[];
  isUnique?: boolean; // company_custom_fields.is_unique, custom fields only
}

const TABLE_NAME_BY_ACTION: Record<ActionType, "tasks" | "projects"> = {
  create_task: "tasks",
  create_project: "projects",
};

// Built-ins only -- required/defaultValue/isCustom are filled in by
// loadFieldConfig below (they depend on this company's overrides).
// defaultRequired overrides the per-action fallback (see loadFieldConfig)
// for a specific field when unconfigured -- due_time should never be asked
// unless the user actually mentions a time, unlike create_task's other
// optional built-ins which default to required ("ask everything").
const BUILTIN_FIELDS: Record<ActionType, Array<Pick<FieldDef, "key" | "label" | "kind" | "alwaysRequired"> & { defaultRequired?: boolean }>> = {
  create_task: [
    { key: "name", label: "Task name", kind: "text", alwaysRequired: true },
    { key: "project_name", label: "Project (name or matter number)", kind: "reference:project", alwaysRequired: true },
    { key: "due_date", label: "Due date (YYYY-MM-DD)", kind: "date", alwaysRequired: false },
    { key: "due_time", label: "Due time (HH:MM, 24-hour)", kind: "time", alwaysRequired: false, defaultRequired: false },
    { key: "assignee_name", label: "Assignee", kind: "reference:profile", alwaysRequired: false },
    { key: "notes", label: "Notes", kind: "text", alwaysRequired: false },
  ],
  create_project: [
    { key: "name", label: "Project name", kind: "text", alwaysRequired: true },
    { key: "status", label: "Status", kind: "text", alwaysRequired: false },
    { key: "description", label: "Description", kind: "text", alwaysRequired: false },
  ],
};

export async function loadFieldConfig(admin: any, companyId: string, actionType: ActionType): Promise<FieldDef[]> {
  const tableName = TABLE_NAME_BY_ACTION[actionType];

  const [{ data: customFieldRows }, { data: settingsRows }] = await Promise.all([
    admin
      .from("company_custom_fields")
      .select("id, field_key, label, field_type, select_options, is_unique, display_order")
      .eq("company_id", companyId)
      .eq("table_name", tableName)
      .is("deleted_at", null)
      .order("display_order"),
    admin
      .from("teams_bot_action_field_settings")
      .select("field_key, required, default_value")
      .eq("company_id", companyId)
      .eq("action_type", actionType),
  ]);

  const settingsByKey = new Map<string, { required: boolean; default_value: string | null }>(
    (settingsRows ?? []).map((s: { field_key: string; required: boolean; default_value: string | null }) => [s.field_key, s])
  );

  const builtins: FieldDef[] = BUILTIN_FIELDS[actionType].map((f) => {
    const override = settingsByKey.get(f.key);
    // Fallback when unconfigured: create_task's built-in optional fields
    // default to required (bot asks everything for a task out of the box);
    // create_project's built-ins default to not required, matching today.
    // A field can override this via defaultRequired (e.g. due_time should
    // never be asked unless the user actually mentions a time).
    const fallbackRequired = f.defaultRequired !== undefined ? f.defaultRequired : actionType === "create_task";
    return {
      ...f,
      isCustom: false,
      required: f.alwaysRequired ? true : override ? override.required : fallbackRequired,
      defaultValue: f.alwaysRequired ? null : override ? override.default_value : null,
    };
  });

  const customFields: FieldDef[] = (customFieldRows ?? []).map(
    (cf: { id: string; field_key: string; label: string; field_type: string; select_options: string[] | null; is_unique: boolean }) => {
      const override = settingsByKey.get(cf.field_key);
      const kind: FieldKind =
        cf.field_type === "select" ? "select" : cf.field_type === "date" ? "date" : cf.field_type === "entity" ? "reference:entity" : "text";
      return {
        key: cf.field_key,
        label: cf.label,
        kind,
        alwaysRequired: false,
        // Custom fields default to not required whether on tasks or
        // projects -- only create_task's *built-in* fields get the
        // "ask everything" fallback above.
        required: override ? override.required : false,
        defaultValue: override ? override.default_value : null,
        isCustom: true,
        customFieldId: cf.id,
        fieldType: cf.field_type,
        selectOptions: cf.select_options ?? undefined,
        isUnique: cf.is_unique,
      };
    }
  );

  return [...builtins, ...customFields];
}
