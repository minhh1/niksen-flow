// lib/ai/actionTools.ts
// Tool/function-calling schemas for the Teams bot's "act on the app"
// capability (see app/api/teams/bot/[companyId]/route.ts and
// lib/ai/actions.ts). Field names here are the human-readable strings the
// model is asked to extract (project_name, assignee_name) -- resolving
// those to real project_id/assignee_id happens after the model call, in
// lib/ai/actions.ts's resolve* functions, never trusted from the model
// directly. Together AI's chat completions endpoint supports this
// OpenAI-style `tools` shape (confirmed against their docs 2026-07-23).
export const ACTION_TOOLS = [
  {
    type: "function",
    function: {
      name: "create_task",
      description: "Create a new task in a project.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "The task's name/title." },
          project_name: { type: "string", description: "The name of the project this task belongs to." },
          due_date: { type: "string", description: "Due date in YYYY-MM-DD format, if mentioned." },
          assignee_name: { type: "string", description: "Name of the person to assign the task to, if mentioned." },
          notes: { type: "string", description: "Any additional notes or details for the task." },
        },
        required: ["name", "project_name"],
      },
    },
  },
  {
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
  },
  {
    type: "function",
    function: {
      name: "create_project",
      description: "Create a new project.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "The project's name." },
          description: { type: "string", description: "A description of the project, if mentioned." },
          status: { type: "string", description: "Initial status, if mentioned (defaults to Open)." },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_project",
      description: "Update an existing project's fields. Only include fields the user actually wants changed.",
      parameters: {
        type: "object",
        properties: {
          project_name: { type: "string", description: "The name of the existing project to update." },
          new_name: { type: "string", description: "A new name for the project, if it should be renamed." },
          description: { type: "string", description: "New description, if changing." },
          status: { type: "string", description: "New status (e.g. Open, Closed), if changing." },
        },
        required: ["project_name"],
      },
    },
  },
];
