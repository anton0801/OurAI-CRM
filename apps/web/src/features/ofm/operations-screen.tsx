'use client';
import { ListChecks, Plus, Receipt, Trash } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { ofmEndpoints as E, type OfmOperationSummary, type OfmSaleCandidate } from '@castlane/api-contracts';
import { OPERATION_STATUSES, OPERATION_TYPES, SALE_CANDIDATE_STATES } from '@castlane/domain';
import {
  AmountInput,
  Badge,
  Banner,
  Button,
  DataTable,
  DescriptionList,
  Dialog,
  Drawer,
  EmptyState,
  Field,
  IconButton,
  Input,
  MultiSelect,
  NoResults,
  PageHeader,
  Select,
  StatusBadge,
  Switch,
  Tabs,
  Textarea,
  Toolbar,
  formatDateTime,
  formatMoney,
  formatPercent,
  type Column,
} from '@castlane/ui';
import { MemberSelect } from '@/components/common/pickers';
import { ConflictDialog } from '@/components/common/conflict';
import { QueryState } from '@/components/common/query-state';
import { useDebounced } from '@/components/common/use-debounced';
import { changedFields, pickChanged, useEditBase } from '@/lib/edit-base';
import { useApiInfinite, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';
import { AccountChip, MemberChip, OfmNav, errorMessage, useOfmMutation } from './common';
import { ContactRefText, OperationDetailDrawer, OperationDrawer, SaleCandidateDrawer } from './operation-dialogs';
import { OfmAccountSelect, OfmModelSelect } from './pickers';

type Keys = 'tab' | 'status' | 'type' | 'projectId' | 'accountId' | 'owner' | 'due' | 'q' | 'archived' | 'sort' | 'saleState' | 'open' | 'create' | 'sale' | 'register';

/** S47 Operations Queue: requests, follow-ups and operational errands, plus registered sale candidates. */
export const OperationsScreen = () => {
  const can = useCan();
  const wsPath = useWsPath();
  const { state, set } = useUrlState<Keys>({ tab: 'operations' });
  const showOps = can('operations.read');
  const showSales = can(['sale-candidates.write', 'sale-candidates.review', 'finance.read']);
  const tab = state.tab === 'sales' || !showOps ? 'sales' : 'operations';
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Operations Queue"
        crumbs={[{ label: 'OFM', href: wsPath('/ofm') }, { label: 'Operations' }]}
        description="Requests, follow-ups and checks. Completing an operation never means a payment happened; sales are verified by Finance."
        actions={
          <>
            {tab === 'operations' && can('operations.write') ? (
              <Button variant="primary" icon={<Plus size={14} />} onClick={() => set({ create: '1' })}>
                Create
              </Button>
            ) : null}
            {can('sale-candidates.write') ? (
              <Button icon={<Receipt size={14} />} onClick={() => set({ register: '1' })}>
                Register Sale Candidate
              </Button>
            ) : null}
          </>
        }
      />
      <OfmNav />
      <Tabs
        label="Queue"
        value={tab}
        onValueChange={(v) => set({ tab: v, open: null, sale: null })}
        items={[
          { value: 'operations', label: 'Operations', hidden: !showOps },
          { value: 'sales', label: 'Sale Candidates', hidden: !showSales },
        ]}
      />
      {tab === 'operations' ? <OperationsTab /> : <SalesTab />}
      {state.create === '1' ? <OperationDrawer onClose={(id) => set({ create: null, open: id ?? null })} /> : null}
      {state.register === '1' ? <SaleCandidateDrawer onClose={() => set({ register: null })} /> : null}
    </div>
  );
};

const OperationsTab = () => {
  const { workspace, user } = useWorkspace();
  const { state, set, list } = useUrlState<Keys>({ tab: 'operations', status: 'open,in_progress,waiting', sort: 'dueAt' });
  const [q, setQ] = useState(state.q ?? '');
  const dq = useDebounced(q, 300);
  const statuses = (state.status === 'all' ? [] : list('status')) as OfmOperationSummary['status'][];
  const types = list('type') as OfmOperationSummary['type'][];
  const sort = (['dueAt', 'updatedAt', 'priority', 'createdAt'].includes(state.sort ?? '') ? state.sort : 'dueAt') as 'dueAt' | 'updatedAt' | 'priority' | 'createdAt';
  const [saleFor, setSaleFor] = useState<{ accountId: string; operationId: string } | null>(null);
  const data = useApiInfinite(E.listOperations, {
    params: { workspaceId: workspace.id },
    query: {
      status: statuses.length ? statuses : undefined,
      type: types.length ? types : undefined,
      projectId: state.projectId,
      accountId: state.accountId,
      ownerMembershipId: state.owner,
      due: state.due as 'overdue' | 'today' | 'week' | undefined,
      q: dq.trim() || undefined,
      includeArchived: state.archived === '1' ? true : undefined,
      sort,
      direction: sort === 'dueAt' ? 'asc' : 'desc',
    },
  });
  const filtered = !!(types.length || state.projectId || state.accountId || state.owner || state.due || dq.trim() || state.archived || state.status !== 'open,in_progress,waiting');
  useEffect(() => {
    if ((state.q ?? '') !== dq.trim()) set({ q: dq.trim() || null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dq]);
  const columns: Column<OfmOperationSummary>[] = [
    { key: 'title', header: 'Title', sticky: true, minWidth: 220, cell: (o) => <span className="font-medium">{o.title}</span> },
    { key: 'type', header: 'Type', minWidth: 140, cell: (o) => label('operationType', o.type) },
    { key: 'account', header: 'Account', minWidth: 170, cell: (o) => <AccountChip account={o.account} /> },
    { key: 'contact', header: 'Contact', minWidth: 140, cell: (o) => <ContactRefText contact={o.contact} /> },
    { key: 'owner', header: 'Owner', minWidth: 170, cell: (o) => <MemberChip member={o.owner} /> },
    { key: 'due', header: 'Due', minWidth: 150, cell: (o) => (o.dueAt ? <span className={o.overdue ? 'text-danger' : undefined}>{formatDateTime(o.dueAt, user.timezone)}</span> : '—') },
    { key: 'priority', header: 'Priority', minWidth: 100, cell: (o) => <Badge tone={o.priority === 'urgent' ? 'danger' : o.priority === 'high' ? 'warning' : 'neutral'}>{label('priority', o.priority)}</Badge> },
    { key: 'status', header: 'Status', minWidth: 130, cell: (o) => <StatusBadge status={o.status === 'in_progress' ? 'active' : o.status} label={label('operationStatus', o.status)} /> },
    { key: 'linked', header: 'Linked', minWidth: 150, cell: (o) => [o.shift ? 'Shift' : null, o.task ? 'Task' : null, o.contentItemId ? 'Content' : null].filter(Boolean).join(' · ') || '—' },
    { key: 'deliverable', header: 'Promised Deliverable', minWidth: 180, cell: (o) => o.promisedDeliverable ?? '—' },
    { key: 'outcome', header: 'Outcome', minWidth: 180, cell: (o) => o.outcome ?? o.cancelReason ?? '—' },
  ];
  return (
    <>
      <Toolbar>
        <div className="w-full sm:w-[220px]">
          <Input type="search" aria-label="Search operations" placeholder="Search title" value={q} onChange={(e) => setQ(e.target.value)} maxLength={120} />
        </div>
        <div className="w-full sm:w-[220px]">
          <MultiSelect aria-label="Status" placeholder="Any status" value={statuses} onChange={(v) => set({ status: v.join(',') || 'all' })} options={OPERATION_STATUSES.map((s) => ({ value: s, label: label('operationStatus', s) }))} />
        </div>
        <div className="w-full sm:w-[200px]">
          <MultiSelect aria-label="Type" placeholder="Any type" value={types} onChange={(v) => set({ type: v.join(',') || null })} options={OPERATION_TYPES.map((t) => ({ value: t, label: label('operationType', t) }))} />
        </div>
        <div className="w-full sm:w-[180px]">
          <OfmModelSelect aria-label="Model" placeholder="All models" value={state.projectId} onChange={(v) => set({ projectId: v, accountId: null })} clearable />
        </div>
        <div className="w-full sm:w-[180px]">
          <OfmAccountSelect aria-label="Account" placeholder="All accounts" projectId={state.projectId} value={state.accountId} onChange={(v) => set({ accountId: v })} clearable />
        </div>
        <div className="w-full sm:w-[180px]">
          <MemberSelect aria-label="Owner" placeholder="Any owner" value={state.owner} onChange={(v) => set({ owner: v })} clearable />
        </div>
        <div className="w-full sm:w-[150px]">
          <Select
            aria-label="Due"
            placeholder="Any due date"
            clearable
            value={state.due ?? null}
            onChange={(v) => set({ due: v })}
            options={[
              { value: 'overdue', label: 'Overdue' },
              { value: 'today', label: 'Due today' },
              { value: 'week', label: 'Due this week' },
            ]}
          />
        </div>
        <div className="w-full sm:w-[160px]">
          <Select
            aria-label="Sort"
            value={sort}
            onChange={(v) => set({ sort: v })}
            options={[
              { value: 'dueAt', label: 'Due date' },
              { value: 'priority', label: 'Priority' },
              { value: 'updatedAt', label: 'Recently updated' },
              { value: 'createdAt', label: 'Newest' },
            ]}
          />
        </div>
        <Switch label="Include archived" checked={state.archived === '1'} onCheckedChange={(c) => set({ archived: c ? '1' : null })} />
      </Toolbar>
      <QueryState query={data}>
        {data.items.length === 0 && !data.isFetching ? (
          filtered ? (
            <NoResults
              onClear={() => {
                setQ('');
                set({ status: null, type: null, projectId: null, accountId: null, owner: null, due: null, q: null, archived: null });
              }}
            />
          ) : (
            <EmptyState icon={<ListChecks size={28} />} title="No open operations" description="Requests and follow-ups created from shifts and contacts appear here." />
          )
        ) : (
          <DataTable
            caption="Operations"
            rows={data.items}
            columns={columns}
            getRowId={(o) => o.id}
            density={user.density}
            onRowClick={(o) => set({ open: o.id })}
            selectedRowId={state.open ?? null}
            rowClassName={(o) => (o.overdue ? 'bg-danger-soft/40' : undefined)}
            hasMore={data.hasNextPage}
            loadingMore={data.isFetchingNextPage}
            onLoadMore={() => void data.fetchNextPage()}
          />
        )}
      </QueryState>
      {state.open ? <OperationDetailDrawer id={state.open} onClose={() => set({ open: null })} onRegisterSale={(op) => (set({ open: null }), setSaleFor({ accountId: op.account.id, operationId: op.id }))} /> : null}
      {saleFor ? <SaleCandidateDrawer preset={{ accountId: saleFor.accountId, operationId: saleFor.operationId }} onClose={() => setSaleFor(null)} /> : null}
    </>
  );
};

const SalesTab = () => {
  const { workspace, user } = useWorkspace();
  const { state, set, list } = useUrlState<Keys>({ tab: 'operations', saleState: 'pending' });
  const states = (state.saleState === 'all' ? [] : list('saleState')) as OfmSaleCandidate['state'][];
  const data = useApiInfinite(E.listSaleCandidates, {
    params: { workspaceId: workspace.id },
    query: { state: states.length ? states : undefined, projectId: state.projectId, accountId: state.accountId },
  });
  const filtered = !!(state.projectId || state.accountId || state.saleState !== 'pending');
  const columns: Column<OfmSaleCandidate>[] = [
    {
      key: 'source',
      header: 'Source Transaction',
      sticky: true,
      minWidth: 220,
      cell: (c) => (
        <span className="flex flex-col">
          <span className="font-mono text-[12px]">{c.sourceTransactionId}</span>
          <span className="text-[12px] text-fg-2">
            {c.sourceNamespace}
            {c.manualReference ? ' · manual reference' : ''}
          </span>
        </span>
      ),
    },
    { key: 'account', header: 'Account', minWidth: 170, cell: (c) => <AccountChip account={c.account} /> },
    { key: 'occurred', header: 'Occurred', minWidth: 150, cell: (c) => formatDateTime(c.occurredAt, user.timezone) },
    { key: 'amount', header: 'Amount', align: 'right', minWidth: 130, cell: (c) => (c.money ? formatMoney(c.money.net ?? c.money.gross, c.currency) : <span className="text-fg-muted">Hidden</span>) },
    {
      key: 'attr',
      header: 'Attribution',
      minWidth: 190,
      cell: (c) => (
        <Badge tone={c.attributionStatus === 'full' ? 'success' : c.attributionStatus === 'partial' ? 'info' : 'neutral'}>
          {label('attribution', c.attributionStatus)}
          {c.attributionStatus !== 'full' ? ` · ${formatPercent(c.unassignedPercent, 0)} unassigned` : ''}
        </Badge>
      ),
    },
    { key: 'contact', header: 'Contact', minWidth: 130, cell: (c) => <ContactRefText contact={c.contact} /> },
    { key: 'shift', header: 'Shift', minWidth: 150, cell: (c) => (c.shift ? formatDateTime(c.shift.scheduledStart, user.timezone) : '—') },
    { key: 'state', header: 'Status', minWidth: 170, cell: (c) => <StatusBadge status={c.state === 'verified' ? 'approved' : c.state === 'rejected' ? 'rejected' : 'pending'} label={label('saleState', c.state)} /> },
    { key: 'by', header: 'Registered By', minWidth: 160, cell: (c) => <MemberChip member={c.createdBy} /> },
  ];
  return (
    <>
      <Toolbar>
        <div className="w-full sm:w-[240px]">
          <MultiSelect aria-label="Status" placeholder="Any status" value={states} onChange={(v) => set({ saleState: v.join(',') || 'all' })} options={SALE_CANDIDATE_STATES.map((s) => ({ value: s, label: label('saleState', s) }))} />
        </div>
        <div className="w-full sm:w-[180px]">
          <OfmModelSelect aria-label="Model" placeholder="All models" value={state.projectId} onChange={(v) => set({ projectId: v, accountId: null })} clearable />
        </div>
        <div className="w-full sm:w-[180px]">
          <OfmAccountSelect aria-label="Account" placeholder="All accounts" projectId={state.projectId} value={state.accountId} onChange={(v) => set({ accountId: v })} clearable />
        </div>
      </Toolbar>
      <QueryState query={data}>
        {data.items.length === 0 && !data.isFetching ? (
          filtered ? (
            <NoResults onClear={() => set({ saleState: null, projectId: null, accountId: null })} />
          ) : (
            <EmptyState icon={<Receipt size={28} />} title="No sale candidates" description="Sales registered during shifts appear here until Finance verifies or rejects them." />
          )
        ) : (
          <DataTable
            caption="Sale candidates"
            rows={data.items}
            columns={columns}
            getRowId={(c) => c.id}
            density={user.density}
            onRowClick={(c) => set({ sale: c.id })}
            selectedRowId={state.sale ?? null}
            hasMore={data.hasNextPage}
            loadingMore={data.isFetchingNextPage}
            onLoadMore={() => void data.fetchNextPage()}
          />
        )}
      </QueryState>
      {state.sale ? <SaleCandidateDetailDrawer id={state.sale} onClose={() => set({ sale: null })} /> : null}
    </>
  );
};

const SaleCandidateDetailDrawer = ({ id, onClose }: { id: string; onClose: () => void }) => {
  const { workspace, user } = useWorkspace();
  const wsPath = useWsPath();
  const q = useApiQuery(E.getSaleCandidate, { params: { workspaceId: workspace.id, candidateId: id } });
  const [editing, setEditing] = useState(false);
  const c = q.data;
  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      title="Sale Candidate"
      width={760}
      footer={
        c && c.state === 'pending' && c.permissions.update ? (
          <Button variant="primary" onClick={() => setEditing(true)}>
            Edit
          </Button>
        ) : undefined
      }
    >
      <QueryState query={q}>
        {c ? (
          <div className="flex flex-col gap-5">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={c.state === 'verified' ? 'approved' : c.state === 'rejected' ? 'rejected' : 'pending'} label={label('saleState', c.state)} />
              <Badge tone={c.attributionStatus === 'full' ? 'success' : c.attributionStatus === 'partial' ? 'info' : 'neutral'}>{label('attribution', c.attributionStatus)}</Badge>
            </div>
            {c.state === 'pending' ? <Banner tone="info">Pending Verification: not revenue until Finance verifies it.</Banner> : null}
            {c.state === 'rejected' && c.reviewNote ? <Banner tone="warning">Rejected: {c.reviewNote}</Banner> : null}
            {c.duplicateWarning ? <Banner tone="warning">Finance flagged a possible duplicate of this transaction.</Banner> : null}
            <DescriptionList
              items={[
                { label: 'Source', value: c.sourceNamespace },
                { label: 'Source Transaction ID', value: <span className="font-mono text-[13px]">{c.sourceTransactionId}</span> },
                { label: 'Account', value: <AccountChip account={c.account} /> },
                { label: 'Model', value: c.project.name },
                { label: 'Occurred', value: formatDateTime(c.occurredAt, user.timezone) },
                { label: 'Contact', value: c.contact && !c.contact.restricted ? <a className="hover:underline" href={wsPath(`/ofm/contacts/${c.contact.id}`)}>{c.contact.alias}</a> : <ContactRefText contact={c.contact} /> },
                { label: 'Shift', value: c.shift ? <a className="hover:underline" href={wsPath(`/ofm/shifts/${c.shift.id}`)}>{`${formatDateTime(c.shift.scheduledStart, user.timezone)} · ${c.shift.member.displayName}`}</a> : null },
                { label: 'Gross', value: c.money?.gross ? formatMoney(c.money.gross, c.currency) : null, hidden: !c.money },
                { label: 'Refund', value: c.money?.refund ? formatMoney(c.money.refund, c.currency) : null, hidden: !c.money },
                { label: 'Fee', value: c.money?.fee ? formatMoney(c.money.fee, c.currency) : null, hidden: !c.money },
                { label: 'Net', value: c.money?.net ? formatMoney(c.money.net, c.currency) : null, hidden: !c.money },
                { label: 'Evidence', value: c.evidenceAssetIds.length ? `${c.evidenceAssetIds.length} asset(s)` : null },
                { label: 'Source Note', value: c.sourceNote },
                { label: 'Registered', value: `${formatDateTime(c.createdAt, user.timezone)}${c.createdBy ? ` by ${c.createdBy.displayName}` : ''}` },
                { label: 'Reviewed', value: c.reviewedAt ? `${formatDateTime(c.reviewedAt, user.timezone)}${c.reviewedBy ? ` by ${c.reviewedBy.displayName}` : ''}` : null, hidden: !c.reviewedAt },
                { label: 'Financial Entry', value: c.financialEntryId ? <a className="hover:underline" href={wsPath(`/finance/entries/${c.financialEntryId}`)}>Open entry</a> : null, hidden: !c.financialEntryId },
              ]}
            />
            <section>
              <h3 className="mb-1 text-[14px] font-semibold text-fg">Claimed Attribution</h3>
              {c.claimedAllocations.length ? (
                <ul className="flex flex-col gap-1 text-[13px]">
                  {c.claimedAllocations.map((a) => (
                    <li key={a.member.membershipId} className="flex items-center justify-between gap-2">
                      <MemberChip member={a.member} />
                      <span className="font-mono tabular-nums">{formatPercent(a.sharePercent, 2)}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              <p className="mt-1 text-[12px] text-fg-2">Unassigned: {formatPercent(c.unassignedPercent, 2)}. Attribution is never inferred from shift timing.</p>
            </section>
          </div>
        ) : null}
      </QueryState>
      {c && editing ? <EditSaleDialog c={c} onClose={() => setEditing(false)} /> : null}
    </Drawer>
  );
};

const EditSaleDialog = ({ c, onClose }: { c: OfmSaleCandidate; onClose: () => void }) => {
  const { workspace } = useWorkspace();
  const moneyOf = (x: OfmSaleCandidate) => ({ gross: x.money?.gross ?? '', refund: x.money?.refund ?? '', fee: x.money?.fee ?? '', net: x.money?.net ?? '' });
  const allocOf = (x: OfmSaleCandidate) => x.claimedAllocations.map((a) => ({ membershipId: a.member.membershipId as string, sharePercent: a.sharePercent }));
  const [money, setMoney] = useState(moneyOf(c));
  const [note, setNote] = useState(c.sourceNote ?? '');
  const [alloc, setAlloc] = useState(allocOf(c));
  const [error, setError] = useState<string | null>(null);
  // `c` refreshes live; edits apply to the candidate as the dialog opened, changed fields only (T162).
  const edit = useEditBase(c, {
    onReload: (x) => {
      setMoney(moneyOf(x));
      setNote(x.sourceNote ?? '');
      setAlloc(allocOf(x));
    },
  });
  const m = useOfmMutation(E.updateSaleCandidate, { successMessage: 'Sale candidate updated', also: ['finance.'] });
  const total = alloc.reduce((s, a) => s + (Number(a.sharePercent) || 0), 0);
  const amountOk = (v: string) => !v || /^-?\d{1,15}(\.\d{1,6})?$/.test(v);
  const valid = Object.values(money).every(amountOk) && total <= 100 && alloc.every((a) => a.membershipId && /^\d{1,3}(\.\d{1,2})?$/.test(a.sharePercent));
  return (
    <>
      <Dialog
        open
        onOpenChange={(o) => !o && onClose()}
        title="Edit sale candidate"
        description="Source transaction IDs cannot change once registered."
        dirty
        footer={
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!valid}
              loading={m.isPending}
              onClick={async () => {
                setError(null);
                try {
                  const s = edit.start ?? c;
                  const moneyBody = (x: typeof money) => (s.money ? { gross: x.gross || null, refund: x.refund || null, fee: x.fee || null, net: x.net || null } : {});
                  const body = { ...moneyBody(money), sourceNote: note.trim() || null, claimedAllocations: alloc };
                  const before = { ...moneyBody(moneyOf(s)), sourceNote: s.sourceNote?.trim() || null, claimedAllocations: allocOf(s) };
                  await m.run({ params: { workspaceId: workspace.id, candidateId: c.id }, body: pickChanged(body, changedFields(before, body)) }, { ifMatch: edit.version });
                  onClose();
                } catch (e) {
                  if (!edit.catchConflict(e)) setError(errorMessage(e));
                }
              }}
            >
              Save Changes
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {error ? <Banner tone="danger">{error}</Banner> : null}
          {c.money ? (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              {(['gross', 'refund', 'fee', 'net'] as const).map((k) => (
                <Field key={k} label={k[0]!.toUpperCase() + k.slice(1)} error={amountOk(money[k]) ? undefined : 'Decimal number'}>
                  <AmountInput currency={c.currency} value={money[k]} onChange={(e) => setMoney({ ...money, [k]: e.target.value.trim() })} />
                </Field>
              ))}
            </div>
          ) : null}
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-[13px] font-[550] text-fg">Claimed Attribution</legend>
            {alloc.map((a, i) => (
              <div key={i} className="grid grid-cols-[1fr_110px_auto] items-start gap-2">
                <MemberSelect aria-label={`Member ${i + 1}`} value={a.membershipId} onChange={(v) => setAlloc(alloc.map((x, n) => (n === i ? { ...x, membershipId: v ?? '' } : x)))} />
                <Input aria-label={`Share ${i + 1} (percent)`} inputMode="decimal" value={a.sharePercent} onChange={(e) => setAlloc(alloc.map((x, n) => (n === i ? { ...x, sharePercent: e.target.value.trim() } : x)))} />
                <IconButton label="Remove claim" icon={<Trash size={16} />} onClick={() => setAlloc(alloc.filter((_, n) => n !== i))} />
              </div>
            ))}
            <p className={total > 100 ? 'text-[12px] text-danger' : 'text-[12px] text-fg-2'}>Claimed {total.toFixed(2)} % · Unassigned {Math.max(0, 100 - total).toFixed(2)} %</p>
            {alloc.length < 10 ? (
              <div>
                <Button size="sm" icon={<Plus size={14} />} onClick={() => setAlloc([...alloc, { membershipId: '', sharePercent: '' }])}>
                  Add Claim
                </Button>
              </div>
            ) : null}
          </fieldset>
          <Field label="Source Note" helper="No card numbers or payment credentials.">
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
          </Field>
        </div>
      </Dialog>
      <ConflictDialog {...edit.conflictDialog} />
    </>
  );
};
