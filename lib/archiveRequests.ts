// lib/archiveRequests.ts
// Shared helper for the non-admin "request an archive instead of deleting"
// flow (see supabase/archive_requests.sql). A non-admin's delete attempt
// calls createArchiveRequest() instead of actually deleting -- the real
// deletion only happens when a company_admin approves it from the Admin ->
// Archive requests tab. The DB trigger (prevent_non_admin_delete) is what
// actually enforces this; this file is just the UI-side plumbing on top.
"use client";

import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";

export type ArchiveEntityTable =
  | "projects" | "tasks" | "entities" | "properties" | "company_table_records"
  | "company_tables" | "company_table_fields" | "company_custom_fields";

// Returns "already_pending" rather than silently no-op-ing so the caller can
// tell the user "already requested" instead of a plain success toast.
export async function createArchiveRequest(
  entityTable: ArchiveEntityTable,
  entityId: string,
  entityLabel: string,
  companyId: string
): Promise<{ ok: true; alreadyPending?: boolean } | { ok: false; error: string }> {
  const { data: existing } = await supabase
    .from("archive_requests")
    .select("id")
    .eq("entity_table", entityTable)
    .eq("entity_id", entityId)
    .eq("status", "pending")
    .maybeSingle();
  if (existing) return { ok: true, alreadyPending: true };

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in" };

  const { error } = await supabase.from("archive_requests").insert({
    company_id: companyId,
    entity_table: entityTable,
    entity_id: entityId,
    entity_label: entityLabel,
    requested_by: user.id,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

// Which entity_ids (within one entityTable) have a pending archive request
// right now -- for rendering an "Archive requested" badge next to a record
// that's still visible while awaiting admin review.
export function usePendingArchiveRequests(entityTable: ArchiveEntityTable, companyId: string | null) {
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    if (!companyId) return;
    const { data } = await supabase
      .from("archive_requests")
      .select("entity_id")
      .eq("entity_table", entityTable)
      .eq("company_id", companyId)
      .eq("status", "pending");
    setPendingIds(new Set((data || []).map(r => r.entity_id)));
  }, [entityTable, companyId]);

  useEffect(() => { refresh(); }, [refresh]);

  return { pendingIds, refreshPendingArchiveRequests: refresh };
}
