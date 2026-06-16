"use client";
import { useState, useEffect } from "react";
import { X, Loader2 } from "lucide-react";
import { supabase } from "@/lib/supabase";

export default function NewProjectModal({ isOpen, onClose, onRefresh, userProfile }: any) {
  const [loading, setLoading] = useState(false);
  const [teams, setTeams] = useState<any[]>([]);
  const [selectedTeams, setSelectedTeams] = useState<string[]>([]);

  useEffect(() => { if (isOpen) fetchTeams(); }, [isOpen]);
  const fetchTeams = async () => {
    const { data } = await supabase.from("teams").select("*").eq("is_active", true);
    if (data) setTeams(data);
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoading(true);
    const fd = new FormData(e.currentTarget);
    const { data: { user } } = await supabase.auth.getUser();

    try {
      const { data: prop, error: pErr } = await supabase.from("properties").insert([{ street_address: fd.get("street"), suburb: fd.get("suburb"), state: fd.get("state"), postcode: fd.get("postcode") }]).select().single();
      if (pErr) throw pErr;
      const { data: proj, error: prErr } = await supabase.from("projects").insert([{ name: fd.get("name"), property_id: prop.id, company_id: userProfile?.company_id || null, created_by: user?.id, estimated_completion_date: fd.get("est_completion") }]).select().single();
      if (prErr) throw prErr;
      await supabase.from("project_members").insert([{ project_id: proj.id, profile_id: user?.id }]);
      onRefresh(); onClose();
    } catch (error: any) { alert(error.message); }
    finally { setLoading(false); }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-6 font-sans">
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-md" onClick={onClose} />
      <div className="relative w-full max-w-4xl bg-white rounded-[48px] p-10 shadow-2xl border border-slate-100 max-h-[95vh] overflow-y-auto">
        <h2 className="text-4xl font-black italic tracking-tighter mb-10">Initiate Project</h2>
        <form onSubmit={handleSubmit} className="grid grid-cols-1 md:grid-cols-2 gap-10">
          <div className="space-y-6">
            <input name="name" required placeholder="Project Name" className="w-full rounded-full border border-slate-100 bg-slate-50 px-8 py-5 font-bold outline-none" />
            <input name="est_completion" type="date" required className="w-full rounded-full border border-slate-100 bg-slate-50 px-8 py-5 font-bold outline-none" />
            <div className="bg-slate-50 p-6 rounded-[32px] border border-slate-100 space-y-3">
              <p className="text-[10px] font-black uppercase text-indigo-500 tracking-widest ml-2 mb-2 italic">Asset Location</p>
              <input name="street" required placeholder="Street" className="w-full rounded-full border border-slate-200 bg-white px-6 py-3 font-bold text-sm" />
              <input name="suburb" required placeholder="Suburb" className="w-full rounded-full border border-slate-200 bg-white px-6 py-3 font-bold text-sm" />
              <div className="grid grid-cols-2 gap-2">
                <select name="state" className="rounded-full border border-slate-200 bg-white px-6 py-3 font-bold text-sm"><option>NSW</option><option>VIC</option><option>QLD</option><option>WA</option><option>SA</option></select>
                <input name="postcode" required placeholder="Postcode" className="w-full rounded-full border border-slate-200 bg-white px-6 py-3 font-bold text-sm" />
              </div>
            </div>
          </div>
          <div className="space-y-6">
            <p className="text-[10px] font-black uppercase text-slate-400 tracking-widest ml-4">Assign Portfolio Teams</p>
            <div className="flex flex-wrap gap-2">{teams.map(t => (
              <button type="button" key={t.id} onClick={() => setSelectedTeams(prev => prev.includes(t.id) ? prev.filter(id => id !== t.id) : [...prev, t.id])} className={`px-5 py-2.5 rounded-full text-[11px] font-bold border transition-all ${selectedTeams.includes(t.id) ? 'bg-black border-black text-white' : 'bg-white border-slate-200 text-slate-400 hover:border-black'}`}>{t.team_name}</button>
            ))}</div>
            <textarea name="description" rows={4} placeholder="Objectives..." className="w-full rounded-[32px] border border-slate-100 bg-slate-50 p-6 font-bold text-sm outline-none resize-none" />
          </div>
          <button type="submit" disabled={loading} className="md:col-span-2 w-full bg-black text-white py-6 rounded-full font-black uppercase text-sm tracking-widest shadow-2xl active:scale-95 transition-all flex items-center justify-center">{loading ? <Loader2 className="animate-spin" /> : "Authorise & Launch Project"}</button>
        </form>
      </div>
    </div>
  );
}