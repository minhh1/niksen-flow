// components/NewProjectModal.tsx
"use client";

import { useState, useEffect } from "react";
import { X, Loader2, Check } from "lucide-react";
import { supabase } from "@/lib/supabase";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onRefresh: () => void;
}

export default function NewProjectModal({ isOpen, onClose, onRefresh }: Props) {
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState(false);
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [customFields, setCustomFields] = useState<any[]>([]);
  const [customValues, setCustomValues] = useState<Record<string, string>>({});

  const [name, setName] = useState('');
  const [status, setStatus] = useState('Open');
  const [description, setDescription] = useState('');
  const [estCompletion, setEstCompletion] = useState('');
  const [street, setStreet] = useState('');
  const [suburb, setSuburb] = useState('');
  const [state, setState] = useState('NSW');
  const [postcode, setPostcode] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    loadData();
  }, [isOpen]);

  const loadData = async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data: prof } = await supabase
      .from('profiles').select('active_company_id').eq('id', user.id).single();
    const cid = prof?.active_company_id;
    setCompanyId(cid);
    if (!cid) return;
    const { data: cf } = await supabase
      .from('company_custom_fields')
      .select('id, field_key, label, field_type, is_required, select_options, display_order')
      .eq('table_name', 'projects')
      .eq('company_id', cid)
      .is('deleted_at', null)
      .order('display_order');
    setCustomFields(cf || []);
  };

  const resetForm = () => {
    setName(''); setStatus('Open'); setDescription('');
    setEstCompletion(''); setStreet(''); setSuburb('');
    setState('NSW'); setPostcode(''); setCustomValues({});
    setSaved(false);
  };

  const handleClose = () => { resetForm(); onClose(); };

  const handleSubmit = async () => {
    if (!name.trim()) return;
    const missingRequired = customFields.filter(f => f.is_required && !customValues[f.id]?.trim());
    if (missingRequired.length > 0) {
      alert(`Please fill in required field${missingRequired.length > 1 ? 's' : ''}: ${missingRequired.map(f => f.label).join(', ')}`);
      return;
    }
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    try {
      let propertyId: string | null = null;
      if (street.trim()) {
        const { data: prop } = await supabase
          .from('properties')
          .insert({ company_id: companyId, street_address: street.trim(), suburb: suburb.trim() || null, state: state || null, postcode: postcode.trim() || null })
          .select('id').single();
        propertyId = prop?.id || null;
      }

      const { data: proj, error: projErr } = await supabase
        .from('projects')
        .insert({ company_id: companyId, name: name.trim(), status, description: description.trim() || null, estimated_completion_date: estCompletion || null, property_id: propertyId, created_by: user?.id })
        .select('id').single();
      if (projErr) throw projErr;

      if (customFields.length > 0 && proj) {
        const cfInserts = Object.entries(customValues)
          .filter(([, val]) => val?.trim())
          .map(([fieldId, val]) => {
            const field = customFields.find(f => f.id === fieldId);
            const isNum = field?.field_type === 'number' || field?.field_type === 'currency';
            const isBool = field?.field_type === 'boolean';
            const isDate = field?.field_type === 'date';
            return {
              company_id: companyId,
              record_id: proj.id,
              field_id: fieldId,
              table_name: 'projects',
              ...(isNum ? { value_number: parseFloat(val) }
                : isBool ? { value_boolean: val === 'true' }
                : isDate ? { value_date: val }
                : { value_text: val }),
            };
          });
        if (cfInserts.length > 0) {
          await supabase.from('company_custom_field_values').insert(cfInserts);
        }
      }

      // Best-effort — a project should still count as created even if Gmail
      // label setup fails (e.g. company hasn't configured Gmail sync yet).
      if (proj) {
        fetch('/api/gmail/create-project-label', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId: proj.id }),
        }).catch(err => console.error('[NewProjectModal] Gmail label creation failed:', err));
      }

      setSaved(true);
      setTimeout(() => { onRefresh(); handleClose(); }, 700);
    } catch (err: any) {
      alert(err.message);
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[250] flex items-center justify-center p-6 bg-slate-900/40 backdrop-blur-md font-sans">
      <div className="bg-white w-full max-w-2xl rounded-[40px] shadow-2xl flex flex-col max-h-[90vh]">

        <div className="flex items-center justify-between px-8 pt-8 pb-4 shrink-0">
          <div>
            <h2 className="text-2xl font-light uppercase tracking-tight text-slate-900">New Project</h2>
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1">Fill in the details below</p>
          </div>
          <button onClick={handleClose} className="p-2 text-slate-300 hover:text-black transition-colors"><X size={20} /></button>
        </div>

        <div className="flex-1 overflow-y-auto px-8 py-4 space-y-6">

          <div>
            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-3">Project details</p>
            <div className="space-y-3">
              <input value={name} onChange={e => setName(e.target.value)} placeholder="Project name *" className="w-full bg-slate-50 border border-slate-200 rounded-full py-3 px-5 text-[13px] font-medium outline-none focus:ring-4 focus:ring-indigo-100" />
              <div className="grid grid-cols-2 gap-3">
                <select value={status} onChange={e => setStatus(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-full py-3 px-5 text-[13px] font-medium outline-none appearance-none">
                  <option value="Open">Open</option>
                  <option value="Closed">Closed</option>
                  <option value="Pending">Pending</option>
                </select>
                <input type="date" value={estCompletion} onChange={e => setEstCompletion(e.target.value)} title="Estimated completion" className="w-full bg-slate-50 border border-slate-200 rounded-full py-3 px-5 text-[13px] font-medium outline-none" />
              </div>
              <textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="Description (optional)" rows={2} className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-3 px-5 text-[13px] font-medium outline-none resize-none focus:ring-4 focus:ring-indigo-100" />
            </div>
          </div>

          <div>
            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-3">Property (optional)</p>
            <div className="space-y-3">
              <input value={street} onChange={e => setStreet(e.target.value)} placeholder="Street address" className="w-full bg-slate-50 border border-slate-200 rounded-full py-3 px-5 text-[13px] font-medium outline-none focus:ring-4 focus:ring-indigo-100" />
              <div className="grid grid-cols-3 gap-3">
                <input value={suburb} onChange={e => setSuburb(e.target.value)} placeholder="Suburb" className="bg-slate-50 border border-slate-200 rounded-full py-3 px-5 text-[13px] font-medium outline-none" />
                <select value={state} onChange={e => setState(e.target.value)} className="bg-slate-50 border border-slate-200 rounded-full py-3 px-5 text-[13px] font-medium outline-none appearance-none">
                  {['NSW','VIC','QLD','WA','SA','TAS','NT','ACT'].map(s => <option key={s}>{s}</option>)}
                </select>
                <input value={postcode} onChange={e => setPostcode(e.target.value)} placeholder="Postcode" className="bg-slate-50 border border-slate-200 rounded-full py-3 px-5 text-[13px] font-medium outline-none" />
              </div>
            </div>
          </div>

          {customFields.length > 0 && (
            <div>
              <p className="text-[9px] font-bold text-violet-400 uppercase tracking-widest mb-3">Custom fields</p>
              <div className="space-y-3">
                {customFields.map(field => (
                  <div key={field.id}>
                    <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block mb-1.5 px-1">
                      {field.label}{field.is_required && <span className="text-red-400 ml-1">*</span>}
                    </label>
                    {field.field_type === 'boolean' ? (
                      <div className="flex gap-3">
                        {['true', 'false'].map(v => (
                          <button key={v} type="button" onClick={() => setCustomValues(p => ({ ...p, [field.id]: v }))}
                            className={`flex-1 py-3 rounded-full text-[11px] font-bold transition-all ${customValues[field.id] === v ? 'bg-indigo-600 text-white' : 'bg-slate-50 border border-slate-200 text-slate-500'}`}>
                            {v === 'true' ? 'Yes' : 'No'}
                          </button>
                        ))}
                      </div>
                    ) : field.field_type === 'select' && field.select_options?.length ? (
                      <select value={customValues[field.id] || ''} onChange={e => setCustomValues(p => ({ ...p, [field.id]: e.target.value }))}
                        className="w-full bg-slate-50 border border-slate-200 rounded-full py-3 px-5 text-[13px] font-medium outline-none appearance-none">
                        <option value="">Select...</option>
                        {field.select_options.map((opt: string) => <option key={opt} value={opt}>{opt}</option>)}
                      </select>
                    ) : (
                      <input
                        type={field.field_type === 'date' ? 'date' : field.field_type === 'number' || field.field_type === 'currency' ? 'number' : field.field_type === 'email' ? 'email' : 'text'}
                        value={customValues[field.id] || ''} onChange={e => setCustomValues(p => ({ ...p, [field.id]: e.target.value }))}
                        placeholder={`Enter ${field.label.toLowerCase()}...`}
                        className="w-full bg-slate-50 border border-slate-200 rounded-full py-3 px-5 text-[13px] font-medium outline-none focus:ring-4 focus:ring-indigo-100" />
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="px-8 py-6 border-t border-slate-100 shrink-0 flex gap-3">
          <button onClick={handleClose} className="flex-1 py-3 bg-slate-50 text-slate-600 rounded-full text-[11px] font-bold hover:bg-slate-100 transition-all">Cancel</button>
          <button onClick={handleSubmit} disabled={loading || !name.trim()}
            className={`flex-1 py-3 rounded-full text-[11px] font-bold transition-all flex items-center justify-center gap-2 ${saved ? 'bg-emerald-500 text-white' : 'bg-slate-900 text-white hover:bg-black disabled:opacity-40'}`}>
            {loading ? <><Loader2 size={13} className="animate-spin" /> Creating...</>
              : saved ? <><Check size={13} /> Created</>
              : 'Create project'}
          </button>
        </div>
      </div>
    </div>
  );
}
