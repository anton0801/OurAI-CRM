'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FileText, Plus } from '@phosphor-icons/react';
import { useState } from 'react';
import { reportEndpoints as R, type ReportScheduleRow, type ReportSnapshotSummary, type ReportSummary } from '@castlane/api-contracts';
import { Badge, Button, Checkbox, DataTable, EmptyState, Input, NoResults, PageHeader, Select, TabPanel, Tabs, Toolbar, formatDateTime, type Column } from '@castlane/ui';
import { QueryState } from '@/components/common/query-state';
import { useDebounced } from '@/components/common/use-debounced';
import { useApiInfinite, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';
import '../metrics/labels';

type Keys = 'tab' | 'scope' | 'q' | 'archived' | 'schedule';

/** S52 Reports: saved and shared reports, my snapshots (including scheduled deliveries) and my schedules. */
export const ReportsScreen = () => {
  const can = useCan();
  const router = useRouter();
  const wsPath = useWsPath();
  const { state, set } = useUrlState<Keys>({ tab: 'reports', scope: 'all' });
  const tab = ['reports', 'snapshots', 'schedules'].includes(state.tab ?? '') ? state.tab! : 'reports';
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        crumbs={[{ label: 'Analytics', href: wsPath('/analytics') }, { label: 'Reports' }]}
        title="Reports"
        description="Build reports from the same metric definitions as Analytics. Shared and scheduled reports always show each member only their own permitted data."
        actions={
          can('reports.create') ? (
            <Button variant="primary" icon={<Plus size={14} weight="bold" />} onClick={() => router.push(wsPath('/reports/new'))}>
              New Report
            </Button>
          ) : undefined
        }
      />
      <Tabs
        label="Reports"
        value={tab}
        onValueChange={(v) => set({ tab: v })}
        items={[
          { value: 'reports', label: 'Reports' },
          { value: 'snapshots', label: 'Snapshots' },
          { value: 'schedules', label: 'Schedules', hidden: !can('reports.schedule') },
        ]}
      >
        <TabPanel value="reports">{tab === 'reports' ? <ReportList scope={state.scope ?? 'all'} q={state.q} archived={state.archived === '1'} set={set} /> : null}</TabPanel>
        <TabPanel value="snapshots">{tab === 'snapshots' ? <SnapshotList /> : null}</TabPanel>
        <TabPanel value="schedules">{tab === 'schedules' ? <ScheduleList highlight={state.schedule} /> : null}</TabPanel>
      </Tabs>
    </div>
  );
};

const ReportList = ({ scope, q, archived, set }: { scope: string; q?: string; archived: boolean; set: (p: Partial<Record<Keys, string | null>>) => void }) => {
  const { workspace, user } = useWorkspace();
  const can = useCan();
  const router = useRouter();
  const wsPath = useWsPath();
  const [search, setSearch] = useState(q ?? '');
  const debounced = useDebounced(search, 250);
  const list = useApiInfinite(R.list, { params: { workspaceId: workspace.id }, query: { scope: scope as 'all' | 'mine' | 'shared', q: debounced.length >= 2 ? debounced : undefined, includeArchived: archived || undefined } });
  const columns: Column<ReportSummary>[] = [
    {
      key: 'name',
      header: 'Report',
      minWidth: 240,
      sticky: true,
      cell: (r) => (
        <span className="flex flex-col">
          <Link href={wsPath(`/reports/${r.id}`)} className="font-medium text-fg hover:underline" onClick={(e) => e.stopPropagation()}>
            {r.name}
          </Link>
          <span className="text-[12px] text-fg-2">{label('reportDataset', r.dataset)}</span>
        </span>
      ),
    },
    { key: 'owner', header: 'Owner', minWidth: 160, cell: (r) => (r.own ? 'You' : r.owner.displayName) },
    {
      key: 'sharing',
      header: 'Sharing',
      minWidth: 170,
      cell: (r) => (
        <span className="flex flex-wrap gap-1">
          <Badge tone={r.sharing === 'shared' ? 'info' : 'neutral'}>{label('reportSharing', r.sharing)}</Badge>
          {r.scheduled ? <Badge tone="success">Scheduled</Badge> : null}
          {r.archivedAt ? <Badge tone="warning">Archived</Badge> : null}
        </span>
      ),
    },
    { key: 'version', header: 'Version', align: 'right', minWidth: 90, cell: (r) => r.configVersion },
    { key: 'snapshot', header: 'Last snapshot', minWidth: 160, cell: (r) => (r.lastSnapshotAt ? formatDateTime(r.lastSnapshotAt, user.timezone) : <span className="text-fg-muted">None</span>) },
    { key: 'updated', header: 'Updated', minWidth: 160, cell: (r) => formatDateTime(r.updatedAt, user.timezone) },
  ];
  const filtered = !!(debounced || scope !== 'all' || archived);
  return (
    <div className="flex flex-col gap-3">
      <Toolbar>
        <div className="w-full sm:w-[240px]">
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              set({ q: e.target.value || null });
            }}
            placeholder="Search reports"
            aria-label="Search reports"
          />
        </div>
        <div className="w-full sm:w-[170px]">
          <Select
            aria-label="Owner"
            value={scope}
            onChange={(v) => v && set({ scope: v })}
            options={[
              { value: 'all', label: 'All reports' },
              { value: 'mine', label: 'My reports' },
              { value: 'shared', label: 'Shared with me' },
            ]}
          />
        </div>
        <Checkbox checked={archived} onCheckedChange={(v) => set({ archived: v ? '1' : null })} label="Include archived" />
      </Toolbar>
      <QueryState query={list}>
        {list.items.length === 0 && !list.isFetching ? (
          filtered ? (
            <NoResults
              onClear={() => {
                setSearch('');
                set({ q: null, scope: null, archived: null });
              }}
            />
          ) : (
            <EmptyState
              icon={<FileText size={28} />}
              title="No reports yet"
              description="Choose a dataset, up to eight metrics and three breakdowns. Reports can be saved, shared, scheduled and exported as CSV, XLSX or PDF."
              action={can('reports.create') ? <Button variant="primary" onClick={() => router.push(wsPath('/reports/new'))}>New Report</Button> : undefined}
            />
          )
        ) : (
          <DataTable
            caption="Reports"
            rows={list.items}
            columns={columns}
            getRowId={(r) => r.id}
            onRowClick={(r) => router.push(wsPath(`/reports/${r.id}`))}
            hasMore={list.hasNextPage}
            loadingMore={list.isFetchingNextPage}
            onLoadMore={() => void list.fetchNextPage()}
          />
        )}
      </QueryState>
    </div>
  );
};

const SnapshotList = () => {
  const { workspace, user } = useWorkspace();
  const router = useRouter();
  const wsPath = useWsPath();
  const list = useApiInfinite(R.snapshots, { params: { workspaceId: workspace.id }, query: {} });
  const columns: Column<ReportSnapshotSummary>[] = [
    {
      key: 'report',
      header: 'Report',
      minWidth: 220,
      sticky: true,
      cell: (s) => (
        <Link href={wsPath(`/reports/snapshots/${s.id}`)} className="font-medium text-fg hover:underline" onClick={(e) => e.stopPropagation()}>
          {s.reportName}
        </Link>
      ),
    },
    { key: 'period', header: 'Period', minWidth: 180, cell: (s) => `${s.fromDate} – ${s.toDate}` },
    { key: 'asOf', header: 'As of', minWidth: 160, cell: (s) => formatDateTime(s.asOf, user.timezone) },
    { key: 'rows', header: 'Rows', align: 'right', minWidth: 80, cell: (s) => s.rowCount },
    { key: 'kind', header: 'Source', minWidth: 140, cell: (s) => (s.scheduled ? <Badge tone="info">Scheduled delivery</Badge> : <Badge>Saved snapshot</Badge>) },
  ];
  return (
    <QueryState query={list}>
      {list.items.length === 0 && !list.isFetching ? (
        <EmptyState title="No snapshots yet" description="Snapshots keep a report result exactly as it was at a moment. Scheduled deliveries appear here too." />
      ) : (
        <DataTable
          caption="My snapshots"
          rows={list.items}
          columns={columns}
          getRowId={(s) => s.id}
          onRowClick={(s) => router.push(wsPath(`/reports/snapshots/${s.id}`))}
          hasMore={list.hasNextPage}
          loadingMore={list.isFetchingNextPage}
          onLoadMore={() => void list.fetchNextPage()}
        />
      )}
    </QueryState>
  );
};

const ScheduleList = ({ highlight }: { highlight?: string }) => {
  const { workspace, user } = useWorkspace();
  const wsPath = useWsPath();
  const q = useApiQuery(R.schedules, { params: { workspaceId: workspace.id }, query: {} });
  const columns: Column<ReportScheduleRow>[] = [
    {
      key: 'report',
      header: 'Report',
      minWidth: 220,
      sticky: true,
      cell: (s) => (
        <Link href={wsPath(`/reports/${s.reportId}`)} className="font-medium text-fg hover:underline">
          {s.reportName}
        </Link>
      ),
    },
    { key: 'cadence', header: 'Cadence', minWidth: 170, cell: (s) => `${label('reportCadence', s.cadence)} at ${s.localTime} (${s.timezone})` },
    { key: 'recipients', header: 'Recipients', align: 'right', minWidth: 100, cell: (s) => s.recipients.length },
    { key: 'status', header: 'Status', minWidth: 170, cell: (s) => <Badge tone={s.status === 'active' ? 'success' : 'warning'}>{label('scheduleStatus', s.status)}</Badge> },
    { key: 'next', header: 'Next run', minWidth: 160, cell: (s) => (s.status === 'active' ? formatDateTime(s.nextRunAt, user.timezone) : <span className="text-fg-muted">{s.pausedReason}</span>) },
  ];
  return (
    <QueryState query={q}>
      {q.data?.length ? (
        <DataTable caption="My schedules" rows={q.data} columns={columns} getRowId={(s) => s.id} selectedRowId={highlight ?? null} />
      ) : (
        <EmptyState title="No schedules" description="Open a report and choose Schedule to deliver it daily, weekly or monthly into your recipients' Inbox." />
      )}
    </QueryState>
  );
};
