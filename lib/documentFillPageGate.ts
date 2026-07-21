// lib/documentFillPageGate.ts
// Gating for the GENUINELY UNAUTHENTICATED client-facing document-fill routes.
// There is NO user session on this side — access is granted purely by the page id
// existing, is_active = true, and expires_at being null or in the future, using the
// service-role admin client throughout. Deliberately returns a single generic
// "not found" (404) for missing / revoked / expired pages so a revoked page can't
// be distinguished from one that never existed. Modelled on the missing/expired
// handling in lib/publicTaskPageAuth.ts, but with no auth.getUser()/membership check.
import { NextResponse } from "next/server";

export async function loadActiveFillPage(admin: any, pageId: string) {
  const { data: page } = await admin
    .from("document_fill_pages")
    .select("id, company_id, project_id, title, client_name, expires_at, is_active, access_code, draft_values, draft_na_fields")
    .eq("id", pageId).maybeSingle();

  const notFound = { error: NextResponse.json({ error: "This page is not available" }, { status: 404 }), page: null };

  if (!page) return notFound;
  if (!page.is_active) return notFound;
  if (page.expires_at) {
    // expires_at is a DATE — the page is valid through the end of that day.
    const expiry = new Date(`${String(page.expires_at).slice(0, 10)}T23:59:59`);
    if (expiry < new Date()) return notFound;
  }

  return { error: null as null, page };
}

// Access-code check — a second, independent gate on top of expiry/active,
// shared over a different channel than the link itself. Comparison is
// trimmed but case-sensitive (codes are shown to the admin as typed/generated).
export function codeMatches(page: { access_code: string | null }, provided: string | null | undefined): boolean {
  if (!page.access_code) return true;
  return String(provided || "").trim() === page.access_code;
}
