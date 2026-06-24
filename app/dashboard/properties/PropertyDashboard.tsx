"use client";

import { useState, useEffect } from "react";
import { supabase } from "@/lib/supabase";
import { propertyService } from "@/lib/services/propertyService";
import { 
  Building2, Landmark, DollarSign, ShieldCheck, ClipboardList, 
  ArrowLeft, Zap, Key, Receipt, Loader2, UserPlus, FileEdit 
} from "lucide-react";

// Modular Sub-Components (from components/property/)
import IdentificationModule from "@/components/property/IdentificationModule";
import AcquisitionDisposalModule from "@/components/property/AcquisitionDisposalModule";
import ValuationModule from "@/components/property/ValuationModule";
import InsuranceModule from "@/components/property/InsuranceModule";
import CredentialModule from "@/components/property/CredentialModule";
import BillPaymentModule from "@/components/property/BillPaymentModule";

import DashboardTabs from "@/components/DashboardTabs";
import AuditLogTimeline from "@/components/AuditLogTimeline";
import DeleteAction from "@/components/actions/DeleteAction";
import UniversalSelectionModal from "@/components/UniversalSelectionModal";

interface PropertyDashboardProps {
  propertyId: string;
  onBack: () => void;
}

export default function PropertyDashboard({ propertyId, onBack }: PropertyDashboardProps) {
  const [data, setData] = useState<any>(null);
  const [activeTab, setActiveTab] = useState("identification");
  const [loading, setLoading] = useState(true);

  // Selection Modal State for Relational Updates
  const [picker, setPicker] = useState({ isOpen: false, field: "", title: "", table: "entities" as any });

  const tabs = [
    { id: 'identification', label: 'Identification', icon: Building2 },
    { id: 'acquisition', label: 'Acquisition & Disposal', icon: DollarSign },
    { id: 'valuations', label: 'Valuations', icon: Landmark },
    { id: 'insurance', label: 'Insurance', icon: ShieldCheck },
    { id: 'credentials', label: 'Utilities Credentials', icon: Key },
    { id: 'payments', label: 'Bill Payments', icon: Receipt },
    { id: 'log', label: 'Activity Log', icon: ClipboardList }
  ];

  useEffect(() => {
    if (propertyId) fetchAll();
  }, [propertyId]);

  const fetchAll = async () => {
    setLoading(true);
    try {
      const result = await propertyService.getDetails(propertyId);
      setData(result);
    } catch (error) {
      console.error("ERP fetch error:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleUpdate = async (field: string, newValue: any, displayName?: string) => {
    if (!data?.property) return;
    const { data: { user } } = await supabase.auth.getUser();
    
    const oldValue = field === 'holding_entity_id' ? data.property.holding_entity?.name : 
                     field === 'council_entity_id' ? data.property.council?.name : 
                     data.property[field];

    const { error } = await supabase.from("properties").update({ [field]: newValue }).eq("id", propertyId);
    
    if (!error) {
      await supabase.from("audit_logs").insert([{
        property_id: propertyId,
        user_id: user?.id,
        action: `modified ${field.replace('_id', '').replace('_', ' ')}`,
        details: { old: String(oldValue || "empty"), new: String(displayName || newValue) }
      }]);
      setPicker({ ...picker, isOpen: false });
      fetchAll();
    }
  };

  if (loading || !data?.property) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 text-slate-300">
        <Loader2 className="animate-spin" size={40} />
        <p className="text-[10px] font-bold uppercase tracking-widest">Accessing Asset Cloud</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-white font-sans antialiased overflow-hidden selection:bg-black selection:text-white">
      
      {/* 1. MANAGEMENT HEADER */}
      <header className="p-8 border-b border-slate-100 shrink-0 bg-white">
        <div className="flex justify-between items-start mb-6">
          <button onClick={onBack} className="flex items-center gap-2 text-[10px] font-bold text-slate-400 uppercase hover:text-indigo-600 transition-all tracking-widest">
            <ArrowLeft size={14}/> Back to Master List
          </button>
          <DeleteAction table="properties" id={propertyId} identifier={data.property.street_address} onRefresh={onBack} variant="icon" />
        </div>

        <div className="flex items-center gap-3 mb-2">
           <span className="px-3 py-1 bg-indigo-600 text-white rounded-full text-[9px] font-bold uppercase tracking-widest shadow-lg shadow-indigo-100">
             Niksen Time Pty Ltd
           </span>
        </div>
        
        <h1 className="text-3xl font-light text-slate-900 tracking-tight uppercase leading-none">
          {data.property.street_address}
        </h1>

        <DashboardTabs tabs={tabs} activeTab={activeTab} setActiveTab={setActiveTab} />
      </header>

      {/* 2. DYNAMIC CONTENT AREA */}
      <main className="flex-1 overflow-y-auto bg-[#F9FAFB] p-10">
        <div className="max-w-5xl mx-auto pb-20 space-y-10">
          
          {activeTab === 'identification' && (
            <div className="space-y-6">
              <IdentificationModule data={data.property} />
              
              {/* Linked Owner Highlight (Relational) */}
              <div className="bg-white border border-slate-200 rounded-[40px] p-8 shadow-sm flex items-center justify-between group">
                 <div>
                    <p className="text-[10px] font-bold text-slate-400 uppercase mb-1">Holding entity</p>
                    <p className="text-sm font-medium text-slate-900 uppercase">
                      {data.property.holding_entity?.name || "No record linked"}
                    </p>
                 </div>
                 <button 
                   onClick={() => setPicker({ isOpen: true, field: "holding_entity_id", title: "Holding entity", table: "entities" })}
                   className="opacity-0 group-hover:opacity-100 p-2 text-indigo-600 hover:bg-slate-50 rounded-full transition-all"
                 >
                   <UserPlus size={18}/>
                 </button>
              </div>
            </div>
          )}

          {activeTab === 'acquisition' && <AcquisitionDisposalModule data={data.property} />}

          {activeTab === 'valuations' && (
            <ValuationModule propertyId={propertyId} data={data.valuations || []} onRefresh={fetchAll} />
          )}

          {activeTab === 'insurance' && (
            <InsuranceModule propertyId={propertyId} data={data.insurances || []} onRefresh={fetchAll} />
          )}

          {activeTab === 'credentials' && <CredentialModule data={data.utilities || []} />}

          {activeTab === 'payments' && (
            <BillPaymentModule propertyId={propertyId} data={data.bills || []} onRefresh={fetchAll} />
          )}

          {activeTab === 'log' && (
            <div className="animate-in slide-in-from-bottom-4">
              <AuditLogTimeline logs={data.logs || []} title="Asset activity history" />
            </div>
          )}
        </div>
      </main>

      {/* UNIVERSAL RELATIONAL PICKER */}
      <UniversalSelectionModal 
        isOpen={picker.isOpen} 
        title={`Select ${picker.title}`} 
        table={picker.table} 
        onClose={() => setPicker({...picker, isOpen: false})} 
        onSelect={(id: string, name: string) => handleUpdate(picker.field, id, name)} 
      />
    </div>
  );
}