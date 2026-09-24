import type { CONTENT_FORMATS, CONTENT_SLOTS, CONTENT_STAGES, REVIEW_STEP_KINDS, TransitionTable } from '@castlane/domain';

/**
 * Pure production rules (section 10): the ContentItem state table, readiness checks per target
 * stage, deliverable slots and checklists per format, review steps from the project policy and
 * annotation bounds. No database access; unit-tested in rules.test.ts.
 */
export type ContentStage = (typeof CONTENT_STAGES)[number];
export type ContentFormat = (typeof CONTENT_FORMATS)[number];
export type ContentSlot = (typeof CONTENT_SLOTS)[number];
export type ReviewStepKind = (typeof REVIEW_STEP_KINDS)[number];

/**
 * Every allowed stage change (§10.1). Review-driven edges (Production → Review by Submit,
 * Review → Approved / Changes Requested by a decision, Approved → Changes Requested by Revoke
 * Approval) are only reachable through their own commands; see MANUAL_TRANSITIONS.
 * Archived is left only through Restore (back to the stage before archiving).
 */
export const CONTENT_TRANSITIONS: TransitionTable<ContentStage> = {
  idea: ['brief', 'archived'],
  brief: ['ready', 'archived'],
  ready: ['production', 'archived'],
  production: ['review', 'archived'],
  review: ['changes_requested', 'approved', 'archived'],
  changes_requested: ['production', 'archived'],
  approved: ['production', 'changes_requested', 'archived'],
  archived: [],
};

/** Transitions a member may request with the generic Move / transition command. */
export const MANUAL_TRANSITIONS: TransitionTable<ContentStage> = {
  idea: ['brief'],
  brief: ['ready'],
  ready: ['production'],
  production: [],
  review: [],
  changes_requested: ['production'],
  approved: ['production'],
  archived: [],
};

export const isManualTransition = (from: ContentStage, to: ContentStage) => (MANUAL_TRANSITIONS[from] ?? []).includes(to);

/** Why a stage cannot be reached by a manual move (e.g. dragging a card straight to Approved). */
export const manualMoveExplanation = (from: ContentStage, to: ContentStage): string | null => {
  if (isManualTransition(from, to)) return null;
  if (from === to) return 'The content is already in this stage.';
  if (to === 'approved') return 'Approval happens in Review: open the review of the submitted version and approve it there.';
  if (to === 'review') return from === 'production' || from === 'changes_requested' ? 'Submit a version for review from the content page.' : 'Only content in Production can be submitted for review.';
  if (to === 'changes_requested') return 'Changes are requested by a reviewer inside the review.';
  if (to === 'archived') return 'Use Archive Content to archive with a preview of open obligations.';
  if (from === 'review') return 'A review is in progress. Wait for the decision or request changes in the review.';
  if (from === 'archived') return 'Restore the content before moving it.';
  return `Content cannot move from ${stageLabel(from)} to ${stageLabel(to)}.`;
};

export const STAGE_LABELS: Record<ContentStage, string> = {
  idea: 'Idea',
  brief: 'Brief',
  ready: 'Ready',
  production: 'Production',
  review: 'Review',
  changes_requested: 'Changes Requested',
  approved: 'Approved',
  archived: 'Archived',
};
export const stageLabel = (s: ContentStage) => STAGE_LABELS[s] ?? s;

/** Canonical pipeline columns (Archived is not shown in the active pipeline). */
export const PIPELINE_STAGES: ContentStage[] = ['idea', 'brief', 'ready', 'production', 'review', 'changes_requested', 'approved'];

export interface BriefFields {
  summary?: string | null;
  objective?: string | null;
  audience?: string | null;
  hook?: string | null;
  script?: string | null;
  captionDraft?: string | null;
  cta?: string | null;
  notes?: string | null;
}

export interface ReadinessInput {
  stage: ContentStage;
  projectStatus: string;
  ownerMembershipId: string | null;
  reviewerMembershipId: string | null;
  brief: BriefFields;
  dueAt: Date | string | null;
  noDeadline: boolean;
  blocked: boolean;
  paused: boolean;
  /** Open tasks of this content that are flagged Blocked (blocking dependencies). */
  blockedTasks: number;
}

export interface Missing {
  field: string;
  code: string;
  message: string;
}

const filled = (v: string | null | undefined) => !!v && v.trim().length > 0;

/**
 * Conditions of a manual transition (§10.1). Returns what is missing; empty means allowed.
 * Idea → Brief: active project (the format is always set). Brief → Ready: brief summary, owner,
 * reviewer, objective, due date or explicit No Deadline. Ready / Changes Requested → Production:
 * an owner and no blocking dependencies (Blocked flag, blocked tasks) or pause.
 */
export const transitionRequirements = (to: ContentStage, c: ReadinessInput): Missing[] => {
  const out: Missing[] = [];
  const projectActive = c.projectStatus === 'active';
  if (to === 'brief') {
    if (!projectActive) out.push({ field: 'projectId', code: 'PROJECT_NOT_ACTIVE', message: 'The project must be active before the brief starts.' });
  }
  if (to === 'ready') {
    if (!filled(c.brief.summary)) out.push({ field: 'brief.summary', code: 'REQUIRED', message: 'Add a brief summary.' });
    if (!c.ownerMembershipId) out.push({ field: 'ownerMembershipId', code: 'REQUIRED', message: 'Assign an owner before starting this work.' });
    if (!c.reviewerMembershipId) out.push({ field: 'reviewerMembershipId', code: 'REQUIRED', message: 'Choose a reviewer.' });
    if (!filled(c.brief.objective)) out.push({ field: 'brief.objective', code: 'REQUIRED', message: 'Add the objective.' });
    if (!c.dueAt && !c.noDeadline) out.push({ field: 'dueAt', code: 'REQUIRED', message: 'Set a due date or mark No Deadline.' });
  }
  if (to === 'production') {
    if (!projectActive) out.push({ field: 'projectId', code: 'PROJECT_NOT_ACTIVE', message: 'The project is not active.' });
    if (!c.ownerMembershipId) out.push({ field: 'ownerMembershipId', code: 'REQUIRED', message: 'Assign an owner before starting this work.' });
    if (c.blocked) out.push({ field: 'blocked', code: 'BLOCKED', message: 'The content is flagged Blocked. Unblock it first.' });
    if (c.paused) out.push({ field: 'paused', code: 'PAUSED', message: 'The content is paused. Resume it first.' });
    if (c.blockedTasks > 0) out.push({ field: 'tasks', code: 'BLOCKED_TASKS', message: `${c.blockedTasks} task${c.blockedTasks === 1 ? ' is' : 's are'} blocked.` });
  }
  return out;
};

// ——— Deliverables and checklists ———

export interface SlotRequirement {
  slot: ContentSlot;
  required: boolean;
}

/** Default deliverable slots per format; a content template's `deliverableSlots` replaces them. */
export const DEFAULT_DELIVERABLE_SLOTS: Record<ContentFormat, SlotRequirement[]> = {
  short_video: [
    { slot: 'main_video', required: true },
    { slot: 'cover', required: false },
    { slot: 'subtitles', required: false },
    { slot: 'source_archive', required: false },
  ],
  episode: [
    { slot: 'main_video', required: true },
    { slot: 'cover', required: false },
    { slot: 'subtitles', required: false },
    { slot: 'source_archive', required: false },
  ],
  trailer: [
    { slot: 'main_video', required: true },
    { slot: 'cover', required: false },
    { slot: 'subtitles', required: false },
  ],
  image: [{ slot: 'main_image', required: true }],
  carousel: [
    { slot: 'image_set', required: true },
    { slot: 'cover', required: false },
  ],
  photo_set: [
    { slot: 'image_set', required: true },
    { slot: 'cover', required: false },
    { slot: 'source_archive', required: false },
  ],
  story: [
    { slot: 'main_video', required: false },
    { slot: 'main_image', required: false },
  ],
  audio: [
    { slot: 'audio', required: true },
    { slot: 'cover', required: false },
  ],
  text_post: [
    { slot: 'caption', required: false },
    { slot: 'main_image', required: false },
  ],
  other: [
    { slot: 'other', required: false },
    { slot: 'document', required: false },
  ],
};

/** Slots allowed to hold several files (ordered by position). */
export const MULTI_FILE_SLOTS: ReadonlySet<ContentSlot> = new Set(['image_set', 'other', 'document', 'subtitles']);

export const deliverableSlotsFor = (format: ContentFormat, templateSlots?: { slot: string; required: boolean }[] | null): SlotRequirement[] => {
  if (templateSlots && templateSlots.length) return templateSlots.map((s) => ({ slot: s.slot as ContentSlot, required: !!s.required }));
  return DEFAULT_DELIVERABLE_SLOTS[format] ?? DEFAULT_DELIVERABLE_SLOTS.other;
};

export interface ChecklistItem {
  label: string;
  done: boolean;
  mandatory: boolean;
}

const VIDEO_AUDIO: ContentFormat[] = ['short_video', 'episode', 'trailer', 'story', 'audio'];
const CAPTIONED: ContentFormat[] = ['short_video', 'trailer', 'image', 'carousel', 'photo_set', 'story', 'text_post'];

/** Default version checklist per format; a content template's `checklist` replaces it. */
export const defaultChecklist = (format: ContentFormat): { label: string; mandatory: boolean }[] => [
  { label: 'Files match the brief and the approved character versions', mandatory: true },
  ...(CAPTIONED.includes(format) ? [{ label: 'Caption draft and call to action checked', mandatory: true }] : []),
  ...(VIDEO_AUDIO.includes(format) ? [{ label: 'Music, voice and source material are cleared for use', mandatory: true }] : []),
  ...(format === 'episode' || format === 'trailer' ? [{ label: 'Subtitles checked against the final cut', mandatory: false }] : []),
];

export const checklistFor = (format: ContentFormat, templateChecklist?: { label: string; mandatory: boolean }[] | null): ChecklistItem[] =>
  (templateChecklist && templateChecklist.length ? templateChecklist : defaultChecklist(format)).map((c) => ({ label: c.label, mandatory: !!c.mandatory, done: false }));

export interface AttachedFile {
  slot: ContentSlot;
  status: string;
  fileName?: string;
}

/**
 * Production → Review conditions (§10.1): every required deliverable slot has a file, every
 * attached file is Available (uploading / checking / processing / rejected files block — T038),
 * the mandatory checklist is done, and the version is not empty.
 */
export const submitRequirements = (input: { format: ContentFormat; slots: SlotRequirement[]; files: AttachedFile[]; checklist: ChecklistItem[]; captionDraft?: string | null }): Missing[] => {
  const out: Missing[] = [];
  for (const s of input.slots)
    if (s.required && !input.files.some((f) => f.slot === s.slot))
      out.push({ field: `slots.${s.slot}`, code: 'MISSING_DELIVERABLE', message: `Upload the required ${slotLabel(s.slot)}.` });
  for (const f of input.files)
    if (f.status !== 'available')
      out.push({
        field: `slots.${f.slot}`,
        code: f.status === 'rejected' || f.status === 'failed' ? 'FILE_REJECTED' : 'FILE_NOT_AVAILABLE',
        message:
          f.status === 'rejected' || f.status === 'failed'
            ? `${f.fileName ?? 'A file'} (${slotLabel(f.slot)}) was rejected. Replace it.`
            : `${f.fileName ?? 'A file'} (${slotLabel(f.slot)}) is still being checked and prepared. Wait until it is Available.`,
      });
  if (input.files.length === 0 && !(input.format === 'text_post' && filled(input.captionDraft)))
    out.push({ field: 'files', code: 'EMPTY_VERSION', message: input.format === 'text_post' ? 'Add the caption draft to the brief or attach the text as a file.' : 'Upload at least one file to this version.' });
  for (const c of input.checklist)
    if (c.mandatory && !c.done) out.push({ field: 'checklist', code: 'CHECKLIST_INCOMPLETE', message: `Complete the checklist item “${c.label}”.` });
  return out;
};

export const SLOT_LABELS: Record<ContentSlot, string> = {
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
};
export const slotLabel = (s: ContentSlot) => SLOT_LABELS[s] ?? s;

// ——— Review policy ———

export interface ProjectReviewPolicy {
  contentQualityStep: boolean;
  releaseApprovalStep: boolean;
  allowSelfReview: boolean;
  eligibleReviewerMembershipIds?: string[];
}

/** Ordered review steps: optional Content Quality, then Release Approval (always at least one step). */
export const reviewSteps = (p: Pick<ProjectReviewPolicy, 'contentQualityStep' | 'releaseApprovalStep'>): ReviewStepKind[] => {
  const steps: ReviewStepKind[] = [];
  if (p.contentQualityStep) steps.push('content_quality');
  if (p.releaseApprovalStep || steps.length === 0) steps.push('release_approval');
  return steps;
};

/** Stable short fingerprint of a review policy (the client echoes it as `reviewPolicyVersion`). */
export const reviewPolicyVersion = (p: ProjectReviewPolicy): string => {
  const canonical = JSON.stringify({
    q: !!p.contentQualityStep,
    r: !!p.releaseApprovalStep,
    s: !!p.allowSelfReview,
    e: [...(p.eligibleReviewerMembershipIds ?? [])].sort(),
  });
  // FNV-1a 32-bit.
  let h = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `p${h.toString(16).padStart(8, '0')}`;
};

export type SelfReviewOutcome = 'not_self' | 'allowed_by_policy' | 'owner_exception' | 'forbidden';

/**
 * Separation of duties (T039): the author of a submitted version may not approve it. The project
 * policy may allow exceptional self-review; otherwise only the workspace Owner may use an explicit,
 * audited exception. In both cases the member must ask for the exception with a reason.
 */
export const selfReviewOutcome = (input: { actorMembershipId: string | null; authorMembershipId: string | null; policyAllowsSelfReview: boolean; actorIsOwner: boolean; exceptionRequested: boolean }): SelfReviewOutcome => {
  if (!input.actorMembershipId || input.actorMembershipId !== input.authorMembershipId) return 'not_self';
  if (!input.exceptionRequested) return 'forbidden';
  if (input.policyAllowsSelfReview) return 'allowed_by_policy';
  if (input.actorIsOwner) return 'owner_exception';
  return 'forbidden';
};

// ——— Annotations ———

export interface AnnotationTarget {
  kind: string;
  durationMs: number | null;
}

/**
 * Review annotations (§10.3): a video/audio timecode must lie within the known duration (T045);
 * an image point is normalised 0–1 on both axes and only allowed on images (T046).
 */
export const annotationErrors = (target: AnnotationTarget | null, a: { timecodeMs?: number | null; pointX?: string | null; pointY?: string | null }): Missing[] => {
  const out: Missing[] = [];
  const hasTime = a.timecodeMs !== undefined && a.timecodeMs !== null;
  const hasPoint = (a.pointX !== undefined && a.pointX !== null) || (a.pointY !== undefined && a.pointY !== null);
  if ((hasTime || hasPoint) && !target) out.push({ field: 'assetVersionId', code: 'REQUIRED', message: 'Choose the file the annotation refers to.' });
  if (!target) return out;
  if (hasTime) {
    if (target.kind !== 'video' && target.kind !== 'audio') out.push({ field: 'timecodeMs', code: 'NOT_TIMED', message: 'Timecodes are only available on video and audio files.' });
    else if (target.durationMs === null) out.push({ field: 'timecodeMs', code: 'DURATION_UNKNOWN', message: 'The duration of this file is unknown, so a timecode cannot be checked. Comment without a timecode.' });
    else if ((a.timecodeMs as number) < 0 || (a.timecodeMs as number) > target.durationMs)
      out.push({ field: 'timecodeMs', code: 'OUT_OF_RANGE', message: `The timecode must be between 0:00 and ${formatTimecode(target.durationMs)}.` });
  }
  if (hasPoint) {
    if (target.kind !== 'image') out.push({ field: 'pointX', code: 'NOT_IMAGE', message: 'Point annotations are only available on images.' });
    const x = Number(a.pointX);
    const y = Number(a.pointY);
    if (a.pointX == null || a.pointY == null || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1)
      out.push({ field: 'pointX', code: 'OUT_OF_RANGE', message: 'Point coordinates must be between 0 and 1.' });
  }
  return out;
};

export const formatTimecode = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
};

/** Media kind of an asset version for annotations (video/audio/image/other). */
export const mediaKindOf = (mime: string | null | undefined): 'image' | 'video' | 'audio' | 'other' => {
  if (!mime) return 'other';
  if (mime.startsWith('image/') && mime !== 'image/svg+xml') return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'other';
};

// ——— Deadlines ———

/** Overdue = due in the past and not yet approved/archived. No deadline is never overdue. */
export const isContentOverdue = (dueAt: Date | null, stage: ContentStage, now: Date): boolean =>
  !!dueAt && dueAt.getTime() < now.getTime() && stage !== 'approved' && stage !== 'archived';

/** Whole hours a review has been waiting (never negative). */
export const waitingHours = (submittedAt: Date, now: Date): number => Math.max(0, Math.floor((now.getTime() - submittedAt.getTime()) / 3_600_000));
