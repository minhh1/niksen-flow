"use client";

import { Trash2 } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useCompany } from "@/components/CompanyContext";
import { createArchiveRequest } from "@/lib/archiveRequests";

interface Props {
  table: "properties" | "entities" | "projects";
  id: string;
  identifier: string; // The name or address to show in the confirm box
  onRefresh: () => void;
  variant?: "icon" | "button";
}

export default function DeleteAction({ table, id, identifier, onRefresh, variant = "icon" }: Props) {
  const { isAdmin, companyId } = useCompany();

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();

    if (!isAdmin) {
      const confirmed = window.confirm(`Request archiving "${identifier}"? A company admin will need to approve it.`);
      if (!confirmed || !companyId) return;
      const result = await createArchiveRequest(table, id, identifier, companyId);
      if (!result.ok) { alert(result.error); return; }
      alert(result.alreadyPending ? "Already requested — waiting on admin review." : "Archive requested — a company admin will review it.");
      return;
    }

    const confirm = window.confirm(`Move "${identifier}" to deleted items?`);
    if (!confirm) return;

    const { error } = await supabase
      .from(table)
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", id);

    if (!error) {
      // Log the deletion to Audit Logs
      const { data: { user } } = await supabase.auth.getUser();
      await supabase.from("audit_logs").insert([{
        user_id: user?.id,
        [table === 'properties' ? 'property_id' : 'entity_id']: id,
        action: `deleted ${table.slice(0, -1)}`,
        details: { name: identifier }
      }]);
      onRefresh();
    }
  };

  if (variant === "button") {
    return (
      <button onClick={handleDelete} className="px-6 py-3 border border-red-100 bg-red-50 text-red-600 rounded-full text-[11px] font-bold uppercase tracking-widest hover:bg-red-600 hover:text-white transition-all">
        Delete record
      </button>
    );
  }

  return (
    <button onClick={handleDelete} className="p-2 text-slate-300 hover:text-red-500 transition-all rounded-full hover:bg-red-50">
      <Trash2 size={16} />
    </button>
  );
}