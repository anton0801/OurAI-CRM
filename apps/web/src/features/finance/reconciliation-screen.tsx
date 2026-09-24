'use client';
import { CheckSquare } from '@phosphor-icons/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { financeEndpoints as F, type SaleCandidateView } from '@castlane/api-contracts';
import { SALE_CANDIDATE_STATES } from '@castlane/domain';
import { Badge, Banner, Button, DataTable, DateInput, Dialog, EmptyState, Field, Input, MultiSelect, NoResults, PageHeader, Select, StatusBadge, Textarea, Toolbar, formatDateTime, toast, type Column } from '@castlane/ui';
import { EntitySelect } from '@/components/common/entity-select';
import { MemberSelect } from '@/components/common/pickers';
import { QueryState } from '@/components/common/query-state';
import { useApiInfinite, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';
import { ConflictDialog } from '@/components/common/conflict';
import { useEditBase } from '@/lib/edit-base';
import { FinanceNav, Money, ReasonDialog, apiMessage, decimalOk, isConflict, useFinanceParams, useFinanceMutation } from './common';
import { rowKey } from './allocation-editor';

type Keys = 'state' | 'projectId' | 'accountId';
type CandState = (typeof SALE_CANDIDATE_STATES)[number];

/**
 * Sale reconciliation queue: sale records reported by operations are verified against finance.
 * Confirming creates a draft income entry (never posted automatically); duplicates are flagged.
 */
export const ReconciliationScreen = () => {
  const can = useCan();
  const wsPath = useWsPath();
  const { user } = useWorkspace();
  const params = useFinanceParams();
  const { state, set, list } = useUrlState<Keys>({ state: 'pending' });
  const query = { state: list('state') as CandState[], projectId: state.projectId, accountId: state.accountId };
  const data = useApiInfinite(F.saleCandidatesList, { params, query });
  const [confirmFor, setConfirmFor] = useState<SaleCandidateView | null>(null);
  const [rejectFor, setRejectFor] = useState<SaleCandidateView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reject = useFinanceMutation(F.saleCandidatesReject, { invalidate: ['finance.', 'ofm.'], silentErrors: true, successMessage: 'Sale record rejected' });
  const filtered = !!(state.projectId || state.accountId || (state.state && state.state !== 'pending'));
  const columns: Column<SaleCandidateView>[] = [
    { key: 'occurred', header: 'Occurred', sticky: true, minWidth: 170, cell: (c) => formatDateTime(c.occurredAt, user.timezone) },
    {
      key: 'where',
      header: 'Account / Project',
      minWidth: 180,
      cell: (c) => (
        <span className="flex flex-col">
          <span>{c.account?.name ?? '—'}</span>
          <span className="text-[12px] text-fg-2">{c.project?.name ?? ''}</span>
        </span>
      ),
    },
    {
      key: 'source',
      header: 'Source',
      minWidth: 180,
      cell: (c) => (c.manualReference ? <span className="text-fg-2">Manually recorded</span> : <span className="font-mono text-[12px]">{`${c.sourceNamespace}:${c.sourceTransactionId}`}</span>),
    },
    { key: 'gross', header: 'Gross', align: 'right', minWidth: 110, cell: (c) => <Money value={c.gross} /> },
    { key: 'refund', header: 'Refund', align: 'right', minWidth: 100, cell: (c) => <Money value={c.refund} /> },
    { key: 'fee', header: 'Fee', align: 'right', minWidth: 100, cell: (c) => <Money value={c.fee} /> },
    { key: 'net', header: 'Net', align: 'right', minWidth: 110, cell: (c) => <Money value={c.net} strong /> },
    {
      key: 'claimed',
      header: 'Claimed By',
      minWidth: 160,
      cell: (c) => (c.claimedAllocations.length ? c.claimedAllocations.map((a) => `${a.member.displayName} ${a.sharePercent}%`).join(', ') : <span className="text-fg-muted">—</span>),
    },
    {
      key: 'state',
      header: 'Status',
      minWidth: 170,
      cell: (c) => (
        <span className="flex flex-wrap items-center gap-1">
          <StatusBadge status={c.state} label={label('saleCandidateState', c.state)} />
          {c.duplicate ? (
            <Link href={wsPath(`/finance/entries/${c.duplicate.entryId}`)} onClick={(e) => e.stopPropagation()}>
              <Badge tone="warning" title={`Already recorded: ${c.duplicate.title}`}>
                Possible duplicate
              </Badge>
            </Link>
          ) : null}
          {c.financialEntryId ? (
            <Link href={wsPath(`/finance/entries/${c.financialEntryId}`)} className="text-[12px] text-primary hover:underline">
              Entry
            </Link>
          ) : null}
        </span>
      ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      headerLabel: 'Actions',
      minWidth: 200,
      cell: (c) =>
        c.state === 'pending' ? (
          <span className="flex gap-1">
            {can('finance.create') ? (
              <Button size="sm" onClick={() => { setError(null); setConfirmFor(c); }}>
                Confirm to Draft
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" onClick={() => { setError(null); setRejectFor(c); }}>
              Reject
            </Button>
          </span>
        ) : c.reviewNote ? (
          <span className="text-[12px] text-fg-2">{c.reviewNote}</span>
        ) : null,
    },
  ];
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Sale Reconciliation" description="Verify sale records reported by operations. Confirming creates a draft income entry for posting; nothing is posted automatically." />
      <FinanceNav />
      <Toolbar>
        <div className="w-[200px]">
          <MultiSelect aria-label="Status" placeholder="Status" value={list('state')} onChange={(v) => set({ state: v.join(',') || null })} options={SALE_CANDIDATE_STATES.map((s) => ({ value: s, label: label('saleCandidateState', s) }))} />
        </div>
        <div className="w-[200px]">
          <EntitySelect type="project" aria-label="Project" placeholder="Project" value={state.projectId} onChange={(v) => set({ projectId: v })} clearable />
        </div>
        <div className="w-[200px]">
          <EntitySelect type="account" aria-label="Account" placeholder="Account" value={state.accountId} onChange={(v) => set({ accountId: v })} clearable />
        </div>
      </Toolbar>
      <QueryState query={data}>
        {data.items.length === 0 && !data.isFetching ? (
          filtered ? (
            <NoResults onClear={() => set({ state: null, projectId: null, accountId: null })} />
          ) : (
            <EmptyState icon={<CheckSquare size={28} />} title="Nothing to reconcile" description="Sale records reported during shifts appear here for verification." />
          )
        ) : (
          <DataTable
            caption="Sale records"
            rows={data.items}
            columns={columns}
            getRowId={(c) => c.id}
            density={user.density}
            hasMore={data.hasNextPage}
            loadingMore={data.isFetchingNextPage}
            onLoadMore={() => void data.fetchNextPage()}
          />
        )}
      </QueryState>
      {confirmFor ? <ConfirmCandidateDialog candidate={confirmFor} onClose={() => setConfirmFor(null)} /> : null}
      <ReasonDialog
        open={!!rejectFor}
        onOpenChange={(o) => !o && setRejectFor(null)}
        title="Reject Sale Record"
        body={rejectFor?.duplicate ? `This transaction is already recorded as “${rejectFor.duplicate.title}”. Rejecting it keeps revenue from being counted twice.` : 'The reporter sees the reason. No revenue is recorded.'}
        confirmLabel="Reject"
        destructive
        loading={reject.isPending}
        error={error}
        onConfirm={(reason) =>
          void reject
            .run({ params: { ...params, candidateId: rejectFor!.id }, body: { reason } }, { ifMatch: rejectFor!.rowVersion })
            .then(() => setRejectFor(null))
            .catch((e) => setError(isConflict(e) ? 'This record changed. Close the dialog to see the latest version.' : apiMessage(e)))
        }
      />
    </div>
  );
};

type AttrRow = { key: string; membershipId: string | null; sharePercent: string };

const ConfirmCandidateDialog = ({ candidate: c, onClose }: { candidate: SaleCandidateView; onClose: () => void }) => {
  const router = useRouter();
  const wsPath = useWsPath();
  const params = useFinanceParams();
  const cats = useApiQuery(F.categoriesList, { params, query: {} }, { staleTime: 60_000 });
  const revenueCats = (cats.data ?? []).filter((x) => x.accountingClass === 'revenue');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [date, setDate] = useState(c.occurredAt.slice(0, 10));
  const [rows, setRows] = useState<AttrRow[]>(c.claimedAllocations.map((a) => ({ key: rowKey(), membershipId: a.member.membershipId, sharePercent: a.sharePercent })));
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Confirmed against the candidate as the dialog opened (T162).
  const edit = useEditBase(c);
  const m = useFinanceMutation(F.saleCandidatesConfirm, { invalidate: ['finance.', 'ofm.'], silentErrors: true });
  const total = rows.reduce((a, r) => a + (Number(r.sharePercent) || 0), 0);
  const attrOk = rows.length === 0 || (rows.every((r) => r.membershipId && Number(r.sharePercent) > 0) && Math.abs(total - 100) < 1e-9);
  const chosen = categoryId ?? revenueCats[0]?.id ?? null;
  return (
    <>
      <Dialog
        open
        onOpenChange={(o) => !o && onClose()}
        title="Confirm to Draft"
        description="Creates a draft revenue entry with the reported gross, refund and fee components. It still needs posting by an approver."
        footer={
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              loading={m.isPending}
              disabled={!chosen || !attrOk}
              onClick={() =>
                void m
                  .run({ params: { ...params, candidateId: c.id }, body: { categoryId: chosen!, recognitionDate: date || undefined, attributions: rows.map((r) => ({ membershipId: r.membershipId!, sharePercent: r.sharePercent })), note: note.trim() || undefined } }, { ifMatch: edit.version })
                  .then((r) => {
                    toast.success('Draft entry created');
                    onClose();
                    router.push(wsPath(`/finance/entries/${r.entry.id}`));
                  })
                  .catch((e) => (edit.catchConflict(e) ? undefined : setError(apiMessage(e))))
              }
            >
              Create Draft Entry
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {error ? <Banner tone="danger">{error}</Banner> : null}
          {c.duplicate ? (
            <Banner tone="warning">
              This source transaction is already recorded as “{c.duplicate.title}”. Confirming would double the revenue — reject it as a duplicate instead.
            </Banner>
          ) : null}
          <div className="flex flex-wrap gap-4 text-[13px]">
            <span>
              Gross <Money value={c.gross} />
            </span>
            <span>
              Refund <Money value={c.refund} />
            </span>
            <span>
              Fee <Money value={c.fee} />
            </span>
            <span>
              Net <Money value={c.net} strong />
            </span>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Revenue Category" required>
              <Select value={chosen} onChange={setCategoryId} options={revenueCats.map((x) => ({ value: x.id, label: x.name }))} placeholder={cats.isLoading ? 'Loading…' : 'Choose a category'} />
            </Field>
            <Field label="Recognition Date">
              <DateInput value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-[12px] font-[550] text-fg">Revenue Attribution</legend>
            {rows.length === 0 ? <p className="text-[13px] text-fg-2">No attribution. Revenue-share rules will not use this revenue.</p> : null}
            {rows.map((r, i) => (
              <div key={r.key} className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <MemberSelect aria-label={`Member ${i + 1}`} value={r.membershipId} onChange={(v) => setRows(rows.map((x, j) => (j === i ? { ...x, membershipId: v } : x)))} />
                </div>
                <div className="relative w-full sm:w-[110px]">
                  <Input aria-label={`Share ${i + 1}`} inputMode="decimal" className="pr-8 text-right font-mono" value={r.sharePercent} onChange={(e) => decimalOk(e.target.value) && setRows(rows.map((x, j) => (j === i ? { ...x, sharePercent: e.target.value } : x)))} />
                  <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[12px] text-fg-2">%</span>
                </div>
                <Button size="sm" variant="ghost" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                  Remove
                </Button>
              </div>
            ))}
            <div className="flex items-center justify-between">
              <Button size="sm" onClick={() => setRows([...rows, { key: rowKey(), membershipId: null, sharePercent: rows.length ? '' : '100' }])}>
                Add Member
              </Button>
              {rows.length ? <span className={attrOk ? 'text-[12px] text-fg-2' : 'text-[12px] text-warning'}>Total {total}% of 100%</span> : null}
            </div>
          </fieldset>
          <Field label="Note">
            <Textarea value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} className="min-h-[64px]" />
          </Field>
        </div>
      </Dialog>
      <ConflictDialog {...edit.conflictDialog} />
    </>
  );
};
