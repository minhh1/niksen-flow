// components/TemplateDownload.tsx
"use client";

import { useState } from "react";
import { FileSpreadsheet, Download, Loader2 } from "lucide-react";
import { buildAllSections, headerToLabel } from "@/lib/import/buildTemplate";

interface Props {
  mode: "properties" | "entities" | "projects";
  sectionKey?: string; // if provided, only download that section's template
}

export default function TemplateDownload({ mode, sectionKey }: Props) {
  const [loading, setLoading] = useState(false);

  const onDownload = async () => {
    setLoading(true);

    // Build all sections — this fetches custom fields from the DB
    const sections = await buildAllSections(mode);

    // Find the right section
    const section = sectionKey
      ? sections.find(s => s.key === sectionKey)
      : sections.find(s => s.targetTable === mode); // base section

    if (!section) { setLoading(false); return; }

    // Convert raw header keys to human-readable labels:
    // - Base fields: "full_address" → "Full Address"
    // - Custom fields: "custom:uuid:field_key" → the field's label from the DB
    // - Cross-table: "relation:holding_entity.abn" → "Holding Entity — ABN"
    const labelledHeaders = section.headers.map(h => headerToLabel(h, section));

    // For child sections (bills, credentials etc.), prepend property address column
    const isBaseSection = section.targetTable === mode;
    const prefix = !isBaseSection ? 'Property Street Address,' : '';

    const csvContent = prefix + labelledHeaders.join(',') + '\n';

    const blob = new Blob([csvContent], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = window.URL.createObjectURL(blob);
    a.download = `diract_${section.key}_template.csv`;
    a.click();
    window.URL.revokeObjectURL(a.href);

    setLoading(false);
  };

  return (
    <div className="p-6 bg-slate-50 border border-slate-100 rounded-[32px] flex items-center justify-between">
      <div className="flex items-center gap-4">
        <div className="h-10 w-10 rounded-full bg-white flex items-center justify-center text-indigo-600 shadow-sm">
          <FileSpreadsheet size={18} />
        </div>
        <div>
          <p className="text-sm font-medium text-slate-700 uppercase leading-none">
            {sectionKey
              ? `${sectionKey.replace(/_/g, ' ')} template`
              : `${mode} template`}
          </p>
          <p className="text-[10px] text-slate-400 font-medium mt-1">
            Includes all custom fields · fill the headers exactly as shown
          </p>
        </div>
      </div>
      <button
        onClick={onDownload}
        disabled={loading}
        className="flex items-center gap-2 px-6 py-2 bg-white border border-slate-200 rounded-full text-[11px] font-bold text-slate-600 hover:bg-slate-900 hover:text-white transition-all disabled:opacity-50"
      >
        {loading
          ? <Loader2 size={14} className="animate-spin" />
          : <Download size={14} />
        }
        Download
      </button>
    </div>
  );
}