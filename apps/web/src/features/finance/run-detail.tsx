'use client';
import { DotsThree } from '@phosphor-icons/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { financeEndpoints as F, type AdjustmentView, type RunDetail } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import {
  AmountInput,
  Avatar,
  Badge,
  Banner,
  Button,
  ConfirmDialog,
  DataTable,
  DateInput,
  DateTimeInput,
  Dialog,
  Field,
  IconButton,
  Input,
  Menu,
  PageHeader,
  Panel,
  RadioGroup,
  Select,
  StatusBadge,
  Textarea,
  formatDate,
  formatDateTime,
  toast,
  type Column,
} from '@castlane/ui';
import { MultiMemberSelect } from '@/components/common/pickers';
import { QueryState } from '@/components/common/query-state';
import { ConflictDialog } from '@/components/common/conflict';
import { useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';
import { CurrencySelect, Money, PAYMENT_EXPLANATION, PaymentNotice, ReasonDialog, apiMessage, decimalOk, errorDetails, isConflict, isZero, localInputToIso, nowLocalInput, useFinanceParams, useGuardedAction, useFinanceMutation } from './common';
import { RunLinesTable } from './member-compensation';

type Dlg = 'approve' | 'return' | 'cancel' | 'adjust' | 'pay' | 'edit' | 'submit' | null;
type Total = RunDetail['recipientTotals'][number];

/** S59 Compensation Run: calculation lines, diff, adjustments, approval and recorded payments. */
export const RunDetailScreen = ({ runId }: { runId: string }) => {
  const params = useFinanceParams();
  const q = useApiQuery(F.runsGet, { params: { ...params, runId } });
  return <QueryState query={q}>{q.data ? <RunView run={q.data} refetch={() => void q.refetch()} /> : null}</QueryState>;
};

const RunView = ({ run: r, refetch }: { run: RunDetail; refetch: () => void }) => {
  const wsPath = useWsPath();
  const router = useRouter();
  const can = useCan();
  const { user } = useWorkspace();
  const params = useFinanceParams();
  const rp = { ...params, runId: r.id };
  const { state, set } = useUrlState<'recipient'>();
  const [dialog, setDialog] = useState<Dlg>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [payFor, setPayFor] = useState<Total | null>(null);
  const [reverseAdj, setReverseAdj] = useState<AdjustmentView | null>(null);
  const guard = useGuardedAction();
  const inv = { invalidate: ['finance.'], silentErrors: true };
  const calculate = useFinanceMutation(F.runsCalculate, inv);
  const submit = useFinanceMutation(F.runsSubmit, inv);
  const ret = useFinanceMutation(F.runsReturn, inv);
  const cancel = useFinanceMutation(F.runsCancel, inv);
  const reverseM = useFinanceMutation(F.adjustmentsReverse, inv);
  const p = r.permissions;
  const open = (d: Dlg) => {
    setError(null);
    setDialog(d);
  };
  const fail = (e: unknown) => {
    if (isConflict(e)) {
      setDialog(null);
      setConflict(true);
    } else setError(apiMessage(e));
  };
  const lines = state.recipient ? r.lines.filter((l) => l.recipient.membershipId === state.recipient) : r.lines;
  const calculated = r.calculationVersion > 0;
  const approvedLike = r.state === 'approved' || r.state === 'partially_paid' || r.state === 'paid';

  const totalCols: Column<Total>[] = [
    {
      key: 'recipient',
      header: 'Recipient',
      sticky: true,
      minWidth: 190,
      cell: (t) => (
        <span className="flex items-center gap-2">
          <Avatar name={t.recipient.displayName} src={t.recipient.avatarUrl ?? null} size={24} decorative />
          <span className="truncate">{t.recipient.displayName}</span>
        </span>
      ),
    },
    { key: 'total', header: 'Calculated', align: 'right', minWidth: 130, cell: (t) => <Money value={t.total} /> },
    { key: 'carry', header: 'Carry-forward', align: 'right', minWidth: 130, cell: (t) => (isZero(t.carryForward.amount) ? <span className="text-fg-muted">—</span> : <Money value={t.carryForward} />) },
    { key: 'payable', header: 'Payable', align: 'right', minWidth: 130, cell: (t) => <Money value={t.payable} strong /> },
    { key: 'paid', header: 'Paid', align: 'right', minWidth: 120, cell: (t) => <Money value={t.paid} /> },
    { key: 'outstanding', header: 'Outstanding', align: 'right', minWidth: 130, cell: (t) => <Money value={t.outstanding} /> },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      headerLabel: 'Actions',
      minWidth: 150,
      hidden: !p.recordPayment,
      cell: (t) =>
        approvedLike && !isZero(t.outstanding.amount) ? (
          <Button size="sm" onClick={() => { setError(null); setPayFor(t); setDialog('pay'); }}>
            Record Payment
          </Button>
        ) : null,
    },
  ];
  const adjCols: Column<AdjustmentView>[] = [
    { key: 'recipient', header: 'Recipient', sticky: true, minWidth: 160, cell: (a) => a.recipient.displayName },
    { key: 'kind', header: 'Kind', minWidth: 150, cell: (a) => label('adjustmentKind', a.kind) },
    { key: 'amount', header: 'Amount', align: 'right', minWidth: 120, cell: (a) => <Money value={a.amount} /> },
    { key: 'reason', header: 'Reason', minWidth: 220, cell: (a) => <span className="line-clamp-2">{a.reason}</span> },
    { key: 'state', header: 'Status', minWidth: 110, cell: (a) => <StatusBadge status={a.state} /> },
    {
      key: 'source',
      header: 'Source Run',
      minWidth: 140,
      cell: (a) =>
        a.sourceRunId && a.sourceRunId !== r.id ? (
          <Link href={wsPath(`/finance/compensation/runs/${a.sourceRunId}`)} className="text-primary hover:underline">
            Open run
          </Link>
        ) : (
          '—'
        ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      headerLabel: 'Actions',
      minWidth: 170,
      hidden: !p.addAdjustment,
      cell: (a) =>
        a.state !== 'reversed' && a.kind !== 'reversal' && a.kind !== 'carry_forward' ? (
          <Button size="sm" variant="ghost" onClick={() => { setError(null); setReverseAdj(a); }}>
            Reverse Adjustment
          </Button>
        ) : null,
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={`Compensation ${formatDate(r.periodStart)} – ${formatDate(r.periodEnd)}`}
        crumbs={[{ label: 'Finance', href: wsPath('/finance') }, { label: 'Compensation Runs', href: wsPath('/finance/compensation/runs') }, { label: `${r.periodStart} – ${r.periodEnd}` }]}
        meta={
          <>
            <StatusBadge status={r.state} label={label('runState', r.state)} />
            {calculated ? <Badge>Calculation v{r.calculationVersion}</Badge> : null}
            {r.calculatedAt ? <span className="text-[13px] text-fg-2">Calculated {formatDateTime(r.calculatedAt, user.timezone)}</span> : null}
          </>
        }
        actions={
          <>
            {p.calculate ? (
              <Button
                variant={calculated ? 'secondary' : 'primary'}
                loading={calculate.isPending}
                onClick={() =>
                  void calculate
                    .run({ params: rp, body: {} }, { ifMatch: r.rowVersion })
                    .then(() => toast.success(calculated ? 'Recalculated. Review the diff.' : 'Calculated'))
                    .catch((e) => (isConflict(e) ? setConflict(true) : toast.error(apiMessage(e))))
                }
              >
                {calculated ? 'Recalculate with Diff' : 'Calculate Draft'}
              </Button>
            ) : null}
            {p.submit && calculated ? (
              <Button variant="primary" onClick={() => open('submit')}>
                Submit
              </Button>
            ) : null}
            {p.approve ? (
              <Button variant="primary" onClick={() => open('approve')}>
                Approve
              </Button>
            ) : null}
            <Menu
              label="More run actions"
              trigger={<IconButton label="More" variant="secondary" icon={<DotsThree size={18} weight="bold" />} />}
              items={[
                { label: 'Edit Period and Participants', onSelect: () => open('edit'), hidden: !p.update },
                { label: 'Add Adjustment', onSelect: () => open('adjust'), hidden: !p.addAdjustment },
                { label: 'Return to Draft', onSelect: () => open('return'), hidden: !p.returnToDraft },
                { label: 'Export Statement', onSelect: () => router.push(wsPath(`/exports?dataset=compensation_lines&runId=${r.id}`)), hidden: !can('exports.create') || !calculated },
                { label: 'Cancel Run', onSelect: () => open('cancel'), hidden: !p.cancel, destructive: true, separatorBefore: true },
              ]}
            />
          </>
        }
      />

      {r.returnReason && r.state === 'draft' ? <Banner tone="warning">Returned: {r.returnReason}</Banner> : null}
      {r.cancelReason ? <Banner tone="info">Cancelled: {r.cancelReason}</Banner> : null}
      {approvedLike ? <Banner tone="info">The approved snapshot is immutable. Later changes to sources become adjustments in the next open run.</Banner> : null}
      {r.warnings.map((w, i) => (
        <Banner key={`${w.code}-${i}`} tone="warning">
          {w.message}
        </Banner>
      ))}
      {!calculated ? <Banner tone="info">Calculate the draft to see source lines, exclusions and totals.</Banner> : null}

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-5">
          {r.diff ? (
            <Panel title={`Changes since calculation v${r.diff.previousVersion}`}>
              {r.diff.added.length + r.diff.removed.length + r.diff.changed.length === 0 ? (
                <p className="text-[13px] text-fg-2">No changes.</p>
              ) : (
                <ul className="flex flex-col gap-1 text-[13px]">
                  {r.diff.added.map((d) => (
                    <li key={`a-${d.entitlementKey}`} className="flex justify-between gap-2">
                      <span className="truncate font-mono text-[12px]">+ {d.entitlementKey}</span>
                      <Money value={d.amount} />
                    </li>
                  ))}
                  {r.diff.removed.map((d) => (
                    <li key={`r-${d.entitlementKey}`} className="flex justify-between gap-2 text-fg-2">
                      <span className="truncate font-mono text-[12px]">− {d.entitlementKey}</span>
                      <Money value={d.amount} />
                    </li>
                  ))}
                  {r.diff.changed.map((d) => (
                    <li key={`c-${d.entitlementKey}`} className="flex justify-between gap-2">
                      <span className="truncate font-mono text-[12px]">~ {d.entitlementKey}</span>
                      <span>
                        <Money value={d.from} /> → <Money value={d.to} />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          ) : null}
          <Panel title="Totals by Recipient" description="Totals are per currency; nothing is converted" bodyClassName="p-0">
            {r.recipientTotals.length ? <DataTable caption="Totals by recipient" rows={r.recipientTotals} columns={totalCols} getRowId={(t) => `${t.recipient.membershipId}-${t.currency}`} /> : <p className="p-4 text-[13px] text-fg-2">No totals yet.</p>}
          </Panel>
          <Panel
            title="Source Lines"
            description="Every counted and excluded source with its rule"
            actions={
              <div className="w-[200px]">
                <Select
                  aria-label="Recipient"
                  placeholder="All recipients"
                  clearable
                  value={state.recipient ?? null}
                  onChange={(v) => set({ recipient: v })}
                  options={r.participants.map((m) => ({ value: m.membershipId, label: m.displayName }))}
                />
              </div>
            }
            bodyClassName="p-0"
          >
            {lines.length ? <RunLinesTable lines={lines} caption="Compensation lines" showRecipient /> : <p className="p-4 text-[13px] text-fg-2">No lines.</p>}
          </Panel>
          <Panel title="Adjustments" bodyClassName="p-0">
            {r.adjustments.length ? <DataTable caption="Adjustments" rows={r.adjustments} columns={adjCols} getRowId={(a) => a.id} /> : <p className="p-4 text-[13px] text-fg-2">No adjustments.</p>}
          </Panel>
          <Panel title="Payments" description={PAYMENT_EXPLANATION} bodyClassName="p-0">
            {r.payments.length ? (
              <DataTable
                caption="Recorded payments"
                rows={r.payments}
                getRowId={(x) => x.allocationId}
                columns={[
                  { key: 'recipient', header: 'Recipient', sticky: true, minWidth: 160, cell: (x) => x.recipient.displayName },
                  { key: 'amount', header: 'Amount', align: 'right', minWidth: 120, cell: (x) => <Money value={x.amount} /> },
                  { key: 'paid', header: 'Paid At', minWidth: 170, cell: (x) => formatDateTime(x.paidAt, user.timezone) },
                  { key: 'ref', header: 'Reference', minWidth: 140, cell: (x) => x.paymentReference ?? 'Manually recorded' },
                  {
                    key: 'settlement',
                    header: 'Settlement',
                    minWidth: 120,
                    cell: (x) => (
                      <span className="flex items-center gap-2">
                        <Link href={wsPath(`/finance/settlements?open=${x.settlementId}`)} className="text-primary hover:underline">
                          Open
                        </Link>
                        {x.reversed ? <Badge>Reversed</Badge> : null}
                      </span>
                    ),
                  },
                ]}
              />
            ) : (
              <p className="p-4 text-[13px] text-fg-2">No payments recorded.</p>
            )}
          </Panel>
        </div>
        <div className="flex min-w-0 flex-col gap-5">
          <Panel title="Participants">
            <ul className="flex flex-col gap-2">
              {r.participants.map((m) => (
                <li key={m.membershipId} className="flex items-center gap-2 text-[14px]">
                  <Avatar name={m.displayName} src={m.avatarUrl ?? null} size={24} decorative />
                  <Link href={wsPath(`/team/${m.membershipId}?tab=compensation`)} className="hover:underline">
                    {m.displayName}
                  </Link>
                </li>
              ))}
            </ul>
          </Panel>
          <Panel title="Rule Versions">
            {r.ruleVersions.length === 0 ? (
              <p className="text-[13px] text-fg-2">None used yet.</p>
            ) : (
              <ul className="flex flex-col gap-1 text-[13px]">
                {r.ruleVersions.map((v) => (
                  <li key={v.id} className="flex items-center justify-between gap-2">
                    <Link href={wsPath(`/finance/compensation/rules?open=${v.ruleId}`)} className="text-primary hover:underline">
                      {v.name}
                    </Link>
                    <span className="text-fg-2">
                      {label('ruleType', v.type)} · v{v.versionNo}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel title="Approval">
            <dl className="flex flex-col gap-2 text-[13px]">
              <div className="flex justify-between gap-2">
                <dt className="text-fg-2">Submitted</dt>
                <dd>{r.submittedAt ? `${formatDateTime(r.submittedAt, user.timezone)}${r.submittedBy ? ` · ${r.submittedBy.displayName}` : ''}` : '—'}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-fg-2">Approved</dt>
                <dd>{r.approvedAt ? `${formatDateTime(r.approvedAt, user.timezone)}${r.approvedBy ? ` · ${r.approvedBy.displayName}` : ''}` : '—'}</dd>
              </div>
              {r.expenseEntryId ? (
                <div className="flex justify-between gap-2">
                  <dt className="text-fg-2">Expense Entry</dt>
                  <dd>
                    <Link href={wsPath(`/finance/entries/${r.expenseEntryId}`)} className="text-primary hover:underline">
                      Open entry
                    </Link>
                  </dd>
                </div>
              ) : null}
            </dl>
          </Panel>
        </div>
      </div>

      <ConfirmDialog
        open={dialog === 'submit'}
        onOpenChange={(o) => !o && setDialog(null)}
        title="Submit Run"
        body={`Calculation v${r.calculationVersion} goes to an approver. Recalculating later requires submitting again.`}
        confirmLabel="Submit"
        loading={submit.isPending}
        onConfirm={() =>
          void submit
            .run({ params: rp, body: { calculationVersion: r.calculationVersion } }, { ifMatch: r.rowVersion })
            .then(() => {
              toast.success('Run submitted for approval');
              setDialog(null);
            })
            .catch(fail)
        }
      >
        {error ? <Banner tone="danger">{error}</Banner> : null}
      </ConfirmDialog>
      {dialog === 'approve' ? <ApproveDialog run={r} onClose={() => setDialog(null)} onConflict={() => { setDialog(null); setConflict(true); }} /> : null}
      <ReasonDialog
        open={dialog === 'return'}
        onOpenChange={(o) => !o && setDialog(null)}
        title="Return to Draft"
        body="The run goes back to its preparer with your reason."
        confirmLabel="Return to Draft"
        loading={ret.isPending}
        error={error}
        onConfirm={(reason) => void ret.run({ params: rp, body: { reason } }, { ifMatch: r.rowVersion }).then(() => setDialog(null)).catch(fail)}
      />
      <ReasonDialog
        open={dialog === 'cancel'}
        onOpenChange={(o) => !o && setDialog(null)}
        title="Cancel Run"
        body="The run and its calculation are kept for history; nothing is accrued."
        confirmLabel="Cancel Run"
        destructive
        loading={cancel.isPending}
        error={error}
        onConfirm={(reason) => void cancel.run({ params: rp, body: { reason } }, { ifMatch: r.rowVersion }).then(() => setDialog(null)).catch(fail)}
      />
      <ReasonDialog
        open={!!reverseAdj}
        onOpenChange={(o) => !o && setReverseAdj(null)}
        title="Reverse Adjustment"
        body={reverseAdj ? `Reverse the ${label('adjustmentKind', reverseAdj.kind).toLowerCase()} of ${reverseAdj.amount.amount} ${reverseAdj.amount.currency} for ${reverseAdj.recipient.displayName}? An applied adjustment is offset in the next open run.` : ''}
        confirmLabel="Reverse Adjustment"
        destructive
        loading={reverseM.isPending}
        error={error}
        onConfirm={(reason) =>
          void reverseM
            .run({ params: { ...params, adjustmentId: reverseAdj!.id }, body: { reason } })
            .then(() => {
              toast.success('Adjustment reversed');
              setReverseAdj(null);
            })
            .catch((e) => setError(apiMessage(e)))
        }
      />
      {dialog === 'adjust' ? <AdjustmentDialog run={r} onClose={() => setDialog(null)} /> : null}
      {dialog === 'pay' && payFor ? <PaymentDialog run={r} total={payFor} onClose={() => { setDialog(null); setPayFor(null); }} guardAct={guard.act} /> : null}
      {dialog === 'edit' ? <EditRunDialog run={r} onClose={() => setDialog(null)} onConflict={() => { setDialog(null); setConflict(true); }} /> : null}
      <ConflictDialog open={conflict} onOpenChange={setConflict} onReload={() => { setConflict(false); refetch(); }} />
      {guard.dialog}
    </div>
  );
};

type ManualEntry = { id: string; title: string; state: string };

/**
 * Approve: exactly one expense document and one claim per entitlement. When compensation was
 * already recorded by hand in the period, link that document or confirm it is unrelated.
 */
const ApproveDialog = ({ run: r, onClose, onConflict }: { run: RunDetail; onClose: () => void; onConflict: () => void }) => {
  const params = useFinanceParams();
  const wsPath = useWsPath();
  const [exception, setException] = useState('');
  const [manual, setManual] = useState<ManualEntry[] | null>(null);
  const [resolution, setResolution] = useState<'link' | 'unrelated'>('link');
  const [linkId, setLinkId] = useState<string | null>(null);
  const [unrelated, setUnrelated] = useState('');
  const [error, setError] = useState<string | null>(null);
  const guard = useGuardedAction();
  const m = useFinanceMutation(F.runsApprove, { invalidate: ['finance.'], silentErrors: true });
  const self = r.permissions.selfApprovalRequired;
  const disabled = (self && exception.trim().length < 3) || (!!manual && (resolution === 'link' ? !linkId : unrelated.trim().length < 3)) || !r.sourceDigest;
  const approve = () =>
    guard.act(
      async () => {
        await m.run(
          {
            params: { ...params, runId: r.id },
            body: {
              calculationVersion: r.calculationVersion,
              sourceDigest: r.sourceDigest ?? '',
              exceptionReason: self ? exception.trim() : undefined,
              linkExistingEntryId: manual && resolution === 'link' ? (linkId ?? undefined) : undefined,
              unrelatedManualEntriesReason: manual && resolution === 'unrelated' ? unrelated.trim() : undefined,
            },
          },
          { ifMatch: r.rowVersion },
        );
        toast.success('Run approved');
        onClose();
      },
      (e) => {
        if (isConflict(e)) return onConflict();
        const d = errorDetails(e);
        if (d?.reason === 'manual_compensation_expense') setManual((d.entries as ManualEntry[]) ?? []);
        setError(apiMessage(e));
      },
    );
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Approve Run"
      description={`Approves calculation v${r.calculationVersion}. One compensation expense entry and one claim per entitlement are created — never twice, even on retry.`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={m.isPending} disabled={disabled} onClick={() => void approve()}>
            Approve
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <ul className="flex flex-col gap-1 text-[14px]">
          {r.totals.map((t) => (
            <li key={t.currency}>
              Total <Money value={t.amount} strong />
            </li>
          ))}
        </ul>
        {self ? (
          <Field label="Exception Reason" required helper="You prepared this run. Approving it yourself is allowed only when no other approver exists, and the reason is audited.">
            <Textarea value={exception} maxLength={2000} onChange={(e) => setException(e.target.value)} className="min-h-[64px]" />
          </Field>
        ) : null}
        {manual ? (
          <div className="flex flex-col gap-3 rounded-[12px] border border-warning p-3">
            <p className="text-[13px]">Compensation expenses were recorded manually in this period:</p>
            <ul className="text-[13px]">
              {manual.map((x) => (
                <li key={x.id}>
                  <Link href={wsPath(`/finance/entries/${x.id}`)} className="text-primary hover:underline" target="_blank">
                    {x.title}
                  </Link>{' '}
                  <span className="text-fg-2">({label('entryState', x.state)})</span>
                </li>
              ))}
            </ul>
            <RadioGroup
              label="Resolution"
              value={resolution}
              onValueChange={setResolution}
              options={[
                { value: 'link', label: 'Link Existing', description: 'The manual entry is this run’s expense (amounts must match)' },
                { value: 'unrelated', label: 'Unrelated', description: 'They are other costs; record a separate expense for this run' },
              ]}
            />
            {resolution === 'link' ? (
              <Field label="Existing Entry" required>
                <Select value={linkId} onChange={setLinkId} options={manual.filter((x) => x.state === 'posted').map((x) => ({ value: x.id, label: x.title }))} placeholder="Choose a posted entry" />
              </Field>
            ) : (
              <Field label="Reason" required>
                <Textarea value={unrelated} maxLength={2000} onChange={(e) => setUnrelated(e.target.value)} className="min-h-[64px]" />
              </Field>
            )}
          </div>
        ) : null}
      </div>
      {guard.dialog}
    </Dialog>
  );
};

const AdjustmentDialog = ({ run: r, onClose }: { run: RunDetail; onClose: () => void }) => {
  const params = useFinanceParams();
  const { workspace } = useWorkspace();
  const [recipient, setRecipient] = useState<string | null>(r.participants[0]?.membershipId ?? null);
  const [kind, setKind] = useState<'manual_bonus' | 'manual_adjustment'>('manual_bonus');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState(r.totals[0]?.currency ?? workspace.baseCurrency);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const m = useFinanceMutation(F.runsAddAdjustment, { invalidate: ['finance.'], silentErrors: true, successMessage: 'Adjustment added' });
  const valid = recipient && /^-?\d+(\.\d+)?$/.test(amount.trim()) && reason.trim().length >= 3;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Add Adjustment"
      description="Adjustments are separate lines with a reason. Recalculate to include them in the totals."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={m.isPending}
            disabled={!valid}
            onClick={() =>
              void m
                .run({ params: { ...params, runId: r.id }, body: { recipientMembershipId: recipient!, amount: amount.trim(), currency, kind, reason: reason.trim() } })
                .then(onClose)
                .catch((e) => {
                  setError(apiMessage(e));
                  if (isApiError(e)) setFieldErrors(Object.fromEntries(e.fieldErrors.map((x) => [x.field.replace(/^body\./, ''), x.message])));
                })
            }
          >
            Add Adjustment
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <Field label="Recipient" required error={fieldErrors.recipientMembershipId}>
          <Select value={recipient} onChange={setRecipient} options={r.participants.map((m) => ({ value: m.membershipId, label: m.displayName }))} />
        </Field>
        <RadioGroup
          label="Kind"
          orientation="horizontal"
          value={kind}
          onValueChange={setKind}
          options={[
            { value: 'manual_bonus', label: 'Manual Bonus' },
            { value: 'manual_adjustment', label: 'Manual Adjustment', description: 'May be negative' },
          ]}
        />
        <div className="grid grid-cols-[minmax(0,1fr)_120px] gap-3">
          <Field label="Amount" required error={fieldErrors.amount}>
            <AmountInput currency={currency} value={amount} onChange={(e) => decimalOk(e.target.value, kind === 'manual_adjustment') && setAmount(e.target.value)} />
          </Field>
          <Field label="Currency" required>
            <CurrencySelect value={currency} onChange={setCurrency} />
          </Field>
        </div>
        <Field label="Reason" required error={fieldErrors.reason} helper="At least 3 characters.">
          <Textarea value={reason} maxLength={2000} onChange={(e) => setReason(e.target.value)} className="min-h-[64px]" />
        </Field>
      </div>
    </Dialog>
  );
};

/** Record Payment: a record of money already paid outside Castlane. */
const PaymentDialog = ({ run: r, total, onClose, guardAct }: { run: RunDetail; total: Total; onClose: () => void; guardAct: (fn: () => Promise<void>, onError?: (e: unknown) => void) => Promise<void> }) => {
  const params = useFinanceParams();
  const { user } = useWorkspace();
  const [amount, setAmount] = useState(total.outstanding.amount);
  const [paidAt, setPaidAt] = useState(nowLocalInput(user.timezone));
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const m = useFinanceMutation(F.runsRecordPayment, { invalidate: ['finance.'], silentErrors: true });
  const iso = localInputToIso(paidAt, user.timezone);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="small"
      title="Record Payment"
      description={`${total.recipient.displayName} · outstanding ${total.outstanding.amount} ${total.outstanding.currency}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={m.isPending}
            disabled={!iso || !/^\d+(\.\d+)?$/.test(amount.trim()) || Number(amount) <= 0}
            onClick={() =>
              void guardAct(
                async () => {
                  await m.run({ params: { ...params, runId: r.id }, body: { recipientMembershipId: total.recipient.membershipId, amount: amount.trim(), currency: total.currency, paidAt: iso!, paymentReference: reference.trim() || null, note: note.trim() || null } });
                  toast.success('Payment recorded');
                  onClose();
                },
                (e) => setError(apiMessage(e)),
              )
            }
          >
            Record Payment
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <PaymentNotice />
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <Field label="Amount" required helper="Partial payments are allowed.">
          <AmountInput currency={total.currency} value={amount} onChange={(e) => decimalOk(e.target.value) && setAmount(e.target.value)} />
        </Field>
        <Field label="Paid At" required>
          <DateTimeInput timezone={user.timezone} value={paidAt} onChange={(e) => setPaidAt(e.target.value)} />
        </Field>
        <Field label="Payment Reference">
          <Input value={reference} maxLength={200} onChange={(e) => setReference(e.target.value)} />
        </Field>
        <Field label="Note">
          <Textarea value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} className="min-h-[64px]" />
        </Field>
      </div>
    </Dialog>
  );
};

const EditRunDialog = ({ run: r, onClose, onConflict }: { run: RunDetail; onClose: () => void; onConflict: () => void }) => {
  const params = useFinanceParams();
  const [start, setStart] = useState(r.periodStart);
  const [end, setEnd] = useState(r.periodEnd);
  const [participants, setParticipants] = useState(r.participants.map((m) => m.membershipId));
  const [error, setError] = useState<string | null>(null);
  const m = useFinanceMutation(F.runsUpdate, { invalidate: ['finance.'], silentErrors: true, successMessage: 'Run updated. Recalculate to refresh the lines.' });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Edit Period and Participants"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={m.isPending}
            disabled={!start || !end || end < start || participants.length === 0}
            onClick={() =>
              void m
                .run({ params: { ...params, runId: r.id }, body: { periodStart: start, periodEnd: end, participantMembershipIds: participants } }, { ifMatch: r.rowVersion })
                .then(onClose)
                .catch((e) => (isConflict(e) ? onConflict() : setError(apiMessage(e))))
            }
          >
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Period Start" required>
            <DateInput value={start} onChange={(e) => setStart(e.target.value)} />
          </Field>
          <Field label="Period End" required>
            <DateInput value={end} onChange={(e) => setEnd(e.target.value)} />
          </Field>
        </div>
        <Field label="Participants" required>
          <MultiMemberSelect value={participants} onChange={setParticipants} />
        </Field>
      </div>
    </Dialog>
  );
};
