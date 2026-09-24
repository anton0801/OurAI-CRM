'use client';
import { useEffect, useMemo, useState } from 'react';
import { publicationEndpoints as P, type PublicationRow } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { PUBLICATION_AVAILABILITY } from '@castlane/domain';
import { Banner, Button, Checkbox, DateTimeInput, Dialog, Field, Input, Select, Textarea, formatDateTime } from '@castlane/ui';
import { ConflictDialog } from '@/components/common/conflict';
import { useDebounced } from '@/components/common/use-debounced';
import { useApiMutation, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useWorkspace } from '@/lib/workspace-context';
import { fromLocalInput, timezones, toLocalInput } from '@/features/tasks/format';
import { gateDetails } from './format';
import { PUBLICATION_INVALIDATE, SCHEDULED_NOTE } from './labels';

/** The fields of a placement the dialogs need (list rows and details both have them). */
export type PublicationLike = Pick<PublicationRow, 'id' | 'rowVersion' | 'status' | 'title' | 'scheduledAt' | 'scheduleTimezone' | 'actualPublishedAt' | 'externalPostUrl' | 'contentItemId' | 'contentVersion' | 'account'> & {
  caption?: string | null;
  noUrlReason?: string | null;
  availability?: PublicationRow['availability'];
};

type FieldErrors = Record<string, string>;
const fieldErrorsOf = (e: unknown): FieldErrors => (isApiError(e) ? Object.fromEntries(e.fieldErrors.map((f) => [f.field.replace(/^body\./, '').replace(/^changes\./, ''), f.message])) : {});

export const TimezoneSelect = ({ value, onChange, id }: { value: string; onChange: (v: string) => void; id?: string }) => {
  const options = useMemo(() => timezones().map((z) => ({ value: z, label: z })), []);
  return <Select id={id} value={value} onChange={(v) => onChange(v ?? value)} options={options} searchable aria-label="Time zone" />;
};

// ——— Schedule / Reschedule / Retry Planning ———

export const ScheduleDialog = ({
  publication: p,
  open,
  onOpenChange,
  initialAt,
  onDone,
}: {
  publication: PublicationLike;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Pre-filled moment (e.g. the day a calendar event was dropped on). */
  initialAt?: string | null;
  onDone?: () => void;
}) => {
  const { workspace, user } = useWorkspace();
  const [tz, setTz] = useState(p.scheduleTimezone ?? user.timezone);
  const [local, setLocal] = useState('');
  const [versionId, setVersionId] = useState<string | null>(p.contentVersion?.approved ? p.contentVersion.id : null);
  const [reason, setReason] = useState('');
  const [overrideReason, setOverrideReason] = useState('');
  const [conflictReason, setConflictReason] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const rescheduling = p.status === 'scheduled';
  useEffect(() => {
    if (!open) return;
    const zone = p.scheduleTimezone ?? user.timezone;
    setTz(zone);
    setLocal(toLocalInput(initialAt ?? p.scheduledAt, zone));
    setVersionId(p.contentVersion?.approved ? p.contentVersion.id : null);
    setReason('');
    setOverrideReason('');
    setConflictReason('');
    setErrors({});
    setError(null);
  }, [open, p.id, p.rowVersion, initialAt]); // eslint-disable-line react-hooks/exhaustive-deps
  const utc = local ? fromLocalInput(local, tz) : null;
  const debounced = useDebounced(utc, 300);
  const versions = useApiQuery(P.contentVersions, { params: { workspaceId: workspace.id }, query: { contentItemId: p.contentItemId, accountId: p.account.id } }, { enabled: open });
  const preview = useApiQuery(
    P.schedulePreview,
    { params: { workspaceId: workspace.id, publicationId: p.id }, query: { scheduledAt: debounced ?? '', timezone: tz, contentVersionId: versionId ?? undefined } },
    { enabled: open && !!debounced },
  );
  const schedule = useApiMutation(P.schedule, { invalidate: PUBLICATION_INVALIDATE, silentErrors: true, successMessage: rescheduling ? 'Publication moved' : 'Publication scheduled' });
  const pv = preview.data;
  const title = rescheduling ? 'Reschedule publication' : p.status === 'failed' ? 'Retry planning' : 'Schedule publication';

  const submit = async () => {
    setErrors({});
    setError(null);
    if (!utc) {
      setErrors({ scheduledAt: 'Choose the date and time to publish.' });
      return;
    }
    try {
      await schedule.run(
        {
          params: { workspaceId: workspace.id, publicationId: p.id },
          body: {
            scheduledAt: utc,
            timezone: tz,
            contentVersionId: versionId ?? undefined,
            reason: reason.trim() || undefined,
            accountOverrideReason: overrideReason.trim() || undefined,
            conflictOverrideReason: conflictReason.trim() || undefined,
          },
        },
        { ifMatch: p.rowVersion },
      );
      onOpenChange(false);
      onDone?.();
    } catch (e) {
      if (isApiError(e) && e.code === 'VERSION_CONFLICT') setConflict(true);
      else {
        setErrors(fieldErrorsOf(e));
        const g = gateDetails(e);
        setError(g?.blockers?.[0]?.message ?? (isApiError(e) ? e.message : 'The publication could not be scheduled.'));
      }
    }
  };

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
        title={title}
        description={`${p.title} on ${p.account.label}`}
        dirty={!!(reason || overrideReason || conflictReason)}
        footer={
          <>
            <Button onClick={() => onOpenChange(false)} disabled={schedule.isPending}>
              Cancel
            </Button>
            <Button variant="primary" loading={schedule.isPending} onClick={() => void submit()} disabled={!!pv && pv.blockers.length > 0}>
              {rescheduling ? 'Reschedule' : 'Schedule'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <p className="text-[13px] text-fg-2">{SCHEDULED_NOTE}</p>
          {error ? <Banner tone="danger">{error}</Banner> : null}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Scheduled at" required error={errors.scheduledAt}>
              <DateTimeInput value={local} onChange={(e) => setLocal(e.target.value)} timezone={tz} />
            </Field>
            <Field label="Time zone" required>
              <TimezoneSelect value={tz} onChange={setTz} />
            </Field>
          </div>
          <Field label="Approved version" required error={errors.contentVersionId} helper="Only an approved, not revoked version can be scheduled.">
            <Select
              value={versionId}
              onChange={setVersionId}
              placeholder={versions.isLoading ? 'Loading…' : 'Choose a version'}
              options={(versions.data ?? []).map((v) => ({
                value: v.id,
                label: `Version ${v.versionNo}${v.approved ? ' · Approved' : v.approvalRevokedAt ? ' · Approval revoked' : ' · Not approved'}`,
                description: v.note ?? undefined,
                disabled: !v.approved,
              }))}
            />
          </Field>
          {pv ? (
            <div className="flex flex-col gap-2" aria-live="polite">
              <p className="text-[13px] text-fg">
                Publishes <strong>{pv.localTime}</strong> ({pv.timezone})
                {tz !== user.timezone && utc ? <span className="text-fg-2"> · {formatDateTime(utc, user.timezone)} in your zone ({user.timezone})</span> : null}
              </p>
              {pv.blockers.map((b) => (
                <Banner key={b.code} tone="danger">
                  {b.message}
                </Banner>
              ))}
              {pv.overridable.map((b) => (
                <Banner key={b.code} tone="warning">
                  {b.message} {pv.canOverride ? 'You can override with a reason; check manually that the platform accepts the post.' : 'Only a lead can override this.'}
                </Banner>
              ))}
              {pv.conflicts.length ? (
                <Banner tone="warning">
                  Another placement on this account is within 15 minutes:{' '}
                  {pv.conflicts.map((c) => `${c.title} (${formatDateTime(c.scheduledAt, user.timezone)})`).join(', ')}.
                </Banner>
              ) : null}
              {pv.baselines.map((b) => (
                <Banner key={b.weekStart} tone="info">
                  {b.effect === 'kept_in_original_week'
                    ? `The frozen plan of the week of ${b.weekStart} keeps this placement at its original time.`
                    : `The plan of the week of ${b.weekStart} is frozen; this placement is added after the baseline.`}
                </Banner>
              ))}
            </div>
          ) : preview.isFetching ? (
            <p className="text-[13px] text-fg-2" role="status">
              Checking the plan…
            </p>
          ) : null}
          {pv && pv.overridable.length && pv.canOverride ? (
            <Field label="Override reason" required error={errors.accountOverrideReason}>
              <Textarea value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} rows={2} maxLength={2000} />
            </Field>
          ) : null}
          {pv && pv.conflicts.length ? (
            <Field label="Reason to keep both placements" required error={errors.conflictOverrideReason}>
              <Textarea value={conflictReason} onChange={(e) => setConflictReason(e.target.value)} rows={2} maxLength={2000} />
            </Field>
          ) : null}
          {rescheduling ? (
            <Field label="Reason for the move" required error={errors.reason} helper="Recorded as a plan revision; the first promised time stays in the history.">
              <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={2000} />
            </Field>
          ) : null}
        </div>
      </Dialog>
      <ConflictDialog open={conflict} onOpenChange={setConflict} onReload={() => window.location.reload()} />
    </>
  );
};

// ——— Mark Published ———

export const MarkPublishedDialog = ({ publication: p, open, onOpenChange, onDone }: { publication: PublicationLike; open: boolean; onOpenChange: (o: boolean) => void; onDone?: () => void }) => {
  const { workspace, user } = useWorkspace();
  const [local, setLocal] = useState('');
  const [url, setUrl] = useState('');
  const [noUrl, setNoUrl] = useState(false);
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  useEffect(() => {
    if (!open) return;
    setLocal(toLocalInput(new Date().toISOString(), user.timezone));
    setUrl('');
    setNoUrl(false);
    setReason('');
    setErrors({});
    setError(null);
  }, [open, p.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const mark = useApiMutation(P.markPublished, { invalidate: PUBLICATION_INVALIDATE, silentErrors: true, successMessage: 'Publication confirmed. Metric checkpoints were created.' });
  const submit = async () => {
    setErrors({});
    setError(null);
    const at = local ? fromLocalInput(local, user.timezone) : null;
    const next: FieldErrors = {};
    if (!at) next.actualPublishedAt = 'Enter when the post went live.';
    if (!noUrl && !url.trim()) next.externalUrl = 'Enter the https link of the published post.';
    if (noUrl && (reason.trim().length < 10 || reason.trim().length > 500)) next.noUrlReason = 'Explain in 10–500 characters why the URL is missing.';
    if (Object.keys(next).length) {
      setErrors(next);
      return;
    }
    try {
      await mark.run(
        { params: { workspaceId: workspace.id, publicationId: p.id }, body: { actualPublishedAt: at!, ...(noUrl ? { noUrlReason: reason.trim() } : { externalUrl: url.trim() }) } },
        { ifMatch: p.rowVersion },
      );
      onOpenChange(false);
      onDone?.();
    } catch (e) {
      if (isApiError(e) && e.code === 'VERSION_CONFLICT') setConflict(true);
      else {
        setErrors(fieldErrorsOf(e));
        setError(isApiError(e) ? e.message : 'The publication could not be confirmed.');
      }
    }
  };
  return (
    <>
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
        title="Mark Published"
        description={`${p.title} on ${p.account.label}`}
        dirty={!!(url || reason)}
        footer={
          <>
            <Button onClick={() => onOpenChange(false)} disabled={mark.isPending}>
              Cancel
            </Button>
            <Button variant="primary" loading={mark.isPending} onClick={() => void submit()}>
              Mark Published
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <p className="text-[13px] text-fg-2">
            Confirm a post you published on the platform. Castlane stores the link as entered and never opens or checks it. The 24h and 7d metric checkpoints start from the actual time.
          </p>
          {error ? <Banner tone="danger">{error}</Banner> : null}
          <Field label="Actual published at" required error={errors.actualPublishedAt}>
            <DateTimeInput value={local} onChange={(e) => setLocal(e.target.value)} timezone={user.timezone} />
          </Field>
          <Checkbox checked={noUrl} onCheckedChange={setNoUrl} label="The post has no permanent URL" />
          {noUrl ? (
            <Field label="Why is the URL missing?" required error={errors.noUrlReason} helper="10–500 characters. The publication gets a URL Missing badge and a follow-up task.">
              <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={500} />
            </Field>
          ) : (
            <Field label="External post URL" required error={errors.externalUrl} helper="https only; each post URL can be recorded once in the workspace.">
              <Input value={url} onChange={(e) => setUrl(e.target.value)} inputMode="url" placeholder="https://" maxLength={2048} />
            </Field>
          )}
        </div>
      </Dialog>
      <ConflictDialog open={conflict} onOpenChange={setConflict} onReload={() => window.location.reload()} />
    </>
  );
};

// ——— Fail / Cancel ———

export const ReasonDialog = ({
  publication: p,
  kind,
  open,
  onOpenChange,
  onDone,
}: {
  publication: PublicationLike;
  kind: 'fail' | 'cancel';
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onDone?: () => void;
}) => {
  const { workspace } = useWorkspace();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  useEffect(() => {
    if (open) {
      setReason('');
      setError(null);
    }
  }, [open]);
  const fail = useApiMutation(P.fail, { invalidate: PUBLICATION_INVALIDATE, silentErrors: true, successMessage: 'Publication marked Failed' });
  const cancel = useApiMutation(P.cancel, { invalidate: PUBLICATION_INVALIDATE, silentErrors: true, successMessage: 'Publication cancelled' });
  const m = kind === 'fail' ? fail : cancel;
  const submit = async () => {
    if (reason.trim().length < 3) {
      setError('Give a reason (at least 3 characters).');
      return;
    }
    try {
      await m.run({ params: { workspaceId: workspace.id, publicationId: p.id }, body: { reason: reason.trim() } }, { ifMatch: p.rowVersion });
      onOpenChange(false);
      onDone?.();
    } catch (e) {
      if (isApiError(e) && e.code === 'VERSION_CONFLICT') setConflict(true);
      else setError(isApiError(e) ? e.message : 'The change could not be saved.');
    }
  };
  return (
    <>
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
        size="small"
        title={kind === 'fail' ? 'Mark Failed' : 'Cancel publication'}
        description={p.title}
        dirty={!!reason}
        footer={
          <>
            <Button onClick={() => onOpenChange(false)} disabled={m.isPending}>
              Keep
            </Button>
            <Button variant="danger" loading={m.isPending} onClick={() => void submit()}>
              {kind === 'fail' ? 'Mark Failed' : 'Cancel Publication'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-[13px] text-fg-2">
            {kind === 'fail'
              ? 'Record that the post could not be published. No statistics are created; you can plan it again later with Retry Planning.'
              : 'The placement will not be published. A frozen weekly plan keeps it with this reason.'}
          </p>
          <Field label="Reason" required error={error ?? undefined}>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={2000} />
          </Field>
        </div>
      </Dialog>
      <ConflictDialog open={conflict} onOpenChange={setConflict} onReload={() => window.location.reload()} />
    </>
  );
};

// ——— Correct Publication ———

export const CorrectDialog = ({ publication: p, open, onOpenChange, onDone, initialAt }: { publication: PublicationLike; open: boolean; onOpenChange: (o: boolean) => void; onDone?: () => void; initialAt?: string | null }) => {
  const { workspace, user } = useWorkspace();
  const [local, setLocal] = useState('');
  const [url, setUrl] = useState('');
  const [removeUrl, setRemoveUrl] = useState(false);
  const [noUrlReason, setNoUrlReason] = useState('');
  const [caption, setCaption] = useState('');
  const [recalc, setRecalc] = useState(true);
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  useEffect(() => {
    if (!open) return;
    setLocal(toLocalInput(initialAt ?? p.actualPublishedAt, user.timezone));
    setUrl(p.externalPostUrl ?? '');
    setRemoveUrl(false);
    setNoUrlReason(p.noUrlReason ?? '');
    setCaption(p.caption ?? '');
    setRecalc(true);
    setReason('');
    setErrors({});
    setError(null);
  }, [open, p.id, p.rowVersion, initialAt]); // eslint-disable-line react-hooks/exhaustive-deps
  const correct = useApiMutation(P.correct, { invalidate: PUBLICATION_INVALIDATE, silentErrors: true, successMessage: 'Correction recorded' });
  const submit = async () => {
    setErrors({});
    setError(null);
    const changes: Record<string, unknown> = {};
    const at = local ? fromLocalInput(local, user.timezone) : null;
    if (at && at !== p.actualPublishedAt) changes.actualPublishedAt = at;
    if (removeUrl) Object.assign(changes, { externalUrl: null, noUrlReason: noUrlReason.trim() });
    else if (url.trim() && url.trim() !== p.externalPostUrl) changes.externalUrl = url.trim();
    else if (!p.externalPostUrl && noUrlReason.trim() !== (p.noUrlReason ?? '')) changes.noUrlReason = noUrlReason.trim();
    if (caption !== (p.caption ?? '')) changes.caption = caption || null;
    if (!Object.keys(changes).length) {
      setError('Change at least one value.');
      return;
    }
    if (reason.trim().length < 3) {
      setErrors({ reason: 'Give a reason for the correction.' });
      return;
    }
    try {
      await correct.run(
        { params: { workspaceId: workspace.id, publicationId: p.id }, body: { changes: changes as never, reason: reason.trim(), recalculateCheckpoints: recalc } },
        { ifMatch: p.rowVersion },
      );
      onOpenChange(false);
      onDone?.();
    } catch (e) {
      if (isApiError(e) && e.code === 'VERSION_CONFLICT') setConflict(true);
      else {
        setErrors(fieldErrorsOf(e));
        setError(isApiError(e) ? e.message : 'The correction could not be saved.');
      }
    }
  };
  return (
    <>
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
        title="Correct Publication"
        description="Historical facts change only with a reason; the previous values stay in the history."
        dirty={!!reason}
        footer={
          <>
            <Button onClick={() => onOpenChange(false)} disabled={correct.isPending}>
              Cancel
            </Button>
            <Button variant="primary" loading={correct.isPending} onClick={() => void submit()}>
              Save Correction
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {error ? <Banner tone="danger">{error}</Banner> : null}
          <Field label="Actual published at" error={errors.actualPublishedAt}>
            <DateTimeInput value={local} onChange={(e) => setLocal(e.target.value)} timezone={user.timezone} />
          </Field>
          <Checkbox checked={recalc} onCheckedChange={setRecalc} label="Move pending metric checkpoints to the corrected time" description="Completed observations keep their real observation time." />
          {p.externalPostUrl ? <Checkbox checked={removeUrl} onCheckedChange={setRemoveUrl} label="The recorded URL is wrong and no URL exists" /> : null}
          {!removeUrl ? (
            <Field label="External post URL" error={errors.externalUrl}>
              <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" maxLength={2048} />
            </Field>
          ) : null}
          {removeUrl || !p.externalPostUrl ? (
            <Field label="Why is the URL missing?" error={errors.noUrlReason} helper="10–500 characters.">
              <Textarea value={noUrlReason} onChange={(e) => setNoUrlReason(e.target.value)} rows={2} maxLength={500} />
            </Field>
          ) : null}
          <Field label="Caption as published" error={errors.caption}>
            <Textarea value={caption} onChange={(e) => setCaption(e.target.value)} rows={3} />
          </Field>
          <Field label="Reason for the correction" required error={errors.reason}>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={2000} />
          </Field>
        </div>
      </Dialog>
      <ConflictDialog open={conflict} onOpenChange={setConflict} onReload={() => window.location.reload()} />
    </>
  );
};

// ——— Availability (removed / unavailable) ———

export const AvailabilityDialog = ({ publication: p, open, onOpenChange }: { publication: PublicationLike; open: boolean; onOpenChange: (o: boolean) => void }) => {
  const { workspace, user } = useWorkspace();
  const [value, setValue] = useState<(typeof PUBLICATION_AVAILABILITY)[number]>('removed');
  const [local, setLocal] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setValue(p.availability === 'available' ? 'removed' : 'available');
    setLocal(toLocalInput(new Date().toISOString(), user.timezone));
    setReason('');
    setError(null);
  }, [open, p.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const m = useApiMutation(P.setAvailability, { invalidate: PUBLICATION_INVALIDATE, silentErrors: true, successMessage: 'Availability recorded' });
  const submit = async () => {
    if (reason.trim().length < 3) {
      setError('Give a reason (at least 3 characters).');
      return;
    }
    try {
      await m.run(
        { params: { workspaceId: workspace.id, publicationId: p.id }, body: { availability: value, effectiveAt: local ? (fromLocalInput(local, user.timezone) ?? undefined) : undefined, reason: reason.trim() } },
        { ifMatch: p.rowVersion },
      );
      onOpenChange(false);
    } catch (e) {
      setError(isApiError(e) ? (e.fieldErrors[0]?.message ?? e.message) : 'The change could not be saved.');
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="small"
      title="Post availability"
      description="The publication stays Published; confirmed facts and recorded metrics are kept."
      dirty={!!reason}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)} disabled={m.isPending}>
            Cancel
          </Button>
          <Button variant="primary" loading={m.isPending} onClick={() => void submit()}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Availability" required>
          <Select value={value} onChange={(v) => v && setValue(v)} options={PUBLICATION_AVAILABILITY.map((a) => ({ value: a, label: label('publicationAvailability', a), disabled: a === p.availability }))} />
        </Field>
        <Field label="Since">
          <DateTimeInput value={local} onChange={(e) => setLocal(e.target.value)} timezone={user.timezone} />
        </Field>
        <Field label="Reason" required error={error ?? undefined}>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={2000} />
        </Field>
      </div>
    </Dialog>
  );
};
