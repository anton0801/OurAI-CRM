'use client';
import { ChartLineUp, Flask, Megaphone, Plus, Rows, Table } from '@phosphor-icons/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { campaignEndpoints as C, trackingLinkEndpoints as TL, type CampaignRow } from '@castlane/api-contracts';
import { CAMPAIGN_STATUSES, DateTime } from '@castlane/domain';
import {
  Avatar,
  Button,
  DataTable,
  EmptyState,
  Input,
  Menu,
  MultiSelect,
  NoResults,
  PageHeader,
  StatusBadge,
  Switch,
  Toolbar,
  formatDate,
  formatMoney,
  type Column,
} from '@castlane/ui';
import { EntitySelect } from '@/components/common/entity-select';
import { MemberSelect } from '@/components/common/pickers';
import { QueryState } from '@/components/common/query-state';
import { useDebounced } from '@/components/common/use-debounced';
import { useApiInfinite, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';
import { CampaignFormDrawer } from './campaign-form';
import { DuplicateCampaignDialog, ArchiveCampaignDialog } from './campaign-dialogs';

type Keys = 'q' | 'status' | 'projectId' | 'ownerMembershipId' | 'partnerId' | 'archived' | 'sort' | 'dir' | 'view' | 'new' | 'link';

const dateRange = (c: Pick<CampaignRow, 'startDate' | 'endDate'>) => `${formatDate(c.startDate)} – ${formatDate(c.endDate)}`;

/** Confirmed (source-reported) values; empty stays empty, never 0 by default. */
const Confirmed = ({ c }: { c: CampaignRow }) =>
  c.confirmedResults.reports === 0 ? (
    <span className="text-fg-muted">No source reports</span>
  ) : (
    <span className="text-[13px]">
      {c.confirmedResults.clicks ?? '—'} clicks · {c.confirmedResults.conversions ?? '—'} conversions
    </span>
  );

/** `?link=<trackingLinkId>` (search results, lookups) opens the campaign that owns the tagged link. */
const LinkRedirect = ({ linkId }: { linkId: string }) => {
  const { workspace } = useWorkspace();
  const wsPath = useWsPath();
  const router = useRouter();
  const q = useApiQuery(TL.get, { params: { workspaceId: workspace.id, linkId } });
  useEffect(() => {
    if (q.data) router.replace(wsPath(`/campaigns/${q.data.campaign.id}?tab=links&highlight=${q.data.id}`));
  }, [q.data, router, wsPath]);
  return <QueryState query={q}>{null}</QueryState>;
};

/** S33 Campaigns: table and timeline over campaigns visible through the member's projects. */
export const CampaignsScreen = () => {
  const { workspace, user } = useWorkspace();
  const can = useCan();
  const wsPath = useWsPath();
  const router = useRouter();
  const { state, set, list } = useUrlState<Keys>({ sort: 'startDate', dir: 'desc', view: 'table' });
  const [search, setSearch] = useState(state.q ?? '');
  const q = useDebounced(search, 250);
  const [duplicating, setDuplicating] = useState<CampaignRow | null>(null);
  const [archiving, setArchiving] = useState<CampaignRow | null>(null);
  const query = {
    q: q.length >= 2 ? q : undefined,
    status: list('status') as CampaignRow['status'][],
    projectId: state.projectId,
    ownerMembershipId: state.ownerMembershipId,
    partnerId: state.partnerId,
    includeArchived: state.archived === '1' ? true : undefined,
    sort: (state.sort ?? 'startDate') as 'startDate' | 'name' | 'updatedAt',
    direction: (state.dir ?? 'desc') as 'asc' | 'desc',
  };
  const data = useApiInfinite(C.list, { params: { workspaceId: workspace.id }, query }, { enabled: !state.link });
  const filtered = !!(query.q || query.status.length || query.projectId || query.ownerMembershipId || query.partnerId);
  const showBudget = data.items.some((i) => i.budget !== undefined && i.budget !== null);
  const canCreate = can('campaigns.write');

  if (state.link) return <LinkRedirect linkId={state.link} />;

  const rowMenu = (c: CampaignRow) => (
    <Menu
      label={`Actions for ${c.name}`}
      trigger={<Button size="sm" variant="ghost">Actions</Button>}
      items={[
        { label: 'Open', href: wsPath(`/campaigns/${c.id}`) },
        { label: 'Duplicate Structure', hidden: !canCreate, onSelect: () => setDuplicating(c) },
        { label: 'Archive', hidden: !canCreate || !['planned', 'closed'].includes(c.status), destructive: true, separatorBefore: true, onSelect: () => setArchiving(c) },
      ]}
    />
  );

  const columns: Column<CampaignRow>[] = [
    {
      key: 'name',
      header: 'Name',
      sortable: true,
      sticky: true,
      minWidth: 240,
      cell: (c) => (
        <span className="flex items-center gap-3">
          {c.coverUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={c.coverUrl} alt="" width={40} height={40} className="h-10 w-10 shrink-0 rounded-[8px] object-cover" loading="lazy" />
          ) : (
            <span aria-hidden className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[8px] bg-surface-2 text-fg-2">
              <Megaphone size={18} />
            </span>
          )}
          <span className="flex min-w-0 flex-col">
            <Link href={wsPath(`/campaigns/${c.id}`)} className="truncate font-medium text-fg hover:underline" onClick={(e) => e.stopPropagation()}>
              {c.name}
            </Link>
            <span className="truncate text-[12px] text-fg-2">{c.objective}</span>
          </span>
        </span>
      ),
    },
    {
      key: 'owner',
      header: 'Owner',
      minWidth: 160,
      cell: (c) => (
        <span className="flex items-center gap-2">
          <Avatar name={c.owner.displayName} src={c.owner.avatarUrl} size={24} decorative />
          <span className="truncate">{c.owner.displayName}</span>
        </span>
      ),
    },
    { key: 'startDate', header: 'Dates', sortable: true, minWidth: 190, cell: (c) => dateRange(c) },
    { key: 'status', header: 'Status', minWidth: 110, cell: (c) => <StatusBadge status={c.status} label={label('campaignStatus', c.status)} /> },
    { key: 'projects', header: 'Projects', minWidth: 160, cell: (c) => c.projects.map((p) => p.name).join(', ') },
    { key: 'placements', header: 'Planned / Published', align: 'right', minWidth: 150, cell: (c) => `${c.publications.planned} / ${c.publications.published}` },
    {
      key: 'budget',
      header: 'Budget',
      align: 'right',
      minWidth: 140,
      hidden: !showBudget,
      cell: (c) => (c.budget ? formatMoney(c.budget.planned.amount, c.budget.planned.currency) : <span className="text-fg-muted">No budget</span>),
    },
    { key: 'results', header: 'Confirmed results', minWidth: 200, cell: (c) => <Confirmed c={c} /> },
    { key: 'actions', header: <span className="sr-only">Actions</span>, minWidth: 90, cell: (c) => <span onClick={(e) => e.stopPropagation()}>{rowMenu(c)}</span> },
  ];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Campaigns"
        description="Group placements, tagged links and reported results across projects. Campaigns never create accounts or metrics."
        actions={
          <>
            {can('experiments.read') ? (
              <Button variant="ghost" icon={<Flask size={14} />} onClick={() => router.push(wsPath('/experiments'))}>
                Experiments
              </Button>
            ) : null}
            {canCreate ? (
              <Button variant="primary" icon={<Plus size={14} weight="bold" />} onClick={() => set({ new: '1' })}>
                New Campaign
              </Button>
            ) : null}
            {can('exports.create') ? (
              <Menu
                label="More campaign actions"
                trigger={<Button variant="ghost">More</Button>}
                items={[{ label: 'Export Campaigns', onSelect: () => router.push(wsPath('/exports?new=1&dataset=campaigns')) }]}
              />
            ) : null}
          </>
        }
      />
      <Toolbar>
        <div className="w-full sm:w-[240px]">
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              set({ q: e.target.value || null });
            }}
            placeholder="Search campaigns"
            aria-label="Search campaigns"
          />
        </div>
        <div className="w-[160px]">
          <MultiSelect
            aria-label="Status"
            placeholder="Status"
            value={list('status')}
            onChange={(v) => set({ status: v.join(',') || null })}
            options={CAMPAIGN_STATUSES.filter((s) => s !== 'archived').map((s) => ({ value: s, label: label('campaignStatus', s) }))}
          />
        </div>
        <div className="w-[180px]">
          <EntitySelect type="project" aria-label="Project" placeholder="Project" value={state.projectId ?? null} onChange={(v) => set({ projectId: v })} clearable />
        </div>
        <div className="w-[180px]">
          <MemberSelect aria-label="Owner" placeholder="Owner" value={state.ownerMembershipId} onChange={(v) => set({ ownerMembershipId: v })} clearable />
        </div>
        <div className="w-[180px]">
          <EntitySelect type="partner" aria-label="Partner" placeholder="Partner" value={state.partnerId ?? null} onChange={(v) => set({ partnerId: v })} clearable />
        </div>
        <div className="flex items-center gap-2 px-1">
          <Switch label="Show archived" checked={state.archived === '1'} onCheckedChange={(v) => set({ archived: v ? '1' : null })} />
        </div>
        <div className="ml-auto flex items-center gap-1" role="group" aria-label="View">
          <Button size="sm" variant={state.view !== 'timeline' ? 'secondary' : 'ghost'} icon={<Table size={14} />} aria-pressed={state.view !== 'timeline'} onClick={() => set({ view: 'table' })}>
            Table
          </Button>
          <Button size="sm" variant={state.view === 'timeline' ? 'secondary' : 'ghost'} icon={<Rows size={14} />} aria-pressed={state.view === 'timeline'} onClick={() => set({ view: 'timeline' })}>
            Timeline
          </Button>
        </div>
      </Toolbar>
      <QueryState query={data}>
        {data.items.length === 0 && !data.isFetching ? (
          filtered ? (
            <NoResults
              onClear={() => {
                setSearch('');
                set({ q: null, status: null, projectId: null, ownerMembershipId: null, partnerId: null });
              }}
            />
          ) : (
            <EmptyState
              icon={<ChartLineUp size={28} />}
              title="No campaigns yet"
              description="Create a campaign to group placements, tagged links and the results partners report."
              action={canCreate ? <Button variant="primary" onClick={() => set({ new: '1' })}>New Campaign</Button> : undefined}
            />
          )
        ) : state.view === 'timeline' ? (
          <div className="flex flex-col gap-3">
            <CampaignTimeline rows={data.items} tz={user.timezone} />
            {data.hasNextPage ? (
              <div className="flex justify-center">
                <Button onClick={() => void data.fetchNextPage()} loading={data.isFetchingNextPage}>
                  Load More
                </Button>
              </div>
            ) : null}
          </div>
        ) : (
          <DataTable
            caption="Campaigns"
            rows={data.items}
            columns={columns}
            getRowId={(c) => c.id}
            density={user.density}
            sort={{ key: query.sort, direction: query.direction }}
            onSortChange={(s) => set({ sort: s.key, dir: s.direction })}
            onRowClick={(c) => router.push(wsPath(`/campaigns/${c.id}`))}
            hasMore={data.hasNextPage}
            loadingMore={data.isFetchingNextPage}
            onLoadMore={() => void data.fetchNextPage()}
          />
        )}
      </QueryState>
      {state.new === '1' ? <CampaignFormDrawer open onOpenChange={(o) => !o && set({ new: null })} initialProjectId={state.projectId} /> : null}
      {duplicating ? <DuplicateCampaignDialog campaign={duplicating} open onOpenChange={(o) => !o && setDuplicating(null)} /> : null}
      {archiving ? <ArchiveCampaignDialog campaign={archiving} open onOpenChange={(o) => !o && setArchiving(null)} /> : null}
    </div>
  );
};

/** Timeline: one bar per campaign between its start and end dates; months as columns. */
const CampaignTimeline = ({ rows, tz }: { rows: CampaignRow[]; tz: string }) => {
  const wsPath = useWsPath();
  const { start, end, months } = useMemo(() => {
    const s = DateTime.fromISO(rows.reduce((m, r) => (r.startDate < m ? r.startDate : m), rows[0]!.startDate)).startOf('month');
    const e = DateTime.fromISO(rows.reduce((m, r) => (r.endDate > m ? r.endDate : m), rows[0]!.endDate)).endOf('month');
    const ms: DateTime[] = [];
    for (let d = s; d < e; d = d.plus({ months: 1 })) ms.push(d);
    return { start: s, end: e, months: ms };
  }, [rows]);
  const total = end.diff(start, 'days').days || 1;
  const pos = (iso: string) => (DateTime.fromISO(iso).diff(start, 'days').days / total) * 100;
  const today = DateTime.now().setZone(tz).toISODate()!;
  const todayPct = pos(today);
  return (
    <div className="overflow-x-auto rounded-[12px] border border-line bg-surface">
      <div className="min-w-[720px]">
        <div className="grid border-b border-line text-[12px] text-fg-2" style={{ gridTemplateColumns: `220px repeat(${months.length}, minmax(0, 1fr))` }}>
          <span className="px-3 py-2 font-semibold">Campaign</span>
          {months.map((m) => (
            <span key={m.toISODate()} className="border-l border-line px-2 py-2">
              {m.toFormat('LLL yyyy')}
            </span>
          ))}
        </div>
        <ul aria-label="Campaign timeline">
          {rows.map((c) => {
            const left = Math.max(0, pos(c.startDate));
            const width = Math.max(1.5, pos(DateTime.fromISO(c.endDate).plus({ days: 1 }).toISODate()!) - left);
            return (
              <li key={c.id} className="grid items-center border-b border-line last:border-b-0" style={{ gridTemplateColumns: '220px 1fr' }}>
                <span className="flex min-w-0 flex-col px-3 py-2">
                  <Link href={wsPath(`/campaigns/${c.id}`)} className="truncate text-[13px] font-medium text-fg hover:underline">
                    {c.name}
                  </Link>
                  <span className="text-[12px] text-fg-2">{label('campaignStatus', c.status)}</span>
                </span>
                <span className="relative block h-10">
                  {todayPct >= 0 && todayPct <= 100 ? <span aria-hidden className="absolute inset-y-0 w-px bg-danger/60" style={{ left: `${todayPct}%` }} /> : null}
                  <Link
                    href={wsPath(`/campaigns/${c.id}`)}
                    className="absolute top-2 flex h-6 items-center overflow-hidden rounded-[6px] border border-primary/40 bg-selection px-2 text-[12px] text-primary hover:border-primary"
                    style={{ left: `${left}%`, width: `${width}%` }}
                    aria-label={`${c.name}: ${dateRange(c)}, ${label('campaignStatus', c.status)}`}
                  >
                    <span className="truncate">{dateRange(c)}</span>
                  </Link>
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
};
