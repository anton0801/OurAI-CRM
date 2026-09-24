'use client';
import { DotsThree } from '@phosphor-icons/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { financeEndpoints as F, type EntryDetail } from '@castlane/api-contracts';
import {
  Badge,
  Banner,
  Button,
  Checkbox,
  ConfirmDialog,
  DataTable,
  DescriptionList,
  Dialog,
  Field,
  IconButton,
  Input,
  Menu,
  PageHeader,
  Panel,
  Textarea,
  formatDate,
  formatDateTime,
  toast,
  type Column,
} from '@castlane/ui';
import { MemberSelect } from '@/components/common/pickers';
import { QueryState } from '@/components/common/query-state';
import { ConflictDialog } from '@/components/common/conflict';
import { useEditBase } from '@/lib/edit-base';
import { useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';
import { AllocationEditor, allocationToSpec, emptyAllocation, rowKey, type AllocationForm } from './allocation-editor';
import { EntryStatus, Money, MoneyList, ReasonDialog, SourceText, apiMessage, decimalOk, isConflict, useFinanceParams, useGuardedAction, useFinanceMutation } from './common';
import { EntryEditor } from './entry-editor';
import { EvidencePanel } from './evidence';

type Line = EntryDetail['lines'][number];

/** S56 Financial Entry detail: lines, FX, allocations, settlements, evidence and the state actions. */
export const EntryDetailScreen = ({ entryId }: { entryId: string }) => {
  const params = useFinanceParams();
  const { state, set } = useUrlState<'mode'>();
  const q = useApiQuery(F.entriesGet, { params: { ...params, entryId } });
  return (
    <QueryState query={q}>
      {q.data ? (
        state.mode === 'edit' && q.data.permissions.update ? (
          <EntryEditor entry={q.data} onDone={() => set({ mode: null })} />
        ) : (
          <EntryView entry={q.data} onEdit={() => set({ mode: 'edit' })} refetch={() => void q.refetch()} />
        )
      ) : null}
    </QueryState>
  );
};

type DialogKind = 'post' | 'reject' | 'reverse' | 'allocate' | 'attributions' | 'submit' | null;

const EntryView = ({ entry: e, onEdit, refetch }: { entry: EntryDetail; onEdit: () => void; refetch: () => void }) => {
  const router = useRouter();
  const wsPath = useWsPath();
  const can = useCan();
  const { user } = useWorkspace();
  const params = useFinanceParams();
  const ep = { ...params, entryId: e.id };
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const guard = useGuardedAction();
  const inv = { invalidate: ['finance.'], silentErrors: true };
  const submit = useFinanceMutation(F.entriesSubmit, inv);
  const post = useFinanceMutation(F.entriesPost, inv);
  const reject = useFinanceMutation(F.entriesReject, inv);
  const reverse = useFinanceMutation(F.entriesReverse, inv);
  const p = e.permissions;
  const open = (d: DialogKind) => {
    setError(null);
    setDialog(d);
  };
  const fail = (err: unknown) => {
    if (isConflict(err)) {
      setDialog(null);
      setConflict(true);
    } else setError(apiMessage(err));
  };

  const primary = p.post ? (
    <Button variant="primary" onClick={() => open('post')}>
      Post
    </Button>
  ) : p.submit ? (
    <Button variant="primary" onClick={() => open('submit')}>
      Submit
    </Button>
  ) : null;

  const isRevenue = e.lines.some((l) => l.accountingClass === 'revenue');
  const settlementCols: Column<EntryDetail['settlements'][number]>[] = [
    { key: 'paid', header: 'Paid At', minWidth: 170, cell: (s) => formatDateTime(s.paidAt, user.timezone) },
    { key: 'dir', header: 'Direction', minWidth: 100, cell: (s) => label('settlementDirection', s.direction) },
    { key: 'doc', header: 'Settled (document)', align: 'right', minWidth: 150, cell: (s) => <Money value={s.documentAmount} /> },
    { key: 'cash', header: 'Cash', align: 'right', minWidth: 140, cell: (s) => <Money value={s.cashAmount} /> },
    { key: 'state', header: 'Status', minWidth: 100, cell: (s) => (s.reversed ? <Badge>Reversed</Badge> : <Badge tone="success">Matched</Badge>) },
    {
      key: 'open',
      header: <span className="sr-only">Open</span>,
      headerLabel: 'Open',
      minWidth: 80,
      cell: (s) => (
        <Link href={wsPath(`/finance/settlements?open=${s.settlementId}`)} className="text-primary hover:underline">
          Open
        </Link>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={e.title}
        crumbs={[{ label: 'Finance', href: wsPath('/finance') }, { label: 'Entries', href: wsPath('/finance') }, { label: e.title }]}
        meta={
          <>
            <EntryStatus state={e.displayState} isReversal={e.isReversal} />
            <Badge>{label('entryType', e.type)}</Badge>
            <span className="text-[13px] text-fg-2">Recognized {formatDate(e.recognitionDate)}</span>
          </>
        }
        actions={
          <>
            {p.update ? <Button onClick={onEdit}>Edit</Button> : null}
            {primary}
            <Menu
              label="More entry actions"
              trigger={<IconButton label="More" variant="secondary" icon={<DotsThree size={18} weight="bold" />} />}
              items={[
                { label: 'Submit', onSelect: () => open('submit'), hidden: !p.submit || !p.post },
                { label: 'Reject', onSelect: () => open('reject'), hidden: !p.reject, destructive: true },
                { label: 'Allocate', onSelect: () => open('allocate'), hidden: !p.allocate },
                { label: 'Revenue Attribution', onSelect: () => open('attributions'), hidden: !p.attribute || !isRevenue },
                { label: 'Add Settlement', onSelect: () => router.push(wsPath(`/finance/settlements?register=1&entryId=${e.id}`)), hidden: !p.addSettlement },
                {
                  label: 'Record Refund',
                  description: 'New draft linked to this revenue entry',
                  onSelect: () => router.push(wsPath(`/finance/entries/new?type=adjustment&refundOf=${e.id}`)),
                  hidden: !(e.displayState === 'posted' && isRevenue && can('finance.create')),
                },
                { label: 'Reverse', onSelect: () => open('reverse'), hidden: !p.reverse, destructive: true, separatorBefore: true },
              ]}
            />
          </>
        }
      />

      {e.state === 'posted' && e.displayState === 'posted' ? <Banner tone="info">Posted entries cannot be edited. Use Reverse to correct them; a replacement draft can be created at the same time.</Banner> : null}
      {e.displayState === 'reversed' && e.reversedByEntryId ? (
        <Banner tone="info" action={<Link className="font-semibold underline" href={wsPath(`/finance/entries/${e.reversedByEntryId}`)}>Open Reversal</Link>}>
          Reversed{e.reversalReason ? `: ${e.reversalReason}` : ''}.
        </Banner>
      ) : null}
      {e.reversesEntryId ? (
        <Banner tone="info" action={<Link className="font-semibold underline" href={wsPath(`/finance/entries/${e.reversesEntryId}`)}>Open Original</Link>}>
          This entry reverses another entry{e.reversalReason ? `: ${e.reversalReason}` : ''}.
        </Banner>
      ) : null}
      {e.replacementOfEntryId ? (
        <Banner tone="info" action={<Link className="font-semibold underline" href={wsPath(`/finance/entries/${e.replacementOfEntryId}`)}>Open Replaced Entry</Link>}>
          Replacement for a reversed entry.
        </Banner>
      ) : null}
      {e.refundOfEntryId ? (
        <Banner tone="info" action={<Link className="font-semibold underline" href={wsPath(`/finance/entries/${e.refundOfEntryId}`)}>Open Original Revenue</Link>}>
          Refund of a posted revenue entry.
        </Banner>
      ) : null}
      {e.rejectedReason && e.state === 'rejected' ? <Banner tone="warning">Rejected: {e.rejectedReason}</Banner> : null}
      {e.missingFx.length ? (
        <Banner tone="warning" action={can('finance.post') ? <Link className="font-semibold underline" href={wsPath('/finance/fx-rates')}>Add FX Rate</Link> : undefined}>
          Add an FX rate to {e.baseCurrency} for {[...new Set(e.missingFx.map((m) => m.currency))].join(', ')} effective on or before {formatDate(e.missingFx[0]!.date)}. The draft can be saved, but not posted.
        </Banner>
      ) : null}
      {e.controlCheck.status === 'mismatch' ? (
        <Banner tone="danger">
          The statement total does not match its components. Difference: <Money value={e.controlCheck.difference} />
        </Banner>
      ) : null}

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-5">
          <Panel title="Lines" bodyClassName="p-0">
            <LinesTable lines={e.lines} baseCurrency={e.baseCurrency} />
          </Panel>
          {e.summary ? (
            <Panel title="Summary" description={`In ${e.baseCurrency}`}>
              <DescriptionList
                columns={3}
                items={[
                  { label: 'Gross revenue', value: e.summary.grossIncomplete ? <span>Not provided</span> : <Money value={e.summary.grossRevenue} /> },
                  { label: 'Refunds', value: <Money value={e.summary.refunds} /> },
                  { label: 'Fees', value: <Money value={e.summary.fees} /> },
                  { label: 'Net revenue', value: <Money value={e.summary.netRevenue} strong /> },
                  { label: 'Operating expenses', value: <Money value={e.summary.operatingExpenses} /> },
                  { label: 'Compensation expense', value: <Money value={e.summary.compensationExpense} /> },
                  { label: 'Result', value: <Money value={e.summary.result} strong /> },
                ]}
              />
            </Panel>
          ) : null}
          {e.state === 'posted' ? (
            <Panel title="Settlements" description="Money actually received or paid against this entry" bodyClassName="flex flex-col gap-3 p-4">
              <div className="flex flex-wrap items-center gap-2 text-[14px]">
                <span className="text-fg-2">Outstanding</span>
                <MoneyList values={e.outstanding.filter((o) => !/^-?0(\.0+)?$/.test(o.amount))} empty="Fully settled" />
              </div>
              {e.settlements.length ? <DataTable caption="Settlements for this entry" rows={e.settlements} columns={settlementCols} getRowId={(s) => s.allocationId} /> : <p className="text-[13px] text-fg-2">No settlements yet.</p>}
            </Panel>
          ) : null}
          {isRevenue ? (
            <Panel title="Revenue Attribution" description="Who revenue-share compensation is calculated for">
              {e.attributions.length === 0 ? (
                <p className="text-[13px] text-fg-2">No attribution. Revenue-share rules only use explicitly attributed revenue.</p>
              ) : (
                <ul className="flex flex-col gap-1 text-[14px]">
                  {e.attributions.map((a) => (
                    <li key={a.id} className="flex items-center justify-between gap-2">
                      <span>{a.member.displayName}</span>
                      <span className="text-fg-2">
                        {a.sharePercent}% · {a.basis === 'manual' ? 'Manual' : 'From source assignment'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          ) : null}
        </div>
        <div className="flex min-w-0 flex-col gap-5">
          <Panel title="Details">
            <DescriptionList
              columns={1}
              items={[
                { label: 'Counterparty', value: e.counterparty },
                { label: 'Source', value: <SourceText source={e.source} /> },
                { label: 'Account', value: e.account?.name, hidden: !e.account },
                { label: 'Campaign', value: e.campaign ? <Link className="text-primary hover:underline" href={wsPath(`/campaigns/${e.campaign.id}`)}>{e.campaign.name}</Link> : null, hidden: !e.campaign },
                { label: 'Deal', value: e.deal ? <Link className="text-primary hover:underline" href={wsPath(`/deals/${e.deal.id}`)}>{e.deal.name}</Link> : null, hidden: !e.deal },
                { label: 'Shift', value: e.shiftId ? <Link className="text-primary hover:underline" href={wsPath(`/ofm/shifts/${e.shiftId}`)}>Open shift</Link> : null, hidden: !e.shiftId },
                { label: 'Compensation Run', value: e.compensationRunId ? <Link className="text-primary hover:underline" href={wsPath(`/finance/compensation/runs/${e.compensationRunId}`)}>Open run</Link> : null, hidden: !e.compensationRunId },
                { label: 'Sale Record', value: 'Confirmed from the reconciliation queue', hidden: !e.saleCandidateId },
                { label: 'Base Currency', value: e.baseCurrency },
                { label: 'Created', value: `${formatDateTime(e.createdAt, user.timezone)}${e.createdBy ? ` · ${e.createdBy.displayName}` : ''}` },
                { label: 'Submitted', value: e.submittedAt ? `${formatDateTime(e.submittedAt, user.timezone)}${e.submittedBy ? ` · ${e.submittedBy.displayName}` : ''}` : null, hidden: !e.submittedAt },
                { label: 'Posted', value: e.postedAt ? `${formatDateTime(e.postedAt, user.timezone)}${e.postedBy ? ` · ${e.postedBy.displayName}` : ''}` : null, hidden: !e.postedAt },
                { label: 'Self-approval Reason', value: e.selfApprovalReason, hidden: !e.selfApprovalReason },
                { label: 'Note', value: e.note, hidden: !e.note },
              ]}
            />
          </Panel>
          <EvidencePanel entityType="financial_entry" entityId={e.id} evidence={e.evidence} canAttach={p.attachEvidence && e.state !== 'posted'} locked={e.state === 'posted'} />
        </div>
      </div>

      <ConfirmDialog
        open={dialog === 'submit'}
        onOpenChange={(o) => !o && setDialog(null)}
        title="Submit Entry"
        body="The entry goes to an approver for posting. You can no longer edit it unless it is rejected."
        confirmLabel="Submit"
        loading={submit.isPending}
        onConfirm={() =>
          void submit
            .run({ params: ep, body: {} }, { ifMatch: e.rowVersion })
            .then(() => {
              toast.success('Entry submitted for posting');
              setDialog(null);
            })
            .catch(fail)
        }
      >
        {error ? <Banner tone="danger">{error}</Banner> : null}
      </ConfirmDialog>
      <PostDialog
        open={dialog === 'post'}
        onOpenChange={(o) => !o && setDialog(null)}
        entry={e}
        loading={post.isPending}
        error={error}
        onConfirm={(approverNote, exceptionReason) =>
          void guard.act(
            async () => {
              await post.run({ params: ep, body: { approverNote: approverNote || undefined, exceptionReason: exceptionReason || undefined } }, { ifMatch: e.rowVersion });
              toast.success('Entry posted');
              setDialog(null);
            },
            fail,
          )
        }
      />
      <ReasonDialog
        open={dialog === 'reject'}
        onOpenChange={(o) => !o && setDialog(null)}
        title="Reject Entry"
        body="The author sees the reason and can correct the draft."
        confirmLabel="Reject"
        destructive
        loading={reject.isPending}
        error={error}
        onConfirm={(reason) =>
          void reject
            .run({ params: ep, body: { reason } }, { ifMatch: e.rowVersion })
            .then(() => {
              toast.success('Entry rejected');
              setDialog(null);
            })
            .catch(fail)
        }
      />
      <ReverseDialog
        open={dialog === 'reverse'}
        onOpenChange={(o) => !o && setDialog(null)}
        loading={reverse.isPending}
        error={error}
        onConfirm={(reason, effectiveDate, createReplacement) =>
          void guard.act(
            async () => {
              const r = await reverse.run({ params: ep, body: { reason, effectiveDate, createReplacement } }, { ifMatch: e.rowVersion });
              toast.success(r.replacementId ? 'Entry reversed. Edit the replacement draft.' : 'Entry reversed');
              setDialog(null);
              if (r.replacementId) router.push(wsPath(`/finance/entries/${r.replacementId}?mode=edit`));
            },
            fail,
          )
        }
      />
      {dialog === 'allocate' ? <AllocateDialog entry={e} onClose={() => setDialog(null)} onConflict={() => { setDialog(null); setConflict(true); }} /> : null}
      {dialog === 'attributions' ? <AttributionsDialog entry={e} onClose={() => setDialog(null)} /> : null}
      <ConflictDialog open={conflict} onOpenChange={setConflict} onReload={() => { setConflict(false); refetch(); }} />
      {guard.dialog}
    </div>
  );
};

const LinesTable = ({ lines, baseCurrency }: { lines: Line[]; baseCurrency: string }) => {
  const { user } = useWorkspace();
  const columns: Column<Line>[] = [
    { key: 'no', header: '#', minWidth: 40, cell: (l) => l.lineNo },
    {
      key: 'category',
      header: 'Category',
      sticky: true,
      minWidth: 200,
      cell: (l) => (
        <span className="flex flex-col">
          <span className="text-fg">{l.category.name}</span>
          <span className="text-[12px] text-fg-2">
            {label('accountingClass', l.accountingClass)}
            {l.fxEffect ? ` · ${l.fxEffect === 'gain' ? 'Gain' : 'Loss'}` : ''}
            {l.description ? ` · ${l.description}` : ''}
          </span>
        </span>
      ),
    },
    { key: 'amount', header: 'Amount', align: 'right', minWidth: 130, cell: (l) => (l.componentsUnknown ? <span className="flex flex-col items-end"><Money value={l.amount} /><span className="text-[11px] text-fg-2">Net only</span></span> : <Money value={l.amount} />) },
    {
      key: 'fx',
      header: 'FX Rate',
      minWidth: 150,
      cell: (l) =>
        l.amount.currency === baseCurrency ? (
          <span className="text-fg-muted">—</span>
        ) : l.fx ? (
          <span className="flex flex-col text-[12px]">
            <span className="font-mono">{l.fx.rate}</span>
            <span className="text-fg-2">
              {l.fx.source ?? ''}
              {l.fx.effectiveDate ? ` · ${formatDate(l.fx.effectiveDate)}` : ''}
            </span>
          </span>
        ) : (
          <span className="text-[12px] text-warning">Missing</span>
        ),
    },
    { key: 'base', header: `Base (${baseCurrency})`, align: 'right', minWidth: 130, cell: (l) => (l.baseAmount ? <Money value={l.baseAmount} /> : <span className="text-fg-muted">Not provided</span>) },
    {
      key: 'alloc',
      header: 'Allocation',
      minWidth: 220,
      cell: (l) => (
        <ul className="flex flex-col gap-0.5 text-[12px]">
          {l.allocations.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-2">
              <span className={a.project ? 'text-fg' : 'text-warning'}>
                {a.project?.name ?? 'Unallocated'}
                {a.adjustmentOfId ? ' (adjustment)' : ''}
              </span>
              <Money value={a.amount} />
            </li>
          ))}
        </ul>
      ),
    },
    { key: 'ref', header: 'Transaction ID', minWidth: 140, cell: (l) => (l.transactionRef ? <span className="font-mono text-[12px]">{l.transactionRef}</span> : '—') },
    { key: 'commitment', header: 'Commitment', minWidth: 140, cell: (l) => l.commitment?.name ?? '—' },
  ];
  return <DataTable caption="Entry lines" rows={lines} columns={columns} getRowId={(l) => l.id} density={user.density} />;
};

const PostDialog = ({
  open,
  onOpenChange,
  entry,
  loading,
  error,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  entry: EntryDetail;
  loading: boolean;
  error: string | null;
  onConfirm: (approverNote: string, exceptionReason: string) => void;
}) => {
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const self = entry.permissions.selfApprovalRequired;
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setNote('');
          setReason('');
        }
        onOpenChange(o);
      }}
      title="Post Entry"
      body="Posting freezes the lines, FX rates and allocations. Later corrections are made with a reversal."
      confirmLabel="Post"
      loading={loading}
      confirmDisabled={self && reason.trim().length < 3}
      onConfirm={() => onConfirm(note.trim(), reason.trim())}
    >
      {error ? <Banner tone="danger">{error}</Banner> : null}
      {self ? (
        <Field label="Exception Reason" required helper="You submitted this entry. Posting it yourself is allowed only when no other approver exists, and the reason is audited.">
          <Textarea value={reason} maxLength={2000} onChange={(e) => setReason(e.target.value)} />
        </Field>
      ) : null}
      <Field label="Approver Note">
        <Textarea value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} className="min-h-[64px]" />
      </Field>
    </ConfirmDialog>
  );
};

const ReverseDialog = ({
  open,
  onOpenChange,
  loading,
  error,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  loading: boolean;
  error: string | null;
  onConfirm: (reason: string, date: string, replacement: boolean) => void;
}) => {
  const [replacement, setReplacement] = useState(false);
  return (
    <ReasonDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Reverse Entry"
      body="A linked reversing entry cancels this one on the effective date. The original stays in history; nothing is deleted."
      confirmLabel="Reverse"
      destructive
      loading={loading}
      error={error}
      dateLabel="Effective Date"
      defaultDate={new Date().toISOString().slice(0, 10)}
      onConfirm={(reason, date) => onConfirm(reason, date, replacement)}
    >
      <Checkbox checked={replacement} onCheckedChange={setReplacement} label="Create a replacement draft" description="Copies this entry into a new draft to correct and post." />
    </ReasonDialog>
  );
};

type Preview = { previewToken: string; mode: 'draft_edit' | 'posted_adjustment'; lines: { lineId: string; amount: { amount: string; currency: string }; rows: { project: { id: string; name: string } | null; amount: { amount: string; currency: string } }[] }[] };

/** Allocation change: preview the exact split first, then apply it (posted entries get adjustment rows). */
const AllocateDialog = ({ entry, onClose, onConflict }: { entry: EntryDetail; onClose: () => void; onConflict: () => void }) => {
  const params = useFinanceParams();
  const ep = { ...params, entryId: entry.id };
  const posted = entry.state === 'posted';
  const currencies = [...new Set(entry.lines.map((l) => l.amount.currency))];
  const [alloc, setAlloc] = useState<AllocationForm>(emptyAllocation());
  const [lineIds, setLineIds] = useState<string[]>(entry.lines.map((l) => l.id));
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const previewM = useFinanceMutation(F.entriesAllocationPreview, { silentErrors: true });
  const apply = useFinanceMutation(F.entriesAllocate, { invalidate: ['finance.'], silentErrors: true, successMessage: 'Allocation updated' });
  const guard = useGuardedAction();
  const runPreview = async () => {
    setError(null);
    setFieldErrors({});
    try {
      const r = await previewM.run({ params: ep, body: { allocation: allocationToSpec(alloc), lineIds, effectiveDate: posted ? date : undefined } });
      setPreview(r as Preview);
    } catch (e) {
      const fe = (e as { fieldErrors?: { field: string; message: string }[] }).fieldErrors ?? [];
      setFieldErrors(Object.fromEntries(fe.map((x) => [x.field.replace(/^body\./, ''), x.message])));
      setError(apiMessage(e));
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="wide"
      title="Allocate"
      description={posted ? 'Posted allocations are not changed. Adjustment rows move the amounts from the effective date.' : 'Replaces the draft allocation.'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          {preview ? (
            <>
              <Button onClick={() => setPreview(null)}>Change</Button>
              <Button
                variant="primary"
                loading={apply.isPending}
                onClick={() =>
                  void guard.act(
                    async () => {
                      await apply.run({ params: ep, body: { previewToken: preview.previewToken } }, { ifMatch: entry.rowVersion });
                      onClose();
                    },
                    (e) => (isConflict(e) ? onConflict() : setError(apiMessage(e))),
                  )
                }
              >
                Apply Allocation
              </Button>
            </>
          ) : (
            <Button variant="primary" loading={previewM.isPending} disabled={lineIds.length === 0} onClick={() => void runPreview()}>
              Preview
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        {!preview ? (
          <>
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-[12px] font-[550] text-fg">Lines</legend>
              {entry.lines.map((l) => (
                <Checkbox
                  key={l.id}
                  checked={lineIds.includes(l.id)}
                  onCheckedChange={(v) => setLineIds(v ? [...lineIds, l.id] : lineIds.filter((x) => x !== l.id))}
                  label={`${l.lineNo}. ${l.category.name} · ${l.amount.amount} ${l.amount.currency}`}
                />
              ))}
            </fieldset>
            {posted ? (
              <Field label="Effective Date" required>
                <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </Field>
            ) : null}
            <AllocationEditor value={alloc} onChange={setAlloc} currency={currencies.length === 1 ? currencies[0]! : entry.baseCurrency} errors={fieldErrors} />
          </>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-[14px]">{preview.mode === 'posted_adjustment' ? 'These adjustment rows will be added:' : 'The draft will be allocated like this:'}</p>
            {preview.lines.map((l) => (
              <div key={l.lineId} className="rounded-[8px] border border-line p-3">
                <p className="mb-2 text-[13px] font-semibold">
                  Line total <Money value={l.amount} />
                </p>
                <ul className="flex flex-col gap-1 text-[13px]">
                  {l.rows.map((r, i) => (
                    <li key={i} className="flex justify-between gap-2">
                      <span className={r.project ? '' : 'text-warning'}>{r.project?.name ?? 'Unallocated'}</span>
                      <Money value={r.amount} />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>
      {guard.dialog}
    </Dialog>
  );
};

type AttrRow = { key: string; membershipId: string | null; sharePercent: string };

const AttributionsDialog = ({ entry, onClose }: { entry: EntryDetail; onClose: () => void }) => {
  const params = useFinanceParams();
  const [rows, setRows] = useState<AttrRow[]>(
    entry.attributions.length ? entry.attributions.map((a) => ({ key: rowKey(), membershipId: a.member.membershipId, sharePercent: a.sharePercent })) : [{ key: rowKey(), membershipId: null, sharePercent: '100' }],
  );
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Saved against the entry as the dialog opened; a conflict keeps the rows (T162).
  const edit = useEditBase(entry, {
    onReload: (x) => setRows(x.attributions.length ? x.attributions.map((a) => ({ key: rowKey(), membershipId: a.member.membershipId, sharePercent: a.sharePercent })) : [{ key: rowKey(), membershipId: null, sharePercent: '100' }]),
  });
  const m = useFinanceMutation(F.entriesSetAttributions, { invalidate: ['finance.'], silentErrors: true, successMessage: 'Attribution saved' });
  const total = rows.reduce((a, r) => a + (Number(r.sharePercent) || 0), 0);
  const valid = rows.every((r) => r.membershipId && Number(r.sharePercent) > 0) && Math.abs(total - 100) < 1e-9;
  return (
    <>
      <Dialog
        open
        onOpenChange={(o) => !o && onClose()}
        title="Revenue Attribution"
        description="Shares of this revenue used by revenue-share compensation rules. Changes after a run was approved become adjustments in the next open run."
        footer={
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              loading={m.isPending}
              disabled={!valid}
              onClick={() =>
                void m
                  .run({ params: { ...params, entryId: entry.id }, body: { attributions: rows.map((r) => ({ membershipId: r.membershipId!, sharePercent: r.sharePercent })), reason: reason.trim() || undefined } }, { ifMatch: edit.version })
                  .then(onClose)
                  .catch((e) => (edit.catchConflict(e) ? undefined : setError(apiMessage(e))))
              }
            >
              Save Attribution
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {error ? <Banner tone="danger">{error}</Banner> : null}
          {rows.map((r, i) => (
            <div key={r.key} className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <MemberSelect aria-label={`Member ${i + 1}`} value={r.membershipId} onChange={(v) => setRows(rows.map((x, j) => (j === i ? { ...x, membershipId: v } : x)))} />
              </div>
              <div className="relative w-full sm:w-[120px]">
                <Input aria-label={`Share ${i + 1}`} inputMode="decimal" className="pr-8 text-right font-mono" value={r.sharePercent} onChange={(e) => decimalOk(e.target.value) && setRows(rows.map((x, j) => (j === i ? { ...x, sharePercent: e.target.value } : x)))} />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[12px] text-fg-2">%</span>
              </div>
              <Button size="sm" variant="ghost" disabled={rows.length === 1} onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                Remove
              </Button>
            </div>
          ))}
          <div className="flex items-center justify-between">
            <Button size="sm" onClick={() => setRows([...rows, { key: rowKey(), membershipId: null, sharePercent: '' }])}>
              Add Member
            </Button>
            <span className={Math.abs(total - 100) < 1e-9 ? 'text-[12px] text-fg-2' : 'text-[12px] text-warning'}>Total {total}% of 100%</span>
          </div>
          <Field label="Reason" helper="Recorded with a manual attribution.">
            <Textarea value={reason} maxLength={2000} onChange={(e) => setReason(e.target.value)} className="min-h-[64px]" />
          </Field>
        </div>
      </Dialog>
      <ConflictDialog {...edit.conflictDialog} />
    </>
  );
};
