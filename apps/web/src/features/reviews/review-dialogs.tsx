'use client';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { reviewEndpoints, type ReviewStudioDetail } from '@castlane/api-contracts';
import { isApiError, type ApiError } from '@castlane/api-client';
import { LIMITS } from '@castlane/domain';
import { Banner, Button, Checkbox, Dialog, Field, Textarea, toast } from '@castlane/ui';
import { MemberSelect } from '@/components/common/pickers';
import { useApiMutation } from '@/lib/hooks';
import { useWorkspace } from '@/lib/workspace-context';

/** What a decision dialog needs to know about the review (from the queue row or the studio). */
export interface ReviewTarget {
  id: string;
  rowVersion: number;
  versionId: string;
  versionNo: number;
  title: string;
  projectId: string;
  reviewerMembershipId?: string | null;
}

export const REVIEW_INVALIDATE = [
  'reviews.',
  'content.',
  'comments.',
  'myWork.',
  'overview.',
  'publications.',
];

/**
 * Stale review (412) and already-decided / superseded (409) are explained in place: the member
 * reloads and decides on the current state — never on a version they have not seen (T041/T042).
 */
export const decisionError = (e: unknown): string => {
  if (!isApiError(e)) return 'The decision was not saved. Try again.';
  const err = e as ApiError;
  if (err.code === 'VERSION_CONFLICT' || err.status === 412)
    return 'This review changed while you were deciding (another decision, a new reviewer or a newer version). Reload the review and check it again.';
  if (err.code === 'PRECONDITION_REQUIRED' || err.status === 428) return 'Reload the review before deciding.';
  return err.fieldErrors[0]?.message ?? err.message;
};

/** A decided or superseded review (409) refreshes the studio/queue behind the dialog. */
const useRefreshOnConflict = () => {
  const qc = useQueryClient();
  return (e: unknown) => {
    if (isApiError(e) && e.status === 409)
      void qc.invalidateQueries({
        predicate: (q) => REVIEW_INVALIDATE.some((p) => String(q.queryKey[0] ?? '').startsWith(p)),
      });
  };
};

const useResetOnOpen = (open: boolean, reset: () => void) => {
  useEffect(() => {
    if (open) reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
};

/** Approve Version: the exact version under review; the self-review exception needs its own reason and is audited (T039). */
export const ApproveDialog = ({
  open,
  onOpenChange,
  review,
  selfReview,
  exceptionAvailable,
  nextStepLabel,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  review: ReviewTarget;
  selfReview: boolean;
  exceptionAvailable: boolean;
  nextStepLabel?: string | null;
  onDone: (r: ReviewStudioDetail) => void;
}) => {
  const { workspace } = useWorkspace();
  const refreshOnConflict = useRefreshOnConflict();
  const [note, setNote] = useState('');
  const [exception, setException] = useState(false);
  const [exceptionReason, setExceptionReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const approve = useApiMutation(reviewEndpoints.approve, {
    invalidate: REVIEW_INVALIDATE,
    silentErrors: true,
  });
  useResetOnOpen(open, () => {
    setNote('');
    setException(false);
    setExceptionReason('');
    setError(null);
  });
  const needsException = selfReview;
  const canSubmit = !needsException || (exception && exceptionReason.trim().length >= LIMITS.reasonMin);
  const submit = async () => {
    setError(null);
    try {
      const r = await approve.run(
        {
          params: { workspaceId: workspace.id, reviewId: review.id },
          body: {
            versionId: review.versionId,
            ...(note.trim() ? { decisionNote: note.trim() } : {}),
            ...(needsException ? { selfReviewException: { reason: exceptionReason.trim() } } : {}),
          },
        },
        { ifMatch: review.rowVersion },
      );
      toast.success(
        nextStepLabel
          ? `Version ${review.versionNo} passed this step. ${nextStepLabel} is next.`
          : `Version ${review.versionNo} approved`,
      );
      onOpenChange(false);
      onDone(r);
    } catch (e) {
      setError(decisionError(e));
      refreshOnConflict(e);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="small"
      title={`Approve version ${review.versionNo}?`}
      description={
        nextStepLabel
          ? `This completes the current review step for version ${review.versionNo}. ${nextStepLabel} opens next.`
          : `Approval pins version ${review.versionNo} of “${review.title}” for publications. A newer version would need its own review.`
      }
      dirty={note.trim().length > 0 || exceptionReason.trim().length > 0}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            loading={approve.isPending}
            disabled={!canSubmit}
            onClick={() => void submit()}
          >
            Approve Version {review.versionNo}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        {needsException ? (
          exceptionAvailable ? (
            <div className="flex flex-col gap-3 rounded-[12px] border border-line bg-surface-2 p-3">
              <p className="text-[13px] text-fg-2">
                You submitted this version. Approving your own work is an exception: it is recorded in the
                audit log with your reason.
              </p>
              <Checkbox
                checked={exception}
                onCheckedChange={setException}
                label="Use a self-review exception"
              />
              {exception ? (
                <Field label="Reason for the exception" required>
                  <Textarea
                    value={exceptionReason}
                    onChange={(e) => setExceptionReason(e.target.value)}
                    maxLength={LIMITS.reasonMax}
                  />
                </Field>
              ) : null}
            </div>
          ) : (
            <Banner tone="warning">
              You submitted this version and cannot approve it yourself. Ask an eligible reviewer.
            </Banner>
          )
        ) : null}
        <Field label="Decision note" helper="Optional. Shown in the review history.">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={LIMITS.reasonMax} />
        </Field>
      </div>
    </Dialog>
  );
};

/** Request Changes: Summary* plus a concrete comment on the version or an explanation (§10.3). */
export const RequestChangesDialog = ({
  open,
  onOpenChange,
  review,
  openComments,
  initialSummary,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  review: ReviewTarget;
  /** Open comments on the version; with none, an explanation is required. */
  openComments: number | null;
  initialSummary?: string;
  onDone?: (r: ReviewStudioDetail) => void;
}) => {
  const { workspace } = useWorkspace();
  const refreshOnConflict = useRefreshOnConflict();
  const [summary, setSummary] = useState('');
  const [explanation, setExplanation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const request = useApiMutation(reviewEndpoints.requestChanges, {
    invalidate: REVIEW_INVALIDATE,
    silentErrors: true,
  });
  useResetOnOpen(open, () => {
    setSummary(initialSummary ?? '');
    setExplanation('');
    setError(null);
  });
  const explanationRequired = !openComments;
  const valid =
    summary.trim().length >= LIMITS.reasonMin && (!explanationRequired || explanation.trim().length > 0);
  const submit = async () => {
    setError(null);
    try {
      const r = await request.run(
        {
          params: { workspaceId: workspace.id, reviewId: review.id },
          body: {
            versionId: review.versionId,
            summary: summary.trim(),
            ...(explanation.trim() ? { explanation: explanation.trim() } : {}),
          },
        },
        { ifMatch: review.rowVersion },
      );
      toast.success(`Changes requested on version ${review.versionNo}`);
      onOpenChange(false);
      onDone?.(r);
    } catch (e) {
      setError(decisionError(e));
      refreshOnConflict(e);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="small"
      title="Request Changes"
      description={`Version ${review.versionNo} of “${review.title}” goes back to production. The author sees your summary and comments.`}
      dirty={summary.trim() !== (initialSummary ?? '').trim() || explanation.trim().length > 0}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            loading={request.isPending}
            disabled={!valid}
            onClick={() => void submit()}
          >
            Request Changes
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <Field label="Summary" required>
          <Textarea
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            maxLength={LIMITS.reasonMax}
            className="min-h-[64px]"
          />
        </Field>
        <Field
          label="Explanation"
          required={explanationRequired}
          helper={
            explanationRequired
              ? 'There are no open comments on this version: explain what has to change. It is added as an issue comment.'
              : `${openComments} open comment${openComments === 1 ? '' : 's'} on this version will be shown with the request.`
          }
        >
          <Textarea
            value={explanation}
            onChange={(e) => setExplanation(e.target.value)}
            maxLength={LIMITS.noteMax}
          />
        </Field>
      </div>
    </Dialog>
  );
};

/** Revoke Approval: blocks new placements; published history stays, flagged, with a check task (T044). */
export const RevokeDialog = ({
  open,
  onOpenChange,
  review,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  review: ReviewTarget;
  onDone: (r: ReviewStudioDetail) => void;
}) => {
  const { workspace } = useWorkspace();
  const refreshOnConflict = useRefreshOnConflict();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const revoke = useApiMutation(reviewEndpoints.revoke, {
    invalidate: REVIEW_INVALIDATE,
    silentErrors: true,
  });
  useResetOnOpen(open, () => {
    setReason('');
    setError(null);
  });
  const submit = async () => {
    setError(null);
    try {
      const r = await revoke.run(
        { params: { workspaceId: workspace.id, reviewId: review.id }, body: { reason: reason.trim() } },
        { ifMatch: review.rowVersion },
      );
      toast.success(`Approval of version ${review.versionNo} revoked`);
      onOpenChange(false);
      onDone(r);
    } catch (e) {
      setError(decisionError(e));
      refreshOnConflict(e);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="small"
      title={`Revoke approval of version ${review.versionNo}?`}
      description="The version can no longer be scheduled. Scheduled publications get a task to replace or cancel them; published ones stay in history, flagged, with a check task."
      dirty={reason.trim().length > 0}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="danger"
            loading={revoke.isPending}
            disabled={reason.trim().length < LIMITS.reasonMin}
            onClick={() => void submit()}
          >
            Revoke Approval
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <Field label="Reason" required>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={LIMITS.reasonMax} />
        </Field>
      </div>
    </Dialog>
  );
};

/** Assign Reviewer: members with approval rights in the project (the server also rejects the author without policy). */
export const AssignReviewerDialog = ({
  open,
  onOpenChange,
  review,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  review: ReviewTarget;
  onDone?: (r: ReviewStudioDetail) => void;
}) => {
  const { workspace } = useWorkspace();
  const refreshOnConflict = useRefreshOnConflict();
  const [reviewer, setReviewer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const assign = useApiMutation(reviewEndpoints.assign, {
    invalidate: REVIEW_INVALIDATE,
    silentErrors: true,
  });
  useResetOnOpen(open, () => {
    setReviewer(review.reviewerMembershipId ?? null);
    setError(null);
  });
  const submit = async () => {
    if (!reviewer) return;
    setError(null);
    try {
      const r = await assign.run(
        {
          params: { workspaceId: workspace.id, reviewId: review.id },
          body: { reviewerMembershipId: reviewer },
        },
        { ifMatch: review.rowVersion },
      );
      toast.success(`Reviewer assigned: ${r.reviewer?.displayName ?? 'member'}`);
      onOpenChange(false);
      onDone?.(r);
    } catch (e) {
      setError(decisionError(e));
      refreshOnConflict(e);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="small"
      title="Assign Reviewer"
      description={`Who decides version ${review.versionNo} of “${review.title}”. Only members with approval rights in this project are listed.`}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            loading={assign.isPending}
            disabled={!reviewer || reviewer === review.reviewerMembershipId}
            onClick={() => void submit()}
          >
            Assign
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <Field label="Reviewer" required>
          <MemberSelect
            value={reviewer}
            onChange={setReviewer}
            projectId={review.projectId}
            permission="content.approve"
            placeholder="Choose a reviewer"
          />
        </Field>
      </div>
    </Dialog>
  );
};
