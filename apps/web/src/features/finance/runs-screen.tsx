'use client';
import { Calculator, Plus } from '@phosphor-icons/react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { financeEndpoints as F, type RunRow } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { COMPENSATION_RUN_STATES } from '@castlane/domain';
import { Avatar, Banner, Button, DataTable, DateInput, Dialog, EmptyState, Field, MultiSelect, NoResults, PageHeader, StatusBadge, Toolbar, formatDate, formatDateTime, type Column } from '@castlane/ui';
import { MultiMemberSelect } from '@/components/common/pickers';
import { QueryState } from '@/components/common/query-state';
import { useApiInfinite } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';
import { FinanceNav, Money, apiMessage, monthPeriod, useFinanceParams, useFinanceMutation } from './common';

type Keys = 'state' | 'create';
type RunState = (typeof COMPENSATION_RUN_STATES)[number];

/** S59 Compensation Runs list: calculate, review and approve compensation per period. */
export const RunsScreen = () => {
  const can = useCan();
  const router = useRouter();
  const wsPath = useWsPath();
  const { user } = useWorkspace();
  const params = useFinanceParams();
  const { state, set, list } = useUrlState<Keys>();
  const query = { state: list('state') as RunState[] };
  const data = useApiInfinite(F.runsList, { params, query });
  const columns: Column<RunRow>[] = [
    { key: 'period', header: 'Period', sticky: true, minWidth: 200, cell: (r) => <span className="font-medium">{`${formatDate(r.periodStart)} – ${formatDate(r.periodEnd)}`}</span> },
    {
      key: 'participants',
      header: 'Participants',
      minWidth: 180,
      cell: (r) => (
        <span className="flex items-center gap-1">
          {r.participants.slice(0, 3).map((p) => (
            <Avatar key={p.membershipId} name={p.displayName} src={p.avatarUrl ?? null} size={24} />
          ))}
          <span className="ml-1 text-[12px] text-fg-2">{r.participants.length}</span>
        </span>
      ),
    },
    { key: 'state', header: 'Status', minWidth: 130, cell: (r) => <StatusBadge status={r.state} label={label('runState', r.state)} /> },
    {
      key: 'totals',
      header: 'Total',
      align: 'right',
      minWidth: 150,
      cell: (r) =>
        r.totals.length ? (
          <span className="flex flex-col items-end">
            {r.totals.map((t) => (
              <Money key={t.currency} value={t.amount} />
            ))}
          </span>
        ) : (
          <span className="text-fg-muted">Not calculated</span>
        ),
    },
    {
      key: 'paid',
      header: 'Paid',
      align: 'right',
      minWidth: 130,
      cell: (r) => (
        <span className="flex flex-col items-end">
          {r.totals.map((t) => (
            <Money key={t.currency} value={t.paid} />
          ))}
        </span>
      ),
    },
    { key: 'calc', header: 'Calculated', minWidth: 170, cell: (r) => (r.calculatedAt ? `v${r.calculationVersion} · ${formatDateTime(r.calculatedAt, user.timezone)}` : '—') },
    { key: 'approved', header: 'Approved', minWidth: 170, cell: (r) => formatDateTime(r.approvedAt, user.timezone) },
  ];
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Compensation Runs"
        description="Calculate compensation for a period from approved sources, review the lines, approve once, then record payments already made."
        actions={
          can('compensation.runs.calculate') ? (
            <Button variant="primary" icon={<Plus size={14} weight="bold" />} onClick={() => set({ create: '1' })}>
              New Run
            </Button>
          ) : undefined
        }
      />
      <FinanceNav />
      <Toolbar>
        <div className="w-[220px]">
          <MultiSelect aria-label="Status" placeholder="Status" value={list('state')} onChange={(v) => set({ state: v.join(',') || null })} options={COMPENSATION_RUN_STATES.map((s) => ({ value: s, label: label('runState', s) }))} />
        </div>
      </Toolbar>
      <QueryState query={data}>
        {data.items.length === 0 && !data.isFetching ? (
          query.state.length ? (
            <NoResults onClear={() => set({ state: null })} />
          ) : (
            <EmptyState
              icon={<Calculator size={28} />}
              title="No compensation runs"
              description="Create a run for a period and its participants. Calculation uses approved rule versions and approved source records only."
              action={can('compensation.runs.calculate') ? <Button variant="primary" onClick={() => set({ create: '1' })}>New Run</Button> : undefined}
            />
          )
        ) : (
          <DataTable
            caption="Compensation runs"
            rows={data.items}
            columns={columns}
            getRowId={(r) => r.id}
            density={user.density}
            onRowClick={(r) => router.push(wsPath(`/finance/compensation/runs/${r.id}`))}
            hasMore={data.hasNextPage}
            loadingMore={data.isFetchingNextPage}
            onLoadMore={() => void data.fetchNextPage()}
          />
        )}
      </QueryState>
      <RunCreateDialog open={state.create === '1'} onOpenChange={(o) => !o && set({ create: null })} onCreated={(id) => router.push(wsPath(`/finance/compensation/runs/${id}`))} />
    </div>
  );
};

const RunCreateDialog = ({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (id: string) => void }) => {
  const params = useFinanceParams();
  const last = new Date();
  last.setUTCMonth(last.getUTCMonth() - 1);
  const init = monthPeriod(last.toISOString().slice(0, 7));
  const [start, setStart] = useState(init.periodStart);
  const [end, setEnd] = useState(init.periodEnd);
  const [participants, setParticipants] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    if (open) {
      setStart(init.periodStart);
      setEnd(init.periodEnd);
      setParticipants([]);
      setError(null);
      setFieldErrors({});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const m = useFinanceMutation(F.runsCreate, { invalidate: ['finance.'], silentErrors: true, successMessage: 'Run created as a draft' });
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New Compensation Run"
      description="The run starts as a draft; calculate it to see the lines."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            loading={m.isPending}
            disabled={!start || !end || end < start || participants.length === 0}
            onClick={() =>
              void m
                .run({ params, body: { periodStart: start, periodEnd: end, participantMembershipIds: participants } })
                .then((r) => onCreated(r.id))
                .catch((e) => {
                  setError(apiMessage(e));
                  if (isApiError(e)) setFieldErrors(Object.fromEntries(e.fieldErrors.map((x) => [x.field.replace(/^body\./, ''), x.message])));
                })
            }
          >
            Create Run
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Period Start" required error={fieldErrors.periodStart}>
            <DateInput value={start} onChange={(e) => setStart(e.target.value)} />
          </Field>
          <Field label="Period End" required error={fieldErrors.periodEnd}>
            <DateInput value={end} onChange={(e) => setEnd(e.target.value)} />
          </Field>
        </div>
        <Field label="Participants" required error={fieldErrors.participantMembershipIds}>
          <MultiMemberSelect value={participants} onChange={setParticipants} placeholder="Choose members" />
        </Field>
      </div>
    </Dialog>
  );
};
