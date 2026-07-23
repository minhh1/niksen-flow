// supabase/functions/calendar-backfill/index.ts
// One-time run — creates calendar events for all existing tasks with due dates

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } }
);
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

async function syncTask(taskId: string): Promise<void> {
  await fetch(`${SUPABASE_URL}/functions/v1/calendar-sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SERVICE_KEY}` },
    body: JSON.stringify({ action: "upsert", taskId }),
  });
}

Deno.serve(async (_req) => {
  console.log("[backfill] START");

  // Get all tasks with due dates, not deleted, no calendar event yet
  const { data: tasks, error } = await db.from("tasks")
    .select("id, name, due_date, company_id")
    .is("deleted_at", null)
    .is("calendar_event_id", null)
    .not("due_date", "is", null)
    .order("due_date", { ascending: true })
    .order("due_time", { ascending: true, nullsFirst: false });

  if (error) {
    console.error("[backfill] error:", error.message);
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  console.log(`[backfill] ${tasks?.length || 0} tasks to sync`);

  let synced = 0, failed = 0;

  // Process in batches of 5 to avoid rate limits
  const batch = 5;
  for (let i = 0; i < (tasks || []).length; i += batch) {
    const chunk = (tasks || []).slice(i, i + batch);
    await Promise.all(chunk.map(async (t: any) => {
      try {
        await syncTask(t.id);
        synced++;
        console.log(`[backfill] ✓ ${t.name} (${t.due_date})`);
      } catch (err: any) {
        failed++;
        console.error(`[backfill] ✗ ${t.name}:`, err.message);
      }
    }));
    // Small delay between batches
    if (i + batch < (tasks || []).length) await new Promise(r => setTimeout(r, 500));
  }

  console.log(`[backfill] DONE — synced=${synced} failed=${failed}`);
  return new Response(JSON.stringify({ ok: true, synced, failed }), {
    headers: { "Content-Type": "application/json" },
  });
});