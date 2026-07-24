// components/NewPropertyModal.tsx
"use client";

import { useState, useEffect } from "react";
import { X, Loader2, Check } from "lucide-react";
import { supabase } from "@/lib/supabase";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onRefresh: () => void;
  tableName?: string; // defaults to 'properties', can be custom table slug
}

export default function NewPropertyModal({ isOpen, onClose, onRefresh, tableName = 'properties' }: Props) {
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState(false);
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [customFields, setCustomFields] = useState<any[]>([]);
  const [customValues, setCustomValues] = useState<Record<string, string>>({});

  // Property base fields
  const [street, setStreet] = useState('');
  const [suburb, setSuburb] = useState('');
  const [state, setState] = useState('NSW');
  const [postcode, setPostcode] = useState('');
  const [country, setCountry] = useState('Australia');
  const [purchasePrice, setPurchasePrice] = useState('');
  const [purchaseDate, setPurchaseDate] = useState('');
  const [folioIdentifier, setFolioIdentifier] = useState('');

  // Generic custom table — just a name field
  const [recordName, setRecordName] = useState('');

  const isProperty = tableName === 'properties';
  const isCustomTable = !isProperty;

  useEffect(() => {
    if (!isOpen) return;
    loadData();
  }, [isOpen, tableName]);

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
      .eq('table_name', tableName)
      .eq('company_id', cid)
      .is('deleted_at', null)
      .order('display_order');
    setCustomFields(cf || []);
  };

  const resetForm = () => {
    setStreet(''); setSuburb(''); setState('NSW'); setPostcode('');
    setCountry('Australia'); setPurchasePrice(''); setPurchaseDate('');
    setFolioIdentifier(''); setRecordName(''); setCustomValues({});
    setSaved(false);
  };

  const handleClose = () => { resetForm(); onClose(); };

  const handleSubmit = async () => {
    if (isProperty && !street.trim()) return;
    if (isCustomTable && !recordName.trim()) return;
    const missingRequired = customFields.filter(f => f.is_required && !customValues[f.id]?.trim());
    if (missingRequired.length > 0) {
      alert(`Please fill in required field${missingRequired.length > 1 ? 's' : ''}: ${missingRequired.map(f => f.label).join(', ')}`);
      return;
    }
    setLoading(true);

    try {
      let recordId: string;

      if (isProperty) {
        const { data: prop, error } = await supabase
          .from('properties')
          .insert({
            company_id: companyId,
            street_address: street.trim(),
            suburb: suburb.trim() || null,
            state: state || null,
            postcode: postcode.trim() || null,
            country: country.trim() || null,
            purchase_price: purchasePrice ? parseFloat(purchasePrice) : null,
            purchase_date: purchaseDate || null,
            folio_identifier: folioIdentifier.trim() || null,
          })
          .select('id').single();
        if (error) throw error;
        recordId = prop.id;
      } else {
        // Generic custom table record
        const { data: rec, error } = await supabase
          .from(tableName)
          .insert({ company_id: companyId, name: recordName.trim() })
          .select('id').single();
        if (error) throw error;
        recordId = rec.id;
      }

      // Save custom field values
      if (customFields.length > 0) {
        const cfInserts = Object.entries(customValues)
          .filter(([, val]) => val?.trim())
          .map(([fieldId, val]) => {
            const field = customFields.find(f => f.id === fieldId);
            const isNum = field?.field_type === 'number' || field?.field_type === 'currency';
            const isBool = field?.field_type === 'boolean';
            const isDate = field?.field_type === 'date';
            return {
              company_id: companyId, record_id: recordId,
              field_id: fieldId, table_name: tableName,
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

      setSaved(true);
      setTimeout(() => { onRefresh(); handleClose(); }, 700);
    } catch (err: any) {
      alert(err.message);
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  const title = isProperty
    ? 'New Property'
    : `New ${tableName.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).replace(/s$/, '')}`;

  const canSubmit = isProperty ? !!street.trim() : !!recordName.trim();

  return (
    <div className="fixed inset-0 z-[250] flex items-center justify-center p-6 bg-slate-900/40 backdrop-blur-md font-sans">
      <div className="bg-white w-full max-w-2xl rounded-[40px] shadow-2xl flex flex-col max-h-[90vh]">

        <div className="flex items-center justify-between px-8 pt-8 pb-4 shrink-0">
          <div>
            <h2 className="text-2xl font-light uppercase tracking-tight text-slate-900">{title}</h2>
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1">Fill in the details below</p>
          </div>
          <button onClick={handleClose} className="p-2 text-slate-300 hover:text-black transition-colors"><X size={20} /></button>
        </div>

        <div className="flex-1 overflow-y-auto px-8 py-4 space-y-6">

          {isCustomTable && (
            <div>
              <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block mb-2 px-1">Name *</label>
              <input value={recordName} onChange={e => setRecordName(e.target.value)} placeholder="Record name"
                className="w-full bg-slate-50 border border-slate-200 rounded-full py-3 px-5 text-[13px] font-medium outline-none focus:ring-4 focus:ring-indigo-100" />
            </div>
          )}

          {isProperty && (
            <>
              <div>
                <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-3">Address</p>
                <div className="space-y-3">
                  <input value={street} onChange={e => setStreet(e.target.value)} placeholder="Street address *"
                    className="w-full bg-slate-50 border border-slate-200 rounded-full py-3 px-5 text-[13px] font-medium outline-none focus:ring-4 focus:ring-indigo-100" />
                  <div className="grid grid-cols-3 gap-3">
                    <input value={suburb} onChange={e => setSuburb(e.target.value)} placeholder="Suburb"
                      className="bg-slate-50 border border-slate-200 rounded-full py-3 px-5 text-[13px] font-medium outline-none" />
                    <select value={state} onChange={e => setState(e.target.value)}
                      className="bg-slate-50 border border-slate-200 rounded-full py-3 px-5 text-[13px] font-medium outline-none appearance-none">
                      {['NSW','VIC','QLD','WA','SA','TAS','NT','ACT'].map(s => <option key={s}>{s}</option>)}
                    </select>
                    <input value={postcode} onChange={e => setPostcode(e.target.value)} placeholder="Postcode"
                      className="bg-slate-50 border border-slate-200 rounded-full py-3 px-5 text-[13px] font-medium outline-none" />
                  </div>
                  <input value={country} onChange={e => setCountry(e.target.value)} placeholder="Country"
                    className="w-full bg-slate-50 border border-slate-200 rounded-full py-3 px-5 text-[13px] font-medium outline-none" />
                </div>
              </div>

              <div>
                <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-3">Details</p>
                <div className="space-y-3">
                  <input value={folioIdentifier} onChange={e => setFolioIdentifier(e.target.value)} placeholder="Folio identifier"
                    className="w-full bg-slate-50 border border-slate-200 rounded-full py-3 px-5 text-[13px] font-medium outline-none" />
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block mb-1.5 px-1">Purchase price</label>
                      <input type="number" value={purchasePrice} onChange={e => setPurchasePrice(e.target.value)} placeholder="0.00"
                        className="w-full bg-slate-50 border border-slate-200 rounded-full py-3 px-5 text-[13px] font-medium outline-none" />
                    </div>
                    <div>
                      <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block mb-1.5 px-1">Purchase date</label>
                      <input type="date" value={purchaseDate} onChange={e => setPurchaseDate(e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-full py-3 px-5 text-[13px] font-medium outline-none" />
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}

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
          <button onClick={handleSubmit} disabled={loading || !canSubmit}
            className={`flex-1 py-3 rounded-full text-[11px] font-bold transition-all flex items-center justify-center gap-2 ${saved ? 'bg-emerald-500 text-white' : 'bg-slate-900 text-white hover:bg-black disabled:opacity-40'}`}>
            {loading ? <><Loader2 size={13} className="animate-spin" /> Creating...</>
              : saved ? <><Check size={13} /> Created</>
              : `Create ${isProperty ? 'property' : 'record'}`}
          </button>
        </div>
      </div>
    </div>
  );
}
