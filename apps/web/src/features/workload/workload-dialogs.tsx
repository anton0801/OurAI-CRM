'use client';
import { useEffect, useState } from 'react';
import { taskEndpoints, workloadEndpoints, type AbsenceView } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { ABSENCE_CATEGORIES, DateTime, LIMITS } from '@castlane/domain';
import { Banner, Button, DateInput, Dialog, Field, Input, Select, Textarea, formatDate } from '@castlane/ui';
import { ConflictDialog } from '@/components/common/conflict';
import { MemberSelect } from '@/components/common/pickers';
import { QueryState } from '@/components/common/query-state';
import { changedFields, pickChanged, useEditBase } from '@/lib/edit-base';
import { useApiMutation, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useWorkspace } from '@/lib/workspace-context';
import { formatMinutes, todayIn } from '../tasks/format';

export const WORKLOAD_INVALIDATE = ['workload.', 'myWork.', 'tasks.'];

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
type Day = (typeof DAYS)[number];
const hoursText = (m: number) => (m % 60 ? (m / 60).toFixed(2).replace(/0+$/, '') : String(m / 60));
const toMinutes = (h: string) => Math.round((Number(h.replace(',', '.')) || 0) * 60);

/** Minutes typed as hours; accepts "7.5" or "7,5". */
const HoursInput = ({ value, onChange, ...rest }: { value: string; onChange: (v: string) => void; 'aria-label'?: string }) => (
  <Input value={value} onChange={(e) => onChange(e.target.value)} inputMode="decimal" {...rest} />
);

/**
 * Adjust Capacity: a dated weekly schedule. The 8 h Mon–Fri template is only a suggestion until a
 * manager confirms it; until then the member’s capacity is unknown, not zero.
 */
export const CapacityDialog = ({ open, onOpenChange, membershipId: fixed }: { open: boolean; onOpenChange: (o: boolean) => void; membershipId?: string }) => {
  const { workspace, user } = useWorkspace();
  const [member, setMember] = useState<string | null>(fixed ?? null);
  const [from, setFrom] = useState(todayIn(user.timezone));
  const [hours, setHours] = useState<Record<Day, string>>({ monday: '', tuesday: '', wednesday: '', thursday: '', friday: '', saturday: '', sunday: '' });
  const [error, setError] = useState<string | null>(null);
  const q = useApiQuery(workloadEndpoints.capacities, { params: { workspaceId: workspace.id }, query: { membershipId: member ?? '' } }, { enabled: open && !!member });
  const set = useApiMutation(workloadEndpoints.setCapacity, { invalidate: WORKLOAD_INVALIDATE, successMessage: 'Capacity confirmed', silentErrors: true });
  useEffect(() => {
    if (open) {
      setMember(fixed ?? null);
      setFrom(todayIn(user.timezone));
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => {
    if (!q.data) return;
    const base = q.data.items[0]?.weekdayMinutes ?? q.data.template;
    setHours(Object.fromEntries(DAYS.map((d) => [d, hoursText(base[d])])) as Record<Day, string>);
  }, [q.data]);
  const total = DAYS.reduce((s, d) => s + toMinutes(hours[d]), 0);
  const invalid = DAYS.some((d) => toMinutes(hours[d]) < 0 || toMinutes(hours[d]) > 24 * 60);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Adjust Capacity"
      description="Working hours per weekday from a date. Earlier periods keep their schedule."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!member || !from || invalid || (q.data ? !q.data.canManage : true)}
            loading={set.isPending}
            onClick={async () => {
              setError(null);
              try {
                await set.run({
                  params: { workspaceId: workspace.id },
                  body: { membershipId: member!, effectiveFrom: from, weekdayMinutes: Object.fromEntries(DAYS.map((d) => [d, toMinutes(hours[d])])) as Record<Day, number> },
                });
                onOpenChange(false);
              } catch (e) {
                setError(isApiError(e) ? (e.fieldErrors[0]?.message ?? e.message) : 'The capacity was not saved.');
              }
            }}
          >
            Confirm Capacity
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Member" required>
            <MemberSelect value={member} onChange={setMember} disabled={!!fixed} permission="workload.read" />
          </Field>
          <Field label="Effective from" required>
            <DateInput value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
        </div>
        {member ? (
          <QueryState query={q}>
            {q.data ? (
              <>
                {!q.data.canManage ? <Banner tone="info">You can see this member’s capacity but not change it.</Banner> : null}
                {q.data.items.length === 0 ? <Banner tone="info">No confirmed capacity yet: workload shows it as unknown. The suggested template is 8 h Monday–Friday.</Banner> : null}
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {DAYS.map((d) => (
                    <Field key={d} label={`${d[0]!.toUpperCase()}${d.slice(1)} (h)`}>
                      <HoursInput value={hours[d]} onChange={(v) => setHours((h) => ({ ...h, [d]: v }))} />
                    </Field>
                  ))}
                </div>
                <p className="text-[13px] text-fg-2">Weekly total: {formatMinutes(total)}</p>
                {q.data.items.length ? (
                  <ul className="flex flex-col gap-1 text-[12px] text-fg-2" aria-label="Capacity history">
                    {q.data.items.map((c) => (
                      <li key={c.id}>
                        From {formatDate(c.effectiveFrom)}: {formatMinutes(c.weeklyMinutes)} per week{c.confirmedBy ? ` · confirmed by ${c.confirmedBy.displayName}` : ''}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </>
            ) : null}
          </QueryState>
        ) : null}
      </div>
    </Dialog>
  );
};

/** Add Absence (own request, or recorded by a manager) / edit a requested absence. */
export const AbsenceDialog = ({ open, onOpenChange, membershipId: fixed, absence }: { open: boolean; onOpenChange: (o: boolean) => void; membershipId?: string; absence?: AbsenceView }) => {
  const { workspace, user, membershipId: me } = useWorkspace();
  const [member, setMember] = useState<string | null>(fixed ?? me);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [category, setCategory] = useState<string>('vacation');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [affected, setAffected] = useState<{ tasksDue: number; shiftsScheduled: number } | null>(null);
  // `absence` is the row as the dialog opened; only changed fields are sent (T162).
  const edit = useEditBase(absence, { open: open && !!absence });
  const create = useApiMutation(workloadEndpoints.createAbsence, { invalidate: WORKLOAD_INVALIDATE, silentErrors: true });
  const update = useApiMutation(workloadEndpoints.updateAbsence, { invalidate: WORKLOAD_INVALIDATE, successMessage: 'Absence updated', silentErrors: true });
  useEffect(() => {
    if (!open) return;
    setError(null);
    setAffected(null);
    setMember(absence?.member.membershipId ?? fixed ?? me);
    setStart(absence?.startDate ?? todayIn(user.timezone));
    setEnd(absence?.endDate ?? todayIn(user.timezone));
    setCategory(absence?.category ?? 'vacation');
    setReason(absence?.privateReason ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const invalid = !member || !start || !end || end < start;
  return (
    <>
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
        title={absence ? 'Edit Absence' : 'Add Absence'}
        description={member === me ? 'Your request goes to your manager or a workload manager.' : 'Recorded by a manager, the absence is approved directly.'}
        footer={
          affected ? (
            <Button variant="primary" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          ) : (
            <>
              <Button onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button
                variant="primary"
                disabled={invalid}
                loading={create.isPending || update.isPending}
                onClick={async () => {
                  setError(null);
                  try {
                    if (absence) {
                      const body = { startDate: start, endDate: end, category: category as never, privateReason: reason.trim() || null };
                      const before = { startDate: absence.startDate, endDate: absence.endDate, category: absence.category as never, privateReason: absence.privateReason?.trim() || null };
                      const changed = changedFields(before, body);
                      if (changed.includes('startDate') || changed.includes('endDate')) changed.push('startDate', 'endDate');
                      await update.run({ params: { workspaceId: workspace.id, absenceId: absence.id }, body: pickChanged(body, changed) }, { ifMatch: edit.version });
                      onOpenChange(false);
                    } else {
                      const r = await create.run({ params: { workspaceId: workspace.id }, body: { membershipId: member!, startDate: start, endDate: end, category: category as never, privateReason: reason.trim() || null } });
                      if (r.affected.tasksDue || r.affected.shiftsScheduled) setAffected(r.affected);
                      else onOpenChange(false);
                    }
                  } catch (e) {
                    if (!edit.catchConflict(e)) setError(isApiError(e) ? (e.fieldErrors[0]?.message ?? e.message) : 'The absence was not saved.');
                  }
                }}
              >
                {absence ? 'Save' : 'Add Absence'}
              </Button>
            </>
          )
        }
      >
        <div className="flex flex-col gap-4">
          {error ? <Banner tone="danger">{error}</Banner> : null}
          {affected ? (
            <Banner tone="warning">
              Saved. During this absence {affected.tasksDue} task deadline(s) and {affected.shiftsScheduled} shift(s) are still scheduled for this member. Nothing was moved or cancelled; reassign or reschedule them if needed.
            </Banner>
          ) : (
            <>
              <Field label="Member" required>
                <MemberSelect value={member} onChange={setMember} disabled={!!fixed || !!absence} />
              </Field>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="First day" required>
                  <DateInput value={start} onChange={(e) => setStart(e.target.value)} />
                </Field>
                <Field label="Last day" required error={end && start && end < start ? 'The last day cannot be before the first.' : undefined}>
                  <DateInput value={end} onChange={(e) => setEnd(e.target.value)} min={start} />
                </Field>
              </div>
              <Field label="Category" required>
                <Select value={category} onChange={(v) => setCategory(v ?? 'vacation')} options={ABSENCE_CATEGORIES.map((c) => ({ value: c, label: label('absenceCategory', c) }))} />
              </Field>
              <Field label="Private reason" helper="Visible only to the member, their manager and workload managers.">
                <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={LIMITS.reasonMax} className="min-h-[72px]" />
              </Field>
            </>
          )}
        </div>
      </Dialog>
      <ConflictDialog {...edit.conflictDialog} />
    </>
  );
};

type ReassignTask = { id: string; title: string; project: { id: string } };

/** Reassign with a preview of both members’ load. A task that changed meanwhile refreshes the preview. */
export const ReassignDialog = ({ task, from, period, onOpenChange }: { task: ReassignTask | null; from: string; period: 'week' | 'month'; onOpenChange: (o: boolean) => void }) => {
  const { workspace } = useWorkspace();
  const [to, setTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const preview = useApiMutation(workloadEndpoints.reassignPreview, { silentErrors: true });
  const assign = useApiMutation(taskEndpoints.update, { invalidate: WORKLOAD_INVALIDATE, successMessage: 'Task reassigned', silentErrors: true });
  useEffect(() => {
    if (task) {
      setTo(null);
      setError(null);
      preview.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.id]);
  const runPreview = async (member: string) => {
    setError(null);
    try {
      await preview.run({ params: { workspaceId: workspace.id }, body: { taskId: task!.id, toMembershipId: member, from, period } });
    } catch (e) {
      setError(isApiError(e) ? e.message : 'The preview failed.');
    }
  };
  const p = preview.data;
  return (
    <Dialog
      open={!!task}
      onOpenChange={onOpenChange}
      title="Reassign"
      description={task?.title}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!p || !p.to.canAccessTask}
            loading={assign.isPending}
            onClick={async () => {
              setError(null);
              try {
                await assign.run({ params: { workspaceId: workspace.id, taskId: task!.id }, body: { assigneeMembershipId: to } }, { ifMatch: p!.task.rowVersion });
                onOpenChange(false);
              } catch (e) {
                if (isApiError(e) && (e.code === 'VERSION_CONFLICT' || e.status === 412)) {
                  setError('The task changed meanwhile. The preview was refreshed; check it and reassign again.');
                  void runPreview(to!);
                } else setError(isApiError(e) ? e.message : 'The task was not reassigned.');
              }
            }}
          >
            Reassign
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="warning">{error}</Banner> : null}
        <Field label="New assignee" required>
          <MemberSelect
            value={to}
            onChange={(v) => {
              setTo(v);
              preview.reset();
              if (v) void runPreview(v);
            }}
            projectId={task?.project.id}
            permission="tasks.read"
          />
        </Field>
        {p ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {p.from ? (
              <div className="rounded-[8px] border border-line p-3 text-[13px]">
                <p className="font-medium text-fg">{p.from.member?.displayName ?? 'Unassigned'}</p>
                <p className="text-fg-2">
                  Planned {formatMinutes(p.from.plannedBefore)} → {formatMinutes(p.from.plannedAfter)}
                </p>
                <p className="text-fg-2">Available {p.from.availableMinutes === null ? 'unknown' : formatMinutes(p.from.availableMinutes)}</p>
              </div>
            ) : null}
            <div className="rounded-[8px] border border-line p-3 text-[13px]">
              <p className="font-medium text-fg">{p.to.member.displayName}</p>
              <p className="text-fg-2">
                Planned {formatMinutes(p.to.plannedBefore)} → {formatMinutes(p.to.plannedAfter)}
              </p>
              <p className="text-fg-2">Available {p.to.availableMinutes === null ? 'unknown' : formatMinutes(p.to.availableMinutes)}</p>
              {p.to.availableMinutes !== null && p.to.plannedAfter > p.to.availableMinutes ? <p className="text-warning">Over capacity by {formatMinutes(p.to.plannedAfter - p.to.availableMinutes)}</p> : null}
            </div>
            {!p.to.canAccessTask ? <Banner tone="danger">This member cannot access the task’s project. Add them to the project first.</Banner> : null}
            {p.task.estimateMinutes === null ? <p className="text-[13px] text-fg-2 sm:col-span-2">The task has no estimate, so it counts as unestimated for the new assignee, not as zero hours.</p> : null}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
};

/** Change Estimate from the workload grid (the same field as on the task). */
export const EstimateDialog = ({ task, onOpenChange }: { task: { id: string; title: string; estimateMinutes: number | null; rowVersion: number } | null; onOpenChange: (o: boolean) => void }) => {
  const { workspace } = useWorkspace();
  const [h, setH] = useState('');
  const [error, setError] = useState<string | null>(null);
  const edit = useEditBase(task, { open: !!task });
  const save = useApiMutation(taskEndpoints.update, { invalidate: WORKLOAD_INVALIDATE, successMessage: 'Estimate updated', silentErrors: true });
  useEffect(() => {
    if (task) {
      setH(task.estimateMinutes === null ? '' : hoursText(task.estimateMinutes));
      setError(null);
    }
  }, [task]);
  const minutes = h.trim() ? toMinutes(h) : null;
  return (
    <>
      <Dialog
        open={!!task}
        onOpenChange={onOpenChange}
        size="small"
        title="Change Estimate"
        description={task?.title}
        footer={
          <>
            <Button onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button
              variant="primary"
              loading={save.isPending}
              disabled={minutes !== null && (minutes <= 0 || minutes > 1000 * 60)}
              onClick={async () => {
                setError(null);
                try {
                  await save.run({ params: { workspaceId: workspace.id, taskId: task!.id }, body: { estimateMinutes: minutes } }, { ifMatch: edit.version });
                  onOpenChange(false);
                } catch (e) {
                  if (!edit.catchConflict(e)) setError(isApiError(e) ? (e.fieldErrors[0]?.message ?? e.message) : 'The estimate was not saved.');
                }
              }}
            >
              Save
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {error ? <Banner tone="danger">{error}</Banner> : null}
          <Field label="Estimate (hours)" helper="Leave empty for unestimated. Unestimated work is counted separately, never as zero.">
            <HoursInput value={h} onChange={setH} />
          </Field>
        </div>
      </Dialog>
      <ConflictDialog {...edit.conflictDialog} />
    </>
  );
};

/** Plan Days: a manager’s daily allocation for one task (empty = even split again). */
export const AllocationDialog = ({ task, days, onOpenChange }: { task: { id: string; title: string; remainingMinutes: number | null } | null; days: string[]; onOpenChange: (o: boolean) => void }) => {
  const { workspace } = useWorkspace();
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const save = useApiMutation(workloadEndpoints.setAllocation, { invalidate: WORKLOAD_INVALIDATE, successMessage: 'Plan saved', silentErrors: true });
  useEffect(() => {
    if (task) {
      setValues({});
      setError(null);
    }
  }, [task]);
  const run = async (allocations: { date: string; minutes: number }[]) => {
    setError(null);
    try {
      await save.run({ params: { workspaceId: workspace.id }, body: { taskId: task!.id, allocations } });
      onOpenChange(false);
    } catch (e) {
      setError(isApiError(e) ? (e.fieldErrors[0]?.message ?? e.message) : 'The plan was not saved.');
    }
  };
  const list = days.map((d) => ({ date: d, minutes: toMinutes(values[d] ?? '') })).filter((x) => x.minutes > 0);
  const total = list.reduce((s, x) => s + x.minutes, 0);
  return (
    <Dialog
      open={!!task}
      onOpenChange={onOpenChange}
      size="wide"
      title="Plan Days"
      description={task ? `${task.title} · remaining ${formatMinutes(task.remainingMinutes)}` : undefined}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button loading={save.isPending} onClick={() => void run([])}>
            Use Even Split
          </Button>
          <Button variant="primary" disabled={list.length === 0 || list.some((x) => x.minutes > 24 * 60)} loading={save.isPending} onClick={() => void run(list)}>
            Save Plan
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <p className="text-[13px] text-fg-2">Hours per day for the assignee in this period. Days left empty get no planned time for this task.</p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
          {days.map((d) => (
            <Field key={d} label={DateTime.fromISO(d).toFormat('ccc d LLL')}>
              <HoursInput value={values[d] ?? ''} onChange={(v) => setValues((x) => ({ ...x, [d]: v }))} />
            </Field>
          ))}
        </div>
        <p className="text-[13px] text-fg">Planned: {formatMinutes(total)}</p>
      </div>
    </Dialog>
  );
};
