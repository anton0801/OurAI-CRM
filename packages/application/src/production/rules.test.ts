import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CONTENT_FORMATS, CONTENT_STAGES, canTransition } from '@castlane/domain';
import {
  CONTENT_TRANSITIONS,
  MANUAL_TRANSITIONS,
  annotationErrors,
  checklistFor,
  deliverableSlotsFor,
  formatTimecode,
  isContentOverdue,
  isManualTransition,
  manualMoveExplanation,
  reviewPolicyVersion,
  reviewSteps,
  selfReviewOutcome,
  submitRequirements,
  transitionRequirements,
  waitingHours,
  type ContentStage,
  type ReadinessInput,
} from './rules';

const stage = fc.constantFrom(...CONTENT_STAGES);

const ready: ReadinessInput = {
  stage: 'brief',
  projectStatus: 'active',
  ownerMembershipId: 'o',
  reviewerMembershipId: 'r',
  brief: { summary: 'Morning routine reel', objective: 'Grow saves' },
  dueAt: new Date('2026-10-01T00:00:00Z'),
  noDeadline: false,
  blocked: false,
  paused: false,
  blockedTasks: 0,
};

describe('content state table (§10.1)', () => {
  it('manual transitions are a subset of the full table', () => {
    fc.assert(
      fc.property(stage, stage, (from, to) => {
        if (isManualTransition(from, to)) expect(canTransition(CONTENT_TRANSITIONS, from, to)).toBe(true);
      }),
    );
  });

  it('Approved and Review can never be reached by a manual move (no bypass of review)', () => {
    fc.assert(
      fc.property(stage, (from) => {
        expect(isManualTransition(from, 'approved')).toBe(false);
        expect(isManualTransition(from, 'review')).toBe(false);
        if (from !== 'approved') expect(manualMoveExplanation(from, 'approved')).toMatch(/Review/);
      }),
    );
  });

  it('archived is terminal except through Restore', () => {
    expect(CONTENT_TRANSITIONS.archived).toEqual([]);
    expect(MANUAL_TRANSITIONS.archived).toEqual([]);
  });

  it('every non-archived stage can be archived', () => {
    for (const s of CONTENT_STAGES.filter((x) => x !== 'archived')) expect(CONTENT_TRANSITIONS[s as ContentStage]).toContain('archived');
  });
});

describe('transition requirements', () => {
  it('Brief → Ready needs summary, owner, reviewer, objective and a due date or No Deadline', () => {
    expect(transitionRequirements('ready', ready)).toEqual([]);
    const missing = transitionRequirements('ready', { ...ready, ownerMembershipId: null, reviewerMembershipId: null, brief: {}, dueAt: null });
    expect(missing.map((m) => m.field).sort()).toEqual(['brief.objective', 'brief.summary', 'dueAt', 'ownerMembershipId', 'reviewerMembershipId']);
    expect(transitionRequirements('ready', { ...ready, dueAt: null, noDeadline: true })).toEqual([]);
  });

  it('Idea → Brief needs an active project', () => {
    expect(transitionRequirements('brief', { ...ready, projectStatus: 'draft' })[0]?.code).toBe('PROJECT_NOT_ACTIVE');
    expect(transitionRequirements('brief', ready)).toEqual([]);
  });

  it('Production needs an owner and no blocking dependencies', () => {
    const m = transitionRequirements('production', { ...ready, ownerMembershipId: null, blocked: true, blockedTasks: 2 });
    expect(m.map((x) => x.code)).toEqual(['REQUIRED', 'BLOCKED', 'BLOCKED_TASKS']);
    expect(m[0]?.message).toBe('Assign an owner before starting this work.');
  });
});

describe('deliverables and submission', () => {
  it('every format has at least one slot and a checklist', () => {
    for (const f of CONTENT_FORMATS) {
      expect(deliverableSlotsFor(f).length).toBeGreaterThan(0);
      expect(checklistFor(f).length).toBeGreaterThan(0);
    }
  });

  it('template slots replace the defaults', () => {
    expect(deliverableSlotsFor('short_video', [{ slot: 'cover', required: true }])).toEqual([{ slot: 'cover', required: true }]);
  });

  it('a processing file blocks submission until it is available (T038)', () => {
    const slots = deliverableSlotsFor('short_video');
    const checklist = checklistFor('short_video').map((c) => ({ ...c, done: true }));
    const processing = submitRequirements({ format: 'short_video', slots, checklist, files: [{ slot: 'main_video', status: 'processing' }] });
    expect(processing.map((m) => m.code)).toEqual(['FILE_NOT_AVAILABLE']);
    expect(submitRequirements({ format: 'short_video', slots, checklist, files: [{ slot: 'main_video', status: 'available' }] })).toEqual([]);
  });

  it('missing required slots, files not yet Available (uploading, checking, processing) or rejected and open mandatory items all block submission (T038)', () => {
    const fx = fc.record({ status: fc.constantFrom('uploading', 'checking', 'processing', 'available', 'rejected', 'failed') });
    fc.assert(
      fc.property(fc.array(fx, { maxLength: 5 }), fc.boolean(), (files, done) => {
        const slots = deliverableSlotsFor('image');
        const attached = files.map((f) => ({ slot: 'main_image' as const, status: f.status }));
        const checklist = checklistFor('image').map((c) => ({ ...c, done }));
        const m = submitRequirements({ format: 'image', slots, checklist, files: attached });
        const ok = attached.length > 0 && attached.every((a) => a.status === 'available') && done;
        expect(m.length === 0).toBe(ok);
      }),
    );
  });

  it('a text post may be submitted with the caption draft only', () => {
    const slots = deliverableSlotsFor('text_post');
    const checklist = checklistFor('text_post').map((c) => ({ ...c, done: true }));
    expect(submitRequirements({ format: 'text_post', slots, checklist, files: [], captionDraft: 'Hello' })).toEqual([]);
    expect(submitRequirements({ format: 'text_post', slots, checklist, files: [] })[0]?.code).toBe('EMPTY_VERSION');
  });
});

describe('review policy', () => {
  it('always has at least the release approval step, content quality first when enabled', () => {
    expect(reviewSteps({ contentQualityStep: false, releaseApprovalStep: true })).toEqual(['release_approval']);
    expect(reviewSteps({ contentQualityStep: true, releaseApprovalStep: true })).toEqual(['content_quality', 'release_approval']);
    expect(reviewSteps({ contentQualityStep: false, releaseApprovalStep: false })).toEqual(['release_approval']);
  });

  it('policy version is stable and changes when the policy changes', () => {
    const a = reviewPolicyVersion({ contentQualityStep: false, releaseApprovalStep: true, allowSelfReview: false, eligibleReviewerMembershipIds: ['b', 'a'] });
    const b = reviewPolicyVersion({ contentQualityStep: false, releaseApprovalStep: true, allowSelfReview: false, eligibleReviewerMembershipIds: ['a', 'b'] });
    expect(a).toBe(b);
    expect(reviewPolicyVersion({ contentQualityStep: false, releaseApprovalStep: true, allowSelfReview: true })).not.toBe(a);
  });

  it('self-review is forbidden unless explicitly excepted (T039)', () => {
    const base = { actorMembershipId: 'm', authorMembershipId: 'm', policyAllowsSelfReview: false, actorIsOwner: false, exceptionRequested: true };
    expect(selfReviewOutcome({ ...base, authorMembershipId: 'x' })).toBe('not_self');
    expect(selfReviewOutcome(base)).toBe('forbidden');
    expect(selfReviewOutcome({ ...base, actorIsOwner: true })).toBe('owner_exception');
    expect(selfReviewOutcome({ ...base, actorIsOwner: true, exceptionRequested: false })).toBe('forbidden');
    expect(selfReviewOutcome({ ...base, policyAllowsSelfReview: true })).toBe('allowed_by_policy');
  });
});

describe('annotations', () => {
  it('timecodes must lie within the duration (T045)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 3_600_000 }), fc.integer({ min: -10, max: 4_000_000 }), (duration, t) => {
        const errs = annotationErrors({ kind: 'video', durationMs: duration }, { timecodeMs: t });
        expect(errs.length === 0).toBe(t >= 0 && t <= duration);
      }),
    );
  });

  it('unknown duration and non-timed files refuse a timecode (T045)', () => {
    expect(annotationErrors({ kind: 'video', durationMs: null }, { timecodeMs: 10 })[0]?.code).toBe('DURATION_UNKNOWN');
    expect(annotationErrors({ kind: 'image', durationMs: null }, { timecodeMs: 10 })[0]?.code).toBe('NOT_TIMED');
  });

  it('points are normalised 0–1 and only on images', () => {
    expect(annotationErrors({ kind: 'image', durationMs: null }, { pointX: '0.5', pointY: '1' })).toEqual([]);
    expect(annotationErrors({ kind: 'image', durationMs: null }, { pointX: '1.2', pointY: '0.1' })[0]?.code).toBe('OUT_OF_RANGE');
    expect(annotationErrors({ kind: 'video', durationMs: 1000 }, { pointX: '0.2', pointY: '0.1' })[0]?.code).toBe('NOT_IMAGE');
    expect(annotationErrors(null, { pointX: '0.2', pointY: '0.1' })[0]?.code).toBe('REQUIRED');
  });

  it('formats timecodes', () => {
    expect(formatTimecode(0)).toBe('0:00');
    expect(formatTimecode(61_000)).toBe('1:01');
    expect(formatTimecode(3_661_000)).toBe('1:01:01');
  });
});

describe('deadlines', () => {
  const now = new Date('2026-10-01T12:00:00Z');
  it('no deadline is never overdue; approved content is not overdue', () => {
    expect(isContentOverdue(null, 'production', now)).toBe(false);
    expect(isContentOverdue(new Date('2026-09-30T00:00:00Z'), 'production', now)).toBe(true);
    expect(isContentOverdue(new Date('2026-09-30T00:00:00Z'), 'approved', now)).toBe(false);
  });
  it('waiting hours are never negative', () => {
    fc.assert(
      fc.property(fc.integer({ min: -1e9, max: 1e9 }), (d) => {
        expect(waitingHours(new Date(now.getTime() + d), now)).toBeGreaterThanOrEqual(0);
      }),
    );
  });
});
