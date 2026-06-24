"use client";

import { useState } from "react";
import { Receipt, CheckCircle2, XCircle, Loader2, MessageSquare } from "lucide-react";
import { supabase } from "@/lib/supabase";

export default function BillPaymentModule({ propertyId, data, onRefresh }: any) {
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoading(true);
    const fd = new FormData(e.currentTarget);

    const { error } = await supabase.from("property_utility_bills").insert([{
      property_id: propertyId,
      category: fd.get("category"),
      amount: fd.get("amount"),
      issued_date: fd.get("date"),
      is_paid: fd.get("is_paid") === "on",
      payment_note: fd.get("note") // ADDED NOTES
    }]);

    if (!error) {
      setIsOpen(false);
      onRefresh();
    }
    setLoading(false);
  };

  return (
    <div className="bg-white border border-slate-200 rounded-[40px] overflow-hidden shadow-sm">
      <div className="p-6 bg-slate-50 border-b border-slate-100 flex justify-between items-center">
        <span className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">Payment records</span>
        <button onClick={() => setIsOpen(true)} className="flex items-center gap-2 px-4 py-1.5 bg-slate-900 text-white rounded-full text-[11px] font-medium transition-all">+ Record payment</button>
      </div>

      <div className="grid grid-cols-5 p-5 bg-slate-50/50 border-b border-slate-100 text-[10px] font-bold text-slate-400 uppercase">
        <span>Provider</span><span>Date</span><span>Amount</span><span>Status</span><span>Notes</span>
      </div>

      {data.map((b: any) => (
        <div key={b.id} className="grid grid-cols-5 p-5 border-b border-slate-50 text-sm font-medium text-slate-700">
          <span className="font-bold text-slate-900">{b.category}</span>
          <span>{new Date(b.issued_date).toLocaleDateString('en-AU')}</span>
          <span className="font-bold text-slate-900">${Number(b.amount).toLocaleString()}</span>
          <span>{b.is_paid ? <CheckCircle2 size={18} className="text-emerald-500"/> : <XCircle size={18} className="text-slate-200"/>}</span>
          <span className="text-xs text-slate-400 truncate">{b.payment_note || '-'}</span>
        </div>
      ))}

      {isOpen && (
        <div className="fixed inset-0 z-[600] flex items-center justify-center p-6 bg-slate-900/40 backdrop-blur-md">
          <form onSubmit={handleSubmit} className="bg-white w-full max-w-md rounded-[40px] p-10 shadow-2xl animate-in zoom-in-95">
            <h2 className="text-xl font-light text-slate-900 uppercase mb-8">Record payment</h2>
            <div className="space-y-6">
              <select name="category" className="w-full bg-slate-50 border border-slate-100 rounded-full px-6 py-4 text-sm font-medium outline-none">
                <option>Council</option><option>Water</option><option>Electricity</option>
                <option>Gas</option><option>Internet</option><option>Land Tax</option>
              </select>
              <input name="amount" type="number" step="0.01" required placeholder="Amount ($)" className="w-full bg-slate-50 border border-slate-100 rounded-full px-6 py-4 text-sm font-medium outline-none" />
              <input name="date" type="date" required className="w-full bg-slate-50 border border-slate-100 rounded-full px-6 py-4 text-sm font-medium outline-none" />
              <textarea name="note" placeholder="Payment notes (Reference #, etc.)" className="w-full bg-slate-50 border border-slate-100 rounded-[24px] px-6 py-4 text-sm font-medium outline-none resize-none" rows={3} />
              
              <label className="flex items-center gap-4 px-6 py-4 bg-slate-50 rounded-full border border-slate-100 cursor-pointer">
                <input type="checkbox" name="is_paid" className="w-5 h-5 rounded-full border-slate-200 text-indigo-600 focus:ring-0" />
                <span className="text-[11px] font-bold text-slate-500 uppercase">Settled</span>
              </label>
              
              <div className="flex gap-3 pt-4">
                <button type="button" onClick={() => setIsOpen(false)} className="flex-1 text-[11px] font-bold text-slate-400 uppercase">Cancel</button>
                <button type="submit" disabled={loading} className="flex-1 py-4 bg-slate-900 text-white rounded-full text-[11px] font-bold uppercase shadow-xl">Process</button>
              </div>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}