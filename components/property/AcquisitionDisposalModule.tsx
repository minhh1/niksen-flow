"use client";

import { DollarSign } from "lucide-react";

export default function AcquisitionDisposalModule({ data }: { data: any }) {
  const DataRow = ({ label, value }: { label: string; value: any }) => (
    <div className="grid grid-cols-3 border-b border-slate-100 p-5 hover:bg-slate-50 transition-colors">
      <div className="text-[11px] font-medium text-slate-400 flex items-center">{label}</div>
      <div className="col-span-2 text-sm font-medium text-slate-700">{String(value || "—")}</div>
    </div>
  );

  return (
    <div className="bg-white border border-slate-200 rounded-[40px] overflow-hidden shadow-sm">
      <div className="p-6 bg-slate-50 border-b border-slate-100">
        <span className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">Acquisition & disposal</span>
      </div>
      <DataRow label="Purchase price" value={data.purchase_price ? `$${Number(data.purchase_price).toLocaleString()}` : null} />
      <DataRow label="Purchase date" value={data.purchase_date} />
      <div className="p-5 bg-slate-50/50 border-y border-slate-100 text-[10px] font-bold text-slate-400 uppercase tracking-widest px-6">Disposal status</div>
      <DataRow label="Sold status" value={data.is_sold ? "Yes - asset settled" : "No - active"} />
      <DataRow label="Sold date" value={data.sold_date} />
      <DataRow label="Sold price" value={data.sold_price ? `$${Number(data.sold_price).toLocaleString()}` : null} />
    </div>
  );
}