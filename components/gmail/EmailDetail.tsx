// components/gmail/EmailDetail.tsx
"use client";

import { useState } from "react";
import { Loader2, Reply, X, Tag, Plus } from "lucide-react";
import ProjectSearch from "./ProjectSearch";
import type {
  GmailMessage, GmailProject, SearchableField,
} from "@/lib/gmail/types";

interface Props {
  message: GmailMessage;
  emailBody: string | null;
  loadingBody: boolean;
  selectedLabelIds: string[];
  assignedMap: Record<string, string>;
  projects: GmailProject[];
  filteredProjects: GmailProject[];
  projectSearch: string;
  searchFields: string[];
  searchableFields: SearchableField[];
  projectCfValues: Record<string, Record<string, string>>;
  assigning: boolean;
  labelFormat: string;
  parentLabel: string;
  companyName: string;
  isAdmin: boolean;
  onClose: () => void;
  onReply: () => void;
  onSearchChange: (val: string) => void;
  onAssign: (projectId: string) => void;
  onUnassign: () => void;
  onRemoveLabel: () => void;
  onSearchFieldsChange: (fields: string[]) => void;
  onLabelSettings: () => void;
}

function NiksenLabelBadge({
  label, isAdmin, removing, onRemove,
}: {
  label: string;
  isAdmin: boolean;
  removing: boolean;
  onRemove: () => void;
}) {
  const parts = label.split('/');
  const displayName = parts[parts.length - 1];

  return (
    <div className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-50 border border-indigo-200 rounded-full">
      <Tag size={10} className="text-indigo-500 shrink-0" />
      <span className="text-[11px] font-bold text-indigo-700 max-w-[200px] truncate" title={label}>
        {displayName}
      </span>
      <button
        onClick={onRemove}
        disabled={removing}
        title={isAdmin ? 'Remove label from all users' : 'Remove label'}
        className="ml-0.5 text-indigo-300 hover:text-red-500 transition-colors disabled:opacity-40"
      >
        {removing
          ? <Loader2 size={11} className="animate-spin" />
          : <X size={11} />
        }
      </button>
    </div>
  );
}

export default function EmailDetail({
  message, emailBody, loadingBody, selectedLabelIds,
  assignedMap, projects, filteredProjects,
  projectSearch, searchFields, searchableFields, projectCfValues,
  assigning, parentLabel, labelFormat, companyName, isAdmin,
  onClose, onReply, onSearchChange, onAssign, onUnassign,
  onRemoveLabel, onSearchFieldsChange, onLabelSettings,
}: Props) {
  const [removingLabel, setRemovingLabel] = useState<string | null>(null);
  const [showAddLabel, setShowAddLabel] = useState(false);

  const assignedProjectId = assignedMap[message.id] || null;
  const hasLabels = selectedLabelIds.length > 0;

  const handleRemoveLabel = async (label: string) => {
    console.log('[LABEL STEP 6] X clicked for label:', label);
    setRemovingLabel(label);
    await onRemoveLabel();
    setRemovingLabel(null);
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden bg-white">

      {/* Header */}
      <div className="p-6 border-b border-slate-100 shrink-0">
        <div className="flex items-start justify-between gap-4 mb-3">
          <h2 className="text-xl font-light text-slate-900 flex-1 min-w-0 leading-snug">
            {message.subject}
          </h2>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={onReply}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-full text-[10px] font-bold text-slate-600 hover:bg-slate-100 transition-all"
            >
              <Reply size={12} /> Reply
            </button>
            <button
              onClick={onClose}
              className="p-1.5 text-slate-300 hover:text-slate-700 transition-colors"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Sender + date */}
        <div className="flex items-center gap-3 text-[12px] text-slate-500 mb-4">
          <div className="h-8 w-8 rounded-full bg-indigo-100 flex items-center justify-center text-[11px] font-bold text-indigo-600 uppercase shrink-0">
            {message.fromName?.charAt(0) || '?'}
          </div>
          <div className="flex-1 min-w-0">
            <span className="font-medium text-slate-700">{message.fromName}</span>
            <span className="text-slate-400 ml-1.5">&lt;{message.from}&gt;</span>
          </div>
          <span className="text-slate-400 shrink-0 text-[11px]">
            {new Date(message.date).toLocaleString('en-AU', {
              day: 'numeric', month: 'short', year: 'numeric',
              hour: '2-digit', minute: '2-digit',
            })}
          </span>
        </div>

        {/* Labels section */}
        <div className="space-y-3">

          {/* Existing labels */}
          {hasLabels && (
            <div>
              <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-2">
                Project labels
              </p>
              <div className="flex items-center gap-2 flex-wrap">
                {selectedLabelIds.map(label => (
                  <NiksenLabelBadge
                    key={label}
                    label={label}
                    isAdmin={isAdmin}
                    removing={removingLabel === label}
                    onRemove={() => handleRemoveLabel(label)}
                  />
                ))}

                {/* Add another label */}
                <button
                  onClick={() => setShowAddLabel(p => !p)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-bold transition-all border ${
                    showAddLabel
                      ? 'bg-indigo-600 text-white border-indigo-600'
                      : 'bg-white text-slate-400 border-dashed border-slate-300 hover:border-indigo-400 hover:text-indigo-600'
                  }`}
                >
                  <Plus size={11} />
                  Add label
                </button>
              </div>
            </div>
          )}

          {/* Project search — shown when no labels OR adding another */}
          {(!hasLabels || showAddLabel) && (
            <div>
              {!hasLabels && (
                <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-2">
                  Assign to project
                </p>
              )}
              <ProjectSearch
                messageId={message.id}
                assignedProjectId={hasLabels ? null : assignedProjectId}
                projects={projects}
                filteredProjects={filteredProjects}
                projectSearch={projectSearch}
                searchFields={searchFields}
                searchableFields={searchableFields}
                projectCfValues={projectCfValues}
                assigning={assigning}
                onSearchChange={onSearchChange}
                onAssign={(projectId) => {
                  onAssign(projectId);
                  setShowAddLabel(false);
                }}
                onUnassign={onUnassign}
                onSearchFieldsChange={onSearchFieldsChange}
              />
            </div>
          )}

          {/* Label format hint */}
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-[10px] text-slate-400">
              Label format:
              <span className="font-bold text-slate-600 ml-1">
                {labelFormat}
              </span>
            </p>
            <button
              onClick={onLabelSettings}
              className="text-[10px] text-indigo-500 hover:text-indigo-700 hover:underline"
            >
              View label settings
            </button>
          </div>
        </div>
      </div>

      {/* Email body */}
      <div className="flex-1 overflow-y-auto">
        {loadingBody ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="animate-spin text-slate-300" size={20} />
          </div>
        ) : emailBody ? (
          <iframe
            srcDoc={emailBody}
            className="w-full h-full border-0"
            sandbox="allow-same-origin"
            title="Email content"
          />
        ) : (
          <div className="p-8">
            <p className="text-[13px] text-slate-600 leading-relaxed">{message.snippet}</p>
            <p className="text-[10px] text-slate-300 mt-4 italic">
              Full email body could not be loaded — showing preview
            </p>
          </div>
        )}
      </div>
    </div>
  );
}