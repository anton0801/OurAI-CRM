'use client';
import { DotsThree, Warning } from '@phosphor-icons/react';
import Link from 'next/link';
import { useState } from 'react';
import { timeEndpoints, type TimeEntryView } from '@castlane/api-contracts';
import { LIMITS } from '@castlane/domain';
import { Badge, ConfirmDialog, DataTable, DateTimeInput, Field, IconButton, Menu, StatusBadge, Textarea, formatDate, type Column, type MenuItem } from '@castlane/ui';
import { useApiMutation } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useWorkspace, useWsPath } from '@/lib/workspace-context';
import { Person, formatSeconds, fromLocalInput, toLocalInput } from '../tasks/format';
import { EntryForm, TIME_INVALIDATE } from './entry-form';
import { StopTimerDialog } from './timer';

const timeOf = (iso: string, tz: string) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz }).format(new Date(iso));

export const EntryWhen = ({ e, tz }: { e: TimeEntryView; tz: string }) =>
  e.startedAt ? (
    <span className="font-mono tabular-nums">
      {timeOf(e.startedAt, tz)}–{e.endedAt ? timeOf(e.endedAt, tz) : 'running'}
    </span>
  ) : (
    <span className="text-fg-2">Duration only</span>
  );

type Pending = { kind: 'edit' | 'revise' | 'discard' | 'approve' | 'stop' | 'close'; entry: TimeEntryView } | null;

/**
 * Time entries with row actions allowed by the server (edit unapproved, discard, revise approved,
 * approve one, stop own timer, close another member's timer with the actual end).
 */
export const EntryTable = ({
  entries,
  caption,
  showMember,
  hasMore,
  loadingMore,
  onLoadMore,
}: {
  entries: TimeEntryView[];
  caption: string;
  showMember?: boolean;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
}) => {
  const { workspace, user } = useWorkspace();
  const wsPath = useWsPath();
  const tz = user.timezone;
  const [pending, setPending] = useState<Pending>(null);
  const [end, setEnd] = useState('');
  const [reason, setReason] = useState('');
  const discard = useApiMutation(timeEndpoints.discard, { invalidate: TIME_INVALIDATE, successMessage: 'Entry discarded' });
  const approve = useApiMutation(timeEndpoints.approve, { invalidate: TIME_INVALIDATE, successMessage: 'Entry approved' });
  const close = useApiMutation(timeEndpoints.closeTimer, { invalidate: TIME_INVALIDATE, successMessage: 'Timer closed. The entry needs review.' });
  const ids = new Set(entries.map((e) => e.id));
  const columns: Column<TimeEntryView>[] = [
    { key: 'date', header: 'Date', minWidth: 110, cell: (e) => formatDate(e.workDate) },
    { key: 'member', header: 'Member', minWidth: 170, hidden: !showMember, cell: (e) => <Person member={e.member} /> },
    {
      key: 'task',
      header: 'Task',
      sticky: true,
      minWidth: 220,
      cell: (e) => (
        <span className="flex min-w-0 flex-col">
          {e.task.readable === false ? (
            <span className="text-fg-2">Task you cannot view</span>
          ) : (
            <Link href={wsPath(`/tasks/${e.task.id}`)} className="truncate font-medium text-fg hover:underline">
              {e.task.title ?? 'Task'}
            </Link>
          )}
          <span className="truncate text-[12px] text-fg-2">{e.project.name}</span>
        </span>
      ),
    },
    { key: 'when', header: 'Start–End', minWidth: 120, cell: (e) => <EntryWhen e={e} tz={tz} /> },
    { key: 'duration', header: 'Duration', minWidth: 90, align: 'right', cell: (e) => <span className="font-mono tabular-nums">{e.state === 'running' ? '—' : formatSeconds(e.durationSeconds)}</span> },
    { key: 'source', header: 'Source', minWidth: 90, cell: (e) => label('timeSource', e.source) },
    {
      key: 'state',
      header: 'State',
      minWidth: 140,
      cell: (e) => (
        <span className="flex flex-col gap-0.5">
          <StatusBadge status={e.state} label={label('timeState', e.state)} />
          {e.revisionOf ? <span className="text-[12px] text-fg-2">Revision</span> : null}
          {e.supersededAt ? <span className="text-[12px] text-fg-2">Replaced by a revision</span> : null}
        </span>
      ),
    },
    {
      key: 'flags',
      header: 'Checks',
      minWidth: 200,
      cell: (e) => (
        <span className="flex flex-col gap-0.5 text-[12px]">
          {e.overlapsWith.length ? (
            <span className="flex items-center gap-1 text-warning">
              <Warning size={14} aria-hidden /> Overlaps {e.overlapsWith.length} other entr{e.overlapsWith.length === 1 ? 'y' : 'ies'}
              {e.overlapsWith.some((o) => !ids.has(o)) ? ' (outside this list)' : ''}
            </span>
          ) : null}
          {e.returnedReason ? <span className="text-fg">Returned: {e.returnedReason}</span> : null}
          {e.needsReviewReason ? <span className="text-fg-2">{e.needsReviewReason}</span> : null}
          {e.closedBy ? <span className="text-fg-2">Closed by {e.closedBy.displayName}: {e.closeReason}</span> : null}
          {!e.overlapsWith.length && !e.returnedReason && !e.needsReviewReason && !e.closedBy ? <span className="text-fg-muted">—</span> : null}
        </span>
      ),
    },
    { key: 'billable', header: 'Billable', minWidth: 80, hidden: !entries.some((e) => e.billable !== undefined), cell: (e) => (e.billable ? <Badge tone="info">Billable</Badge> : <span className="text-fg-muted">—</span>) },
    { key: 'note', header: 'Note', minWidth: 180, cell: (e) => (e.note ? <span className="line-clamp-2">{e.note}</span> : <span className="text-fg-muted">—</span>) },
    {
      key: 'actions',
      header: '',
      headerLabel: 'Actions',
      minWidth: 56,
      align: 'right',
      cell: (e) => {
        const items: MenuItem[] = [
          { label: 'Stop Timer', onSelect: () => setPending({ kind: 'stop', entry: e }), hidden: !e.permissions.stop },
          { label: 'Close Timer…', onSelect: () => { setEnd(toLocalInput(new Date().toISOString(), tz)); setReason(''); setPending({ kind: 'close', entry: e }); }, hidden: !e.permissions.close },
          { label: 'Edit', onSelect: () => setPending({ kind: 'edit', entry: e }), hidden: !e.permissions.edit },
          { label: 'Revise…', onSelect: () => setPending({ kind: 'revise', entry: e }), hidden: !e.permissions.revise },
          { label: 'Approve', onSelect: () => setPending({ kind: 'approve', entry: e }), hidden: !e.permissions.approve },
          { label: 'Discard', destructive: true, separatorBefore: true, onSelect: () => setPending({ kind: 'discard', entry: e }), hidden: !e.permissions.discard },
        ];
        return items.some((i) => !i.hidden) ? (
          <Menu label="Entry actions" trigger={<IconButton label={`Actions for entry on ${formatDate(e.workDate)}`} icon={<DotsThree size={16} weight="bold" />} />} items={items} />
        ) : null;
      },
    },
  ];
  const p = pending;
  return (
    <>
      <DataTable
        caption={caption}
        rows={entries}
        columns={columns}
        getRowId={(e) => e.id}
        density={user.density}
        hasMore={hasMore}
        loadingMore={loadingMore}
        onLoadMore={onLoadMore}
        rowClassName={(e) => (e.supersededAt ? 'opacity-60' : undefined)}
      />
      <EntryForm open={p?.kind === 'edit' || p?.kind === 'revise'} onOpenChange={(o) => !o && setPending(null)} entry={p?.entry} revise={p?.kind === 'revise'} />
      {p?.kind === 'stop' ? <StopTimerDialog open onOpenChange={(o) => !o && setPending(null)} timerId={p.entry.id} startedAt={p.entry.startedAt!} /> : null}
      <ConfirmDialog
        open={p?.kind === 'discard'}
        onOpenChange={(o) => !o && setPending(null)}
        title="Discard this entry?"
        body="The entry is removed from your time. Approved time cannot be discarded; it is corrected by a revision."
        confirmLabel="Discard"
        destructive
        loading={discard.isPending}
        onConfirm={async () => {
          await discard.run({ params: { workspaceId: workspace.id, entryId: p!.entry.id }, body: {} }, { ifMatch: p!.entry.rowVersion });
          setPending(null);
        }}
      />
      <ConfirmDialog
        open={p?.kind === 'approve'}
        onOpenChange={(o) => !o && setPending(null)}
        title="Approve this entry?"
        body="Approved entries cannot be edited; later corrections need a revision."
        confirmLabel="Approve"
        loading={approve.isPending}
        onConfirm={async () => {
          await approve.run({ params: { workspaceId: workspace.id, entryId: p!.entry.id }, body: {} }, { ifMatch: p!.entry.rowVersion });
          setPending(null);
        }}
      />
      <ConfirmDialog
        open={p?.kind === 'close'}
        onOpenChange={(o) => !o && setPending(null)}
        title={`Close ${p?.entry.member.displayName ?? 'member'}’s timer`}
        body="Enter when the work actually ended. The entry goes to Needs Review; nothing is invented."
        confirmLabel="Close Timer"
        loading={close.isPending}
        confirmDisabled={!end || reason.trim().length < 3}
        onConfirm={async () => {
          await close.run({ params: { workspaceId: workspace.id, timerId: p!.entry.id }, body: { endedAt: fromLocalInput(end, tz)!, reason: reason.trim() } });
          setPending(null);
        }}
      >
        <Field label="Actual end" required>
          <DateTimeInput value={end} onChange={(e) => setEnd(e.target.value)} timezone={tz} />
        </Field>
        <Field label="Reason" required>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={LIMITS.reasonMax} className="min-h-[72px]" />
        </Field>
      </ConfirmDialog>
    </>
  );
};
