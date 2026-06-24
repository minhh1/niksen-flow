"use client";

import { useState, useEffect } from "react";
import { supabase } from "@/lib/supabase";
import { Landmark, ShieldCheck, Users, CreditCard, ClipboardList, ArrowLeft, Check, FileEdit, CheckCircle2 } from "lucide-react";
import DashboardTabs from "@/components/DashboardTabs";
import AuditLogTimeline from "@/components/AuditLogTimeline";
import DeleteAction from "@/components/actions/DeleteAction";

// FIX: Added explicit Interface
interface EntityDashboardProps {
  entityId: string;
  onBack: () => void;
}

export default function EntityDashboard({ entityId, onBack }: EntityDashboardProps) {
  const [entity, setEntity] = useState<any>(null);
  const [logs, setLogs] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState("identity");

  const tabs = [
    { id: 'identity', label: 'Identity', icon: Landmark },
    { id: 'tax', label: 'Tax', icon: ShieldCheck },
    { id: 'banking', label: 'Banking', icon: CreditCard },
    { id: 'log', label: 'Log', icon: ClipboardList }
  ];

  useEffect(() => { if (entityId) fetchAll(); }, [entityId]);

  const fetchAll = async () => {
    const { data: e } = await supabase.from("entities").select("*").eq("id", entityId).single();
    const { data: l } = await supabase.from("audit_logs").select(`*, profiles:user_id(full_name)`).eq("entity_id", entityId).order('created_at', { ascending: false });
    if (e) setEntity(e); if (l) setLogs(l);
  };

  const DataRow = ({ label, value }: any) => (
    <div className="grid grid-cols-3 border-b border-slate-100 p-5 hover:bg-slate-50 transition-colors">
      <div className="text-[10px] font-bold uppercase text-slate-400 flex items-center">{label}</div>
      <div className="col-span-2 text-sm font-medium text-slate-700">{String(value || "—")}</div>
    </div>
  );

  if (!entity) return null;

  return (
    <div className="flex flex-col h-screen bg-white font-sans antialiased overflow-hidden">
      <header className="p-8 border-b border-slate-100 shrink-0 bg-white">
        <div className="flex justify-between items-start">
          <button onClick={onBack} className="flex items-center gap-2 text-[10px] font-bold text-slate-400 uppercase hover:text-black mb-4 transition-all tracking-widest"><ArrowLeft size={14}/> Back</button>
          <DeleteAction table="entities" id={entityId} identifier={entity.name} onRefresh={onBack} variant="icon" />
        </div>
        <h1 className="text-3xl font-light text-slate-900 tracking-tight uppercase leading-none">{entity.name}</h1>
        <DashboardTabs tabs={tabs} activeTab={activeTab} setActiveTab={setActiveTab} />
      </header>
      <main className="flex-1 overflow-y-auto bg-[#F9FAFB] p-10">
        <div className="max-w-4xl mx-auto bg-white border border-slate-200 rounded-[48px] shadow-sm p-2 overflow-hidden">
           {activeTab === 'identity' && (
             <div className="animate-in fade-in">
               <DataRow label="Legal name" value={entity.name} />
               <DataRow label="Entity type" value={entity.entity_type} />
             </div>
           )}
           {activeTab === 'log' && <AuditLogTimeline logs={logs} title="Activity history" />}
        </div>
      </main>
    </div>
  );
}