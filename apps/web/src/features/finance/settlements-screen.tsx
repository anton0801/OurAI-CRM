'use client';
import { ArrowsLeftRight, Plus } from '@phosphor-icons/react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { financeEndpoints as F, type SettlementDetail, type SettlementRow } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { SETTLEMENT_STATES } from '@castlane/domain';
import {
  AmountInput,
  Badge,
  Banner,
  Button,
  Checkbox,
  DataTable,
  DateTimeInput,
  DescriptionList,
  Drawer,
  EmptyState,
  Field,
  Input,
  MultiSelect,
  NoResults,
  PageHeader,
  Panel,
  RadioGroup,
  Select,
  StatusBadge,
  Switch,
  Textarea,
  Toolbar,
  formatDateTime,
  toast,
  type Column,
} from '@castlane/ui';
import { QueryState } from '@/components/common/query-state';
import { ConflictDialog } from '@/components/common/conflict';
import { useEditBase } from '@/lib/edit-base';
import { useDebounced } from '@/components/common/use-debounced';
import { useApiInfinite, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';
import { CurrencySelect, FinanceNav, Money, PaymentNotice, ReasonDialog, absAmount, apiMessage, decimalOf, decimalOk, errorDetails, isConflict, isZero, localInputToIso, minorOf, nowLocalInput, useFinanceParams, useGuardedAction, useFinanceMutation } from './common';
import { EvidencePanel } from './evidence';

type Keys = 'q' | 'direction' | 'state' | 'unmatched' | 'open' | 'register' | 'entryId';

/** S60 Settlements / Reconciliation: money actually received or paid, matched to documents. */
export const SettlementsScreen = () => {
  const can = useCan();
  const { user } = useWorkspace();
  const params = useFinanceParams();
  const { state, set, list } = useUrlState<Keys>();
  const [search, setSearch] = useState(state.q ?? '');
  const q = useDebounced(search, 250);
  const query = {
    q: q.length >= 2 ? q : undefined,
    direction: state.direction === 'in' || state.direction === 'out' ? (state.direction as 'in' | 'out') : undefined,
    state: list('state') as (typeof SETTLEMENT_STATES)[number][],
    unmatched: state.unmatched === '1' ? true : undefined,
  };
  const data = useApiInfinite(F.settlementsList, { params, query });
  const filtered = !!(query.q || query.direction || query.state.length || query.unmatched);
  const columns: Column<SettlementRow>[] = [
    { key: 'paidAt', header: 'Paid At', sticky: true, minWidth: 170, cell: (s) => formatDateTime(s.paidAt, user.timezone) },
    { key: 'direction', header: 'Direction', minWidth: 100, cell: (s) => <Badge tone={s.direction === 'in' ? 'success' : 'neutral'}>{label('settlementDirection', s.direction)}</Badge> },
    { key: 'amount', header: 'Amount', align: 'right', minWidth: 130, cell: (s) => <Money value={s.amount} strong /> },
    { key: 'allocated', header: 'Matched', align: 'right', minWidth: 130, cell: (s) => <Money value={s.allocated} /> },
    {
      key: 'unallocated',
      header: 'Unmatched',
      align: 'right',
      minWidth: 150,
      cell: (s) =>
        isZero(s.unallocated.amount) ? (
          <span className="text-fg-muted">—</span>
        ) : (
          <span className="flex flex-col items-end">
            <Money value={s.unallocated} className={s.state === 'confirmed' ? 'text-warning' : undefined} />
            {s.remainderPolicy !== 'none' ? <span className="text-[11px] text-fg-2">{label('remainderPolicy', s.remainderPolicy)}</span> : null}
          </span>
        ),
    },
    { key: 'state', header: 'Status', minWidth: 110, cell: (s) => <StatusBadge status={s.state} label={label('settlementState', s.state)} /> },
    { key: 'reference', header: 'Payment Reference', minWidth: 170, cell: (s) => (s.paymentReference ? <span className="font-mono text-[12px]">{s.paymentReference}</span> : <span className="text-fg-muted">Manually recorded</span>) },
    { key: 'counterparty', header: 'Counterparty', minWidth: 150, cell: (s) => s.counterparty ?? '—' },
  ];
  const clear = () => {
    setSearch('');
    set({ q: null, direction: null, state: null, unmatched: null });
  };
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Settlements"
        description="Money actually received or paid, matched to entries and compensation. A settlement never creates a second revenue or expense."
        actions={
          can('settlements.create') ? (
            <Button variant="primary" icon={<Plus size={14} weight="bold" />} onClick={() => set({ register: '1' })}>
              Register Settlement
            </Button>
          ) : undefined
        }
      />
      <FinanceNav />
      <Toolbar>
        <div className="w-full sm:w-[240px]">
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              set({ q: e.target.value || null });
            }}
            placeholder="Search reference or counterparty"
            aria-label="Search settlements"
          />
        </div>
        <div className="w-[150px]">
          <Select
            aria-label="Direction"
            placeholder="Direction"
            value={query.direction ?? null}
            onChange={(v) => set({ direction: v })}
            clearable
            options={[
              { value: 'in', label: 'Incoming' },
              { value: 'out', label: 'Outgoing' },
            ]}
          />
        </div>
        <div className="w-[160px]">
          <MultiSelect aria-label="Status" placeholder="Status" value={list('state')} onChange={(v) => set({ state: v.join(',') || null })} options={SETTLEMENT_STATES.map((s) => ({ value: s, label: label('settlementState', s) }))} />
        </div>
        <div className="px-1">
          <Switch label="Open Unmatched" checked={state.unmatched === '1'} onCheckedChange={(v) => set({ unmatched: v ? '1' : null })} />
        </div>
      </Toolbar>
      <QueryState query={data}>
        {data.items.length === 0 && !data.isFetching ? (
          filtered ? (
            <NoResults onClear={clear} />
          ) : (
            <EmptyState
              icon={<ArrowsLeftRight size={28} />}
              title="No settlements yet"
              description="Register money received from platforms and clients, or payments made, then match them to entries."
              action={can('settlements.create') ? <Button variant="primary" onClick={() => set({ register: '1' })}>Register Settlement</Button> : undefined}
            />
          )
        ) : (
          <DataTable
            caption="Settlements"
            rows={data.items}
            columns={columns}
            getRowId={(s) => s.id}
            density={user.density}
            onRowClick={(s) => set({ open: s.id }, { replace: false })}
            selectedRowId={state.open ?? null}
            hasMore={data.hasNextPage}
            loadingMore={data.isFetchingNextPage}
            onLoadMore={() => void data.fetchNextPage()}
          />
        )}
      </QueryState>
      <RegisterSettlementDrawer
        open={state.register === '1'}
        onOpenChange={(o) => !o && set({ register: null })}
        onCreated={(id) => set({ register: null, open: id })}
        prefillEntryId={state.entryId}
      />
      {state.open ? <SettlementDrawer id={state.open} prefillEntryId={state.entryId} onClose={() => set({ open: null, entryId: null })} /> : null}
    </div>
  );
};

type RegisterForm = { direction: 'in' | 'out'; amount: string; currency: string; paidAt: string; paymentSourceNamespace: string; paymentReference: string; counterparty: string; note: string; duplicateAckReason: string };

export const RegisterSettlementDrawer = ({
  open,
  onOpenChange,
  onCreated,
  prefillEntryId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (id: string) => void;
  /** Coming from an entry: direction, amount and currency follow its outstanding balance. */
  prefillEntryId?: string;
}) => {
  const { workspace, user } = useWorkspace();
  const params = useFinanceParams();
  const blank = (): RegisterForm => ({ direction: 'in', amount: '', currency: workspace.baseCurrency, paidAt: nowLocalInput(user.timezone), paymentSourceNamespace: '', paymentReference: '', counterparty: '', note: '', duplicateAckReason: '' });
  const [f, setF] = useState<RegisterForm>(blank);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [duplicates, setDuplicates] = useState<{ id: string; paidAt: string; reference: string | null }[] | null>(null);
  const [dirty, setDirty] = useState(false);
  const entry = useApiQuery(F.entriesGet, { params: { ...params, entryId: prefillEntryId ?? '' } }, { enabled: open && !!prefillEntryId });
  useEffect(() => {
    if (open) {
      setF(blank());
      setErrors({});
      setError(null);
      setDuplicates(null);
      setDirty(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => {
    const o = entry.data?.outstanding.find((x) => !isZero(x.amount));
    // Prefill until the member types: a background refresh of the entry never overwrites their input (T162).
    if (open && entry.data && o && !dirty)
      setF((x) => ({ ...x, direction: o.amount.startsWith('-') ? 'out' : 'in', amount: absAmount(o.amount), currency: o.currency, counterparty: entry.data?.counterparty ?? x.counterparty }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, entry.data]);
  const create = useFinanceMutation(F.settlementsCreate, { invalidate: ['finance.'], silentErrors: true, successMessage: 'Settlement registered' });
  const patch = (p: Partial<RegisterForm>) => {
    setF((x) => ({ ...x, ...p }));
    setDirty(true);
  };
  const submit = async () => {
    setError(null);
    const e: Record<string, string> = {};
    if (!/^\d+(\.\d+)?$/.test(f.amount.trim()) || Number(f.amount) <= 0) e.amount = 'Enter the amount received or paid.';
    const paidAt = localInputToIso(f.paidAt, user.timezone);
    if (!paidAt) e.paidAt = 'Choose when the money moved.';
    if (duplicates && f.duplicateAckReason.trim().length < 3) e.duplicateAckReason = 'Explain why this is a different payment.';
    setErrors(e);
    if (Object.keys(e).length) return;
    try {
      const r = await create.run({
        params,
        body: {
          direction: f.direction,
          amount: f.amount.trim(),
          currency: f.currency,
          paidAt: paidAt!,
          paymentSourceNamespace: f.paymentSourceNamespace.trim() || undefined,
          paymentReference: f.paymentReference.trim() || null,
          counterparty: f.counterparty.trim() || null,
          note: f.note.trim() || null,
          duplicateAckReason: f.duplicateAckReason.trim() || null,
        },
      });
      onCreated(r.id);
    } catch (err) {
      const d = errorDetails(err);
      if (d?.reason === 'possible_duplicate') setDuplicates((d.matches as { id: string; paidAt: string; reference: string | null }[]) ?? []);
      if (isApiError(err) && err.fieldErrors.length) setErrors(Object.fromEntries(err.fieldErrors.map((x) => [x.field.replace(/^body\./, ''), x.message])));
      setError(apiMessage(err));
    }
  };
  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      dirty={dirty}
      title="Register Settlement"
      description="A draft until it is confirmed and matched"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)} disabled={create.isPending}>
            Cancel
          </Button>
          <Button variant="primary" loading={create.isPending} onClick={() => void submit()}>
            Register Settlement
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <PaymentNotice />
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <RadioGroup
          label="Direction"
          orientation="horizontal"
          value={f.direction}
          onValueChange={(v) => patch({ direction: v })}
          options={[
            { value: 'in', label: 'Incoming', description: 'Money received' },
            { value: 'out', label: 'Outgoing', description: 'Money paid' },
          ]}
        />
        <div className="grid grid-cols-[minmax(0,1fr)_120px] gap-3">
          <Field label="Amount" required error={errors.amount}>
            <AmountInput currency={f.currency} value={f.amount} onChange={(e) => decimalOk(e.target.value) && patch({ amount: e.target.value })} />
          </Field>
          <Field label="Currency" required error={errors.currency}>
            <CurrencySelect value={f.currency} onChange={(v) => patch({ currency: v })} />
          </Field>
        </div>
        <Field label="Paid At" required error={errors.paidAt}>
          <DateTimeInput timezone={user.timezone} value={f.paidAt} onChange={(e) => patch({ paidAt: e.target.value })} />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Payment Source" error={errors.paymentSourceNamespace} helper="e.g. bank, fansly, paypal">
            <Input value={f.paymentSourceNamespace} maxLength={60} onChange={(e) => patch({ paymentSourceNamespace: e.target.value })} />
          </Field>
          <Field label="Payment Reference" error={errors.paymentReference}>
            <Input value={f.paymentReference} maxLength={200} onChange={(e) => patch({ paymentReference: e.target.value })} />
          </Field>
        </div>
        <Field label="Counterparty" error={errors.counterparty}>
          <Input value={f.counterparty} maxLength={200} onChange={(e) => patch({ counterparty: e.target.value })} />
        </Field>
        <Field label="Note" error={errors.note}>
          <Textarea value={f.note} maxLength={10000} onChange={(e) => patch({ note: e.target.value })} className="min-h-[64px]" />
        </Field>
        {duplicates ? (
          <div className="flex flex-col gap-2 rounded-[12px] border border-warning p-3">
            <p className="text-[13px] text-warning">A similar payment is already recorded:</p>
            <ul className="text-[13px]">
              {duplicates.map((d) => (
                <li key={d.id}>
                  {formatDateTime(d.paidAt, user.timezone)} · {d.reference ?? 'no reference'}
                </li>
              ))}
            </ul>
            <Field label="Why is this a different payment?" required error={errors.duplicateAckReason}>
              <Textarea value={f.duplicateAckReason} maxLength={2000} onChange={(e) => patch({ duplicateAckReason: e.target.value })} className="min-h-[64px]" />
            </Field>
          </div>
        ) : null}
      </form>
    </Drawer>
  );
};

const SettlementDrawer = ({ id, onClose, prefillEntryId }: { id: string; onClose: () => void; prefillEntryId?: string }) => {
  const params = useFinanceParams();
  const q = useApiQuery(F.settlementsGet, { params: { ...params, settlementId: id } });
  const s = q.data;
  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      width={760}
      title={s ? `${label('settlementDirection', s.direction)} ${s.amount.amount} ${s.amount.currency}` : 'Settlement'}
      description={s ? label('settlementState', s.state) : undefined}
    >
      <QueryState query={q}>{s ? <SettlementBody s={s} prefillEntryId={prefillEntryId} refetch={() => void q.refetch()} /> : null}</QueryState>
    </Drawer>
  );
};

const SettlementBody = ({ s, prefillEntryId, refetch }: { s: SettlementDetail; prefillEntryId?: string; refetch: () => void }) => {
  const wsPath = useWsPath();
  const { user } = useWorkspace();
  const params = useFinanceParams();
  const sp = { ...params, settlementId: s.id };
  const [mode, setMode] = useState<'view' | 'confirm' | 'match'>(s.state === 'draft' && s.permissions.confirm && prefillEntryId ? 'confirm' : 'view');
  const [reverseOpen, setReverseOpen] = useState(false);
  const [allocToReverse, setAllocToReverse] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const guard = useGuardedAction();
  const reverse = useFinanceMutation(F.settlementsReverse, { invalidate: ['finance.'], silentErrors: true, successMessage: 'Settlement reversed' });
  const reverseAlloc = useFinanceMutation(F.settlementsReverseAllocation, { invalidate: ['finance.'], silentErrors: true, successMessage: 'Allocation reversed' });
  const fail = (e: unknown) => (isConflict(e) ? setConflict(true) : setError(apiMessage(e)));
  const allocationCols: Column<SettlementDetail['allocations'][number]>[] = [
    {
      key: 'target',
      header: 'Matched To',
      sticky: true,
      minWidth: 220,
      cell: (a) =>
        a.entry ? (
          <Link href={wsPath(`/finance/entries/${a.entry.id}`)} className="text-primary hover:underline">
            {a.entry.title}
          </Link>
        ) : a.run ? (
          <Link href={wsPath(`/finance/compensation/runs/${a.run.id}`)} className="text-primary hover:underline">
            Compensation {a.run.periodStart} – {a.run.periodEnd}
            {a.recipient ? ` · ${a.recipient.displayName}` : ''}
          </Link>
        ) : (
          '—'
        ),
    },
    { key: 'amount', header: 'Cash', align: 'right', minWidth: 120, cell: (a) => <Money value={a.amount} /> },
    { key: 'doc', header: 'Document', align: 'right', minWidth: 120, cell: (a) => <Money value={a.documentAmount} /> },
    {
      key: 'fx',
      header: 'Rate / FX Difference',
      minWidth: 160,
      cell: (a) =>
        a.effectiveFxRate ? (
          <span className="flex flex-col text-[12px]">
            <span className="font-mono">{a.effectiveFxRate}</span>
            {a.realizedDifferenceEntryId ? (
              <Link href={wsPath(`/finance/entries/${a.realizedDifferenceEntryId}`)} className="text-primary hover:underline">
                Realized difference
              </Link>
            ) : null}
          </span>
        ) : (
          '—'
        ),
    },
    {
      key: 'state',
      header: 'Status',
      minWidth: 170,
      cell: (a) =>
        a.reversedAt ? (
          <span className="text-[12px] text-fg-2">Reversed{a.reversalReason ? `: ${a.reversalReason}` : ''}</span>
        ) : s.permissions.reverse && s.state === 'confirmed' ? (
          <Button size="sm" variant="ghost" onClick={() => { setError(null); setAllocToReverse(a.id); }}>
            Reverse Allocation
          </Button>
        ) : (
          <Badge tone="success">Matched</Badge>
        ),
    },
  ];
  if (mode !== 'view')
    return (
      <AllocationBuilder
        settlement={s}
        mode={mode}
        prefillEntryId={prefillEntryId}
        onCancel={() => setMode('view')}
        onDone={() => setMode('view')}
      />
    );
  return (
    <div className="flex flex-col gap-4">
      <PaymentNotice />
      {error ? <Banner tone="danger">{error}</Banner> : null}
      {s.state === 'confirmed' && !isZero(s.unallocated.amount) && s.remainderPolicy === 'none' ? <Banner tone="warning">Part of this settlement is not matched yet.</Banner> : null}
      {s.state === 'reversed' ? <Banner tone="info">Reversed{s.reversalReason ? `: ${s.reversalReason}` : ''}. The original record stays in history.</Banner> : null}
      <div className="flex flex-wrap gap-2">
        {s.state === 'draft' && s.permissions.confirm ? (
          <Button variant="primary" onClick={() => setMode('confirm')}>
            Confirm
          </Button>
        ) : null}
        {s.state === 'confirmed' && s.permissions.match && !isZero(s.unallocated.amount) ? (
          <Button variant="primary" onClick={() => setMode('match')}>
            Match
          </Button>
        ) : null}
        {s.state === 'confirmed' && s.permissions.reverse ? (
          <Button variant="danger-secondary" onClick={() => { setError(null); setReverseOpen(true); }}>
            Reverse
          </Button>
        ) : null}
      </div>
      <DescriptionList
        items={[
          { label: 'Amount', value: <Money value={s.amount} strong /> },
          { label: 'Paid At', value: formatDateTime(s.paidAt, user.timezone) },
          { label: 'Matched', value: <Money value={s.allocated} /> },
          { label: 'Unmatched', value: <span className="flex items-center gap-2"><Money value={s.unallocated} />{s.remainderPolicy !== 'none' ? <Badge tone="info">{label('remainderPolicy', s.remainderPolicy)}</Badge> : null}</span> },
          { label: 'Payment Source', value: s.paymentSourceNamespace },
          { label: 'Payment Reference', value: s.paymentReference ?? 'Manually recorded' },
          { label: 'Counterparty', value: s.counterparty },
          { label: 'Confirmed', value: s.confirmedAt ? `${formatDateTime(s.confirmedAt, user.timezone)}${s.confirmedBy ? ` · ${s.confirmedBy.displayName}` : ''}` : null, hidden: !s.confirmedAt },
          { label: 'Duplicate Check', value: s.duplicateAckReason, hidden: !s.duplicateAckReason },
          { label: 'Compensation Run', value: s.compensationRunId ? <Link className="text-primary hover:underline" href={wsPath(`/finance/compensation/runs/${s.compensationRunId}`)}>Open run</Link> : null, hidden: !s.compensationRunId },
          { label: 'Note', value: s.note, hidden: !s.note },
        ]}
      />
      <Panel title="Allocations" bodyClassName="p-0">
        {s.allocations.length === 0 ? <p className="p-4 text-[13px] text-fg-2">Not matched to any entry yet.</p> : <DataTable caption="Settlement allocations" rows={s.allocations} columns={allocationCols} getRowId={(a) => a.id} />}
      </Panel>
      <EvidencePanel entityType="settlement" entityId={s.id} evidence={s.evidence} canAttach={s.permissions.attachEvidence} />
      <ReasonDialog
        open={reverseOpen}
        onOpenChange={setReverseOpen}
        title="Reverse Settlement"
        body="The cash fact is reversed on the effective date and its allocations are released. Nothing is deleted."
        confirmLabel="Reverse"
        destructive
        dateLabel="Effective Date"
        defaultDate={new Date().toISOString().slice(0, 10)}
        loading={reverse.isPending}
        error={error}
        onConfirm={(reason, date) =>
          void guard.act(async () => {
            await reverse.run({ params: sp, body: { reason, effectiveDate: date } }, { ifMatch: s.rowVersion });
            setReverseOpen(false);
          }, fail)
        }
      />
      <ReasonDialog
        open={!!allocToReverse}
        onOpenChange={(o) => !o && setAllocToReverse(null)}
        title="Reverse Allocation"
        body="The matched amount returns to the document's outstanding balance and to this settlement's unmatched balance."
        confirmLabel="Reverse Allocation"
        destructive
        loading={reverseAlloc.isPending}
        error={error}
        onConfirm={(reason) =>
          void guard.act(async () => {
            await reverseAlloc.run({ params: { ...sp, allocationId: allocToReverse! }, body: { reason } }, { ifMatch: s.rowVersion });
            setAllocToReverse(null);
          }, fail)
        }
      />
      <ConflictDialog open={conflict} onOpenChange={setConflict} onReload={() => { setConflict(false); refetch(); }} />
      {guard.dialog}
    </div>
  );
};

type PickRow = { key: string; targetType: 'entry' | 'compensation_run'; entryId: string | null; runId: string | null; recipientId: string | null; title: string; date: string; outstanding: { amount: string; currency: string }; amount: string; documentAmount: string };

const itemKey = (i: { entryId: string | null; runId: string | null; recipient: { membershipId: string } | null }) => `${i.entryId ?? ''}|${i.runId ?? ''}|${i.recipient?.membershipId ?? ''}`;

/**
 * Confirm / Match: pick open documents, split the settlement across them (partial payments are
 * fine), and decide explicitly what happens with any remainder. Different currencies need both
 * amounts.
 */
const AllocationBuilder = ({
  settlement: s,
  mode,
  prefillEntryId,
  onCancel,
  onDone,
}: {
  settlement: SettlementDetail;
  mode: 'confirm' | 'match';
  prefillEntryId?: string;
  onCancel: () => void;
  onDone: () => void;
}) => {
  const params = useFinanceParams();
  const { user } = useWorkspace();
  const cur = s.amount.currency;
  const available = mode === 'confirm' ? s.amount : s.unallocated;
  const [search, setSearch] = useState('');
  const q = useDebounced(search, 250);
  const items = useApiQuery(F.openItems, { params, query: { direction: s.direction, q: q || undefined, limit: 100 } });
  const [picks, setPicks] = useState<PickRow[]>([]);
  const [policy, setPolicy] = useState<'none' | 'advance' | 'unallocated'>('none');
  const [remainderNote, setRemainderNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Allocations are saved against the settlement as the builder opened; a conflict keeps the picks (T162).
  const edit = useEditBase(s, { onReload: () => setPicks([]) });
  const guard = useGuardedAction();
  const confirm = useFinanceMutation(F.settlementsConfirm, { invalidate: ['finance.'], silentErrors: true });
  const match = useFinanceMutation(F.settlementsMatch, { invalidate: ['finance.'], silentErrors: true });

  const allocatedMinor = picks.reduce((a, p) => a + (minorOf(p.amount, cur) ?? 0n), 0n);
  const availableMinor = minorOf(available.amount, cur) ?? 0n;
  const remainder = availableMinor - allocatedMinor;

  const toggle = (it: NonNullable<typeof items.data>[number], on: boolean) => {
    const key = itemKey(it);
    if (!on) return setPicks(picks.filter((p) => p.key !== key));
    const out = absAmount(it.outstanding.amount);
    const left = availableMinor - allocatedMinor;
    const sameCur = it.outstanding.currency === cur;
    const outMinor = sameCur ? (minorOf(out, cur) ?? 0n) : 0n;
    const amount = sameCur ? decimalOf(outMinor < left ? outMinor : left > 0n ? left : 0n, cur) : '';
    setPicks([
      ...picks,
      { key, targetType: it.targetType, entryId: it.entryId, runId: it.runId, recipientId: it.recipient?.membershipId ?? null, title: it.title, date: it.date, outstanding: { amount: out, currency: it.outstanding.currency }, amount, documentAmount: sameCur ? '' : out },
    ]);
  };
  // Pre-select the entry the user came from.
  useEffect(() => {
    if (!prefillEntryId || !items.data || picks.length) return;
    const it = items.data.find((i) => i.entryId === prefillEntryId);
    if (it) toggle(it, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.data, prefillEntryId]);

  const lines = picks.map((p) => ({
    targetType: p.targetType,
    targetEntryId: p.entryId ?? undefined,
    targetRunId: p.runId ?? undefined,
    recipientMembershipId: p.recipientId ?? undefined,
    amount: p.amount.trim(),
    documentAmount: p.outstanding.currency !== cur ? p.documentAmount.trim() : undefined,
    documentCurrency: p.outstanding.currency !== cur ? p.outstanding.currency : undefined,
  }));
  const invalid = picks.some((p) => !p.amount.trim() || (p.outstanding.currency !== cur && !p.documentAmount.trim())) || remainder < 0n || (mode === 'match' && picks.length === 0) || (mode === 'confirm' && remainder > 0n && policy === 'none');
  const submit = () =>
    guard.act(
      async () => {
        if (mode === 'confirm') await confirm.run({ params: { ...params, settlementId: s.id }, body: { allocationLines: lines, remainderPolicy: remainder > 0n ? policy : 'none', remainderNote: remainderNote.trim() || undefined } }, { ifMatch: edit.version });
        else await match.run({ params: { ...params, settlementId: s.id }, body: { allocationLines: lines } }, { ifMatch: edit.version });
        toast.success(mode === 'confirm' ? 'Settlement confirmed' : 'Settlement matched');
        onDone();
      },
      (e) => (edit.catchConflict(e) ? undefined : setError(apiMessage(e))),
    );

  const pickedKeys = new Set(picks.map((p) => p.key));
  return (
    <>
      <div className="flex flex-col gap-4">
        <PaymentNotice />
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-[12px] bg-surface-2 px-4 py-3 text-[13px]">
          <span>
            Available <Money value={available} strong />
          </span>
          <span>
            Allocated <Money value={{ amount: decimalOf(allocatedMinor, cur), currency: cur }} />
          </span>
          <span className={remainder < 0n ? 'text-danger' : remainder > 0n ? 'text-warning' : ''}>
            Remainder <Money value={{ amount: decimalOf(remainder, cur), currency: cur }} />
          </span>
        </div>
        <Panel title={s.direction === 'in' ? 'Open Receivables' : 'Open Payables and Compensation'} bodyClassName="flex flex-col gap-3 p-4">
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search open items" aria-label="Search open items" />
          <QueryState query={items}>
            {items.data && items.data.length === 0 ? (
              <p className="text-[13px] text-fg-2">No open items{q ? ' match this search' : ''}.</p>
            ) : (
              <ul className="flex max-h-[280px] flex-col divide-y divide-line overflow-y-auto">
                {(items.data ?? []).map((it) => (
                  <li key={itemKey(it)} className="flex items-center justify-between gap-3 py-2">
                    <Checkbox checked={pickedKeys.has(itemKey(it))} onCheckedChange={(v) => toggle(it, v)} label={it.title} description={`${it.date}${it.recipient ? ` · ${it.recipient.displayName}` : ''}`} />
                    <Money value={{ amount: absAmount(it.outstanding.amount), currency: it.outstanding.currency }} />
                  </li>
                ))}
              </ul>
            )}
          </QueryState>
        </Panel>
        {picks.length ? (
          <Panel title="Split Allocation">
            <ul className="flex flex-col gap-3">
              {picks.map((p, i) => (
                <li key={p.key} className="flex flex-col gap-2 rounded-[8px] border border-line p-3">
                  <div className="flex items-center justify-between gap-2 text-[13px]">
                    <span className="font-medium">{p.title}</span>
                    <span className="text-fg-2">
                      Outstanding <Money value={p.outstanding} />
                    </span>
                  </div>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <Field label={`Amount (${cur})`} required>
                      <AmountInput currency={cur} value={p.amount} onChange={(e) => decimalOk(e.target.value) && setPicks(picks.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />
                    </Field>
                    {p.outstanding.currency !== cur ? (
                      <Field label={`Settled in ${p.outstanding.currency}`} required helper="Both amounts are required; the effective rate and any realized FX difference follow from them.">
                        <AmountInput currency={p.outstanding.currency} value={p.documentAmount} onChange={(e) => decimalOk(e.target.value) && setPicks(picks.map((x, j) => (j === i ? { ...x, documentAmount: e.target.value } : x)))} />
                      </Field>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </Panel>
        ) : null}
        {mode === 'confirm' && remainder > 0n ? (
          <Panel title="Remainder">
            <div className="flex flex-col gap-3">
              <p className="text-[13px] text-fg-2">
                <Money value={{ amount: decimalOf(remainder, cur), currency: cur }} /> is not matched. Record it explicitly — an overpayment never disappears into another document.
              </p>
              <RadioGroup
                label="Remainder"
                value={policy}
                onValueChange={setPolicy}
                options={[
                  { value: 'none', label: 'Match more items', description: 'Required before confirming without a remainder policy' },
                  { value: 'advance', label: 'Advance', description: 'Prepayment to match against future documents' },
                  { value: 'unallocated', label: 'Unallocated Balance', description: 'Keep it visible under Open Unmatched' },
                ]}
              />
              {policy !== 'none' ? (
                <Field label="Remainder Note">
                  <Textarea value={remainderNote} maxLength={500} onChange={(e) => setRemainderNote(e.target.value)} className="min-h-[64px]" />
                </Field>
              ) : null}
            </div>
          </Panel>
        ) : null}
        {remainder < 0n ? <Banner tone="danger">The allocations exceed the available amount.</Banner> : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={onCancel}>Back</Button>
          <Button variant="primary" loading={confirm.isPending || match.isPending} disabled={invalid} onClick={() => void submit()}>
            {mode === 'confirm' ? 'Confirm Settlement' : 'Match'}
          </Button>
        </div>
        <p className="text-[12px] text-fg-2">Paid at {formatDateTime(s.paidAt, user.timezone)}.</p>
        {guard.dialog}
      </div>
      <ConflictDialog {...edit.conflictDialog} />
    </>
  );
};
