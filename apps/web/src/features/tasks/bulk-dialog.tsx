'use client';
import { useEffect, useState } from 'react';
import { taskEndpoints, type BulkAction, type TaskListQuery } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { TASK_PRIORITIES, TASK_STATUSES } from '@castlane/domain';
import { Badge, Banner, Button, DateInput, Dialog, Field, Input, Select, Textarea } from '@castlane/ui';
import { MemberSelect } from '@/components/common/pickers';
import { useApiMutation } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useWorkspace } from '@/lib/workspace-context';
import { TASK_INVALIDATE } from './task-actions';

export type BulkSelection = { ids: string[] } | { filter: Omit<TaskListQuery, 'cursor' | 'pageSize' | 'sort' | 'direction'>; expectedCount: number };
type ActionKind = BulkAction['action'];

const ACTIONS: { value: ActionKind; label: string }[] = [
  { value: 'assign', label: 'Assign' },
  { value: 'reschedule', label: 'Reschedule' },
  { value: 'status', label: 'Change Status' },
  { value: 'priority', label: 'Change Priority' },
  { value: 'add_tags', label: 'Add Tags' },
];

const STATUS_TEXT: Record<string, string> = { ok: 'Will change', forbidden: 'Not allowed', conflict: 'Changed', invalid: 'Not applicable' };

/**
 * Bulk change with a preview of available, unavailable and conflicting tasks. Each task succeeds or
 * fails on its own; failures can be retried, conflicts need a fresh preview.
 */
export const BulkDialog = ({ open, onOpenChange, selection, initialAction, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; selection: BulkSelection; initialAction?: ActionKind; onDone: () => void }) => {
  const { workspace, user } = useWorkspace();
  const [action, setAction] = useState<ActionKind>(initialAction ?? 'assign');
  const [assignee, setAssignee] = useState<string | null>(null);
  const [shiftDays, setShiftDays] = useState('1');
  const [newDate, setNewDate] = useState('');
  const [status, setStatus] = useState<string>('ready');
  const [reason, setReason] = useState('');
  const [priority, setPriority] = useState<string>('high');
  const [tags, setTags] = useState('');
  const [error, setError] = useState<string | null>(null);
  const preview = useApiMutation(taskEndpoints.bulkPreview, { silentErrors: true });
  const apply = useApiMutation(taskEndpoints.bulkApply, { invalidate: TASK_INVALIDATE, silentErrors: true });
  useEffect(() => {
    if (open) {
      setAction(initialAction ?? 'assign');
      setError(null);
      preview.reset();
      apply.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const change = (): BulkAction => {
    switch (action) {
      case 'assign':
        return { action, assigneeMembershipId: assignee };
      case 'reschedule':
        return newDate ? { action, due: { kind: 'date', date: newDate, timezone: user.timezone } } : { action, shiftDays: Number(shiftDays) || 0 };
      case 'status':
        return { action, targetState: status as never, reason: reason.trim() || undefined };
      case 'priority':
        return { action, priority: priority as never };
      case 'add_tags':
        return { action, tags: tags.split(',').map((t) => t.trim()).filter(Boolean) };
    }
  };
  const doPreview = async () => {
    setError(null);
    apply.reset();
    try {
      await preview.run({ params: { workspaceId: workspace.id }, body: { selection, change: change() } });
    } catch (e) {
      setError(isApiError(e) ? e.message : 'The preview failed.');
    }
  };
  const doApply = async (onlyIds?: string[]) => {
    setError(null);
    try {
      const r = await apply.run({ params: { workspaceId: workspace.id }, body: { previewToken: preview.data!.token, onlyIds } });
      if (r.failed === 0) {
        onDone();
      }
    } catch (e) {
      setError(isApiError(e) ? e.message : 'The change was not applied.');
    }
  };
  const failures = apply.data?.results.filter((r) => !r.ok) ?? [];
  const retryable = failures.filter((f) => f.code !== 'CONFLICT' && f.code !== 'FORBIDDEN');
  const count = 'ids' in selection ? selection.ids.length : selection.expectedCount;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="wide"
      title={`Bulk change · ${count} task${count === 1 ? '' : 's'}`}
      description="Preview first: nothing changes until you apply."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{apply.data ? 'Close' : 'Cancel'}</Button>
          {!apply.data ? (
            <>
              <Button loading={preview.isPending} onClick={() => void doPreview()}>
                {preview.data ? 'Preview Again' : 'Preview'}
              </Button>
              <Button variant="primary" disabled={!preview.data || preview.data.counts.ok === 0} loading={apply.isPending} onClick={() => void doApply()}>
                Apply to {preview.data?.counts.ok ?? 0}
              </Button>
            </>
          ) : retryable.length ? (
            <Button variant="primary" loading={apply.isPending} onClick={() => void doApply(retryable.map((f) => f.id))}>
              Retry Failures ({retryable.length})
            </Button>
          ) : failures.length ? (
            <Button variant="primary" onClick={() => { apply.reset(); void doPreview(); }}>
              Preview Again
            </Button>
          ) : null}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Change">
            <Select value={action} onChange={(v) => { setAction((v as ActionKind) ?? 'assign'); preview.reset(); apply.reset(); }} options={ACTIONS} />
          </Field>
          {action === 'assign' ? (
            <Field label="Assignee" helper="Clear the field to leave the tasks unassigned.">
              <MemberSelect value={assignee} onChange={(v) => { setAssignee(v); preview.reset(); }} clearable placeholder="Unassigned" />
            </Field>
          ) : null}
          {action === 'reschedule' ? (
            <>
              <Field label="Move deadlines by (days)" helper="Negative values move earlier. Ignored when a new date is set.">
                <Input value={shiftDays} onChange={(e) => { setShiftDays(e.target.value); preview.reset(); }} inputMode="numeric" />
              </Field>
              <Field label="Or set a new due date" helper={`Due by end of day, ${user.timezone}`}>
                <DateInput value={newDate} onChange={(e) => { setNewDate(e.target.value); preview.reset(); }} />
              </Field>
            </>
          ) : null}
          {action === 'status' ? (
            <>
              <Field label="New status">
                <Select value={status} onChange={(v) => { setStatus(v ?? 'ready'); preview.reset(); }} options={TASK_STATUSES.map((s) => ({ value: s, label: label('taskStatus', s) }))} />
              </Field>
              <Field label="Reason" helper="Required for cancel and reopen.">
                <Textarea value={reason} onChange={(e) => { setReason(e.target.value); preview.reset(); }} className="min-h-[72px]" />
              </Field>
            </>
          ) : null}
          {action === 'priority' ? (
            <Field label="Priority">
              <Select value={priority} onChange={(v) => { setPriority(v ?? 'normal'); preview.reset(); }} options={TASK_PRIORITIES.map((p) => ({ value: p, label: label('taskPriority', p) }))} />
            </Field>
          ) : null}
          {action === 'add_tags' ? (
            <Field label="Tags" helper="Comma-separated.">
              <Input value={tags} onChange={(e) => { setTags(e.target.value); preview.reset(); }} />
            </Field>
          ) : null}
        </div>
        {preview.data && !apply.data ? (
          <div className="flex flex-col gap-2">
            <p className="text-[13px] text-fg">
              {preview.data.counts.ok} will change · {preview.data.counts.forbidden} not allowed · {preview.data.counts.invalid} not applicable · {preview.data.counts.conflict} changed
            </p>
            <ItemList items={preview.data.items.map((i) => ({ id: i.id, title: i.title, tag: STATUS_TEXT[i.status]!, tone: i.status === 'ok' ? 'success' : 'warning', reason: i.reason }))} />
          </div>
        ) : null}
        {apply.data ? (
          <div className="flex flex-col gap-2">
            <Banner tone={apply.data.failed ? 'warning' : 'success'}>
              {apply.data.succeeded} changed{apply.data.failed ? ` · ${apply.data.failed} failed` : ''}.
            </Banner>
            {failures.length ? (
              <ItemList
                items={failures.map((f) => ({ id: f.id, title: preview.data?.items.find((i) => i.id === f.id)?.title ?? null, tag: f.code === 'CONFLICT' ? 'Changed meanwhile' : 'Failed', tone: 'danger', reason: f.message }))}
              />
            ) : null}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
};

const ItemList = ({ items }: { items: { id: string; title: string | null; tag: string; tone: 'success' | 'warning' | 'danger'; reason: string | null }[] }) => (
  <ul className="max-h-[320px] divide-y divide-line overflow-y-auto rounded-[12px] border border-line">
    {items.map((i) => (
      <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-[13px]">
        <span className="min-w-0 truncate text-fg">{i.title ?? 'Task'}</span>
        <span className="flex items-center gap-2 text-fg-2">
          {i.reason ? <span>{i.reason}</span> : null}
          <Badge tone={i.tone}>{i.tag}</Badge>
        </span>
      </li>
    ))}
  </ul>
);
