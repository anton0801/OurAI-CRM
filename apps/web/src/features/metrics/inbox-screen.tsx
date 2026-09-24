'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { DotsThree, Gauge, Plus } from '@phosphor-icons/react';
import { useState } from 'react';
import { metricsEndpoints as M, type CheckpointRow } from '@castlane/api-contracts';
import { CHECKPOINT_INBOX_TABS, METRIC_ENTITY_TYPES } from '@castlane/domain';
import { Badge, Button, Checkbox, DescriptionList, Drawer, EmptyState, IconButton, Input, Menu, NoResults, PageHeader, Panel, Select, TabPanel, Tabs, Toolbar, formatDateTime } from '@castlane/ui';
import { EntitySelect } from '@/components/common/entity-select';
import { QueryState } from '@/components/common/query-state';
import { useApiInfinite, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';
import { CheckpointStatusBadge, EntityLink, MetricValueText, QualityBadge, TimingBadge } from './common';
import { MarkMissingDialog } from './dialogs';
import { addMetricsHref, CheckpointsTable, ObservationsTable } from './tables';

type Tab = (typeof CHECKPOINT_INBOX_TABS)[number] | 'observations' | 'review' | 'definitions';
type Keys = 'tab' | 'projectId' | 'accountId' | 'entityType' | 'mine' | 'open' | 'definition' | 'q';

const TAB_EMPTY: Record<string, { title: string; description: string }> = {
  due: { title: 'Nothing is due right now', description: 'Checkpoints appear here when their collection window opens after a publication or an account snapshot date.' },
  overdue: { title: 'No overdue checkpoints', description: 'Checkpoints whose window has passed without values appear here until values are added or the request is marked unavailable.' },
  upcoming: { title: 'No upcoming checkpoints', description: 'Checkpoints expected in the next 7 days appear here.' },
  submitted: { title: 'No submitted checkpoints', description: 'Checkpoints completed with an observation appear here with the real observed time.' },
  missing: { title: 'No missing checkpoints', description: 'Requests closed as unavailable appear here with their reason.' },
  all: { title: 'No checkpoints yet', description: 'Checkpoints are created when a publication is marked published and for account snapshot dates.' },
};

/** S49 Metrics Inbox: expected checkpoints by status, observations, corrections to review and definitions. */
export const MetricsInboxScreen = () => {
  const { workspace } = useWorkspace();
  const can = useCan();
  const router = useRouter();
  const wsPath = useWsPath();
  const { state, set } = useUrlState<Keys>({ tab: 'due' });
  const [missing, setMissing] = useState<CheckpointRow | null>(null);
  const p = { workspaceId: workspace.id };
  const tab = (['observations', 'review', 'definitions', ...CHECKPOINT_INBOX_TABS] as string[]).includes(state.tab ?? '') ? (state.tab as Tab) : 'due';
  const mine = state.mine === '1';
  const scope = {
    projectId: state.projectId,
    accountId: state.accountId,
    entityType: state.entityType as (typeof METRIC_ENTITY_TYPES)[number] | undefined,
  };
  const summary = useApiQuery(M.inboxSummary, { params: p, query: { mine: mine || undefined } });
  const counts = summary.data;
  const filtered = !!(scope.projectId || scope.accountId || scope.entityType || mine);
  const clear = () => set({ projectId: null, accountId: null, entityType: null, mine: null });
  const addMetrics = (c: CheckpointRow) => router.push(wsPath(addMetricsHref(c)));

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Metrics"
        description="Expected checkpoints, recorded observations and corrections to review. Values are recorded as the source reports them; unknown values are never shown as zero."
        actions={
          <>
            {can('metrics.write') ? (
              <Button variant="primary" icon={<Plus size={14} weight="bold" />} onClick={() => router.push(wsPath('/metrics/new'))}>
                Add Metrics
              </Button>
            ) : null}
            {can('metrics.write') ? <Button onClick={() => router.push(wsPath('/metrics/new?mode=bulk'))}>Bulk Entry</Button> : null}
            <Menu
              label="More metrics actions"
              trigger={<IconButton label="More" variant="secondary" icon={<DotsThree size={18} weight="bold" />} />}
              items={[
                { label: 'Import CSV', href: wsPath('/imports?new=1&dataset=metric_observations'), hidden: !can(['imports.create', 'metrics.write']) },
                { label: 'Export Observations', href: wsPath('/exports?new=1&dataset=metric_observations'), hidden: !can('exports.create') },
                { label: 'Open Analytics', href: wsPath('/analytics'), separatorBefore: true },
              ]}
            />
          </>
        }
      />
      <Tabs
        label="Metrics inbox"
        value={tab}
        onValueChange={(v) => set({ tab: v, open: null })}
        items={[
          { value: 'due', label: 'Due', count: counts?.due },
          { value: 'overdue', label: 'Overdue', count: counts?.overdue },
          { value: 'upcoming', label: 'Upcoming', count: counts?.upcoming },
          { value: 'submitted', label: 'Submitted' },
          { value: 'missing', label: 'Missing' },
          { value: 'all', label: 'All Checkpoints' },
          { value: 'observations', label: 'Observations' },
          { value: 'review', label: 'Needs Review', count: counts?.needsReview },
          { value: 'definitions', label: 'Definitions' },
        ]}
      >
        {tab !== 'definitions' ? (
          <Toolbar className="pt-4">
            <div className="w-full sm:w-[200px]">
              <EntitySelect type="project" aria-label="Project" placeholder="All projects" value={state.projectId} onChange={(v) => set({ projectId: v })} clearable />
            </div>
            <div className="w-full sm:w-[220px]">
              <EntitySelect type="account" aria-label="Account" placeholder="All accounts" value={state.accountId} onChange={(v) => set({ accountId: v })} clearable filters={state.projectId ? { projectId: state.projectId } : undefined} />
            </div>
            <div className="w-full sm:w-[170px]">
              <Select
                aria-label="Record type"
                placeholder="All records"
                clearable
                value={state.entityType ?? null}
                onChange={(v) => set({ entityType: v })}
                options={METRIC_ENTITY_TYPES.map((t) => ({ value: t, label: label('metricEntityType', t) }))}
              />
            </div>
            {tab !== 'observations' && tab !== 'review' ? <Checkbox checked={mine} onCheckedChange={(v) => set({ mine: v ? '1' : null })} label="Assigned to me" /> : null}
          </Toolbar>
        ) : null}
        {CHECKPOINT_INBOX_TABS.map((t) => (
          <TabPanel key={t} value={t}>
            {tab === t ? <CheckpointTab tab={t} scope={scope} mine={mine} filtered={filtered} onClear={clear} onAddMetrics={addMetrics} onMarkMissing={setMissing} /> : null}
          </TabPanel>
        ))}
        <TabPanel value="observations">{tab === 'observations' ? <ObservationsTab scope={scope} filtered={filtered} onClear={clear} /> : null}</TabPanel>
        <TabPanel value="review">{tab === 'review' ? <ReviewTab scope={scope} /> : null}</TabPanel>
        <TabPanel value="definitions">{tab === 'definitions' ? <DefinitionsTab selected={state.definition} q={state.q} onSelect={(id) => set({ definition: id })} onQuery={(v) => set({ q: v || null })} /> : null}</TabPanel>
      </Tabs>
      {state.open ? <CheckpointDrawer id={state.open} onClose={() => set({ open: null })} onAddMetrics={addMetrics} onMarkMissing={setMissing} /> : null}
      {missing ? <MarkMissingDialog checkpoint={missing} onClose={() => setMissing(null)} /> : null}
    </div>
  );
};

const CheckpointTab = ({
  tab,
  scope,
  mine,
  filtered,
  onClear,
  onAddMetrics,
  onMarkMissing,
}: {
  tab: (typeof CHECKPOINT_INBOX_TABS)[number];
  scope: { projectId?: string; accountId?: string; entityType?: (typeof METRIC_ENTITY_TYPES)[number] };
  mine: boolean;
  filtered: boolean;
  onClear: () => void;
  onAddMetrics: (c: CheckpointRow) => void;
  onMarkMissing: (c: CheckpointRow) => void;
}) => {
  const { workspace } = useWorkspace();
  const can = useCan();
  const router = useRouter();
  const wsPath = useWsPath();
  const list = useApiInfinite(M.checkpoints, { params: { workspaceId: workspace.id }, query: { tab, ...scope, mine: mine || undefined } });
  return (
    <QueryState query={list}>
      {list.items.length === 0 && !list.isFetching ? (
        filtered ? (
          <NoResults onClear={onClear} />
        ) : (
          <EmptyState
            icon={<Gauge size={28} />}
            title={TAB_EMPTY[tab]!.title}
            description={TAB_EMPTY[tab]!.description}
            action={can('metrics.write') && (tab === 'due' || tab === 'all') ? <Button onClick={() => router.push(wsPath('/metrics/new'))}>Add Metrics</Button> : undefined}
          />
        )
      ) : (
        <CheckpointsTable
          rows={list.items}
          caption={`${label('checkpointStatus', tab === 'submitted' ? 'completed' : tab)} checkpoints`}
          onAddMetrics={tab === 'submitted' || tab === 'missing' ? undefined : onAddMetrics}
          onMarkMissing={tab === 'submitted' || tab === 'missing' ? undefined : onMarkMissing}
          hasMore={list.hasNextPage}
          loadingMore={list.isFetchingNextPage}
          onLoadMore={() => void list.fetchNextPage()}
        />
      )}
    </QueryState>
  );
};

const ObservationsTab = ({ scope, filtered, onClear }: { scope: { projectId?: string; accountId?: string; entityType?: (typeof METRIC_ENTITY_TYPES)[number] }; filtered: boolean; onClear: () => void }) => {
  const { workspace } = useWorkspace();
  const can = useCan();
  const router = useRouter();
  const wsPath = useWsPath();
  const list = useApiInfinite(M.observations, { params: { workspaceId: workspace.id }, query: scope });
  return (
    <QueryState query={list}>
      {list.items.length === 0 && !list.isFetching ? (
        filtered ? (
          <NoResults onClear={onClear} />
        ) : (
          <EmptyState
            icon={<Gauge size={28} />}
            title="No observations yet"
            description="Record follower snapshots, period results and publication results manually, in the Bulk Entry grid or with a CSV import. Account links do not import statistics or publish content."
            action={can('metrics.write') ? <Button variant="primary" onClick={() => router.push(wsPath('/metrics/new'))}>Add Metrics</Button> : undefined}
          />
        )
      ) : (
        <ObservationsTable rows={list.items} caption="Observations" hasMore={list.hasNextPage} loadingMore={list.isFetchingNextPage} onLoadMore={() => void list.fetchNextPage()} />
      )}
    </QueryState>
  );
};

const KIND_LABEL = { correction: 'Correction to review', conflict: 'Overlapping periods', unverified: 'Saved with warnings' } as const;

const ReviewTab = ({ scope }: { scope: { projectId?: string; accountId?: string; entityType?: (typeof METRIC_ENTITY_TYPES)[number] } }) => {
  const { workspace, user } = useWorkspace();
  const wsPath = useWsPath();
  const q = useApiQuery(M.reviewQueue, { params: { workspaceId: workspace.id }, query: { ...scope, limit: 100 } });
  return (
    <QueryState query={q}>
      {q.data?.length ? (
        <ul className="flex flex-col divide-y divide-line rounded-[12px] border border-line bg-surface">
          {q.data.map((item) => (
            <li key={`${item.kind}:${item.observation.id}`} className="flex flex-col gap-2 px-4 py-3 md:flex-row md:items-center md:justify-between">
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-2">
                  <Badge tone={item.kind === 'correction' ? 'warning' : item.kind === 'conflict' ? 'danger' : 'neutral'}>{KIND_LABEL[item.kind]}</Badge>
                  <EntityLink entity={item.observation.entity} />
                  <QualityBadge quality={item.observation.qualityState} />
                </span>
                <span className="mt-1 block text-[13px] text-fg-2">
                  {label('observationDataset', item.observation.dataset)} · observed {formatDateTime(item.observation.observedAt, user.timezone)} · {item.submittedBy?.displayName ?? 'Unknown member'} · {formatDateTime(item.submittedAt, user.timezone)}
                  {item.reason ? ` · ${item.reason}` : ''}
                </span>
              </span>
              <Link href={wsPath(`/metrics/${item.observation.id}`)} className="shrink-0 text-[13px] font-medium text-primary hover:underline">
                {item.kind === 'correction' ? 'Review Correction' : 'Open Record'}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title="Nothing needs review" description="Corrections waiting for approval, overlapping periods and entries saved with warnings appear here." />
      )}
    </QueryState>
  );
};

/** Metric definitions: recorded fields by dataset and the semantic metrics (formula in plain language). */
const DefinitionsTab = ({ selected, q, onSelect, onQuery }: { selected?: string; q?: string; onSelect: (id: string | null) => void; onQuery: (v: string) => void }) => {
  const { workspace } = useWorkspace();
  const cat = useApiQuery(M.catalog, { params: { workspaceId: workspace.id } }, { staleTime: 5 * 60_000 });
  const needle = (q ?? '').trim().toLowerCase();
  const match = (s: string) => !needle || s.toLowerCase().includes(needle);
  const def = cat.data?.fields.find((f) => f.id === selected);
  return (
    <QueryState query={cat}>
      {cat.data ? (
        <div className="flex flex-col gap-4">
          <div className="w-full sm:w-[280px]">
            <Input value={q ?? ''} onChange={(e) => onQuery(e.target.value)} placeholder="Search metrics" aria-label="Search metric definitions" />
          </div>
          <Panel title="Recorded fields" description="What can be entered per observation type. Definitions are versioned; different versions are never mixed.">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {cat.data.datasets.map((ds) => (
                <section key={ds.key}>
                  <h3 className="text-[13px] font-semibold text-fg">{ds.label}</h3>
                  <p className="mb-1 text-[12px] text-fg-2">{ds.description}</p>
                  <ul className="flex flex-col gap-0.5 text-[13px]">
                    {cat.data.fields
                      .filter((f) => ds.fields.includes(f.key) && match(`${f.label} ${f.key}`))
                      .map((f) => (
                        <li key={f.id}>
                          <button type="button" className="text-left text-primary hover:underline" onClick={() => onSelect(f.id)}>
                            {f.label}
                          </button>
                          <span className="text-fg-2"> · {f.key}</span>
                        </li>
                      ))}
                  </ul>
                </section>
              ))}
            </div>
          </Panel>
          <Panel title="Calculated metrics" description="Formulas used by Analytics, reports, goals and Overview.">
            <ul className="flex flex-col divide-y divide-line text-[13px]">
              {cat.data.semantic
                .filter((m) => match(`${m.id} ${m.label} ${m.description}`))
                .map((m) => (
                  <li key={m.id} className="py-2">
                    <span className="font-medium text-fg">
                      {m.id} · {m.label}
                    </span>
                    <span className="ml-2 text-fg-2">{m.rate ? 'Rate (compared in percentage points)' : m.additive ? 'Adds up across rows' : 'Computed per row'}</span>
                    <p className="text-fg-2">{m.description}</p>
                  </li>
                ))}
            </ul>
          </Panel>
          {def ? (
            <Drawer open onOpenChange={(v) => !v && onSelect(null)} title={def.label} description={`${def.key} · version ${def.version}`}>
              <DescriptionList
                columns={1}
                items={[
                  { label: 'Definition', value: def.description },
                  { label: 'Recorded for', value: `${label('metricEntityType', def.entityType)} · ${label('observationKind', def.observationKind)}` },
                  { label: 'Unit', value: def.unit },
                  { label: 'Value type', value: def.valueType.replace('_', ' ') },
                  { label: 'How values combine', value: { sum_non_overlapping: 'Summed over non-overlapping periods', last_snapshot: 'Latest snapshot', checkpoint_value: 'Value at a checkpoint (cumulative totals are never added up)', none: 'Not combined' }[def.aggregation] },
                  { label: 'Status', value: def.active ? 'Active' : 'Retired' },
                ]}
              />
            </Drawer>
          ) : null}
        </div>
      ) : null}
    </QueryState>
  );
};

/** Checkpoint details opened from links (`/metrics?open=<id>`). */
const CheckpointDrawer = ({ id, onClose, onAddMetrics, onMarkMissing }: { id: string; onClose: () => void; onAddMetrics: (c: CheckpointRow) => void; onMarkMissing: (c: CheckpointRow) => void }) => {
  const { workspace, user } = useWorkspace();
  const wsPath = useWsPath();
  const q = useApiQuery(M.checkpoint, { params: { workspaceId: workspace.id, checkpointId: id } });
  const c = q.data;
  return (
    <Drawer
      open
      onOpenChange={(v) => !v && onClose()}
      title={c ? `${c.entity.label} · ${c.label}` : 'Checkpoint'}
      footer={
        c && c.state === 'pending' ? (
          <>
            {c.permissions.markMissing ? <Button onClick={() => onMarkMissing(c)}>Mark Unavailable</Button> : null}
            {c.permissions.addMetrics ? (
              <Button variant="primary" onClick={() => onAddMetrics(c)}>
                Add Metrics
              </Button>
            ) : null}
          </>
        ) : undefined
      }
    >
      <QueryState query={q}>
        {c ? (
          <DescriptionList
            columns={1}
            items={[
              { label: 'Recorded for', value: <EntityLink entity={c.entity} /> },
              { label: 'Status', value: <span className="flex items-center gap-2"><CheckpointStatusBadge status={c.status} /><TimingBadge timing={c.timing} /></span> },
              { label: 'Expected', value: formatDateTime(c.expectedAt, user.timezone) },
              { label: 'Window', value: `${formatDateTime(c.windowStart, user.timezone)} – ${formatDateTime(c.windowEnd, user.timezone)}` },
              { label: 'Assignee', value: c.assignee?.displayName ?? 'Unassigned' },
              { label: 'Required fields', value: c.requiredMetrics.join(', ') || 'Any value', hidden: c.state !== 'pending' },
              {
                label: 'Observation',
                value: c.observationId ? (
                  <Link href={wsPath(`/metrics/${c.observationId}`)} className="text-primary hover:underline">
                    Observed {formatDateTime(c.observedAt, user.timezone)} by {c.reporter?.displayName ?? 'unknown member'}
                  </Link>
                ) : null,
                hidden: !c.observationId,
              },
              { label: 'Required fields present', value: <MetricValueText value={c.completeness} />, hidden: !c.completeness },
              { label: 'Missing reason', value: c.missingReason, hidden: !c.missingReason },
            ]}
          />
        ) : null}
      </QueryState>
    </Drawer>
  );
};
