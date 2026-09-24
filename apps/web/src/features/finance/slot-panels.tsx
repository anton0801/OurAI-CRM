'use client';
import { Plus } from '@phosphor-icons/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { financeEndpoints as F, type BudgetRow, type ProjectDetail } from '@castlane/api-contracts';
import { Banner, Button, DataTable, EmptyState, KpiStrip, Panel, StatusBadge, Toolbar, formatDate, formatPercent, type Column } from '@castlane/ui';
import { QueryState } from '@/components/common/query-state';
import { useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';
import { Money, MoneyList, PeriodPicker, useFinanceParams, usePeriod } from './common';
import { EntriesTable } from './entries-table';
import { MemberCompensationView } from './member-compensation';

const BudgetsTable = ({ rows, caption }: { rows: BudgetRow[]; caption: string }) => {
  const wsPath = useWsPath();
  const router = useRouter();
  const { user } = useWorkspace();
  const columns: Column<BudgetRow>[] = [
    { key: 'name', header: 'Budget', sticky: true, minWidth: 200, cell: (b) => <span className="font-medium">{b.name}</span> },
    { key: 'period', header: 'Period', minWidth: 190, cell: (b) => `${formatDate(b.periodStart)} – ${formatDate(b.periodEnd)}` },
    { key: 'version', header: 'Version', minWidth: 120, cell: (b) => (b.approvedVersionNo ? <StatusBadge status="approved" label={`v${b.approvedVersionNo} approved`} /> : <StatusBadge status="draft" label="Not approved" />) },
    { key: 'planned', header: 'Planned', align: 'right', minWidth: 120, cell: (b) => (b.figures ? <Money value={b.figures.planned} /> : '—') },
    { key: 'actual', header: 'Actual', align: 'right', minWidth: 120, cell: (b) => (b.figures ? <Money value={b.figures.actual} /> : '—') },
    { key: 'committed', header: 'Committed', align: 'right', minWidth: 120, cell: (b) => (b.figures ? <Money value={b.figures.committed} /> : '—') },
    {
      key: 'remaining',
      header: 'Remaining',
      align: 'right',
      minWidth: 130,
      cell: (b) =>
        b.figures ? (
          <span className="flex flex-col items-end">
            <Money value={b.figures.remaining} strong />
            {b.figures.consumedPercent !== null ? <span className="text-[11px] text-fg-2">{formatPercent(b.figures.consumedPercent)} consumed</span> : null}
          </span>
        ) : (
          '—'
        ),
    },
  ];
  return <DataTable caption={caption} rows={rows} columns={columns} getRowId={(b) => b.id} density={user.density} onRowClick={(b) => router.push(wsPath(`/finance/budgets?open=${b.id}`))} />;
};

/** Project workspace tab "Finance": the same ledger, budgets and commitments, filtered by project. */
export const ProjectFinanceTab = ({ project }: { project: ProjectDetail }) => {
  const params = useFinanceParams();
  const wsPath = useWsPath();
  const router = useRouter();
  const { period } = usePeriod();
  const q = useApiQuery(F.projectSummary, { params: { ...params, projectId: project.id }, query: period });
  return (
    <div className="flex flex-col gap-4">
      <Toolbar>
        <PeriodPicker />
        <div className="ml-auto flex flex-wrap gap-2">
          {q.data?.permissions.createEntry ? (
            <Button variant="primary" icon={<Plus size={14} weight="bold" />} onClick={() => router.push(wsPath(`/finance/entries/new?projectId=${project.id}`))}>
              Add Entry
            </Button>
          ) : null}
          {q.data?.permissions.finance ? (
            <Button onClick={() => router.push(wsPath(`/finance?projectId=${project.id}&from=${period.periodStart}&to=${period.periodEnd}`))}>Open in Ledger</Button>
          ) : null}
        </div>
      </Toolbar>
      <QueryState query={q}>
        {q.data ? (
          <>
            {q.data.accrual ? (
              <>
                <KpiStrip
                  items={[
                    { label: 'Recognized Revenue', value: <Money value={q.data.accrual.netRevenue} />, hint: q.data.accrual.grossIncomplete ? 'Gross incomplete: some statements report net only' : undefined },
                    { label: 'Operating Expenses', value: <Money value={q.data.accrual.operatingExpenses} /> },
                    { label: 'Compensation', value: <Money value={q.data.accrual.compensationExpense} /> },
                    { label: 'Operating Result', value: <Money value={q.data.accrual.operatingResult} /> },
                  ]}
                />
                <p className="text-[12px] text-fg-2">Posted records allocated to this project, in {q.data.baseCurrency}. Drafts are not included.</p>
              </>
            ) : null}
            {q.data.recentEntries ? (
              <Panel title="Entries" bodyClassName="p-0">
                {q.data.recentEntries.length ? (
                  <EntriesTable rows={q.data.recentEntries} caption={`Entries for ${project.name}`} />
                ) : (
                  <p className="p-4 text-[13px] text-fg-2">No entries allocated to this project in this period.</p>
                )}
              </Panel>
            ) : null}
            {q.data.budgets ? (
              <Panel title="Budgets" bodyClassName="p-0">
                {q.data.budgets.length ? <BudgetsTable rows={q.data.budgets} caption={`Budgets for ${project.name}`} /> : <p className="p-4 text-[13px] text-fg-2">No budgets for this project.</p>}
              </Panel>
            ) : null}
            {q.data.commitments && q.data.commitments.length ? (
              <Panel title="Open Commitments">
                <ul className="flex flex-col gap-1 text-[13px]">
                  {q.data.commitments.map((c) => (
                    <li key={c.id} className="flex items-center justify-between gap-2">
                      <Link href={wsPath(`/finance/budgets?tab=commitments&commitment=${c.id}`)} className="text-primary hover:underline">
                        {c.description}
                      </Link>
                      <span className="flex items-center gap-2">
                        <Money value={c.remaining} />
                        <span className="text-fg-2">{label('commitmentState', c.state)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </Panel>
            ) : null}
            {!q.data.accrual && !q.data.recentEntries && !q.data.budgets ? <EmptyState title="No finance access for this project" description="Your role does not include finance or budget access here." /> : null}
          </>
        ) : null}
      </QueryState>
    </div>
  );
};

/** Deal panel: entries linked to the deal and money received. Payments are records only. */
export const DealFinancePanel = ({ dealId }: { dealId: string }) => {
  const params = useFinanceParams();
  const can = useCan();
  const router = useRouter();
  const wsPath = useWsPath();
  const q = useApiQuery(F.dealSummary, { params: { ...params, dealId } });
  return (
    <Panel
      title="Finance"
      actions={
        can('finance.create') ? (
          <Button size="sm" icon={<Plus size={12} />} onClick={() => router.push(wsPath(`/finance/entries/new?type=revenue&dealId=${dealId}`))}>
            Add Entry
          </Button>
        ) : undefined
      }
      bodyClassName="flex flex-col gap-3 p-4"
    >
      <QueryState query={q}>
        {q.data ? (
          <>
            {q.data.postedIncome || q.data.received ? (
              <div className="flex flex-wrap gap-6 text-[14px]">
                {q.data.postedIncome ? (
                  <span className="flex flex-col">
                    <span className="text-[12px] text-fg-2">Posted income</span>
                    <Money value={q.data.postedIncome} strong />
                  </span>
                ) : null}
                {q.data.received ? (
                  <span className="flex flex-col">
                    <span className="text-[12px] text-fg-2">Received</span>
                    <MoneyList values={q.data.received} empty="Nothing received yet" />
                  </span>
                ) : null}
              </div>
            ) : null}
            <p className="text-[12px] text-fg-2">{q.data.explanation}</p>
            {q.data.entries.length ? <EntriesTable rows={q.data.entries} caption="Entries linked to this deal" /> : <p className="text-[13px] text-fg-2">No entries linked to this deal.</p>}
          </>
        ) : null}
      </QueryState>
    </Panel>
  );
};

/** Campaign tab "Budget": campaign budgets and actual costs linked to the campaign. */
export const CampaignBudgetTab = ({ campaignId }: { campaignId: string }) => {
  const params = useFinanceParams();
  const can = useCan();
  const router = useRouter();
  const wsPath = useWsPath();
  const q = useApiQuery(F.campaignSummary, { params: { ...params, campaignId } });
  return (
    <div className="flex flex-col gap-4">
      <Toolbar>
        <div className="ml-auto flex gap-2">
          {can('budgets.write') ? <Button onClick={() => router.push(wsPath('/finance/budgets?create=1'))}>New Budget</Button> : null}
          {can('finance.create') ? (
            <Button variant="primary" icon={<Plus size={14} weight="bold" />} onClick={() => router.push(wsPath(`/finance/entries/new?type=expense&campaignId=${campaignId}`))}>
              Add Cost
            </Button>
          ) : null}
        </div>
      </Toolbar>
      <QueryState query={q}>
        {q.data ? (
          <>
            {q.data.actual ? (
              <Banner tone="info">
                Posted costs linked to this campaign: <Money value={q.data.actual} strong />
              </Banner>
            ) : null}
            <Panel title="Budgets" bodyClassName="p-0">
              {q.data.budgets.length ? <BudgetsTable rows={q.data.budgets} caption="Campaign budgets" /> : <p className="p-4 text-[13px] text-fg-2">No budget for this campaign.</p>}
            </Panel>
            {q.data.entries ? (
              <Panel title="Entries" bodyClassName="p-0">
                {q.data.entries.length ? <EntriesTable rows={q.data.entries} caption="Entries linked to this campaign" /> : <p className="p-4 text-[13px] text-fg-2">No entries linked to this campaign.</p>}
              </Panel>
            ) : null}
          </>
        ) : null}
      </QueryState>
    </div>
  );
};

/** Member Workspace tab "Compensation". */
export const MemberCompensationTab = ({ membershipId }: { membershipId: string }) => {
  const { membershipId: me } = useWorkspace();
  return <MemberCompensationView membershipId={membershipId} own={membershipId === me} />;
};
