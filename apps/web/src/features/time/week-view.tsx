'use client';
import { CaretLeft, CaretRight, Plus } from '@phosphor-icons/react';
import { useState } from 'react';
import { timeEndpoints } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { DateTime } from '@castlane/domain';
import { Badge, Banner, Button, ConfirmDialog, EmptyState, IconButton, Toolbar, formatDate, formatDateTime } from '@castlane/ui';
import { QueryState } from '@/components/common/query-state';
import { useApiMutation, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';
import { useCan, useWorkspace } from '@/lib/workspace-context';
import { formatSeconds } from '../tasks/format';
import { EntryForm, TIME_INVALIDATE } from './entry-form';
import { EntryTable } from './entry-table';

const shift = (iso: string, days: number) => DateTime.fromISO(iso).plus({ days }).toISODate() as string;

/**
 * One member's week (S30 My Week; Member Workspace → Time): entries, totals per day, overlaps and
 * the latest submission. Submitting freezes exactly the entry versions you reviewed.
 */
export const WeekView = ({ membershipId }: { membershipId?: string }) => {
  const { workspace, user, membershipId: me } = useWorkspace();
  const can = useCan();
  const { state, set } = useUrlState<'week'>();
  const [addOpen, setAddOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const own = !membershipId || membershipId === me;
  const q = useApiQuery(timeEndpoints.week, { params: { workspaceId: workspace.id }, query: { weekStart: state.week, membershipId: own ? undefined : membershipId } });
  const submit = useApiMutation(timeEndpoints.submitWeek, { invalidate: TIME_INVALIDATE, successMessage: 'Week submitted for approval', silentErrors: true });
  const w = q.data;
  const pendingEntries = w?.entries.filter((e) => !e.supersededAt && ['draft', 'needs_review', 'returned'].includes(e.state)) ?? [];
  const thisWeek = !state.week;
  return (
    <div className="flex flex-col gap-4">
      <Toolbar>
        <div className="flex items-center gap-1">
          <IconButton label="Previous week" icon={<CaretLeft size={16} />} onClick={() => w && set({ week: shift(w.weekStart, -7) })} disabled={!w} />
          <span className="min-w-[180px] text-center text-[14px] font-medium text-fg" aria-live="polite">
            {w ? `${formatDate(w.weekStart)} – ${formatDate(w.weekEnd)}` : 'Week'}
          </span>
          <IconButton label="Next week" icon={<CaretRight size={16} />} onClick={() => w && set({ week: shift(w.weekStart, 7) })} disabled={!w} />
          {!thisWeek ? (
            <Button size="sm" variant="ghost" onClick={() => set({ week: null })}>
              This Week
            </Button>
          ) : null}
        </div>
        {w ? (
          <span className="text-[13px] text-fg-2">
            {own ? 'Your' : `${w.member.displayName}’s`} total: <span className="font-mono tabular-nums text-fg">{formatSeconds(w.totalSeconds)}</span>
          </span>
        ) : null}
        {own && can('time.write.own') ? (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button icon={<Plus size={14} />} onClick={() => setAddOpen(true)}>
              Add Entry
            </Button>
            <Button variant="primary" disabled={!w?.canSubmit || pendingEntries.length === 0} onClick={() => { setError(null); setConfirm(true); }}>
              Submit Week
            </Button>
          </div>
        ) : null}
      </Toolbar>
      {error ? <Banner tone="danger">{error}</Banner> : null}
      <QueryState query={q}>
        {w ? (
          <>
            {w.submission ? (
              <Banner tone={w.submission.state === 'returned' ? 'warning' : w.submission.state === 'approved' ? 'success' : 'info'}>
                {label('sheetState', w.submission.state)} {formatDateTime(w.submission.decidedAt ?? w.submission.submittedAt, user.timezone)}
                {w.submission.approver ? ` · approver ${w.submission.approver.displayName}` : ''}
                {w.submission.reason ? ` · ${w.submission.reason}` : ''}
              </Banner>
            ) : null}
            {own && w.blockers.length && pendingEntries.length ? (
              <Banner tone="warning">
                <span className="flex flex-col gap-0.5">
                  {w.blockers.map((b) => (
                    <span key={b}>{b}</span>
                  ))}
                </span>
              </Banner>
            ) : null}
            <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7" aria-label="Time per day">
              {w.byDay.map((d) => (
                <li key={d.date} className="flex flex-col rounded-[8px] border border-line bg-surface px-3 py-2">
                  <span className="text-[12px] text-fg-2">{DateTime.fromISO(d.date).toFormat('ccc d LLL')}</span>
                  <span className="font-mono text-[16px] tabular-nums text-fg">{d.seconds ? formatSeconds(d.seconds) : '—'}</span>
                </li>
              ))}
            </ol>
            {w.entries.length === 0 ? (
              <EmptyState
                title="No time recorded this week"
                description={own ? 'Start a timer on a task or add an entry for work you did. Time tracking is voluntary and explicit.' : 'This member recorded no time in this week.'}
                action={own && can('time.write.own') ? <Button onClick={() => setAddOpen(true)}>Add Entry</Button> : undefined}
              />
            ) : (
              <EntryTable entries={w.entries} caption={`Time entries ${w.weekStart} to ${w.weekEnd}`} />
            )}
            <p className="text-[12px] text-fg-2">
              Times are shown in {user.timezone}. {pendingEntries.length ? <Badge>{pendingEntries.length} not yet submitted</Badge> : null}
            </p>
          </>
        ) : null}
      </QueryState>
      <EntryForm open={addOpen} onOpenChange={setAddOpen} defaultDate={w && !thisWeek ? w.weekStart : undefined} />
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Submit this week?"
        body={`${pendingEntries.length} entr${pendingEntries.length === 1 ? 'y' : 'ies'} (${formatSeconds(pendingEntries.reduce((s, e) => s + (e.durationSeconds ?? 0), 0))}) go to your approver exactly as shown. You cannot edit them unless the week is returned.`}
        confirmLabel="Submit Week"
        loading={submit.isPending}
        onConfirm={async () => {
          try {
            await submit.run({ params: { workspaceId: workspace.id }, body: { weekStart: w!.weekStart, entries: pendingEntries.map((e) => ({ id: e.id, rowVersion: e.rowVersion })) } });
            setConfirm(false);
          } catch (e) {
            setError(isApiError(e) ? e.message : 'The week was not submitted.');
            setConfirm(false);
            void q.refetch();
          }
        }}
      />
    </div>
  );
};
