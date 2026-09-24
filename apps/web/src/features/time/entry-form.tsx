'use client';
import { useEffect, useState } from 'react';
import { timeEndpoints, type TimeEntryView } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { LIMITS } from '@castlane/domain';
import { Banner, Button, DateInput, DateTimeInput, Drawer, Field, Input, RadioGroup, Switch, Textarea, toast } from '@castlane/ui';
import { EntitySelect } from '@/components/common/entity-select';
import { useApiMutation } from '@/lib/hooks';
import { useCan, useWorkspace } from '@/lib/workspace-context';
import { fromLocalInput, toLocalInput, todayIn } from '../tasks/format';

export const TIME_INVALIDATE = ['time.', 'myWork.', 'tasks.get', 'workload.'];

type Mode = 'interval' | 'duration';
const FIELDS = ['taskId', 'startedAt', 'endedAt', 'durationMinutes', 'workDate', 'note', 'reason'];
type Errors = Partial<Record<'taskId' | 'startedAt' | 'endedAt' | 'durationMinutes' | 'workDate' | 'note' | 'reason' | 'form', string>>;

export interface EntryFormProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Edit an unapproved entry, or correct an approved one with a revision. */
  entry?: TimeEntryView;
  revise?: boolean;
  defaultTaskId?: string;
  defaultDate?: string;
}

/**
 * Add Entry / Edit Unapproved / Revise Approved (S30). Start–end or a duration on a date; at most
 * 24 hours, not in the future. Overlaps are reported after saving and must be fixed before approval.
 */
export const EntryForm = ({ open, onOpenChange, entry, revise, defaultTaskId, defaultDate }: EntryFormProps) => {
  const { workspace, user } = useWorkspace();
  const can = useCan();
  const tz = user.timezone;
  const [taskId, setTaskId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('interval');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [date, setDate] = useState('');
  const [hours, setHours] = useState('');
  const [minutes, setMinutes] = useState('');
  const [note, setNote] = useState('');
  const [billable, setBillable] = useState(false);
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [dirty, setDirty] = useState(false);
  const create = useApiMutation(timeEndpoints.create, { invalidate: TIME_INVALIDATE, silentErrors: true });
  const update = useApiMutation(timeEndpoints.update, { invalidate: TIME_INVALIDATE, silentErrors: true });
  const revision = useApiMutation(timeEndpoints.revise, { invalidate: TIME_INVALIDATE, silentErrors: true });
  const showBillable = entry ? entry.billable !== undefined : can('time.approve');

  useEffect(() => {
    if (!open) return;
    setErrors({});
    setDirty(false);
    setReason('');
    if (entry) {
      setTaskId(entry.task.id);
      setMode(entry.startedAt ? 'interval' : 'duration');
      setStart(toLocalInput(entry.startedAt, tz));
      setEnd(toLocalInput(entry.endedAt, tz));
      setDate(entry.workDate);
      const m = Math.round((entry.durationSeconds ?? 0) / 60);
      setHours(m ? String(Math.floor(m / 60)) : '');
      setMinutes(m ? String(m % 60) : '');
      setNote(entry.note ?? '');
      setBillable(!!entry.billable);
    } else {
      setTaskId(defaultTaskId ?? null);
      setMode('interval');
      setStart('');
      setEnd('');
      setDate(defaultDate ?? todayIn(tz));
      setHours('');
      setMinutes('');
      setNote('');
      setBillable(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const touch = <T,>(fn: (v: T) => void) => (v: T) => {
    fn(v);
    setDirty(true);
  };

  const submit = async () => {
    const e: Errors = {};
    if (!taskId) e.taskId = 'Choose the task you worked on.';
    let startedAt: string | null = null;
    let endedAt: string | null = null;
    let durationMinutes: number | null = null;
    if (mode === 'interval') {
      startedAt = fromLocalInput(start, tz);
      endedAt = fromLocalInput(end, tz);
      if (!startedAt) e.startedAt = 'Enter the start.';
      if (!endedAt) e.endedAt = 'Enter the end.';
      if (startedAt && endedAt && endedAt <= startedAt) e.endedAt = 'The end must be after the start.';
    } else {
      durationMinutes = (Number(hours) || 0) * 60 + (Number(minutes) || 0);
      if (!date) e.workDate = 'Enter the date.';
      if (durationMinutes <= 0) e.durationMinutes = 'Enter a duration above zero.';
      else if (durationMinutes > 24 * 60) e.durationMinutes = 'One entry can be at most 24 hours.';
    }
    if (revise && reason.trim().length < 3) e.reason = 'Explain the correction.';
    setErrors(e);
    if (Object.keys(e).length) return;
    const fields = {
      taskId: taskId!,
      startedAt: mode === 'interval' ? startedAt : null,
      endedAt: mode === 'interval' ? endedAt : null,
      durationMinutes: mode === 'duration' ? durationMinutes : null,
      workDate: mode === 'duration' ? date : undefined,
      note: note.trim() || null,
      ...(showBillable ? { billable } : {}),
    };
    try {
      const r = revise && entry
        ? await revision.run({ params: { workspaceId: workspace.id, entryId: entry.id }, body: { ...fields, reason: reason.trim() } })
        : entry
          ? await update.run({ params: { workspaceId: workspace.id, entryId: entry.id }, body: fields }, { ifMatch: entry.rowVersion })
          : await create.run({ params: { workspaceId: workspace.id }, body: fields });
      if (r.overlapsWith.length) toast.info('Saved, but this entry overlaps other time', 'Fix the overlap before submitting the week.');
      else toast.success(revise ? 'Revision saved. The approved entry stays until the revision is approved.' : 'Time entry saved');
      onOpenChange(false);
    } catch (err) {
      if (isApiError(err)) {
        const fe: Errors = {};
        for (const f of err.fieldErrors) fe[(FIELDS.includes(f.field) ? f.field : 'form') as keyof Errors] = f.message;
        if (!err.fieldErrors.length) fe.form = err.code === 'VERSION_CONFLICT' ? 'This entry changed meanwhile. Close and open it again.' : err.message;
        setErrors(fe);
      } else setErrors({ form: 'The entry could not be saved.' });
    }
  };

  const pending = create.isPending || update.isPending || revision.isPending;
  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      dirty={dirty}
      title={revise ? 'Revise Approved Entry' : entry ? 'Edit Time Entry' : 'Add Time Entry'}
      description={revise ? 'The approved entry is kept until a manager approves the correction.' : 'Only time you actually worked. Timers and manual entries both count.'}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" loading={pending} onClick={() => void submit()}>
            {revise ? 'Save Revision' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {errors.form ? <Banner tone="danger">{errors.form}</Banner> : null}
        <Field label="Task" required error={errors.taskId}>
          <EntitySelect type="task" value={taskId} onChange={touch(setTaskId)} placeholder="Search tasks" />
        </Field>
        <RadioGroup
          label="How to record"
          orientation="horizontal"
          value={mode}
          onValueChange={touch(setMode)}
          options={[
            { value: 'interval', label: 'Start and end' },
            { value: 'duration', label: 'Duration on a date' },
          ]}
        />
        {mode === 'interval' ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Start" required error={errors.startedAt}>
              <DateTimeInput value={start} onChange={(e) => touch(setStart)(e.target.value)} timezone={tz} max={toLocalInput(new Date().toISOString(), tz)} />
            </Field>
            <Field label="End" required error={errors.endedAt}>
              <DateTimeInput value={end} onChange={(e) => touch(setEnd)(e.target.value)} timezone={tz} max={toLocalInput(new Date().toISOString(), tz)} />
            </Field>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Date" required error={errors.workDate}>
              <DateInput value={date} onChange={(e) => touch(setDate)(e.target.value)} max={todayIn(tz)} />
            </Field>
            <Field label="Hours" error={errors.durationMinutes}>
              <Input value={hours} onChange={(e) => touch(setHours)(e.target.value)} inputMode="numeric" />
            </Field>
            <Field label="Minutes">
              <Input value={minutes} onChange={(e) => touch(setMinutes)(e.target.value)} inputMode="numeric" />
            </Field>
          </div>
        )}
        <Field label="Note" error={errors.note}>
          <Textarea value={note} onChange={(e) => touch(setNote)(e.target.value)} maxLength={LIMITS.noteMax} className="min-h-[72px]" />
        </Field>
        {showBillable ? <Switch label="Billable" checked={billable} onCheckedChange={touch(setBillable)} /> : null}
        {revise ? (
          <Field label="Reason for correction" required error={errors.reason}>
            <Textarea value={reason} onChange={(e) => touch(setReason)(e.target.value)} maxLength={LIMITS.reasonMax} className="min-h-[72px]" />
          </Field>
        ) : null}
      </div>
    </Drawer>
  );
};
