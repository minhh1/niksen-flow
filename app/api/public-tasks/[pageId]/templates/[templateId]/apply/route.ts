// app/api/public-tasks/[pageId]/templates/[templateId]/apply/route.ts
// Applies a checklist template to a chosen project, mirroring the logic in
// components/dashboard/tabs/ChecklistTab.tsx's TemplateModal (resolveDate /
// resolveDateAsync), but server-side.
import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabaseServer";
import { createClient } from "@supabase/supabase-js";
import { loadPageAndAuthorize } from "@/lib/publicTaskPageAuth";

const DATE_CALC_URL = "https://txzzgtwrrokomiphairy.supabase.co/functions/v1/date-calc";

function getAnchorDate(item: any, projectCreatedAt: string, projectDueDate: string | null): Date {
  if (item.due_anchor === "record_due" && projectDueDate) return new Date(projectDueDate);
  return new Date(projectCreatedAt);
}

async function resolveDate(item: any, projectCreatedAt: string, projectDueDate: string | null): Promise<string | null> {
  if (item.due_offset_days === null || item.due_offset_days === undefined) return null;
  const anchor = getAnchorDate(item, projectCreatedAt, projectDueDate);

  if (item.due_offset_mode === "business" && item.due_offset_state) {
    const fromDateStr = anchor.toISOString().slice(0, 10);
    try {
      const res = await fetch(DATE_CALC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromDate: fromDateStr, days: item.due_offset_days, mode: "business", state: item.due_offset_state }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.resultDate) return data.resultDate;
      }
    } catch { /* fall through to calendar-day calc below */ }
  }

  anchor.setDate(anchor.getDate() + (item.due_offset_days || 0));
  return anchor.toISOString().slice(0, 10);
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ pageId: string; templateId: string }> }) {
  const { pageId, templateId } = await params;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const auth = await loadPageAndAuthorize(admin, pageId, user.id);
  if (auth.error) return auth.error;
  const { page, targetUserIds } = auth;

  let body: any;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const { projectId } = body;
  if (!projectId) return NextResponse.json({ error: "Project is required" }, { status: 400 });

  const { data: project } = await admin
    .from("projects").select("id, company_id, created_at, estimated_completion_date").eq("id", projectId).maybeSingle();
  if (!project || project.company_id !== page.company_id) {
    return NextResponse.json({ error: "Invalid project" }, { status: 400 });
  }

  const { data: template } = await admin
    .from("checklist_templates").select("id, company_id, items:checklist_template_items(*)").eq("id", templateId).maybeSingle();
  if (!template || template.company_id !== page.company_id) {
    return NextResponse.json({ error: "Template not found" }, { status: 404 });
  }

  const items = (template.items || [])
    .filter((i: any) => !i.parent_item_id)
    .sort((a: any, b: any) => a.display_order - b.display_order);

  const tasksToInsert = await Promise.all(items.map(async (item: any) => {
    const dueDate = await resolveDate(item, project.created_at, project.estimated_completion_date);
    // Only carry over an assignee if they're within this page's scope — otherwise leave unassigned.
    const assigneeId = item.assignee_id && targetUserIds.includes(item.assignee_id) ? item.assignee_id : null;
    return {
      project_id: projectId,
      company_id: page.company_id,
      name: item.title,
      assignee_id: assigneeId,
      assigned_team_id: item.assigned_team_id || null,
      is_monetary: item.is_monetary || false,
      estimated_cost: item.estimated_cost || null,
      due_date: dueDate,
      is_completed: false,
      created_by: user.id,
      date_entered: new Date().toISOString().slice(0, 10),
    };
  }));

  if (!tasksToInsert.length) return NextResponse.json({ ok: true, count: 0 });

  const { data: created, error } = await admin.from("tasks").insert(tasksToInsert).select();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, count: created?.length || 0 });
}
