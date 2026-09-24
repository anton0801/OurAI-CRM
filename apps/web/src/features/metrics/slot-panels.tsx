'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Gauge } from '@phosphor-icons/react';
import { useState } from 'react';
import { metricsEndpoints as M, type CheckpointRow } from '@castlane/api-contracts';
import { Banner, Button, DateInput, EmptyState, Field, KpiStrip, LineChart, Panel, Toolbar, formatDateTime } from '@castlane/ui';
import { QueryState } from '@/components/common/query-state';
import { useApiQuery } from '@/lib/hooks';
import { useUrlState } from '@/lib/url-state';
import { useWorkspace, useWsPath } from '@/lib/workspace-context';
import { CheckpointStatusBadge, EntityLink, MetricValueText, NO_DATA, ObservationValue, TimingBadge, sourceAge } from './common';
import { MarkMissingDialog } from './dialogs';
import { addMetricsHref, CheckpointsTable, ObservationsTable } from './tables';

/** Account Detail → Metrics (S20): follower snapshots as a chart and table, period results, freshness, open checkpoints. */
export const AccountMetricsTab = ({ accountId }: { accountId: string; projectId: string }) => {
  const { workspace, user } = useWorkspace();
  const wsPath = useWsPath();
  const router = useRouter();
  const { state, set } = useUrlState<'mfrom' | 'mto'>();
  const [missing, setMissing] = useState<CheckpointRow | null>(null);
  const q = useApiQuery(M.accountMetrics, { params: { workspaceId: workspace.id, accountId }, query: { from: state.mfrom, to: state.mto } });
  const d = q.data;
  return (
    <div className="flex flex-col gap-4">
      <Toolbar>
        <Field label="From" className="w-[160px]">
          <DateInput value={state.mfrom ?? d?.fromDate ?? ''} onChange={(e) => set({ mfrom: e.target.value || null })} />
        </Field>
        <Field label="To" className="w-[160px]">
          <DateInput value={state.mto ?? d?.toDate ?? ''} onChange={(e) => set({ mto: e.target.value || null })} />
        </Field>
        {d?.permissions.addMetrics ? (
          <Button variant="primary" className="ml-auto self-end" onClick={() => router.push(wsPath(`/metrics/new?accountId=${accountId}`))}>
            Add Metrics
          </Button>
        ) : null}
      </Toolbar>
      <QueryState query={q}>
        {d ? (
          <>
            {d.freshness.overdue ? <Banner tone="warning">An account snapshot is overdue. Record the current values or mark the request as unavailable.</Banner> : null}
            <KpiStrip
              items={[
                { label: 'Followers (latest)', value: d.followers.last ? <ObservationValue availability="known" value={d.followers.last.value} /> : <span className="text-[16px] text-fg-muted">No data</span>, hint: d.followers.last ? formatDateTime(d.followers.last.observedAt, user.timezone) : NO_DATA },
                { label: 'Followers Change', value: <MetricValueText value={d.followers.change} />, hint: d.followers.first ? `Since ${formatDateTime(d.followers.first.observedAt, user.timezone)}` : undefined },
                { label: 'Followers Growth %', value: <MetricValueText value={d.followers.growth} /> },
                { label: 'Last observation', value: <span className="text-[16px]">{sourceAge(d.freshness.lastObservedAt)}</span>, hint: d.freshness.nextExpectedAt ? `Next expected ${formatDateTime(d.freshness.nextExpectedAt, user.timezone)}` : `Cadence: ${d.account.metricsCadence}` },
              ]}
            />
            <Panel title="Followers" description="Snapshots as observed. Unknown values are gaps, never zero.">
              <LineChart
                title="Followers over time"
                series={[
                  {
                    key: 'followers',
                    label: 'Followers',
                    points: d.followers.points
                      .filter((p) => p.segment === 'unknown' || p.segment === 'combined')
                      .map((p) => ({ x: p.observedAt.slice(0, 16), y: p.availability === 'known' && p.value !== null ? Number(p.value) : null })),
                  },
                ]}
                formatX={(x) => formatDateTime(`${x}:00Z`, user.timezone)}
              />
            </Panel>
            <Panel title="Snapshots">
              <ObservationsTable rows={d.snapshots} caption="Account snapshots" hideEntity empty={<p className="py-6 text-center text-[13px] text-fg-2">{NO_DATA}</p>} />
            </Panel>
            <Panel title="Period results" description="Reported per closed period; overlapping periods are never summed.">
              <ObservationsTable rows={d.periodObservations} caption="Period results" hideEntity empty={<p className="py-6 text-center text-[13px] text-fg-2">{NO_DATA}</p>} />
            </Panel>
            {d.checkpoints.length ? (
              <Panel title="Open requests">
                <CheckpointsTable rows={d.checkpoints} caption="Open metric requests" hideEntity onAddMetrics={(c) => router.push(wsPath(addMetricsHref(c)))} onMarkMissing={setMissing} />
              </Panel>
            ) : null}
          </>
        ) : null}
      </QueryState>
      {missing ? <MarkMissingDialog checkpoint={missing} onClose={() => setMissing(null)} /> : null}
    </div>
  );
};

const CheckpointList = ({ items, empty }: { items: CheckpointRow[]; empty: string }) => {
  const { user } = useWorkspace();
  const wsPath = useWsPath();
  return items.length ? (
    <ul className="flex flex-col divide-y divide-line rounded-[12px] border border-line">
      {items.map((c) => (
        <li key={c.id} className="flex flex-col gap-1 px-3 py-2 text-[13px] md:flex-row md:items-center md:justify-between">
          <span className="min-w-0">
            <EntityLink entity={c.entity} />
            <span className="block text-fg-2">
              {c.label} · expected {formatDateTime(c.expectedAt, user.timezone)}
            </span>
          </span>
          <span className="flex items-center gap-2">
            <CheckpointStatusBadge status={c.status} />
            {c.permissions.addMetrics ? (
              <Link href={wsPath(addMetricsHref(c))} className="font-medium text-primary hover:underline">
                Add Metrics
              </Link>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  ) : (
    <p className="text-[13px] text-fg-2">{empty}</p>
  );
};

/** My Work → Metric Checkpoints: requests assigned to the member (overdue, due now, upcoming). */
export const MyMetricCheckpointsSection = () => {
  const { workspace } = useWorkspace();
  const wsPath = useWsPath();
  const q = useApiQuery(M.myCheckpoints, { params: { workspaceId: workspace.id } }, { refetchInterval: 5 * 60_000 });
  const d = q.data;
  return (
    <Panel
      title="Metric Checkpoints"
      actions={
        <Link className="text-[13px] font-medium text-primary hover:underline" href={wsPath('/metrics?mine=1')}>
          Open Metrics Inbox
        </Link>
      }
    >
      <QueryState query={q}>
        {d ? (
          d.overdue.length || d.due.length || d.upcoming.length ? (
            <div className="flex flex-col gap-4">
              {d.overdue.length ? (
                <section>
                  <h3 className="mb-1 text-[13px] font-semibold text-fg">Overdue</h3>
                  <CheckpointList items={d.overdue} empty="" />
                </section>
              ) : null}
              <section>
                <h3 className="mb-1 text-[13px] font-semibold text-fg">Due now</h3>
                <CheckpointList items={d.due} empty="Nothing is due right now." />
              </section>
              {d.upcoming.length ? (
                <section>
                  <h3 className="mb-1 text-[13px] font-semibold text-fg">Upcoming</h3>
                  <CheckpointList items={d.upcoming} empty="" />
                </section>
              ) : null}
            </div>
          ) : (
            <p className="text-[13px] text-fg-2">No metric checkpoints are waiting for you.</p>
          )
        ) : null}
      </QueryState>
    </Panel>
  );
};

/** Content Detail → Results: every published placement with its checkpoints and latest values. */
export const ContentResultsPanel = ({ contentId }: { contentId: string; projectId: string; tab: 'publications' | 'results' }) => {
  const { workspace, user } = useWorkspace();
  const wsPath = useWsPath();
  const q = useApiQuery(M.contentResults, { params: { workspaceId: workspace.id, contentItemId: contentId } });
  const d = q.data;
  return (
    <QueryState query={q}>
      {d ? (
        d.placements.length ? (
          <div className="flex flex-col gap-3">
            {d.placements.map((p) => (
              <Panel
                key={p.publication.id}
                title={<EntityLink entity={p.publication}>{p.publication.sublabel ?? p.publication.label}</EntityLink>}
                description={p.publishedAt ? `Published ${formatDateTime(p.publishedAt, user.timezone)}` : undefined}
                actions={
                  p.addMetrics ? (
                    <Link href={wsPath(`/metrics/new?publicationId=${p.publication.id}`)} className="text-[13px] font-medium text-primary hover:underline">
                      Add Metrics
                    </Link>
                  ) : undefined
                }
              >
                <div className="flex flex-col gap-3">
                  <ul className="flex flex-wrap gap-3 text-[13px]">
                    {p.checkpoints.map((c) => (
                      <li key={c.id} className="flex items-center gap-1.5">
                        <span className="text-fg-2">{c.label}</span>
                        <CheckpointStatusBadge status={c.status} />
                        <TimingBadge timing={c.timing} />
                      </li>
                    ))}
                  </ul>
                  {p.latest ? (
                    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                      {p.latest.headline.map((h) => (
                        <div key={h.metricKey}>
                          <dt className="text-[12px] text-fg-2">{h.label}</dt>
                          <dd className="text-[15px]">
                            <ObservationValue availability={h.availability} value={h.value} />
                          </dd>
                        </div>
                      ))}
                      <div>
                        <dt className="text-[12px] text-fg-2">Observed</dt>
                        <dd className="text-[13px]">
                          <Link href={wsPath(`/metrics/${p.latest.id}`)} className="hover:underline">
                            {formatDateTime(p.latest.observedAt, user.timezone)}
                          </Link>
                        </dd>
                      </div>
                    </dl>
                  ) : (
                    <p className="text-[13px] text-fg-2">{NO_DATA}</p>
                  )}
                </div>
              </Panel>
            ))}
            {d.hidden ? <p className="text-[12px] text-fg-2">{d.hidden} placement(s) on accounts outside your access are not shown.</p> : null}
          </div>
        ) : (
          <EmptyState icon={<Gauge size={28} />} title="No results yet" description="Results are recorded per placement after publication. No data recorded for this period." />
        )
      ) : null}
    </QueryState>
  );
};
