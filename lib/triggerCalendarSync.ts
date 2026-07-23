// lib/triggerCalendarSync.ts
// Fire-and-forget call to the calendar-sync edge function — same trigger
// the Gmail Add-on's edge function uses, so task changes made from the web
// app (public page, main app) also sync a calendar event, not only ones
// made through the add-on. Server-side only (needs the service role key).
export function triggerCalendarSync(taskId: string, action: "upsert" | "delete" | "complete"): void {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  fetch(`${supabaseUrl}/functions/v1/calendar-sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceRoleKey}` },
    body: JSON.stringify({ action, taskId }),
  }).catch(err => console.error("[calendar-sync] trigger failed:", err?.message));
}
