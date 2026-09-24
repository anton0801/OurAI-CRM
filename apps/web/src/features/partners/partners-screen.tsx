'use client';
import { Handshake, Plus } from '@phosphor-icons/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { dealEndpoints, partnerEndpoints, type DealSummary, type PartnerRow } from '@castlane/api-contracts';
import { DEAL_STAGES, PARTNER_KINDS } from '@castlane/domain';
import {
  Avatar,
  Badge,
  Button,
  DataTable,
  EmptyState,
  Input,
  MultiSelect,
  NoResults,
  PageHeader,
  StatusBadge,
  Switch,
  TabPanel,
  Tabs,
  Toolbar,
  formatDate,
  formatMoney,
  type Column,
} from '@castlane/ui';
import { EntitySelect } from '@/components/common/entity-select';
import { MemberSelect } from '@/components/common/pickers';
import { QueryState } from '@/components/common/query-state';
import { useDebounced } from '@/components/common/use-debounced';
import { useApiInfinite } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';
import '@/features/accounts/labels';
import { PartnerDrawer } from './partner-drawer';

type Filters = 'tab' | 'q' | 'kind' | 'stage' | 'ownerMembershipId' | 'partnerId' | 'projectId' | 'archived' | 'open' | 'create' | 'sort' | 'dir';

/** S73 Partners (and the deals list): business partners, never system users. */
export const PartnersScreen = () => {
  const can = useCan();
  const router = useRouter();
  const wsPath = useWsPath();
  const { state, set } = useUrlState<Filters>({ tab: can('partners.read') ? 'partners' : 'deals' });
  const tab = state.tab ?? 'partners';
  const tabs = [
    { value: 'partners', label: 'Partners', hidden: !can('partners.read') },
    { value: 'deals', label: 'Deals', hidden: !can('deals.read') },
  ];
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Partners"
        description="Brands and people the team works with. E-mail addresses are records only — Castlane never writes to partners."
        actions={
          <>
            {can('deals.write') ? (
              <Button icon={<Plus size={14} />} onClick={() => router.push(wsPath('/deals/new'))}>
                New Deal
              </Button>
            ) : null}
            {can('partners.write') ? (
              <Button variant="primary" icon={<Plus size={14} weight="bold" />} onClick={() => set({ create: '1' })}>
                Add Partner
              </Button>
            ) : null}
          </>
        }
      />
      <Tabs label="Partner sections" value={tab} onValueChange={(v) => set({ tab: v, sort: null, dir: null })} items={tabs}>
        <TabPanel value="partners">{tab === 'partners' ? <PartnersList /> : null}</TabPanel>
        <TabPanel value="deals">{tab === 'deals' ? <DealsList /> : null}</TabPanel>
      </Tabs>
      {state.open ? <PartnerDrawer partnerId={state.open} onClose={() => set({ open: null })} /> : null}
      {state.create === '1' ? <PartnerDrawer partnerId={null} onClose={() => set({ create: null })} onCreated={(id) => set({ create: null, open: id })} /> : null}
    </div>
  );
};

const PartnersList = () => {
  const { workspace, user } = useWorkspace();
  const can = useCan();
  const { state, set, list } = useUrlState<Filters>({ sort: 'name', dir: 'asc' });
  const [search, setSearch] = useState(state.q ?? '');
  const q = useDebounced(search, 250);
  const query = {
    q: q.length >= 2 ? q : undefined,
    kind: list('kind') as PartnerRow['kind'][],
    ownerMembershipId: state.ownerMembershipId,
    includeArchived: state.archived === '1' ? true : undefined,
    sort: (state.sort === 'updatedAt' ? 'updatedAt' : 'name') as 'name' | 'updatedAt',
    direction: (state.dir ?? 'asc') as 'asc' | 'desc',
  };
  const data = useApiInfinite(partnerEndpoints.list, { params: { workspaceId: workspace.id }, query });
  const filtered = !!(query.q || query.kind.length || query.ownerMembershipId);
  const columns: Column<PartnerRow>[] = [
    {
      key: 'name',
      header: 'Name',
      sortable: true,
      sticky: true,
      minWidth: 240,
      cell: (p) => (
        <span className="flex items-center gap-3">
          <Avatar name={p.name} src={p.logoUrl} size={32} decorative />
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-medium text-fg">{p.name}</span>
            <span className="text-[12px] text-fg-2">{label('partnerKind', p.kind)}</span>
          </span>
        </span>
      ),
    },
    { key: 'contact', header: 'Contact', minWidth: 180, cell: (p) => [p.contactName, p.businessEmail].filter(Boolean).join(' · ') || '—' },
    { key: 'owner', header: 'Owner', minWidth: 150, cell: (p) => p.owner.displayName },
    { key: 'tags', header: 'Tags', minWidth: 140, cell: (p) => <span className="flex flex-wrap gap-1">{p.tags.map((t) => <Badge key={t}>{t}</Badge>)}</span> },
    { key: 'active', header: 'Active Deals', align: 'right', minWidth: 110, cell: (p) => p.activeDeals },
    { key: 'last', header: 'Last Interaction', minWidth: 140, cell: (p) => (p.lastInteractionAt ? formatDate(p.lastInteractionAt, user.timezone) : <span className="text-fg-muted">None logged</span>) },
    { key: 'updatedAt', header: 'Updated', sortable: true, minWidth: 120, cell: (p) => formatDate(p.updatedAt, user.timezone) },
  ];
  return (
    <div className="mt-4 flex flex-col gap-4">
      <Toolbar>
        <div className="w-full sm:w-[220px]">
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              set({ q: e.target.value || null });
            }}
            placeholder="Search partners"
            aria-label="Search partners"
          />
        </div>
        <div className="w-[170px]">
          <MultiSelect aria-label="Kind" placeholder="Kind" value={list('kind')} onChange={(v) => set({ kind: v.join(',') || null })} options={PARTNER_KINDS.map((k) => ({ value: k, label: label('partnerKind', k) }))} />
        </div>
        <div className="w-[170px]">
          <MemberSelect aria-label="Owner" placeholder="Owner" value={state.ownerMembershipId} onChange={(v) => set({ ownerMembershipId: v })} clearable />
        </div>
        <Switch label="Show archived" checked={state.archived === '1'} onCheckedChange={(v) => set({ archived: v ? '1' : null })} />
      </Toolbar>
      <QueryState query={data}>
        {data.items.length === 0 && !data.isFetching ? (
          filtered ? (
            <NoResults
              onClear={() => {
                setSearch('');
                set({ q: null, kind: null, ownerMembershipId: null });
              }}
            />
          ) : (
            <EmptyState
              icon={<Handshake size={28} />}
              title="No partners yet"
              description={can('partners.write') ? 'Add the brands and people you work with to track deals and deliverables.' : 'No partners are shared with you yet. Partners appear through deals in your projects.'}
              action={can('partners.write') ? <Button variant="primary" onClick={() => set({ create: '1' })}>Add Partner</Button> : undefined}
            />
          )
        ) : (
          <DataTable
            caption="Partners"
            rows={data.items}
            columns={columns}
            getRowId={(p) => p.id}
            density={user.density}
            sort={{ key: query.sort, direction: query.direction }}
            onSortChange={(s) => set({ sort: s.key, dir: s.direction })}
            onRowClick={(p) => set({ open: p.id }, { replace: false })}
            selectedRowId={state.open ?? null}
            hasMore={data.hasNextPage}
            loadingMore={data.isFetchingNextPage}
            onLoadMore={() => void data.fetchNextPage()}
          />
        )}
      </QueryState>
    </div>
  );
};

export const DealsList = ({ partnerId, embedded }: { partnerId?: string; embedded?: boolean }) => {
  const { workspace, user } = useWorkspace();
  const can = useCan();
  const wsPath = useWsPath();
  const router = useRouter();
  const { state, set, list } = useUrlState<Filters>({ sort: 'updatedAt', dir: 'desc' });
  const [search, setSearch] = useState(state.q ?? '');
  const q = useDebounced(search, 250);
  const query = {
    q: q.length >= 2 ? q : undefined,
    stage: list('stage') as DealSummary['stage'][],
    partnerId: partnerId ?? state.partnerId,
    projectId: state.projectId,
    ownerMembershipId: state.ownerMembershipId,
    includeArchived: state.archived === '1' ? true : undefined,
    sort: (['updatedAt', 'title', 'stage', 'expectedCloseDate'].includes(state.sort ?? '') ? state.sort : 'updatedAt') as 'updatedAt' | 'title' | 'stage' | 'expectedCloseDate',
    direction: (state.dir ?? 'desc') as 'asc' | 'desc',
  };
  const data = useApiInfinite(dealEndpoints.list, { params: { workspaceId: workspace.id }, query });
  const filtered = !!(query.q || query.stage.length || (!partnerId && query.partnerId) || query.projectId || query.ownerMembershipId);
  const showAmounts = data.items.some((d) => d.amount !== undefined);
  const columns: Column<DealSummary>[] = [
    {
      key: 'title',
      header: 'Deal',
      sortable: true,
      sticky: true,
      minWidth: 220,
      cell: (d) => (
        <Link href={wsPath(`/deals/${d.id}`)} className="font-medium text-fg hover:underline" onClick={(e) => e.stopPropagation()}>
          {d.title}
        </Link>
      ),
    },
    { key: 'partner', header: 'Partner', minWidth: 160, hidden: !!partnerId, cell: (d) => d.partner.name },
    { key: 'stage', header: 'Stage', sortable: true, minWidth: 120, cell: (d) => <StatusBadge status={d.stage} label={label('dealStage', d.stage)} /> },
    { key: 'projects', header: 'Projects', minWidth: 160, cell: (d) => d.projects.map((p) => p.name).join(', ') },
    { key: 'owner', header: 'Owner', minWidth: 140, cell: (d) => d.owner.displayName },
    {
      key: 'amount',
      header: 'Planned Amount',
      align: 'right',
      minWidth: 140,
      hidden: !showAmounts,
      cell: (d) => (d.amount ? formatMoney(d.amount.amount, d.amount.currency) : <span className="text-fg-muted">Not provided</span>),
    },
    { key: 'deliverables', header: 'Open Deliverables', align: 'right', minWidth: 140, cell: (d) => `${d.deliverables.open} / ${d.deliverables.total}` },
    { key: 'expectedCloseDate', header: 'Expected Close', sortable: true, minWidth: 130, cell: (d) => (d.expectedCloseDate ? formatDate(d.expectedCloseDate) : '—') },
  ];
  return (
    <div className={embedded ? 'flex flex-col gap-3' : 'mt-4 flex flex-col gap-4'}>
      {!embedded ? (
        <Toolbar>
          <div className="w-full sm:w-[220px]">
            <Input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                set({ q: e.target.value || null });
              }}
              placeholder="Search deals or partners"
              aria-label="Search deals"
            />
          </div>
          <div className="w-[170px]">
            <MultiSelect aria-label="Stage" placeholder="Stage" value={list('stage')} onChange={(v) => set({ stage: v.join(',') || null })} options={DEAL_STAGES.map((s) => ({ value: s, label: label('dealStage', s) }))} />
          </div>
          <div className="w-[180px]">
            <EntitySelect type="project" aria-label="Project" placeholder="Project" value={state.projectId} onChange={(v) => set({ projectId: v })} clearable />
          </div>
          <div className="w-[170px]">
            <MemberSelect aria-label="Owner" placeholder="Owner" value={state.ownerMembershipId} onChange={(v) => set({ ownerMembershipId: v })} clearable />
          </div>
          <Switch label="Show archived" checked={state.archived === '1'} onCheckedChange={(v) => set({ archived: v ? '1' : null })} />
        </Toolbar>
      ) : null}
      <QueryState query={data}>
        {data.items.length === 0 && !data.isFetching ? (
          filtered ? (
            <NoResults
              onClear={() => {
                setSearch('');
                set({ q: null, stage: null, projectId: null, ownerMembershipId: null });
              }}
            />
          ) : (
            <EmptyState
              icon={<Handshake size={28} />}
              title="No deals yet"
              description={can('deals.write') ? 'Create a deal to track a collaboration from lead to fulfilled delivery. Amounts are plans, not revenue.' : 'No deals are shared with you yet.'}
              action={can('deals.write') ? <Button variant="primary" onClick={() => router.push(wsPath(`/deals/new${partnerId ? `?partnerId=${partnerId}` : ''}`))}>New Deal</Button> : undefined}
            />
          )
        ) : (
          <DataTable
            caption="Deals"
            rows={data.items}
            columns={columns}
            getRowId={(d) => d.id}
            density={embedded ? 'compact' : user.density}
            sort={embedded ? null : { key: query.sort, direction: query.direction }}
            onSortChange={embedded ? undefined : (s) => set({ sort: s.key, dir: s.direction })}
            onRowClick={(d) => router.push(wsPath(`/deals/${d.id}`))}
            hasMore={data.hasNextPage}
            loadingMore={data.isFetchingNextPage}
            onLoadMore={() => void data.fetchNextPage()}
          />
        )}
      </QueryState>
    </div>
  );
};
