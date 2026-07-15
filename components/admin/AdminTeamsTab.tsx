// components/admin/AdminTeamsTab.tsx
"use client";

import { useState, useEffect } from "react";
import { supabase } from "@/lib/supabase";
import { Users, Plus, X, Crown, Pencil, Check } from "lucide-react";

interface Profile {
  id: string;
  full_name: string | null;
  email: string | null;
}

interface TeamMember {
  profile_id: string;
  is_leader: boolean;
}

interface Team {
  id: string;
  team_name: string;
  leader_id: string | null;
  is_active: boolean;
  members: TeamMember[];
}

interface Props {
  companyId: string;
}

export default function AdminTeamsTab({ companyId }: Props) {
  const [teams, setTeams]             = useState<Team[]>([]);
  const [allProfiles, setAllProfiles] = useState<Profile[]>([]);
  const [loading, setLoading]         = useState(true);
  const [newTeamName, setNewTeamName] = useState('');
  const [editingId, setEditingId]     = useState<string | null>(null);
  const [editName, setEditName]       = useState('');
  const [expandedTeamId, setExpandedTeamId] = useState<string | null>(null);

  useEffect(() => { load(); }, [companyId]);

  const load = async () => {
    setLoading(true);

    // Load teams
    const { data: ts } = await supabase
      .from('teams')
      .select('id, team_name, leader_id, is_active')
      .order('team_name');

    // Load all company members
    const { data: ms } = await supabase
      .from('company_memberships')
      .select('user_id')
      .eq('company_id', companyId);

    let profs: Profile[] = [];
    if (ms?.length) {
      const { data: pd } = await supabase
        .from('profiles')
        .select('id, full_name, email')
        .in('id', ms.map((m: any) => m.user_id));
      profs = pd || [];
    }
    setAllProfiles(profs);

    // Load team members (many-to-many via team_members table or profiles.team_id)
    // Using profiles.team_id for now — members can only be in one team this way
    // Switch to team_members join table if multi-team is needed in DB
    const activeTeams: Team[] = (ts || [])
      .filter((t: any) => t.is_active)
      .map((t: any) => ({
        ...t,
        members: profs
          .filter(p => {
            // Check team_id on profile for now
            return false; // will be populated from team_members if available
          })
          .map(p => ({ profile_id: p.id, is_leader: t.leader_id === p.id })),
      }));

    // Load from team_members table (multi-team support)
    const { data: tmRows } = await supabase
      .from('team_members')
      .select('team_id, profile_id');

    if (tmRows) {
      activeTeams.forEach(team => {
        const memberIds = tmRows
          .filter((r: any) => r.team_id === team.id)
          .map((r: any) => r.profile_id);
        team.members = memberIds.map(pid => ({
          profile_id: pid,
          is_leader: team.leader_id === pid,
        }));
      });
    } else {
      // Fallback: use profiles.team_id
      activeTeams.forEach(team => {
        team.members = profs
          .filter((p: any) => (p as any).team_id === team.id)
          .map(p => ({ profile_id: p.id, is_leader: team.leader_id === p.id }));
      });
    }

    setTeams(activeTeams);
    setLoading(false);
  };

  const createTeam = async () => {
    if (!newTeamName.trim()) return;
    await supabase.from('teams').insert({ team_name: newTeamName.trim(), is_active: true });
    setNewTeamName('');
    load();
  };

  const renameTeam = async (teamId: string) => {
    if (!editName.trim()) return;
    await supabase.from('teams').update({ team_name: editName.trim() }).eq('id', teamId);
    setEditingId(null);
    load();
  };

  const deleteTeam = async (teamId: string) => {
    if (!window.confirm('Remove this team?')) return;
    await supabase.from('teams').update({ is_active: false }).eq('id', teamId);
    load();
  };

  const toggleMember = (teamId: string, profileId: string, isMember: boolean) => {
    // Update local state immediately — don't wait on the network round trip
    // for the checkbox to feel responsive.
    setTeams(prev => prev.map(t => {
      if (t.id !== teamId) return t;
      const members = isMember
        ? t.members.filter(m => m.profile_id !== profileId)
        : [...t.members, { profile_id: profileId, is_leader: false }];
      return { ...t, members };
    }));
    if (isMember) {
      supabase.from('team_members').delete().eq('team_id', teamId).eq('profile_id', profileId).then();
    } else {
      supabase.from('team_members')
        .upsert({ team_id: teamId, profile_id: profileId }, { onConflict: 'team_id,profile_id' }).then();
    }
  };

  const setLeader = async (teamId: string, profileId: string) => {
    await supabase.from('teams').update({ leader_id: profileId }).eq('id', teamId);
    setTeams(prev => prev.map(t => {
      if (t.id !== teamId) return t;
      return {
        ...t,
        leader_id: profileId,
        members: t.members.map(m => ({ ...m, is_leader: m.profile_id === profileId })),
      };
    }));
  };

  const getProfile = (id: string) => allProfiles.find(p => p.id === id);

  if (loading) return <p className="text-[11px] text-slate-400">Loading...</p>;

  return (
    <div className="space-y-6">

      {/* Create team */}
      <div className="bg-white border border-slate-200 rounded-[32px] p-6">
        <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-4">New team</p>
        <div className="flex gap-3">
          <input
            value={newTeamName}
            onChange={e => setNewTeamName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && createTeam()}
            placeholder="Team name..."
            className="flex-1 px-4 py-2.5 border border-slate-200 rounded-full text-[13px] outline-none focus:border-indigo-400"
          />
          <button
            onClick={createTeam}
            disabled={!newTeamName.trim()}
            className="px-5 py-2.5 bg-indigo-600 text-white text-[12px] font-bold rounded-full hover:bg-indigo-700 disabled:opacity-40 transition-colors"
          >
            Create
          </button>
        </div>
      </div>

      {/* Teams */}
      {teams.map(team => (
        <div key={team.id} className="bg-white border border-slate-200 rounded-[32px] overflow-hidden">

          {/* Header */}
          <div className="flex items-center gap-3 px-6 py-4 bg-slate-50 border-b border-slate-100">
            <Users size={14} className="text-indigo-500 shrink-0" />
            {editingId === team.id ? (
              <div className="flex items-center gap-2 flex-1">
                <input
                  autoFocus
                  value={editName}
                  onChange={e => setEditName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') renameTeam(team.id); if (e.key === 'Escape') setEditingId(null); }}
                  className="flex-1 px-3 py-1 border border-indigo-300 rounded-full text-[13px] outline-none"
                />
                <button onClick={() => renameTeam(team.id)} className="p-1.5 bg-indigo-600 text-white rounded-full"><Check size={12} /></button>
                <button onClick={() => setEditingId(null)} className="p-1.5 text-slate-400 hover:text-slate-700"><X size={12} /></button>
              </div>
            ) : (
              <>
                <p className="text-[13px] font-bold text-slate-800 flex-1">{team.team_name}</p>
                <span className="text-[10px] text-slate-400">{team.members.length} member{team.members.length !== 1 ? 's' : ''}</span>
                <button
                  onClick={() => setExpandedTeamId(expandedTeamId === team.id ? null : team.id)}
                  className="p-1.5 text-slate-300 hover:text-indigo-600 transition-colors"
                  title="Add member"
                >
                  <Plus size={13} />
                </button>
                <button
                  onClick={() => { setEditingId(team.id); setEditName(team.team_name); }}
                  className="p-1.5 text-slate-300 hover:text-indigo-600 transition-colors"
                >
                  <Pencil size={13} />
                </button>
                <button
                  onClick={() => deleteTeam(team.id)}
                  className="p-1.5 text-slate-300 hover:text-red-500 transition-colors"
                >
                  <X size={13} />
                </button>
              </>
            )}
          </div>

          {/* Current members */}
          {team.members.map(m => {
            const prof = getProfile(m.profile_id);
            if (!prof) return null;
            return (
              <div key={m.profile_id} className="flex items-center gap-3 px-6 py-3 border-b border-slate-50">
                <div className="w-7 h-7 rounded-full bg-indigo-100 flex items-center justify-center text-[10px] font-bold text-indigo-600 shrink-0">
                  {(prof.full_name || prof.email || '?').charAt(0).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[12px] font-medium text-slate-800 truncate">{prof.full_name || prof.email}</p>
                  {prof.full_name && <p className="text-[10px] text-slate-400 truncate">{prof.email}</p>}
                </div>
                {m.is_leader ? (
                  <span className="flex items-center gap-1 text-[10px] text-amber-500 font-bold shrink-0">
                    <Crown size={11} /> Leader
                  </span>
                ) : (
                  <button
                    onClick={() => setLeader(team.id, m.profile_id)}
                    title="Set as leader"
                    className="p-1 text-slate-300 hover:text-amber-500 transition-colors"
                  >
                    <Crown size={11} />
                  </button>
                )}
                <button
                  onClick={() => toggleMember(team.id, m.profile_id, true)}
                  className="p-1 text-slate-300 hover:text-red-500 transition-colors"
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}

          {/* Member checklist — shown when + is clicked */}
          {expandedTeamId === team.id && (
            <div className="px-6 py-3 space-y-1.5 border-t border-slate-100">
                <div className="flex items-center justify-between pb-1">
                  <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">Add / remove members</p>
                  <button
                    onClick={() => setExpandedTeamId(null)}
                    className="px-3 py-1.5 bg-slate-900 text-white text-[10px] font-bold rounded-full hover:bg-slate-700 transition-colors"
                  >
                    Done
                  </button>
                </div>
                {allProfiles.map(prof => {
                  const isMember = team.members.some(m => m.profile_id === prof.id);
                  return (
                    <button
                      key={prof.id}
                      onClick={() => toggleMember(team.id, prof.id, isMember)}
                      className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-2xl border text-left transition-colors active:scale-[0.98] ${
                        isMember
                          ? 'bg-indigo-50 border-indigo-200'
                          : 'bg-white border-slate-200 hover:border-indigo-200'
                      }`}
                    >
                      <div className={`w-4 h-4 rounded border-2 shrink-0 flex items-center justify-center ${
                        isMember ? 'bg-indigo-600 border-indigo-600' : 'border-slate-300'
                      }`}>
                        {isMember && (
                          <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
                            <path d="M1 4L3.5 6.5L9 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        )}
                      </div>
                      <div className="w-7 h-7 rounded-full bg-slate-100 flex items-center justify-center text-[10px] font-bold text-slate-500 shrink-0">
                        {(prof.full_name || prof.email || '?').charAt(0).toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className={`text-[12px] font-medium truncate ${isMember ? 'text-indigo-800' : 'text-slate-700'}`}>
                          {prof.full_name || prof.email}
                        </p>
                        {prof.full_name && <p className="text-[10px] text-slate-400 truncate">{prof.email}</p>}
                      </div>
                    </button>
                  );
                })}
              </div>
          )}

        </div>
      ))}

    </div>
  );
}