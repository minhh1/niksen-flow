"use client";

import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { Loader2, Mail } from "lucide-react";

import GmailHeader from "@/components/gmail/GmailHeader";
import EmailList from "@/components/gmail/EmailList";
import EmailDetail from "@/components/gmail/EmailDetail";
import ComposeModal from "@/components/gmail/ComposeModal";
import LabelSettingsModal from "@/components/gmail/LabelSettingsModal";
import LabelConflictModal from "@/components/gmail/LabelConflictModal";
import SyncLog from "@/components/gmail/SyncLog";

import type {
  GmailMessage, GmailProject, LabelFormat, SearchableField,
} from "@/lib/gmail/types";
import { getFirstTwoWords } from "@/lib/gmail/types";

export default function GmailPage() {

  // ── Connection
  const [connected, setConnected] = useState<boolean | null>(null);
  const [gmailEmail, setGmailEmail] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);

  // ── Company / label config
  const [companyName, setCompanyName] = useState('');
  const [labelFormat, setLabelFormat] = useState<LabelFormat>('project_name');
  const [parentLabel, setParentLabel] = useState('Shared Emails');
  const [labelTokens, setLabelTokens] = useState<string[]>(['company', 'project_name']);

  // ── Messages
  const [messages, setMessages] = useState<GmailMessage[]>([]);
  const [filteredMessages, setFilteredMessages] = useState<GmailMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState('in:inbox');
  const [search, setSearch] = useState('');

  // ── Selected message
  const [selectedMessage, setSelectedMessage] = useState<GmailMessage | null>(null);
  const [emailBody, setEmailBody] = useState<string | null>(null);
  const [loadingBody, setLoadingBody] = useState(false);
  const [selectedLabelIds, setSelectedLabelIds] = useState<string[]>([]);

  // ── Projects
  const [projects, setProjects] = useState<GmailProject[]>([]);
  const [assignedMap, setAssignedMap] = useState<Record<string, string>>({});
  const [assigning, setAssigning] = useState<string | null>(null);
  const [projectSearch, setProjectSearch] = useState('');
  const [projectCfValues, setProjectCfValues] = useState<Record<string, Record<string, string>>>({});

  // ── Search config
  const [searchFields, setSearchFields] = useState<string[]>(['name']);
  const [searchableFields, setSearchableFields] = useState<SearchableField[]>([]);

  // ── Label conflict
  const [labelConflict, setLabelConflict] = useState<{
    messageId: string;
    projectId: string;
    existingLabel: string;
    proposedLabel: string;
  } | null>(null);

  // ── Sync
  const [syncing, setSyncing] = useState(false);
  const [lastSynced, setLastSynced] = useState<Date | null>(null);

  // ── UI
  const [showActivityLog, setShowActivityLog] = useState(false);
  const [showCompose, setShowCompose] = useState(false);
  const [composeTo, setComposeTo] = useState('');
  const [composeSubject, setComposeSubject] = useState('');
  const [showLabelSettings, setShowLabelSettings] = useState(false);

  // ── Init

  useEffect(() => {
    checkConnection();
    loadProjects();
    loadAssignments();
    loadCompanyAndProfile();
  }, []);

  useEffect(() => {
    if (connected) handleGmailSync();
  }, [connected]);

  useEffect(() => {
    if (!search) {
      setFilteredMessages(messages);
    } else {
      const q = search.toLowerCase();
      setFilteredMessages(messages.filter(m =>
        m.subject.toLowerCase().includes(q) ||
        m.fromName.toLowerCase().includes(q) ||
        m.from.toLowerCase().includes(q) ||
        m.snippet.toLowerCase().includes(q)
      ));
    }
  }, [search, messages]);

  useEffect(() => {
    const cfIds = searchFields
      .filter(f => f.startsWith('cf:'))
      .map(f => f.replace('cf:', ''));
    if (!cfIds.length || !projects.length) return;
    const load = async () => {
      const { data } = await supabase
        .from('company_custom_field_values')
        .select('record_id, field_id, value_text')
        .in('record_id', projects.map(p => p.id))
        .in('field_id', cfIds);
      const map: Record<string, Record<string, string>> = {};
      (data || []).forEach(v => {
        if (!map[v.record_id]) map[v.record_id] = {};
        map[v.record_id][v.field_id] = v.value_text || '';
      });
      setProjectCfValues(map);
    };
    load();
  }, [searchFields, projects]);

  // ── Data loaders

  const checkConnection = async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setConnected(false); return; }
    const { data } = await supabase
      .from('user_gmail_tokens')
      .select('email')
      .eq('user_id', user.id)
      .single();
    setConnected(!!data);
    if (data?.email) setGmailEmail(data.email);
    if (data) fetchMessages('in:inbox');
    else setLoading(false);
  };

  const loadCompanyAndProfile = async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data: prof } = await supabase
      .from('profiles')
      .select('active_company_id, is_admin, gmail_search_fields')
      .eq('id', user.id)
      .single();
    setIsAdmin(prof?.is_admin || false);
    if (prof?.gmail_search_fields) setSearchFields(prof.gmail_search_fields);
    if (!prof?.active_company_id) return;
    const { data: company } = await supabase
      .from('companies')
      .select('name, gmail_label_format, gmail_parent_label, gmail_label_tokens')
      .eq('id', prof.active_company_id)
      .single();
    if (company?.name) setCompanyName(company.name);
    if (company?.gmail_label_format) setLabelFormat(company.gmail_label_format as LabelFormat);
    if (company?.gmail_parent_label) setParentLabel(company.gmail_parent_label);
    if (company?.gmail_label_tokens?.length) setLabelTokens(company.gmail_label_tokens);
    const { data: customFields } = await supabase
      .from('company_custom_fields')
      .select('id, field_key, label, field_type')
      .eq('table_name', 'projects')
      .order('display_order');
    setSearchableFields([
      { key: 'name',        label: 'Project Name' },
      { key: 'description', label: 'Description' },
      { key: 'status',      label: 'Status' },
      ...(customFields || []).map(f => ({ key: `cf:${f.id}`, label: f.label })),
    ]);
  };

  const loadProjects = async () => {
    const { data } = await supabase
      .from('projects')
      .select('id, name, property:property_id(street_address)')
      .is('deleted_at', null)
      .order('created_at', { ascending: false });
    setProjects((data as GmailProject[]) || []);
  };

  const loadAssignments = async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data } = await supabase
      .from('project_emails')
      .select('gmail_message_id, project_id')
      .eq('user_id', user.id);
    const map: Record<string, string> = {};
    (data || []).forEach(r => { map[r.gmail_message_id] = r.project_id; });
    setAssignedMap(map);
  };

  // ── Fetch messages

  const fetchMessages = useCallback(async (query: string) => {
    setLoading(true);
    setActiveFilter(query);
    setFetchError(null);
    try {
      const res = await fetch(`/api/gmail/messages?q=${encodeURIComponent(query)}`);
      const data = await res.json();
      if (data.error) { setFetchError(data.error); setMessages([]); }
      else setMessages(data.messages || []);
    } catch (err: any) {
      setFetchError(err?.message || 'Failed to load emails');
      setMessages([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // ── Select message

const handleSelectMessage = async (msg: GmailMessage) => {
  setSelectedMessage(msg);
  setEmailBody(null);
  // ← Use niksenLabels directly — already resolved names from message list
  setSelectedLabelIds(msg.niksenLabels || []);
  setProjectSearch('');
  setLoadingBody(true);
  try {
    const res = await fetch(`/api/gmail/messages/${msg.id}`);
    const data = await res.json();
    setEmailBody(data.body || null);
    // Update with fresh labels if detail fetch returns them
    if (data.niksenLabels?.length) setSelectedLabelIds(data.niksenLabels);
  } catch {
    setEmailBody(null);
  } finally {
    setLoadingBody(false);
  }
};
  // ── Build label from tokens

  const buildLabelFromTokens = async (
    projectId: string,
    project: GmailProject
  ): Promise<string> => {
    const { data: cfValues } = await supabase
      .from('company_custom_field_values')
      .select('value_text, field:field_id(label, field_key)')
      .eq('record_id', projectId)
      .eq('table_name', 'projects');

    const getCfValue = (keyOrLabel: string) => {
      const match = (cfValues || []).find((v: any) =>
        v.field?.label?.toLowerCase().includes(keyOrLabel.toLowerCase()) ||
        v.field?.field_key?.toLowerCase().includes(keyOrLabel.toLowerCase())
      );
      return match?.value_text || '';
    };

    const parts = [parentLabel];
    for (const token of labelTokens) {
      switch (token) {
        case 'company':
          parts.push(getFirstTwoWords(companyName));
          break;
        case 'project_name':
          parts.push(project.name);
          break;
        case 'matter_number':
          parts.push(getCfValue('matter number') || getCfValue('matter_number'));
          break;
        case 'matter_status':
          parts.push(getCfValue('matter status') || getCfValue('matter_status'));
          break;
        case 'year':
          parts.push(String(new Date().getFullYear()));
          break;
      }
    }
    return parts.filter(Boolean).join('/');
  };

  // ── Commit assign

  const commitAssign = async (
    messageId: string,
    projectId: string,
    gmailLabelName: string
  ) => {
    setAssigning(messageId);
    try {
      await fetch('/api/gmail/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageId,
          threadId: selectedMessage?.threadId,
          projectId,
          projectName: gmailLabelName,
          subject: selectedMessage?.subject,
          from: selectedMessage?.from,
          fromName: selectedMessage?.fromName,
          date: selectedMessage?.date,
          snippet: selectedMessage?.snippet,
        }),
      });
      setAssignedMap(prev => ({ ...prev, [messageId]: projectId }));
      setLabelConflict(null);
      const refreshRes = await fetch(`/api/gmail/messages/${messageId}`);
      const refreshData = await refreshRes.json();
      if (refreshData.labelIds) setSelectedLabelIds(refreshData.labelIds);
    } catch (err) {
      console.error('commitAssign:', err);
    } finally {
      setAssigning(null);
    }
  };

  // ── Assign project

  const handleAssign = async (projectId: string) => {
    if (!selectedMessage) return;
    const project = projects.find(p => p.id === projectId);
    if (!project) return;

    setAssigning(selectedMessage.id);
    const proposedLabel = await buildLabelFromTokens(projectId, project);

    // Only check conflicts when creating a brand new project label
    const { data: existingProjectLabel } = await supabase
      .from('project_gmail_labels')
      .select('id')
      .eq('project_id', projectId)
      .single();

    if (!existingProjectLabel) {
      try {
        const checkRes = await fetch('/api/gmail/check-label', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messageId: selectedMessage.id,
            threadId: selectedMessage.threadId,
            proposedLabel,
            parentLabel,
          }),
        });
        const check = await checkRes.json();
        if (check.conflict) {
          setAssigning(null);
          setLabelConflict({
            messageId: selectedMessage.id,
            projectId,
            existingLabel: [
              ...check.existingLabels,
              ...check.threadLabels,
              check.dbConflict ? check.dbConflict.projectName : null,
            ].filter(Boolean).join(', '),
            proposedLabel,
          });
          return;
        }
      } catch (err) {
        console.error('Label check failed — proceeding anyway:', err);
      }
    }

    await commitAssign(selectedMessage.id, projectId, proposedLabel);
  };

  const handleRemoveLabel = async (projectId: string) => {
    if (!selectedMessage) return;
    try {
      const res = await fetch('/api/gmail/remove-label', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageId: selectedMessage.id,
          projectId,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        // Clear from assigned map
        setAssignedMap(prev => {
          const next = { ...prev };
          delete next[selectedMessage.id];
          return next;
        });

        // Clear label display in detail pane
        setSelectedLabelIds([]);

        // ← Also clear niksenLabels on the message in the list
        setMessages(prev => prev.map(m =>
          m.id === selectedMessage.id
            ? { ...m, niksenLabels: [] }
            : m
        ));
      }
    } catch (err) {
      console.error('handleRemoveLabel:', err);
    }
  };
  
  // ── Sync

  const handleGmailSync = async () => {
    setSyncing(true);
    try {
      await fetch('/api/gmail/sync', { method: 'POST' });
      setLastSynced(new Date());
      await loadAssignments();
    } catch (err) {
      console.error('Sync error:', err);
    } finally {
      setSyncing(false);
    }
  };

  // ── Send

  const handleSend = async (to: string, subject: string, body: string) => {
    await fetch('/api/gmail/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, subject, body, threadId: selectedMessage?.threadId }),
    });
  };

  // ── Label settings save

  const handleLabelFormatChange = async (
    newParent: string,
    newFormat: LabelFormat,
    newTokens: string[]
  ) => {
    setParentLabel(newParent);
    setLabelFormat(newFormat);
    setLabelTokens(newTokens);

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { console.error('No user session'); return; }

    const { data: prof } = await supabase
      .from('profiles')
      .select('active_company_id')
      .eq('id', user.id)
      .single();

    if (!prof?.active_company_id) { console.error('No company id'); return; }

    const { error } = await supabase
      .from('companies')
      .update({
        gmail_label_format: newFormat,
        gmail_parent_label: newParent,
        gmail_label_tokens: newTokens,
      })
      .eq('id', prof.active_company_id);

    if (error) console.error('Company update error:', error);
  };

  // ── Search fields save

  const handleSearchFieldsChange = async (fields: string[]) => {
    setSearchFields(fields);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    await supabase.from('profiles').update({ gmail_search_fields: fields }).eq('id', user.id);
  };

  // ── Filtered projects

  const filteredProjects = projects.filter(p => {
    if (!projectSearch.trim()) return true;
    const q = projectSearch.toLowerCase().trim();
    return searchFields.some(field => {
      if (field.startsWith('cf:')) {
        const cfId = field.replace('cf:', '');
        return (projectCfValues[p.id]?.[cfId] || '').toLowerCase().includes(q);
      }
      return String((p as any)[field] || '').toLowerCase().includes(q);
    });
  });

  // ── Reply

  const handleReply = () => {
    if (!selectedMessage) return;
    setComposeTo(selectedMessage.from);
    setComposeSubject(
      selectedMessage.subject.startsWith('Re:')
        ? selectedMessage.subject
        : `Re: ${selectedMessage.subject}`
    );
    setShowCompose(true);
  };

  // ── Not connected

  if (connected === null) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Loader2 className="animate-spin text-slate-300" size={24} />
      </div>
    );
  }

  if (connected === false) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-[#F9FAFB] font-sans">
        <div className="bg-white border border-slate-200 rounded-[40px] p-12 max-w-md w-full mx-4 text-center shadow-sm">
          <div className="w-16 h-16 bg-red-50 rounded-full flex items-center justify-center mx-auto mb-5">
            <Mail size={28} className="text-red-500" />
          </div>
          <h2 className="text-2xl font-light uppercase tracking-tight text-slate-900 mb-3">
            Connect Gmail
          </h2>
          <p className="text-[13px] text-slate-500 mb-8 leading-relaxed">
            Connect your Gmail account to view emails, assign them to projects,
            and sync project labels across your team.
          </p>
          <button
            onClick={() => { window.location.href = '/api/gmail/auth'; }}
            className="flex items-center justify-center gap-3 w-full py-4 bg-slate-900 text-white rounded-full font-bold text-[13px] hover:bg-slate-700 transition-all"
          >
            Connect with Google
          </button>
          <p className="text-[10px] text-slate-400 mt-4">
            We only request access to read, label, and send emails.
          </p>
        </div>
      </div>
    );
  }

  // ── Main render

  return (
    <div className="flex flex-col h-screen bg-[#F9FAFB] font-sans antialiased overflow-hidden">

      <GmailHeader
        gmailEmail={gmailEmail}
        loading={loading}
        syncing={syncing}
        lastSynced={lastSynced}
        activeFilter={activeFilter}
        search={search}
        showActivityLog={showActivityLog}
        onSearch={setSearch}
        onFilter={fetchMessages}
        onRefresh={() => fetchMessages(activeFilter)}
        onSync={handleGmailSync}
        onCompose={() => setShowCompose(true)}
        onLabelSettings={() => setShowLabelSettings(true)}
        onToggleActivityLog={() => setShowActivityLog(p => !p)}
      />

      <div className="flex flex-1 min-h-0 overflow-hidden">
        {showActivityLog ? (
          <div className="flex-1 overflow-y-auto bg-[#F9FAFB] p-8">
            <div className="max-w-3xl mx-auto">
              <SyncLog isAdmin={isAdmin} />
            </div>
          </div>
        ) : (
          <>
            <EmailList
              messages={filteredMessages}
              loading={loading}
              fetchError={fetchError}
              selectedId={selectedMessage?.id || null}
              assignedMap={assignedMap}
              projects={projects}
              collapsed={!!selectedMessage}
              onSelect={handleSelectMessage}
              onRetry={() => fetchMessages('in:inbox')}
            />

            {selectedMessage && (
              <EmailDetail
                message={selectedMessage}
                emailBody={emailBody}
                loadingBody={loadingBody}
                selectedLabelIds={selectedLabelIds}
                assignedMap={assignedMap}
                projects={projects}
                filteredProjects={filteredProjects}
                projectSearch={projectSearch}
                searchFields={searchFields}
                searchableFields={searchableFields}
                projectCfValues={projectCfValues}
                assigning={assigning === selectedMessage.id}
                labelFormat={labelFormat}
                parentLabel={parentLabel}
                companyName={companyName}
                isAdmin={isAdmin}
                onClose={() => {
                  setSelectedMessage(null);
                  setEmailBody(null);
                  setSelectedLabelIds([]);
                }}
                onReply={handleReply}
                onSearchChange={setProjectSearch}
                onAssign={handleAssign}
                onUnassign={() => setAssignedMap(prev => {
                  const next = { ...prev };
                  if (selectedMessage) delete next[selectedMessage.id];
                  return next;
                })}
                onRemoveLabel={handleRemoveLabel}
                onSearchFieldsChange={handleSearchFieldsChange}
                onLabelSettings={() => setShowLabelSettings(true)}
              />
            )}
          </>
        )}
      </div>

      {showCompose && (
        <ComposeModal
          initialTo={composeTo}
          initialSubject={composeSubject}
          onSend={handleSend}
          onClose={() => {
            setShowCompose(false);
            setComposeTo('');
            setComposeSubject('');
          }}
        />
      )}

      {showLabelSettings && (
        <LabelSettingsModal
          parentLabel={parentLabel}
          format={labelFormat}
          labelTokens={labelTokens}
          companyName={companyName}
          onSave={handleLabelFormatChange}
          onClose={() => setShowLabelSettings(false)}
        />
      )}

      {labelConflict && (
        <LabelConflictModal
          existingLabel={labelConflict.existingLabel}
          proposedLabel={labelConflict.proposedLabel}
          onReplace={async () => {
            await fetch('/api/gmail/remove-label', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                messageId: labelConflict.messageId,
                projectId: assignedMap[labelConflict.messageId],
              }),
            });
            await commitAssign(
              labelConflict.messageId,
              labelConflict.projectId,
              labelConflict.proposedLabel
            );
          }}
          onAddBoth={() => commitAssign(
            labelConflict.messageId,
            labelConflict.projectId,
            labelConflict.proposedLabel
          )}
          onCancel={() => setLabelConflict(null)}
        />
      )}
    </div>
  );
}
