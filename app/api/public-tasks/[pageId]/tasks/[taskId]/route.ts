// app/api/public-tasks/[pageId]/tasks/[taskId]/route.ts
// Update (including toggle-complete) or soft-delete a task from the public
// task page. Authorization mirrors app/api/public-tasks/[pageId]/route.ts.
import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabaseServer";
import { createClient } from "@supabase/supabase-js";
import { loadPageAndAuthorize } from "@/lib/publicTaskPageAuth";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ pageId: string; taskId: string }> }) {
  const { pageId, taskId } = await params;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const auth = await loadPageAndAuthorize(admin, pageId, user.id);
  if (auth.error) return auth.error;
  const { page, targetUserIds } = auth;

  const { data: existing } = await admin.from("tasks").select("id, company_id").eq("id", taskId).maybeSingle();
  if (!existing || existing.company_id !== page.company_id) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  let body: any;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const update: Record<string, any> = {};
  if (body.name !== undefined) {
    if (!body.name.trim()) return NextResponse.json({ error: "Task name is required" }, { status: 400 });
    update.name = body.name.trim();
  }
  if (body.dueDate !== undefined) update.due_date = body.dueDate || null;
  if (body.dueTime !== undefined) update.due_time = body.dueTime || null;
  if (body.statusId !== undefined) update.status_id = body.statusId || null;
  if (body.teamId !== undefined) update.assigned_team_id = body.teamId || null;
  if (body.isMonetary !== undefined) update.is_monetary = !!body.isMonetary;
  if (body.estimatedCost !== undefined) update.estimated_cost = body.estimatedCost || null;
  if (body.isCompleted !== undefined) update.is_completed = !!body.isCompleted;
  if (body.awaitingFollowUp !== undefined) update.awaiting_follow_up = !!body.awaitingFollowUp;
  if (body.followUpDate !== undefined) update.follow_up_date = body.followUpDate || null;
  if (body.assigneeId !== undefined) {
    if (body.assigneeId && !targetUserIds.includes(body.assigneeId)) {
      return NextResponse.json({ error: "Assignee is outside this page's scope" }, { status: 400 });
    }
    update.assignee_id = body.assigneeId || null;
  }

  if (Object.keys(update).length === 0) return NextResponse.json({ error: "No fields to update" }, { status: 400 });

  const { error } = await admin.from("tasks").update(update).eq("id", taskId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ pageId: string; taskId: string }> }) {
  const { pageId, taskId } = await params;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const auth = await loadPageAndAuthorize(admin, pageId, user.id);
  if (auth.error) return auth.error;
  const { page } = auth;

  const { data: existing } = await admin.from("tasks").select("id, company_id").eq("id", taskId).maybeSingle();
  if (!existing || existing.company_id !== page.company_id) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  const { error } = await admin.from("tasks").update({ deleted_at: new Date().toISOString() }).eq("id", taskId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
