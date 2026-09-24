'use client';
import Link from 'next/link';
import { ClockCounterClockwise } from '@phosphor-icons/react';
import { teamEndpoints, type MemberDetail } from '@castlane/api-contracts';
import { Button, EmptyState, formatDateTime } from '@castlane/ui';
import { QueryState } from '@/components/common/query-state';
import { useApiInfinite } from '@/lib/hooks';
import { useUrlState } from '@/lib/url-state';
import { useWorkspace } from '@/lib/workspace-context';
import { actionLabel } from './labels';

const show = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** Membership & access history (masked diffs) and the member's recent actions within the viewer's scope. */
export const MemberActivityTab = ({ m }: { m: MemberDetail }) => {
  const { workspace, user } = useWorkspace();
  const { state, set } = useUrlState<'activity'>({ activity: 'membership' });
  const kind = (state.activity === 'actions' ? 'actions' : 'membership') as 'membership' | 'actions';
  const q = useApiInfinite(teamEndpoints.activity, { params: { workspaceId: workspace.id, membershipId: m.membershipId }, query: { kind } });
  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-1" role="group" aria-label="Activity type">
        <Button size="sm" variant={kind === 'membership' ? 'secondary' : 'ghost'} aria-pressed={kind === 'membership'} onClick={() => set({ activity: 'membership' })}>
          Membership &amp; Access
        </Button>
        <Button size="sm" variant={kind === 'actions' ? 'secondary' : 'ghost'} aria-pressed={kind === 'actions'} onClick={() => set({ activity: 'actions' })}>
          Recent Actions
        </Button>
      </div>
      <QueryState query={q}>
        {q.items.length === 0 && !q.isFetching ? (
          <EmptyState icon={<ClockCounterClockwise size={24} />} title="No activity recorded" description={kind === 'actions' ? 'Only actions in projects you can see are listed.' : 'Changes to this membership will appear here.'} />
        ) : (
          <ol className="flex flex-col divide-y divide-line rounded-[12px] border border-line bg-surface">
            {q.items.map((e) => (
              <li key={e.id} className="flex flex-col gap-1 px-4 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-[14px] font-medium text-fg">
                    {e.href ? (
                      <Link href={e.href} className="hover:underline">
                        {actionLabel(e.action)}
                      </Link>
                    ) : (
                      actionLabel(e.action)
                    )}
                  </span>
                  <time dateTime={e.occurredAt} className="text-[12px] text-fg-2">
                    {formatDateTime(e.occurredAt, user.timezone)}
                  </time>
                </div>
                <span className="text-[12px] text-fg-2">
                  by {e.actorName ?? 'System'}
                  {e.reason ? ` · Reason: ${e.reason}` : ''}
                </span>
                {e.changes.length ? (
                  <ul className="text-[12px] text-fg-2">
                    {e.changes.map((c) => (
                      <li key={c.field}>
                        <span className="font-medium text-fg">{c.field}</span>: {show(c.from)} → {show(c.to)}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ol>
        )}
        {q.hasNextPage ? (
          <div className="flex justify-center">
            <Button onClick={() => void q.fetchNextPage()} loading={q.isFetchingNextPage}>
              Load More
            </Button>
          </div>
        ) : null}
      </QueryState>
    </div>
  );
};
