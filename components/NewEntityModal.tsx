// components/NewEntityModal.tsx
"use client";

import { useState, useEffect } from "react";
import { X, Loader2, Check, ShieldCheck } from "lucide-react";
import { supabase } from "@/lib/supabase";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onRefresh: () => void;
}

export default function NewEntityModal({ isOpen, onClose, onRefresh }: Props) {
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState(false);
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [customFields, setCustomFields] = useState<any[]>([]);
  const [customValues, setCustomValues] = useState<Record<string, string>>({});

  const [entityType, setEntityType] = useState('Company');
  const [name, setName] = useState('');
  const [abn, setAbn] = useState('');
  const [acn, setAcn] = useState('');
  const [tfn, setTfn] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [bankName, setBankName] = useState('');
  const [bsb, setBsb] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  // Trust specific
  const [trusteeName, setTrusteeName] = useState('');
  const [trusteeType, setTrusteeType] = useState('Company');
  const [trusteeAbn, setTrusteeAbn] = useState('');
  const [trustDeedDate, setTrustDeedDate] = useState('');

  const isTrust = entityType.toLowerCase().includes('trust');

  const ENTITY_TYPES = [
    'Company', 'Individual', 'Discretionary Family Trust', 'Fixed Unit Trust',
    'Lawyer', 'Accountant', 'Mortgage Broker', 'Real Estate Agent',
    'Local Council', 'Bank', 'Staff', 'Other',
  ];

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
      .eq('table_name', 'entities')
      .eq('company_id', cid)
      .is('deleted_at', null)
      .order('display_order');
    setCustomFields(cf || []);
  };

  const resetForm = () => {
    setEntityType('Company'); setName(''); setAbn(''); setAcn(''); setTfn('');
    setEmail(''); setPhone(''); setAddress(''); setBankName(''); setBsb('');
    setAccountNumber(''); setTrusteeName(''); setTrusteeType('Company');
    setTrusteeAbn(''); setTrustDeedDate(''); setCustomValues({}); setSaved(false);
  };

  const handleClose = () => { resetForm(); onClose(); };

  const handleSubmit = async () => {
    if (!name.trim()) return;
    if (isTrust && !trusteeName.trim()) { alert('Trustee name is required'); return; }
    const missingRequired = customFields.filter(f => f.is_required && !customValues[f.id]?.trim());
    if (missingRequired.length > 0) {
      alert(`Please fill in required field${missingRequired.length > 1 ? 's' : ''}: ${missingRequired.map(f => f.label).join(', ')}`);
      return;
    }
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();

    try {
      let mainEntityId: string;

      if (isTrust) {
        const { data: trustee, error: tErr } = await supabase
          .from('entities')
          .insert({ company_id: companyId, name: trusteeName.trim(), entity_type: trusteeType, abn: trusteeAbn.trim() || null })
          .select('id').single();
        if (tErr) throw tErr;

        const { data: trust, error: trErr } = await supabase
          .from('entities')
          .insert({ company_id: companyId, name: name.trim(), entity_type: entityType, abn: abn.trim() || null, tfn: tfn.trim() || null, trust_deed_date: trustDeedDate || null, email: email.trim() || null, phone: phone.trim() || null, registered_address_text: address.trim() || null, bank_name: bankName.trim() || null, bsb: bsb.trim() || null, account_number: accountNumber.trim() || null })
          .select('id').single();
        if (trErr) throw trErr;

        await supabase.from('entity_relationships').insert({
          parent_entity_id: trust.id, child_entity_id: trustee.id, relationship_type: 'Trustee',
        });
        mainEntityId = trust.id;
      } else {
        const { data: ent, error: entErr } = await supabase
          .from('entities')
          .insert({ company_id: companyId, name: name.trim(), entity_type: entityType, abn: abn.trim() || null, acn: acn.trim() || null, tfn: tfn.trim() || null, email: email.trim() || null, phone: phone.trim() || null, registered_address_text: address.trim() || null, bank_name: bankName.trim() || null, bsb: bsb.trim() || null, account_number: accountNumber.trim() || null })
          .select('id').single();
        if (entErr) throw entErr;
        mainEntityId = ent.id;
      }

      if (customFields.length > 0) {
        const cfInserts = Object.entries(customValues)
          .filter(([, val]) => val?.trim())
          .map(([fieldId, val]) => {
            const field = customFields.find(f => f.id === fieldId);
            const isNum = field?.field_type === 'number' || field?.field_type === 'currency';
            const isBool = field?.field_type === 'boolean';
            const isDate = field?.field_type === 'date';
            return {
              company_id: companyId, record_id: mainEntityId, field_id: fieldId, table_name: 'entities',
              ...(isNum ? { value_number: parseFloat(val) } : isBool ? { value_boolean: val === 'true' } : isDate ? { value_date: val } : { value_text: val }),
            };
          });
        if (cfInserts.length > 0) {
          await supabase.from('company_custom_field_values').insert(cfInserts);
        }
      }

      await supabase.from('audit_logs').insert({ entity_id: mainEntityId, user_id: user?.id, action: `Created ${entityType}`, details: { entity_name: name } });

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
            <h2 className="text-2xl font-light uppercase tracking-tight text-slate-900">New Entity</h2>
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1">Fill in the details below</p>
          </div>
          <button onClick={handleClose} className="p-2 text-slate-300 hover:text-black transition-colors"><X size={20} /></button>
        </div>

        <div className="flex-1 overflow-y-auto px-8 py-4 space-y-6">

          {/* Classification */}
          <div>
            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-3">Classification</p>
            <div className="space-y-3">
              <select value={entityType} onChange={e => setEntityType(e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 rounded-full py-3 px-5 text-[13px] font-medium outline-none appearance-none">
                {ENTITY_TYPES.map(t => <option key={t}>{t}</option>)}
              </select>
              <input value={name} onChange={e => setName(e.target.value)} placeholder="Legal name *"
                className="w-full bg-slate-50 border border-slate-200 rounded-full py-3 px-5 text-[13px] font-medium outline-none focus:ring-4 focus:ring-indigo-100" />
            </div>
          </div>

          {/* Trust specific */}
          {isTrust && (
            <div className="p-5 bg-indigo-50 border border-indigo-100 rounded-3xl space-y-3">
              <div className="flex items-center gap-2 mb-1">
                <ShieldCheck size={13} className="text-indigo-600" />
                <p className="text-[9px] font-bold text-indigo-600 uppercase tracking-widest">Trustee details</p>
              </div>
              <input value={trusteeName} onChange={e => setTrusteeName(e.target.value)} placeholder="Trustee name *"
                className="w-full bg-white border border-indigo-100 rounded-full py-3 px-5 text-[13px] font-medium outline-none focus:ring-4 focus:ring-indigo-100" />
              <div className="grid grid-cols-2 gap-3">
                <select value={trusteeType} onChange={e => setTrusteeType(e.target.value)}
                  className="bg-white border border-indigo-100 rounded-full py-3 px-5 text-[13px] font-medium outline-none appearance-none">
                  <option>Company</option><option>Individual</option>
                </select>
                <input value={trusteeAbn} onChange={e => setTrusteeAbn(e.target.value)} placeholder="Trustee ABN"
                  className="bg-white border border-indigo-100 rounded-full py-3 px-5 text-[13px] font-medium outline-none" />
              </div>
              <div>
                <label className="text-[9px] font-bold text-indigo-400 uppercase tracking-widest block mb-1.5 px-1">Trust deed date</label>
                <input type="date" value={trustDeedDate} onChange={e => setTrustDeedDate(e.target.value)}
                  className="w-full bg-white border border-indigo-100 rounded-full py-3 px-5 text-[13px] font-medium outline-none" />
              </div>
            </div>
          )}

          {/* Identifiers */}
          <div>
            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-3">Identifiers</p>
            <div className="grid grid-cols-3 gap-3">
              <input value={abn} onChange={e => setAbn(e.target.value)} placeholder="ABN"
                className="bg-slate-50 border border-slate-200 rounded-full py-3 px-5 text-[13px] font-medium outline-none" />
              {!isTrust && (
                <input value={acn} onChange={e => setAcn(e.target.value)} placeholder="ACN"
                  className="bg-slate-50 border border-slate-200 rounded-full py-3 px-5 text-[13px] font-medium outline-none" />
              )}
              <input value={tfn} onChange={e => setTfn(e.target.value)} placeholder="TFN"
                className="bg-slate-50 border border-slate-200 rounded-full py-3 px-5 text-[13px] font-medium outline-none" />
            </div>
          </div>

          {/* Contact */}
          <div>
            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-3">Contact</p>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <input value={email} onChange={e => setEmail(e.target.value)} placeholder="Email" type="email"
                  className="bg-slate-50 border border-slate-200 rounded-full py-3 px-5 text-[13px] font-medium outline-none" />
                <input value={phone} onChange={e => setPhone(e.target.value)} placeholder="Phone"
                  className="bg-slate-50 border border-slate-200 rounded-full py-3 px-5 text-[13px] font-medium outline-none" />
              </div>
              <input value={address} onChange={e => setAddress(e.target.value)} placeholder="Registered address"
                className="w-full bg-slate-50 border border-slate-200 rounded-full py-3 px-5 text-[13px] font-medium outline-none" />
            </div>
          </div>

          {/* Banking */}
          <div>
            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-3">Banking</p>
            <div className="space-y-3">
              <input value={bankName} onChange={e => setBankName(e.target.value)} placeholder="Bank name"
                className="w-full bg-slate-50 border border-slate-200 rounded-full py-3 px-5 text-[13px] font-medium outline-none" />
              <div className="grid grid-cols-2 gap-3">
                <input value={bsb} onChange={e => setBsb(e.target.value)} placeholder="BSB"
                  className="bg-slate-50 border border-slate-200 rounded-full py-3 px-5 text-[13px] font-medium outline-none" />
                <input value={accountNumber} onChange={e => setAccountNumber(e.target.value)} placeholder="Account number"
                  className="bg-slate-50 border border-slate-200 rounded-full py-3 px-5 text-[13px] font-medium outline-none" />
              </div>
            </div>
          </div>

          {/* Custom fields */}
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
              : 'Create entity'}
          </button>
        </div>
      </div>
    </div>
  );
}
