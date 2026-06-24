"use client";

import { useState } from "react";
import { ShieldCheck, Plus, X, Loader2 } from "lucide-react";
import { supabase } from "@/lib/supabase";
import UniversalSelectionModal from "@/components/UniversalSelectionModal";

export default function InsuranceModule({ propertyId, data, onRefresh }: any) {
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [selectedInsurer, setSelectedInsurer] = useState({ id: "", name: "" });

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoading(true);
    const fd = new FormData(e.currentTarget);
    const { error } = await supabase.from("property_insurances").insert([{
      property_id: propertyId,
      insurer_entity_id: selectedInsurer.id,
      policy_number: fd.get("policy_number"),
      date_expiry: fd.get("date_expiry"),
      amount_paid: fd.get("amount_paid")
    }]);
    if (!error) { setIsOpen(false); onRefresh(); }
    setLoading(false);
  };

  return (
    <div className="bg-white border border-slate-200 rounded-[40px] overflow-hidden shadow-sm font-sans">
      <div className="p-6 bg-slate-50 border-b border-slate-100 flex justify-between items-center">
        <span className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">Insurance policies</span>
        <button onClick={() => setIsOpen(true)} className="flex items-center gap-2 px-4 py-1.5 bg-slate-900 text-white rounded-full text-[11px] font-medium transition-all">+ Add policy</button>
      </div>

      <div className="grid grid-cols-4 p-5 bg-slate-50/50 border-b border-slate-100 text-[10px] font-bold text-slate-400 uppercase">
        <span>Insurer</span><span>Policy number</span><span>Expiry date</span><span>Premium</span>
      </div>

      {/* FIX: Safe check using ?. and fallback to empty array */}
      {(data || []).map((ins: any) => (
        <div key={ins.id} className="grid grid-cols-4 p-5 border-b border-slate-50 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors">
          <span className="font-bold text-indigo-600">{ins.insurer?.name || 'Unlinked'}</span>
          <span>{ins.policy_number}</span>
          <span>{ins.date_expiry ? new Date(ins.date_expiry).toLocaleDateString('en-AU') : '-'}</span>
          <span className="text-slate-900">${Number(ins.amount_paid || 0).toLocaleString()}</span>
        </div>
      ))}

      {/* EMPTY STATE */}
      {(!data || data.length === 0) && (
        <div className="p-12 text-center text-slate-300 uppercase text-[10px] font-bold tracking-widest">No active policies found</div>
      )}

      {isOpen && (
        <div className="fixed inset-0 z-[600] flex items-center justify-center p-6 bg-slate-900/40 backdrop-blur-md">
          <form onSubmit={handleSubmit} className="bg-white w-full max-w-lg rounded-[40px] p-10 shadow-2xl animate-in zoom-in-95">
            <h2 className="text-xl font-light text-slate-900 uppercase mb-8">New insurance policy</h2>
            <div className="space-y-6">
              <button type="button" onClick={() => setIsPickerOpen(true)} className="w-full bg-slate-50 border border-slate-100 rounded-full px-6 py-4 text-sm font-medium text-left flex justify-between items-center">
                <span className={selectedInsurer.name ? "text-slate-900" : "text-slate-400"}>{selectedInsurer.name || "Select insurer entity..."}</span>
                <Plus size={16} />
              </button>
              <input name="policy_number" required placeholder="Policy number" className="w-full bg-slate-50 border border-slate-100 rounded-full px-6 py-4 text-sm font-medium outline-none" />
              <input name="date_expiry" type="date" required className="w-full bg-slate-50 border border-slate-100 rounded-full px-6 py-3 text-sm font-medium outline-none" />
              <input name="amount_paid" type="number" step="0.01" placeholder="Premium amount ($)" className="w-full bg-slate-50 border border-slate-100 rounded-full px-6 py-4 text-sm font-medium outline-none" />
              <div className="flex gap-3 pt-4">
                <button type="button" onClick={() => setIsOpen(false)} className="flex-1 text-[11px] font-bold text-slate-400 uppercase">Cancel</button>
                <button type="submit" disabled={loading || !selectedInsurer.id} className="flex-1 py-4 bg-slate-900 text-white rounded-full text-[11px] font-bold uppercase shadow-xl">Save policy</button>
              </div>
            </div>
          </form>
        </div>
      )}
      <UniversalSelectionModal isOpen={isPickerOpen} title="Select insurer" table="entities" onClose={() => setIsPickerOpen(false)} onSelect={(id: string, name: string) => { setSelectedInsurer({ id, name }); setIsPickerOpen(false); }} />
    </div>
  );
}