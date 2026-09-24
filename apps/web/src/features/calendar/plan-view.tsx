'use client';
import { Snowflake } from '@phosphor-icons/react';
import Link from 'next/link';
import { planBaselineEndpoints as PB, type PlanBaselineItem, type PublicationRow } from '@castlane/api-contracts';
import { Badge, Button, DataTable, EmptyState, StatusBadge, formatDateTime, type Column } from '@castlane/ui';
import { QueryState } from '@/components/common/query-state';
import { useApiMutation, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useWorkspace, useWsPath } from '@/lib/workspace-context';
import { PlatformLabel } from '@/features/accounts/platform';
import { PublicationBadges, whenText } from '@/features/publications/format';
import { PUBLICATION_INVALIDATE } from '@/features/publications/labels';

/**
 * §12 Original Plan vs Current Plan for one week. The original plan is frozen at the start of the
 * week in the workspace time zone and never changes when placements move; on-time is measured
 * against the frozen time plus the grace period.
 */
export const PlanView = ({ weekStart, projectId, accountId, tz }: { weekStart: string; projectId?: string | null; accountId?: string | null; tz: string }) => {
  const { workspace, user } = useWorkspace();
  const wsPath = useWsPath();
  const q = useApiQuery(PB.week, { params: { workspaceId: workspace.id }, query: { weekStart, projectId: projectId ?? undefined, accountId: accountId ?? undefined } });
  const freeze = useApiMutation(PB.freeze, { invalidate: PUBLICATION_INVALIDATE, successMessage: 'This week’s plan was frozen' });
  const at = (v: string | null) => (v ? formatDateTime(v, tz) : '—');

  const originalColumns: Column<PlanBaselineItem>[] = [
    {
      key: 'title',
      header: 'Placement',
      sticky: true,
      minWidth: 220,
      cell: (r) => (
        <Link href={wsPath(`/publications/${r.publicationId}`)} className="font-medium text-fg hover:underline" onClick={(e) => e.stopPropagation()}>
          {r.title}
        </Link>
      ),
    },
    {
      key: 'account',
      header: 'Account',
      minWidth: 170,
      cell: (r) => (
        <span className="flex items-center gap-2">
          <PlatformLabel platform={r.account.platform} iconOnly />
          <span className="truncate">{r.account.label}</span>
        </span>
      ),
    },
    { key: 'baseline', header: 'Original time', minWidth: 160, cell: (r) => (r.addedAfterBaseline ? <span className="text-fg-muted">Not in original plan</span> : at(r.baselineScheduledAt)) },
    { key: 'current', header: 'Current time', minWidth: 160, cell: (r) => (r.actualPublishedAt ? `Published ${at(r.actualPublishedAt)}` : at(r.currentScheduledAt)) },
    {
      key: 'flags',
      header: 'Changes',
      minWidth: 240,
      cell: (r) => (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <StatusBadge status={r.status} label={label('publicationStatus', r.status)} />
          {r.addedAfterBaseline ? <Badge tone="info">Added After Baseline</Badge> : null}
          {r.movedOutOfWeek ? <Badge tone="warning">Moved out of week</Badge> : null}
          {r.removedAfterBaselineAt ? <Badge tone="warning">Removed {formatDateTime(r.removedAfterBaselineAt, tz)}</Badge> : null}
        </span>
      ),
    },
    { key: 'reason', header: 'Reason', minWidth: 180, cell: (r) => r.removalReason ?? <span className="text-fg-muted">—</span> },
    {
      key: 'ontime',
      header: 'On time',
      minWidth: 110,
      cell: (r) => (r.onTimeAgainstBaseline === null ? <span className="text-fg-muted">—</span> : r.onTimeAgainstBaseline ? <Badge tone="success">On time</Badge> : <Badge tone="warning">Late</Badge>),
    },
  ];

  const currentColumns: Column<PublicationRow>[] = [
    {
      key: 'title',
      header: 'Placement',
      sticky: true,
      minWidth: 220,
      cell: (p) => (
        <Link href={wsPath(`/publications/${p.id}`)} className="font-medium text-fg hover:underline" onClick={(e) => e.stopPropagation()}>
          {p.title}
        </Link>
      ),
    },
    {
      key: 'account',
      header: 'Account',
      minWidth: 170,
      cell: (p) => (
        <span className="flex items-center gap-2">
          <PlatformLabel platform={p.account.platform} iconOnly />
          <span className="truncate">{p.account.label}</span>
        </span>
      ),
    },
    { key: 'when', header: 'When', minWidth: 230, cell: (p) => <span className="text-[13px]">{whenText(p, tz)}</span> },
    { key: 'status', header: 'Status', minWidth: 200, cell: (p) => <PublicationBadges p={p} compact /> },
  ];

  return (
    <QueryState query={q}>
      {q.data ? (
        <div className="flex flex-col gap-6">
          <div className="flex flex-wrap items-center gap-3 rounded-[12px] border border-line bg-surface px-4 py-3 text-[13px] text-fg-2">
            <span className="min-w-0 flex-1">
              Week {q.data.weekStart} – {q.data.weekEnd} in {q.data.timezone} (workspace time zone). On time means published no later than {q.data.graceMinutes} minutes after the original time.{' '}
              {q.data.baseline ? `Frozen ${formatDateTime(q.data.baseline.frozenAt, user.timezone)}.` : 'This week has not been frozen yet.'}
            </span>
            {!q.data.baseline && q.data.canFreeze ? (
              <Button size="sm" icon={<Snowflake size={14} />} loading={freeze.isPending} onClick={() => void freeze.run({ params: { workspaceId: workspace.id }, body: { weekStart: q.data!.weekStart } })}>
                Freeze This Week
              </Button>
            ) : null}
          </div>
          <section className="flex flex-col gap-2" aria-labelledby="plan-original">
            <h2 id="plan-original" className="text-[15px] font-semibold text-fg">
              Original Plan
            </h2>
            {q.data.original.length ? (
              <DataTable caption="Original plan" rows={q.data.original} columns={originalColumns} getRowId={(r) => r.publicationId} density={user.density} />
            ) : (
              <EmptyState
                title={q.data.baseline ? 'Nothing was planned when the week was frozen' : 'No original plan for this week'}
                description={q.data.baseline ? 'Placements added later appear here as Added After Baseline.' : 'The plan is frozen automatically at the start of the week. Past weeks that were never frozen have no original plan.'}
              />
            )}
          </section>
          <section className="flex flex-col gap-2" aria-labelledby="plan-current">
            <h2 id="plan-current" className="text-[15px] font-semibold text-fg">
              Current Plan
            </h2>
            {q.data.current.length ? (
              <DataTable caption="Current plan" rows={q.data.current} columns={currentColumns} getRowId={(p) => p.id} density={user.density} />
            ) : (
              <EmptyState title="Nothing planned this week" description="Scheduled and published placements whose time falls in this week appear here." />
            )}
          </section>
        </div>
      ) : null}
    </QueryState>
  );
};
