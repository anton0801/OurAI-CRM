'use client';
import { BellSimple, CheckSquare, DotsThree, Plus } from '@phosphor-icons/react';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { MY_WORK_TASK_SECTIONS, myWorkEndpoints, reminderEndpoints, taskEndpoints, type ReminderView, type TaskRow } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import {
  Badge,
  Button,
  ConfirmDialog,
  DateTimeInput,
  EmptyState,
  Field,
  IconButton,
  Menu,
  PageHeader,
  Panel,
  TabPanel,
  Tabs,
  formatDate,
  formatDateTime,
  toast,
  type MenuItem,
} from '@castlane/ui';
import { QueryState } from '@/components/common/query-state';
import { useApiMutation, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { MY_WORK_SECTIONS } from '@/lib/slots';
import { useUrlState } from '@/lib/url-state';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';
import '@/features/slots';
import { DueText, Person, PriorityBadge, TaskStatusBadge, fromLocalInput, toLocalInput } from '@/features/tasks/format';
import { TASK_INVALIDATE } from '@/features/tasks/task-actions';
import { TaskDrawer } from '@/features/tasks/task-drawer';
import { TaskForm } from '@/features/tasks/task-form';
import { RunningTimerPanel, TaskTimerControl } from '@/features/time/timer';

type Section = (typeof MY_WORK_TASK_SECTIONS)[number];

const SECTION_LABELS: Record<Section, string> = {
  today: 'Today',
  upcoming: 'Upcoming',
  overdue: 'Overdue',
  assigned: 'Assigned to Me',
  reviewing: 'Reviewing',
  following: 'Following',
};

const SECTION_EMPTY: Record<Section, { title: string; description: string }> = {
  today: { title: 'Nothing due today', description: 'Tasks due or starting today in your time zone appear here.' },
  upcoming: { title: 'Nothing upcoming', description: 'Tasks due in the next 7 days appear here.' },
  overdue: { title: 'Nothing overdue', description: 'Tasks past their deadline appear here until they are done or rescheduled.' },
  assigned: { title: 'No open tasks assigned to you', description: 'Tasks where you are the assignee appear here. Unassigned tasks are not listed.' },
  reviewing: { title: 'Nothing to review', description: 'Tasks where you are the reviewer appear here.' },
  following: { title: 'You follow no open tasks', description: 'Follow a task to keep track of it. Following never opens a task you cannot access.' },
};

/** Quick next step for a row; the server re-checks predecessors, checklist and review policy. */
const nextStep = (t: TaskRow, me: string): { to: string; label: string } | null => {
  if (t.assignee?.membershipId !== me) return null;
  if (t.status === 'ready' || t.status === 'backlog') return { to: 'in_progress', label: 'Start Work' };
  if (t.status === 'in_progress') return t.reviewer ? { to: 'in_review', label: 'Submit for Review' } : { to: 'done', label: 'Complete' };
  return null;
};

const TaskRowItem = ({ task, section, onOpen }: { task: TaskRow; section: Section; onOpen: (id: string) => void }) => {
  const { workspace, user, membershipId } = useWorkspace();
  const can = useCan();
  const step = nextStep(task, membershipId);
  const transition = useApiMutation(taskEndpoints.transition, { invalidate: TASK_INVALIDATE, silentErrors: true });
  const run = async () => {
    if (!step) return;
    try {
      await transition.run({ params: { workspaceId: workspace.id, taskId: task.id }, body: { targetState: step.to as never } }, { ifMatch: task.rowVersion });
      toast.success(`${label('taskStatus', step.to)}: ${task.title}`);
    } catch (e) {
      toast.error(isApiError(e) ? e.message : 'The task was not changed.', 'Open the task to see what is missing.');
    }
  };
  const showTimer = can('time.write.own') && task.assignee?.membershipId === membershipId && task.status !== 'done' && task.status !== 'cancelled';
  return (
    <li className="flex flex-col gap-2 px-4 py-3 md:flex-row md:items-center md:justify-between">
      <div className="flex min-w-0 flex-col gap-1">
        <button type="button" onClick={() => onOpen(task.id)} className="truncate text-left text-[14px] font-medium text-fg hover:underline focus-visible:outline-2 focus-visible:outline-[var(--c-focus)]">
          {task.title}
        </button>
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-fg-2">
          <span className="truncate">{task.project.name}</span>
          <TaskStatusBadge status={task.status} />
          {task.priority !== 'normal' ? <PriorityBadge priority={task.priority} /> : null}
          {task.blocked ? <Badge tone="warning">Blocked</Badge> : null}
          {task.checklist.mandatoryOpen ? <span>{task.checklist.mandatoryOpen} required checklist item(s) open</span> : null}
          {section === 'reviewing' || section === 'following' ? <Person member={task.assignee} /> : null}
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {task.due ? <DueText due={task.due} tz={user.timezone} overdue={task.overdue} compact /> : <span className="text-[12px] text-fg-2">No deadline</span>}
        {showTimer ? <TaskTimerControl taskId={task.id} size="sm" /> : null}
        {step ? (
          <Button size="sm" loading={transition.isPending} onClick={() => void run()}>
            {step.label}
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={() => onOpen(task.id)}>
          Open Task
        </Button>
      </div>
    </li>
  );
};

const SNOOZE_PRESETS: { label: string; at: (now: Date) => Date }[] = [
  { label: '1 hour', at: (n) => new Date(n.getTime() + 3_600_000) },
  { label: '3 hours', at: (n) => new Date(n.getTime() + 3 * 3_600_000) },
  { label: '1 day', at: (n) => new Date(n.getTime() + 86_400_000) },
];

const Reminders = ({ reminders, onOpen }: { reminders: ReminderView[]; onOpen: (id: string) => void }) => {
  const { workspace, user } = useWorkspace();
  const [custom, setCustom] = useState<ReminderView | null>(null);
  const [until, setUntil] = useState('');
  const snooze = useApiMutation(reminderEndpoints.snooze, { invalidate: ['reminders.', 'myWork.'], successMessage: 'Reminder snoozed. The deadline is unchanged.' });
  const dismiss = useApiMutation(reminderEndpoints.dismiss, { invalidate: ['reminders.', 'myWork.'], successMessage: 'Reminder dismissed' });
  const doSnooze = (r: ReminderView, at: Date) => void snooze.run({ params: { workspaceId: workspace.id, reminderId: r.id }, body: { until: at.toISOString() } }).catch(() => undefined);
  const now = Date.now();
  return (
    <Panel title="Reminders" description="Only you see these. Snoozing never moves a deadline." actions={<BellSimple size={18} className="text-fg-2" aria-hidden />}>
      <ul className="flex flex-col divide-y divide-line">
        {reminders.map((r) => {
          const due = new Date(r.effectiveAt).getTime() <= now;
          const items: MenuItem[] = [
            ...SNOOZE_PRESETS.map((p) => ({ label: `Snooze ${p.label}`, onSelect: () => doSnooze(r, p.at(new Date())) })),
            { label: 'Snooze until…', onSelect: () => { setUntil(''); setCustom(r); } },
            { label: 'Dismiss', separatorBefore: true, onSelect: () => void dismiss.run({ params: { workspaceId: workspace.id, reminderId: r.id }, body: {} }).catch(() => undefined) },
          ];
          return (
            <li key={r.id} className="flex items-start justify-between gap-2 py-2 first:pt-0 last:pb-0">
              <div className="flex min-w-0 flex-col gap-0.5">
                <button type="button" onClick={() => onOpen(r.entityId)} className="truncate text-left text-[13px] font-medium text-fg hover:underline">
                  {r.title}
                </button>
                <span className="text-[12px] text-fg-2">
                  {r.source === 'due' ? (r.threshold ? label('reminderThreshold', r.threshold) : 'Due reminder') : 'Personal reminder'} · {due ? 'now' : formatDateTime(r.effectiveAt, user.timezone)}
                  {r.snoozedUntil ? ' (snoozed)' : ''}
                </span>
                {r.entityDueAt ? <span className="text-[12px] text-fg-2">Deadline {formatDateTime(r.entityDueAt, user.timezone)}</span> : null}
                {r.note ? <span className="text-[12px] text-fg">{r.note}</span> : null}
              </div>
              <Menu label={`Reminder actions for ${r.title ?? 'task'}`} trigger={<IconButton label="Snooze or dismiss" icon={<DotsThree size={16} weight="bold" />} />} items={items} />
            </li>
          );
        })}
      </ul>
      <ConfirmDialog
        open={!!custom}
        onOpenChange={(o) => !o && setCustom(null)}
        title="Snooze until"
        body="The reminder comes back at this time. The task deadline stays as it is."
        confirmLabel="Snooze"
        loading={snooze.isPending}
        confirmDisabled={!until}
        onConfirm={async () => {
          const at = fromLocalInput(until, user.timezone);
          if (!at || !custom) return;
          await snooze.run({ params: { workspaceId: workspace.id, reminderId: custom.id }, body: { until: at } });
          setCustom(null);
        }}
      >
        <Field label="Snooze until" required>
          <DateTimeInput value={until} onChange={(e) => setUntil(e.target.value)} timezone={user.timezone} min={toLocalInput(new Date().toISOString(), user.timezone)} />
        </Field>
      </ConfirmDialog>
    </Panel>
  );
};

/** S09 My Work: the member's own actions. Sections from other modules follow the task sections. */
export const MyWorkScreen = () => {
  const { workspace, user, membershipId } = useWorkspace();
  const can = useCan();
  const wsPath = useWsPath();
  const { state, set } = useUrlState<'section' | 'open' | 'create'>({ section: 'today' });
  const created = useRef<string | null>(null);
  const q = useApiQuery(myWorkEndpoints.get, { params: { workspaceId: workspace.id }, query: { limit: 30 } });
  const section = (MY_WORK_TASK_SECTIONS as readonly string[]).includes(state.section ?? '') ? (state.section as Section) : 'today';
  const extra = MY_WORK_SECTIONS.items.filter((i) => !i.visible || i.visible({}, can));
  const more: MenuItem[] = [
    { label: 'Time Entries', href: wsPath('/time'), hidden: !can(['time.read.own', 'time.read.scope', 'time.write.own']) },
    { label: 'Workload', href: wsPath('/team/workload'), hidden: !can('workload.read') },
    { label: 'All Tasks', href: wsPath('/tasks'), hidden: !can('tasks.read') },
  ];
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="My Work"
        description={q.data ? `Today is ${formatDate(q.data.today)} in ${q.data.timezone}.` : `Your tasks, reviews and reminders in ${user.timezone}.`}
        actions={
          <>
            {can('tasks.create') ? (
              <Button variant="primary" icon={<Plus size={14} />} onClick={() => set({ create: '1' })}>
                New Task
              </Button>
            ) : null}
            {more.some((m) => !m.hidden) ? <Menu label="More" trigger={<IconButton label="More" icon={<DotsThree size={18} weight="bold" />} variant="secondary" />} items={more} /> : null}
          </>
        }
      />
      <QueryState query={q}>
        {q.data ? (
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <div className="flex min-w-0 flex-col gap-4 xl:col-span-2">
              {q.data.canReadTasks ? (
                <Tabs
                  label="My work sections"
                  value={section}
                  onValueChange={(v) => set({ section: v })}
                  items={MY_WORK_TASK_SECTIONS.map((s) => ({ value: s, label: SECTION_LABELS[s], count: q.data!.sections[s].total }))}
                >
                  {MY_WORK_TASK_SECTIONS.map((s) => {
                    const data = q.data!.sections[s];
                    return (
                      <TabPanel key={s} value={s}>
                        {data.items.length === 0 ? (
                          <EmptyState icon={<CheckSquare size={28} />} title={SECTION_EMPTY[s].title} description={SECTION_EMPTY[s].description} className="py-8" />
                        ) : (
                          <div className="rounded-[12px] border border-line bg-surface">
                            <ul className="flex flex-col divide-y divide-line" aria-label={SECTION_LABELS[s]}>
                              {data.items.map((t) => (
                                <TaskRowItem key={t.id} task={t} section={s} onOpen={(id) => set({ open: id })} />
                              ))}
                            </ul>
                            {data.total > data.items.length ? (
                              <div className="border-t border-line px-4 py-3 text-[13px] text-fg-2">
                                Showing {data.items.length} of {data.total}.{' '}
                                <Link className="text-fg underline" href={wsPath(s === 'reviewing' ? '/tasks?reviewer=me' : s === 'following' ? '/tasks?following=1' : s === 'overdue' ? '/tasks?assignee=me&overdue=1' : '/tasks?assignee=me')}>
                                  See all in Tasks
                                </Link>
                              </div>
                            ) : null}
                          </div>
                        )}
                      </TabPanel>
                    );
                  })}
                </Tabs>
              ) : (
                <EmptyState icon={<CheckSquare size={28} />} title="No task access" description="Your role does not include tasks. Other work assigned to you appears below." />
              )}
              {extra.map((item) => {
                const C = item.component;
                return (
                  <Panel key={item.key} title={item.label}>
                    <C />
                  </Panel>
                );
              })}
            </div>
            <div className="flex min-w-0 flex-col gap-4">
              <RunningTimerPanel />
              {q.data.reminders.length ? (
                <Reminders reminders={q.data.reminders} onOpen={(id) => set({ open: id })} />
              ) : (
                <Panel title="Reminders">
                  <p className="text-[13px] text-fg-2">No reminders in the next 7 days. Use Remind Me on a task to add one; due-soon reminders are added for your tasks automatically.</p>
                </Panel>
              )}
            </div>
          </div>
        ) : null}
      </QueryState>
      <TaskDrawer taskId={state.open} onClose={() => set({ open: null })} />
      <TaskForm
        open={state.create === '1'}
        defaults={{ assigneeMembershipId: membershipId }}
        onOpenChange={(o) => {
          if (o) return;
          const id = created.current;
          created.current = null;
          set(id ? { create: null, open: id } : { create: null });
        }}
        onSaved={(id) => (created.current = id)}
      />
    </div>
  );
};
