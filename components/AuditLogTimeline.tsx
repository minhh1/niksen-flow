"use client";

import { useState } from "react";
import { History, Eye, Database, FilePlus } from "lucide-react";
import AuditLogDetailOverlay from "./AuditLogDetailOverlay";

interface AuditLogTimelineProps {
  logs: any[];
  title: string;
}

export default function AuditLogTimeline({ logs, title }: AuditLogTimelineProps) {
  const [selectedLog, setSelectedLog] = useState<any>(null);

  // Helper to format labels from keys (e.g. street_address -> Street address)
  const formatLabel = (key: string) => {
    return key.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  };

  return (
    <div className="space-y-8 py-6 font-sans antialiased text-slate-600">
      
      {/* 1. SECTION HEADER */}
      <div className="flex items-center justify-between mb-8 px-2">
        <h3 className="text-xl font-light text-slate-800 tracking-tight">{title}</h3>
        <span className="text-[10px] font-bold px-3 py-1 bg-slate-100 rounded-full text-slate-400 uppercase tracking-widest">
          {logs.length} logged events
        </span>
      </div>

      {/* 2. TIMELINE LIST */}
      <div className="space-y-6">
        {logs.length > 0 ? logs.map((log) => {
          const isImport = log.action.toLowerCase().includes('import') || log.action.toLowerCase().includes('onboard');
          
          return (
            <div key={log.id} className="relative pl-12 group">
              {/* Vertical Connector Line */}
              <div className="absolute left-[15px] top-2 bottom-0 w-0.5 bg-slate-100 group-last:bg-transparent" />
              
              {/* Event Indicator Icon */}
              <div className="absolute left-0 top-1 w-8 h-8 rounded-xl bg-white border border-slate-200 flex items-center justify-center shadow-sm z-10 transition-colors group-hover:border-indigo-400">
                {isImport ? (
                  <Database size={14} className="text-indigo-500" />
                ) : (
                  <span className="text-[9px] font-bold text-slate-400 uppercase tracking-tighter">
                    {log.profiles?.full_name?.substring(0, 2).toUpperCase() || 'SY'}
                  </span>
                )}
              </div>

              {/* Log Card */}
              <div className="bg-white border border-slate-100 rounded-[28px] p-6 shadow-sm group-hover:shadow-md transition-all">
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <p className="text-sm text-slate-600 font-medium leading-none">
                      <span className="text-slate-900 font-bold">{log.profiles?.full_name || 'System'}</span>
                      <span className="mx-2 text-slate-400 font-normal lowercase">{log.action}</span>
                    </p>
                    <div className="flex items-center gap-2 text-[10px] font-medium text-slate-300 uppercase tracking-wider mt-2">
                      <History size={12} />
                      {new Date(log.created_at).toLocaleString('en-AU', { 
                        day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' 
                      })}
                    </div>
                  </div>
                  
                  <button 
                    onClick={() => setSelectedLog(log)}
                    className="text-[10px] font-bold text-indigo-500 uppercase tracking-widest hover:text-indigo-700 transition-colors"
                  >
                    View details
                  </button>
                </div>

                {/* 3. IN-LINE DATA PREVIEW */}
                {log.details && (
                  <div className="mt-4 pt-4 border-t border-slate-50">
                    {/* CASE A: Modification (Old vs New) */}
                    {log.details.old !== undefined || log.details.new !== undefined ? (
                      <div className="flex gap-4">
                        <div className="flex-1 p-3 bg-slate-50 rounded-xl border border-slate-100">
                          <span className="text-[8px] font-bold text-slate-300 uppercase block mb-1">Prior State</span>
                          <span className="text-[11px] font-medium text-slate-400 line-through truncate block">
                            {String(log.details.old || "Empty")}
                          </span>
                        </div>
                        <div className="flex-1 p-3 bg-emerald-50 rounded-xl border border-emerald-100">
                          <span className="text-[8px] font-bold text-emerald-600 uppercase block mb-1">New State</span>
                          <span className="text-[11px] font-bold text-emerald-900 truncate block">
                            {String(log.details.new || "Unset")}
                          </span>
                        </div>
                      </div>
                    ) : (
                      /* CASE B: Creation/Import (Snapshot Grid) */
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                        {Object.entries(log.details).slice(0, 4).map(([key, val]) => (
                          <div key={key}>
                            <p className="text-[8px] font-bold text-slate-300 uppercase tracking-tighter mb-0.5 truncate">{formatLabel(key)}</p>
                            <p className="text-[11px] font-medium text-slate-600 truncate">{String(val || '—')}</p>
                          </div>
                        ))}
                        {Object.keys(log.details).length > 4 && (
                          <div className="flex items-end">
                            <span className="text-[9px] font-bold text-indigo-400 uppercase">+{Object.keys(log.details).length - 4} More fields</span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        }) : (
          <div className="py-20 text-center border-2 border-dashed border-slate-100 rounded-[40px]">
            <p className="text-slate-300 font-medium uppercase text-xs tracking-widest">No activity found in database</p>
          </div>
        )}
      </div>

      {/* 4. DETAIL OVERLAY (The "Bigger View" for Inspection) */}
      <AuditLogDetailOverlay 
        isOpen={!!selectedLog} 
        log={selectedLog} 
        onClose={() => setSelectedLog(null)} 
      />
    </div>
  );
}