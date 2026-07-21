// lib/gmail/types.ts

export type LabelFormat = 'project_name' | 'matter_number' | 'company_project';

export interface GmailMessage {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  fromName: string;
  date: string;
  snippet: string;
  hasAttachments: boolean;
  isRead: boolean;
  labelIds: string[];
  diractLabels: string[];
}

export interface GmailProject {
  id: string;
  name: string;
  property: { street_address: string } | { street_address: string }[] | null;
}

export interface SearchableField {
  key: string;
  label: string;
}

export interface GmailPageState {
  // Connection
  connected: boolean | null;
  gmailEmail: string | null;
  companyName: string;
  isAdmin: boolean;
  // Messages
  messages: GmailMessage[];
  loading: boolean;
  fetchError: string | null;
  activeFilter: string;
  // Selection
  selectedMessage: GmailMessage | null;
  emailBody: string | null;
  loadingBody: boolean;
  selectedLabelIds: string[];
  // Projects
  projects: GmailProject[];
  assignedMap: Record<string, string>;
  assigning: string | null;
  projectSearch: string;
  projectCfValues: Record<string, Record<string, string>>;
  // Label
  labelFormat: LabelFormat;
  parentLabel: string;
  // Search config
  searchFields: string[];
  searchableFields: SearchableField[];
  // Sync
  syncing: boolean;
  lastSynced: Date | null;
  // UI
  showActivityLog: boolean;
  showCompose: boolean;
  showLabelSettings: boolean;
  showProjectDropdown: boolean;
  showSearchConfig: boolean;
}

export function getProjectLabel(project: GmailProject): string {
  if (!project.property) return project.name;
  if (Array.isArray(project.property)) {
    return project.property[0]?.street_address || project.name;
  }
  return (project.property as { street_address: string }).street_address || project.name;
}

export function formatDate(dateStr: string): string {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
  } catch { return dateStr; }
}

export function getFirstTwoWords(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).join(' ');
}

export const SYSTEM_LABELS = new Set([
  'INBOX', 'UNREAD', 'IMPORTANT', 'SENT', 'DRAFT',
  'SPAM', 'TRASH', 'STARRED', 'CATEGORY_PERSONAL',
  'CATEGORY_SOCIAL', 'CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES',
  'CATEGORY_FORUMS',
]);

export const GMAIL_FILTERS = [
  { label: 'Inbox',   q: 'in:inbox' },
  { label: 'Unread',  q: 'is:unread in:inbox' },
  { label: 'Sent',    q: 'in:sent' },
  { label: 'Starred', q: 'is:starred' },
];
