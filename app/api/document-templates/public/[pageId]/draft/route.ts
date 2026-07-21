// app/api/document-templates/public/[pageId]/draft/route.ts
// GENUINELY UNAUTHENTICATED client-facing route. Like the sibling GET/submit routes,
// performs NO supabase.auth.getUser() and NO session/membership check — access is
// gated only by loadActiveFillPage (page exists + active + not expired) plus the
// same access-code recheck submit does, using the service-role admin client throughout.
//
// Autosaves the client's in-progress answers (debounced client-side — see
// app/public/documents/[pageId]/page.tsx) so a closed tab or a different device
// doesn't mean retyping everything. Overwrites whatever was saved before; there's no
// merge logic since the client always sends its full current values/naFields state.
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { loadActiveFillPage, codeMatches } from "@/lib/documentFillPageGate";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ pageId: string }> }) {
  const { pageId } = await params;

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const gate = await loadActiveFillPage(admin, pageId);
  if (gate.error) return gate.error;
  const { page } = gate;

  let body: any;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  if (!codeMatches(page, body?.code)) {
    return NextResponse.json({ error: "Incorrect access code" }, { status: 401 });
  }

  const values = (body?.values && typeof body.values === "object") ? body.values : {};
  const naFields = Array.isArray(body?.naFields) ? body.naFields : [];

  const { error } = await admin
    .from("document_fill_pages")
    .update({ draft_values: values, draft_na_fields: naFields })
    .eq("id", pageId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
