"use client";

import { Building2 } from "lucide-react";

export default function IdentificationModule({ data }: { data: any }) {
  const DataRow = ({ label, value }: { label: string; value: any }) => (
    <div className="grid grid-cols-3 border-b border-slate-100 p-5 hover:bg-slate-50 transition-colors">
      <div className="text-[11px] font-medium text-slate-400 flex items-center">{label}</div>
      <div className="col-span-2 text-sm font-medium text-slate-700">{String(value || "—")}</div>
    </div>
  );

  return (
    <div className="bg-white border border-slate-200 rounded-[40px] overflow-hidden shadow-sm">
      <div className="p-6 bg-slate-50 border-b border-slate-100">
        <span className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">Asset identification</span>
      </div>
      <DataRow label="Street address" value={data.street_address} />
      <DataRow label="Suburb" value={data.suburb} />
      <DataRow label="State / Postcode" value={`${data.state || ''} ${data.postcode || ''}`} />
      <DataRow label="Folio identifier" value={data.folio_identifier} />
      <DataRow label="Local council" value={data.council?.name} />
      <DataRow label="Project manager" value={data.project_manager} />
    </div>
  );
}