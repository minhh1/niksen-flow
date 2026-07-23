// lib/ai/actionTools.ts
// Tool/function-calling schemas for the Teams bot's "act on the app"
// capability (see app/api/teams/bot/[companyId]/route.ts and
// lib/ai/actions.ts). Field names here are the human-readable strings the
// model is asked to extract (project_name, assignee_name) -- resolving
// those to real project_id/assignee_id happens after the model call, in
// lib/ai/actions.ts's resolve* functions, never trusted from the model
// directly. Together AI's chat completions endpoint supports this
// OpenAI-style `tools` shape (confirmed against their docs 2026-07-23).
//
// Observed in testing: with tool_choice "auto", the model called
// create_project (inventing the placeholder name "My Project") in response
// to a plain "Hi are you live?" -- a casual message with zero actual
// request to create anything. Passing `tools` alone isn't enough; the
// system prompt needs to explicitly discourage speculative tool calls, or
// the model treats "a tool exists" as license to use it. This message is
// appended as its own system message (see the bot route) only for the
// tool-calling call, not the plain RAG chat path, which has no tools to
// misuse in the first place.
export const TOOL_USE_GUARDRAILS =
  "You also have tools for creating/updating tasks and projects. Only call one of these when the user is clearly and explicitly asking you to create or change something specific, using real details they actually provided. Never invent a placeholder name, project, or value to fill a required field. For greetings, small talk, or questions that aren't a clear action request, respond normally in plain text without calling any tool. If a request is action-like but missing a required detail (e.g. no project name for a new task), ask a clarifying question in plain text instead of guessing or calling a tool with incomplete or invented information. If the user refers back to something already in the conversation instead of restating it -- e.g. \"create the above task\", \"create above task\", \"make this a task\", \"add that as a project\" -- use the actual text of the message(s) they're pointing to (usually the immediately preceding message) to fill in the corresponding field (e.g. the referenced message's full text becomes the task/project name) instead of asking for it again or leaving it blank. Copy that referenced text verbatim -- never summarize, shorten, or paraphrase it into your own wording.";

import type { FieldDef } from "./actionFields";

// create_task/create_project gain one extra string property per *custom*
// field configured for this company (see lib/ai/actionFields.ts) -- this
// lets the model capture something like "matter number 2026-114" directly
// from a rich first message instead of always having to be asked for it
// separately. Built-in optional fields are already static properties below
// and aren't duplicated here.
function slugify(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "value";
}

// Maps each field to the JSON property name the model is asked to use.
// Built-ins keep their existing key (already semantic: due_date, notes,
// ...); custom fields get a slug of their *label* instead of their often-
// opaque field_key (e.g. "field_1783322037432"). Observed in testing: the
// model doesn't reliably echo back an opaque key in its function-call
// output -- for a "Client Name" field keyed "field_1783322037432" it
// silently substituted its own more natural key ("client") instead, so the
// answer never landed on the real field. A readable slug fixes that. Two
// custom fields sharing a label get a numeric suffix to stay unique.
// Callers regenerate this same map from the same field list to translate
// the model's response keys back to each field's real .key (see
// translateFieldAnswers below) -- it's not returned/stored anywhere.
export function propertyKeysForFields(fields: FieldDef[]): Map<string, FieldDef> {
  const used = new Set<string>();
  const map = new Map<string, FieldDef>();
  for (const field of fields) {
    if (!field.isCustom) {
      map.set(field.key, field);
      used.add(field.key);
      continue;
    }
    let slug = slugify(field.label);
    let suffix = 2;
    while (used.has(slug)) slug = `${slugify(field.label)}_${suffix++}`;
    used.add(slug);
    map.set(slug, field);
  }
  return map;
}

// Translates a model's extracted answers (keyed by whatever property names
// buildActionTools/buildMissingFieldsTool exposed, per propertyKeysForFields
// above) back into each field's real .key for storage in "collected".
// Drops any key the model invented that doesn't match a known field --
// there's nowhere safe to put it.
export function translateFieldAnswers(fields: FieldDef[], answers: Record<string, unknown>): Record<string, string> {
  const keyMap = propertyKeysForFields(fields);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(answers)) {
    if (value === undefined || value === null) continue;
    const str = String(value).trim();
    if (!str) continue;
    const field = keyMap.get(key);
    if (field) result[field.key] = str;
  }
  return result;
}

function customFieldProperties(fields: FieldDef[]): Record<string, { type: string; description: string }> {
  const properties: Record<string, { type: string; description: string }> = {};
  for (const [key, field] of propertyKeysForFields(fields)) {
    if (!field.isCustom) continue;
    properties[key] = {
      type: "string",
      description: field.selectOptions?.length ? `${field.label} (one of: ${field.selectOptions.join(", ")})` : field.label,
    };
  }
  return properties;
}

const UPDATE_TASK_TOOL = {
  type: "function",
  function: {
    name: "update_task",
    description: "Update an existing task's fields. Only include fields the user actually wants changed.",
    parameters: {
      type: "object",
      properties: {
        task_name: { type: "string", description: "The name of the existing task to update." },
        new_name: { type: "string", description: "A new name for the task, if it should be renamed." },
        due_date: { type: "string", description: "New due date in YYYY-MM-DD format, if changing." },
        assignee_name: { type: "string", description: "New assignee's name, if changing." },
        status: { type: "string", description: "New status label (e.g. Done, In Progress), if changing." },
        is_completed: { type: "boolean", description: "Whether to mark the task complete or reopen it." },
        notes: { type: "string", description: "New notes, if changing." },
      },
      required: ["task_name"],
    },
  },
};

const UPDATE_PROJECT_TOOL = {
  type: "function",
  function: {
    name: "update_project",
    description: "Update an existing project's fields. Only include fields the user actually wants changed.",
    parameters: {
      type: "object",
      properties: {
        project_name: { type: "string", description: "The existing project to update -- its name OR a known identifier like a matter number." },
        new_name: { type: "string", description: "A new name for the project, if it should be renamed." },
        description: { type: "string", description: "New description, if changing." },
        status: { type: "string", description: "New status (e.g. Open, Closed), if changing." },
      },
      required: ["project_name"],
    },
  },
};

const CREATE_FILE_TOOL = {
  type: "function",
  function: {
    name: "create_file",
    description: "Create a new file/document in the company's OneDrive/SharePoint. The content is drafted from the instructions, not typed in directly.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "The file's name/title, ONLY if the user actually stated one -- omit rather than inventing one." },
        instructions: {
          type: "string",
          description: "What the file should say -- e.g. \"a letter to the client about the settlement offer\" -- only if the user actually gave real instructions, not invented.",
        },
        project_name: { type: "string", description: "Which project this relates to, if mentioned -- used to file it in that project's folder. Optional." },
      },
      required: [],
    },
  },
};

const UPDATE_FILE_TOOL = {
  type: "function",
  function: {
    name: "update_file",
    description: "Update an existing OneDrive/SharePoint file with new content drafted from instructions.",
    parameters: {
      type: "object",
      properties: {
        file_name: { type: "string", description: "The name of the existing file to update, only if stated." },
        instructions: { type: "string", description: "What should change or be added, only if actually given." },
      },
      required: [],
    },
  },
};

// Built with this company's field config so create_task/create_project's
// schemas reflect its custom fields -- called once per bot message (see
// app/api/teams/bot/[companyId]/route.ts). update_task/update_project are
// untouched: Phase G (required/default fields) only changes creation.
export function buildActionTools(taskFields: FieldDef[], projectFields: FieldDef[]) {
  return [
    {
      type: "function",
      function: {
        name: "create_task",
        description: "Create a new task in a project.",
        parameters: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description:
                "The task's name/title. If the user references a prior message instead of stating one directly (e.g. \"create the above task\", \"create above task\", \"make this a task\"), use the COMPLETE, VERBATIM text of the message they're pointing to (usually the one immediately before) as the name -- copy it exactly, do not summarize, shorten, paraphrase, or rewrite it into your own words. Otherwise, ONLY fill this in if the user actually stated a name -- omit this property entirely rather than inventing a placeholder.",
            },
            project_name: {
              type: "string",
              description:
                "The project this task belongs to, only if mentioned -- this can be the project's name OR a known identifier like a matter number (e.g. \"matter number 230005\" -> extract just \"230005\", not the whole phrase).",
            },
            due_date: { type: "string", description: "Due date in YYYY-MM-DD format, if mentioned." },
            due_time: {
              type: "string",
              description: "Due time in 24-hour HH:MM format, ONLY if the user actually mentioned a specific time (e.g. \"3pm\" -> \"15:00\") -- never invent one, it's fine to leave a task with no time.",
            },
            assignee_name: { type: "string", description: "Name of the person to assign the task to, if mentioned." },
            notes: { type: "string", description: "Any additional notes or details for the task." },
            ...customFieldProperties(taskFields),
          },
          // Deliberately empty -- name/project_name ARE required before a
          // task can actually be created, but that's enforced by
          // lib/ai/actionAdvance.ts (which asks for whatever's missing)
          // after this call, not by this schema. Observed in testing: with
          // "name" listed here as JSON-schema required, the model invented
          // a placeholder ("Test Project") to satisfy the schema rather
          // than omitting it, silently skipping the "what should this be
          // called?" question entirely. An empty `required` lets the model
          // call the tool the moment it recognizes intent, without being
          // structurally pressured to fabricate any value.
          required: [],
        },
      },
    },
    UPDATE_TASK_TOOL,
    {
      type: "function",
      function: {
        name: "create_project",
        description: "Create a new project.",
        parameters: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description:
                "The project's name. If the user references a prior message instead of stating one directly (e.g. \"create the above as a project\", \"make this a project\"), use the COMPLETE, VERBATIM text of the message they're pointing to as the name -- copy it exactly, do not summarize, shorten, paraphrase, or rewrite it into your own words. Otherwise, ONLY fill this in if the user actually stated a name -- omit this property entirely rather than inventing a placeholder.",
            },
            description: { type: "string", description: "A description of the project, if mentioned." },
            status: { type: "string", description: "Initial status, if mentioned (defaults to Open)." },
            ...customFieldProperties(projectFields),
          },
          required: [],
        },
      },
    },
    UPDATE_PROJECT_TOOL,
    CREATE_FILE_TOOL,
    UPDATE_FILE_TOOL,
  ];
}

// A one-off schema for extracting answers out of a reply to a *batched*
// "I still need: X, Y, Z" question (see lib/ai/actionAdvance.ts) -- no
// `required` array, since the whole point is that the reply might only
// answer some of what was asked; TOOL_USE_GUARDRAILS's "never invent a
// value" instruction applies here too (passed alongside this tool by the
// caller, same as the other tool-calling call).
export function buildMissingFieldsTool(missingFields: FieldDef[]) {
  const properties: Record<string, { type: string; description: string }> = {};
  for (const [key, field] of propertyKeysForFields(missingFields)) {
    properties[key] =
      field.kind === "select" && field.selectOptions?.length
        ? { type: "string", description: `${field.label} (one of: ${field.selectOptions.join(", ")})` }
        : { type: "string", description: field.label };
  }
  return [
    {
      type: "function",
      function: {
        name: "provide_details",
        description:
          "Extract any of the requested details that the user's reply actually answers. Omit any field the reply doesn't address -- never invent or guess a value for a field that wasn't mentioned.",
        parameters: { type: "object", properties, required: [] },
      },
    },
  ];
}
