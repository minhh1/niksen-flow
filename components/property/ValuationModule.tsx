"use client";

import { useState } from "react";
import { Plus, Loader2 } from "lucide-react";
import { supabase } from "@/lib/supabase";

export default function ValuationModule({ propertyId, data, onRefresh }: any) {
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoading(true);
    const fd = new FormData(e.currentTarget);
    await supabase.from("property_valuations").insert([{
      property_id: propertyId,
      amount: fd.get("amount"),
      valuation_date: fd.get("date"),
      is_full_valuation: fd.get("type") === "Full"
    }]);
    setIsOpen(false);
    onRefresh();
    setLoading(false);
  };

  return (
    <div className="bg-white border border-slate-200 rounded-[40px] overflow-hidden shadow-sm">
      <div className="p-6 bg-slate-50 border-b border-slate-100 flex justify-between items-center">
        <span className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">Valuation history</span>
        <button onClick={() => setIsOpen(true)} className="px-4 py-1.5 bg-slate-900 text-white rounded-full text-[11px] font-medium transition-all">+ Add valuation</button>
      </div>

      <div className="grid grid-cols-3 p-5 bg-slate-50/50 border-b border-slate-100 text-[10px] font-bold text-slate-400 uppercase">
        <span>Market value</span><span>Inspection date</span><span>Report type</span>
      </div>

      {data.map((v: any) => (
        <div key={v.id} className="grid grid-cols-3 p-5 border-b border-slate-50 text-sm font-medium text-slate-700">
          <span>${Number(v.amount).toLocaleString()}</span>
          <span>{v.valuation_date}</span>
          <span className="text-[10px] text-indigo-600 font-bold uppercase">{v.is_full_valuation ? "Full" : "Desktop"}</span>
        </div>
      ))}

      {isOpen && (
        <div className="fixed inset-0 z-[600] flex items-center justify-center p-6 bg-slate-900/40 backdrop-blur-md">
          <form onSubmit={handleSubmit} className="bg-white w-full max-w-md rounded-[40px] p-10 shadow-2xl animate-in zoom-in-95">
            <h2 className="text-xl font-light text-slate-900 mb-8">New valuation</h2>
            <div className="space-y-6">
              <input name="amount" type="number" step="0.01" required placeholder="Amount ($)" className="w-full bg-slate-50 border border-slate-100 rounded-full px-6 py-4 text-sm font-medium outline-none" />
              <input name="date" type="date" required className="w-full bg-slate-50 border border-slate-100 rounded-full px-6 py-4 text-sm font-medium outline-none" />
              <select name="type" className="w-full bg-slate-50 border border-slate-100 rounded-full px-6 py-4 text-sm font-medium outline-none"><option>Full</option><option>Desktop</option></select>
              <div className="flex gap-3 pt-4">
                <button type="button" onClick={() => setIsOpen(false)} className="flex-1 py-4 text-slate-400 text-[11px] font-bold">Cancel</button>
                <button type="submit" disabled={loading} className="flex-1 py-4 bg-slate-900 text-white rounded-full text-[11px] font-bold uppercase">{loading ? "Saving..." : "Save record"}</button>
              </div>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}