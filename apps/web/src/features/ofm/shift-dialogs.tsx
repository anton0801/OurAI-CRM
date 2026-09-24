'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { ofmEndpoints as E, type EndpointResponse, type OfmShiftSummary, type OfmSwapRequest } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { DateTime, SHIFT_LIMITS } from '@castlane/domain';
import {
  Badge,
  Banner,
  Button,
  Checkbox,
  DateInput,
  DateTimeInput,
  Dialog,
  Drawer,
  Field,
  Input,
  Panel,
  StatusBadge,
  Switch,
  Textarea,
  toast,
} from '@castlane/ui';
import { ConflictDialog } from '@/components/common/conflict';
import { changedFields, pickChanged, useEditBase } from '@/lib/edit-base';
import { MemberSelect } from '@/components/common/pickers';
import { useDebounced } from '@/components/common/use-debounced';
import { applyFieldErrors, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useWorkspace } from '@/lib/workspace-context';
import { MemberChip, ReasonDialog, errorMessage, fmtRange, fromLocalInput, runAction, toLocalInput, useOfmMutation } from './common';
import { OfmAccountMultiSelect, OfmAccountSelect, OfmModelSelect, TimeZoneSelect, projectOfAccount, useOfmModels } from './pickers';

type Issue = { code: string; message: string };

const IssueList = ({ title, issues, tone }: { title: string; issues: Issue[]; tone: 'danger' | 'warning' }) =>
  issues.length ? (
    <Banner tone={tone}>
      <p className="font-semibold">{title}</p>
      <ul className="mt-1 list-disc pl-5">
        {issues.map((i, n) => (
          <li key={`${i.code}-${n}`}>{i.message}</li>
        ))}
      </ul>
    </Banner>
  ) : null;

// ——— Schedule / edit shift ———

const shiftSchema = z
  .object({
    projectId: z.string(),
    membershipId: z.string().uuid('Choose a member.'),
    primaryAccountId: z.string().uuid('Choose the primary account.'),
    additionalAccountIds: z.array(z.string().uuid()).max(SHIFT_LIMITS.maxAccounts - 1, `At most ${SHIFT_LIMITS.maxAccounts - 1} additional accounts.`),
    start: z.string().min(1, 'Choose the start.'),
    end: z.string().min(1, 'Choose the end.'),
    timezone: z.string().min(1, 'Choose a time zone.'),
    supervisorMembershipId: z.string().optional(),
    parallelCoverage: z.boolean(),
  })
  .refine((v) => !v.start || !v.end || v.end > v.start, { path: ['end'], message: 'End must be after start.' });
type ShiftValues = z.infer<typeof shiftSchema>;

/**
 * Schedule (or edit) a shift: live dry-run validation shows member overlap, coverage lanes,
 * assignment intervals, leave and the DST preview before anything is saved.
 */
export const ScheduleShiftDrawer = ({
  shift,
  preset,
  onClose,
}: {
  shift?: OfmShiftSummary;
  preset?: { projectId?: string; accountId?: string; membershipId?: string };
  onClose: (created?: string) => void;
}) => {
  const { workspace } = useWorkspace();
  const models = useOfmModels();
  const zone = shift?.timezone ?? workspace.timezone;
  const form = useForm<ShiftValues>({
    resolver: zodResolver(shiftSchema),
    defaultValues: shift
      ? {
          projectId: shift.project.id,
          membershipId: shift.member.membershipId,
          primaryAccountId: shift.primaryAccount.id,
          additionalAccountIds: shift.accounts.filter((a) => !a.isPrimary).map((a) => a.account.id),
          start: toLocalInput(shift.scheduledStart, zone),
          end: toLocalInput(shift.scheduledEnd, zone),
          timezone: zone,
          supervisorMembershipId: shift.supervisor?.membershipId ?? '',
          parallelCoverage: shift.parallelCoverage,
        }
      : {
          projectId: preset?.projectId ?? '',
          membershipId: preset?.membershipId ?? '',
          primaryAccountId: preset?.accountId ?? '',
          additionalAccountIds: [],
          start: '',
          end: '',
          timezone: zone,
          supervisorMembershipId: '',
          parallelCoverage: false,
        },
  });
  const [error, setError] = useState<string | null>(null);
  // Edits apply to the shift as the drawer opened; only changed parts are sent (T162).
  const edit = useEditBase(shift);
  const create = useOfmMutation(E.createShift, { successMessage: 'Shift scheduled', also: ['myWork.', 'calendar.'] });
  const update = useOfmMutation(E.updateShift, { successMessage: 'Shift updated', also: ['myWork.', 'calendar.'] });
  const v = form.watch();
  useEffect(() => {
    if (v.primaryAccountId && !v.projectId) form.setValue('projectId', projectOfAccount(models.data, v.primaryAccountId) ?? '');
  }, [v.primaryAccountId, v.projectId, models.data, form]);

  const body = useMemo(() => {
    const start = fromLocalInput(v.start, v.timezone);
    const end = fromLocalInput(v.end, v.timezone);
    if (!v.membershipId || !v.primaryAccountId || !start || !end || end <= start) return null;
    return {
      membershipId: v.membershipId,
      primaryAccountId: v.primaryAccountId,
      additionalAccountIds: v.additionalAccountIds,
      scheduledStart: start,
      scheduledEnd: end,
      timezone: v.timezone,
      supervisorMembershipId: v.supervisorMembershipId || null,
      parallelCoverage: v.parallelCoverage,
    };
  }, [v.membershipId, v.primaryAccountId, v.additionalAccountIds, v.start, v.end, v.timezone, v.supervisorMembershipId, v.parallelCoverage]);
  const debounced = useDebounced(body, 400);
  const validation = useApiQuery(
    E.validateShift,
    { params: { workspaceId: workspace.id }, body: { ...(debounced ?? ({} as NonNullable<typeof debounced>)), shiftId: shift?.id } },
    { enabled: !!debounced, staleTime: 5_000 },
  );

  const submit = form.handleSubmit(async () => {
    setError(null);
    if (!body) return;
    try {
      if (shift) {
        const s = edit.start ?? shift;
        const sz = s.timezone ?? workspace.timezone;
        const before = {
          membershipId: s.member.membershipId,
          primaryAccountId: s.primaryAccount.id,
          additionalAccountIds: s.accounts.filter((a) => !a.isPrimary).map((a) => a.account.id),
          scheduledStart: fromLocalInput(toLocalInput(s.scheduledStart, sz), sz),
          scheduledEnd: fromLocalInput(toLocalInput(s.scheduledEnd, sz), sz),
          timezone: sz,
          supervisorMembershipId: s.supervisor?.membershipId ?? null,
          parallelCoverage: s.parallelCoverage,
        };
        const changed = changedFields(before, body);
        // The schedule and the accounts are validated as a whole: send their fields together.
        for (const group of [['scheduledStart', 'scheduledEnd', 'timezone'], ['primaryAccountId', 'additionalAccountIds']] as const)
          if (group.some((k) => changed.includes(k))) changed.push(...group);
        await update.run({ params: { workspaceId: workspace.id, shiftId: shift.id }, body: pickChanged(body, changed) }, { ifMatch: edit.version });
        onClose();
      } else {
        const created = await create.run({ params: { workspaceId: workspace.id }, body });
        onClose(created.id);
      }
    } catch (e) {
      if (edit.catchConflict(e)) return;
      if (!applyFieldErrors(e, form.setError as never)) setError(errorMessage(e, 'The shift could not be saved.'));
    }
  });
  const errs = form.formState.errors;
  const val = validation.data;
  const pending = create.isPending || update.isPending;
  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      title={shift ? 'Edit Scheduled Shift' : 'Schedule Shift'}
      description="One timer covers the primary account and up to 9 additional accounts."
      width={760}
      dirty={form.formState.isDirty && !pending}
      footer={
        <>
          <Button onClick={() => onClose()} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" loading={pending} onClick={() => void submit()}>
            {shift ? 'Save Changes' : 'Schedule'}
          </Button>
        </>
      }
    >
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <Field label="Model" helper="Filters the account list.">
          <Controller
            control={form.control}
            name="projectId"
            render={({ field }) => (
              <OfmModelSelect
                value={field.value || null}
                onChange={(p) => {
                  field.onChange(p ?? '');
                  form.setValue('primaryAccountId', '');
                  form.setValue('additionalAccountIds', []);
                }}
                clearable
              />
            )}
          />
        </Field>
        <Field label="Member" required error={errs.membershipId?.message}>
          <Controller control={form.control} name="membershipId" render={({ field }) => <MemberSelect value={field.value} onChange={(m) => field.onChange(m ?? '')} />} />
        </Field>
        <Field label="Primary Account" required error={errs.primaryAccountId?.message}>
          <Controller
            control={form.control}
            name="primaryAccountId"
            render={({ field }) => <OfmAccountSelect projectId={v.projectId || undefined} value={field.value} onChange={(a) => field.onChange(a ?? '')} />}
          />
        </Field>
        <Field label="Additional Accounts" helper="Each account needs a valid assignment for the member." error={errs.additionalAccountIds?.message}>
          <Controller
            control={form.control}
            name="additionalAccountIds"
            render={({ field }) => (
              <OfmAccountMultiSelect projectId={v.projectId || undefined} exclude={v.primaryAccountId ? [v.primaryAccountId] : []} max={SHIFT_LIMITS.maxAccounts - 1} value={field.value} onChange={field.onChange} />
            )}
          />
        </Field>
        <Field label="Time Zone" required error={errs.timezone?.message} helper="Start and end are entered in this zone.">
          <Controller control={form.control} name="timezone" render={({ field }) => <TimeZoneSelect value={field.value} onChange={field.onChange} />} />
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Start" required error={errs.start?.message}>
            <DateTimeInput timezone={v.timezone} {...form.register('start')} />
          </Field>
          <Field label="End" required error={errs.end?.message}>
            <DateTimeInput timezone={v.timezone} {...form.register('end')} />
          </Field>
        </div>
        <Field label="Supervisor" helper="Defaults to the assignment or model supervisor.">
          <Controller control={form.control} name="supervisorMembershipId" render={({ field }) => <MemberSelect value={field.value} onChange={(m) => field.onChange(m ?? '')} clearable />} />
        </Field>
        <Controller
          control={form.control}
          name="parallelCoverage"
          render={({ field }) => (
            <Switch
              label="Parallel Coverage"
              description="Required when another shift already covers the same account and coverage lane at this time."
              checked={field.value}
              onCheckedChange={field.onChange}
            />
          )}
        />
        <section aria-live="polite" className="flex flex-col gap-2">
          <h3 className="text-[14px] font-semibold text-fg">Schedule Check</h3>
          {!body ? (
            <p className="text-[13px] text-fg-2">Choose a member, account, start and end to check conflicts and daylight saving time.</p>
          ) : validation.isFetching && !val ? (
            <p className="text-[13px] text-fg-2">Checking…</p>
          ) : validation.error ? (
            <Banner tone="danger">{validation.error.message}</Banner>
          ) : val ? (
            <>
              <p className="text-[13px] text-fg-2">
                Local time {val.dst.localStart} – {val.dst.localEnd} ({v.timezone}) · {Math.floor(val.durationMinutes / 60)} h {val.durationMinutes % 60} min
              </p>
              {val.dst.offsetChanges ? (
                <Banner tone="warning">
                  Daylight saving time changes during this shift: {val.dst.elapsedMinutes} minutes elapse while the clock shows {val.dst.wallClockMinutes} minutes. Net hours use elapsed time.
                </Banner>
              ) : null}
              <IssueList title="Conflicts" issues={val.conflicts} tone="danger" />
              <IssueList title="Assignment" issues={val.assignmentIssues} tone="danger" />
              <IssueList title="Warnings" issues={val.warnings} tone="warning" />
              {val.ok && !val.warnings.length ? <Banner tone="success">No conflicts found.</Banner> : null}
            </>
          ) : null}
        </section>
      </form>
      <ConflictDialog {...edit.conflictDialog} />
    </Drawer>
  );
};

// ——— Repeat schedule with preview ———

const WEEKDAYS = [
  { n: 1, label: 'Mon' },
  { n: 2, label: 'Tue' },
  { n: 3, label: 'Wed' },
  { n: 4, label: 'Thu' },
  { n: 5, label: 'Fri' },
  { n: 6, label: 'Sat' },
  { n: 7, label: 'Sun' },
];

const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
const repeatSchema = z
  .object({
    projectId: z.string(),
    membershipId: z.string().uuid('Choose a member.'),
    primaryAccountId: z.string().uuid('Choose the primary account.'),
    additionalAccountIds: z.array(z.string().uuid()).max(SHIFT_LIMITS.maxAccounts - 1),
    supervisorMembershipId: z.string().optional(),
    parallelCoverage: z.boolean(),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose the first date.'),
    weeks: z.number().int().min(1).max(SHIFT_LIMITS.repeatMaxWeeks, `At most ${SHIFT_LIMITS.repeatMaxWeeks} weeks.`),
    weekdays: z.array(z.number().int().min(1).max(7)).min(1, 'Choose at least one weekday.'),
    startTime: z.string().regex(hhmm, 'Use HH:mm.'),
    endTime: z.string().regex(hhmm, 'Use HH:mm.'),
    timezone: z.string().min(1, 'Choose a time zone.'),
  })
  .refine((v) => v.startTime !== v.endTime, { path: ['endTime'], message: 'End time must differ from start time.' });
type RepeatValues = z.infer<typeof repeatSchema>;
type RepeatPreview = EndpointResponse<typeof E.repeatPreview>;

/** Repeat Schedule (≤ 8 weeks): Preview lists every occurrence with conflicts and DST notes; Apply creates each once. */
export const RepeatScheduleDialog = ({ onClose }: { onClose: () => void }) => {
  const { workspace } = useWorkspace();
  const form = useForm<RepeatValues>({
    resolver: zodResolver(repeatSchema),
    defaultValues: {
      projectId: '',
      membershipId: '',
      primaryAccountId: '',
      additionalAccountIds: [],
      supervisorMembershipId: '',
      parallelCoverage: false,
      startDate: DateTime.now().setZone(workspace.timezone).plus({ days: 1 }).toISODate() ?? '',
      weeks: 2,
      weekdays: [1, 2, 3, 4, 5],
      startTime: '09:00',
      endTime: '17:00',
      timezone: workspace.timezone,
    },
  });
  const [preview, setPreview] = useState<RepeatPreview | null>(null);
  const [skipConflicting, setSkipConflicting] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const previewM = useOfmMutation(E.repeatPreview);
  const apply = useOfmMutation(E.repeatApply, { also: ['myWork.', 'calendar.'] });
  const v = form.watch();
  const errs = form.formState.errors;

  const runPreview = form.handleSubmit(async (values) => {
    setError(null);
    try {
      const res = await previewM.run({
        params: { workspaceId: workspace.id },
        body: {
          membershipId: values.membershipId,
          primaryAccountId: values.primaryAccountId,
          additionalAccountIds: values.additionalAccountIds,
          supervisorMembershipId: values.supervisorMembershipId || null,
          parallelCoverage: values.parallelCoverage,
          pattern: { startDate: values.startDate, weeks: values.weeks, weekdays: values.weekdays, startTime: values.startTime, endTime: values.endTime, timezone: values.timezone },
        },
      });
      setPreview(res);
    } catch (e) {
      if (!applyFieldErrors(e, form.setError as never)) setError(errorMessage(e, 'The preview could not be built.'));
    }
  });
  const okCount = preview?.occurrences.filter((o) => o.ok).length ?? 0;
  const badCount = (preview?.occurrences.length ?? 0) - okCount;

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Repeat Schedule"
      description={`Weekly pattern for up to ${SHIFT_LIMITS.repeatMaxWeeks} weeks. Nothing is created until you apply the preview.`}
      size="wide"
      dirty={form.formState.isDirty && !apply.isPending}
      footer={
        preview ? (
          <>
            <Button onClick={() => setPreview(null)} disabled={apply.isPending}>
              Back to Pattern
            </Button>
            <Button
              variant="primary"
              loading={apply.isPending}
              disabled={okCount === 0 || (badCount > 0 && !skipConflicting)}
              onClick={async () => {
                setError(null);
                try {
                  const res = await apply.run({ params: { workspaceId: workspace.id }, body: { previewToken: preview.previewToken, skipConflicting } });
                  toast.success(`${res.created.length} shift(s) scheduled`, res.skipped.length ? `${res.skipped.length} occurrence(s) skipped because of conflicts.` : undefined);
                  onClose();
                } catch (e) {
                  setError(errorMessage(e, 'The schedule could not be applied.'));
                }
              }}
            >
              Apply {okCount} Shift(s)
            </Button>
          </>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" loading={previewM.isPending} onClick={() => void runPreview()}>
              Preview
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        {preview ? (
          <>
            <p className="text-[13px] text-fg-2">
              {preview.occurrences.length} occurrence(s): {okCount} ready, {badCount} with conflicts. Preview expires {DateTime.fromISO(preview.expiresAt).setZone(v.timezone).toFormat('HH:mm')}.
            </p>
            {badCount > 0 ? <Switch label="Skip conflicting occurrences" description="Otherwise Apply is blocked until the conflicts are fixed." checked={skipConflicting} onCheckedChange={setSkipConflicting} /> : null}
            <ul className="flex flex-col divide-y divide-line rounded-[12px] border border-line">
              {preview.occurrences.map((o) => (
                <li key={o.date} className="flex flex-col gap-1 px-3 py-2 text-[13px]">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-fg">{fmtRange(o.start, o.end, v.timezone)}</span>
                    <span className="flex flex-wrap items-center gap-1.5">
                      {o.dstShifted || o.offsetChanges ? <Badge tone="warning">DST: {Math.floor(o.durationMinutes / 60)} h {o.durationMinutes % 60} min elapsed</Badge> : null}
                      {o.ok ? <Badge tone="success">Ready</Badge> : <Badge tone="danger">Conflict</Badge>}
                    </span>
                  </div>
                  {[...o.conflicts, ...o.assignmentIssues].map((i, n) => (
                    <span key={`c${n}`} className="text-danger">
                      {i.message}
                    </span>
                  ))}
                  {o.warnings.map((i, n) => (
                    <span key={`w${n}`} className="text-fg-2">
                      {i.message}
                    </span>
                  ))}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <form onSubmit={runPreview} noValidate className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label="Model">
              <Controller
                control={form.control}
                name="projectId"
                render={({ field }) => (
                  <OfmModelSelect
                    value={field.value || null}
                    onChange={(p) => {
                      field.onChange(p ?? '');
                      form.setValue('primaryAccountId', '');
                      form.setValue('additionalAccountIds', []);
                    }}
                    clearable
                  />
                )}
              />
            </Field>
            <Field label="Member" required error={errs.membershipId?.message}>
              <Controller control={form.control} name="membershipId" render={({ field }) => <MemberSelect value={field.value} onChange={(m) => field.onChange(m ?? '')} />} />
            </Field>
            <Field label="Primary Account" required error={errs.primaryAccountId?.message}>
              <Controller control={form.control} name="primaryAccountId" render={({ field }) => <OfmAccountSelect projectId={v.projectId || undefined} value={field.value} onChange={(a) => field.onChange(a ?? '')} />} />
            </Field>
            <Field label="Additional Accounts">
              <Controller
                control={form.control}
                name="additionalAccountIds"
                render={({ field }) => (
                  <OfmAccountMultiSelect projectId={v.projectId || undefined} exclude={v.primaryAccountId ? [v.primaryAccountId] : []} max={SHIFT_LIMITS.maxAccounts - 1} value={field.value} onChange={field.onChange} />
                )}
              />
            </Field>
            <Field label="First Date" required error={errs.startDate?.message}>
              <DateInput {...form.register('startDate')} />
            </Field>
            <Field label="Weeks" required error={errs.weeks?.message} helper={`1–${SHIFT_LIMITS.repeatMaxWeeks}`}>
              <Input type="number" min={1} max={SHIFT_LIMITS.repeatMaxWeeks} {...form.register('weeks', { valueAsNumber: true })} />
            </Field>
            <fieldset className="md:col-span-2">
              <legend className="mb-2 text-[13px] font-[550] text-fg">
                Weekdays <span className="text-danger">*</span>
              </legend>
              <Controller
                control={form.control}
                name="weekdays"
                render={({ field }) => (
                  <div className="flex flex-wrap gap-3">
                    {WEEKDAYS.map((d) => (
                      <Checkbox
                        key={d.n}
                        label={d.label}
                        checked={field.value.includes(d.n)}
                        onCheckedChange={(c) => field.onChange(c ? [...field.value, d.n].sort() : field.value.filter((x) => x !== d.n))}
                      />
                    ))}
                  </div>
                )}
              />
              {errs.weekdays?.message ? <p className="mt-1 text-[12px] text-danger">{errs.weekdays.message}</p> : null}
            </fieldset>
            <Field label="Start Time" required error={errs.startTime?.message}>
              <Input type="time" {...form.register('startTime')} />
            </Field>
            <Field label="End Time" required error={errs.endTime?.message} helper="An end before the start means the shift ends the next day.">
              <Input type="time" {...form.register('endTime')} />
            </Field>
            <Field label="Time Zone" required error={errs.timezone?.message}>
              <Controller control={form.control} name="timezone" render={({ field }) => <TimeZoneSelect value={field.value} onChange={field.onChange} />} />
            </Field>
            <Field label="Supervisor">
              <Controller control={form.control} name="supervisorMembershipId" render={({ field }) => <MemberSelect value={field.value} onChange={(m) => field.onChange(m ?? '')} clearable />} />
            </Field>
            <div className="md:col-span-2">
              <Controller
                control={form.control}
                name="parallelCoverage"
                render={({ field }) => <Switch label="Parallel Coverage" description="Mark when another shift covers the same account and lane." checked={field.value} onCheckedChange={field.onChange} />}
              />
            </div>
          </form>
        )}
      </div>
    </Dialog>
  );
};

// ——— Swaps ———

export const SwapRequestDialog = ({ shift, onClose }: { shift: OfmShiftSummary; onClose: () => void }) => {
  const { workspace, user } = useWorkspace();
  const [member, setMember] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const m = useOfmMutation(E.requestSwap, { successMessage: 'Swap requested' });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Request Swap"
      description={`${fmtRange(shift.scheduledStart, shift.scheduledEnd, user.timezone)}. The proposed member accepts first, then a supervisor approves.`}
      size="small"
      dirty={!!member || reason.length > 0}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!member || reason.trim().length < 3}
            loading={m.isPending}
            onClick={async () => {
              setError(null);
              try {
                await m.run({ params: { workspaceId: workspace.id, shiftId: shift.id }, body: { proposedMembershipId: member!, reason: reason.trim() } });
                onClose();
              } catch (e) {
                setError(errorMessage(e));
              }
            }}
          >
            Request Swap
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <Field label="Proposed Member" required>
          <MemberSelect value={member} onChange={setMember} />
        </Field>
        <Field label="Reason" required helper="At least 3 characters.">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} />
        </Field>
      </div>
    </Dialog>
  );
};

/** Swap requests with the actions the viewer may take (accept / decline / approve / withdraw). */
export const SwapList = ({ swaps, title = 'Swap Requests', emptyText }: { swaps: OfmSwapRequest[]; title?: string; emptyText?: string }) => {
  const { workspace, user } = useWorkspace();
  const [declining, setDeclining] = useState<OfmSwapRequest | null>(null);
  const accept = useOfmMutation(E.acceptSwap, { successMessage: 'Swap accepted — waiting for approval' });
  const approve = useOfmMutation(E.approveSwap, { successMessage: 'Swap approved; the shift was reassigned', also: ['myWork.'] });
  const cancel = useOfmMutation(E.cancelSwap, { successMessage: 'Swap request withdrawn' });
  const decline = useOfmMutation(E.declineSwap, { successMessage: 'Swap declined' });
  if (!swaps.length && !emptyText) return null;
  const p = (s: OfmSwapRequest) => ({ params: { workspaceId: workspace.id, swapId: s.id } });
  return (
    <Panel title={title}>
      {swaps.length ? (
        <ul className="flex flex-col divide-y divide-line">
          {swaps.map((s) => (
            <li key={s.id} className="flex flex-col gap-2 py-2 first:pt-0 last:pb-0 md:flex-row md:items-center md:justify-between">
              <div className="min-w-0 text-[13px]">
                <p className="font-medium text-fg">
                  <a className="hover:underline" href={`/w/${workspace.id}/ofm/shifts/${s.shift.id}`}>
                    {fmtRange(s.shift.scheduledStart, s.shift.scheduledEnd, user.timezone)}
                  </a>
                </p>
                <p className="flex flex-wrap items-center gap-1.5 text-fg-2">
                  <MemberChip member={s.from} /> <span aria-hidden>→</span> <MemberChip member={s.proposed} />
                </p>
                <p className="text-fg-2">{s.reason}</p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <StatusBadge status={s.state === 'approved' ? 'approved' : s.state === 'declined' || s.state === 'cancelled' ? 'cancelled' : 'pending'} label={label('swapState', s.state)} />
                {s.permissions.accept ? (
                  <Button size="sm" variant="primary" loading={accept.isPending} onClick={() => void runAction(() => accept.run(p(s), { ifMatch: s.rowVersion }))}>
                    Accept
                  </Button>
                ) : null}
                {s.permissions.approve ? (
                  <Button size="sm" variant="primary" loading={approve.isPending} onClick={() => void runAction(() => approve.run({ ...p(s), body: {} }, { ifMatch: s.rowVersion }))}>
                    Approve Swap
                  </Button>
                ) : null}
                {s.permissions.decline ? (
                  <Button size="sm" onClick={() => setDeclining(s)}>
                    Decline
                  </Button>
                ) : null}
                {s.permissions.cancel ? (
                  <Button size="sm" variant="ghost" loading={cancel.isPending} onClick={() => void runAction(() => cancel.run(p(s), { ifMatch: s.rowVersion }))}>
                    Withdraw
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-fg-2">{emptyText}</p>
      )}
      <ReasonDialog
        open={!!declining}
        onOpenChange={(o) => !o && setDeclining(null)}
        title="Decline swap?"
        body="The shift stays with the current member."
        confirmLabel="Decline Swap"
        destructive
        record={declining}
        onConfirm={(reason, ifMatch) => decline.run({ params: { workspaceId: workspace.id, swapId: declining!.id }, body: { reason } }, { ifMatch })}
      />
    </Panel>
  );
};

/** Cancel Shift with a reason (reminders stop; the record stays in history). */
export const CancelShiftDialog = ({ shift, open, onOpenChange }: { shift: OfmShiftSummary; open: boolean; onOpenChange: (o: boolean) => void }) => {
  const { workspace, user } = useWorkspace();
  const m = useOfmMutation(E.cancelShift, { successMessage: 'Shift cancelled', also: ['myWork.', 'calendar.'] });
  return (
    <ReasonDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Cancel shift?"
      body={`${shift.member.displayName}, ${fmtRange(shift.scheduledStart, shift.scheduledEnd, user.timezone)}. The member is notified and reminders stop.`}
      confirmLabel="Cancel Shift"
      destructive
      record={shift}
      onConfirm={(reason, ifMatch) => m.run({ params: { workspaceId: workspace.id, shiftId: shift.id }, body: { reason } }, { ifMatch })}
    />
  );
};
