'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ArrowRight, CheckCircle, Circle, DotsThree, Plus, WarningCircle } from '@phosphor-icons/react';
import { OVERVIEW_PERIODS, overviewEndpoints, type NeedsAttentionItem, type OverviewProjectRow, type OverviewResponse } from '@castlane/api-contracts';
import {
  Avatar,
  Badge,
  Button,
  DataTable,
  DateInput,
  EmptyState,
  Field,
  IconButton,
  KpiStrip,
  LineChart,
  Menu,
  PageHeader,
  Panel,
  Select,
  Skeleton,
  StatusBadge,
  Toolbar,
  formatDate,
  formatDateTime,
  formatMoney,
  formatNumber,
  type Column,
  type Kpi,
} from '@castlane/ui';
import { EntitySelect } from '@/components/common/entity-select';
import { DirectionSelect } from '@/components/common/pickers';
import { QueryState } from '@/components/common/query-state';
import { useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';
import { formatMeasured, hasMeasuredValue, MeasuredValue, UNAVAILABLE_TEXT } from '../goals/measured';
import './labels';

type Keys = 'period' | 'from' | 'to' | 'directionId' | 'projectId';
type Preset = (typeof OVERVIEW_PERIODS)[number];

const PERIOD_OPTIONS: { value: Preset; label: string }[] = [
  { value: 'last_7_days', label: 'Last 7 days' },
  { value: 'last_30_days', label: 'Last 30 days' },
  { value: 'this_week', label: 'This week' },
  { value: 'last_week', label: 'Last week' },
  { value: 'this_month', label: 'This month' },
  { value: 'last_month', label: 'Last month' },
  { value: 'this_quarter', label: 'This quarter' },
  { value: 'last_quarter', label: 'Last quarter' },
  { value: 'this_year', label: 'This year' },
  { value: 'custom', label: 'Custom dates' },
];

/** S08 Overview (§17, F03): filters in the URL, scoped KPIs that open their source records. */
export const OverviewScreen = () => {
  const { workspace, user } = useWorkspace();
  const can = useCan();
  const router = useRouter();
  const wsPath = useWsPath();
  const { state, set } = useUrlState<Keys>({ period: 'last_30_days' });
  const preset = (OVERVIEW_PERIODS as readonly string[]).includes(state.period ?? '') ? (state.period as Preset) : 'last_30_days';
  const customReady = preset !== 'custom' || (!!state.from && !!state.to);
  const query = {
    period: preset,
    from: preset === 'custom' ? state.from : undefined,
    to: preset === 'custom' ? state.to : undefined,
    directionId: state.directionId,
    projectId: state.projectId,
  };
  const q = useApiQuery(overviewEndpoints.get, { params: { workspaceId: workspace.id }, query }, { enabled: customReady });
  const exportHref = () => {
    const prefill = new URLSearchParams();
    if (state.directionId) prefill.set('directionId', state.directionId);
    if (state.projectId) prefill.set('projectId', state.projectId);
    return wsPath(`/exports?new=1&dataset=overview_projects${prefill.toString() ? `&prefill=${encodeURIComponent(prefill.toString())}` : ''}`);
  };
  const data = q.data;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Overview"
        description="What is produced, what is late and what needs a decision — for the projects you can see."
        actions={
          <>
            {can('projects.create') ? (
              <Button variant="primary" icon={<Plus size={14} weight="bold" />} onClick={() => router.push(wsPath('/projects/new'))}>
                New Project
              </Button>
            ) : null}
            <Menu
              label="More overview actions"
              trigger={<IconButton label="More" variant="secondary" icon={<DotsThree size={18} weight="bold" />} />}
              items={[
                { label: 'Open Review Queue', onSelect: () => router.push(wsPath('/reviews?status=pending')), hidden: !can('content.read') },
                { label: 'Export View', description: 'Projects table with the current filters, in the Export Center', onSelect: () => router.push(exportHref()), hidden: !can('exports.create') },
                { label: 'Open Analytics', onSelect: () => router.push(wsPath('/analytics')), hidden: !can(['analytics.production.read', 'analytics.accounts.read']) },
              ]}
            />
          </>
        }
      />
      <Toolbar>
        <div className="w-full sm:w-[180px]">
          <Select aria-label="Period" value={preset} onChange={(v) => set({ period: v ?? 'last_30_days', from: v === 'custom' ? state.from : null, to: v === 'custom' ? state.to : null })} options={PERIOD_OPTIONS} />
        </div>
        {preset === 'custom' ? (
          <div className="flex w-full flex-wrap items-end gap-2 sm:w-auto">
            <Field label="From" hideLabel>
              <DateInput aria-label="From" value={state.from ?? ''} max={state.to} onChange={(e) => set({ from: e.target.value || null })} />
            </Field>
            <span className="pb-2 text-[13px] text-fg-2">to</span>
            <Field label="To" hideLabel>
              <DateInput aria-label="To" value={state.to ?? ''} min={state.from} onChange={(e) => set({ to: e.target.value || null })} />
            </Field>
          </div>
        ) : null}
        {can('directions.read') ? (
          <div className="w-full sm:w-[200px]">
            <DirectionSelect aria-label="Direction" placeholder="All directions" value={state.directionId} onChange={(v) => set({ directionId: v, projectId: null })} clearable />
          </div>
        ) : null}
        <div className="w-full sm:w-[220px]">
          <EntitySelect type="project" aria-label="Project" placeholder="All projects" filters={state.directionId ? { directionId: state.directionId } : undefined} value={state.projectId} onChange={(v) => set({ projectId: v })} clearable />
        </div>
        {data ? (
          <span className="text-[12px] text-fg-2 sm:ml-auto">
            {formatDate(data.period.fromDate)} – {formatDate(data.period.toDate)} · {data.period.zone} · as of {formatDateTime(data.asOf, user.timezone)}
          </span>
        ) : null}
      </Toolbar>
      {!customReady ? (
        <EmptyState title="Choose the dates" description="Pick the first and last day of the custom period to see the Overview." />
      ) : (
        <QueryState query={q} skeleton={<OverviewSkeleton />}>
          {data ? data.setup.empty ? <SetupChecklist data={data} /> : <OverviewBody data={data} /> : null}
        </QueryState>
      )}
    </div>
  );
};

const OverviewSkeleton = () => (
  <div className="flex flex-col gap-5" role="status" aria-label="Loading overview">
    <Skeleton className="h-[92px] w-full rounded-[12px]" />
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
      <Skeleton className="h-[330px] lg:col-span-8" />
      <Skeleton className="h-[330px] lg:col-span-4" />
    </div>
    <Skeleton className="h-[280px] w-full" />
  </div>
);

/** T169: an empty workspace explains the first real steps instead of showing empty charts. */
const SetupChecklist = ({ data }: { data: OverviewResponse }) => {
  const router = useRouter();
  return (
    <Panel title="Get started" description="The Overview fills with real work as soon as your team starts a project. Nothing here is sample data.">
      <ol className="flex flex-col divide-y divide-line">
        {data.setup.steps.map((s, i) => (
          <li key={s.key} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <span className="flex items-center gap-3">
              {s.done ? <CheckCircle size={20} weight="fill" className="text-primary" aria-hidden /> : <Circle size={20} className="text-fg-muted" aria-hidden />}
              <span className="text-[14px] text-fg">
                <span className="sr-only">Step {i + 1}: </span>
                {s.label}
                <span className="sr-only">{s.done ? ' (done)' : ' (to do)'}</span>
              </span>
            </span>
            {s.done ? (
              <Badge tone="success">Done</Badge>
            ) : s.permitted ? (
              <Button variant={i === data.setup.steps.findIndex((x) => !x.done) ? 'primary' : 'secondary'} onClick={() => router.push(s.href)}>
                {s.label}
              </Button>
            ) : (
              <span className="max-w-[320px] text-[12px] text-fg-2">Your role cannot do this. Ask a workspace administrator or a project lead.</span>
            )}
          </li>
        ))}
      </ol>
    </Panel>
  );
};

const kpiValue = (k: OverviewResponse['kpis'][number]) =>
  hasMeasuredValue(k.value) ? formatMeasured(k.value) : <span className="text-[16px] font-medium text-fg-2">{formatMeasured(k.value, { short: true })}</span>;

const kpiDelta = (k: OverviewResponse['kpis'][number]): Kpi['delta'] => {
  const c = k.comparison;
  if (!c) return undefined;
  if (c.status !== 'known' || c.abs === null) return { text: `No comparison ${c.previousLabel.replace(/^vs /, 'with ')}`, tone: 'flat' };
  const abs = Number(c.abs);
  const sign = abs > 0 ? '+' : abs < 0 ? '−' : '±';
  const size = formatNumber(Math.abs(abs), { maximumFractionDigits: 2 });
  const text = c.unitLabel === 'pp' ? `${sign}${size} pp ${c.previousLabel}` : `${sign}${size}${c.pct !== null ? ` (${sign}${formatNumber(Math.abs(Number(c.pct)), { maximumFractionDigits: 1 })}%)` : ''} ${c.previousLabel}`;
  // Only On-Time Rate and Published have a "better" direction; Overdue up is worse.
  const better = k.key === 'overdue_tasks' ? abs < 0 : abs > 0;
  return { text, tone: abs === 0 ? 'flat' : better ? 'up' : 'down' };
};

const OverviewBody = ({ data }: { data: OverviewResponse }) => {
  const { user } = useWorkspace();
  const wsPath = useWsPath();
  const kpis: Kpi[] = data.kpis.map((k) => ({
    label: k.label,
    value: kpiValue(k),
    href: k.href ?? undefined,
    delta: kpiDelta(k),
    hint: k.value.coverage ? `${k.value.coverage.usable} of ${k.value.coverage.expected} expected inputs` : k.value.note && hasMeasuredValue(k.value) ? k.value.note : undefined,
  }));
  return (
    <div className="flex flex-col gap-5">
      {kpis.length ? <KpiStrip items={kpis} /> : null}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
        <Panel title="Production Trend" className="lg:col-span-8" description={data.trend.series.length ? `Per ${data.trend.grain} · missing points are gaps, not zero` : undefined}>
          {data.trend.series.length ? (
            <LineChart
              title="Production trend"
              height={260}
              unit={data.trend.series[0]!.unit === 'count' ? 'items' : data.trend.series[0]!.unit}
              formatX={(x) => formatDate(x)}
              series={data.trend.series.map((s) => ({ key: s.key, label: s.label, points: s.points.map((p) => ({ x: p.bucket, y: hasMeasuredValue(p.value) ? Number(p.value.value) : null })) }))}
            />
          ) : (
            <p className="flex h-[200px] items-center justify-center px-6 text-center text-[13px] text-fg-2">{data.trend.unavailableReason ?? UNAVAILABLE_TEXT.no_data}</p>
          )}
        </Panel>
        <NeedsAttention data={data} className="lg:col-span-4" />
      </div>
      <ProjectsPanel data={data} />
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
        {data.freshness ? <FreshnessPanel data={data} className={data.finance ? 'lg:col-span-7' : 'lg:col-span-12'} /> : null}
        {data.finance ? (
          <Panel
            title="Finance"
            description={`Posted records for the period, ${data.finance.baseCurrency}. Cash is shown separately.`}
            className={data.freshness ? 'lg:col-span-5' : 'lg:col-span-12'}
            actions={
              <Link href={wsPath('/finance')} className="text-[13px] font-medium text-primary hover:underline">
                Open Finance
              </Link>
            }
          >
            <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {[
                { l: 'Net Revenue', v: data.finance.netRevenue },
                { l: 'Operating Expenses', v: data.finance.operatingExpenses },
                { l: 'Operating Result', v: data.finance.operatingResult },
              ].map((x) => (
                <div key={x.l}>
                  <dt className="text-[12px] font-[550] text-fg-2">{x.l}</dt>
                  <dd className="font-mono text-[18px] font-semibold tabular-nums text-fg">{formatMoney(x.v.amount, x.v.currency)}</dd>
                </div>
              ))}
              <div>
                <dt className="text-[12px] font-[550] text-fg-2">Cash Movement</dt>
                <dd className="font-mono text-[14px] tabular-nums text-fg">
                  {data.finance.cash.length ? data.finance.cash.map((c) => <span key={c.currency} className="block">{formatMoney(c.movement.amount, c.movement.currency)}</span>) : <span className="text-fg-muted">No confirmed cash movement</span>}
                </dd>
              </div>
            </dl>
            {data.finance.grossIncomplete ? <p className="mt-3 text-[12px] text-warning">Gross revenue is incomplete: some statements are recorded as net only.</p> : null}
            {data.finance.draftCount ? <p className="mt-1 text-[12px] text-fg-2">{data.finance.draftCount} draft or submitted entries are not included.</p> : null}
          </Panel>
        ) : null}
      </div>
      <p className="text-[12px] text-fg-2">Figures include only records you can open. Time zone {user.timezone}.</p>
    </div>
  );
};

const ATTENTION_ICON = <WarningCircle size={16} aria-hidden />;

const NeedsAttention = ({ data, className }: { data: OverviewResponse; className?: string }) => {
  const [kind, setKind] = useState<NeedsAttentionItem['kind'] | null>(null);
  const items = data.needsAttention.items.filter((i) => !kind || i.kind === kind);
  const kinds = data.needsAttention.counts.filter((c) => c.count > 0);
  return (
    <Panel title="Needs Attention" description={data.needsAttention.total ? `${data.needsAttention.total} items in your scope` : 'Nothing overdue or blocked in your scope'} className={className} bodyClassName="p-0">
      {kinds.length ? (
        <div className="flex flex-wrap gap-1 border-b border-line px-4 py-2" role="group" aria-label="Filter by kind">
          <Button size="sm" variant={kind === null ? 'secondary' : 'ghost'} aria-pressed={kind === null} onClick={() => setKind(null)}>
            All
          </Button>
          {kinds.map((k) => (
            <Button key={k.kind} size="sm" variant={kind === k.kind ? 'secondary' : 'ghost'} aria-pressed={kind === k.kind} onClick={() => setKind(k.kind)}>
              {k.label} · {k.count}
            </Button>
          ))}
        </div>
      ) : null}
      {items.length ? (
        <ul className="max-h-[260px] divide-y divide-line overflow-y-auto" aria-label="Needs attention items">
          {items.map((i) => (
            <li key={`${i.kind}:${i.id}`} className="flex items-start gap-3 px-4 py-3">
              <span className={i.severity === 'danger' ? 'mt-0.5 text-danger' : 'mt-0.5 text-warning'}>{ATTENTION_ICON}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium text-fg" title={i.title}>
                  {i.title}
                </p>
                <p className="text-[12px] leading-[18px] text-fg-2">
                  <span className="sr-only">{i.severity === 'danger' ? 'Urgent: ' : 'Attention: '}</span>
                  {label('attentionKind', i.kind)} · {i.detail}
                  {i.project ? ` · ${i.project.name}` : ''}
                </p>
              </div>
              <Link href={i.href} className="inline-flex shrink-0 items-center gap-1 rounded-[6px] px-2 py-1 text-[12px] font-semibold text-primary hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-[var(--c-focus)]">
                {i.actionLabel}
                <ArrowRight size={12} aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-4 py-8 text-center text-[13px] text-fg-2">{data.needsAttention.total ? 'No items of this kind.' : 'No overdue tasks, waiting reviews or missing data in your scope.'}</p>
      )}
      {data.needsAttention.total > data.needsAttention.items.length ? (
        <p className="border-t border-line px-4 py-2 text-[12px] text-fg-2">Showing the most urgent {data.needsAttention.items.length} of {data.needsAttention.total}. Open a kind in its module for the full list.</p>
      ) : null}
    </Panel>
  );
};

const ProjectsPanel = ({ data }: { data: OverviewResponse }) => {
  const { user } = useWorkspace();
  const router = useRouter();
  const wsPath = useWsPath();
  const columns: Column<OverviewProjectRow>[] = [
    {
      key: 'name',
      header: 'Project',
      sticky: true,
      minWidth: 220,
      cell: (p) => (
        <span className="flex items-center gap-2">
          {p.thumbnailUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={p.thumbnailUrl} alt="" width={32} height={32} className="h-8 w-8 shrink-0 rounded-[6px] object-cover" loading="lazy" />
          ) : (
            <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[6px] bg-surface-2 text-[11px] font-semibold text-fg-2">
              {p.name.slice(0, 2).toUpperCase()}
            </span>
          )}
          <Link href={wsPath(`/projects/${p.id}`)} className="font-medium text-fg hover:underline" onClick={(e) => e.stopPropagation()}>
            {p.name}
          </Link>
        </span>
      ),
    },
    { key: 'status', header: 'Status', minWidth: 110, cell: (p) => <StatusBadge status={p.status} /> },
    { key: 'type', header: 'Type', minWidth: 100, cell: (p) => label('projectType', p.type) },
    {
      key: 'owner',
      header: 'Owner',
      minWidth: 160,
      cell: (p) => (
        <span className="flex items-center gap-2">
          <Avatar name={p.owner.displayName} src={p.owner.avatarUrl} size={24} decorative />
          <span className="truncate">{p.owner.displayName}</span>
        </span>
      ),
    },
    { key: 'open', header: 'Open Tasks', align: 'right', minWidth: 100, cell: (p) => p.openTasks },
    {
      key: 'overdue',
      header: 'Overdue',
      align: 'right',
      minWidth: 90,
      cell: (p) => (p.overdueTasks ? <Link href={wsPath(`/tasks?overdue=1&projectId=${p.id}`)} className="font-semibold text-warning hover:underline" onClick={(e) => e.stopPropagation()}>{p.overdueTasks}</Link> : 0),
    },
    {
      key: 'milestone',
      header: 'Next Milestone',
      minWidth: 200,
      cell: (p) => (p.nextMilestone ? <span>{p.nextMilestone.title}{p.nextMilestone.dueDate ? <span className="text-fg-2"> · {formatDate(p.nextMilestone.dueDate)}</span> : null}</span> : <span className="text-fg-muted">None planned</span>),
    },
    { key: 'last', header: 'Last Publication', minWidth: 160, cell: (p) => (p.lastPublicationAt ? formatDate(p.lastPublicationAt, user.timezone) : <span className="text-fg-muted">None yet</span>) },
  ];
  return (
    <Panel
      title="Projects"
      description={`${data.projects.total} project${data.projects.total === 1 ? '' : 's'} in view`}
      bodyClassName="p-0"
      actions={
        <Link href={wsPath('/projects')} className="text-[13px] font-medium text-primary hover:underline">
          All projects
        </Link>
      }
    >
      <DataTable caption="Projects in the Overview" rows={data.projects.items} columns={columns} getRowId={(p) => p.id} density={user.density} onRowClick={(p) => router.push(wsPath(`/projects/${p.id}`))} empty={<p className="p-6 text-center text-[13px] text-fg-2">No projects match these filters.</p>} />
    </Panel>
  );
};

const FreshnessPanel = ({ data, className }: { data: OverviewResponse; className?: string }) => {
  const { user } = useWorkspace();
  const wsPath = useWsPath();
  const f = data.freshness!;
  return (
    <Panel
      title="Data Freshness"
      className={className}
      bodyClassName="p-0"
      description={`${f.staleAccounts} of ${f.totalAccounts} active accounts without an observation in 7 days`}
      actions={
        <Link href={wsPath('/metrics')} className="text-[13px] font-medium text-primary hover:underline">
          Metrics Inbox
        </Link>
      }
    >
      <div className="flex flex-wrap items-baseline gap-2 border-b border-line px-4 py-3">
        <span className="text-[12px] font-[550] text-fg-2">Checkpoint coverage</span>
        <MeasuredValue value={f.coverage} className="font-mono text-[18px] font-semibold tabular-nums text-fg" />
        {f.coverage.coverage ? <span className="text-[12px] text-fg-2">{f.coverage.coverage.usable} usable of {f.coverage.coverage.expected} expected · Missing checkpoints are not usable</span> : null}
      </div>
      {f.accounts.length ? (
        <div className="max-h-[320px] overflow-auto">
          <table className="w-full min-w-[560px] text-left text-[13px]">
            <caption className="sr-only">Latest observations per account</caption>
            <thead className="sticky top-0 bg-surface">
              <tr className="border-b border-line text-[12px] text-fg-2">
                <th scope="col" className="px-4 py-2 font-[550]">Account</th>
                <th scope="col" className="px-4 py-2 font-[550]">Last Observed</th>
                <th scope="col" className="px-4 py-2 font-[550]">Last Entered</th>
                <th scope="col" className="px-4 py-2 font-[550]">Status</th>
              </tr>
            </thead>
            <tbody>
              {f.accounts.map((a) => (
                <tr key={a.id} className="border-b border-line last:border-b-0">
                  <td className="px-4 py-2">
                    <Link href={wsPath(`/accounts/${a.id}`)} className="font-medium text-fg hover:underline">
                      {a.label}
                    </Link>
                    <span className="block text-[12px] text-fg-2">
                      {label('platform', a.platform)} · {a.project.name}
                    </span>
                  </td>
                  <td className="px-4 py-2">{a.lastObservedAt ? formatDateTime(a.lastObservedAt, user.timezone) : <span className="text-fg-muted">Never</span>}</td>
                  <td className="px-4 py-2">{a.lastEnteredAt ? formatDateTime(a.lastEnteredAt, user.timezone) : <span className="text-fg-muted">Never</span>}</td>
                  <td className="px-4 py-2">{a.overdue ? <Badge tone="warning">Update Needed</Badge> : <Badge tone="success">Fresh</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="px-4 py-6 text-[13px] text-fg-2">No active accounts in view. Account links do not import statistics or publish content.</p>
      )}
    </Panel>
  );
};
