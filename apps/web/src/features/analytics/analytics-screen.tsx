'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChartLineUp, Info } from '@phosphor-icons/react';
import { analyticsEndpoints as A, type AnalyticsDashboard, type AnalyticsKpi } from '@castlane/api-contracts';
import { ANALYTICS_TABS, CONTENT_FORMATS, PERIOD_PRESETS, PLATFORMS, TIME_GRAINS } from '@castlane/domain';
import { Banner, Button, Checkbox, DateInput, Drawer, EmptyState, MultiSelect, PageHeader, PermissionDenied, Select, Skeleton, TabPanel, Tabs, Toolbar, Tooltip, cn, formatDateTime, formatNumber } from '@castlane/ui';
import { EntitySelect, MultiEntitySelect } from '@/components/common/entity-select';
import { QueryState } from '@/components/common/query-state';
import { useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';
import { MetricValueText, NO_DATA, metricDetails, sourceAge } from '../metrics/common';
import '../metrics/labels';
import { AnalyticsChartView, AnalyticsTableView } from './views';

type Tab = (typeof ANALYTICS_TABS)[number];
type Keys = 'tab' | 'preset' | 'from' | 'to' | 'compare' | 'directionId' | 'projectIds' | 'accountIds' | 'platforms' | 'formats' | 'grain' | 'drill' | 'dgroup' | 'dkey';

/** Client-side hint of the tabs a member may open (the server decides; 403 is shown otherwise). */
const TAB_PERMISSION: Record<Tab, string> = {
  production: 'analytics.production.read',
  accounts: 'analytics.accounts.read',
  content: 'analytics.content.read',
  ofm: 'analytics.ofm.read',
  team: 'analytics.team.read',
  finance: 'analytics.finance.read',
};

const EMPTY_COPY: Record<Tab, string> = {
  production: 'Published placements, approved content and tasks appear here once they exist in the selected period.',
  accounts: 'Follower snapshots and period results appear here once they are recorded in the Metrics Inbox.',
  content: 'Publication results appear here once values are recorded at their checkpoints.',
  ofm: 'Shifts, shift reports and OFM period results appear here once they are recorded.',
  team: 'Completed tasks, reviews and approved time appear here once they exist in the selected period.',
  finance: 'Posted ledger entries, settlements and budgets appear here. Drafts never count.',
};

/** S51 Analytics: KPI tiles with formula tooltips and equal-window comparison, charts, tables and drill-down. */
export const AnalyticsScreen = () => {
  const { workspace } = useWorkspace();
  const can = useCan();
  const wsPath = useWsPath();
  const { state, set, list } = useUrlState<Keys>({ preset: 'last_30_days', compare: 'true' });
  const allowed = ANALYTICS_TABS.filter((t) => can(TAB_PERMISSION[t]));
  const tab: Tab = (allowed as string[]).includes(state.tab ?? '') ? (state.tab as Tab) : (allowed[0] ?? 'production');
  const preset = ((PERIOD_PRESETS as readonly string[]).includes(state.preset ?? '') ? state.preset : 'last_30_days') as (typeof PERIOD_PRESETS)[number];
  const custom = preset === 'custom';
  const query = {
    preset,
    from: custom ? state.from : undefined,
    to: custom ? state.to : undefined,
    compare: state.compare !== 'false',
    directionId: state.directionId,
    projectIds: list('projectIds'),
    accountIds: list('accountIds'),
    platforms: list('platforms') as (typeof PLATFORMS)[number][],
    formats: list('formats') as (typeof CONTENT_FORMATS)[number][],
    grain: state.grain as (typeof TIME_GRAINS)[number] | undefined,
  };
  const ready = !custom || (!!state.from && !!state.to);
  const q = useApiQuery(A.dashboard, { params: { workspaceId: workspace.id, tab }, query }, { enabled: allowed.length > 0 && ready });
  if (!allowed.length) return <PermissionDenied description="You do not have access to analytics." />;
  const filtered = !!(query.directionId || query.projectIds.length || query.accountIds.length || query.platforms.length || query.formats.length);
  const tabs = q.data?.availableTabs ?? allowed;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Analytics"
        description="Metrics are calculated from source records in your access scope. Hover or focus a value to see its formula, sample and source age."
        actions={
          can('reports.read') ? (
            <Link href={wsPath('/reports')} className="text-[13px] font-medium text-primary hover:underline">
              Open Report Builder
            </Link>
          ) : undefined
        }
      />
      <Toolbar>
        <div className="w-full sm:w-[170px]">
          <Select aria-label="Period" value={preset} onChange={(v) => v && set({ preset: v })} options={PERIOD_PRESETS.map((p) => ({ value: p, label: label('periodPreset', p) }))} />
        </div>
        {custom ? (
          <>
            <DateInput aria-label="From" className="w-[150px]" value={state.from ?? ''} onChange={(e) => set({ from: e.target.value || null })} />
            <DateInput aria-label="To" className="w-[150px]" value={state.to ?? ''} onChange={(e) => set({ to: e.target.value || null })} />
          </>
        ) : null}
        <div className="w-full sm:w-[170px]">
          <EntitySelect type="direction" aria-label="Direction" placeholder="All directions" value={state.directionId} onChange={(v) => set({ directionId: v })} clearable />
        </div>
        <div className="w-full sm:w-[200px]">
          <MultiEntitySelect type="project" aria-label="Projects" placeholder="All projects" value={list('projectIds')} onChange={(v) => set({ projectIds: v.join(',') || null })} />
        </div>
        <div className="w-full sm:w-[200px]">
          <MultiEntitySelect type="account" aria-label="Accounts" placeholder="All accounts" value={list('accountIds')} onChange={(v) => set({ accountIds: v.join(',') || null })} />
        </div>
        <div className="w-full sm:w-[160px]">
          <MultiSelect aria-label="Platforms" placeholder="All platforms" value={list('platforms')} onChange={(v) => set({ platforms: v.join(',') || null })} options={PLATFORMS.map((p) => ({ value: p, label: label('platform', p) }))} />
        </div>
        <div className="w-full sm:w-[160px]">
          <MultiSelect aria-label="Content types" placeholder="All content types" value={list('formats')} onChange={(v) => set({ formats: v.join(',') || null })} options={CONTENT_FORMATS.map((f) => ({ value: f, label: label('contentFormat', f) }))} />
        </div>
        <div className="w-full sm:w-[130px]">
          <Select aria-label="Chart grain" placeholder="Auto grain" clearable value={state.grain ?? null} onChange={(v) => set({ grain: v })} options={TIME_GRAINS.map((g) => ({ value: g, label: `By ${label('timeGrain', g).toLowerCase()}` }))} />
        </div>
        <Checkbox checked={query.compare} onCheckedChange={(v) => set({ compare: v ? null : 'false' })} label="Compare with previous period" />
        {filtered ? (
          <Button variant="ghost" size="sm" onClick={() => set({ directionId: null, projectIds: null, accountIds: null, platforms: null, formats: null })}>
            Clear Filters
          </Button>
        ) : null}
      </Toolbar>
      <Tabs label="Dashboards" value={tab} onValueChange={(v) => set({ tab: v, drill: null, dgroup: null, dkey: null })} items={ANALYTICS_TABS.map((t) => ({ value: t, label: label('analyticsTab', t), hidden: !tabs.includes(t) }))}>
        <TabPanel value={tab}>
          {!ready ? (
            <Banner tone="info">Choose the start and end dates of the custom period.</Banner>
          ) : (
            <QueryState query={q} skeleton={<DashboardSkeleton />}>
              {q.data ? <Dashboard d={q.data} tab={tab} onDrill={(metric) => set({ drill: metric, dgroup: null, dkey: null })} /> : null}
            </QueryState>
          )}
        </TabPanel>
      </Tabs>
      {state.drill ? <DrillDownDrawer metric={state.drill} query={query} groupDimension={state.dgroup} groupKey={state.dkey} onClose={() => set({ drill: null, dgroup: null, dkey: null })} /> : null}
    </div>
  );
};

const DashboardSkeleton = () => (
  <div className="flex flex-col gap-4" role="status" aria-label="Loading">
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {Array.from({ length: 8 }, (_, i) => (
        <Skeleton key={i} className="h-[104px]" />
      ))}
    </div>
    <Skeleton className="h-[300px]" />
  </div>
);

const Dashboard = ({ d, tab, onDrill }: { d: AnalyticsDashboard; tab: Tab; onDrill: (metric: string) => void }) => {
  const { user } = useWorkspace();
  const can = useCan();
  const router = useRouter();
  const wsPath = useWsPath();
  if (d.empty)
    return (
      <EmptyState
        icon={<ChartLineUp size={28} />}
        title={NO_DATA}
        description={`${EMPTY_COPY[tab]} Nothing is estimated or filled in: charts appear once source records exist.`}
        action={
          <>
            {can('metrics.write') && (tab === 'accounts' || tab === 'content') ? (
              <Button variant="primary" onClick={() => router.push(wsPath('/metrics/new'))}>
                Add Metrics
              </Button>
            ) : null}
            {tab === 'accounts' || tab === 'content' ? <Button onClick={() => router.push(wsPath('/metrics'))}>Open Metrics Inbox</Button> : null}
            {tab === 'finance' && can('finance.create') ? <Button onClick={() => router.push(wsPath('/finance/entries/new'))}>Add Entry</Button> : null}
          </>
        }
      />
    );
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[12px] text-fg-2">
        {d.period.fromDate} – {d.period.toDate} ({d.period.zone})
        {d.comparison ? ` · compared with ${d.comparison.fromDate} – ${d.comparison.toDate}` : ''}
        {d.period.elapsedOnly ? ' · unfinished period: elapsed part only' : ''} · as of {formatDateTime(d.asOf, user.timezone)}
        {d.freshness ? ` · last observation ${sourceAge(d.freshness.lastObservedAt)}` : ''}
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {d.kpis.map((k) => (
          <KpiTile key={k.metricId} k={k} onDrill={() => onDrill(k.metricId)} />
        ))}
      </div>
      {d.notes.length ? (
        <ul className="flex flex-col gap-1 text-[12px] text-fg-2">
          {d.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {d.charts.map((c) => (
          <AnalyticsChartView key={c.key} chart={c} />
        ))}
      </div>
      {d.tables.map((t) => (
        <AnalyticsTableView key={t.key} table={t} />
      ))}
    </div>
  );
};

const deltaText = (k: AnalyticsKpi) => {
  const d = k.delta;
  if (!d) return null;
  if (d.status !== 'known' || d.abs === null) return { text: 'No comparison', tone: 'none' as const };
  const n = Number(d.abs);
  const sign = n > 0 ? '+' : n < 0 ? '−' : '±';
  const abs = formatNumber(Math.abs(n), { maximumFractionDigits: 2 });
  const text = d.unitLabel === 'pp' ? `${sign}${abs} pp vs previous` : `${sign}${abs}${d.pct !== null ? ` (${sign}${formatNumber(Math.abs(Number(d.pct)), { maximumFractionDigits: 1 })}%)` : ''} vs previous`;
  const tone = n === 0 || k.higherIsBetter === null ? ('flat' as const) : (n > 0) === k.higherIsBetter ? ('up' as const) : ('down' as const);
  return { text, tone };
};

/** KPI tile: value with availability, formula tooltip (sample size, exclusions, source age), comparison, drill-down. */
const KpiTile = ({ k, onDrill }: { k: AnalyticsKpi; onDrill: () => void }) => {
  const delta = deltaText(k);
  const details = metricDetails(k.value);
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-[12px] border border-line bg-surface px-4 py-3">
      <div className="flex items-start justify-between gap-2">
        <span className="text-[12px] font-[550] leading-[18px] text-fg-2">{k.label}</span>
        <Tooltip
          content={
            <span className="flex flex-col gap-1">
              <span>{k.description}</span>
              {details.map((x) => (
                <span key={x}>{x}</span>
              ))}
              <span>Source: {sourceAge(k.sourceAsOf)}</span>
            </span>
          }
        >
          <button type="button" aria-label={`How ${k.label} is calculated`} className="rounded-full text-fg-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-[var(--c-focus)]">
            <Info size={16} />
          </button>
        </Tooltip>
      </div>
      <span className={cn('text-[24px] font-semibold leading-8', k.value.value === null && 'text-[15px] font-normal')}>
        <MetricValueText value={k.value} />
      </span>
      {delta && delta.tone !== 'none' ? <span className={cn('text-[12px]', delta.tone === 'up' ? 'text-primary' : delta.tone === 'down' ? 'text-danger' : 'text-fg-2')}>{delta.text}</span> : delta ? <span className="text-[12px] text-fg-muted">{delta.text}</span> : null}
      {k.value.sampleSize !== undefined ? <span className="text-[12px] text-fg-2">Sample: {k.value.sampleSize}</span> : null}
      {k.drillable ? (
        <button type="button" onClick={onDrill} className="mt-auto self-start text-[12px] font-medium text-primary hover:underline">
          Drill Down
        </button>
      ) : null}
    </div>
  );
};

/** Exact source records behind a value; records the member cannot open are counted, never listed. */
const DrillDownDrawer = ({
  metric,
  query,
  groupDimension,
  groupKey,
  onClose,
}: {
  metric: string;
  query: Record<string, unknown>;
  groupDimension?: string;
  groupKey?: string;
  onClose: () => void;
}) => {
  const { workspace, user } = useWorkspace();
  const q = useApiQuery(A.drillDown, { params: { workspaceId: workspace.id }, query: { ...(query as object), metric, groupDimension: groupDimension as never, groupKey } as never });
  const d = q.data;
  return (
    <Drawer open onOpenChange={(v) => !v && onClose()} width={760} title={d ? `${d.label}: source records` : 'Source records'} description={d?.description}>
      <QueryState query={q}>
        {d ? (
          d.items.length ? (
            <div className="flex flex-col gap-2">
              <ul className="flex flex-col divide-y divide-line rounded-[12px] border border-line">
                {d.items.map((i) => (
                  <li key={`${i.entityType}:${i.entityId}`} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-[13px]">
                    <span className="min-w-0">
                      <Link href={i.href} className="font-medium text-fg hover:underline">
                        {i.label}
                      </Link>
                      <span className="block text-fg-2">
                        {[i.sublabel, i.at ? formatDateTime(i.at, user.timezone) : null].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                    {i.value !== null ? <span className="font-mono tabular-nums text-fg">{formatNumber(i.value)}</span> : null}
                  </li>
                ))}
              </ul>
              <p className="text-[12px] text-fg-2">
                {d.total} record(s){d.truncated ? `, first ${d.items.length} shown` : ''}
                {d.hidden ? ` · ${d.hidden} record(s) you cannot open are not listed` : ''}.
              </p>
            </div>
          ) : (
            <p className="text-[13px] text-fg-2">{d.hidden ? `${d.hidden} record(s) you cannot open are not listed.` : NO_DATA}</p>
          )
        ) : null}
      </QueryState>
    </Drawer>
  );
};

