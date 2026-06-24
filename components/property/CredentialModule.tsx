"use client";

import { useState } from "react";
import { Key, Eye, EyeOff, FileEdit } from "lucide-react";

export default function CredentialModule({ data }: { data: any[] }) {
  const [showPass, setShowPass] = useState<string | null>(null);
  const categories = ['Council', 'Water', 'Electricity', 'Gas', 'Internet', 'Land Tax', 'PropertyMe'];

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      {categories.map(cat => {
        const acc = data.find(u => u.category === cat);
        return (
          <div key={cat} className="bg-white border border-slate-200 rounded-[32px] p-8 shadow-sm flex flex-col justify-between hover:border-indigo-200 transition-all">
            <div>
              <p className="text-[11px] font-bold text-indigo-600 uppercase tracking-widest mb-6">{cat} account</p>
              <div className="grid grid-cols-1 gap-6">
                <div><p className="text-[9px] font-bold text-slate-400 uppercase">Login / User ID</p><p className="text-sm font-medium text-slate-700">{acc?.login_id || 'Not configured'}</p></div>
                <div>
                  <p className="text-[9px] font-bold text-slate-400 uppercase">Access key</p>
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-sm">{showPass === cat ? acc?.encrypted_password : "••••••••"}</span>
                    <button onClick={() => setShowPass(showPass === cat ? null : cat)} className="text-indigo-600">{showPass === cat ? <EyeOff size={14}/> : <Eye size={14}/>}</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}