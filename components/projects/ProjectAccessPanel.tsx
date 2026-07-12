// components/projects/ProjectAccessPanel.tsx
"use client";

import { useState, useEffect } from "react";
import { supabase } from "@/lib/supabase";
import { Users, User, Plus, X, Shield, Crown } from "lucide-react";

interface Team {
  id: string;
  team_name: string;
  leader_id: string | null;
  members?: Member[];
}

interface Member {
  id: string;
  full_name: string | null;
  email: string | null;
}

interface Props {
  projectId: string;
  companyId: string;
  isAdmin: boolean;
}

type AccessMode = 'all_members' | 'specific_teams' | 'specific_members';

export default function ProjectAccessPanel({ projectId, companyId, isAdmin }: Props) {
  const [accessMode, setAccessMode]       = useState<AccessMode>('all_members');
  const [assignedTeams, setAssignedTeams] = useState<Team[]>([]);
  const [assignedMembers, setAssignedMembers] = useState<Member[]>([]);
  const [allTeams, setAllTeams]           = useState<Team[]>([]);
  const [allMembers, setAllMembers]       = useState<Member[]>([]);
  const [loading, setLoading]             = useState(true);

  useEffect(() => { load(); }, [projectId]);

  const load = async () => {
    setLoading(true);

    // Resolve companyId if not passed as prop
    let cid = companyId;
    if (!cid) {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const { data: prof } = await supabase
          .from('profiles').select('active_company_id').eq('id', user.id).single();
        cid = prof?.active_company_id || '';
      }
    }

    const { data: project } = await supabase
      .from('projects').select('access_mode').eq('id', projectId).single();
    if (project?.access_mode) setAccessMode(project.access_mode as AccessMode);

    // Assigned teams with members
    const { data: pts } = await supabase
      .from('project_teams')
      .select('team:team_id(id, team_name, leader_id)')
      .eq('project_id', projectId);

    const teams: Team[] = (pts || []).map((r: any) => r.team).filter(Boolean);
    // Load members for each team
    for (const team of teams) {
      const { data: profs } = await supabase
        .from('profiles').select('id, full_name, email').eq('team_id', team.id);
      team.members = profs || [];
    }
    setAssignedTeams(teams);

    // Assigned individual members
    const { data: pms } = await supabase
      .from('project_members')
      .select('profile:profile_id(id, full_name, email)')
      .eq('project_id', projectId);
    setAssignedMembers((pms || []).map((r: any) => r.profile).filter(Boolean));

    // All company teams
    const { data: allT } = await supabase
      .from('teams').select('id, team_name, leader_id').eq('is_active', true).order('team_name');
    setAllTeams(allT || []);

    // All company members — get user_ids then fetch profiles
    const { data: ms, error: msError } = await supabase
      .from('company_memberships')
      .select('user_id')
      .eq('company_id', cid);
    console.log('[ProjectAccessPanel] memberships raw:', ms, msError?.message);

    if (ms && ms.length > 0) {
      const userIds = ms.map((m: any) => m.user_id);
      const { data: profs } = await supabase
        .from('profiles')
        .select('id, full_name, email')
        .in('id', userIds);
      setAllMembers(profs || []);
      console.log('[ProjectAccessPanel] profiles:', profs?.length);
    }

    setLoading(false);
  };

  const setMode = async (mode: AccessMode) => {
    setAccessMode(mode);
    await supabase.from('projects').update({ access_mode: mode }).eq('id', projectId);
  };

  const addTeam = async (team: Team) => {
    await supabase.from('project_teams').upsert(
      { project_id: projectId, team_id: team.id },
      { onConflict: 'project_id,team_id' }
    );
    // Load members for display
    const { data: profs } = await supabase
      .from('profiles').select('id, full_name, email').eq('team_id', team.id);
    setAssignedTeams(prev => [...prev.filter(t => t.id !== team.id), { ...team, members: profs || [] }]);
  };

  const removeTeam = async (teamId: string) => {
    await supabase.from('project_teams').delete().eq('project_id', projectId).eq('team_id', teamId);
    setAssignedTeams(prev => prev.filter(t => t.id !== teamId));
  };

  const addMember = async (member: Member) => {
    await supabase.from('project_members').upsert(
      { project_id: projectId, profile_id: member.id },
      { onConflict: 'project_id,profile_id' }
    );
    setAssignedMembers(prev => [...prev.filter(m => m.id !== member.id), member]);
  };

  const removeMember = async (memberId: string) => {
    await supabase.from('project_members').delete().eq('project_id', projectId).eq('profile_id', memberId);
    setAssignedMembers(prev => prev.filter(m => m.id !== memberId));
  };


  if (loading) return <p className="text-[11px] text-slate-400">Loading...</p>;

  return (
    <div className="space-y-6">

      {/* Access mode */}
      <div>
        <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-3">
          Who can access this project
        </p>
        <div className="space-y-2">
          {([
            { value: 'all_members',      label: 'All company members', desc: 'Everyone in the company' },
            { value: 'specific_teams',   label: 'Specific teams',      desc: 'Only members of assigned teams' },
            { value: 'specific_members', label: 'Specific members',    desc: 'Only individually assigned members' },
          ] as { value: AccessMode; label: string; desc: string }[]).map(opt => (
            <button
              key={opt.value}
              onClick={() => isAdmin && setMode(opt.value)}
              disabled={!isAdmin}
              className={`w-full flex items-start gap-3 px-4 py-3 rounded-2xl border text-left transition-all ${
                accessMode === opt.value ? 'bg-indigo-50 border-indigo-200' : 'bg-white border-slate-200 hover:border-slate-300'
              } ${!isAdmin ? 'opacity-60 cursor-default' : 'cursor-pointer'}`}
            >
              <div className={`w-4 h-4 rounded-full border-2 mt-0.5 shrink-0 flex items-center justify-center ${
                accessMode === opt.value ? 'border-indigo-500' : 'border-slate-300'
              }`}>
                {accessMode === opt.value && <div className="w-2 h-2 rounded-full bg-indigo-500" />}
              </div>
              <div>
                <p className={`text-[12px] font-bold ${accessMode === opt.value ? 'text-indigo-800' : 'text-slate-700'}`}>
                  {opt.label}
                </p>
                <p className="text-[11px] text-slate-400 mt-0.5">{opt.desc}</p>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Teams — show when specific_teams selected */}
      {accessMode === 'specific_teams' && (
        <div>
          <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-3">
            Teams — tick to assign
          </p>
          {allTeams.length === 0 ? (
            <p className="text-[11px] text-slate-400 italic">No teams found — create teams in Admin → Teams</p>
          ) : (
            <div className="space-y-2">
              {allTeams.map(team => {
                const isAssigned = assignedTeams.some(at => at.id === team.id);
                const assignedTeamFull = assignedTeams.find(at => at.id === team.id);
                return (
                  <div key={team.id} className={`border rounded-2xl overflow-hidden transition-all ${
                    isAssigned ? 'border-indigo-200' : 'border-slate-200'
                  }`}>
                    <button
                      onClick={() => isAdmin && (isAssigned ? removeTeam(team.id) : addTeam(team))}
                      disabled={!isAdmin}
                      className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-all ${
                        isAssigned ? 'bg-indigo-50' : 'bg-white hover:bg-slate-50'
                      } ${!isAdmin ? 'cursor-default' : 'cursor-pointer'}`}
                    >
                      {/* Checkbox */}
                      <div className={`w-4 h-4 rounded border-2 shrink-0 flex items-center justify-center ${
                        isAssigned ? 'bg-indigo-600 border-indigo-600' : 'border-slate-300'
                      }`}>
                        {isAssigned && (
                          <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
                            <path d="M1 4L3.5 6.5L9 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        )}
                      </div>
                      <Users size={13} className={isAssigned ? 'text-indigo-500' : 'text-slate-400'} />
                      <p className={`text-[12px] font-bold flex-1 ${isAssigned ? 'text-indigo-800' : 'text-slate-700'}`}>
                        {team.team_name}
                      </p>
                      {isAssigned && (
                        <span className="text-[10px] font-bold text-indigo-500 shrink-0">Assigned</span>
                      )}
                    </button>
                    {/* Show members of assigned teams */}
                    {isAssigned && (assignedTeamFull?.members || []).map(m => (
                      <div key={m.id} className="flex items-center gap-3 px-4 py-2 border-t border-indigo-100">
                        <div className="w-6 h-6 rounded-full bg-indigo-100 flex items-center justify-center text-[9px] font-bold text-indigo-600 shrink-0">
                          {(m.full_name || m.email || '?').charAt(0).toUpperCase()}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-[11px] font-medium text-slate-600 truncate">{m.full_name || m.email}</p>
                        </div>
                        {team.leader_id === m.id && <Crown size={11} className="text-amber-400 shrink-0" />}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Members — show when specific_members selected */}
      {accessMode === 'specific_members' && (
        <div>
          <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-3">
            Members — tick to assign
          </p>
          {allMembers.length === 0 ? (
            <p className="text-[11px] text-slate-400 italic">No company members found</p>
          ) : (
            <div className="space-y-1.5">
              {allMembers.map(m => {
                const isAssigned = assignedMembers.some(am => am.id === m.id);
                return (
                  <button
                    key={m.id}
                    onClick={() => isAdmin && (isAssigned ? removeMember(m.id) : addMember(m))}
                    disabled={!isAdmin}
                    className={`w-full flex items-center gap-3 px-4 py-3 rounded-2xl border text-left transition-all ${
                      isAssigned
                        ? 'bg-indigo-50 border-indigo-200'
                        : 'bg-white border-slate-200 hover:border-indigo-200'
                    } ${!isAdmin ? 'cursor-default' : 'cursor-pointer'}`}
                  >
                    {/* Checkbox */}
                    <div className={`w-4 h-4 rounded border-2 shrink-0 flex items-center justify-center transition-all ${
                      isAssigned ? 'bg-indigo-600 border-indigo-600' : 'border-slate-300'
                    }`}>
                      {isAssigned && (
                        <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
                          <path d="M1 4L3.5 6.5L9 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      )}
                    </div>
                    {/* Avatar */}
                    <div className={`w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 ${
                      isAssigned ? 'bg-indigo-200 text-indigo-700' : 'bg-slate-100 text-slate-500'
                    }`}>
                      {(m.full_name || m.email || '?').charAt(0).toUpperCase()}
                    </div>
                    {/* Name */}
                    <div className="flex-1 min-w-0">
                      <p className={`text-[12px] font-medium truncate ${isAssigned ? 'text-indigo-800' : 'text-slate-700'}`}>
                        {m.full_name || m.email}
                      </p>
                      {m.full_name && <p className="text-[10px] text-slate-400 truncate">{m.email}</p>}
                    </div>
                    {/* Status label */}
                    {isAssigned && (
                      <span className="text-[10px] font-bold text-indigo-500 shrink-0">Assigned</span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {!isAdmin && (
        <div className="flex items-center gap-2 px-3 py-2 bg-slate-50 rounded-xl">
          <Shield size={11} className="text-slate-400 shrink-0" />
          <p className="text-[10px] text-slate-400">Only admins can change access settings</p>
        </div>
      )}

    </div>
  );
}