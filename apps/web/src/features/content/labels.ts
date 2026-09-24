import { registerLabels } from '@/lib/labels';

/** English labels for the production module's canonical values (section 21 dictionaries). */
registerLabels({
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
  contentSlot: {
    main_video: 'Main Video',
    main_image: 'Main Image',
    image_set: 'Image Set',
    cover: 'Cover',
    subtitles: 'Subtitles',
    caption: 'Caption',
    audio: 'Audio',
    document: 'Document',
    source_archive: 'Source Archive',
    other: 'Other File',
  },
  reviewStep: { content_quality: 'Content Quality', release_approval: 'Release Approval' },
  reviewStatus: {
    pending: 'Pending',
    approved: 'Approved',
    changes_requested: 'Changes Requested',
    cancelled: 'Cancelled',
    superseded: 'Superseded',
  },
  versionState: {
    draft: 'Draft',
    submitted: 'In Review',
    approved: 'Approved',
    changes_requested: 'Changes Requested',
    revoked: 'Approval Revoked',
    superseded: 'Superseded',
  },
  commentSeverity: { note: 'Note', issue: 'Issue', blocking: 'Blocker' },
  reviewDecision: {
    approved: 'Approved',
    changes_requested: 'Changes Requested',
    revoked: 'Approval Revoked',
  },
});

export const CONTENT_BRIEF_FIELDS = [
  { key: 'summary', label: 'Brief Summary', long: true },
  { key: 'objective', label: 'Objective', long: false },
  { key: 'audience', label: 'Audience', long: false },
  { key: 'hook', label: 'Hook', long: false },
  { key: 'script', label: 'Script', long: true },
  { key: 'captionDraft', label: 'Caption Draft', long: true },
  { key: 'cta', label: 'CTA', long: false },
  { key: 'notes', label: 'Notes', long: true },
] as const;
