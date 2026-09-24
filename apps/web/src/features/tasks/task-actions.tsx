'use client';
import { useEffect, useMemo, useState } from 'react';
import { reminderEndpoints, taskEndpoints, type DueInputBody, type TaskDetail } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { LIMITS } from '@castlane/domain';
import { Banner, Button, Checkbox, ConfirmDialog, DateInput, DateTimeInput, Dialog, Field, RadioGroup, Select, Textarea, formatDateTime, toast } from '@castlane/ui';
import { ConflictDialog } from '@/components/common/conflict';
import { EntitySelect } from '@/components/common/entity-select';
import { useApiMutation } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useWorkspace } from '@/lib/workspace-context';
import { fromLocalInput, timezones, toLocalInput } from './format';

export const TASK_INVALIDATE = ['tasks.', 'myWork.', 'workload.', 'time.', 'projects.'];

type Option = TaskDetail['transitions'][number];

interface PendingTransition {
  option: Option;
  /** Server asked for more information (predecessors, successor policy). */
  predecessors?: { id: string | null; title: string | null; status: string | null }[];
  canOverride?: boolean;
  successors?: { id: string | null; title: string | null }[];
  message?: string;
}

/**
 * Status actions offered by the server (with the reason when not available). A move that needs a
 * reason, a dependency override or a decision about waiting tasks opens a dialog; nothing is
 * changed until the server confirms.
 */
export const useTransitions = (task: TaskDetail) => {
  const { workspace } = useWorkspace();
  const [pending, setPending] = useState<PendingTransition | null>(null);
  const [conflict, setConflict] = useState(false);
  const mutation = useApiMutation(taskEndpoints.transition, { invalidate: TASK_INVALIDATE, silentErrors: true });
  const run = async (option: Option, extra: Record<string, unknown> = {}) => {
    try {
      const r = await mutation.run({ params: { workspaceId: workspace.id, taskId: task.id }, body: { targetState: option.to, ...extra } }, { ifMatch: task.rowVersion });
      toast.success(`${option.label}: ${label('taskStatus', r.status)}`);
      setPending(null);
      return true;
    } catch (e) {
      if (!isApiError(e)) {
        toast.error('The status could not be changed.');
        return false;
      }
      if (e.code === 'VERSION_CONFLICT') {
        setConflict(true);
        return false;
      }
      const d = e.details as { predecessors?: PendingTransition['predecessors']; canOverride?: boolean; successors?: PendingTransition['successors']; needsSuccessorPolicy?: boolean } | undefined;
      if (d?.predecessors || d?.needsSuccessorPolicy) {
        setPending({ option, predecessors: d.predecessors, canOverride: d.canOverride, successors: d.successors, message: e.message });
        return false;
      }
      if (e.fieldErrors.length) {
        setPending((p) => ({ ...(p ?? { option }), message: e.fieldErrors[0]!.message }));
        return false;
      }
      toast.error(e.message);
      return false;
    }
  };
  const trigger = (option: Option) => {
    if (option.needsReason || option.to === 'cancelled' || (task.status === 'in_progress' && option.to === 'done' && task.permissions.overrideDependencies)) setPending({ option });
    else void run(option);
  };
  const dialog = (
    <>
      <TransitionDialog pending={pending} task={task} onCancel={() => setPending(null)} loading={mutation.isPending} onConfirm={(extra) => void run(pending!.option, extra)} />
      <ConflictDialog open={conflict} onOpenChange={setConflict} onReload={() => setConflict(false)} />
    </>
  );
  return { trigger, dialog, pendingAction: mutation.isPending };
};

const TransitionDialog = ({
  pending,
  task,
  onCancel,
  onConfirm,
  loading,
}: {
  pending: PendingTransition | null;
  task: TaskDetail;
  onCancel: () => void;
  onConfirm: (extra: Record<string, unknown>) => void;
  loading: boolean;
}) => {
  const { user } = useWorkspace();
  const [reason, setReason] = useState('');
  const [override, setOverride] = useState(false);
  const [policy, setPolicy] = useState<'remove_dependency' | 'keep_blocked' | 'replace'>('keep_blocked');
  const [replacement, setReplacement] = useState<string | null>(null);
  const [backdate, setBackdate] = useState('');
  useEffect(() => {
    setReason('');
    setOverride(false);
    setReplacement(null);
    setBackdate('');
  }, [pending?.option.to]);
  if (!pending) return null;
  const o = pending.option;
  const cancelling = o.to === 'cancelled';
  const needsPolicy = !!pending.successors?.length;
  const blockedByPreds = !!pending.predecessors?.length;
  const needsReason = o.needsReason || cancelling || override || !!backdate;
  const canBackdate = o.to === 'done' && task.permissions.overrideDependencies;
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onCancel()}
      size="regular"
      title={`${o.label}?`}
      description={`${task.title}: ${label('taskStatus', task.status)} → ${label('taskStatus', o.to)}`}
      footer={
        <>
          <Button onClick={onCancel}>Keep As Is</Button>
          <Button
            variant={cancelling ? 'danger' : 'primary'}
            loading={loading}
            disabled={(needsReason && reason.trim().length < 3) || (blockedByPreds && !override) || (policy === 'replace' && needsPolicy && !replacement)}
            onClick={() =>
              onConfirm({
                reason: reason.trim() || undefined,
                ...(override ? { overrideDependencies: true } : {}),
                ...(needsPolicy || cancelling ? { successorPolicy: needsPolicy ? policy : undefined, replacementTaskId: policy === 'replace' ? (replacement ?? undefined) : undefined } : {}),
                ...(backdate ? { effectiveAt: fromLocalInput(backdate, user.timezone) } : {}),
              })
            }
          >
            {override ? 'Override and Start' : o.label}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 text-[14px]">
        {pending.message ? <Banner tone={blockedByPreds || needsPolicy ? 'warning' : 'danger'}>{pending.message}</Banner> : null}
        {blockedByPreds ? (
          <div className="flex flex-col gap-2">
            <p className="text-fg-2">Unfinished predecessors:</p>
            <ul className="list-inside list-disc text-fg">
              {pending.predecessors!.map((p, i) => (
                <li key={p.id ?? i}>{p.title ? `${p.title} — ${label('taskStatus', p.status)}` : 'A task you cannot view'}</li>
              ))}
            </ul>
            {pending.canOverride ? (
              <Checkbox
                checked={override}
                onCheckedChange={setOverride}
                label="Override Dependency"
                description="Start anyway. The override, your reason and the state of the predecessors are recorded in the audit log."
              />
            ) : (
              <p className="text-fg-2">Only a lead can override dependencies. Finish the predecessors or ask a lead.</p>
            )}
          </div>
        ) : null}
        {needsPolicy ? (
          <div className="flex flex-col gap-3">
            <p className="text-fg-2">These tasks wait for this one: {pending.successors!.map((s) => s.title ?? 'a task you cannot view').join(', ')}.</p>
            <RadioGroup
              label="What happens to waiting tasks"
              value={policy}
              onValueChange={setPolicy}
              options={[
                { value: 'keep_blocked', label: 'Keep Blocked', description: 'They stay blocked until someone decides.' },
                { value: 'remove_dependency', label: 'Remove Dependency', description: 'They no longer wait for this task.' },
                { value: 'replace', label: 'Replace', description: 'They wait for another task instead.' },
              ]}
            />
            {policy === 'replace' ? (
              <Field label="Replacement task" required>
                <EntitySelect type="task" filters={{ projectId: task.project.id }} value={replacement} onChange={setReplacement} />
              </Field>
            ) : null}
          </div>
        ) : null}
        {canBackdate ? (
          <Field label="Effective completion date (optional)" helper="Backdated correction by a lead. The audit keeps the real time of this change.">
            <DateTimeInput value={backdate} onChange={(e) => setBackdate(e.target.value)} timezone={user.timezone} max={toLocalInput(new Date().toISOString(), user.timezone)} />
          </Field>
        ) : null}
        {needsReason || o.needsReason ? (
          <Field label="Reason" required>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={LIMITS.reasonMax} />
          </Field>
        ) : (
          <Field label="Note (optional)">
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={LIMITS.reasonMax} className="min-h-[72px]" />
          </Field>
        )}
      </div>
    </Dialog>
  );
};

export const BlockDialog = ({ open, onOpenChange, task }: { open: boolean; onOpenChange: (o: boolean) => void; task: TaskDetail }) => {
  const { workspace, user } = useWorkspace();
  const [reason, setReason] = useState('');
  const [next, setNext] = useState('');
  const blocking = !task.blocked;
  const block = useApiMutation(taskEndpoints.block, { invalidate: TASK_INVALIDATE, successMessage: 'Task marked as blocked' });
  const unblock = useApiMutation(taskEndpoints.unblock, { invalidate: TASK_INVALIDATE, successMessage: 'Blocker resolved' });
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) {
          setReason('');
          setNext('');
        }
      }}
      title={blocking ? 'Block task' : 'Resolve blocker'}
      body={blocking ? 'The status stays the same; the Blocked flag and the reason are shown to everyone working on the task.' : `Blocked since ${formatDateTime(task.blocked?.since, user.timezone)}: ${task.blocked?.reason ?? ''}`}
      confirmLabel={blocking ? 'Block' : 'Unblock'}
      loading={block.isPending || unblock.isPending}
      confirmDisabled={reason.trim().length < 3}
      onConfirm={async () => {
        if (blocking)
          await block.run({ params: { workspaceId: workspace.id, taskId: task.id }, body: { reason: reason.trim(), nextCheckAt: next ? fromLocalInput(next, user.timezone) : null } }, { ifMatch: task.rowVersion });
        else await unblock.run({ params: { workspaceId: workspace.id, taskId: task.id }, body: { resolution: reason.trim() } }, { ifMatch: task.rowVersion });
        onOpenChange(false);
        setReason('');
      }}
    >
      <Field label={blocking ? 'Reason' : 'Resolution'} required>
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={LIMITS.reasonMax} />
      </Field>
      {blocking ? (
        <Field label="Next check (optional)">
          <DateTimeInput value={next} onChange={(e) => setNext(e.target.value)} timezone={user.timezone} />
        </Field>
      ) : null}
    </ConfirmDialog>
  );
};

type DueBody = DueInputBody;

/**
 * Reschedule with a computed preview of dependent tasks; nothing moves before Apply. The Timeline
 * passes `proposedDueDate` (a bar moved to a new day): the preview then runs immediately.
 */
export const RescheduleDialog = ({
  open,
  onOpenChange,
  task,
  proposedDueDate,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  task: Pick<TaskDetail, 'id' | 'title' | 'due' | 'rowVersion'>;
  proposedDueDate?: string;
}) => {
  const { workspace, user } = useWorkspace();
  const [mode, setMode] = useState<'none' | 'date' | 'datetime'>('date');
  const [date, setDate] = useState('');
  const [dt, setDt] = useState('');
  const [tz, setTz] = useState(user.timezone);
  const [propagate, setPropagate] = useState(true);
  const [reason, setReason] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const tzOptions = useMemo(() => timezones().map((z) => ({ value: z, label: z })), []);
  const preview = useApiMutation(taskEndpoints.reschedulePreview, { silentErrors: true });
  const apply = useApiMutation(taskEndpoints.reschedule, { invalidate: TASK_INVALIDATE, successMessage: 'New dates applied' });
  const [error, setError] = useState<string | null>(null);
  const runPreview = async (body: { due: DueBody | null; propagate: boolean }) => {
    setError(null);
    try {
      const r = await preview.run({ params: { workspaceId: workspace.id, taskId: task.id }, body });
      setSelected(new Set(r.changes.filter((c) => c.task.id !== task.id && c.canApply).map((c) => c.task.id)));
    } catch (e) {
      setError(isApiError(e) ? (e.fieldErrors[0]?.message ?? e.message) : 'The preview failed.');
    }
  };
  useEffect(() => {
    if (!open) return;
    const zone = task.due?.timezone ?? user.timezone;
    setTz(zone);
    setReason('');
    setError(null);
    setPropagate(true);
    preview.reset();
    if (proposedDueDate && task.due && !task.due.date) {
      // Keep the time of day, move the calendar day.
      const time = toLocalInput(task.due.at, zone).slice(11);
      const local = `${proposedDueDate}T${time}`;
      setMode('datetime');
      setDate('');
      setDt(local);
      void runPreview({ due: { kind: 'datetime', at: fromLocalInput(local, zone)!, timezone: zone }, propagate: true });
    } else if (proposedDueDate) {
      setMode('date');
      setDate(proposedDueDate);
      setDt('');
      void runPreview({ due: { kind: 'date', date: proposedDueDate, timezone: zone }, propagate: true });
    } else {
      setMode(!task.due ? 'none' : task.due.date ? 'date' : 'datetime');
      setDate(task.due?.date ?? '');
      setDt(task.due && !task.due.date ? toLocalInput(task.due.at, zone) : '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, proposedDueDate]);
  const due = mode === 'none' ? null : mode === 'date' ? (date ? { kind: 'date' as const, date, timezone: tz } : undefined) : dt ? { kind: 'datetime' as const, at: fromLocalInput(dt, tz)!, timezone: tz } : undefined;
  const changes = preview.data?.changes ?? [];
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="wide"
      title={proposedDueDate ? `Move “${task.title}”` : 'Reschedule'}
      description="Preview how dependent tasks move. Tasks you cannot edit are shown but never moved silently."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            loading={preview.isPending}
            disabled={due === undefined}
            onClick={() => void runPreview({ due: due ?? null, propagate })}
          >
            Preview
          </Button>
          <Button
            variant="primary"
            disabled={!preview.data}
            loading={apply.isPending}
            onClick={async () => {
              try {
                await apply.run({ params: { workspaceId: workspace.id, taskId: task.id }, body: { previewToken: preview.data!.token, applyTaskIds: [...selected], reason: reason.trim() || undefined } }, { ifMatch: task.rowVersion });
                onOpenChange(false);
              } catch (e) {
                setError(isApiError(e) ? e.message : 'The new dates were not applied.');
                preview.reset();
              }
            }}
          >
            Apply
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <RadioGroup
          label="Deadline"
          orientation="horizontal"
          value={mode}
          onValueChange={(v) => {
            setMode(v);
            preview.reset();
          }}
          options={[
            { value: 'none', label: 'No Deadline' },
            { value: 'date', label: 'Date' },
            { value: 'datetime', label: 'Date and time' },
          ]}
        />
        {mode !== 'none' ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {mode === 'date' ? (
              <Field label="New due date">
                <DateInput value={date} onChange={(e) => { setDate(e.target.value); preview.reset(); }} />
              </Field>
            ) : (
              <Field label="New deadline">
                <DateTimeInput value={dt} onChange={(e) => { setDt(e.target.value); preview.reset(); }} timezone={tz} />
              </Field>
            )}
            <Field label="Time zone">
              <Select value={tz} onChange={(v) => { setTz(v ?? user.timezone); preview.reset(); }} options={tzOptions} searchable />
            </Field>
          </div>
        ) : null}
        <Checkbox checked={propagate} onCheckedChange={(v) => { setPropagate(v); preview.reset(); }} label="Move dependent tasks when needed" description="Finish-to-Start: waiting tasks are pushed later only when they would start before this deadline." />
        <Field label="Reason (optional)">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={LIMITS.reasonMax} className="min-h-[72px]" />
        </Field>
        {preview.data ? (
          <div className="overflow-x-auto rounded-[12px] border border-line">
            <table className="w-full min-w-[640px] text-left text-[13px]">
              <caption className="sr-only">Previewed date changes</caption>
              <thead>
                <tr className="h-10 border-b border-line text-[12px] text-fg-2">
                  <th className="px-3">Apply</th>
                  <th className="px-3">Task</th>
                  <th className="px-3">Due now</th>
                  <th className="px-3">New due</th>
                </tr>
              </thead>
              <tbody>
                {changes.map((c) => (
                  <tr key={c.task.id} className="h-11 border-b border-line last:border-0">
                    <td className="px-3">
                      {c.task.id === task.id ? (
                        <span className="text-fg-2">This task</span>
                      ) : c.canApply ? (
                        <Checkbox
                          aria-label={`Move ${c.task.title ?? 'task'}`}
                          checked={selected.has(c.task.id)}
                          onCheckedChange={(v) => setSelected((s) => { const n = new Set(s); if (v) n.add(c.task.id); else n.delete(c.task.id); return n; })}
                        />
                      ) : (
                        <span className="text-fg-2">Owner decides</span>
                      )}
                    </td>
                    <td className="px-3">{c.task.title ?? 'A task you cannot view'}</td>
                    <td className="px-3">{c.fromDue ? formatDateTime(c.fromDue, user.timezone) : 'No Deadline'}</td>
                    <td className="px-3 font-medium">{c.toDue ? formatDateTime(c.toDue, user.timezone) : 'No Deadline'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
};

export const DuplicateDialog = ({ open, onOpenChange, task, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; task: TaskDetail; onCreated: (id: string) => void }) => {
  const { workspace } = useWorkspace();
  const FIELDS = [
    ['description', 'Description'],
    ['checklist', 'Checklist (unticked)'],
    ['assignee', 'Assignee'],
    ['reviewer', 'Reviewer'],
    ['estimate', 'Estimate'],
    ['priority', 'Priority'],
    ['tags', 'Tags'],
    ['links', 'Linked records'],
    ['attachments', 'Attachment links'],
  ] as const;
  const [fields, setFields] = useState<Set<string>>(new Set(['description', 'checklist', 'estimate', 'tags', 'links']));
  const [project, setProject] = useState<string | null>(task.project.id);
  const dup = useApiMutation(taskEndpoints.duplicate, { invalidate: TASK_INVALIDATE, successMessage: 'Task duplicated as a new Draft' });
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Duplicate as new Draft"
      body="Status, history, time, comments and completion are never copied."
      confirmLabel="Duplicate"
      loading={dup.isPending}
      confirmDisabled={!project}
      onConfirm={async () => {
        const r = await dup.run({ params: { workspaceId: workspace.id, taskId: task.id }, body: { targetProjectId: project ?? undefined, copiedFields: [...fields] as never } });
        onOpenChange(false);
        onCreated(r.id);
      }}
    >
      <Field label="Project">
        <EntitySelect type="project" value={project} onChange={setProject} />
      </Field>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-[12px] font-[550] text-fg">Copy</legend>
        {FIELDS.map(([k, l]) => (
          <Checkbox
            key={k}
            label={l}
            checked={fields.has(k)}
            onCheckedChange={(v) => setFields((s) => { const n = new Set(s); if (v) n.add(k); else n.delete(k); return n; })}
          />
        ))}
      </fieldset>
    </ConfirmDialog>
  );
};

/** Personal reminder: never changes the task's deadline. */
export const ReminderDialog = ({ open, onOpenChange, taskId }: { open: boolean; onOpenChange: (o: boolean) => void; taskId: string }) => {
  const { workspace, user } = useWorkspace();
  const [at, setAt] = useState('');
  const [note, setNote] = useState('');
  const create = useApiMutation(reminderEndpoints.create, { invalidate: ['reminders.', 'myWork.'], successMessage: 'Reminder set' });
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) {
          setAt('');
          setNote('');
        }
      }}
      title="Remind me"
      body="Only you get this reminder. It never changes the task’s deadline."
      confirmLabel="Set Reminder"
      loading={create.isPending}
      confirmDisabled={!at}
      onConfirm={async () => {
        await create.run({ params: { workspaceId: workspace.id }, body: { entityType: 'task', entityId: taskId, remindAt: fromLocalInput(at, user.timezone)!, note: note.trim() || undefined } });
        onOpenChange(false);
      }}
    >
      <Field label="Remind at" required>
        <DateTimeInput value={at} onChange={(e) => setAt(e.target.value)} timezone={user.timezone} min={toLocalInput(new Date().toISOString(), user.timezone)} />
      </Field>
      <Field label="Note (optional)">
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} className="min-h-[72px]" />
      </Field>
    </ConfirmDialog>
  );
};
