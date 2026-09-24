'use client';
import { DotsThree, LinkSimple, PencilSimple, Play, Scales } from '@phosphor-icons/react';
import Link from 'next/link';
import { useState } from 'react';
import { experimentEndpoints as X, type ExperimentDetail, type ExperimentResults } from '@castlane/api-contracts';
import {
  Avatar,
  Badge,
  Banner,
  Button,
  DataTable,
  DescriptionList,
  EmptyState,
  IconButton,
  Menu,
  PageHeader,
  Panel,
  StatusBadge,
  TabPanel,
  Tabs,
  formatDateTime,
  type MenuItem,
  type Tone,
} from '@castlane/ui';
import { QueryState } from '@/components/common/query-state';
import { useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';
import { useWorkspace, useWsPath } from '@/lib/workspace-context';
import { PlatformLabel } from '@/features/accounts/platform';
import { PublicationBadges, whenText } from '@/features/publications/format';
import { ARCHIVE_EXPLANATION } from '@/features/publications/labels';
import {
  ArchiveExperimentDialog,
  ConcludeExperimentDialog,
  DuplicateExperimentDialog,
  LinkPublicationsDialog,
  RESULT_STATUS,
  StartExperimentDialog,
  UnlinkPublicationDialog,
} from './experiment-dialogs';
import { ExperimentFormDrawer } from './experiment-form';
import { NOT_COMPARABLE_NOTE, ORGANIC_CAVEAT, windowText } from './labels';

type DialogKind = 'edit' | 'start' | 'conclude' | 'link' | 'duplicate' | 'archive' | null;

const RESULT_TONE: Record<ExperimentResults['status'], Tone> = { comparable: 'success', not_comparable: 'warning', insufficient_sample: 'warning', no_data: 'neutral' };
const STATE_TONE: Record<string, Tone> = { comparable: 'success', too_young: 'info', no_observation_in_window: 'warning', unknown_value: 'warning', not_published: 'neutral', removed: 'danger' };

/** S35 experiment page: plan, variants, linked placements, comparable results, conclusion and plan revisions. */
export const ExperimentDetailScreen = ({ experimentId }: { experimentId: string }) => {
  const { workspace } = useWorkspace();
  const q = useApiQuery(X.get, { params: { workspaceId: workspace.id, experimentId } });
  return <QueryState query={q}>{q.data ? <ExperimentView e={q.data} /> : null}</QueryState>;
};

const ExperimentView = ({ e }: { e: ExperimentDetail }) => {
  const wsPath = useWsPath();
  const { state, set } = useUrlState<'tab'>({ tab: 'overview' });
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [linkVariant, setLinkVariant] = useState<string | undefined>(undefined);
  const [unlinking, setUnlinking] = useState<ExperimentDetail['publications'][number] | null>(null);
  const perm = e.permissions;
  const open = e.status === 'draft' || e.status === 'running';
  const tabs = [
    { value: 'overview', label: 'Plan' },
    { value: 'publications', label: `Publications (${e.publicationCount})` },
    { value: 'results', label: 'Comparable Results' },
    { value: 'history', label: 'Plan History' },
  ];
  const active = tabs.find((t) => t.value === state.tab)?.value ?? 'overview';
  const menu: MenuItem[] = [
    { label: 'Duplicate Hypothesis', hidden: !perm.duplicate, onSelect: () => setDialog('duplicate') },
    { label: 'Archive', hidden: !perm.archive || !['draft', 'concluded'].includes(e.status), destructive: true, separatorBefore: true, onSelect: () => setDialog('archive') },
  ];
  const openLink = (variantId?: string) => {
    setLinkVariant(variantId);
    setDialog('link');
  };

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        crumbs={[{ label: 'Experiments', href: wsPath('/experiments') }, { label: 'Experiment' }]}
        title={<span className="break-words">{e.hypothesis}</span>}
        meta={
          <>
            <StatusBadge status={e.status} label={label('experimentStatus', e.status)} />
            <Link href={wsPath(`/projects/${e.project.id}`)} className="text-[13px] text-fg-2 hover:underline">
              {e.project.name}
            </Link>
            <span className="flex items-center gap-1.5 text-[13px] text-fg-2">
              <Avatar name={e.owner.displayName} src={e.owner.avatarUrl} size={24} decorative /> {e.owner.displayName}
            </span>
            <span className="text-[13px] text-fg-2">
              {e.primaryMetricLabel} at {windowText(e.observationWindowHours)}
            </span>
            {e.planFrozenAt ? <Badge>Plan version {e.planVersion}</Badge> : null}
          </>
        }
        actions={
          <>
            {perm.start && e.status === 'draft' ? (
              <Button variant="primary" icon={<Play size={14} />} onClick={() => setDialog('start')}>
                Start
              </Button>
            ) : null}
            {perm.conclude && e.status === 'running' ? (
              <Button variant="primary" icon={<Scales size={14} />} onClick={() => setDialog('conclude')}>
                Conclude
              </Button>
            ) : null}
            {perm.linkPublications && open ? (
              <Button icon={<LinkSimple size={14} />} onClick={() => openLink()}>
                Link Publications
              </Button>
            ) : null}
            {perm.update && open ? (
              <Button icon={<PencilSimple size={14} />} onClick={() => setDialog('edit')}>
                {e.status === 'running' ? 'Revise Plan' : 'Edit'}
              </Button>
            ) : null}
            {menu.some((m) => !m.hidden) ? <Menu label="More actions" trigger={<IconButton label="More actions" icon={<DotsThree size={18} weight="bold" />} variant="secondary" />} items={menu} /> : null}
          </>
        }
      />
      <Banner tone="info">{ORGANIC_CAVEAT}</Banner>
      {e.status === 'archived' ? <Banner tone="info">{ARCHIVE_EXPLANATION}</Banner> : null}
      <Tabs label="Experiment sections" value={active} onValueChange={(v) => set({ tab: v })} items={tabs}>
        <TabPanel value="overview">{active === 'overview' ? <PlanTab e={e} /> : null}</TabPanel>
        <TabPanel value="publications">
          {active === 'publications' ? <PublicationsTab e={e} onLink={perm.linkPublications && open ? openLink : undefined} onUnlink={perm.linkPublications && open ? setUnlinking : undefined} /> : null}
        </TabPanel>
        <TabPanel value="results">{active === 'results' ? <ResultsTab e={e} /> : null}</TabPanel>
        <TabPanel value="history">{active === 'history' ? <HistoryTab e={e} /> : null}</TabPanel>
      </Tabs>
      {dialog === 'edit' ? <ExperimentFormDrawer open experiment={e} onOpenChange={(o) => !o && setDialog(null)} /> : null}
      {dialog === 'start' ? <StartExperimentDialog experiment={e} onClose={() => setDialog(null)} /> : null}
      {dialog === 'conclude' ? <ConcludeExperimentDialog experiment={e} onClose={() => setDialog(null)} /> : null}
      {dialog === 'link' ? <LinkPublicationsDialog experiment={e} initialVariantId={linkVariant} onClose={() => setDialog(null)} /> : null}
      {dialog === 'duplicate' ? <DuplicateExperimentDialog experiment={e} onClose={() => setDialog(null)} /> : null}
      {dialog === 'archive' ? <ArchiveExperimentDialog experiment={e} onClose={() => setDialog(null)} /> : null}
      {unlinking ? <UnlinkPublicationDialog experiment={e} link={unlinking} onClose={() => setUnlinking(null)} /> : null}
    </div>
  );
};

const PlanTab = ({ e }: { e: ExperimentDetail }) => {
  const { user } = useWorkspace();
  const wsPath = useWsPath();
  const [showAll, setShowAll] = useState(false);
  // At most 4 variant images at once (160×100).
  const shown = showAll ? e.variants : e.variants.slice(0, 4);
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <Panel title="Plan" className="lg:col-span-2">
        <DescriptionList
          items={[
            { label: 'Hypothesis', value: e.hypothesis },
            { label: 'Project', value: e.project.name },
            { label: 'Primary metric', value: e.primaryMetricLabel },
            { label: 'Observation window', value: `${windowText(e.observationWindowHours)} after publishing` },
            { label: 'Minimum sample', value: `${e.minimumSample} comparable placements per variant` },
            { label: 'Planned start', value: e.startAt ? formatDateTime(e.startAt, user.timezone) : null },
            { label: 'Planned end', value: e.endAt ? formatDateTime(e.endAt, user.timezone) : null },
            { label: 'Plan frozen', value: e.planFrozenAt ? `${formatDateTime(e.planFrozenAt, user.timezone)} · version ${e.planVersion}` : 'Not started' },
            { label: 'Duplicated from', value: e.duplicatedFrom ? <Link href={wsPath(`/experiments/${e.duplicatedFrom.id}`)} className="hover:underline">{e.duplicatedFrom.hypothesis}</Link> : null, hidden: !e.duplicatedFrom },
          ]}
        />
        {e.limitations ? (
          <div className="mt-4">
            <h3 className="text-[12px] font-[550] text-fg-2">Limitations</h3>
            <p className="whitespace-pre-wrap text-[14px] text-fg">{e.limitations}</p>
          </div>
        ) : null}
      </Panel>
      <Panel title="Conclusion">
        {e.conclusion ? (
          <div className="flex flex-col gap-3 text-[14px]">
            <p className="whitespace-pre-wrap text-fg">{e.conclusion.findings}</p>
            <p className="text-[13px] text-fg-2">
              <span className="font-semibold">Limitations:</span> {e.conclusion.limitations}
            </p>
            {e.selectedVariant ? (
              <p className="text-[13px] text-fg-2">
                <span className="font-semibold">Selected variant:</span> {e.selectedVariant.name} — {e.conclusion.selectionRationale}
              </p>
            ) : (
              <p className="text-[13px] text-fg-2">No variant was selected.</p>
            )}
            <p className="text-[12px] text-fg-muted">
              Concluded {formatDateTime(e.conclusion.concludedAt, user.timezone)}
              {e.conclusion.concludedBy ? ` by ${e.conclusion.concludedBy}` : ''}. The results at that moment are kept as evidence.
            </p>
          </div>
        ) : (
          <p className="text-[14px] text-fg-2">{e.status === 'running' ? 'Running. Conclude with findings and limitations when the window has passed.' : 'Not concluded.'}</p>
        )}
      </Panel>
      <Panel title="Variants" className="lg:col-span-3">
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {shown.map((v) => (
            <li key={v.id} className="flex flex-col gap-2 rounded-[12px] border border-line p-3">
              {v.thumbnailUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={v.thumbnailUrl} alt={`Example of variant ${v.name}`} width={160} height={100} className="h-[100px] w-[160px] rounded-[8px] object-cover" loading="lazy" />
              ) : null}
              <span className="flex items-center gap-2">
                <span className="font-semibold text-fg">{v.name}</span>
                {e.selectedVariant?.id === v.id ? <Badge tone="success">Selected</Badge> : null}
              </span>
              {v.description ? <p className="text-[13px] text-fg-2">{v.description}</p> : null}
              <span className="text-[12px] text-fg-muted">{v.publicationCount} linked placement(s)</span>
            </li>
          ))}
        </ul>
        {e.variants.length > 4 ? (
          <div className="mt-3">
            <Button size="sm" variant="ghost" onClick={() => setShowAll(!showAll)}>
              {showAll ? 'Show fewer' : `Show all ${e.variants.length} variants`}
            </Button>
          </div>
        ) : null}
        <p className="mt-3 text-[12px] text-fg-muted">
          Images are examples only; results come only from recorded observations.
        </p>
      </Panel>
    </div>
  );
};

const PublicationsTab = ({
  e,
  onLink,
  onUnlink,
}: {
  e: ExperimentDetail;
  onLink?: (variantId?: string) => void;
  onUnlink?: (l: ExperimentDetail['publications'][number]) => void;
}) => {
  const { user } = useWorkspace();
  const wsPath = useWsPath();
  return (
    <div className="flex flex-col gap-4">
      {e.hiddenPublications ? <Banner tone="info">{e.hiddenPublications} linked placement(s) are outside your access and not shown. They still count in the results.</Banner> : null}
      {e.variants.map((v) => {
        const rows = e.publications.filter((p) => p.variantId === v.id);
        return (
          <Panel
            key={v.id}
            title={`Variant ${v.name}`}
            actions={
              onLink ? (
                <Button size="sm" onClick={() => onLink(v.id)}>
                  Link Publications
                </Button>
              ) : undefined
            }
          >
            {rows.length ? (
              <DataTable
                caption={`Placements of variant ${v.name}`}
                rows={rows}
                getRowId={(r) => r.linkId}
                density={user.density}
                columns={[
                  {
                    key: 'title',
                    header: 'Placement',
                    sticky: true,
                    minWidth: 220,
                    cell: (r) => (
                      <Link href={wsPath(`/publications/${r.publication.id}`)} className="font-medium text-fg hover:underline">
                        {r.publication.title}
                      </Link>
                    ),
                  },
                  {
                    key: 'account',
                    header: 'Account',
                    minWidth: 160,
                    cell: (r) => (
                      <span className="flex items-center gap-2">
                        <PlatformLabel platform={r.publication.account.platform} iconOnly />
                        <span className="truncate">{r.publication.account.label}</span>
                      </span>
                    ),
                  },
                  { key: 'segment', header: 'Segment', minWidth: 100, cell: (r) => <Badge tone={r.segment === 'paid' ? 'warning' : 'neutral'}>{label('segment', r.segment)}</Badge> },
                  { key: 'when', header: 'When', minWidth: 220, cell: (r) => <span className="text-[13px]">{whenText(r.publication, user.timezone)}</span> },
                  { key: 'status', header: 'Status', minWidth: 180, cell: (r) => <PublicationBadges p={r.publication} compact /> },
                  {
                    key: 'actions',
                    header: <span className="sr-only">Actions</span>,
                    minWidth: 90,
                    hidden: !onUnlink,
                    cell: (r) => (
                      <Button size="sm" variant="ghost" onClick={() => onUnlink?.(r)}>
                        Remove
                      </Button>
                    ),
                  },
                ]}
              />
            ) : (
              <p className="text-[14px] text-fg-2">No placements linked to this variant.</p>
            )}
          </Panel>
        );
      })}
    </div>
  );
};

const num = (v: string | null) => (v === null ? <span className="text-fg-muted">—</span> : <span className="font-mono tabular-nums">{v}</span>);

const ResultsTab = ({ e }: { e: ExperimentDetail }) => {
  const { workspace, user } = useWorkspace();
  const wsPath = useWsPath();
  const q = useApiQuery(X.results, { params: { workspaceId: workspace.id, experimentId: e.id } });
  const variantName = (id: string) => e.variants.find((v) => v.id === id)?.name ?? '—';
  return (
    <QueryState query={q}>
      {q.data ? (
        <div className="flex flex-col gap-4">
          <Panel title="Comparison">
            <div className="flex flex-col gap-3">
              <span className="flex flex-wrap items-center gap-2">
                <Badge tone={RESULT_TONE[q.data.status]}>{RESULT_STATUS[q.data.status]}</Badge>
                <span className="text-[13px] text-fg-2">
                  {q.data.metricLabel} at {windowText(q.data.windowHours)} ± {q.data.toleranceHours} h · evaluated {formatDateTime(q.data.evaluatedAt, user.timezone)}
                </span>
              </span>
              {q.data.reasons.length ? (
                <ul className="list-disc pl-5 text-[13px] text-fg-2">
                  {q.data.reasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              ) : null}
              <p className="text-[13px] text-fg-2">{q.data.caveat}</p>
              <p className="text-[12px] text-fg-muted">
                Method: {q.data.method} {NOT_COMPARABLE_NOTE}
              </p>
            </div>
          </Panel>
          {q.data.segments.length ? (
            q.data.segments.map((s) => (
              <Panel key={s.segment} title={`${label('segment', s.segment)} placements`}>
                <DataTable
                  caption={`${label('segment', s.segment)} results by variant`}
                  rows={s.variants}
                  getRowId={(v) => v.variantId}
                  density={user.density}
                  columns={[
                    { key: 'name', header: 'Variant', sticky: true, minWidth: 140, cell: (v) => <span className="font-medium text-fg">{v.name}</span> },
                    { key: 'n', header: 'Comparable', align: 'right', minWidth: 110, cell: (v) => (v.sampleSize < e.minimumSample ? <span className="text-warning">{v.sampleSize} (below {e.minimumSample})</span> : v.sampleSize) },
                    { key: 'median', header: 'Median', align: 'right', minWidth: 100, cell: (v) => num(v.median) },
                    { key: 'mean', header: 'Mean', align: 'right', minWidth: 100, cell: (v) => num(v.mean) },
                    { key: 'range', header: 'Min – Max', align: 'right', minWidth: 140, cell: (v) => (v.min === null ? num(null) : `${v.min} – ${v.max}`) },
                    { key: 'outliers', header: 'Outliers', align: 'right', minWidth: 90, cell: (v) => v.outliers.length },
                    {
                      key: 'excluded',
                      header: 'Not counted',
                      minWidth: 240,
                      cell: (v) => {
                        const parts = Object.entries(v.excluded).filter(([, n]) => n > 0);
                        return parts.length ? parts.map(([k, n]) => `${label('comparableState', k)}: ${n}`).join(' · ') : <span className="text-fg-muted">—</span>;
                      },
                    },
                  ]}
                />
              </Panel>
            ))
          ) : (
            <EmptyState title="No data recorded" description="Link placements and record their metrics at the observation window to compare the variants." />
          )}
          {q.data.items.length ? (
            <Panel title="Placements and observations">
              <DataTable
                caption="Experiment observations"
                rows={q.data.items}
                getRowId={(i) => `${i.publicationId}-${i.segment}`}
                density={user.density}
                columns={[
                  {
                    key: 'title',
                    header: 'Placement',
                    sticky: true,
                    minWidth: 200,
                    cell: (i) => (
                      <Link href={wsPath(`/publications/${i.publicationId}`)} className="font-medium text-fg hover:underline">
                        {i.title}
                      </Link>
                    ),
                  },
                  { key: 'variant', header: 'Variant', minWidth: 100, cell: (i) => variantName(i.variantId) },
                  { key: 'segment', header: 'Segment', minWidth: 100, cell: (i) => label('segment', i.segment) },
                  { key: 'state', header: 'State', minWidth: 190, cell: (i) => <Badge tone={STATE_TONE[i.state] ?? 'neutral'}>{label('comparableState', i.state)}</Badge> },
                  { key: 'age', header: 'Post age', align: 'right', minWidth: 100, cell: (i) => (i.ageHours === null ? num(null) : `${Math.floor(i.ageHours)} h`) },
                  { key: 'value', header: 'Value', align: 'right', minWidth: 100, cell: (i) => num(i.value) },
                  { key: 'observed', header: 'Observed at age', align: 'right', minWidth: 130, cell: (i) => (i.observedAgeHours === null ? num(null) : `${i.observedAgeHours.toFixed(1)} h`) },
                  { key: 'observedAt', header: 'Observed', minWidth: 170, cell: (i) => (i.observedAt ? formatDateTime(i.observedAt, user.timezone) : num(null)) },
                ]}
              />
            </Panel>
          ) : null}
        </div>
      ) : null}
    </QueryState>
  );
};

const HistoryTab = ({ e }: { e: ExperimentDetail }) => {
  const { user } = useWorkspace();
  return (
    <Panel title="Plan revisions">
      {e.revisions.length ? (
        <ol className="flex flex-col gap-3">
          {e.revisions.map((r) => (
            <li key={r.id} className="flex flex-col gap-1 rounded-[8px] border border-line px-3 py-2 text-[14px]">
              <span className="flex items-center gap-2">
                <Badge>Version {r.planVersion}</Badge>
                <span className="text-[12px] text-fg-muted">{formatDateTime(r.createdAt, user.timezone)}</span>
              </span>
              {r.reason ? <p className="text-fg">{r.reason}</p> : null}
              <details className="text-[12px] text-fg-2">
                <summary className="cursor-pointer">Plan snapshot</summary>
                <pre className="mt-2 max-h-[240px] overflow-auto whitespace-pre-wrap rounded-[8px] bg-surface-2 p-2 font-mono text-[11px]">{JSON.stringify(r.snapshot, null, 2)}</pre>
              </details>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-[14px] text-fg-2">The plan is frozen as version 1 when the experiment starts. Later changes appear here with their reasons.</p>
      )}
    </Panel>
  );
};
