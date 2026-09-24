'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { CheckpointRow, ObservationSummary } from '@castlane/api-contracts';
import { Badge, DataTable, formatDateTime, type Column } from '@castlane/ui';
import { label } from '@/lib/labels';
import { useWorkspace, useWsPath } from '@/lib/workspace-context';
import { CheckpointStatusBadge, EntityCell, MetricValueText, ObservationValue, QualityBadge, SourceText, TimingBadge } from './common';

/** Observations with their headline values (unknown values stay labelled, never 0). */
export const ObservationsTable = ({
  rows,
  caption,
  hideEntity,
  hasMore,
  loadingMore,
  onLoadMore,
  empty,
}: {
  rows: ObservationSummary[];
  caption: string;
  hideEntity?: boolean;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  empty?: React.ReactNode;
}) => {
  const { user } = useWorkspace();
  const wsPath = useWsPath();
  const router = useRouter();
  const headlineKeys = [...new Set(rows.flatMap((r) => r.headline.map((h) => h.metricKey)))].slice(0, 3);
  const headlineLabel = (k: string) => rows.flatMap((r) => r.headline).find((h) => h.metricKey === k)?.label ?? k;
  const columns: Column<ObservationSummary>[] = [
    {
      key: 'observedAt',
      header: 'Observed',
      minWidth: 170,
      sticky: true,
      cell: (o) => (
        <span className="flex flex-col">
          <Link href={wsPath(`/metrics/${o.id}`)} className="font-medium text-fg hover:underline" onClick={(e) => e.stopPropagation()}>
            {o.kind === 'period' && o.periodStart ? `${formatDateTime(o.periodStart, user.timezone)} – ${formatDateTime(o.periodEnd, user.timezone)}` : formatDateTime(o.observedAt, user.timezone)}
          </Link>
          <span className="text-[12px] text-fg-2">{label('observationDataset', o.dataset)}</span>
        </span>
      ),
    },
    { key: 'entity', header: 'Recorded for', minWidth: 200, hidden: hideEntity, cell: (o) => <EntityCell entity={o.entity} /> },
    ...headlineKeys.map(
      (k): Column<ObservationSummary> => ({
        key: `h:${k}`,
        header: headlineLabel(k),
        align: 'right',
        minWidth: 110,
        cell: (o) => {
          const h = o.headline.find((x) => x.metricKey === k);
          return h ? <ObservationValue availability={h.availability} value={h.value} /> : <span className="text-fg-muted">Not recorded</span>;
        },
      }),
    ),
    { key: 'source', header: 'Source', minWidth: 160, cell: (o) => <SourceText o={o} /> },
    {
      key: 'quality',
      header: 'Quality',
      minWidth: 170,
      cell: (o) => (
        <span className="flex flex-wrap items-center gap-1">
          <QualityBadge quality={o.qualityState} />
          {o.hasPendingCorrection ? <Badge tone="warning">Correction pending</Badge> : null}
          {!o.canonical ? <Badge tone="neutral">Excluded from reports</Badge> : null}
          {o.checkpoint ? <TimingBadge timing={o.checkpoint.timing} /> : null}
        </span>
      ),
    },
  ];
  return (
    <DataTable
      caption={caption}
      rows={rows}
      columns={columns}
      getRowId={(o) => o.id}
      onRowClick={(o) => router.push(wsPath(`/metrics/${o.id}`))}
      hasMore={hasMore}
      loadingMore={loadingMore}
      onLoadMore={onLoadMore}
      empty={empty}
    />
  );
};

/** Checkpoints with expected time, window, status and — once submitted — the real observed time. */
export const CheckpointsTable = ({
  rows,
  caption,
  hideEntity,
  onAddMetrics,
  onMarkMissing,
  hasMore,
  loadingMore,
  onLoadMore,
}: {
  rows: CheckpointRow[];
  caption: string;
  hideEntity?: boolean;
  onAddMetrics?: (c: CheckpointRow) => void;
  onMarkMissing?: (c: CheckpointRow) => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
}) => {
  const { user } = useWorkspace();
  const wsPath = useWsPath();
  const zone = user.timezone;
  const columns: Column<CheckpointRow>[] = [
    { key: 'entity', header: 'Account or publication', minWidth: 220, sticky: true, hidden: hideEntity, cell: (c) => <EntityCell entity={c.entity} /> },
    {
      key: 'checkpoint',
      header: 'Checkpoint',
      minWidth: 170,
      cell: (c) => (
        <span className="flex flex-col">
          <span className="font-medium text-fg">{c.label}</span>
          <span className="text-[12px] text-fg-2">
            Window {formatDateTime(c.windowStart, zone)} – {formatDateTime(c.windowEnd, zone)}
          </span>
        </span>
      ),
    },
    { key: 'expected', header: 'Expected', minWidth: 150, cell: (c) => formatDateTime(c.expectedAt, zone) },
    {
      key: 'status',
      header: 'Status',
      minWidth: 150,
      cell: (c) => (
        <span className="flex flex-wrap items-center gap-1">
          <CheckpointStatusBadge status={c.status} />
          <TimingBadge timing={c.timing} />
        </span>
      ),
    },
    {
      key: 'result',
      header: 'Recorded',
      minWidth: 200,
      cell: (c) =>
        c.observationId ? (
          <span className="flex flex-col">
            <Link href={wsPath(`/metrics/${c.observationId}`)} className="text-fg hover:underline">
              Observed {formatDateTime(c.observedAt, zone)}
            </Link>
            <span className="text-[12px] text-fg-2">
              {c.reporter?.displayName ?? 'Unknown member'}
              {c.completeness ? (
                <>
                  {' '}
                  · required fields <MetricValueText value={c.completeness} />
                </>
              ) : null}
            </span>
          </span>
        ) : c.missingReason ? (
          <span className="text-fg-2">Missing: {c.missingReason}</span>
        ) : (
          <span className="text-fg-muted">{c.assignee ? `Assigned to ${c.assignee.displayName}` : 'Unassigned'}</span>
        ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      headerLabel: 'Actions',
      minWidth: 210,
      hidden: !onAddMetrics && !onMarkMissing,
      cell: (c) =>
        c.state === 'pending' ? (
          <span className="flex flex-wrap gap-2">
            {c.permissions.addMetrics && onAddMetrics ? (
              <button type="button" className="text-[13px] font-medium text-primary hover:underline" onClick={() => onAddMetrics(c)}>
                Add Metrics
              </button>
            ) : null}
            {c.permissions.markMissing && onMarkMissing ? (
              <button type="button" className="text-[13px] font-medium text-fg-2 hover:text-fg hover:underline" onClick={() => onMarkMissing(c)}>
                Mark Unavailable
              </button>
            ) : null}
          </span>
        ) : null,
    },
  ];
  return <DataTable caption={caption} rows={rows} columns={columns} getRowId={(c) => c.id} hasMore={hasMore} loadingMore={loadingMore} onLoadMore={onLoadMore} />;
};

/** Link to Add Metrics for a checkpoint (the form pre-selects the entity and completes the checkpoint). */
export const addMetricsHref = (c: CheckpointRow) =>
  `/metrics/new?checkpointId=${c.id}&${c.entity.type === 'publication' ? `publicationId=${c.entity.id}` : `accountId=${c.entity.accountId}`}`;
