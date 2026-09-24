import { registerLabels } from '@/lib/labels';

/** Enum labels for accounts, characters, references, partners and deals (English dictionary). */
registerLabels({
  accountStatus: { preparing: 'Preparing', active: 'Active', paused: 'Paused', restricted: 'Restricted', archived: 'Archived' },
  metricsCadence: { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' },
  responsibility: {
    direction_management: 'Direction Management',
    producing: 'Producing',
    writing: 'Writing',
    image_generation: 'Image Generation',
    video_generation: 'Video Generation',
    voice: 'Voice',
    editing: 'Editing',
    quality_review: 'Quality Review',
    publishing: 'Publishing',
    analytics: 'Analytics',
    ofm_operations: 'OFM Operations',
    finance: 'Finance',
  },
  characterVersionState: { draft: 'Draft', submitted: 'Awaiting Approval', approved: 'Approved', superseded: 'Superseded' },
  referenceTag: { hook: 'Hook', lighting: 'Lighting', story: 'Story', edit: 'Edit', character: 'Character', other: 'Other' },
  partnerKind: { organization: 'Organization', person: 'Person' },
  interactionKind: { call: 'Call', meeting: 'Meeting', email_summary: 'E-mail Summary', note: 'Note', other: 'Other' },
  dealStage: {
    lead: 'Lead',
    discussing: 'Discussing',
    proposal: 'Proposal',
    negotiation: 'Negotiation',
    won: 'Won',
    delivering: 'Delivering',
    fulfilled: 'Fulfilled',
    lost: 'Lost',
    cancelled: 'Cancelled',
  },
  deliverableStatus: { open: 'Open', delivered: 'Delivered', accepted: 'Accepted', cancelled: 'Cancelled' },
  contentStage: {
    idea: 'Idea',
    brief: 'Brief',
    ready: 'Ready',
    production: 'Production',
    review: 'Review',
    changes_requested: 'Changes Requested',
    approved: 'Approved',
    archived: 'Archived',
  },
});

export const WEEKDAY_OPTIONS = [
  { value: '1', label: 'Monday' },
  { value: '2', label: 'Tuesday' },
  { value: '3', label: 'Wednesday' },
  { value: '4', label: 'Thursday' },
  { value: '5', label: 'Friday' },
  { value: '6', label: 'Saturday' },
  { value: '7', label: 'Sunday' },
];

/** Exact microcopy (section 31.2). */
export const NO_INTEGRATION_NOTE = 'Account links do not import statistics or publish content.';
export const EMPTY_ACCOUNTS = 'Add an account link to start planning publications and recording results.';
export const ARCHIVE_EXPLANATION = 'Archived records remain available in historical reports.';
export const NO_METRICS = 'No data recorded for this period.';
export const NOT_PROVIDED = 'Not provided';
