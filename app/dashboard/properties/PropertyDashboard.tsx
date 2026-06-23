"use client";

import { useState, useEffect } from "react";
import { supabase } from "@/lib/supabase";
import { 
  Building2, Landmark, DollarSign, ShieldCheck, ClipboardList, 
  ArrowLeft, FileEdit, Check, X, UserPlus, Loader2
} from "lucide-react";
import UniversalSelectionModal from "@/components/UniversalSelectionModal";
import DashboardTabs from "@/components/DashboardTabs";
import AuditLogTimeline from "@/components/AuditLogTimeline";
import DeleteAction from "@/components/actions/DeleteAction";

interface PropertyDashboardProps { propertyId: string; onBack: () => void; }

export default function PropertyDashboard({ propertyId, onBack }: PropertyDashboardProps) {
  const [property, setProperty] = useState<any>(null);
  const [logs, setLogs] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState("identification");
  const [loading, setLoading] = useState(true);

  const [picker, setPicker] = useState({ isOpen: false, field: "", title: "", table: "entities" as any });
  const [edit, setEdit] = useState({ field: null, value: "", type: "text" });

  const tabs = [
    { id: 'identification', label: 'Identification', icon: Building2 },
    { id: 'legal', label: 'Legal holding', icon: Landmark },
    { id: 'insurance', label: 'Insurance', icon: ShieldCheck },
    { id: 'log', label: 'Log', icon: ClipboardList }
  ];

  useEffect(() => { fetchAll(); }, [propertyId]);

  const fetchAll = async () => {
    setLoading(true);
    // SAFER SELECT: Matches the SQL Repair in Step 1
    const { data: p, error } = await supabase.from("properties")
      .select(`
        *, 
        holding_entity:holding_entity_id(name), 
        council:council_entity_id(name), 
        insurer:insurer_entity_id(name)
      `)
      .eq("id", propertyId)
      .single();
    
    if (error) {
      console.error("❌ PROPERTY FETCH ERROR:", error.message, error.details);
    }

    const { data: l } = await supabase.from("audit_logs")
      .select(`*, profiles:user_id(full_name)`)
      .eq("property_id", propertyId)
      .order('created_at', { ascending: false });

    if (p) setProperty(p); 
    if (l) setLogs(l || []);
    setLoading(false);
  };

  const handleUpdate = async (field: string, newValue: any, displayName?: string) => {
    if (!property) return;
    const { data: { user } } = await supabase.auth.getUser();
    const oldValue = property[field];
    const { error } = await supabase.from("properties").update({ [field]: newValue }).eq("id", propertyId);
    if (!error) {
      await supabase.from("audit_logs").insert([{
        property_id: propertyId, user_id: user?.id,
        action: `modified ${field}`,
        details: { old: String(oldValue || "empty"), new: String(displayName || newValue) }
      }]);
      setEdit({ field: null, value: "", type: "text" });
      setPicker({ ...picker, isOpen: false });
      fetchAll();
    }
  };

  const DataRow = ({ label, field, value, type = "text", table = "entities", isPlaceholder = false }: any) => {
    const isEditing = edit.field === field;
    return (
      <div className="grid grid-cols-3 border-b border-slate-100 group hover:bg-slate-50 transition-colors">
        <div className="col-span-1 bg-slate-50/50 p-5 border-r border-slate-100 flex items-center font-bold text-[10px] uppercase text-slate-400 tracking-widest">{label}</div>
        <div className="col-span-2 p-5 flex items-center justify-between text-sm font-medium">
          {isEditing ? (
            <div className="flex-1 flex items-center gap-2">
              <input type={type === 'currency' ? 'number' : type} autoFocus className="flex-1 bg-white border-2 border-indigo-600 rounded-lg px-3 py-2 font-medium" value={edit.value} onChange={e => setEdit({...edit, value: e.target.value})} />
              <button onClick={() => handleUpdate(field, edit.value)} className="p-2 bg-indigo-600 text-white rounded-lg">Save</button>
            </div>
          ) : (
            <>
              <span className={isPlaceholder || !value ? 'text-slate-300 underline decoration-dotted' : 'text-slate-900 font-medium'}>
                {type === 'currency' ? `$${Number(value || 0).toLocaleString()}` : String(value || "click to add")}
              </span>
              <button onClick={() => { if(type==='relational') setPicker({isOpen:true, field, title:label, table}); else setEdit({field, value, type}); }} className="opacity-0 group-hover:opacity-100 text-indigo-600 p-2 hover:bg-white rounded-full transition-all border border-slate-100 shadow-sm">
                {type === 'relational' ? <UserPlus size={14}/> : <FileEdit size={14}/>}
              </button>
            </>
          )}
        </div>
      </div>
    );
  };

  if (loading || !property) return <div className="p-20 text-center text-slate-300 font-medium uppercase animate-pulse tracking-widest">Accessing Secure Records...</div>;

  return (
    <div className="flex flex-col h-screen bg-white font-sans antialiased overflow-hidden">
      <header className="p-8 border-b border-slate-100 shrink-0 bg-white">
        <div className="flex justify-between items-start">
          <button onClick={onBack} className="flex items-center gap-2 text-[10px] font-bold text-slate-400 uppercase hover:text-indigo-600 mb-4 transition-all tracking-widest"><ArrowLeft size={14}/> Master List</button>
          <DeleteAction table="properties" id={propertyId} identifier={property.street_address} onRefresh={onBack} variant="icon" />
        </div>
        <h1 className="text-5xl font-light text-slate-900 tracking-tight uppercase leading-none">{property.street_address}</h1>
        <DashboardTabs tabs={tabs} activeTab={activeTab} setActiveTab={setActiveTab} />
      </header>

      <main className="flex-1 overflow-y-auto bg-[#F9FAFB] p-10">
        <div className="max-w-4xl mx-auto bg-white border border-slate-200 rounded-[48px] shadow-sm p-2 overflow-hidden">
           {activeTab === 'identification' && (
             <div className="rounded-[32px] overflow-hidden">
               <DataRow label="Street address" field="street_address" value={property.street_address} />
               <DataRow label="Suburb" field="suburb" value={property.suburb} />
               <DataRow label="LGA Council" field="council_entity_id" value={property.council?.name} type="relational" />
             </div>
           )}
           {activeTab === 'legal' && (
             <div className="rounded-[32px] overflow-hidden">
               <DataRow label="Holding Entity" field="holding_entity_id" value={property.holding_entity?.name} type="relational" />
               <DataRow label="Project Manager" field="project_manager" value={property.project_manager} />
             </div>
           )}
           {activeTab === 'insurance' && (
             <div className="rounded-[32px] overflow-hidden">
                <DataRow label="Primary Insurer" field="insurer_entity_id" value={property.insurer?.name} type="relational" />
                <DataRow label="Policy number" field="policy_number" value={property.policy_number} />
             </div>
           )}
           {activeTab === 'log' && <AuditLogTimeline logs={logs} title="Asset history" />}
        </div>
      </main>
      <UniversalSelectionModal isOpen={picker.isOpen} title={`Select ${picker.title}`} table={picker.table} onClose={() => setPicker({...picker, isOpen: false})} onSelect={(id: string, name: string) => handleUpdate(picker.field, id, name)} />
    </div>
  );
}