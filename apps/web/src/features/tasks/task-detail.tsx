'use client';
import { ArrowsOutSimple, BellSimple, CalendarBlank, Copy, DotsThree, Eye, EyeSlash, PencilSimple, Prohibit, Repeat } from '@phosphor-icons/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { taskEndpoints, type TaskDetail as Detail } from '@castlane/api-contracts';
import { Badge, Banner, Button, DescriptionList, IconButton, Menu, PageHeader, Panel, formatDateTime, type MenuItem } from '@castlane/ui';
import { CommentThread } from '@/components/comments/comment-thread';
import { QueryState } from '@/components/common/query-state';
import { useApiMutation, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useWorkspace, useWsPath } from '@/lib/workspace-context';
import { TaskTimerControl } from '../time/timer';
import { DueText, Person, PriorityBadge, TaskStatusBadge, formatMinutes, formatSeconds } from './format';
import { BlockDialog, DuplicateDialog, ReminderDialog, RescheduleDialog, TASK_INVALIDATE, useTransitions } from './task-actions';
import { TaskForm } from './task-form';
import { AttachmentsSection, ChecklistSection, DependenciesSection, HistorySection, SubtasksSection } from './task-sections';

/** Primary status actions, most relevant first. */
const PRIMARY: string[] = ['in_progress', 'in_review', 'done', 'ready'];

const TaskBody = ({ task, variant }: { task: Detail; variant: 'page' | 'drawer' }) => {
  const { workspace, user } = useWorkspace();
  const wsPath = useWsPath();
  const router = useRouter();
  const [editOpen, setEditOpen] = useState(false);
  const [blockOpen, setBlockOpen] = useState(false);
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [dupOpen, setDupOpen] = useState(false);
  const [remindOpen, setRemindOpen] = useState(false);
  const { trigger, dialog, pendingAction } = useTransitions(task);
  const follow = useApiMutation(taskEndpoints.follow, { invalidate: TASK_INVALIDATE, successMessage: (d) => (d.following ? 'You follow this task' : 'You no longer follow this task') });
  const allowed = task.transitions.filter((t) => t.allowed);
  const primary = [...allowed].sort((a, b) => PRIMARY.indexOf(a.to) - PRIMARY.indexOf(b.to)).filter((t) => t.to !== 'cancelled').slice(0, 2);
  const unavailable = task.transitions.filter((t) => !t.allowed && t.reason && t.to !== 'cancelled');
  const cancel = task.transitions.find((t) => t.to === 'cancelled' && t.allowed);
  const menu: MenuItem[] = [
    ...allowed.filter((t) => !primary.includes(t) && t.to !== 'cancelled').map((t) => ({ label: t.label, onSelect: () => trigger(t) })),
    { label: task.blocked ? 'Resolve Blocker' : 'Block', icon: <Prohibit size={14} />, onSelect: () => setBlockOpen(true), hidden: !task.permissions.block, separatorBefore: true },
    { label: 'Reschedule…', icon: <CalendarBlank size={14} />, onSelect: () => setRescheduleOpen(true), hidden: !task.permissions.edit },
    { label: 'Duplicate', icon: <Copy size={14} />, onSelect: () => setDupOpen(true), hidden: !task.permissions.duplicate },
    { label: 'Remind Me', icon: <BellSimple size={14} />, onSelect: () => setRemindOpen(true) },
    {
      label: task.following ? 'Unfollow' : 'Follow',
      icon: task.following ? <EyeSlash size={14} /> : <Eye size={14} />,
      onSelect: () => void follow.run({ params: { workspaceId: workspace.id, taskId: task.id }, body: { following: !task.following } }),
    },
    { label: 'Open Full Page', icon: <ArrowsOutSimple size={14} />, onSelect: () => router.push(wsPath(`/tasks/${task.id}`)), hidden: variant === 'page' },
    ...(cancel ? [{ label: 'Cancel Task', destructive: true, onSelect: () => trigger(cancel), separatorBefore: true }] : []),
  ];
  const actions = (
    <>
      {primary.map((t, i) => (
        <Button key={t.to} variant={i === 0 ? 'primary' : 'secondary'} loading={pendingAction} onClick={() => trigger(t)}>
          {t.label}
        </Button>
      ))}
      {task.permissions.edit ? (
        <Button icon={<PencilSimple size={14} />} onClick={() => setEditOpen(true)}>
          Edit
        </Button>
      ) : null}
      <Menu label="More actions" trigger={<IconButton label="More actions" icon={<DotsThree size={18} weight="bold" />} variant="secondary" />} items={menu} />
    </>
  );
  return (
    <div className="flex flex-col gap-5">
      {variant === 'page' ? (
        <PageHeader
          crumbs={[{ label: 'Tasks', href: wsPath('/tasks') }, ...(task.parent?.readable ? [{ label: task.parent.title ?? 'Parent', href: wsPath(`/tasks/${task.parent.id}`) }] : []), { label: task.title }]}
          title={task.title}
          meta={<Meta task={task} />}
          actions={actions}
        />
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Meta task={task} />
          </div>
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        </div>
      )}
      {task.blocked ? (
        <Banner tone="warning" action={task.permissions.block ? <Button size="sm" onClick={() => setBlockOpen(true)}>Resolve Blocker</Button> : undefined}>
          Blocked since {formatDateTime(task.blocked.since, user.timezone)}: {task.blocked.reason}
          {task.blocked.nextCheckAt ? ` · next check ${formatDateTime(task.blocked.nextCheckAt, user.timezone)}` : ''}
        </Banner>
      ) : null}
      {task.status === 'cancelled' ? <Banner tone="info">Cancelled: {task.cancelReason}{task.cancellationAccepted ? '' : ' (cancellation not yet accepted by a lead)'}</Banner> : null}
      {unavailable.length && task.status !== 'done' && task.status !== 'cancelled' ? (
        <ul className="flex flex-col gap-1 text-[12px] text-fg-2" aria-label="Unavailable actions">
          {unavailable.slice(0, 3).map((t) => (
            <li key={t.to}>
              {t.label}: {t.reason}
            </li>
          ))}
        </ul>
      ) : null}
      <div className={variant === 'page' ? 'grid grid-cols-1 gap-4 xl:grid-cols-3' : 'flex flex-col gap-4'}>
        <div className="flex min-w-0 flex-col gap-4 xl:col-span-2">
          <Panel title="Description">
            {task.description ? <p className="whitespace-pre-wrap text-[14px] leading-[22px] text-fg">{task.description}</p> : <p className="text-[14px] text-fg-2">No description.</p>}
          </Panel>
          <ChecklistSection task={task} />
          <SubtasksSection task={task} />
          <DependenciesSection task={task} />
          <AttachmentsSection task={task} />
          <Panel title="Discussion">
            <CommentThread parentType="task" parentId={task.id} title="Comments" />
          </Panel>
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <Panel title="Details">
            <DescriptionList
              columns={1}
              items={[
                { label: 'Project', value: <Link href={wsPath(`/projects/${task.project.id}`)} className="hover:underline">{task.project.name}</Link> },
                { label: 'Assignee', value: <Person member={task.assignee} /> },
                { label: 'Reviewer', value: <Person member={task.reviewer} empty="No review" /> },
                { label: 'Priority', value: <PriorityBadge priority={task.priority} /> },
                { label: 'Start', value: task.startAt ? formatDateTime(task.startAt, user.timezone) : 'Not set' },
                { label: 'Deadline', value: <DueText due={task.due} tz={user.timezone} overdue={task.overdue} /> },
                { label: 'Estimate', value: formatMinutes(task.estimateMinutes) },
                { label: 'Recorded time', value: formatSeconds(task.time.loggedSeconds) },
                { label: 'Parent task', value: task.parent ? (task.parent.readable ? <Link href={wsPath(`/tasks/${task.parent.id}`)} className="hover:underline">{task.parent.title}</Link> : 'A task you cannot view') : null, hidden: !task.parent },
                { label: 'Parent completion', value: task.requiredForParent ? 'Required for the parent' : 'Optional for the parent', hidden: !task.parent },
                { label: 'Completed', value: task.completedAt ? `${formatDateTime(task.completedAt, user.timezone)}${task.completedBy ? ` by ${task.completedBy.displayName}` : ''}` : null, hidden: !task.completedAt },
                { label: 'Reopened', value: `${task.reopenCount} time(s) · cycle ${task.cycle}`, hidden: task.reopenCount === 0 },
                { label: 'Tags', value: task.tags.length ? task.tags.join(', ') : null },
                { label: 'Followers', value: task.followers.length ? task.followers.map((f) => f.displayName).join(', ') : null },
                { label: 'Source', value: label('taskSource', task.source) },
              ]}
            />
          </Panel>
          {task.permissions.trackTime ? (
            <Panel title="Time">
              <div className="flex flex-col gap-2">
                <p className="text-[13px] text-fg-2">Recorded: {formatSeconds(task.time.loggedSeconds)} · Estimate: {formatMinutes(task.estimateMinutes)}</p>
                <TaskTimerControl taskId={task.id} />
                <Link href={wsPath(`/time?task=${task.id}&add=1`)} className="text-[13px] text-primary hover:underline">
                  Add time manually
                </Link>
              </div>
            </Panel>
          ) : null}
          <Panel title="Linked records">
            {task.linked.length === 0 ? (
              <p className="text-[14px] text-fg-2">None.</p>
            ) : (
              <ul className="flex flex-col gap-1 text-[14px]">
                {task.linked.map((l) => (
                  <li key={`${l.type}:${l.id}`} className="flex items-center gap-2">
                    <Badge>{label('linkedType', l.type)}</Badge>
                    {l.href ? (
                      <Link href={l.href} className="truncate hover:underline">
                        {l.label}
                      </Link>
                    ) : (
                      <span className="text-fg-muted">A record you cannot view</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <HistorySection task={task} />
        </div>
      </div>
      {dialog}
      <TaskForm open={editOpen} onOpenChange={setEditOpen} task={task} />
      <BlockDialog open={blockOpen} onOpenChange={setBlockOpen} task={task} />
      <RescheduleDialog open={rescheduleOpen} onOpenChange={setRescheduleOpen} task={task} />
      <DuplicateDialog open={dupOpen} onOpenChange={setDupOpen} task={task} onCreated={(id) => router.push(wsPath(`/tasks/${id}`))} />
      <ReminderDialog open={remindOpen} onOpenChange={setRemindOpen} taskId={task.id} />
    </div>
  );
};

const Meta = ({ task }: { task: Detail }) => (
  <>
    <TaskStatusBadge status={task.status} />
    <PriorityBadge priority={task.priority} />
    {task.overdue ? <Badge tone="warning">Overdue</Badge> : null}
    {task.blocked ? <Badge tone="warning">Blocked</Badge> : null}
    {task.recurring ? <Badge icon={<Repeat size={12} aria-hidden />}>Recurring</Badge> : null}
    {task.source === 'template' ? <Badge>From template</Badge> : null}
  </>
);

/** Task detail loader for the full page (/tasks/:id) and the list drawer. */
export const TaskDetailView = ({ taskId, variant }: { taskId: string; variant: 'page' | 'drawer' }) => {
  const { workspace } = useWorkspace();
  const q = useApiQuery(taskEndpoints.get, { params: { workspaceId: workspace.id, taskId } });
  return <QueryState query={q}>{q.data ? <TaskBody task={q.data} variant={variant} /> : null}</QueryState>;
};

export const TaskPage = ({ taskId }: { taskId: string }) => <TaskDetailView taskId={taskId} variant="page" />;
