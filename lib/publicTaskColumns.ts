// lib/publicTaskColumns.ts
// Optional columns an admin/team-leader/user can pick when configuring a
// public task report page. Task name is always shown and isn't in this list.

export const PUBLIC_TASK_COLUMNS = [
  { key: "project_name", label: "Project" },
  { key: "matter_number", label: "Matter number" },
  { key: "due_date", label: "Due date" },
  { key: "due_time", label: "Due time" },
  { key: "status", label: "Status" },
  { key: "team", label: "Team" },
  { key: "estimated_cost", label: "Estimated cost" },
  { key: "date_entered", label: "Date entered" },
  { key: "created_by", label: "Created by" },
] as const;

export type PublicTaskColumnKey = typeof PUBLIC_TASK_COLUMNS[number]["key"];

export const SCOPE_LABELS: Record<string, string> = {
  self: "Just my tasks",
  team: "My team's tasks",
  company: "Everyone's tasks",
};
