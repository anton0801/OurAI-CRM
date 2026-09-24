'use client';
import { ArrowRight, File, LinkBreak, Plus, Trash } from '@phosphor-icons/react';
import Link from 'next/link';
import { useState } from 'react';
import { mediaEndpoints, taskEndpoints, type TaskDetail } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { LIMITS } from '@castlane/domain';
import { Badge, Button, Checkbox, ConfirmDialog, EmptyState, Field, IconButton, Input, Panel, Switch, Textarea, formatBytes, formatDateTime, toast } from '@castlane/ui';
import { EntitySelect } from '@/components/common/entity-select';
import { QueryState } from '@/components/common/query-state';
import { AssetThumb, FileUploader } from '@/components/media/file-uploader';
import { useApiInfinite, useApiMutation, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useWorkspace, useWsPath } from '@/lib/workspace-context';
import { DueText, Person, TaskStatusBadge } from './format';
import { TASK_INVALIDATE } from './task-actions';
import { TaskForm } from './task-form';

export const ChecklistSection = ({ task }: { task: TaskDetail }) => {
  const { workspace } = useWorkspace();
  const [labelText, setLabelText] = useState('');
  const [mandatory, setMandatory] = useState(false);
  const add = useApiMutation(taskEndpoints.addChecklistItem, { invalidate: TASK_INVALIDATE, silentErrors: true });
  const update = useApiMutation(taskEndpoints.updateChecklistItem, { invalidate: TASK_INVALIDATE });
  const remove = useApiMutation(taskEndpoints.removeChecklistItem, { invalidate: TASK_INVALIDATE, successMessage: 'Checklist item removed' });
  const editable = task.permissions.manageChecklist;
  const done = task.checklistItems.filter((i) => i.done).length;
  return (
    <Panel title="Checklist" description={task.checklistItems.length ? `${done} of ${task.checklistItems.length} done · mandatory items block completion` : undefined}>
      {task.checklistItems.length === 0 ? <p className="text-[14px] text-fg-2">No checklist items.</p> : null}
      <ul className="flex flex-col gap-1">
        {task.checklistItems.map((i) => (
          <li key={i.id} className="group flex items-start justify-between gap-2 rounded-[8px] px-1 py-1 hover:bg-surface-2">
            <div className="flex min-w-0 items-start gap-2">
              <Checkbox
                checked={i.done}
                disabled={!editable || update.isPending}
                onCheckedChange={(v) => void update.run({ params: { workspaceId: workspace.id, taskId: task.id, itemId: i.id }, body: { done: v } }, { ifMatch: i.rowVersion })}
                aria-label={`Mark “${i.label}” ${i.done ? 'not done' : 'done'}`}
              />
              <span className={i.done ? 'text-[14px] text-fg-2 line-through' : 'text-[14px] text-fg'}>
                {i.label}
                {i.mandatory ? <Badge tone="warning" className="ml-2">Mandatory</Badge> : null}
                {i.doneBy && i.done ? <span className="ml-2 text-[12px] text-fg-muted">by {i.doneBy.displayName}</span> : null}
              </span>
            </div>
            {editable ? (
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void update.run({ params: { workspaceId: workspace.id, taskId: task.id, itemId: i.id }, body: { mandatory: !i.mandatory } }, { ifMatch: i.rowVersion })}
                >
                  {i.mandatory ? 'Make Optional' : 'Make Mandatory'}
                </Button>
                <IconButton
                  label={`Remove “${i.label}”`}
                  icon={<Trash size={16} />}
                  onClick={() => void remove.run({ params: { workspaceId: workspace.id, taskId: task.id, itemId: i.id }, body: {} }, { ifMatch: i.rowVersion })}
                />
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {editable ? (
        <form
          className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!labelText.trim()) return;
            try {
              await add.run({ params: { workspaceId: workspace.id, taskId: task.id }, body: { label: labelText.trim(), mandatory } });
              setLabelText('');
              setMandatory(false);
            } catch (err) {
              toast.error(isApiError(err) ? err.message : 'The item was not added.');
            }
          }}
        >
          <div className="min-w-0 flex-1">
            <Input value={labelText} onChange={(e) => setLabelText(e.target.value)} placeholder="Add checklist item" aria-label="New checklist item" maxLength={300} />
          </div>
          <Switch label="Mandatory" checked={mandatory} onCheckedChange={setMandatory} />
          <Button type="submit" icon={<Plus size={14} />} loading={add.isPending} disabled={!labelText.trim()}>
            Add
          </Button>
        </form>
      ) : null}
    </Panel>
  );
};

export const DependenciesSection = ({ task }: { task: TaskDetail }) => {
  const { workspace } = useWorkspace();
  const wsPath = useWsPath();
  const [pred, setPred] = useState<string | null>(null);
  const [removing, setRemoving] = useState<{ id: string; title: string | null } | null>(null);
  const [reason, setReason] = useState('');
  const add = useApiMutation(taskEndpoints.addDependency, { invalidate: TASK_INVALIDATE, successMessage: 'Dependency added', silentErrors: true });
  const remove = useApiMutation(taskEndpoints.removeDependency, { invalidate: TASK_INVALIDATE, successMessage: 'Dependency removed' });
  const row = (d: TaskDetail['predecessors'][number], removable: boolean) => (
    <li key={d.id} className="flex items-center justify-between gap-2 py-1.5">
      <span className="flex min-w-0 items-center gap-2 text-[14px]">
        {d.task.readable ? (
          <Link href={wsPath(`/tasks/${d.task.id}`)} className="truncate text-fg hover:underline">
            {d.task.title}
          </Link>
        ) : (
          <span className="text-fg-muted">A task you cannot view</span>
        )}
        {d.task.status ? <TaskStatusBadge status={d.task.status} /> : null}
        {d.overriddenAt ? <Badge tone="warning" title={d.overrideReason ?? undefined}>Overridden</Badge> : null}
      </span>
      {removable && task.permissions.edit ? (
        <IconButton label="Remove dependency" icon={<LinkBreak size={16} />} onClick={() => setRemoving({ id: d.id, title: d.task.title })} />
      ) : null}
    </li>
  );
  return (
    <Panel title="Dependencies" description="Finish-to-Start: a task starts after its predecessors are Done.">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div>
          <h3 className="text-[12px] font-[550] text-fg-2">Waits for</h3>
          {task.predecessors.length ? <ul className="divide-y divide-line">{task.predecessors.map((d) => row(d, true))}</ul> : <p className="mt-1 text-[14px] text-fg-2">Nothing.</p>}
        </div>
        <div>
          <h3 className="text-[12px] font-[550] text-fg-2">Blocks</h3>
          {task.successors.length ? <ul className="divide-y divide-line">{task.successors.map((d) => row(d, false))}</ul> : <p className="mt-1 text-[14px] text-fg-2">Nothing.</p>}
        </div>
      </div>
      {task.permissions.edit ? (
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
          <Field label="Add predecessor" className="min-w-0 flex-1">
            <EntitySelect type="task" value={pred} onChange={setPred} placeholder="Search tasks" />
          </Field>
          <Button
            icon={<ArrowRight size={14} />}
            disabled={!pred}
            loading={add.isPending}
            onClick={async () => {
              try {
                await add.run({ params: { workspaceId: workspace.id, taskId: task.id }, body: { predecessorId: pred! } });
                setPred(null);
              } catch (e) {
                const cycle = isApiError(e) ? ((e.details?.cycle as { title: string | null }[] | undefined) ?? null) : null;
                toast.error(isApiError(e) ? (e.fieldErrors[0]?.message ?? e.message) : 'The dependency was not added.', cycle ? `Cycle: ${cycle.map((c) => c.title ?? 'hidden task').join(' → ')}` : undefined);
              }
            }}
          >
            Add Dependency
          </Button>
        </div>
      ) : null}
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title="Remove dependency?"
        body={`This task will no longer wait for “${removing?.title ?? 'the predecessor'}”. The change is recorded with your reason.`}
        confirmLabel="Remove Dependency"
        loading={remove.isPending}
        confirmDisabled={reason.trim().length < 3}
        onConfirm={async () => {
          await remove.run({ params: { workspaceId: workspace.id, taskId: task.id, dependencyId: removing!.id }, body: { reason: reason.trim() } });
          setRemoving(null);
          setReason('');
        }}
      >
        <Field label="Reason" required>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={LIMITS.reasonMax} />
        </Field>
      </ConfirmDialog>
    </Panel>
  );
};

export const SubtasksSection = ({ task }: { task: TaskDetail }) => {
  const { workspace, user } = useWorkspace();
  const wsPath = useWsPath();
  const [open, setOpen] = useState(false);
  const accept = useApiMutation(taskEndpoints.acceptCancellation, { invalidate: TASK_INVALIDATE, successMessage: 'Cancellation accepted' });
  return (
    <Panel
      title="Subtasks"
      description={task.parentPolicy.requiredOpen || task.parentPolicy.unacceptedCancellations ? `${task.parentPolicy.requiredOpen} required open · ${task.parentPolicy.unacceptedCancellations} cancellation(s) awaiting acceptance — the parent cannot complete yet` : 'The parent completes when required subtasks are Done or Cancelled with an accepted reason.'}
      actions={
        task.permissions.createSubtask ? (
          <Button size="sm" icon={<Plus size={12} />} onClick={() => setOpen(true)}>
            Add Subtask
          </Button>
        ) : undefined
      }
    >
      {task.subtaskList.length === 0 ? (
        <p className="text-[14px] text-fg-2">No subtasks.</p>
      ) : (
        <ul className="divide-y divide-line">
          {task.subtaskList.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="flex min-w-0 items-center gap-2">
                <Link href={wsPath(`/tasks/${s.id}`)} className="truncate text-[14px] text-fg hover:underline">
                  {s.title}
                </Link>
                <TaskStatusBadge status={s.status} />
                {!s.requiredForParent ? <Badge>Optional</Badge> : null}
              </span>
              <span className="flex items-center gap-3 text-[13px] text-fg-2">
                <Person member={s.assignee} />
                <DueText due={s.due} tz={user.timezone} overdue={s.overdue} compact />
                {s.status === 'cancelled' && s.requiredForParent && !s.cancellationAccepted && task.permissions.assign ? (
                  <Button size="sm" loading={accept.isPending} onClick={() => void accept.run({ params: { workspaceId: workspace.id, taskId: s.id }, body: {} }, { ifMatch: s.rowVersion })}>
                    Accept Cancellation
                  </Button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
      <TaskForm open={open} onOpenChange={setOpen} parentTaskId={task.id} defaults={{ projectId: task.project.id }} />
    </Panel>
  );
};

export const AttachmentsSection = ({ task }: { task: TaskDetail }) => {
  const { workspace } = useWorkspace();
  const wsPath = useWsPath();
  const q = useApiQuery(taskEndpoints.attachments, { params: { workspaceId: workspace.id, taskId: task.id } });
  const [removing, setRemoving] = useState<{ linkId: string; name: string } | null>(null);
  const remove = useApiMutation(mediaEndpoints.removeLink, { invalidate: ['tasks.attachments', 'assets.'], successMessage: 'Attachment link removed' });
  return (
    <Panel title="Attachments">
      <QueryState query={q}>
        {q.data && q.data.length ? (
          <ul className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {q.data.map((a) => (
              <li key={a.linkId} className="flex items-center gap-3 rounded-[8px] border border-line p-2">
                {a.asset.thumbnailUrl ? (
                  <AssetThumb workspaceId={workspace.id} assetId={a.asset.id} size={64} className="h-16 w-16 shrink-0" />
                ) : (
                  <span aria-hidden className="flex h-16 w-16 shrink-0 items-center justify-center rounded-[8px] bg-surface-2 text-fg-2">
                    <File size={24} />
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <Link href={wsPath(`/library/assets/${a.asset.id}`)} className="block truncate text-[14px] text-fg hover:underline">
                    {a.asset.restrictedHidden ? 'Restricted media' : a.asset.name}
                  </Link>
                  <p className="text-[12px] text-fg-2">
                    {a.asset.currentVersion ? `${formatBytes(a.asset.currentVersion.byteSize)} · ${label('assetStatus', a.asset.currentVersion.status)}` : a.asset.kind === 'external_link' ? 'External link' : 'No stored version'}
                  </p>
                </div>
                {task.permissions.attach ? <IconButton label={`Remove attachment link to ${a.asset.name}`} icon={<LinkBreak size={16} />} onClick={() => setRemoving({ linkId: a.linkId, name: a.asset.name })} /> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mb-3 text-[14px] text-fg-2">No attachments.</p>
        )}
      </QueryState>
      {task.permissions.attach ? (
        <FileUploader
          workspaceId={workspace.id}
          purpose="document"
          projectId={task.project.id}
          target={{ entityType: 'task', entityId: task.id }}
          compact
          label="Attach Files"
          hint="Files are checked before they become available."
          onUploaded={() => void q.refetch()}
        />
      ) : null}
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title="Remove attachment link?"
        body={`“${removing?.name ?? ''}” stays in the Library; only its link to this task is removed.`}
        confirmLabel="Remove Attachment Link"
        loading={remove.isPending}
        onConfirm={async () => {
          await remove.run({ params: { workspaceId: workspace.id, linkId: removing!.linkId }, body: {} });
          setRemoving(null);
          void q.refetch();
        }}
      />
    </Panel>
  );
};

export const HistorySection = ({ task }: { task: TaskDetail }) => {
  const { workspace, user } = useWorkspace();
  const activity = useApiInfinite(taskEndpoints.activity, { params: { workspaceId: workspace.id, taskId: task.id }, query: {} });
  return (
    <Panel title="History">
      <div className="flex flex-col gap-5">
        <div>
          <h3 className="text-[12px] font-[550] text-fg-2">Status</h3>
          <ol className="mt-1 flex flex-col gap-1 text-[13px]">
            {task.statusEvents.map((e) => (
              <li key={e.id} className="flex flex-wrap gap-x-2">
                <span className="text-fg-2">{formatDateTime(e.at, user.timezone)}</span>
                <span className="text-fg">{e.from ? `${label('taskStatus', e.from)} → ` : 'Created as '}{label('taskStatus', e.to)}</span>
                {e.actor ? <span className="text-fg-2">by {e.actor.displayName}</span> : null}
                {e.cycle > 1 ? <Badge>Cycle {e.cycle}</Badge> : null}
                {e.effectiveAt ? <span className="text-fg-2">effective {formatDateTime(e.effectiveAt, user.timezone)}</span> : null}
                {e.reason ? <span className="w-full text-fg-2">“{e.reason}”</span> : null}
              </li>
            ))}
          </ol>
        </div>
        {task.dueRevisions.length ? (
          <div>
            <h3 className="text-[12px] font-[550] text-fg-2">Deadline changes</h3>
            <ol className="mt-1 flex flex-col gap-1 text-[13px]">
              {task.dueRevisions.map((r) => (
                <li key={r.id} className="flex flex-wrap gap-x-2">
                  <span className="text-fg-2">{formatDateTime(r.at, user.timezone)}</span>
                  <span className="text-fg">
                    {r.from ? formatDateTime(r.from, user.timezone) : 'No Deadline'} → {r.to ? formatDateTime(r.to, user.timezone) : 'No Deadline'}
                  </span>
                  {r.reason ? <span className="text-fg-2">“{r.reason}”</span> : null}
                </li>
              ))}
            </ol>
            {task.baselineDueAt ? <p className="mt-1 text-[12px] text-fg-2">Baseline deadline: {formatDateTime(task.baselineDueAt, user.timezone)}</p> : null}
          </div>
        ) : null}
        {task.blockIntervals.length ? (
          <div>
            <h3 className="text-[12px] font-[550] text-fg-2">Blockers</h3>
            <ol className="mt-1 flex flex-col gap-1 text-[13px]">
              {task.blockIntervals.map((b) => (
                <li key={b.id} className="text-fg">
                  {formatDateTime(b.startedAt, user.timezone)} – {b.endedAt ? formatDateTime(b.endedAt, user.timezone) : 'now'}: {b.reason}
                  {b.resolution ? <span className="text-fg-2"> · resolved: {b.resolution}</span> : null}
                </li>
              ))}
            </ol>
          </div>
        ) : null}
        <div>
          <h3 className="text-[12px] font-[550] text-fg-2">Activity</h3>
          <QueryState query={activity}>
            {activity.items.length === 0 ? (
              <EmptyState title="No activity yet" className="py-4" />
            ) : (
              <ol className="mt-1 flex flex-col gap-1 text-[13px]">
                {activity.items.map((a) => (
                  <li key={a.id} className="flex flex-wrap gap-x-2">
                    <span className="text-fg-2">{formatDateTime(a.occurredAt, user.timezone)}</span>
                    <span className="text-fg">{a.action.replace(/^task\./, '').replace(/_/g, ' ')}</span>
                    {a.actorName ? <span className="text-fg-2">by {a.actorName}</span> : null}
                    {a.changes.length ? <span className="w-full text-fg-2">Changed: {a.changes.map((c) => c.field).join(', ')}</span> : null}
                  </li>
                ))}
              </ol>
            )}
            {activity.hasNextPage ? (
              <Button size="sm" className="mt-2" loading={activity.isFetchingNextPage} onClick={() => void activity.fetchNextPage()}>
                Load More
              </Button>
            ) : null}
          </QueryState>
        </div>
      </div>
    </Panel>
  );
};
