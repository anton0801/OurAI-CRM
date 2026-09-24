'use client';
import { ArrowsLeftRight } from '@phosphor-icons/react';
import { ofmEndpoints as E, type OfmHandoverSummary } from '@castlane/api-contracts';
import { HANDOVER_STATES } from '@castlane/domain';
import { Badge, DataTable, EmptyState, MultiSelect, NoResults, PageHeader, StatusBadge, Tabs, Toolbar, formatDateTime, type Column } from '@castlane/ui';
import { QueryState } from '@/components/common/query-state';
import { useApiInfinite } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';
import { useWorkspace, useWsPath } from '@/lib/workspace-context';
import { AccountChip, MemberChip, OfmNav } from './common';
import { HandoverDetailDrawer } from './handover-dialogs';
import { OfmAccountSelect, OfmModelSelect } from './pickers';

type Keys = 'box' | 'state' | 'projectId' | 'accountId' | 'open';
type Box = 'incoming' | 'outgoing' | 'unacknowledged' | 'all';

/** S44 Handover Desk: incoming and outgoing handovers; acknowledgement never resolves the items. */
export const HandoversScreen = () => {
  const { workspace, user } = useWorkspace();
  const wsPath = useWsPath();
  const { state, set, list } = useUrlState<Keys>({ box: 'incoming' });
  const box = (['incoming', 'outgoing', 'unacknowledged', 'all'].includes(state.box ?? '') ? state.box : 'incoming') as Box;
  const states = list('state') as OfmHandoverSummary['state'][];
  const data = useApiInfinite(E.listHandovers, {
    params: { workspaceId: workspace.id },
    query: { box, state: states.length ? states : undefined, projectId: state.projectId, accountId: state.accountId },
  });
  const filtered = !!(states.length || state.projectId || state.accountId);
  const columns: Column<OfmHandoverSummary>[] = [
    { key: 'from', header: 'From', sticky: true, minWidth: 190, cell: (h) => <MemberChip member={h.fromShift.member} size={28} /> },
    { key: 'to', header: 'To', minWidth: 190, cell: (h) => <MemberChip member={h.recipient} size={28} /> },
    { key: 'account', header: 'Account', minWidth: 170, cell: (h) => <AccountChip account={h.account} /> },
    { key: 'summary', header: 'Summary', minWidth: 260, cell: (h) => <span className="line-clamp-2">{h.summary}</span> },
    {
      key: 'items',
      header: 'Items',
      minWidth: 170,
      cell: (h) => (h.noOpenItems && !h.itemCounts.open && !h.itemCounts.accepted && !h.itemCounts.resolved ? 'No open items' : `${h.itemCounts.open} open · ${h.itemCounts.accepted} accepted · ${h.itemCounts.resolved} resolved`),
    },
    { key: 'priority', header: 'Priority', minWidth: 100, cell: (h) => (h.highestPriority ? <Badge tone={h.highestPriority === 'urgent' ? 'danger' : h.highestPriority === 'high' ? 'warning' : 'neutral'}>{label('priority', h.highestPriority)}</Badge> : '—') },
    { key: 'fromShift', header: 'From Shift', minWidth: 160, cell: (h) => formatDateTime(h.fromShift.scheduledStart, user.timezone) },
    { key: 'submitted', header: 'Submitted', minWidth: 160, cell: (h) => (h.submittedAt ? formatDateTime(h.submittedAt, user.timezone) : '—') },
    { key: 'ack', header: 'Acknowledged', minWidth: 160, cell: (h) => (h.acknowledgedAt ? formatDateTime(h.acknowledgedAt, user.timezone) : '—') },
    { key: 'state', header: 'Status', minWidth: 190, cell: (h) => <StatusBadge status={h.state === 'acknowledged' ? 'approved' : h.state === 'submitted' ? 'pending' : 'draft'} label={label('handoverState', h.state)} /> },
  ];
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Handover Desk"
        crumbs={[{ label: 'OFM', href: wsPath('/ofm') }, { label: 'Handovers' }]}
        description="Unfinished matters passed between shifts. Tasks and operations are linked by ID, never copied. When no next shift exists the supervisor receives the handover."
      />
      <OfmNav />
      <Tabs
        label="Handover boxes"
        value={box}
        onValueChange={(v) => set({ box: v, open: null })}
        items={[
          { value: 'incoming', label: 'Incoming' },
          { value: 'outgoing', label: 'Outgoing' },
          { value: 'unacknowledged', label: 'Unacknowledged' },
          { value: 'all', label: 'All' },
        ]}
      />
      <Toolbar>
        <div className="w-full sm:w-[190px]">
          <OfmModelSelect aria-label="Model" placeholder="All models" value={state.projectId} onChange={(v) => set({ projectId: v, accountId: null })} clearable />
        </div>
        <div className="w-full sm:w-[190px]">
          <OfmAccountSelect aria-label="Account" placeholder="All accounts" projectId={state.projectId} value={state.accountId} onChange={(v) => set({ accountId: v })} clearable />
        </div>
        <div className="w-full sm:w-[240px]">
          <MultiSelect aria-label="Status" placeholder="Any status" value={states} onChange={(v) => set({ state: v.join(',') || null })} options={HANDOVER_STATES.map((s) => ({ value: s, label: label('handoverState', s) }))} />
        </div>
      </Toolbar>
      <QueryState query={data}>
        {data.items.length === 0 && !data.isFetching ? (
          filtered ? (
            <NoResults onClear={() => set({ state: null, projectId: null, accountId: null })} />
          ) : (
            <EmptyState
              icon={<ArrowsLeftRight size={28} />}
              title={box === 'incoming' ? 'No handovers for you' : box === 'outgoing' ? 'You have not written handovers' : 'No handovers'}
              description="Handovers are written from the Shift Workspace when a shift ends."
            />
          )
        ) : (
          <DataTable
            caption="Handovers"
            rows={data.items}
            columns={columns}
            getRowId={(h) => h.id}
            density={user.density}
            onRowClick={(h) => set({ open: h.id })}
            selectedRowId={state.open ?? null}
            hasMore={data.hasNextPage}
            loadingMore={data.isFetchingNextPage}
            onLoadMore={() => void data.fetchNextPage()}
          />
        )}
      </QueryState>
      {state.open ? <HandoverDetailDrawer id={state.open} onClose={() => set({ open: null })} /> : null}
    </div>
  );
};
