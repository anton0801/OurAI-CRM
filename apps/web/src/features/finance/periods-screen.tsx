'use client';
import { LockSimple } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { financeEndpoints as F } from '@castlane/api-contracts';
import { Banner, Button, DataTable, DateInput, Dialog, EmptyState, Field, PageHeader, Skeleton, StatusBadge, Textarea, formatDate, formatDateTime, type Column } from '@castlane/ui';
import { QueryState } from '@/components/common/query-state';
import { useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useCan, useWorkspace } from '@/lib/workspace-context';
import { FinanceNav, ReasonDialog, apiMessage, errorDetails, monthPeriod, useFinanceParams, useGuardedAction, useFinanceMutation } from './common';

type Period = { periodStart: string; periodEnd: string };
type Issue = { kind: 'unreviewed_entries' | 'unmatched_settlements' | 'unallocated_costs' | 'compensation_drafts' | 'missing_fx'; label: string; count: number };

/**
 * Close Period: the preview lists unresolved items; each kind must be resolved or acknowledged
 * with a note that is stored with the lock. Posting into a closed period is blocked afterwards.
 */
export const ClosePeriodDialog = ({ open, onOpenChange, period, editable }: { open: boolean; onOpenChange: (o: boolean) => void; period: Period; editable?: boolean }) => {
  const params = useFinanceParams();
  const [range, setRange] = useState(period);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setRange(period);
      setNotes({});
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const valid = !!range.periodStart && !!range.periodEnd && range.periodStart <= range.periodEnd;
  const preview = useApiQuery(F.periodsClosePreview, { params, query: range }, { enabled: open && valid });
  const close = useFinanceMutation(F.periodsClose, { invalidate: ['finance.'], successMessage: 'Period closed', silentErrors: true });
  const issues = (preview.data?.issues ?? []) as Issue[];
  const missingNote = issues.some((i) => (notes[i.kind] ?? '').trim().length < 3);
  const submit = async () => {
    setError(null);
    try {
      await close.run({ params, body: { ...range, unresolvedAcknowledgements: issues.map((i) => ({ kind: i.kind, note: (notes[i.kind] ?? '').trim() })) } });
      onOpenChange(false);
    } catch (e) {
      setError(apiMessage(e));
      const d = errorDetails(e);
      if (d?.reason === 'unresolved_items') void preview.refetch();
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Close Period"
      description="After closing, posting into this period is blocked until an audited reopen."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)} disabled={close.isPending}>
            Cancel
          </Button>
          <Button variant="primary" loading={close.isPending} disabled={!valid || preview.isLoading || !!preview.data?.overlapsLock || missingNote} onClick={() => void submit()}>
            Close Period
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Period start" required>
            <DateInput value={range.periodStart} disabled={!editable} onChange={(e) => setRange({ ...range, periodStart: e.target.value })} />
          </Field>
          <Field label="Period end" required error={valid ? undefined : 'Choose an end on or after the start.'}>
            <DateInput value={range.periodEnd} disabled={!editable} onChange={(e) => setRange({ ...range, periodEnd: e.target.value })} />
          </Field>
        </div>
        {preview.isLoading ? (
          <div className="flex flex-col gap-2" role="status" aria-label="Checking the period">
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : preview.error ? (
          <Banner tone="danger">{apiMessage(preview.error)}</Banner>
        ) : preview.data ? (
          preview.data.overlapsLock ? (
            <Banner tone="warning">This period overlaps a closed period. Choose dates outside it, or reopen that period first.</Banner>
          ) : issues.length === 0 ? (
            <Banner tone="success">No unresolved items in this period.</Banner>
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-[14px] text-fg">Resolve these items first, or acknowledge each one with a note that is kept with the closed period.</p>
              {issues.map((i) => (
                <Field key={i.kind} label={`${label('periodIssue', i.kind)}: ${i.count}`} required helper="Explain why the period can close with these open.">
                  <Textarea value={notes[i.kind] ?? ''} maxLength={500} onChange={(e) => setNotes({ ...notes, [i.kind]: e.target.value })} className="min-h-[64px]" />
                </Field>
              ))}
            </div>
          )
        ) : null}
      </div>
    </Dialog>
  );
};

type Lock = { id: string; periodStart: string; periodEnd: string; state: 'locked' | 'reopened'; lockedAt: string; lockedBy: { displayName: string } | null; unresolvedItems: { kind: string; count: number; note?: string }[]; reopenedAt: string | null; reopenedBy: { displayName: string } | null; reopenReason: string | null; rowVersion: number };

/** Closed periods and audited reopening. */
export const PeriodsScreen = () => {
  const can = useCan();
  const { user } = useWorkspace();
  const params = useFinanceParams();
  const q = useApiQuery(F.periodsList, { params });
  const [closeOpen, setCloseOpen] = useState(false);
  const [reopen, setReopen] = useState<Lock | null>(null);
  const [reopenError, setReopenError] = useState<string | null>(null);
  const reopenM = useFinanceMutation(F.periodsReopen, { invalidate: ['finance.'], successMessage: 'Period reopened', silentErrors: true });
  const guard = useGuardedAction();
  const last = new Date();
  last.setUTCMonth(last.getUTCMonth() - 1);
  const defaultPeriod = monthPeriod(last.toISOString().slice(0, 7));
  const manage = can('finance.close-period');
  const columns: Column<Lock>[] = [
    { key: 'period', header: 'Period', sticky: true, minWidth: 200, cell: (l) => `${formatDate(l.periodStart)} – ${formatDate(l.periodEnd)}` },
    { key: 'state', header: 'Status', minWidth: 110, cell: (l) => <StatusBadge status={l.state === 'locked' ? 'confirmed' : 'reopened'} label={l.state === 'locked' ? 'Closed' : 'Reopened'} /> },
    { key: 'locked', header: 'Closed', minWidth: 200, cell: (l) => `${formatDateTime(l.lockedAt, user.timezone)}${l.lockedBy ? ` · ${l.lockedBy.displayName}` : ''}` },
    {
      key: 'items',
      header: 'Acknowledged Items',
      minWidth: 240,
      cell: (l) =>
        l.unresolvedItems.length === 0 ? (
          <span className="text-fg-muted">None</span>
        ) : (
          <ul className="flex flex-col gap-0.5 text-[12px]">
            {l.unresolvedItems.map((i) => (
              <li key={i.kind}>
                {label('periodIssue', i.kind)} ({i.count}){i.note ? `: ${i.note}` : ''}
              </li>
            ))}
          </ul>
        ),
    },
    {
      key: 'reopen',
      header: 'Reopened',
      minWidth: 220,
      cell: (l) => (l.reopenedAt ? `${formatDateTime(l.reopenedAt, user.timezone)} · ${l.reopenReason ?? ''}` : <span className="text-fg-muted">—</span>),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      headerLabel: 'Actions',
      minWidth: 110,
      hidden: !manage,
      cell: (l) =>
        l.state === 'locked' ? (
          <Button size="sm" onClick={() => { setReopenError(null); setReopen(l); }}>
            Reopen
          </Button>
        ) : null,
    },
  ];
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Periods"
        description="Closed periods block posting and reversals dated inside them. Reopening is audited and marks reports as stale."
        actions={manage ? <Button variant="primary" icon={<LockSimple size={14} />} onClick={() => setCloseOpen(true)}>Close Period</Button> : undefined}
      />
      <FinanceNav />
      <QueryState query={q}>
        {q.data && q.data.length === 0 ? (
          <EmptyState icon={<LockSimple size={28} />} title="No closed periods" description="Close a period after reviewing its entries, settlements and compensation." />
        ) : (
          <DataTable caption="Closed periods" rows={(q.data ?? []) as Lock[]} columns={columns} getRowId={(l) => l.id} density={user.density} />
        )}
      </QueryState>
      {manage ? <ClosePeriodDialog open={closeOpen} onOpenChange={setCloseOpen} period={defaultPeriod} editable /> : null}
      <ReasonDialog
        open={!!reopen}
        onOpenChange={(o) => !o && setReopen(null)}
        title="Reopen Period"
        body={reopen ? `Reopen ${formatDate(reopen.periodStart)} – ${formatDate(reopen.periodEnd)}? Posting into it becomes possible again and reports for it are marked stale.` : ''}
        confirmLabel="Reopen Period"
        destructive
        loading={reopenM.isPending}
        error={reopenError}
        onConfirm={(reason) =>
          void guard.act(
            async () => {
              await reopenM.run({ params, body: { periodId: reopen!.id, reason } });
              setReopen(null);
            },
            (e) => setReopenError(apiMessage(e)),
          )
        }
      />
      {guard.dialog}
    </div>
  );
};
