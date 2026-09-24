'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { taskEndpoints, type TaskCreateBody, type TaskDetail } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { LIMITS, TASK_PRIORITIES } from '@castlane/domain';
import { Banner, Button, Checkbox, DateInput, DateTimeInput, Drawer, Field, Input, RadioGroup, Select, Textarea } from '@castlane/ui';
import { ConflictDialog } from '@/components/common/conflict';
import { EntitySelect } from '@/components/common/entity-select';
import { MemberSelect } from '@/components/common/pickers';
import { applyFieldErrors, useApiMutation } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useCan, useWorkspace } from '@/lib/workspace-context';
import { fromLocalInput, timezones, toLocalInput } from './format';

const schema = z
  .object({
    title: z.string().trim().min(3, 'Use 3–200 characters.').max(200, 'Use 3–200 characters.'),
    projectId: z.string().uuid('Choose a project.'),
    description: z.string().max(LIMITS.noteMax),
    status: z.enum(['draft', 'backlog', 'ready']),
    priority: z.enum(TASK_PRIORITIES),
    assigneeMembershipId: z.string().nullable(),
    reviewerMembershipId: z.string().nullable(),
    startAt: z.string(),
    dueMode: z.enum(['none', 'date', 'datetime']),
    dueDate: z.string(),
    dueDateTime: z.string(),
    dueTimezone: z.string().min(1),
    estimateHours: z.string().regex(/^\d{0,4}$/, 'Whole hours'),
    estimateMinutes: z.string().regex(/^\d{0,2}$/, 'Minutes 0–59'),
    tags: z.string().max(1200),
    requiredForParent: z.boolean(),
    accountId: z.string().nullable(),
    contentItemId: z.string().nullable(),
    publicationId: z.string().nullable(),
    shiftId: z.string().nullable(),
    dealId: z.string().nullable(),
    checklist: z.string().max(10_000),
  })
  .superRefine((v, ctx) => {
    if (v.dueMode === 'date' && !v.dueDate) ctx.addIssue({ code: 'custom', path: ['dueDate'], message: 'Choose the due date.' });
    if (v.dueMode === 'datetime' && !v.dueDateTime) ctx.addIssue({ code: 'custom', path: ['dueDateTime'], message: 'Choose the due date and time.' });
    if (v.assigneeMembershipId && v.assigneeMembershipId === v.reviewerMembershipId)
      ctx.addIssue({ code: 'custom', path: ['reviewerMembershipId'], message: 'The reviewer must be someone other than the assignee.' });
    if (Number(v.estimateMinutes || 0) > 59) ctx.addIssue({ code: 'custom', path: ['estimateMinutes'], message: 'Minutes 0–59' });
  });
type Values = z.infer<typeof schema>;

const split = (v: string) =>
  v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export interface TaskFormProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Edit an existing task; otherwise create. */
  task?: TaskDetail;
  /** Defaults for a new task (project tab, subtask, quick create). */
  defaults?: Partial<Pick<Values, 'projectId' | 'assigneeMembershipId' | 'status' | 'accountId' | 'contentItemId'>>;
  parentTaskId?: string;
  onSaved?: (id: string) => void;
}

/** Create / edit drawer (S28). Nothing is created until Save; the drawer closes only after the server confirmed. */
export const TaskForm = ({ open, onOpenChange, task, defaults, parentTaskId, onSaved }: TaskFormProps) => {
  const { workspace, user } = useWorkspace();
  const can = useCan();
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initial: Values = useMemo(
    () =>
      task
        ? {
            title: task.title,
            projectId: task.project.id,
            description: task.description ?? '',
            status: 'backlog',
            priority: task.priority,
            assigneeMembershipId: task.assignee?.membershipId ?? null,
            reviewerMembershipId: task.reviewer?.membershipId ?? null,
            startAt: toLocalInput(task.startAt, user.timezone),
            dueMode: !task.due ? 'none' : task.due.date ? 'date' : 'datetime',
            dueDate: task.due?.date ?? '',
            dueDateTime: task.due && !task.due.date ? toLocalInput(task.due.at, task.due.timezone ?? user.timezone) : '',
            dueTimezone: task.due?.timezone ?? user.timezone,
            estimateHours: task.estimateMinutes !== null ? String(Math.floor(task.estimateMinutes / 60)) : '',
            estimateMinutes: task.estimateMinutes !== null ? String(task.estimateMinutes % 60) : '',
            tags: task.tags.join(', '),
            requiredForParent: task.requiredForParent,
            accountId: task.linked.find((l) => l.type === 'account')?.id ?? null,
            contentItemId: task.linked.find((l) => l.type === 'content_item')?.id ?? null,
            publicationId: task.linked.find((l) => l.type === 'publication')?.id ?? null,
            shiftId: task.linked.find((l) => l.type === 'shift')?.id ?? null,
            dealId: task.linked.find((l) => l.type === 'deal')?.id ?? null,
            checklist: '',
          }
        : {
            title: '',
            projectId: defaults?.projectId ?? '',
            description: '',
            status: defaults?.status ?? 'backlog',
            priority: 'normal',
            assigneeMembershipId: defaults?.assigneeMembershipId ?? null,
            reviewerMembershipId: null,
            startAt: '',
            dueMode: 'none',
            dueDate: '',
            dueDateTime: '',
            dueTimezone: user.timezone,
            estimateHours: '',
            estimateMinutes: '',
            tags: '',
            requiredForParent: true,
            accountId: defaults?.accountId ?? null,
            contentItemId: defaults?.contentItemId ?? null,
            publicationId: null,
            shiftId: null,
            dealId: null,
            checklist: '',
          },
    [task, defaults, user.timezone],
  );
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: initial });
  // Start from fresh values each time the drawer opens (never while the member is typing).
  useEffect(() => {
    if (open) {
      form.reset(initial);
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const create = useApiMutation(taskEndpoints.create, { invalidate: ['tasks.', 'myWork.', 'workload.', 'projects.'], silentErrors: true, successMessage: 'Task created' });
  const createSub = useApiMutation(taskEndpoints.createSubtask, { invalidate: ['tasks.', 'myWork.', 'workload.'], silentErrors: true, successMessage: 'Subtask created' });
  const update = useApiMutation(taskEndpoints.update, { invalidate: ['tasks.', 'myWork.', 'workload.'], silentErrors: true, successMessage: 'Task saved' });
  const projectId = form.watch('projectId');
  const dueMode = form.watch('dueMode');
  const e = form.formState.errors;
  const canAssign = can('tasks.assign');
  const tzOptions = useMemo(() => timezones().map((z) => ({ value: z, label: z })), []);

  const onSubmit = form.handleSubmit(async (v) => {
    setError(null);
    const estimate = v.estimateHours || v.estimateMinutes ? Number(v.estimateHours || 0) * 60 + Number(v.estimateMinutes || 0) : null;
    const due =
      v.dueMode === 'none'
        ? null
        : v.dueMode === 'date'
          ? { kind: 'date' as const, date: v.dueDate, timezone: v.dueTimezone }
          : { kind: 'datetime' as const, at: fromLocalInput(v.dueDateTime, v.dueTimezone)!, timezone: v.dueTimezone };
    const full = {
      title: v.title.trim(),
      description: v.description.trim() || null,
      priority: v.priority,
      assigneeMembershipId: v.assigneeMembershipId,
      reviewerMembershipId: v.reviewerMembershipId,
      startAt: v.startAt ? fromLocalInput(v.startAt, user.timezone) : null,
      due,
      estimateMinutes: estimate,
      tags: split(v.tags),
      requiredForParent: v.requiredForParent,
      accountId: v.accountId,
      contentItemId: v.contentItemId,
      publicationId: v.publicationId,
      shiftId: v.shiftId,
      dealId: v.dealId,
    };
    try {
      if (task) {
        // Send only what changed: unchanged links or people are never re-validated or re-assigned.
        const dirty = form.formState.dirtyFields as Partial<Record<keyof Values, boolean>>;
        const patch: Record<string, unknown> = {};
        const map: [keyof Values, keyof typeof full][] = [
          ['title', 'title'],
          ['description', 'description'],
          ['priority', 'priority'],
          ['assigneeMembershipId', 'assigneeMembershipId'],
          ['reviewerMembershipId', 'reviewerMembershipId'],
          ['startAt', 'startAt'],
          ['tags', 'tags'],
          ['requiredForParent', 'requiredForParent'],
          ['accountId', 'accountId'],
          ['contentItemId', 'contentItemId'],
          ['publicationId', 'publicationId'],
          ['shiftId', 'shiftId'],
          ['dealId', 'dealId'],
        ];
        for (const [f, k] of map) if (dirty[f]) patch[k] = full[k];
        if (dirty.dueMode || dirty.dueDate || dirty.dueDateTime || dirty.dueTimezone) patch.due = full.due;
        if (dirty.estimateHours || dirty.estimateMinutes) patch.estimateMinutes = full.estimateMinutes;
        if (Object.keys(patch).length === 0) {
          onOpenChange(false);
          return;
        }
        const r = await update.run({ params: { workspaceId: workspace.id, taskId: task.id }, body: patch }, { ifMatch: task.rowVersion });
        onSaved?.(r.id);
      } else {
        const checklist = v.checklist
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => ({ label: l.replace(/^\*\s*/, ''), mandatory: l.startsWith('*') }));
        const body = { ...full, status: v.status, checklist: checklist.length ? checklist : undefined };
        const r = parentTaskId
          ? await createSub.run({ params: { workspaceId: workspace.id, taskId: parentTaskId }, body })
          : await create.run({ params: { workspaceId: workspace.id }, body: { ...body, projectId: v.projectId } as TaskCreateBody });
        onSaved?.(r.id);
      }
      onOpenChange(false);
    } catch (err) {
      if (isApiError(err) && err.code === 'VERSION_CONFLICT') setConflict(true);
      else if (!applyFieldErrors(err, form.setError as never)) setError(isApiError(err) ? err.message : 'The task could not be saved.');
      else setError('Some fields need attention.');
    }
  });

  const pending = create.isPending || update.isPending || createSub.isPending;
  const linkFilters = projectId ? { projectId } : undefined;
  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      width={760}
      title={task ? 'Edit Task' : parentTaskId ? 'New Subtask' : 'New Task'}
      description={task ? task.title : 'Nothing is created until you save.'}
      dirty={form.formState.isDirty}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" loading={pending} onClick={() => void onSubmit()}>
            {task ? 'Save Changes' : 'Create Task'}
          </Button>
        </>
      }
    >
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <Field label="Title" required error={e.title?.message}>
          <Input {...form.register('title')} maxLength={200} autoFocus />
        </Field>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Project" required error={e.projectId?.message} helper={task || parentTaskId ? 'A task stays in its project.' : undefined}>
            <Controller
              control={form.control}
              name="projectId"
              render={({ field }) => <EntitySelect type="project" value={field.value || null} onChange={(v) => field.onChange(v ?? '')} disabled={!!task || !!parentTaskId} />}
            />
          </Field>
          <Field label="Priority">
            <Controller
              control={form.control}
              name="priority"
              render={({ field }) => <Select value={field.value} onChange={(v) => field.onChange(v ?? 'normal')} options={TASK_PRIORITIES.map((p) => ({ value: p, label: label('taskPriority', p) }))} />}
            />
          </Field>
          <Field
            label="Assignee"
            error={e.assigneeMembershipId?.message}
            helper={!canAssign ? 'You can assign tasks to yourself. A lead assigns others.' : 'Only people with access to the project are listed.'}
          >
            <Controller
              control={form.control}
              name="assigneeMembershipId"
              render={({ field }) => (
                <MemberSelect value={field.value} onChange={field.onChange} projectId={projectId || undefined} permission="tasks.read" clearable placeholder="Unassigned" disabled={!projectId} />
              )}
            />
          </Field>
          <Field label="Reviewer" error={e.reviewerMembershipId?.message} helper="With a reviewer, the task passes In Review and the reviewer completes it.">
            <Controller
              control={form.control}
              name="reviewerMembershipId"
              render={({ field }) => (
                <MemberSelect value={field.value} onChange={field.onChange} projectId={projectId || undefined} permission="tasks.read" clearable placeholder="No review" disabled={!projectId || !canAssign} />
              )}
            />
          </Field>
          {!task ? (
            <Field label="Status">
              <Controller
                control={form.control}
                name="status"
                render={({ field }) => (
                  <Select value={field.value} onChange={(v) => field.onChange(v ?? 'backlog')} options={(['draft', 'backlog', 'ready'] as const).map((s) => ({ value: s, label: label('taskStatus', s) }))} />
                )}
              />
            </Field>
          ) : null}
          <Field label="Estimate" error={e.estimateHours?.message ?? e.estimateMinutes?.message} helper="Leave empty when unknown — it is shown as unestimated, never as zero hours.">
            <div className="flex items-center gap-2">
              <Input {...form.register('estimateHours')} inputMode="numeric" aria-label="Estimate hours" className="w-20" placeholder="h" />
              <span className="text-[13px] text-fg-2">h</span>
              <Input {...form.register('estimateMinutes')} inputMode="numeric" aria-label="Estimate minutes" className="w-20" placeholder="min" />
              <span className="text-[13px] text-fg-2">min</span>
            </div>
          </Field>
        </div>
        <Field label="Description" error={e.description?.message}>
          <Textarea {...form.register('description')} maxLength={LIMITS.noteMax} />
        </Field>
        <fieldset className="flex flex-col gap-3 rounded-[12px] border border-line p-4">
          <legend className="px-1 text-[12px] font-[550] text-fg">Dates</legend>
          <Field label="Start" helper={`Time zone: ${user.timezone}`}>
            <DateTimeInput {...form.register('startAt')} timezone={user.timezone} />
          </Field>
          <Controller
            control={form.control}
            name="dueMode"
            render={({ field }) => (
              <RadioGroup
                label="Deadline"
                orientation="horizontal"
                value={field.value}
                onValueChange={field.onChange}
                options={[
                  { value: 'none', label: 'No Deadline' },
                  { value: 'date', label: 'Date', description: 'Due by end of day' },
                  { value: 'datetime', label: 'Date and time' },
                ]}
              />
            )}
          />
          {dueMode !== 'none' ? (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {dueMode === 'date' ? (
                <Field label="Due date" required error={e.dueDate?.message}>
                  <DateInput {...form.register('dueDate')} />
                </Field>
              ) : (
                <Field label="Due date and time" required error={e.dueDateTime?.message}>
                  <DateTimeInput {...form.register('dueDateTime')} timezone={form.watch('dueTimezone')} />
                </Field>
              )}
              <Field label="Deadline time zone" helper="The same deadline is shown to everyone in their own time.">
                <Controller control={form.control} name="dueTimezone" render={({ field }) => <Select value={field.value} onChange={(v) => field.onChange(v ?? user.timezone)} options={tzOptions} searchable />} />
              </Field>
            </div>
          ) : null}
        </fieldset>
        <fieldset className="flex flex-col gap-3 rounded-[12px] border border-line p-4">
          <legend className="px-1 text-[12px] font-[550] text-fg">Linked records</legend>
          <p className="text-[12px] text-fg-2">Optional. Only records from the same project that you can see are offered.</p>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label="Account" error={e.accountId?.message}>
              <Controller control={form.control} name="accountId" render={({ field }) => <EntitySelect type="account" filters={linkFilters} value={field.value} onChange={field.onChange} clearable disabled={!projectId} />} />
            </Field>
            <Field label="Content" error={e.contentItemId?.message}>
              <Controller control={form.control} name="contentItemId" render={({ field }) => <EntitySelect type="content_item" filters={linkFilters} value={field.value} onChange={field.onChange} clearable disabled={!projectId} />} />
            </Field>
            <Field label="Publication" error={e.publicationId?.message}>
              <Controller control={form.control} name="publicationId" render={({ field }) => <EntitySelect type="publication" filters={linkFilters} value={field.value} onChange={field.onChange} clearable disabled={!projectId} />} />
            </Field>
            <Field label="Shift" error={e.shiftId?.message}>
              <Controller control={form.control} name="shiftId" render={({ field }) => <EntitySelect type="shift" filters={linkFilters} value={field.value} onChange={field.onChange} clearable disabled={!projectId} />} />
            </Field>
            <Field label="Deal" error={e.dealId?.message}>
              <Controller control={form.control} name="dealId" render={({ field }) => <EntitySelect type="deal" value={field.value} onChange={field.onChange} clearable />} />
            </Field>
            <Field label="Tags" helper="Comma-separated, up to 30." error={e.tags?.message}>
              <Input {...form.register('tags')} />
            </Field>
          </div>
        </fieldset>
        {!task ? (
          <Field label="Checklist" helper="One item per line. Start a line with * to make the item mandatory (it blocks completion).">
            <Textarea {...form.register('checklist')} placeholder={'* Upload the final file\nCheck captions'} />
          </Field>
        ) : null}
        {parentTaskId || task?.parent ? (
          <Controller
            control={form.control}
            name="requiredForParent"
            render={({ field }) => (
              <Checkbox checked={field.value} onCheckedChange={field.onChange} label="Required for the parent task" description="The parent can complete only when this subtask is Done, or Cancelled with an accepted reason." />
            )}
          />
        ) : null}
      </form>
      <ConflictDialog open={conflict} onOpenChange={setConflict} onReload={() => { setConflict(false); onOpenChange(false); }} />
    </Drawer>
  );
};
