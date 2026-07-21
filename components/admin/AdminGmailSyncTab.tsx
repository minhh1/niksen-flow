// components/admin/AdminGmailSyncTab.tsx
"use client";

import { useState, useEffect } from "react";
import { supabase } from "@/lib/supabase";
import {
  Loader2, Tag, Users2, ListOrdered, Activity, Radio, Mail, Trash2, PlusCircle, MinusCircle, Inbox, Archive, Check, X, ClipboardCheck, ArrowUpDown, Clock, AlertTriangle, RotateCw,
} from "lucide-react";

interface AdminGmailSyncTabProps {
  companyId: string;
}

interface SharedLabel {
  project_id: string;
  project_name: string;
  gmail_label_name: string;
  label_code: string | null;
}

interface QueueJob {
  id: string;
  job_type: string;
  project_id: string;
  project_name: string;
  gmail_label_name: string;
  status: string;
  attempts: number;
  completed_users: string[];
  total_users: number;
  updated_at: string;
  position: number;
  doneNames: string[];
  pendingNames: string[];
  emailCount: number;
}

interface ActivityRow {
  id: string;
  action: string;
  project_name: string | null;
  gmail_label_name: string | null;
  label_code: string | null;
  email_subject: string | null;
  email_snippet: string | null;
  user_name: string;
  reapplied: boolean;
  created_at: string;
}

type ActivityRange = "all" | "1h" | "24h" | "7d" | "30d" | "custom";

const ACTIVITY_RANGE_OPTIONS: { id: ActivityRange; label: string }[] = [
  { id: "all", label: "All time" },
  { id: "1h", label: "Last hour" },
  { id: "24h", label: "Last 24 hours" },
  { id: "7d", label: "Last 7 days" },
  { id: "30d", label: "Last 30 days" },
  { id: "custom", label: "Custom range" },
];

function describeActivity(row: ActivityRow): string {
  switch (row.action) {
    case "sync_to_user": return `Synced to ${row.user_name}`;
    case "label_applied": return `Label applied for ${row.user_name}`;
    case "label_removed": return row.reapplied
      ? `${row.user_name} removed the label — auto re-applied`
      : `Label removed for ${row.user_name}`;
    case "message_deleted": return `Message deleted by ${row.user_name}`;
    case "archived": return `Archived to ${row.user_name}`;
    case "email_trashed": return `Deleted from ${row.user_name}'s mailbox (archived)`;
    case "sync_recovered": return `Recovered — ${row.user_name} is back on track`;
    case "sync_failed": return `Persistent failure for ${row.user_name} — needs attention`;
    case "sync_error": return `Sync failed for ${row.user_name} — quarantined, will retry automatically`;
    case "dispatch_error": return `Couldn't reach the processor for ${row.user_name} — will retry next cycle`;
    default: return row.user_name;
  }
}

interface SyncFailure {
  id: string;
  job_type: string;
  project_name: string;
  gmail_label_name: string | null;
  user_name: string;
  status: string;
  attempts: number;
  last_error: string | null;
  first_failed_at: string;
  last_attempted_at: string | null;
}

interface HeartbeatRow {
  name: string;
  last_run_at: string;
  last_result: any;
}

interface ArchivedProject {
  project_id: string;
  project_name: string;
  gmail_label_name: string;
  archived_at: string;
  job_status: string | null; // status of the archive job, if one is tracked
}

interface ArchiveRequest {
  id: string;
  project_id: string;
  project_name: string;
  requester_name: string;
  created_at: string;
  error: string | null;
}

const JOB_STATUS_STYLES: Record<string, string> = {
  pending: "bg-slate-100 text-slate-500",
  processing: "bg-amber-50 text-amber-600",
  done: "bg-emerald-50 text-emerald-600",
  failed: "bg-red-50 text-red-600",
};

const ACTION_META: Record<string, { label: string; icon: any; style: string }> = {
  sync_to_user: { label: "Synced to user", icon: Inbox, style: "bg-indigo-50 text-indigo-600" },
  label_applied: { label: "Label applied", icon: Tag, style: "bg-sky-50 text-sky-600" },
  label_removed: { label: "Label removed", icon: MinusCircle, style: "bg-slate-100 text-slate-500" },
  message_deleted: { label: "Message deleted", icon: Trash2, style: "bg-red-50 text-red-600" },
  archived: { label: "Archived", icon: PlusCircle, style: "bg-purple-50 text-purple-600" },
  email_trashed: { label: "Deleted (archived)", icon: Trash2, style: "bg-red-50 text-red-600" },
  sync_recovered: { label: "Recovered", icon: RotateCw, style: "bg-emerald-50 text-emerald-600" },
  sync_failed: { label: "Persistent failure", icon: AlertTriangle, style: "bg-red-50 text-red-600" },
  sync_error: { label: "Sync error (quarantined)", icon: AlertTriangle, style: "bg-amber-50 text-amber-600" },
  dispatch_error: { label: "Dispatch error", icon: AlertTriangle, style: "bg-amber-50 text-amber-600" },
};

// name → [human label, expected interval in ms]
const HEARTBEAT_DEFS: Record<string, { label: string; intervalMs: number }> = {
  "gmail-label-sync-cron": { label: "Label sync cron (every 15 min)", intervalMs: 15 * 60 * 1000 },
  "gmail-label-sync-worker": { label: "Label sync worker (every 1 min)", intervalMs: 60 * 1000 },
  "gmail-email-sync-cron": { label: "Email sync cron (every 15 min)", intervalMs: 15 * 60 * 1000 },
  "gmail-email-sync-worker": { label: "Email sync worker (every 1 min)", intervalMs: 60 * 1000 },
  "gmail-watch-renewal": { label: "Watch renewal (daily)", intervalMs: 24 * 60 * 60 * 1000 },
  "gmail-sync-recovery-worker": { label: "Sync recovery worker (every 15 min)", intervalMs: 15 * 60 * 1000 },
};

const ACTIVITY_PAGE_SIZE = 50;

export default function AdminGmailSyncTab({ companyId }: AdminGmailSyncTabProps) {
  const [section, setSection] = useState<"labels" | "queue" | "activity" | "health" | "archived" | "requests" | "failures">("labels");
  const [loading, setLoading] = useState(true);

  const [sharedLabels, setSharedLabels] = useState<SharedLabel[]>([]);
  const [sharedWithNames, setSharedWithNames] = useState<string[]>([]);
  const [archiveEmails, setArchiveEmails] = useState<string[]>([]);
  const [archivingProjectId, setArchivingProjectId] = useState<string | null>(null);
  const [archivedProjects, setArchivedProjects] = useState<ArchivedProject[]>([]);

  const [archiveRequests, setArchiveRequests] = useState<ArchiveRequest[]>([]);
  const [selectedRequestIds, setSelectedRequestIds] = useState<Set<string>>(new Set());
  const [reviewingRequests, setReviewingRequests] = useState(false);

  const [queue, setQueue] = useState<QueueJob[]>([]);
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);

  const [activity, setActivity] = useState<ActivityRow[]>([]);
  const [activityFilter, setActivityFilter] = useState<string | null>(null);
  const [activityRange, setActivityRange] = useState<ActivityRange>("all");
  const [activityCustomFrom, setActivityCustomFrom] = useState("");
  const [activityCustomTo, setActivityCustomTo] = useState("");
  const [activitySortAsc, setActivitySortAsc] = useState(false);
  const [activityOffset, setActivityOffset] = useState(0);
  const [activityHasMore, setActivityHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [projectNameById, setProjectNameById] = useState<Map<string, string>>(new Map());

  const [heartbeats, setHeartbeats] = useState<HeartbeatRow[]>([]);
  const [syncFailures, setSyncFailures] = useState<SyncFailure[]>([]);

  useEffect(() => { load(); }, [companyId]);
  useEffect(() => { loadActivity(true); }, [companyId, activityFilter, activityRange, activityCustomFrom, activityCustomTo, activitySortAsc]);

  const load = async () => {
    setLoading(true);

    const [{ data: memberships }, { data: labels }, { data: archived }, { data: jobs }, { data: archiveJobs }, { data: hb }, { data: comp }, { data: requests }, { data: failures }] = await Promise.all([
      supabase.from("company_memberships").select("user_id").eq("company_id", companyId),
      supabase.from("project_gmail_labels")
        .select("project_id, gmail_label_name, label_code")
        .eq("company_id", companyId)
        .is("removed_at", null)
        .is("archived_at", null),
      supabase.from("project_gmail_labels")
        .select("project_id, gmail_label_name, archived_at")
        .eq("company_id", companyId)
        .not("archived_at", "is", null)
        .order("archived_at", { ascending: false }),
      supabase.from("gmail_sync_jobs")
        .select("id, job_type, project_id, gmail_label_name, status, attempts, completed_users, total_users, updated_at")
        .eq("company_id", companyId)
        .in("status", ["pending", "processing"]),
      supabase.from("gmail_sync_jobs")
        .select("project_id, status, updated_at")
        .eq("company_id", companyId).eq("job_type", "archive")
        .order("updated_at", { ascending: false }),
      supabase.from("cron_heartbeats").select("name, last_run_at, last_result"),
      supabase.from("companies").select("gmail_archive_emails").eq("id", companyId).single(),
      supabase.from("gmail_archive_requests")
        .select("id, project_id, requested_by, created_at, error")
        .eq("company_id", companyId).eq("status", "pending")
        .order("created_at", { ascending: false }),
      supabase.from("gmail_sync_failures")
        .select("id, job_id, job_type, project_id, user_id, status, attempts, last_error, first_failed_at, last_attempted_at")
        .eq("company_id", companyId)
        .in("status", ["pending_retry", "persistent_failure"])
        .order("first_failed_at", { ascending: false }),
    ]);

    setArchiveEmails(comp?.gmail_archive_emails || []);

    // Resolve "shared with" — every connected user in the company shares in every label.
    // Queries company_gmail_connections (a view), not user_gmail_tokens directly — that
    // table's RLS only ever returns your own row to a browser client.
    const { data: tokens } = await supabase.from("company_gmail_connections").select("user_id, email");
    const connectedIds = (tokens || []).map((t: any) => t.user_id);
    let connectedNames: string[] = [];
    let nameByUserId = new Map<string, string>();
    if (connectedIds.length) {
      const { data: profiles } = await supabase.from("profiles").select("id, full_name, email").in("id", connectedIds);
      nameByUserId = new Map((profiles || []).map((p: any) => [p.id, p.full_name || p.email || "Unknown"]));
      connectedNames = connectedIds.map((id: string) => nameByUserId.get(id) || "Unknown");
    }
    setSharedWithNames(connectedNames);

    // Archive jobs exclude the nominated archive account(s) from the "still to do" set
    const archiveEmailSet = new Set(comp?.gmail_archive_emails || []);
    const archiveUserIdSet = new Set((tokens || []).filter((t: any) => archiveEmailSet.has(t.email)).map((t: any) => t.user_id));

    // Resolve project names for labels + queue jobs + archived projects
    const projectIds = Array.from(new Set([
      ...(labels || []).map((l: any) => l.project_id),
      ...(jobs || []).map((j: any) => j.project_id),
      ...(archived || []).map((a: any) => a.project_id),
      ...(requests || []).map((r: any) => r.project_id),
      ...(failures || []).map((f: any) => f.project_id),
    ]));
    let projectNameById = new Map<string, string>();
    if (projectIds.length) {
      const { data: projects } = await supabase.from("projects").select("id, name").in("id", projectIds);
      projectNameById = new Map((projects || []).map((p: any) => [p.id, p.name]));
      setProjectNameById(prev => new Map([...prev, ...projectNameById]));
    }

    setSharedLabels((labels || []).map((l: any) => ({
      project_id: l.project_id,
      project_name: projectNameById.get(l.project_id) || l.project_id,
      gmail_label_name: l.gmail_label_name,
      label_code: l.label_code,
    })));

    // Distinct email count per project, for the jobs currently in the queue
    const queueProjectIds = Array.from(new Set((jobs || []).map((j: any) => j.project_id)));
    const emailCountByProject = new Map<string, number>();
    if (queueProjectIds.length) {
      const { data: emailRows } = await supabase.from("project_emails")
        .select("project_id, gmail_message_id").in("project_id", queueProjectIds);
      const seenByProject = new Map<string, Set<string>>();
      for (const e of (emailRows || [])) {
        if (!seenByProject.has(e.project_id)) seenByProject.set(e.project_id, new Set());
        seenByProject.get(e.project_id)!.add(e.gmail_message_id);
      }
      for (const [pid, set] of seenByProject) emailCountByProject.set(pid, set.size);
    }

    setQueue(computeQueuePositions(jobs || []).map((j: any) => {
      const relevantIds = j.job_type === "archive"
        ? connectedIds.filter((id: string) => !archiveUserIdSet.has(id))
        : connectedIds;
      const completedSet = new Set(j.completed_users || []);
      const doneNames = (j.completed_users || []).map((id: string) => nameByUserId.get(id) || "Unknown");
      const pendingNames = relevantIds.filter((id: string) => !completedSet.has(id)).map((id: string) => nameByUserId.get(id) || "Unknown");
      return {
        ...j,
        project_name: projectNameById.get(j.project_id) || j.project_id,
        doneNames,
        pendingNames,
        emailCount: emailCountByProject.get(j.project_id) || 0,
      };
    }));

    // Most recent archive job status per project (archiveJobs already ordered newest-first)
    const latestJobStatusByProject = new Map<string, string>();
    for (const j of (archiveJobs || [])) {
      if (!latestJobStatusByProject.has(j.project_id)) latestJobStatusByProject.set(j.project_id, j.status);
    }
    setArchivedProjects((archived || []).map((a: any) => ({
      project_id: a.project_id,
      project_name: projectNameById.get(a.project_id) || a.project_id,
      gmail_label_name: a.gmail_label_name,
      archived_at: a.archived_at,
      job_status: latestJobStatusByProject.get(a.project_id) || null,
    })));

    // Resolve requester names for pending archive requests
    const requesterIds = Array.from(new Set((requests || []).map((r: any) => r.requested_by).filter(Boolean)));
    let requesterNameById = new Map<string, string>();
    if (requesterIds.length) {
      const { data: profiles } = await supabase.from("profiles").select("id, full_name, email").in("id", requesterIds);
      requesterNameById = new Map((profiles || []).map((p: any) => [p.id, p.full_name || p.email || "Unknown"]));
    }
    setArchiveRequests((requests || []).map((r: any) => ({
      id: r.id,
      project_id: r.project_id,
      project_name: projectNameById.get(r.project_id) || r.project_id,
      requester_name: r.requested_by ? (requesterNameById.get(r.requested_by) || "Unknown") : "Unknown",
      created_at: r.created_at,
      error: r.error,
    })));
    setSelectedRequestIds(new Set());

    // Resolve label names (via each failure's parent job) + user names for the Persistent Failures tab
    const failureJobIds = Array.from(new Set((failures || []).map((f: any) => f.job_id).filter(Boolean)));
    let labelNameByJobId = new Map<string, string>();
    if (failureJobIds.length) {
      const { data: failureJobs } = await supabase.from("gmail_sync_jobs").select("id, gmail_label_name").in("id", failureJobIds);
      labelNameByJobId = new Map((failureJobs || []).map((j: any) => [j.id, j.gmail_label_name]));
    }
    const failureUserIds = Array.from(new Set((failures || []).map((f: any) => f.user_id).filter(Boolean)));
    const missingFailureUserIds = failureUserIds.filter(id => !nameByUserId.has(id));
    let failureNameByUserId = nameByUserId;
    if (missingFailureUserIds.length) {
      const { data: profiles } = await supabase.from("profiles").select("id, full_name, email").in("id", missingFailureUserIds);
      const merged = new Map(failureNameByUserId);
      for (const p of (profiles || [])) merged.set(p.id, p.full_name || p.email || "Unknown");
      failureNameByUserId = merged;
    }
    setSyncFailures((failures || []).map((f: any) => ({
      id: f.id,
      job_type: f.job_type,
      project_name: projectNameById.get(f.project_id) || f.project_id,
      gmail_label_name: labelNameByJobId.get(f.job_id) || null,
      user_name: f.user_id ? (failureNameByUserId.get(f.user_id) || "Unknown") : "Unknown",
      status: f.status,
      attempts: f.attempts,
      last_error: f.last_error,
      first_failed_at: f.first_failed_at,
      last_attempted_at: f.last_attempted_at,
    })));

    setHeartbeats(hb || []);
    setLoading(false);
  };

  const toggleRequestSelected = (id: string) => {
    setSelectedRequestIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleSelectAllRequests = () => {
    setSelectedRequestIds(prev =>
      prev.size === archiveRequests.length ? new Set() : new Set(archiveRequests.map(r => r.id))
    );
  };

  const handleApproveSelected = async () => {
    if (!selectedRequestIds.size) return;
    if (!window.confirm(
      `Approve ${selectedRequestIds.size} archive request${selectedRequestIds.size !== 1 ? "s" : ""}?\n\n` +
      `Each project's emails will be copied to the nominated archive account(s), verified, then deleted ` +
      `from every other member's mailbox.`
    )) return;

    setReviewingRequests(true);
    const res = await fetch("/api/gmail/archive-requests/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request_ids: Array.from(selectedRequestIds) }),
    });
    const result = await res.json();
    setReviewingRequests(false);
    if (!res.ok) { alert(result.error || "Failed to approve requests"); return; }
    const failed = (result.results || []).filter((r: any) => !r.ok);
    if (failed.length) alert(`${failed.length} request(s) could not be approved:\n` + failed.map((f: any) => f.error).join("\n"));
    load();
  };

  const handleRejectSelected = async () => {
    if (!selectedRequestIds.size) return;
    if (!window.confirm(`Reject ${selectedRequestIds.size} archive request${selectedRequestIds.size !== 1 ? "s" : ""}?`)) return;

    setReviewingRequests(true);
    const res = await fetch("/api/gmail/archive-requests/reject", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request_ids: Array.from(selectedRequestIds) }),
    });
    const result = await res.json();
    setReviewingRequests(false);
    if (!res.ok) { alert(result.error || "Failed to reject requests"); return; }
    load();
  };

  const handleArchive = async (projectId: string, labelName: string) => {
    if (!window.confirm(
      `Archive "${labelName}"?\n\n` +
      `This copies every email in this project to the nominated archive account(s), verifies delivery, ` +
      `then DELETES (moves to Trash) those emails from every other member's mailbox. This cannot be undone ` +
      `beyond Gmail's own ~30-day Trash retention.`
    )) return;

    setArchivingProjectId(projectId);
    const res = await fetch("/api/gmail/archive-project", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: projectId }),
    });
    const result = await res.json();
    setArchivingProjectId(null);
    if (!res.ok) { alert(result.error || "Failed to start archiving"); return; }
    load();
  };

  const activityDateBounds = (): { from: string | null; to: string | null } => {
    const now = Date.now();
    switch (activityRange) {
      case "1h": return { from: new Date(now - 60 * 60 * 1000).toISOString(), to: null };
      case "24h": return { from: new Date(now - 24 * 60 * 60 * 1000).toISOString(), to: null };
      case "7d": return { from: new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString(), to: null };
      case "30d": return { from: new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString(), to: null };
      case "custom": return {
        from: activityCustomFrom ? new Date(activityCustomFrom + "T00:00:00").toISOString() : null,
        to: activityCustomTo ? new Date(activityCustomTo + "T23:59:59.999").toISOString() : null,
      };
      default: return { from: null, to: null };
    }
  };

  const loadActivity = async (reset: boolean) => {
    setLoadingMore(true);
    const offset = reset ? 0 : activityOffset;

    let query = supabase.from("gmail_sync_log")
      .select("id, action, project_id, gmail_label_name, target_user_id, details, created_at")
      .eq("company_id", companyId)
      .order("created_at", { ascending: activitySortAsc })
      .range(offset, offset + ACTIVITY_PAGE_SIZE - 1);
    if (activityFilter) query = query.eq("action", activityFilter);
    const { from, to } = activityDateBounds();
    if (from) query = query.gte("created_at", from);
    if (to) query = query.lte("created_at", to);

    const { data: rows } = await query;

    const userIds = Array.from(new Set((rows || []).map((r: any) => r.target_user_id).filter(Boolean)));
    let nameById = new Map<string, string>();
    if (userIds.length) {
      const { data: profiles } = await supabase.from("profiles").select("id, full_name, email").in("id", userIds);
      nameById = new Map((profiles || []).map((p: any) => [p.id, p.full_name || p.email || "Unknown"]));
    }

    // Resolve any project names not already known from the other sections' loads
    const projectIds = Array.from(new Set((rows || []).map((r: any) => r.project_id).filter(Boolean)));
    const missingIds = projectIds.filter(id => !projectNameById.has(id));
    let namesById = projectNameById;
    if (missingIds.length) {
      const { data: projects } = await supabase.from("projects").select("id, name").in("id", missingIds);
      const merged = new Map(namesById);
      for (const p of (projects || [])) merged.set(p.id, p.name);
      namesById = merged;
      setProjectNameById(merged);
    }

    const mapped: ActivityRow[] = (rows || []).map((r: any) => ({
      id: r.id,
      action: r.action,
      project_name: r.project_id ? (namesById.get(r.project_id) || null) : null,
      gmail_label_name: r.gmail_label_name,
      label_code: r.details?.label_code || null,
      email_subject: r.details?.subject || null,
      email_snippet: r.details?.snippet || null,
      user_name: r.target_user_id ? (nameById.get(r.target_user_id) || "Unknown") : "System",
      reapplied: !!r.details?.reapplied,
      created_at: r.created_at,
    }));

    setActivity(prev => reset ? mapped : [...prev, ...mapped]);
    setActivityOffset(offset + (rows?.length || 0));
    setActivityHasMore((rows?.length || 0) === ACTIVITY_PAGE_SIZE);
    setLoadingMore(false);
  };

  if (loading) return (
    <div className="flex items-center justify-center py-24">
      <Loader2 className="animate-spin text-slate-300" size={24} />
    </div>
  );

  const sections = [
    { id: "labels" as const, label: "Shared labels", icon: Tag },
    { id: "requests" as const, label: `Requests${archiveRequests.length ? ` (${archiveRequests.length})` : ""}`, icon: ClipboardCheck },
    { id: "archived" as const, label: "Archived", icon: Archive },
    { id: "queue" as const, label: "Live queue", icon: ListOrdered },
    { id: "failures" as const, label: `Failures${syncFailures.length ? ` (${syncFailures.length})` : ""}`, icon: AlertTriangle },
    { id: "activity" as const, label: "Activity log", icon: Activity },
    { id: "health" as const, label: "System health", icon: Radio },
  ];

  return (
    <div className="space-y-4">
      <div className="flex gap-2 flex-wrap">
        {sections.map(s => {
          const Icon = s.icon;
          return (
            <button
              key={s.id}
              onClick={() => setSection(s.id)}
              className={`flex items-center gap-2 px-4 py-2 rounded-full text-[11px] font-bold transition-all ${
                section === s.id
                  ? "bg-slate-900 text-white"
                  : "bg-white border border-slate-200 text-slate-500 hover:border-slate-400"
              }`}
            >
              <Icon size={13} />
              {s.label}
            </button>
          );
        })}
      </div>

      {section === "labels" && (
        <div className="space-y-3">
          <div className="bg-indigo-50 border border-indigo-100 rounded-2xl px-4 py-3 text-[11px] text-indigo-700">
            Sharing is company-wide — every label below is synced into every connected member's own Gmail.
            {sharedWithNames.length > 0 && (
              <> Currently shared with: <span className="font-bold">{sharedWithNames.join(", ")}</span>.</>
            )}
          </div>
          {sharedLabels.length === 0 ? (
            <p className="text-center text-slate-300 text-[11px] uppercase font-bold tracking-widest py-16">
              No active shared labels
            </p>
          ) : (
            sharedLabels.map(label => (
              <div key={label.project_id} className="bg-white border border-slate-100 rounded-[28px] p-5 flex items-center gap-4">
                <div className="h-10 w-10 rounded-2xl bg-sky-50 flex items-center justify-center shrink-0">
                  <Tag size={16} className="text-sky-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] font-bold text-slate-800 truncate">{label.gmail_label_name}</p>
                  <p className="text-[11px] text-slate-400 truncate mt-0.5">
                    Project: {label.project_name}
                    {label.label_code && <span className="ml-2 font-mono text-slate-300">[{label.label_code}]</span>}
                  </p>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <div className="flex items-center gap-1.5">
                    <Users2 size={13} className="text-slate-300" />
                    <span className="text-[11px] font-bold text-slate-500">{sharedWithNames.length}</span>
                  </div>
                  <button
                    onClick={() => handleArchive(label.project_id, label.gmail_label_name)}
                    disabled={archiveEmails.length === 0 || archivingProjectId === label.project_id}
                    title={archiveEmails.length === 0 ? "Nominate an archive account in Gmail settings first" : "Archive this project"}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[10px] font-bold bg-purple-50 text-purple-600 hover:bg-purple-100 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                  >
                    {archivingProjectId === label.project_id
                      ? <Loader2 size={11} className="animate-spin" />
                      : <Archive size={11} />
                    }
                    Archive
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {section === "requests" && (
        <div className="space-y-3">
          {archiveRequests.length === 0 ? (
            <p className="text-center text-slate-300 text-[11px] uppercase font-bold tracking-widest py-16">
              No pending archive requests
            </p>
          ) : (
            <>
              <div className="flex items-center justify-between px-1">
                <button
                  onClick={toggleSelectAllRequests}
                  className="text-[11px] font-bold text-slate-500 hover:text-slate-800"
                >
                  {selectedRequestIds.size === archiveRequests.length ? "Deselect all" : "Select all"}
                </button>
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleRejectSelected}
                    disabled={!selectedRequestIds.size || reviewingRequests}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-500 hover:bg-red-50 hover:text-red-500 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                  >
                    <X size={11} /> Reject
                  </button>
                  <button
                    onClick={handleApproveSelected}
                    disabled={!selectedRequestIds.size || reviewingRequests}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[10px] font-bold bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                  >
                    {reviewingRequests ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
                    Approve selected
                  </button>
                </div>
              </div>

              {archiveRequests.map(r => (
                <div
                  key={r.id}
                  onClick={() => toggleRequestSelected(r.id)}
                  className={`bg-white border rounded-[28px] p-5 flex items-center gap-4 cursor-pointer transition-all ${
                    selectedRequestIds.has(r.id) ? "border-purple-300 ring-2 ring-purple-100" : "border-slate-100"
                  }`}
                >
                  <div className={`h-5 w-5 rounded-md border-2 flex items-center justify-center shrink-0 ${
                    selectedRequestIds.has(r.id) ? "bg-purple-600 border-purple-600" : "border-slate-300"
                  }`}>
                    {selectedRequestIds.has(r.id) && <Check size={12} className="text-white" />}
                  </div>
                  <div className="h-10 w-10 rounded-2xl bg-purple-50 flex items-center justify-center shrink-0">
                    <ClipboardCheck size={16} className="text-purple-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[13px] font-bold text-slate-800 truncate">{r.project_name}</p>
                    <p className="text-[11px] text-slate-400 truncate mt-0.5">
                      Requested by {r.requester_name} — {new Date(r.created_at).toLocaleString()}
                    </p>
                    {r.error && (
                      <p className="text-[10px] text-red-500 mt-1">Last attempt failed: {r.error}</p>
                    )}
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {section === "archived" && (
        <div className="space-y-3">
          {archivedProjects.length === 0 ? (
            <p className="text-center text-slate-300 text-[11px] uppercase font-bold tracking-widest py-16">
              No archived projects yet
            </p>
          ) : (
            archivedProjects.map(p => (
              <div key={p.project_id} className="bg-white border border-slate-100 rounded-[28px] p-5 flex items-center gap-4">
                <div className="h-10 w-10 rounded-2xl bg-purple-50 flex items-center justify-center shrink-0">
                  <Archive size={16} className="text-purple-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] font-bold text-slate-800 truncate">{p.project_name}</p>
                  <p className="text-[11px] text-slate-400 truncate mt-0.5">{p.gmail_label_name}</p>
                  <p className="text-[10px] text-slate-300 mt-1">
                    Archived {new Date(p.archived_at).toLocaleString()}
                    {archiveEmails.length > 0 && <> — copies held by {archiveEmails.join(", ")}</>}
                  </p>
                </div>
                {p.job_status && p.job_status !== "done" && (
                  <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold uppercase shrink-0 ${JOB_STATUS_STYLES[p.job_status] || "bg-slate-100 text-slate-500"}`}>
                    {p.job_status}
                  </span>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {section === "queue" && (
        <div className="space-y-3">
          {queue.length === 0 ? (
            <p className="text-center text-slate-300 text-[11px] uppercase font-bold tracking-widest py-16">
              Queue is empty — nothing in process
            </p>
          ) : (
            queue.map(job => {
              const done = job.completed_users?.length || 0;
              const total = job.total_users || 0;
              const expanded = expandedJobId === job.id;
              return (
                <div key={job.id} className="bg-white border border-slate-100 rounded-[28px] p-5">
                  <div className="flex items-center gap-3 mb-2 flex-wrap">
                    <span className="px-2 py-0.5 rounded-full text-[9px] font-bold uppercase bg-slate-100 text-slate-500">
                      #{job.position}
                    </span>
                    <span className="px-2 py-0.5 rounded-full text-[9px] font-bold uppercase bg-indigo-50 text-indigo-600">
                      {job.job_type === "label_sync" ? "Label sync" : job.job_type === "email_sync" ? "Email sync" : "Archive"}
                    </span>
                    <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold uppercase ${JOB_STATUS_STYLES[job.status] || "bg-slate-100 text-slate-500"}`}>
                      {job.status}
                    </span>
                    <span className="px-2 py-0.5 rounded-full text-[9px] font-bold uppercase bg-slate-100 text-slate-500">
                      {job.emailCount} email{job.emailCount !== 1 ? "s" : ""}
                    </span>
                  </div>
                  <p className="text-[13px] font-bold text-slate-800 truncate">{job.gmail_label_name}</p>
                  <p className="text-[11px] text-slate-400 truncate mt-0.5">Project: {job.project_name}</p>
                  <div className="mt-3 flex items-center gap-2">
                    <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-indigo-500 rounded-full transition-all"
                        style={{ width: `${total ? Math.round((done / total) * 100) : 0}%` }}
                      />
                    </div>
                    <button
                      onClick={() => setExpandedJobId(expanded ? null : job.id)}
                      className="text-[10px] font-bold text-indigo-500 hover:text-indigo-700 shrink-0"
                    >
                      {done}/{total} users {expanded ? "▲" : "▼"}
                    </button>
                  </div>
                  {expanded && (
                    <div className="mt-3 pt-3 border-t border-slate-100 space-y-2">
                      <div>
                        <p className="text-[9px] font-bold text-emerald-500 uppercase tracking-widest mb-1">
                          Done ({job.doneNames.length})
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {job.doneNames.length === 0
                            ? <span className="text-[11px] text-slate-300 italic">None yet</span>
                            : job.doneNames.map((name, i) => (
                                <span key={i} className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-50 text-emerald-700">
                                  {name}
                                </span>
                              ))
                          }
                        </div>
                      </div>
                      <div>
                        <p className="text-[9px] font-bold text-amber-500 uppercase tracking-widest mb-1">
                          Pending ({job.pendingNames.length})
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {job.pendingNames.length === 0
                            ? <span className="text-[11px] text-slate-300 italic">None — all done</span>
                            : job.pendingNames.map((name, i) => (
                                <span key={i} className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-amber-50 text-amber-700">
                                  {name}
                                </span>
                              ))
                          }
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}

      {section === "failures" && (
        <div className="space-y-3">
          <div className="bg-red-50 border border-red-100 rounded-2xl px-4 py-3 text-[11px] text-red-700">
            A user's account failed to sync and was quarantined so it couldn't block the rest of the queue.
            gmail-sync-recovery-worker retries it every 15 minutes; anything still failing after 3 retries shows as a
            persistent failure and needs the account owner to fix it (usually reconnecting Gmail, or waiting out a rate limit).
          </div>
          {syncFailures.length === 0 ? (
            <p className="text-center text-slate-300 text-[11px] uppercase font-bold tracking-widest py-16">
              No failures — everything syncing cleanly
            </p>
          ) : (
            syncFailures.map(f => (
              <div key={f.id} className="bg-white border border-slate-100 rounded-[28px] p-5 flex items-start gap-4">
                <div className={`h-10 w-10 rounded-2xl flex items-center justify-center shrink-0 ${
                  f.status === "persistent_failure" ? "bg-red-50" : "bg-amber-50"
                }`}>
                  <AlertTriangle size={16} className={f.status === "persistent_failure" ? "text-red-600" : "text-amber-600"} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold uppercase ${
                      f.status === "persistent_failure" ? "bg-red-50 text-red-600" : "bg-amber-50 text-amber-600"
                    }`}>
                      {f.status === "persistent_failure" ? "Persistent failure" : "Retrying"}
                    </span>
                    <span className="px-2 py-0.5 rounded-full text-[9px] font-bold uppercase bg-slate-100 text-slate-500">
                      {f.job_type === "label_sync" ? "Label sync" : f.job_type === "email_sync" ? "Email sync" : f.job_type}
                    </span>
                  </div>
                  <p className="text-[13px] font-bold text-slate-800 truncate mt-1">{f.project_name}</p>
                  {f.gmail_label_name && (
                    <p className="text-[11px] text-slate-400 truncate mt-0.5">{f.gmail_label_name}</p>
                  )}
                  <p className="text-[11px] text-slate-500 font-medium mt-1.5">{f.user_name}</p>
                  {f.last_error && (
                    <p className="text-[11px] text-red-500 mt-1 break-words">{f.last_error}</p>
                  )}
                  <p className="text-[10px] text-slate-300 mt-1.5">
                    First failed {new Date(f.first_failed_at).toLocaleString()}
                    {f.last_attempted_at && <> — last retried {new Date(f.last_attempted_at).toLocaleString()}</>}
                    {" "}— {f.attempts} recovery attempt{f.attempts !== 1 ? "s" : ""}
                  </p>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {section === "activity" && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={activityFilter || "all"}
              onChange={e => setActivityFilter(e.target.value === "all" ? null : e.target.value)}
              className="min-w-0 flex-1 sm:flex-none bg-white border border-slate-200 rounded-full py-1.5 px-3 text-[11px] font-bold text-slate-600 outline-none focus:ring-4 focus:ring-slate-100"
            >
              <option value="all">All actions</option>
              {Object.entries(ACTION_META).map(([key, meta]) => (
                <option key={key} value={key}>{meta.label}</option>
              ))}
            </select>

            <div className="flex items-center gap-1.5 min-w-0 flex-1 sm:flex-none">
              <Clock size={13} className="text-slate-300 shrink-0" />
              <select
                value={activityRange}
                onChange={e => setActivityRange(e.target.value as ActivityRange)}
                className="min-w-0 flex-1 sm:flex-none bg-white border border-slate-200 rounded-full py-1.5 px-3 text-[11px] font-bold text-slate-600 outline-none focus:ring-4 focus:ring-indigo-100"
              >
                {ACTIVITY_RANGE_OPTIONS.map(opt => (
                  <option key={opt.id} value={opt.id}>{opt.label}</option>
                ))}
              </select>
            </div>

            <button
              onClick={() => setActivitySortAsc(v => !v)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-bold border border-slate-200 bg-white text-slate-500 hover:border-slate-400 transition-all sm:ml-auto"
            >
              <ArrowUpDown size={11} className="shrink-0" />
              <span className="hidden sm:inline">{activitySortAsc ? "Oldest first" : "Newest first"}</span>
            </button>
          </div>

          {activityRange === "custom" && (
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="date"
                value={activityCustomFrom}
                onChange={e => setActivityCustomFrom(e.target.value)}
                className="bg-white border border-slate-200 rounded-full py-1.5 px-3 text-[11px] font-medium outline-none focus:ring-4 focus:ring-indigo-100"
              />
              <span className="text-[11px] text-slate-400">to</span>
              <input
                type="date"
                value={activityCustomTo}
                onChange={e => setActivityCustomTo(e.target.value)}
                className="bg-white border border-slate-200 rounded-full py-1.5 px-3 text-[11px] font-medium outline-none focus:ring-4 focus:ring-indigo-100"
              />
            </div>
          )}

          {activity.length === 0 ? (
            <p className="text-center text-slate-300 text-[11px] uppercase font-bold tracking-widest py-16">
              No activity recorded yet
            </p>
          ) : (
            <>
              {activity.map(row => {
                const meta = ACTION_META[row.action] || { label: row.action, icon: Mail, style: "bg-slate-100 text-slate-500" };
                const Icon = meta.icon;
                return (
                  <div key={row.id} className="bg-white border border-slate-100 rounded-[28px] p-5 flex items-start gap-4">
                    <div className={`h-9 w-9 rounded-2xl flex items-center justify-center shrink-0 ${meta.style}`}>
                      <Icon size={15} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold uppercase ${meta.style}`}>
                          {meta.label}
                        </span>
                        {row.project_name && (
                          <span className="text-[11px] font-bold text-slate-500 truncate">{row.project_name}</span>
                        )}
                        {row.gmail_label_name && (
                          <span className="text-[11px] text-slate-400 truncate">
                            {row.gmail_label_name}{row.label_code && ` [${row.label_code}]`}
                          </span>
                        )}
                      </div>
                      {row.email_subject && (
                        <p className="text-[13px] font-bold text-slate-800 truncate mt-1">{row.email_subject}</p>
                      )}
                      {row.email_snippet && (
                        <p className="text-[11px] text-slate-400 truncate mt-0.5">{row.email_snippet}</p>
                      )}
                      <p className="text-[11px] text-slate-500 font-medium mt-1.5">
                        {describeActivity(row)}
                      </p>
                      <p className="text-[10px] text-slate-300 mt-0.5">
                        {new Date(row.created_at).toLocaleString()}
                      </p>
                    </div>
                  </div>
                );
              })}
              {activityHasMore && (
                <button
                  onClick={() => loadActivity(false)}
                  disabled={loadingMore}
                  className="w-full py-3 bg-white border border-slate-200 text-slate-500 rounded-full text-[11px] font-bold hover:border-slate-400 disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {loadingMore ? <Loader2 size={12} className="animate-spin" /> : "Load more"}
                </button>
              )}
            </>
          )}
        </div>
      )}

      {section === "health" && (
        <div className="space-y-3">
          {Object.entries(HEARTBEAT_DEFS).map(([name, def]) => {
            const hb = heartbeats.find(h => h.name === name);
            const lastRunMs = hb ? new Date(hb.last_run_at).getTime() : 0;
            const isLive = lastRunMs > 0 && (Date.now() - lastRunMs) < def.intervalMs * 2;
            const resultEntries = hb?.last_result && typeof hb.last_result === "object"
              ? Object.entries(hb.last_result)
              : [];
            return (
              <div key={name} className="bg-white border border-slate-100 rounded-[28px] p-5">
                <div className="flex items-center gap-4">
                  <div className={`h-10 w-10 rounded-2xl flex items-center justify-center shrink-0 ${isLive ? "bg-emerald-50" : "bg-red-50"}`}>
                    <Radio size={16} className={isLive ? "text-emerald-600" : "text-red-500"} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[13px] font-bold text-slate-800">{def.label}</p>
                    <p className="text-[11px] text-slate-400 mt-0.5">
                      {hb ? `Last ran ${new Date(hb.last_run_at).toLocaleString()}` : "Never ran"}
                    </p>
                  </div>
                  <span className={`px-3 py-1 rounded-full text-[10px] font-bold uppercase shrink-0 ${
                    isLive ? "bg-emerald-50 text-emerald-600" : "bg-red-50 text-red-600"
                  }`}>
                    {isLive ? "Live" : "Down"}
                  </span>
                </div>
                {resultEntries.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-3 pt-3 border-t border-slate-100">
                    {resultEntries.map(([key, value]) => (
                      <span key={key} className="px-2.5 py-1 rounded-full text-[10px] font-medium bg-slate-50 text-slate-500">
                        <span className="text-slate-400">{key}:</span> {String(value)}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Mirrors the worker's own pending-job priority: brand new jobs first, then
// jobs already in progress, then everything else oldest-first — so
// "position" reflects the order the worker will actually pick them up in.
function computeQueuePositions(jobs: any[]): any[] {
  const byType = new Map<string, any[]>();
  for (const j of jobs) {
    if (!byType.has(j.job_type)) byType.set(j.job_type, []);
    byType.get(j.job_type)!.push(j);
  }
  const result: any[] = [];
  for (const [, list] of byType) {
    const brandNew = list.filter(j => j.status === "pending" && (!j.completed_users || j.completed_users.length === 0))
      .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
    const processing = list.filter(j => j.status === "processing");
    const inProgress = list.filter(j => j.status === "pending" && j.completed_users?.length > 0)
      .sort((a, b) => new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime());
    const ordered = [...brandNew, ...processing, ...inProgress];
    ordered.forEach((j, idx) => result.push({ ...j, position: idx + 1 }));
  }
  return result;
}
