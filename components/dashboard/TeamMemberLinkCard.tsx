"use client";

import { useState, useEffect, useRef } from "react";
import { Users, X, Search, Loader2, Sparkles } from "lucide-react";
import { supabase } from "@/lib/supabase";

interface TeamMember { profileId: string; fullName: string; email: string }

interface Props {
  companyId: string;
  entityId: string;
  entityName: string;
  linkedProfileId: string | null;
  onLinked: (profileId: string | null) => void;
}

// Normalizes "Last, First [Middle]" -> "First [Middle] Last" so an entity
// name can be compared against profiles.full_name (always "First Last") --
// entities imported from a practice-management export are commonly stored
// surname-first (e.g. this company's real data has "Pakarinen, Anna").
function normalizeName(name: string): string {
  const trimmed = name.trim();
  const commaIdx = trimmed.indexOf(',');
  if (commaIdx === -1) return trimmed.toLowerCase().replace(/\s+/g, ' ');
  const last = trimmed.slice(0, commaIdx).trim();
  const rest = trimmed.slice(commaIdx + 1).trim();
  return `${rest} ${last}`.toLowerCase().replace(/\s+/g, ' ');
}

// Links an `entities` row to a real logged-in user via entities.linked_profile_id
// (see supabase/entities_contact_fields.sql) -- e.g. so a "Staff" entity used
// on Time & Fee Entries corresponds to an actual company member. Suggests a
// match (by normalized name -- entities has no email/phone columns despite
// NewEntityModal.tsx trying to insert them, a separate pre-existing bug)
// against the company's existing team (company_memberships + profiles)
// instead of requiring a manual search every time, but always offers the
// manual search too since a suggestion can be wrong or absent.
export default function TeamMemberLinkCard({ companyId, entityId, entityName, linkedProfileId, onLinked }: Props) {
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      const { data: memberships } = await supabase
        .from('company_memberships').select('user_id').eq('company_id', companyId);
      const userIds = (memberships || []).map(m => m.user_id);
      if (!userIds.length) { if (active) setLoading(false); return; }
      const { data: profiles } = await supabase.from('profiles').select('id, full_name, email').in('id', userIds);
      const list = (profiles || []).map(p => ({
        profileId: p.id, fullName: p.full_name || p.email || 'Unnamed', email: p.email || '',
      }));
      if (active) { setMembers(list); setLoading(false); }
    })();
    return () => { active = false; };
  }, [companyId]);

  useEffect(() => {
    if (!searching) return;
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) { setSearching(false); setQuery(''); }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [searching]);

  const linked = linkedProfileId ? members.find(m => m.profileId === linkedProfileId) : null;
  const normalizedEntityName = normalizeName(entityName);
  const suggestion = !linkedProfileId && !loading
    ? members.find(m => normalizeName(m.fullName) === normalizedEntityName)
    : null;

  const link = async (profileId: string | null) => {
    setSaving(true);
    const { error } = await supabase.from('entities').update({ linked_profile_id: profileId }).eq('id', entityId);
    setSaving(false);
    if (!error) { onLinked(profileId); setSearching(false); setQuery(''); }
  };

  if (loading) return null; // no flash of "not linked" while resolving

  const filtered = query.trim()
    ? members.filter(m => m.fullName.toLowerCase().includes(query.toLowerCase()) || m.email.toLowerCase().includes(query.toLowerCase()))
    : members;

  return (
    <div className="mb-4" ref={containerRef}>
      {linked ? (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-indigo-50 border border-indigo-100 rounded-full w-fit">
          <Users size={12} className="text-indigo-500" />
          <span className="text-[11px] font-bold text-indigo-700">{linked.fullName}</span>
          <span className="text-[10px] text-indigo-400">team member</span>
          <button onClick={() => link(null)} disabled={saving} className="text-indigo-300 hover:text-red-500 transition-colors ml-1">
            <X size={11} />
          </button>
        </div>
      ) : suggestion ? (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-amber-50 border border-amber-200 rounded-full w-fit">
          <Sparkles size={12} className="text-amber-500 shrink-0" />
          <span className="text-[11px] text-amber-700">
            Looks like <span className="font-bold">{suggestion.fullName}</span>{suggestion.email ? ` (${suggestion.email})` : ''} — link as team member?
          </span>
          <button
            onClick={() => link(suggestion.profileId)}
            disabled={saving}
            className="ml-1 px-2 py-0.5 bg-amber-600 text-white rounded-full text-[10px] font-bold hover:bg-amber-700 transition-all disabled:opacity-50 flex items-center gap-1"
          >
            {saving && <Loader2 size={10} className="animate-spin" />} Link
          </button>
          <button onClick={() => setSearching(true)} className="text-amber-400 hover:text-amber-700 text-[10px] font-bold">
            Not them
          </button>
        </div>
      ) : !searching ? (
        <button
          onClick={() => setSearching(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-bold text-slate-400 hover:text-indigo-600 border border-dashed border-slate-200 hover:border-indigo-300 transition-all"
        >
          <Users size={12} /> Link to a team member
        </button>
      ) : null}

      {searching && (
        <div className="relative mt-2 max-w-xs">
          <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-full px-3 py-1.5">
            <Search size={12} className="text-slate-400 shrink-0" />
            <input
              autoFocus
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search team members..."
              className="flex-1 bg-transparent text-[12px] outline-none"
            />
            <button onClick={() => { setSearching(false); setQuery(''); }} className="text-slate-300 hover:text-slate-600 shrink-0">
              <X size={12} />
            </button>
          </div>
          <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-slate-200 rounded-2xl shadow-xl z-20 max-h-48 overflow-y-auto">
            {members.length === 0 ? (
              <p className="px-4 py-3 text-[11px] text-slate-300 italic">No team members yet</p>
            ) : filtered.length === 0 ? (
              <p className="px-4 py-3 text-[11px] text-slate-300 italic">No matches</p>
            ) : filtered.map(m => (
              <button
                key={m.profileId}
                onClick={() => link(m.profileId)}
                className="w-full text-left px-4 py-2 text-[12px] font-medium text-slate-700 hover:bg-indigo-50 transition-colors flex items-center justify-between gap-2"
              >
                <span className="truncate">{m.fullName}</span>
                <span className="text-slate-400 text-[10px] shrink-0">{m.email}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
