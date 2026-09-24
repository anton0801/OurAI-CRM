'use client';
import { DotsThree, Plus, Receipt } from '@phosphor-icons/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { financeEndpoints as F, type FinanceOverview } from '@castlane/api-contracts';
import { FINANCE_ENTRY_TYPES } from '@castlane/domain';
import {
  Banner,
  Button,
  DataTable,
  EmptyState,
  IconButton,
  Input,
  KpiStrip,
  Menu,
  MultiSelect,
  NoResults,
  PageHeader,
  Panel,
  Skeleton,
  TabPanel,
  Tabs,
  Toolbar,
  formatDate,
  formatMoney,
  formatPercent,
  type Column,
} from '@castlane/ui';
import { EntitySelect } from '@/components/common/entity-select';
import { QueryState } from '@/components/common/query-state';
import { useDebounced } from '@/components/common/use-debounced';
import { useApiInfinite, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';
import { FinanceNav, Money, MoneyList, PeriodPicker, useFinanceParams, usePeriod } from './common';
import { EntriesTable } from './entries-table';
import { ClosePeriodDialog } from './periods-screen';
import { MemberCompensationView } from './member-compensation';

type Keys = 'basis' | 'projectId' | 'q' | 'state' | 'type' | 'categoryId' | 'sort' | 'dir';
const ENTRY_STATES = ['draft', 'submitted', 'posted', 'rejected', 'reversed'] as const;
type EntrySort = 'recognitionDate' | 'updatedAt' | 'title';

const NOT_DEFINED = 'This rate cannot be calculated from the available data.';

/** S55 Finance Overview / Ledger. Accrual and cash are separate views; drafts never enter totals. */
export const FinanceOverviewScreen = () => {
  const can = useCan();
  const { membershipId } = useWorkspace();
  const ledgerAccess = can(['finance.read', 'finance.create']);
  if (!ledgerAccess)
    return (
      <div className="flex flex-col gap-5">
        <PageHeader title="Finance" description="Your finance sections and your own compensation." />
        <FinanceNav />
        {can('compensation.own.read') ? <MemberCompensationView membershipId={membershipId} own /> : null}
      </div>
    );
  return <LedgerOverview />;
};

const LedgerOverview = () => {
  const can = useCan();
  const router = useRouter();
  const wsPath = useWsPath();
  const params = useFinanceParams();
  const { period } = usePeriod();
  const { state, set, list } = useUrlState<Keys>({ basis: 'accrual', sort: 'recognitionDate', dir: 'desc' });
  const [search, setSearch] = useState(state.q ?? '');
  const q = useDebounced(search, 250);
  const [closeOpen, setCloseOpen] = useState(false);
  const readTotals = can('finance.read');
  const overview = useApiQuery(F.overview, { params, query: { ...period, projectId: state.projectId } }, { enabled: readTotals });
  const query = {
    q: q.length >= 2 ? q : undefined,
    state: list('state') as (typeof ENTRY_STATES)[number][],
    type: list('type') as (typeof FINANCE_ENTRY_TYPES)[number][],
    categoryId: state.categoryId,
    projectId: state.projectId,
    from: period.periodStart,
    to: period.periodEnd,
    sort: (state.sort ?? 'recognitionDate') as EntrySort,
    direction: (state.dir ?? 'desc') as 'asc' | 'desc',
  };
  const entries = useApiInfinite(F.entriesList, { params, query });
  const filtered = !!(query.q || query.state.length || query.type.length || query.categoryId);
  const clear = () => {
    setSearch('');
    set({ q: null, state: null, type: null, categoryId: null });
  };

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Finance"
        description="Recognized revenue, costs and cash for the period. Drafts are listed separately and never enter totals."
        actions={
          <>
            {can('finance.create') ? (
              <Button variant="primary" icon={<Plus size={14} weight="bold" />} onClick={() => router.push(wsPath('/finance/entries/new'))}>
                Add Entry
              </Button>
            ) : null}
            {can(['settlements.create', 'settlements.confirm']) ? (
              <Button onClick={() => router.push(wsPath('/finance/settlements?unmatched=1'))}>Reconcile Settlement</Button>
            ) : null}
            <Menu
              label="More finance actions"
              trigger={<IconButton label="More" variant="secondary" icon={<DotsThree size={18} weight="bold" />} />}
              items={[
                { label: 'Open Budgets', onSelect: () => router.push(wsPath('/finance/budgets')), hidden: !can('budgets.read') },
                { label: 'Export Ledger', onSelect: () => router.push(wsPath('/exports?dataset=finance_ledger_lines')), hidden: !can('exports.create') },
                { label: 'Close Period', onSelect: () => setCloseOpen(true), hidden: !can('finance.close-period'), separatorBefore: true },
              ]}
            />
          </>
        }
      />
      <FinanceNav />
      <Toolbar>
        <PeriodPicker />
        <div className="w-full sm:ml-auto sm:w-[220px]">
          <EntitySelect type="project" aria-label="Project" placeholder="All projects" value={state.projectId} onChange={(v) => set({ projectId: v })} clearable />
        </div>
      </Toolbar>

      {readTotals ? (
        <QueryState query={overview} skeleton={<OverviewSkeleton />}>
          {overview.data ? (
            <OverviewTotals
              data={overview.data}
              basis={state.basis === 'cash' ? 'cash' : 'accrual'}
              onBasis={(b) => set({ basis: b })}
              onDrafts={() => set({ state: 'draft,submitted' })}
            />
          ) : null}
        </QueryState>
      ) : (
        <Banner tone="info">You can record entries. Totals are visible to finance readers only.</Banner>
      )}

      <Panel title="Ledger" description={`${formatDate(period.periodStart)} – ${formatDate(period.periodEnd)} · recognition date`} bodyClassName="flex flex-col gap-3 p-4">
        <Toolbar>
          <div className="w-full sm:w-[220px]">
            <Input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                set({ q: e.target.value || null });
              }}
              placeholder="Search title, counterparty, reference"
              aria-label="Search entries"
            />
          </div>
          <div className="w-[160px]">
            <MultiSelect aria-label="Status" placeholder="Status" value={list('state')} onChange={(v) => set({ state: v.join(',') || null })} options={ENTRY_STATES.map((s) => ({ value: s, label: label('entryState', s) }))} />
          </div>
          <div className="w-[170px]">
            <MultiSelect aria-label="Type" placeholder="Type" value={list('type')} onChange={(v) => set({ type: v.join(',') || null })} options={FINANCE_ENTRY_TYPES.map((t) => ({ value: t, label: label('entryType', t) }))} />
          </div>
          <div className="w-[200px]">
            <EntitySelect type="finance_category" aria-label="Category" placeholder="Category" value={state.categoryId} onChange={(v) => set({ categoryId: v })} clearable />
          </div>
        </Toolbar>
        <QueryState query={entries}>
          {entries.items.length === 0 && !entries.isFetching ? (
            filtered ? (
              <NoResults onClear={clear} />
            ) : (
              <EmptyState
                icon={<Receipt size={28} />}
                title="No entries in this period"
                description="Record revenue, costs and platform statements as entries. Drafts stay out of totals until they are posted."
                action={can('finance.create') ? <Button variant="primary" onClick={() => router.push(wsPath('/finance/entries/new'))}>Add Entry</Button> : undefined}
              />
            )
          ) : (
            <EntriesTable
              caption="Ledger entries"
              rows={entries.items}
              sort={{ key: query.sort, direction: query.direction }}
              onSortChange={(s) => set({ sort: s.key === 'title' || s.key === 'recognitionDate' ? s.key : 'recognitionDate', dir: s.direction })}
              hasMore={entries.hasNextPage}
              loadingMore={entries.isFetchingNextPage}
              onLoadMore={() => void entries.fetchNextPage()}
            />
          )}
        </QueryState>
      </Panel>
      {can('finance.close-period') ? <ClosePeriodDialog open={closeOpen} onOpenChange={setCloseOpen} period={period} /> : null}
    </div>
  );
};

const OverviewSkeleton = () => (
  <div className="flex flex-col gap-3" role="status" aria-label="Loading">
    <Skeleton className="h-11 w-60" />
    <div className="grid grid-cols-2 gap-px lg:grid-cols-4">
      {[0, 1, 2, 3].map((i) => (
        <Skeleton key={i} className="h-[92px]" />
      ))}
    </div>
  </div>
);

const OverviewTotals = ({ data, basis, onBasis, onDrafts }: { data: FinanceOverview; basis: 'accrual' | 'cash'; onBasis: (b: string) => void; onDrafts: () => void }) => {
  const wsPath = useWsPath();
  const a = data.accrual;
  const base = data.baseCurrency;
  const expenses = { amount: addDecimal(a.operatingExpenses.amount, a.compensationExpense.amount), currency: base };
  const projectColumns: Column<FinanceOverview['byProject'][number]>[] = [
    {
      key: 'project',
      header: 'Project',
      sticky: true,
      minWidth: 180,
      cell: (r) =>
        r.project ? (
          <Link href={wsPath(`/projects/${r.project.id}?tab=finance`)} className="font-medium text-fg hover:underline">
            {r.project.name}
          </Link>
        ) : (
          <span className="text-warning">Unallocated</span>
        ),
    },
    { key: 'net', header: 'Net Revenue', align: 'right', minWidth: 140, cell: (r) => <Money value={r.netRevenue} /> },
    { key: 'costs', header: 'Costs', align: 'right', minWidth: 140, cell: (r) => <Money value={r.costs} /> },
    { key: 'result', header: 'Result', align: 'right', minWidth: 140, cell: (r) => <Money value={r.result} strong /> },
  ];
  return (
    <div className="flex flex-col gap-4">
      {data.periodLock ? (
        <Banner tone="info">
          This period is closed ({formatDate(data.periodLock.periodStart)} – {formatDate(data.periodLock.periodEnd)}). Posting into it needs an audited reopen.
        </Banner>
      ) : null}
      <Tabs
        label="Basis"
        value={basis}
        onValueChange={onBasis}
        items={[
          { value: 'accrual', label: 'Accrual' },
          { value: 'cash', label: 'Cash' },
        ]}
      >
        <TabPanel value="accrual" className="flex flex-col gap-4">
          <KpiStrip
            items={[
              { label: 'Recognized Revenue', value: <Money value={a.netRevenue} />, hint: a.grossIncomplete ? 'Gross incomplete: some statements report net only' : `Gross ${fmt(a.grossRevenue)}` },
              { label: 'Expenses', value: <Money value={expenses} />, hint: `Compensation ${fmt(a.compensationExpense)}` },
              { label: 'Operating Result', value: <Money value={a.operatingResult} /> },
              { label: 'Operating Margin', value: a.operatingMarginPercent === null ? '—' : formatPercent(a.operatingMarginPercent), hint: a.operatingMarginPercent === null ? NOT_DEFINED : 'Of gross revenue' },
            ]}
          />
          <KpiStrip
            items={[
              { label: 'Receivables', value: data.receivables?.length ? <MoneyList values={data.receivables} /> : 'None', hint: 'Posted, not yet received' },
              { label: 'Payables', value: data.payables?.length ? <MoneyList values={data.payables} /> : 'None', hint: 'Posted, not yet paid' },
              { label: 'Outstanding Compensation', value: data.outstandingCompensation?.length ? <MoneyList values={data.outstandingCompensation} /> : 'None', href: wsPath('/finance/compensation/runs?state=approved,partially_paid') },
              {
                label: 'Unallocated Costs',
                value: <Money value={data.unallocatedCosts} />,
                hint: data.costAllocationCoverage === null ? 'No costs in this period' : `Cost allocation coverage ${formatPercent(data.costAllocationCoverage)}`,
              },
            ]}
          />
          {data.costAllocationCoverage !== null && Number(data.costAllocationCoverage) < 100 ? (
            <Banner tone="warning">Some costs are not allocated to a project. Project results below are incomplete until they are allocated.</Banner>
          ) : null}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Panel title="Breakdown" className="lg:col-span-1">
              <dl className="flex flex-col gap-2 text-[14px]">
                {[
                  ['Gross revenue', a.grossRevenue, a.grossIncomplete ? 'incomplete' : null],
                  ['Refunds and chargebacks', neg(a.refunds), null],
                  ['Platform and payment fees', neg(a.fees), null],
                  ['Net revenue', a.netRevenue, null],
                  ['Operating expenses', neg(a.operatingExpenses), null],
                  ['Compensation expense', neg(a.compensationExpense), null],
                  ['Realized FX difference', a.fxDifference, null],
                  ['Operating result', a.operatingResult, null],
                ].map(([k, v, note]) => (
                  <div key={k as string} className="flex items-center justify-between gap-3">
                    <dt className="text-fg-2">
                      {k as string}
                      {note ? <span className="ml-1 text-[12px] text-warning">({note as string})</span> : null}
                    </dt>
                    <dd>
                      <Money value={v as { amount: string; currency: string }} strong={k === 'Operating result' || k === 'Net revenue'} />
                    </dd>
                  </div>
                ))}
              </dl>
              {a.netOnlyRevenue.amount !== '0.00' && !/^0(\.0+)?$/.test(a.netOnlyRevenue.amount) ? (
                <p className="mt-3 text-[12px] text-fg-2">Net-only statements contributed {fmt(a.netOnlyRevenue)}; their gross is not provided.</p>
              ) : null}
            </Panel>
            <Panel title="Drafts" description="Not included in totals" className="lg:col-span-1">
              <div className="flex flex-col gap-2 text-[14px]">
                <p>
                  <span className="font-semibold">{data.drafts.count}</span> draft and <span className="font-semibold">{data.drafts.submitted}</span> submitted entries in this period.
                </p>
                <MoneyList values={data.drafts.byCurrency} empty="No draft amounts" />
                {data.drafts.count + data.drafts.submitted > 0 ? (
                  <Button size="sm" onClick={onDrafts}>
                    Show Drafts in Ledger
                  </Button>
                ) : null}
              </div>
            </Panel>
            <Panel title="Source Reconciliation" className="lg:col-span-1">
              <div className="flex flex-col gap-2 text-[14px]">
                <p>
                  {data.sourceMatch.reconciled} of {data.sourceMatch.eligible} sale records reconciled
                  {data.sourceMatch.ratePercent !== null ? ` (${formatPercent(data.sourceMatch.ratePercent)})` : ''}.
                </p>
                {data.sourceMatch.ratePercent === null ? <p className="text-[12px] text-fg-2">{NOT_DEFINED}</p> : null}
                <p className="text-fg-2">{data.sourceMatch.duplicatesRejected} duplicates rejected.</p>
                <Link href={wsPath('/finance/reconciliation')} className="text-[13px] font-medium text-primary hover:underline">
                  Open Reconciliation Queue
                </Link>
              </div>
            </Panel>
          </div>
          <Panel title="By Project" bodyClassName="p-0">
            {data.byProject.length === 0 ? (
              <p className="p-4 text-[13px] text-fg-2">No posted records for this period.</p>
            ) : (
              <DataTable caption="Result by project" rows={data.byProject} columns={projectColumns} getRowId={(r) => r.project?.id ?? 'unallocated'} />
            )}
          </Panel>
        </TabPanel>
        <TabPanel value="cash" className="flex flex-col gap-4">
          <Banner tone="info">Cash shows confirmed settlements by paid date. It is never added to accrual figures.</Banner>
          {data.cash.length === 0 ? (
            <EmptyState title="No confirmed settlements in this period" description="Register and confirm settlements to see money received and paid." />
          ) : (
            <DataTable
              caption="Cash movement by currency"
              rows={data.cash}
              getRowId={(r) => r.currency}
              columns={[
                { key: 'currency', header: 'Currency', minWidth: 90, cell: (r) => r.currency },
                { key: 'in', header: 'Received', align: 'right', minWidth: 140, cell: (r) => <Money value={r.inflows} /> },
                { key: 'out', header: 'Paid', align: 'right', minWidth: 140, cell: (r) => <Money value={r.outflows} /> },
                { key: 'movement', header: 'Net Movement', align: 'right', minWidth: 140, cell: (r) => <Money value={r.movement} strong /> },
              ]}
            />
          )}
          <Panel title="Unmatched Settlements">
            <p className="text-[14px]">
              {data.unmatchedSettlements === 0 ? 'Every confirmed settlement in this period is fully matched.' : `${data.unmatchedSettlements} settlements have an unmatched balance.`}
            </p>
            {data.unmatchedSettlements > 0 ? (
              <Link href={wsPath('/finance/settlements?unmatched=1')} className="mt-2 inline-block text-[13px] font-medium text-primary hover:underline">
                Open Unmatched
              </Link>
            ) : null}
          </Panel>
        </TabPanel>
      </Tabs>
    </div>
  );
};

const fmt = (m: { amount: string; currency: string }) => formatMoney(m.amount, m.currency);
const neg = (m: { amount: string; currency: string }) => (/^0(\.0+)?$/.test(m.amount) ? m : { ...m, amount: m.amount.startsWith('-') ? m.amount.slice(1) : `-${m.amount}` });

/** Decimal-string addition without floats (both operands share the currency's minor units). */
const addDecimal = (x: string, y: string) => {
  const scale = Math.max((x.split('.')[1] ?? '').length, (y.split('.')[1] ?? '').length);
  const toMinor = (v: string) => {
    const neg = v.startsWith('-');
    const [i, f = ''] = v.replace('-', '').split('.');
    const n = BigInt(`${i}${f.padEnd(scale, '0')}`);
    return neg ? -n : n;
  };
  const sum = toMinor(x) + toMinor(y);
  const neg = sum < 0n;
  const abs = (neg ? -sum : sum).toString().padStart(scale + 1, '0');
  const out = scale ? `${abs.slice(0, -scale)}.${abs.slice(-scale)}` : abs;
  return neg ? `-${out}` : out;
};
