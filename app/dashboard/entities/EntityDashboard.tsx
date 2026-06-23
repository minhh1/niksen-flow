"use client";

import { useState, useEffect } from "react";
import { supabase } from "@/lib/supabase";
import { Landmark, ShieldCheck, Users, CreditCard, ClipboardList, ArrowLeft, Check, FileEdit, UserPlus, Loader2 } from "lucide-react";
import UniversalSelectionModal from "@/components/UniversalSelectionModal";
import DashboardTabs from "@/components/DashboardTabs";
import AuditLogTimeline from "@/components/AuditLogTimeline";
import DeleteAction from "@/components/actions/DeleteAction";

interface EntityDashboardProps { entityId: string; onBack: () => void; }

export default function EntityDashboard({ entityId, onBack }: EntityDashboardProps) {
  const [entity, setEntity] = useState<any>(null);
  const [logs, setLogs] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState("identity");
  const [loading, setLoading] = useState(true);

  const [picker, setPicker] = useState({ isOpen: false, field: "", title: "", table: "entities" as any });
  const [edit, setEdit] = useState({ field: null, value: "", type: "text" });

  const tabs = [
    { id: 'identity', label: 'Identity', icon: Landmark },
    { id: 'tax', label: 'Tax & GST', icon: ShieldCheck },
    { id: 'banking', label: 'Banking', icon: CreditCard },
    { id: 'log', label: 'Log', icon: ClipboardList }
  ];

  useEffect(() => { fetchAll(); }, [entityId]);

  const fetchAll = async () => {
    setLoading(true);
    const { data: e } = await supabase.from("entities").select("*").eq("id", entityId).single();
    const { data: l } = await supabase.from("audit_logs").select(`*, profiles:user_id(full_name)`).eq("entity_id", entityId).order('created_at', { ascending: false });
    if (e) setEntity(e); 
    if (l) setLogs(l || []);
    setLoading(false);
  };

  const handleUpdate = async (field: string, newValue: any, displayName?: string) => {
    if (!entity) return;
    const { data: { user } } = await supabase.auth.getUser();
    const oldValue = entity[field];
    await supabase.from("entities").update({ [field]: newValue }).eq("id", entityId);
    await supabase.from("audit_logs").insert([{
      entity_id: entityId, user_id: user?.id,
      action: `modified ${field}`,
      details: { old: String(oldValue || "empty"), new: String(displayName || newValue) }
    }]);
    setEdit({ field: null, value: "", type: "text" }); 
    fetchAll();
  };

  const DataRow = ({ label, field, value, type = "text", isPlaceholder = false }: any) => {
    const isEditing = edit.field === field;
    return (
      <div className="grid grid-cols-3 border-b border-slate-100 group hover:bg-slate-50 transition-colors">
        <div className="col-span-1 bg-slate-50/50 p-5 border-r border-slate-100 flex items-center font-bold text-[10px] uppercase text-slate-400 tracking-widest leading-none">{label}</div>
        <div className="col-span-2 p-5 flex items-center justify-between text-sm font-medium">
          {isEditing ? (
            <div className="flex-1 flex items-center gap-2">
              <input type={type} autoFocus className="flex-1 bg-white border-2 border-indigo-600 rounded-lg px-3 py-2 font-medium outline-none" value={edit.value} onChange={e => setEdit({...edit, value: e.target.value})} />
              <button onClick={() => handleUpdate(field, edit.value)} className="p-2 bg-indigo-600 text-white rounded-lg">Save</button>
            </div>
          ) : (
            <>
              <span className={isPlaceholder || !value ? 'text-slate-300 underline decoration-dotted' : 'text-slate-900 font-medium'}>
                {type === 'boolean' ? (value ? "Yes" : "No") : String(value || "add record")}
              </span>
              <button onClick={() => setEdit({field, value, type})} className="opacity-0 group-hover:opacity-100 text-indigo-600 p-2 hover:bg-white rounded-full transition-all border border-slate-100 shadow-sm"><FileEdit size={14}/></button>
            </>
          )}
        </div>
      </div>
    );
  };

  if (loading || !entity) return <div className="p-20 text-center text-slate-400 font-medium uppercase tracking-widest animate-pulse">Syncing entity...</div>;

  return (
    <div className="flex flex-col h-screen bg-white font-sans antialiased overflow-hidden selection:bg-black selection:text-white">
      <header className="p-8 border-b border-slate-100 shrink-0 bg-white">
        <div className="flex justify-between items-start">
          <button onClick={onBack} className="flex items-center gap-2 text-[10px] font-bold text-slate-400 uppercase hover:text-black mb-4 transition-all tracking-widest"><ArrowLeft size={14}/> Master List</button>
          <DeleteAction table="entities" id={entityId} identifier={entity.name} onRefresh={onBack} variant="icon" />
        </div>
        <h1 className="text-5xl font-light text-slate-900 tracking-tight uppercase leading-none">{entity.name}</h1>
        <DashboardTabs tabs={tabs} activeTab={activeTab} setActiveTab={setActiveTab} />
      </header>

      <main className="flex-1 overflow-y-auto bg-[#F9FAFB] p-10">
        <div className="max-w-4xl mx-auto bg-white border border-slate-200 rounded-[48px] shadow-sm p-2 overflow-hidden">
           {activeTab === 'identity' && (
             <div className="rounded-[32px] overflow-hidden border border-slate-100 animate-in fade-in">
               <DataRow label="Legal name" field="name" value={entity.name} />
               <DataRow label="Classification" field="entity_type" value={entity.entity_type} />
             </div>
           )}
           {/* FIXED: RESTORED TAX TAB CONTENT */}
           {activeTab === 'tax' && (
             <div className="rounded-[32px] overflow-hidden border border-slate-100 animate-in fade-in">
               <DataRow label="ABN (Australian Business No)" field="abn" value={entity.abn} />
               <DataRow label="ACN (Company Number)" field="acn" value={entity.acn} />
               <DataRow label="Tax File Number (TFN)" field="tfn" value={entity.tfn} />
               <DataRow label="GST Registered" field="gst_registered" value={entity.gst_registered} type="boolean" />
             </div>
           )}
          {activeTab === 'banking' && (
                <div className="rounded-[32px] overflow-hidden border border-slate-100 animate-in fade-in">
                    <DataRow label="Bank name" field="bank_name" value={entity.bank_name} />
                    <DataRow label="BSB number" field="bsb" value={entity.bsb} />
                    {/* REMOVED THE <td> TAG HERE */}
                    <DataRow label="Account" field="account_number" value={entity.account_number} />
                    <DataRow label="NAB Connect ID" field="nab_connect_id" value={entity.nab_connect_id} />
                </div>
                )}
           {activeTab === 'log' && <AuditLogTimeline logs={logs} title="History log" />}
        </div>
      </main>
      <UniversalSelectionModal isOpen={picker.isOpen} title={`Select ${picker.title}`} table={picker.table} onClose={() => setPicker({...picker, isOpen: false})} onSelect={(id: string, name: string) => handleUpdate(picker.field, id, name)} />
    </div>
  );
}