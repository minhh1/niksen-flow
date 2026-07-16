// lib/daysLeft.ts
// Shared "days left" label for a task's due date — used in the Checklist
// View and the public task page (kept in sync there; the Gmail add-on has
// its own copy of this logic since Apps Script can't import from here).

export interface DaysLeftInfo {
  text: string;
  colorClass: string; // Tailwind text color class
}

export function getDaysLeft(dueDate: string | null, isCompleted: boolean): DaysLeftInfo | null {
  if (!dueDate || isCompleted) return null;

  const due = new Date(String(dueDate).slice(0, 10) + "T23:59:59");
  const now = new Date();
  const diffMs = due.getTime() - now.getTime();
  const diffDays = Math.ceil(diffMs / 86_400_000);

  if (diffDays < 0) {
    const n = Math.abs(diffDays);
    return { text: `${n} day${n !== 1 ? "s" : ""} overdue`, colorClass: "text-red-500" };
  }
  if (diffDays === 0) return { text: "Due today", colorClass: "text-red-500" };
  if (diffDays === 1) return { text: "Due tomorrow", colorClass: "text-orange-500" };
  if (diffDays <= 3) return { text: `Due in ${diffDays} days`, colorClass: "text-orange-500" };
  if (diffDays <= 7) return { text: `Due in ${diffDays} days`, colorClass: "text-amber-500" };
  if (diffDays <= 14) return { text: `Due in ${diffDays} days`, colorClass: "text-emerald-600" };
  const weeks = Math.floor(diffDays / 7);
  return { text: `Due in ${weeks} week${weeks !== 1 ? "s" : ""}`, colorClass: "text-emerald-600" };
}
