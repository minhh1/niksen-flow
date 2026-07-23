// supabase/functions/calendar-sync/index.ts
// Creates / updates / deletes a Google Calendar event for a task — on the
// assignee's own calendar, and optionally also on the company's nominated
// source-of-truth Gmail account's calendar (companies.
// sync_tasks_to_company_calendar), if that's turned on. These are two
// independent copies (separate event ids), synced whether or not the
// other target is available — a task with no assignee (or an assignee who
// hasn't connected Calendar) can still sync to the company calendar, and
// vice versa. Whether the assignee shares their own calendar with anyone
// else is entirely up to them; this doesn't manage sharing/ACLs there.
// Called with: { action: 'upsert' | 'delete' | 'complete', taskId }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } }
);
const googleClientId = Deno.env.get("GOOGLE_CLIENT_ID")!;
const googleClientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET")!;

// ── Token ──────────────────────────────────────────────────────────

async function getAccessToken(userId: string): Promise<string | null> {
  const { data } = await db.from("user_gmail_tokens")
    .select("access_token, refresh_token, token_expires_at, email")
    .eq("user_id", userId).single();
  if (!data) return null;
  if (new Date(data.token_expires_at).getTime() < Date.now() + 60_000) {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: googleClientId, client_secret: googleClientSecret,
        refresh_token: data.refresh_token, grant_type: "refresh_token" }),
    });
    const r = await res.json();
    if (!r.access_token) return null;
    await db.from("user_gmail_tokens").update({
      access_token: r.access_token,
      token_expires_at: new Date(Date.now() + r.expires_in * 1000).toISOString(),
    }).eq("user_id", userId);
    return r.access_token;
  }
  return data.access_token;
}

async function getTokenByEmail(email: string): Promise<{ token: string; userId: string } | null> {
  const { data } = await db.from("user_gmail_tokens")
    .select("user_id, access_token, refresh_token, token_expires_at")
    .eq("email", email).maybeSingle();
  if (!data) return null;
  const token = await getAccessToken(data.user_id);
  return token ? { token, userId: data.user_id } : null;
}

// ── Which of the assignee's own calendars ────────────────────────────
// Per-task choice (tasks.calendar_target): their primary calendar, or a
// dedicated "Tasks" calendar on their own account (created lazily the
// first time they need it).

async function createTasksCalendar(token: string): Promise<string | null> {
  const res = await fetch("https://www.googleapis.com/calendar/v3/calendars", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      summary: "Tasks",
      description: "Task due dates synced automatically from Diract.",
    }),
  });
  if (!res.ok) {
    console.error("[calendar] create Tasks calendar error:", await res.text());
    return null;
  }
  const data = await res.json();
  return data.id || null;
}

async function resolveCalendarId(userId: string, token: string, calendarTarget: string | null): Promise<string> {
  if (calendarTarget === "main_calendar") return "primary";

  const { data } = await db.from("user_gmail_tokens").select("tasks_calendar_id").eq("user_id", userId).maybeSingle();
  if (data?.tasks_calendar_id) return data.tasks_calendar_id;

  const created = await createTasksCalendar(token);
  if (!created) return "primary"; // fall back if creation failed
  await db.from("user_gmail_tokens").update({ tasks_calendar_id: created }).eq("user_id", userId);
  return created;
}

// ── Calendar API ───────────────────────────────────────────────────

let lastCalendarApiError: string | null = null;

async function createCalendarEvent(
  token: string,
  calendarId: string,
  event: any
): Promise<string | null> {
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
    { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(event) }
  );
  if (!res.ok) {
    const err = await res.text();
    console.error("[calendar] create error:", err);
    lastCalendarApiError = err;
    return null;
  }
  const data = await res.json();
  return data.id || null;
}

async function updateCalendarEvent(
  token: string,
  calendarId: string,
  eventId: string,
  event: any
): Promise<boolean> {
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`,
    { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(event) }
  );
  if (!res.ok) {
    const err = await res.text();
    // Event might not exist on this calendar — try create instead
    if (res.status === 404) return false;
    console.error("[calendar] update error:", err);
    return false;
  }
  return true;
}

async function deleteCalendarEvent(
  token: string,
  calendarId: string,
  eventId: string
): Promise<void> {
  await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }
  );
}

// ── Build event object ─────────────────────────────────────────────

function extractTokens(format: string): string[] {
  const regex = /\{(\w+)\}/g;
  const tokens: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = regex.exec(format))) tokens.push(m[1]);
  return tokens;
}

// Title format can reference {task_name}, {project_name}, or any of the
// company's custom fields on the projects table (by field_key) — e.g.
// {matter_number} for a law firm, {job_reference} for a trades company.
// customFieldValues is keyed by field_key, resolved by the caller.
function buildEventTitle(format: string, taskName: string, projectName: string, customFieldValues: Record<string, string>): string {
  let title = format
    .replace("{task_name}", taskName || "")
    .replace("{project_name}", projectName || "");
  for (const [key, value] of Object.entries(customFieldValues)) {
    title = title.split(`{${key}}`).join(value || "");
  }
  return title.trim().replace(/^[\s—\-]+|[\s—\-]+$/g, ""); // strip leading/trailing separators
}

function buildEvent(params: {
  title: string;
  description: string;
  dueDate: string;
  dueTime: string | null;
  durationMins: number;
  isCompleted: boolean;
}): any {
  const { title, description, dueDate, dueTime, durationMins, isCompleted } = params;

  let start: any, end: any;
  const datePart = dueDate.substring(0, 10); // dueDate may be a full timestamp — keep just YYYY-MM-DD

  if (dueTime) {
    // Timed event — dueTime is HH:MM:SS, already includes seconds
    const startDt = new Date(`${datePart}T${dueTime}`);
    const endDt = new Date(startDt.getTime() + durationMins * 60 * 1000);
    start = { dateTime: startDt.toISOString(), timeZone: "Australia/Sydney" };
    end = { dateTime: endDt.toISOString(), timeZone: "Australia/Sydney" };
  } else {
    // All-day event
    start = { date: datePart };
    end = { date: datePart };
  }

  return {
    summary: title,
    description,
    start, end,
    status: isCompleted ? "cancelled" : "confirmed",
    reminders: {
      useDefault: false,
      overrides: isCompleted ? [] : [
        { method: "email", minutes: 24 * 60 }, // 1 day before
        { method: "popup", minutes: 30 },
      ],
    },
  };
}

// ── Main handler ───────────────────────────────────────────────────

Deno.serve(async (req) => {
  const corsHeaders = { "Content-Type": "application/json" };

  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { action, taskId } = await req.json();
    if (!taskId) return new Response(JSON.stringify({ error: "Missing taskId" }), { status: 400, headers: corsHeaders });

    console.log(`[calendar] action=${action} taskId=${taskId}`);

    // Fetch task with all related data
    const { data: task, error: taskErr } = await db.from("tasks")
      .select(`
        id, name, due_date, due_time, is_completed, calendar_event_id, calendar_target, company_calendar_event_id,
        company_id, project_id,
        assignee:assignee_id(id, email, full_name),
        project:project_id(id, name)
      `)
      .eq("id", taskId).single();

    if (taskErr || !task) {
      console.error("[calendar] task not found:", taskErr?.message);
      return new Response(JSON.stringify({ error: "Task not found" }), { status: 404, headers: corsHeaders });
    }

    const companyId = task.company_id;
    const { data: company } = await db.from("companies")
      .select("calendar_event_title_format, calendar_event_duration_mins, sync_tasks_to_company_calendar, gmail_source_emails")
      .eq("id", companyId).maybeSingle();

    const titleFormat = company?.calendar_event_title_format || "{task_name}";
    const durationMins = company?.calendar_event_duration_mins || 30;

    // ── Resolve sync targets ────────────────────────────────────────
    // Two independent copies — each syncs (or doesn't) on its own, so a
    // task missing one target still syncs to the other.
    const assigneeEmail = (task.assignee as any)?.email || null;
    let assigneeAuth: { token: string; userId: string } | null = null;
    let assigneeCalendarId: string | null = null;
    if (assigneeEmail) {
      assigneeAuth = await getTokenByEmail(assigneeEmail);
      if (assigneeAuth) {
        assigneeCalendarId = await resolveCalendarId(assigneeAuth.userId, assigneeAuth.token, task.calendar_target);
      } else {
        console.log("[calendar] assignee hasn't connected Google Calendar");
      }
    }

    let companyAuth: { token: string; userId: string } | null = null;
    if (company?.sync_tasks_to_company_calendar && company.gmail_source_emails?.length) {
      companyAuth = await getTokenByEmail(company.gmail_source_emails[0]);
      if (!companyAuth) console.log("[calendar] company source email hasn't connected Google Calendar");
    }

    if (!assigneeAuth && !companyAuth) {
      console.log("[calendar] no sync target available — skipping");
      return new Response(JSON.stringify({ ok: true, skipped: "no sync target" }), { headers: corsHeaders });
    }

    // Resolve any custom-field tokens referenced in the title format (e.g.
    // {matter_number}, {job_reference} — whatever fields this company has
    // configured on the projects table) for this task's project.
    const customTokenKeys = extractTokens(titleFormat).filter(t => t !== "task_name" && t !== "project_name");
    const customFieldValues: Record<string, string> = {};
    const customFieldLabels: Record<string, string> = {};
    if (customTokenKeys.length && task.project_id) {
      const { data: fields } = await db.from("company_custom_fields")
        .select("id, field_key, label").eq("company_id", companyId).eq("table_name", "projects").in("field_key", customTokenKeys);
      if (fields?.length) {
        const fieldIds = fields.map((f: any) => f.id);
        const { data: vals } = await db.from("company_custom_field_values")
          .select("field_id, value_text").eq("record_id", task.project_id).in("field_id", fieldIds);
        const byFieldId = Object.fromEntries((vals || []).map((v: any) => [v.field_id, v.value_text || ""]));
        for (const f of fields) {
          customFieldValues[f.field_key] = byFieldId[f.id] || "";
          customFieldLabels[f.field_key] = f.label;
        }
      }
    }

    const projectName = (task.project as any)?.name || "";
    const title = buildEventTitle(titleFormat, task.name, projectName, customFieldValues);

    const description = [
      projectName ? `Project: ${projectName}` : null,
      ...Object.entries(customFieldValues)
        .filter(([, value]) => value)
        .map(([key, value]) => `${customFieldLabels[key] || key}: ${value}`),
    ].filter(Boolean).join("\n");

    // ── Handle delete / complete ───────────────────────────────────
    if ((action === "delete" || action === "complete") && (task.calendar_event_id || task.company_calendar_event_id)) {
      const dbUpdate: Record<string, unknown> = {};

      if (action === "delete") {
        if (assigneeAuth && assigneeCalendarId && task.calendar_event_id) {
          await deleteCalendarEvent(assigneeAuth.token, assigneeCalendarId, task.calendar_event_id);
          dbUpdate.calendar_event_id = null;
        }
        if (companyAuth && task.company_calendar_event_id) {
          await deleteCalendarEvent(companyAuth.token, "primary", task.company_calendar_event_id);
          dbUpdate.company_calendar_event_id = null;
        }
        dbUpdate.calendar_synced_at = null;
      } else {
        // Mark as cancelled (keeps in history)
        const event = buildEvent({ title, description, dueDate: task.due_date, dueTime: task.due_time,
          durationMins, isCompleted: true });
        if (assigneeAuth && assigneeCalendarId && task.calendar_event_id) {
          await updateCalendarEvent(assigneeAuth.token, assigneeCalendarId, task.calendar_event_id, event);
        }
        if (companyAuth && task.company_calendar_event_id) {
          await updateCalendarEvent(companyAuth.token, "primary", task.company_calendar_event_id, event);
        }
        dbUpdate.calendar_synced_at = new Date().toISOString();
      }

      await db.from("tasks").update(dbUpdate).eq("id", taskId);
      return new Response(JSON.stringify({ ok: true, action }), { headers: corsHeaders });
    }

    // ── Handle upsert ──────────────────────────────────────────────
    if (!task.due_date) {
      console.log("[calendar] no due date — skipping");
      return new Response(JSON.stringify({ ok: true, skipped: "no due date" }), { headers: corsHeaders });
    }

    const event = buildEvent({ title, description, dueDate: task.due_date, dueTime: task.due_time,
      durationMins, isCompleted: false });

    const dbUpdate: Record<string, unknown> = {};
    let anySynced = false;

    if (assigneeAuth && assigneeCalendarId) {
      let eventId = task.calendar_event_id;
      if (eventId) {
        const updated = await updateCalendarEvent(assigneeAuth.token, assigneeCalendarId, eventId, event);
        if (!updated) eventId = null; // gone, or calendar_target changed — recreate
      }
      if (!eventId) eventId = await createCalendarEvent(assigneeAuth.token, assigneeCalendarId, event);
      if (eventId) { dbUpdate.calendar_event_id = eventId; anySynced = true; }
    }

    if (companyAuth) {
      let companyEventId = task.company_calendar_event_id;
      if (companyEventId) {
        const updated = await updateCalendarEvent(companyAuth.token, "primary", companyEventId, event);
        if (!updated) companyEventId = null;
      }
      if (!companyEventId) companyEventId = await createCalendarEvent(companyAuth.token, "primary", event);
      if (companyEventId) { dbUpdate.company_calendar_event_id = companyEventId; anySynced = true; }
    }

    if (!anySynced) {
      return new Response(JSON.stringify({ error: "Failed to create event", detail: lastCalendarApiError }), { status: 500, headers: corsHeaders });
    }

    dbUpdate.calendar_synced_at = new Date().toISOString();
    await db.from("tasks").update(dbUpdate).eq("id", taskId);

    return new Response(JSON.stringify({ ok: true, eventId: dbUpdate.calendar_event_id || null, companyEventId: dbUpdate.company_calendar_event_id || null }), { headers: corsHeaders });

  } catch (err: any) {
    console.error("[calendar] error:", err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
  }
});
