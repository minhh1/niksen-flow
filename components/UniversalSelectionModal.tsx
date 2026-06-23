"use client";

import { useState, useEffect } from "react";
import { 
  X, Search, Check, Building2, Landmark, ShieldCheck, 
  Loader2, PlusCircle, User, DollarSign, Mail, Phone, MapPin 
} from "lucide-react";
import { supabase } from "@/lib/supabase";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (id: string, name: string) => void;
  title: string;
  table: "entities" | "projects" | "properties";
}

export default function UniversalSelectionModal({ isOpen, onClose, onSelect, title, table }: Props) {
  const [view, setView] = useState<"select" | "create">("select");
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  
  // Entity specific state
  const [entityType, setEntityType] = useState("Company");

  useEffect(() => {
    if (isOpen && view === "select") fetchItems();
  }, [isOpen, search, table, view]);

  const fetchItems = async () => {
    setLoading(true);
    const nameCol = table === 'properties' ? 'street_address' : 'name';
    const { data } = await supabase
      .from(table)
      .select(`id, ${nameCol}`)
      .ilike(nameCol, `%${search}%`)
      .is('deleted_at', null)
      .limit(8);
    setItems(data || []);
    setLoading(false);
  };

  const handleCreate = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoading(true);
    const fd = new FormData(e.currentTarget);
    const { data: { user } } = await supabase.auth.getUser();
    const { data: prof } = await supabase.from("profiles").select("company_id").eq("id", user?.id).single();
    const compId = prof?.company_id;

    try {
      let resultId = "";
      let resultName = "";

      if (table === "entities") {
        if (entityType.toLowerCase().includes("trust")) {
          // --- STAGE 1: CREATE TRUSTEE ---
          const { data: trustee, error: tErr } = await supabase.from("entities").insert([{ 
            name: fd.get("t_name"), 
            company_id: compId,
            entity_type: fd.get("t_type") || "Company",
            abn: fd.get("t_abn")
          }]).select().single();
          if (tErr) throw tErr;
          
          // --- STAGE 2: CREATE TRUST ---
          const { data: trust, error: trErr } = await supabase.from("entities").insert([{
            name: fd.get("name"), 
            entity_type: entityType, 
            company_id: compId, 
            abn: fd.get("abn"), 
            tfn: fd.get("tfn"),
            trust_deed_date: fd.get("deed"),
            gst_registered: fd.get("gst") === "on",
            bank_name: fd.get("bank"),
            bsb: fd.get("bsb"),
            account_number: fd.get("acc"),
            nab_connect_id: fd.get("nab")
          }]).select().single();
          if (trErr) throw trErr;

          // --- STAGE 3: LINK RELATIONSHIP ---
          await supabase.from("entity_relationships").insert([{ 
            parent_entity_id: trust.id, 
            child_entity_id: trustee.id, 
            relationship_type: 'Trustee' 
          }]);
          
          resultId = trust.id; resultName = trust.name;
        } else {
          // Standard Entity (Company, Professional, etc)
          const { data: ent, error: entErr } = await supabase.from("entities").insert([{ 
            name: fd.get("name"), 
            entity_type: entityType, 
            company_id: compId, 
            abn: fd.get("abn"), 
            acn: fd.get("acn"),
            tfn: fd.get("tfn"),
            gst_registered: fd.get("gst") === "on",
            nab_connect_id: fd.get("nab"),
            bank_name: fd.get("bank"),
            bsb: fd.get("bsb"),
            account_number: fd.get("acc")
          }]).select().single();
          if (entErr) throw entErr;
          resultId = ent.id; resultName = ent.name;
        }
      }

      if (table === "properties") {
        const { data: prop, error: pErr } = await supabase.from("properties").insert([{ 
          street_address: fd.get("address"), 
          suburb: fd.get("suburb"), 
          state: fd.get("state"), 
          postcode: fd.get("postcode"),
          folio_identifier: fd.get("folio"),
          purchase_price: parseFloat(String(fd.get("price") || "0").replace(/[$,]/g, "")),
          company_id: compId 
        }]).select().single();
        if (pErr) throw pErr;
        resultId = prop.id; resultName = prop.street_address;
      }

      onSelect(resultId, resultName);
      onClose();
      setView("select");
    } catch (err: any) { 
      alert(`Onboarding error: ${err.message}`); 
    }
    setLoading(false);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[500] flex items-center justify-center p-6 bg-slate-900/60 backdrop-blur-md font-sans antialiased text-slate-600">
      <div className="bg-white w-full max-w-4xl rounded-[48px] shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        
        {/* MODAL HEADER */}
        <div className="p-10 border-b border-slate-100 flex justify-between items-center bg-white shrink-0">
          <div>
            <h2 className="text-3xl font-light text-slate-900 uppercase tracking-tighter leading-none">{title}</h2>
            <div className="flex gap-6 mt-4">
              <button onClick={() => setView("select")} className={`text-[11px] font-bold uppercase tracking-widest transition-all ${view === 'select' ? 'text-indigo-600 border-b-2 border-indigo-600 pb-1' : 'text-slate-400'}`}>Search records</button>
              <button onClick={() => setView("create")} className={`text-[11px] font-bold uppercase tracking-widest transition-all ${view === 'create' ? 'text-indigo-600 border-b-2 border-indigo-600 pb-1' : 'text-slate-400'}`}>Onboard new {table.slice(0,-1)}</button>
            </div>
          </div>
          <button onClick={onClose} className="p-3 text-slate-300 hover:text-black transition-colors"><X size={24}/></button>
        </div>

        {/* MODAL CONTENT */}
        <div className="flex-1 overflow-y-auto p-10 bg-[#F9FAFB] custom-scrollbar">
          {view === "select" ? (
            <div className="max-w-2xl mx-auto space-y-6">
              <div className="relative mb-6">
                <Search className="absolute left-6 top-1/2 -translate-y-1/2 text-slate-300" size={20} />
                <input autoFocus placeholder={`Search ${table}...`} className="w-full bg-white border border-slate-200 rounded-full py-5 pl-16 pr-8 text-sm font-medium outline-none focus:ring-8 focus:ring-black/5 transition-all" value={search} onChange={(e) => setSearch(e.target.value)} />
              </div>
              <div className="space-y-2">
                {items.map(item => (
                  <button key={item.id} onClick={() => onSelect(item.id, item.name || item.street_address)} className="flex items-center justify-between p-6 bg-white border border-slate-100 rounded-[32px] hover:border-black transition-all w-full group shadow-sm">
                    <span className="text-[14px] font-medium text-slate-700 uppercase">{item.name || item.street_address}</span>
                    <Check size={20} className="text-indigo-600 opacity-0 group-hover:opacity-100" />
                  </button>
                ))}
                {items.length === 0 && <p className="p-20 text-center text-slate-300 uppercase text-[10px] font-bold tracking-widest italic">No existing records found</p>}
              </div>
            </div>
          ) : (
            /* ONBOARDING FORM */
            <form onSubmit={handleCreate} className="space-y-10 animate-in zoom-in-95">
              
              {table === 'entities' && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-10">
                  <div className="space-y-6">
                    <div className="space-y-2">
                      <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest ml-4">Classification</label>
                      <select onChange={(e) => setEntityType(e.target.value)} className="w-full bg-white border border-slate-200 rounded-full py-4 px-8 text-sm font-medium outline-none">
                        <optgroup label="Main"><option>Company</option><option>Discretionary Family Trust</option><option>Fixed Unit Trust</option></optgroup>
                        <optgroup label="Professionals"><option>Lawyer</option><option>Accountant</option><option>Mortgage Broker</option></optgroup>
                        <optgroup label="Government"><option>Local Council</option></optgroup>
                      </select>
                    </div>
                    <input name="name" required placeholder="Legal entity name" className="w-full bg-white border border-slate-200 rounded-full py-4 px-8 text-sm font-medium" />
                    <div className="grid grid-cols-2 gap-4">
                      <input name="abn" placeholder="ABN" className="w-full bg-white border border-slate-200 rounded-full py-4 px-8 text-sm font-medium" />
                      <input name="acn" placeholder="ACN" className="w-full bg-white border border-slate-200 rounded-full py-4 px-8 text-sm font-medium" />
                    </div>
                  </div>

                  <div className="space-y-6">
                    {/* TRUST SPECIFIC LOGIC */}
                    {entityType.toLowerCase().includes("trust") ? (
                      <div className="p-8 bg-indigo-50 border border-indigo-100 rounded-[40px] space-y-4">
                        <p className="text-[10px] font-bold uppercase text-indigo-600 flex items-center gap-2 tracking-widest"><ShieldCheck size={14}/> Trustee generation</p>
                        <input name="t_name" required placeholder="Full trustee name" className="w-full rounded-full border-none bg-white px-6 py-4 text-sm font-medium shadow-sm" />
                        <select name="t_type" className="w-full rounded-full border-none bg-white px-6 py-4 text-sm font-medium shadow-sm outline-none"><option>Company</option><option>Individual</option></select>
                        <input name="t_abn" placeholder="Trustee ABN" className="w-full rounded-full border-none bg-white px-6 py-4 text-sm font-medium shadow-sm" />
                        <input name="deed" type="date" title="Trust deed date" className="w-full rounded-full border-none bg-white px-6 py-4 text-sm font-medium shadow-sm outline-none" />
                      </div>
                    ) : (
                      <div className="space-y-4">
                        <input name="email" type="email" placeholder="Contact email" className="w-full bg-white border border-slate-200 rounded-full py-4 px-8 text-sm font-medium" />
                        <input name="phone" placeholder="Phone number" className="w-full bg-white border border-slate-200 rounded-full py-4 px-8 text-sm font-medium" />
                        <input name="nab" placeholder="NAB connect ID" className="w-full bg-white border border-slate-200 rounded-full py-4 px-8 text-sm font-medium" />
                      </div>
                    )}
                  </div>

                  <div className="md:col-span-2 grid grid-cols-3 gap-6 p-8 bg-slate-50 border border-slate-100 rounded-[40px]">
                    <input name="bank" placeholder="Bank name" className="bg-white border border-slate-200 rounded-full px-6 py-3 text-xs font-medium" />
                    <input name="bsb" placeholder="BSB" className="bg-white border border-slate-200 rounded-full px-6 py-3 text-xs font-medium" />
                    <input name="acc" placeholder="Account no." className="bg-white border border-slate-200 rounded-full px-6 py-3 text-xs font-medium" />
                  </div>
                </div>
              )}

              {table === 'properties' && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-10">
                   <div className="space-y-4">
                      <input name="address" required placeholder="Street address" className="w-full bg-white border border-slate-200 rounded-full py-4 px-8 text-sm font-medium" />
                      <div className="grid grid-cols-2 gap-4">
                        <input name="suburb" placeholder="Suburb" className="w-full bg-white border border-slate-200 rounded-full py-4 px-8 text-sm font-medium" />
                        <input name="postcode" placeholder="Postcode" className="w-full bg-white border border-slate-200 rounded-full py-4 px-8 text-sm font-medium" />
                      </div>
                      <select name="state" className="w-full bg-white border border-slate-200 rounded-full py-4 px-8 text-sm font-medium"><option>NSW</option><option>VIC</option><option>QLD</option><option>WA</option><option>SA</option></select>
                   </div>
                   <div className="space-y-4">
                      <input name="folio" placeholder="Folio identifier" className="w-full bg-white border border-slate-200 rounded-full py-4 px-8 text-sm font-medium" />
                      <input name="price" type="number" placeholder="Purchase price ($)" className="w-full bg-white border border-slate-200 rounded-full py-4 px-8 text-sm font-medium" />
                   </div>
                </div>
              )}

              <button disabled={loading} className="w-full bg-black text-white py-6 rounded-full font-bold uppercase text-xs tracking-widest shadow-2xl hover:bg-slate-800 transition-all flex items-center justify-center gap-4">
                {loading ? <Loader2 className="animate-spin" /> : "Verify and save record"}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}