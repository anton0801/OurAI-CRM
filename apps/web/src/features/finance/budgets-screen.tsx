'use client';
import { ChartPieSlice, Plus, Trash } from '@phosphor-icons/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { financeEndpoints as F, type BudgetDetail, type BudgetRow, type CommitmentView } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { COMMITMENT_STATES } from '@castlane/domain';
import {
  AmountInput,
  Badge,
  Banner,
  Button,
  DataTable,
  DateInput,
  DescriptionList,
  Dialog,
  Drawer,
  EmptyState,
  Field,
  IconButton,
  Input,
  KpiStrip,
  MultiSelect,
  NoResults,
  PageHeader,
  Panel,
  RadioGroup,
  Select,
  StatusBadge,
  Switch,
  TabPanel,
  Tabs,
  Textarea,
  Toolbar,
  formatDate,
  formatDateTime,
  formatPercent,
  toast,
  type Column,
} from '@castlane/ui';
import { EntitySelect } from '@/components/common/entity-select';
import { ConflictDialog } from '@/components/common/conflict';
import { DirectionSelect, MemberSelect } from '@/components/common/pickers';
import { QueryState } from '@/components/common/query-state';
import { useDebounced } from '@/components/common/use-debounced';
import { useApiInfinite, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';
import { rowKey } from './allocation-editor';
import { CurrencySelect, FinanceNav, Money, ReasonDialog, apiMessage, decimalOk, isConflict, useFinanceParams, useGuardedAction, useFinanceMutation } from './common';

type Keys = 'tab' | 'q' | 'scopeType' | 'projectId' | 'archived' | 'open' | 'create' | 'cstate' | 'commitment' | 'newCommitment';
const BUDGET_CLASSES = ['operating_expense', 'compensation_expense', 'fee'];
const SCOPES = ['workspace', 'direction', 'project', 'campaign'] as const;
type Scope = (typeof SCOPES)[number];

const fieldErrorsOf = (e: unknown) => (isApiError(e) ? Object.fromEntries(e.fieldErrors.map((x) => [x.field.replace(/^body\./, ''), x.message])) : {});

/** Budget figures as a compact cell: remaining, and consumption when defined. */
const Consumed = ({ b }: { b: BudgetRow }) =>
  b.figures ? (
    <span className="flex flex-col items-end">
      <Money value={b.figures.remaining} strong />
      <span className={`text-[11px] ${b.figures.consumedPercent !== null && Number(b.figures.consumedPercent) > 100 ? 'text-danger' : 'text-fg-2'}`}>
        {b.figures.consumedPercent === null ? 'No approved plan' : `${formatPercent(b.figures.consumedPercent)} consumed`}
      </span>
    </span>
  ) : (
    <span className="text-fg-muted">—</span>
  );

/** S57 Budgets and commitments. Commitments already converted to actual costs are never counted twice. */
export const BudgetsScreen = () => {
  const can = useCan();
  const { state, set } = useUrlState<Keys>({ tab: 'budgets' });
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Budgets"
        description="Plans by scope and period, compared with posted costs and open commitments. Alerts inform; they never block recording a real cost."
        actions={
          can('budgets.write') ? (
            state.tab === 'commitments' ? (
              <Button variant="primary" icon={<Plus size={14} weight="bold" />} onClick={() => set({ newCommitment: '1' })}>
                New Commitment
              </Button>
            ) : (
              <Button variant="primary" icon={<Plus size={14} weight="bold" />} onClick={() => set({ create: '1' })}>
                New Budget
              </Button>
            )
          ) : undefined
        }
      />
      <FinanceNav />
      <Tabs
        label="Budgets and commitments"
        value={state.tab === 'commitments' ? 'commitments' : 'budgets'}
        onValueChange={(v) => set({ tab: v, open: null, commitment: null })}
        items={[
          { value: 'budgets', label: 'Budgets' },
          { value: 'commitments', label: 'Commitments' },
        ]}
      >
        <TabPanel value="budgets">
          <BudgetsList />
        </TabPanel>
        <TabPanel value="commitments">
          <CommitmentsList />
        </TabPanel>
      </Tabs>
      <BudgetCreateDrawer open={state.create === '1'} onOpenChange={(o) => !o && set({ create: null })} onCreated={(id) => set({ create: null, open: id })} />
      {state.open ? <BudgetDrawer id={state.open} onClose={() => set({ open: null })} /> : null}
      <CommitmentDrawer open={state.newCommitment === '1'} onClose={() => set({ newCommitment: null })} onCreated={(id) => set({ newCommitment: null, commitment: id, tab: 'commitments' })} />
      {state.commitment ? <CommitmentDetailDrawer id={state.commitment} onClose={() => set({ commitment: null })} /> : null}
    </div>
  );
};

const BudgetsList = () => {
  const can = useCan();
  const { user } = useWorkspace();
  const params = useFinanceParams();
  const { state, set } = useUrlState<Keys>({ tab: 'budgets' });
  const [search, setSearch] = useState(state.q ?? '');
  const q = useDebounced(search, 250);
  const query = {
    q: q.length >= 2 ? q : undefined,
    scopeType: (SCOPES as readonly string[]).includes(state.scopeType ?? '') ? (state.scopeType as Scope) : undefined,
    projectId: state.projectId,
    includeArchived: state.archived === '1' ? true : undefined,
  };
  const data = useApiInfinite(F.budgetsList, { params, query });
  const filtered = !!(query.q || query.scopeType || query.projectId);
  const columns: Column<BudgetRow>[] = [
    {
      key: 'name',
      header: 'Budget',
      sticky: true,
      minWidth: 220,
      cell: (b) => (
        <span className="flex flex-col">
          <span className="font-medium text-fg">{b.name}</span>
          <span className="text-[12px] text-fg-2">
            {label('budgetScope', b.scopeType)}
            {b.scope ? ` · ${b.scope.name}` : ''}
          </span>
        </span>
      ),
    },
    { key: 'period', header: 'Period', minWidth: 190, cell: (b) => `${formatDate(b.periodStart)} – ${formatDate(b.periodEnd)}` },
    { key: 'owner', header: 'Owner', minWidth: 150, cell: (b) => b.owner.displayName },
    {
      key: 'version',
      header: 'Version',
      minWidth: 140,
      cell: (b) => (
        <span className="flex flex-wrap gap-1">
          {b.approvedVersionNo ? <Badge tone="success">v{b.approvedVersionNo} approved</Badge> : <Badge>Not approved</Badge>}
          {b.draftVersionNo && b.draftVersionNo !== b.approvedVersionNo ? <Badge tone="info">v{b.draftVersionNo} pending</Badge> : null}
        </span>
      ),
    },
    { key: 'planned', header: 'Planned', align: 'right', minWidth: 120, cell: (b) => (b.figures ? <Money value={b.figures.planned} /> : '—') },
    { key: 'actual', header: 'Actual', align: 'right', minWidth: 120, cell: (b) => (b.figures ? <Money value={b.figures.actual} /> : '—') },
    { key: 'committed', header: 'Committed', align: 'right', minWidth: 120, cell: (b) => (b.figures ? <Money value={b.figures.committed} /> : '—') },
    { key: 'remaining', header: 'Remaining', align: 'right', minWidth: 140, cell: (b) => <Consumed b={b} /> },
  ];
  return (
    <div className="flex flex-col gap-3">
      <Toolbar>
        <div className="w-full sm:w-[220px]">
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              set({ q: e.target.value || null });
            }}
            placeholder="Search budgets"
            aria-label="Search budgets"
          />
        </div>
        <div className="w-[160px]">
          <Select aria-label="Scope" placeholder="Scope" clearable value={query.scopeType ?? null} onChange={(v) => set({ scopeType: v })} options={SCOPES.map((s) => ({ value: s, label: label('budgetScope', s) }))} />
        </div>
        <div className="w-[200px]">
          <EntitySelect type="project" aria-label="Project" placeholder="Project" value={state.projectId} onChange={(v) => set({ projectId: v })} clearable />
        </div>
        <div className="px-1">
          <Switch label="Show archived" checked={state.archived === '1'} onCheckedChange={(v) => set({ archived: v ? '1' : null })} />
        </div>
      </Toolbar>
      <QueryState query={data}>
        {data.items.length === 0 && !data.isFetching ? (
          filtered ? (
            <NoResults onClear={() => { setSearch(''); set({ q: null, scopeType: null, projectId: null }); }} />
          ) : (
            <EmptyState
              icon={<ChartPieSlice size={28} />}
              title="No budgets yet"
              description="Create a budget for a project, campaign, direction or the whole workspace to compare plans with actual costs."
              action={can('budgets.write') ? <Button variant="primary" onClick={() => set({ create: '1' })}>New Budget</Button> : undefined}
            />
          )
        ) : (
          <DataTable
            caption="Budgets"
            rows={data.items}
            columns={columns}
            getRowId={(b) => b.id}
            density={user.density}
            onRowClick={(b) => set({ open: b.id }, { replace: false })}
            selectedRowId={state.open ?? null}
            hasMore={data.hasNextPage}
            loadingMore={data.isFetchingNextPage}
            onLoadMore={() => void data.fetchNextPage()}
          />
        )}
      </QueryState>
    </div>
  );
};

type LineRow = { key: string; categoryId: string | null; planned: string; note: string };

/** Planned amount per expense category (one line per category). */
const BudgetLinesEditor = ({ value, onChange, currency, errors }: { value: LineRow[]; onChange: (v: LineRow[]) => void; currency: string; errors: Record<string, string> }) => {
  const params = useFinanceParams();
  const cats = useApiQuery(F.categoriesList, { params, query: {} }, { staleTime: 60_000 });
  const options = (cats.data ?? []).filter((c) => BUDGET_CLASSES.includes(c.accountingClass)).map((c) => ({ value: c.id, label: c.name, description: label('accountingClass', c.accountingClass) }));
  const set = (i: number, p: Partial<LineRow>) => onChange(value.map((l, j) => (j === i ? { ...l, ...p } : l)));
  return (
    <div className="flex flex-col gap-3">
      {errors.lines ? <p className="text-[12px] text-danger">{errors.lines}</p> : null}
      {value.map((l, i) => (
        <div key={l.key} className="grid grid-cols-1 gap-2 rounded-[8px] border border-line p-2 sm:grid-cols-[minmax(0,1fr)_160px_40px] sm:border-0 sm:p-0">
          <Field label="Category" hideLabel={i > 0} required error={errors[`lines.${i}.categoryId`]}>
            <Select value={l.categoryId} onChange={(v) => set(i, { categoryId: v })} options={options} searchable placeholder={cats.isLoading ? 'Loading…' : 'Choose a category'} />
          </Field>
          <Field label="Planned" hideLabel={i > 0} required error={errors[`lines.${i}.planned`]}>
            <AmountInput currency={currency} value={l.planned} onChange={(e) => decimalOk(e.target.value) && set(i, { planned: e.target.value })} />
          </Field>
          <div className={i === 0 ? 'flex items-end' : 'flex items-start'}>
            <IconButton label={`Remove line ${i + 1}`} icon={<Trash size={14} />} onClick={() => onChange(value.filter((_, j) => j !== i))} />
          </div>
        </div>
      ))}
      <div>
        <Button size="sm" icon={<Plus size={12} />} onClick={() => onChange([...value, { key: rowKey(), categoryId: null, planned: '', note: '' }])} disabled={value.length >= 100}>
          Add Category
        </Button>
      </div>
    </div>
  );
};

const linesBody = (lines: LineRow[]) => lines.filter((l) => l.categoryId).map((l) => ({ categoryId: l.categoryId!, planned: l.planned.trim() || '0', note: l.note.trim() || null }));
const parseThresholds = (v: string) =>
  v
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);

type CreateForm = { name: string; scopeType: Scope; scopeId: string | null; periodStart: string; periodEnd: string; currency: string; ownerMembershipId: string | null; thresholds: string; lines: LineRow[] };

const BudgetCreateDrawer = ({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (id: string) => void }) => {
  const { workspace, membershipId } = useWorkspace();
  const params = useFinanceParams();
  const blank = (): CreateForm => {
    const now = new Date();
    const start = `${now.toISOString().slice(0, 7)}-01`;
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    return { name: '', scopeType: 'project', scopeId: null, periodStart: start, periodEnd: end, currency: workspace.baseCurrency, ownerMembershipId: membershipId, thresholds: '80, 100', lines: [{ key: rowKey(), categoryId: null, planned: '', note: '' }] };
  };
  const [f, setF] = useState<CreateForm>(blank);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (open) {
      setF(blank());
      setErrors({});
      setError(null);
      setDirty(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const create = useFinanceMutation(F.budgetsCreate, { invalidate: ['finance.'], silentErrors: true, successMessage: 'Budget created as a draft' });
  const patch = (p: Partial<CreateForm>) => {
    setF((x) => ({ ...x, ...p }));
    setDirty(true);
  };
  const submit = async () => {
    setError(null);
    const e: Record<string, string> = {};
    if (f.name.trim().length < 2) e.name = 'Use 2–120 characters.';
    if (f.scopeType !== 'workspace' && !f.scopeId) e.scopeId = 'Choose the scope record.';
    if (!f.periodStart || !f.periodEnd || f.periodEnd < f.periodStart) e.periodEnd = 'Choose an end on or after the start.';
    if (!f.ownerMembershipId) e.ownerMembershipId = 'Choose an owner.';
    setErrors(e);
    if (Object.keys(e).length) return;
    try {
      const r = await create.run({
        params,
        body: {
          name: f.name.trim(),
          scopeType: f.scopeType,
          scopeId: f.scopeType === 'workspace' ? null : f.scopeId,
          periodStart: f.periodStart,
          periodEnd: f.periodEnd,
          currency: f.currency,
          ownerMembershipId: f.ownerMembershipId!,
          alertThresholds: parseThresholds(f.thresholds),
          lines: linesBody(f.lines),
        },
      });
      onCreated(r.id);
    } catch (err) {
      setErrors(fieldErrorsOf(err));
      setError(apiMessage(err));
    }
  };
  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      dirty={dirty}
      width={760}
      title="New Budget"
      description="Saved as a draft version; approval makes it the current plan."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)} disabled={create.isPending}>
            Cancel
          </Button>
          <Button variant="primary" loading={create.isPending} onClick={() => void submit()}>
            Create Budget
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <Field label="Name" required error={errors.name}>
          <Input value={f.name} maxLength={120} onChange={(e) => patch({ name: e.target.value })} />
        </Field>
        <RadioGroup label="Scope" orientation="horizontal" value={f.scopeType} onValueChange={(v) => patch({ scopeType: v, scopeId: null })} options={SCOPES.map((s) => ({ value: s, label: label('budgetScope', s) }))} />
        {f.scopeType === 'project' ? (
          <Field label="Project" required error={errors.scopeId}>
            <EntitySelect type="project" value={f.scopeId} onChange={(v) => patch({ scopeId: v })} />
          </Field>
        ) : f.scopeType === 'campaign' ? (
          <Field label="Campaign" required error={errors.scopeId}>
            <EntitySelect type="campaign" value={f.scopeId} onChange={(v) => patch({ scopeId: v })} />
          </Field>
        ) : f.scopeType === 'direction' ? (
          <Field label="Direction" required error={errors.scopeId}>
            <DirectionSelect value={f.scopeId} onChange={(v) => patch({ scopeId: v })} />
          </Field>
        ) : null}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Period Start" required error={errors.periodStart}>
            <DateInput value={f.periodStart} onChange={(e) => patch({ periodStart: e.target.value })} />
          </Field>
          <Field label="Period End" required error={errors.periodEnd}>
            <DateInput value={f.periodEnd} onChange={(e) => patch({ periodEnd: e.target.value })} />
          </Field>
          <Field label="Currency" required error={errors.currency} helper="Actual costs in other currencies are listed separately.">
            <CurrencySelect value={f.currency} onChange={(v) => patch({ currency: v })} />
          </Field>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Owner" required error={errors.ownerMembershipId}>
            <MemberSelect value={f.ownerMembershipId} onChange={(v) => patch({ ownerMembershipId: v })} />
          </Field>
          <Field label="Alert Thresholds" error={errors.alertThresholds} helper="Percent of plan, e.g. 80, 100. The owner is notified once per threshold.">
            <Input value={f.thresholds} onChange={(e) => patch({ thresholds: e.target.value })} />
          </Field>
        </div>
        <Panel title="Planned Costs">
          <BudgetLinesEditor value={f.lines} onChange={(lines) => patch({ lines })} currency={f.currency} errors={errors} />
        </Panel>
      </div>
    </Drawer>
  );
};

type BudgetDialog = 'edit' | 'revise' | 'thresholds' | 'copy' | null;

const BudgetDrawer = ({ id, onClose }: { id: string; onClose: () => void }) => {
  const params = useFinanceParams();
  const q = useApiQuery(F.budgetsGet, { params: { ...params, budgetId: id } });
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} width={760} title={q.data?.name ?? 'Budget'} description={q.data ? `${label('budgetScope', q.data.scopeType)}${q.data.scope ? ` · ${q.data.scope.name}` : ''}` : undefined}>
      <QueryState query={q}>{q.data ? <BudgetBody b={q.data} refetch={() => void q.refetch()} /> : null}</QueryState>
    </Drawer>
  );
};

const BudgetBody = ({ b, refetch }: { b: BudgetDetail; refetch: () => void }) => {
  const wsPath = useWsPath();
  const { user } = useWorkspace();
  const params = useFinanceParams();
  const bp = { ...params, budgetId: b.id };
  const [dialog, setDialog] = useState<BudgetDialog>(null);
  const [resetAlert, setResetAlert] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const guard = useGuardedAction();
  const inv = { invalidate: ['finance.'], silentErrors: true };
  const submitM = useFinanceMutation(F.budgetsSubmit, { ...inv, successMessage: 'Version submitted for approval' });
  const approveM = useFinanceMutation(F.budgetsApprove, { ...inv, successMessage: 'Version approved' });
  const resetM = useFinanceMutation(F.budgetsResetAlert, { ...inv, successMessage: 'Alert reset' });
  const fail = (e: unknown) => (isConflict(e) ? setConflict(true) : setError(apiMessage(e)));
  const approved = b.versions.find((v) => v.versionNo === b.approvedVersionNo);
  const pending = b.versions.find((v) => v.state === 'draft' || v.state === 'submitted');
  const relatedHref = wsPath(`/finance?from=${b.periodStart}&to=${b.periodEnd}${b.scopeType === 'project' && b.scope ? `&projectId=${b.scope.id}` : ''}`);
  const figures = b.figures;
  return (
    <div className="flex flex-col gap-4">
      {error ? <Banner tone="danger">{error}</Banner> : null}
      {approved && pending ? <Banner tone="info">A newer version is awaiting review.</Banner> : null}
      {b.archivedAt ? <Banner tone="info">Archived records remain available in historical reports.</Banner> : null}
      <p className="text-[13px] text-fg-2">
        {formatDate(b.periodStart)} – {formatDate(b.periodEnd)} · {b.currency} · Owner {b.owner.displayName}
      </p>
      {figures ? (
        <KpiStrip
          items={[
            { label: 'Planned', value: <Money value={figures.planned} /> },
            { label: 'Actual', value: <Money value={figures.actual} />, href: relatedHref },
            { label: 'Committed', value: <Money value={figures.committed} />, hint: 'Open commitments not yet converted' },
            { label: 'Remaining', value: <Money value={figures.remaining} />, hint: figures.consumedPercent === null ? 'No approved plan' : `${formatPercent(figures.consumedPercent)} consumed` },
          ]}
        />
      ) : null}
      {b.excludedCurrencies.length ? (
        <Banner tone="warning">
          Costs in other currencies are not compared with this {b.currency} budget:{' '}
          {b.excludedCurrencies.map((m) => (
            <Money key={m.currency} value={m} className="ml-1" />
          ))}
        </Banner>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {pending && pending.state === 'draft' && b.permissions.submit ? (
          <Button onClick={() => void submitM.run({ params: bp, body: { versionId: pending.id } }, { ifMatch: b.rowVersion }).catch(fail)} loading={submitM.isPending}>
            Submit v{pending.versionNo}
          </Button>
        ) : null}
        {pending && b.permissions.approve ? (
          <Button variant="primary" loading={approveM.isPending} onClick={() => void guard.act(async () => { await approveM.run({ params: bp, body: { versionId: pending.id } }, { ifMatch: b.rowVersion }); }, fail)}>
            Approve Version
          </Button>
        ) : null}
        {pending && pending.state === 'draft' && b.permissions.update && !approved ? <Button onClick={() => setDialog('edit')}>Edit Lines</Button> : null}
        {approved && !pending && b.permissions.revise ? <Button onClick={() => setDialog('revise')}>Revise</Button> : null}
        {b.permissions.update ? <Button onClick={() => setDialog('thresholds')}>Set Alert Threshold</Button> : null}
        {b.permissions.update ? <Button onClick={() => setDialog('copy')}>Copy Budget</Button> : null}
        <Link href={relatedHref} className="inline-flex h-11 items-center px-2 text-[13px] font-semibold text-primary hover:underline md:h-9">
          Open Related Entries
        </Link>
      </div>
      {b.lineFigures.length ? (
        <Panel title="By Category" bodyClassName="p-0">
          <DataTable
            caption="Budget by category"
            rows={b.lineFigures}
            getRowId={(l) => l.category.id}
            columns={[
              { key: 'cat', header: 'Category', sticky: true, minWidth: 180, cell: (l) => l.category.name },
              { key: 'planned', header: 'Planned', align: 'right', minWidth: 120, cell: (l) => <Money value={l.figures.planned} /> },
              { key: 'actual', header: 'Actual', align: 'right', minWidth: 120, cell: (l) => <Money value={l.figures.actual} /> },
              { key: 'committed', header: 'Committed', align: 'right', minWidth: 120, cell: (l) => <Money value={l.figures.committed} /> },
              { key: 'remaining', header: 'Remaining', align: 'right', minWidth: 120, cell: (l) => <Money value={l.figures.remaining} strong /> },
            ]}
          />
        </Panel>
      ) : null}
      <Panel title="Alerts" description={b.alertThresholds.length ? `Thresholds: ${b.alertThresholds.map((t) => `${t}%`).join(', ')}` : 'No thresholds set'}>
        {b.alerts.length === 0 ? (
          <p className="text-[13px] text-fg-2">No threshold crossed.</p>
        ) : (
          <ul className="flex flex-col gap-2 text-[13px]">
            {b.alerts.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  {a.threshold}% crossed {formatDateTime(a.crossedAt, user.timezone)}
                  {a.resetAt ? ` · reset ${formatDateTime(a.resetAt, user.timezone)}` : ''}
                </span>
                {!a.resetAt && b.permissions.update ? (
                  <Button size="sm" variant="ghost" onClick={() => { setError(null); setResetAlert(a.id); }}>
                    Reset
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <Panel title="Versions">
        <ul className="flex flex-col divide-y divide-line">
          {b.versions.map((v) => (
            <li key={v.id} className="flex flex-col gap-1 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-2">
                  <span className="font-semibold">v{v.versionNo}</span>
                  <StatusBadge status={v.state} label={label('budgetVersionState', v.state)} />
                </span>
                <Money value={v.total} />
              </div>
              <span className="text-[12px] text-fg-2">
                Created {formatDateTime(v.createdAt, user.timezone)}
                {v.approvedAt ? ` · approved ${formatDateTime(v.approvedAt, user.timezone)}${v.approvedBy ? ` by ${v.approvedBy.displayName}` : ''}` : ''}
                {v.reason ? ` · ${v.reason}` : ''}
              </span>
            </li>
          ))}
        </ul>
      </Panel>
      {dialog === 'edit' || dialog === 'revise' ? (
        <LinesDialog b={b} revise={dialog === 'revise'} onClose={() => setDialog(null)} onConflict={() => { setDialog(null); setConflict(true); }} />
      ) : null}
      {dialog === 'thresholds' ? <ThresholdsDialog b={b} onClose={() => setDialog(null)} onConflict={() => { setDialog(null); setConflict(true); }} /> : null}
      {dialog === 'copy' ? <CopyDialog b={b} onClose={() => setDialog(null)} /> : null}
      <ReasonDialog
        open={!!resetAlert}
        onOpenChange={(o) => !o && setResetAlert(null)}
        title="Reset Alert"
        body="The threshold can notify again. Resetting is refused while spending is still above it."
        confirmLabel="Reset Alert"
        loading={resetM.isPending}
        error={error}
        onConfirm={(reason) =>
          void resetM
            .run({ params: { ...bp, alertId: resetAlert! }, body: { reason } })
            .then(() => setResetAlert(null))
            .catch(fail)
        }
      />
      <ConflictDialog open={conflict} onOpenChange={setConflict} onReload={() => { setConflict(false); refetch(); }} />
      {guard.dialog}
    </div>
  );
};

const LinesDialog = ({ b, revise, onClose, onConflict }: { b: BudgetDetail; revise: boolean; onClose: () => void; onConflict: () => void }) => {
  const params = useFinanceParams();
  const source = revise ? b.versions.find((v) => v.versionNo === b.approvedVersionNo) : b.versions.find((v) => v.state === 'draft');
  const [lines, setLines] = useState<LineRow[]>((source?.lines ?? []).map((l) => ({ key: rowKey(), categoryId: l.category.id, planned: l.planned.amount, note: l.note ?? '' })));
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const update = useFinanceMutation(F.budgetsUpdate, { invalidate: ['finance.'], silentErrors: true, successMessage: 'Draft version saved' });
  const reviseM = useFinanceMutation(F.budgetsRevise, { invalidate: ['finance.'], silentErrors: true, successMessage: 'New draft version created' });
  const save = async () => {
    setError(null);
    try {
      if (revise) await reviseM.run({ params: { ...params, budgetId: b.id }, body: { lines: linesBody(lines), reason: reason.trim() } }, { ifMatch: b.rowVersion });
      else await update.run({ params: { ...params, budgetId: b.id }, body: { lines: linesBody(lines) } }, { ifMatch: b.rowVersion });
      onClose();
    } catch (e) {
      if (isConflict(e)) return onConflict();
      setErrors(fieldErrorsOf(e));
      setError(apiMessage(e));
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="wide"
      title={revise ? 'Revise Budget' : 'Edit Draft Lines'}
      description={revise ? 'Creates a new draft version. The approved version and actual costs do not change until the new version is approved.' : undefined}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={update.isPending || reviseM.isPending} disabled={revise && reason.trim().length < 3} onClick={() => void save()}>
            {revise ? 'Create Version' : 'Save Lines'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <BudgetLinesEditor value={lines} onChange={setLines} currency={b.currency} errors={errors} />
        {revise ? (
          <Field label="Reason" required helper="At least 3 characters.">
            <Textarea value={reason} maxLength={2000} onChange={(e) => setReason(e.target.value)} className="min-h-[64px]" />
          </Field>
        ) : null}
      </div>
    </Dialog>
  );
};

const ThresholdsDialog = ({ b, onClose, onConflict }: { b: BudgetDetail; onClose: () => void; onConflict: () => void }) => {
  const params = useFinanceParams();
  const [value, setValue] = useState(b.alertThresholds.join(', '));
  const [owner, setOwner] = useState<string | null>(b.owner.membershipId);
  const [error, setError] = useState<string | null>(null);
  const m = useFinanceMutation(F.budgetsUpdate, { invalidate: ['finance.'], silentErrors: true, successMessage: 'Budget updated' });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="small"
      title="Set Alert Threshold"
      description="Alerts notify the owner once per threshold. They never block recording a real cost."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={m.isPending}
            onClick={() =>
              void m
                .run({ params: { ...params, budgetId: b.id }, body: { alertThresholds: parseThresholds(value), ownerMembershipId: owner ?? undefined } }, { ifMatch: b.rowVersion })
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
        <Field label="Thresholds" helper="Percent of plan, comma-separated, e.g. 50, 80, 100.">
          <Input value={value} onChange={(e) => setValue(e.target.value)} />
        </Field>
        <Field label="Owner">
          <MemberSelect value={owner} onChange={setOwner} />
        </Field>
      </div>
    </Dialog>
  );
};

const CopyDialog = ({ b, onClose }: { b: BudgetDetail; onClose: () => void }) => {
  const params = useFinanceParams();
  const { set } = useUrlState<Keys>();
  const nextStart = new Date(`${b.periodEnd}T00:00:00Z`);
  nextStart.setUTCDate(nextStart.getUTCDate() + 1);
  const ns = nextStart.toISOString().slice(0, 10);
  const ne = new Date(Date.UTC(nextStart.getUTCFullYear(), nextStart.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  const [name, setName] = useState(`${b.name} (copy)`);
  const [start, setStart] = useState(ns);
  const [end, setEnd] = useState(ne);
  const [carry, setCarry] = useState<'planned' | 'add_unused_remaining' | 'empty'>('planned');
  const [error, setError] = useState<string | null>(null);
  const m = useFinanceMutation(F.budgetsCopy, { invalidate: ['finance.'], silentErrors: true, successMessage: 'Budget copied as a draft' });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Copy Budget"
      description="Creates a draft for another period. Carry-over is explicit."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={m.isPending}
            disabled={name.trim().length < 2 || !start || !end || end < start}
            onClick={() =>
              void m
                .run({ params: { ...params, budgetId: b.id }, body: { name: name.trim(), periodStart: start, periodEnd: end, carryOver: carry } })
                .then((r) => {
                  onClose();
                  set({ open: r.id });
                })
                .catch((e) => setError(apiMessage(e)))
            }
          >
            Copy Budget
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <Field label="Name" required>
          <Input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Period Start" required>
            <DateInput value={start} onChange={(e) => setStart(e.target.value)} />
          </Field>
          <Field label="Period End" required>
            <DateInput value={end} onChange={(e) => setEnd(e.target.value)} />
          </Field>
        </div>
        <RadioGroup
          label="Carry-over"
          value={carry}
          onValueChange={setCarry}
          options={[
            { value: 'planned', label: 'Same planned amounts' },
            { value: 'add_unused_remaining', label: 'Planned plus unused remaining', description: 'Adds what was not spent or committed in this period' },
            { value: 'empty', label: 'Categories only, amounts empty' },
          ]}
        />
      </div>
    </Dialog>
  );
};

// ——— Commitments ———

const CommitmentsList = () => {
  const can = useCan();
  const { user } = useWorkspace();
  const params = useFinanceParams();
  const { state, set, list } = useUrlState<Keys>({ tab: 'budgets' });
  const query = { projectId: state.projectId, state: list('cstate') as (typeof COMMITMENT_STATES)[number][] };
  const data = useApiInfinite(F.commitmentsList, { params, query });
  const filtered = !!(query.projectId || query.state.length);
  const columns: Column<CommitmentView>[] = [
    {
      key: 'desc',
      header: 'Commitment',
      sticky: true,
      minWidth: 220,
      cell: (c) => (
        <span className="flex flex-col">
          <span className="font-medium text-fg">{c.description}</span>
          <span className="text-[12px] text-fg-2">
            {c.project.name} · {c.category.name}
          </span>
        </span>
      ),
    },
    { key: 'amount', header: 'Amount', align: 'right', minWidth: 120, cell: (c) => <Money value={c.amount} /> },
    { key: 'consumed', header: 'Converted to Actual', align: 'right', minWidth: 150, cell: (c) => <Money value={c.consumed} /> },
    { key: 'remaining', header: 'Committed', align: 'right', minWidth: 120, cell: (c) => <Money value={c.remaining} strong /> },
    { key: 'due', header: 'Due', minWidth: 110, cell: (c) => formatDate(c.dueDate) },
    { key: 'state', header: 'Status', minWidth: 150, cell: (c) => <StatusBadge status={c.state === 'consumed' ? 'completed' : c.state} label={label('commitmentState', c.state)} /> },
    { key: 'budget', header: 'Budget', minWidth: 150, cell: (c) => c.budget?.name ?? '—' },
  ];
  return (
    <div className="flex flex-col gap-3">
      <Toolbar>
        <div className="w-[220px]">
          <EntitySelect type="project" aria-label="Project" placeholder="Project" value={state.projectId} onChange={(v) => set({ projectId: v })} clearable />
        </div>
        <div className="w-[190px]">
          <MultiSelect aria-label="Status" placeholder="Status" value={list('cstate')} onChange={(v) => set({ cstate: v.join(',') || null })} options={COMMITMENT_STATES.map((s) => ({ value: s, label: label('commitmentState', s) }))} />
        </div>
      </Toolbar>
      <QueryState query={data}>
        {data.items.length === 0 && !data.isFetching ? (
          filtered ? (
            <NoResults onClear={() => set({ projectId: null, cstate: null })} />
          ) : (
            <EmptyState
              title="No commitments"
              description="Record costs you have agreed to but not yet received an invoice for. Converting them to an entry moves the amount from Committed to Actual."
              action={can('budgets.write') ? <Button variant="primary" onClick={() => set({ newCommitment: '1' })}>New Commitment</Button> : undefined}
            />
          )
        ) : (
          <DataTable
            caption="Commitments"
            rows={data.items}
            columns={columns}
            getRowId={(c) => c.id}
            density={user.density}
            onRowClick={(c) => set({ commitment: c.id }, { replace: false })}
            selectedRowId={state.commitment ?? null}
            hasMore={data.hasNextPage}
            loadingMore={data.isFetchingNextPage}
            onLoadMore={() => void data.fetchNextPage()}
          />
        )}
      </QueryState>
    </div>
  );
};

type CommitmentForm = { projectId: string | null; budgetId: string | null; categoryId: string | null; amount: string; currency: string; dueDate: string; counterparty: string; description: string };

const CommitmentDrawer = ({ open, onClose, onCreated, existing }: { open: boolean; onClose: () => void; onCreated?: (id: string) => void; existing?: CommitmentView }) => {
  const { workspace } = useWorkspace();
  const params = useFinanceParams();
  const cats = useApiQuery(F.categoriesList, { params, query: {} }, { staleTime: 60_000, enabled: open });
  const blank = (): CommitmentForm =>
    existing
      ? { projectId: existing.project.id, budgetId: existing.budget?.id ?? null, categoryId: existing.category.id, amount: existing.amount.amount, currency: existing.amount.currency, dueDate: existing.dueDate ?? '', counterparty: existing.counterparty ?? '', description: existing.description }
      : { projectId: null, budgetId: null, categoryId: null, amount: '', currency: workspace.baseCurrency, dueDate: '', counterparty: '', description: '' };
  const [f, setF] = useState<CommitmentForm>(blank);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  useEffect(() => {
    if (open) {
      setF(blank());
      setErrors({});
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const create = useFinanceMutation(F.commitmentsCreate, { invalidate: ['finance.'], silentErrors: true, successMessage: 'Commitment recorded' });
  const update = useFinanceMutation(F.commitmentsUpdate, { invalidate: ['finance.'], silentErrors: true, successMessage: 'Commitment updated' });
  const patch = (p: Partial<CommitmentForm>) => setF((x) => ({ ...x, ...p }));
  const submit = async () => {
    setError(null);
    const e: Record<string, string> = {};
    if (!f.projectId) e.projectId = 'Choose a project.';
    if (!f.categoryId) e.categoryId = 'Choose an expense category.';
    if (!/^\d+(\.\d+)?$/.test(f.amount.trim())) e.amount = 'Enter the committed amount.';
    if (f.description.trim().length < 3) e.description = 'Describe the commitment (at least 3 characters).';
    setErrors(e);
    if (Object.keys(e).length) return;
    const body = { projectId: f.projectId!, budgetId: f.budgetId, categoryId: f.categoryId!, amount: f.amount.trim(), currency: f.currency, dueDate: f.dueDate || null, counterparty: f.counterparty.trim() || null, description: f.description.trim() };
    try {
      if (existing) {
        await update.run({ params: { ...params, commitmentId: existing.id }, body }, { ifMatch: existing.rowVersion });
        onClose();
      } else {
        const r = await create.run({ params, body });
        onCreated?.(r.id);
      }
    } catch (err) {
      if (isConflict(err)) return setConflict(true);
      setErrors(fieldErrorsOf(err));
      setError(apiMessage(err));
    }
  };
  return (
    <Drawer
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={existing ? 'Edit Commitment' : 'New Commitment'}
      description="An agreed cost not yet invoiced"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={create.isPending || update.isPending} onClick={() => void submit()}>
            {existing ? 'Save Changes' : 'Record Commitment'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <Field label="Description" required error={errors.description}>
          <Input value={f.description} maxLength={500} onChange={(e) => patch({ description: e.target.value })} />
        </Field>
        <Field label="Project" required error={errors.projectId}>
          <EntitySelect type="project" value={f.projectId} onChange={(v) => patch({ projectId: v, budgetId: null })} />
        </Field>
        <Field label="Budget" error={errors.budgetId} helper="Optional. Must use the same currency.">
          <EntitySelect type="budget" value={f.budgetId} onChange={(v) => patch({ budgetId: v })} filters={f.projectId ? { projectId: f.projectId } : undefined} clearable placeholder="No budget" />
        </Field>
        <Field label="Category" required error={errors.categoryId}>
          <Select
            value={f.categoryId}
            onChange={(v) => patch({ categoryId: v })}
            searchable
            options={(cats.data ?? []).filter((c) => BUDGET_CLASSES.includes(c.accountingClass)).map((c) => ({ value: c.id, label: c.name, description: label('accountingClass', c.accountingClass) }))}
          />
        </Field>
        <div className="grid grid-cols-[minmax(0,1fr)_120px] gap-3">
          <Field label="Amount" required error={errors.amount}>
            <AmountInput currency={f.currency} value={f.amount} onChange={(e) => decimalOk(e.target.value) && patch({ amount: e.target.value })} />
          </Field>
          <Field label="Currency" required error={errors.currency}>
            <CurrencySelect value={f.currency} onChange={(v) => patch({ currency: v })} disabled={!!existing} />
          </Field>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Due Date" error={errors.dueDate}>
            <DateInput value={f.dueDate} onChange={(e) => patch({ dueDate: e.target.value })} />
          </Field>
          <Field label="Counterparty" error={errors.counterparty}>
            <Input value={f.counterparty} maxLength={200} onChange={(e) => patch({ counterparty: e.target.value })} />
          </Field>
        </div>
      </div>
      <ConflictDialog open={conflict} onOpenChange={setConflict} onReload={() => { setConflict(false); onClose(); }} />
    </Drawer>
  );
};

const CommitmentDetailDrawer = ({ id, onClose }: { id: string; onClose: () => void }) => {
  const params = useFinanceParams();
  const router = useRouter();
  const wsPath = useWsPath();
  const can = useCan();
  const q = useApiQuery(F.commitmentsGet, { params: { ...params, commitmentId: id } });
  const [edit, setEdit] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [convertOpen, setConvertOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const cancel = useFinanceMutation(F.commitmentsCancel, { invalidate: ['finance.'], silentErrors: true, successMessage: 'Commitment cancelled' });
  const convert = useFinanceMutation(F.commitmentsConvert, { invalidate: ['finance.'], silentErrors: true });
  const c = q.data;
  const open = c && (c.state === 'open' || c.state === 'partially_consumed');
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} title={c?.description ?? 'Commitment'} description={c ? label('commitmentState', c.state) : undefined}>
      <QueryState query={q}>
        {c ? (
          <div className="flex flex-col gap-4">
            {error ? <Banner tone="danger">{error}</Banner> : null}
            <div className="flex flex-wrap gap-2">
              {open && can('finance.create') ? (
                <Button variant="primary" onClick={() => { setError(null); setAmount(c.remaining.amount); setConvertOpen(true); }}>
                  Convert to Entry
                </Button>
              ) : null}
              {open && can('budgets.write') ? <Button onClick={() => setEdit(true)}>Edit</Button> : null}
              {open && can('budgets.write') ? (
                <Button variant="danger-secondary" onClick={() => { setError(null); setCancelOpen(true); }}>
                  Cancel Commitment
                </Button>
              ) : null}
            </div>
            <DescriptionList
              items={[
                { label: 'Project', value: c.project.name },
                { label: 'Category', value: c.category.name },
                { label: 'Budget', value: c.budget?.name, hidden: !c.budget },
                { label: 'Amount', value: <Money value={c.amount} /> },
                { label: 'Converted to Actual', value: <Money value={c.consumed} /> },
                { label: 'Still Committed', value: <Money value={c.remaining} strong /> },
                { label: 'Due', value: formatDate(c.dueDate) },
                { label: 'Counterparty', value: c.counterparty },
                { label: 'Cancel Reason', value: c.cancelReason, hidden: !c.cancelReason },
              ]}
            />
            <Panel title="Conversions">
              {c.consumptions.length === 0 ? (
                <p className="text-[13px] text-fg-2">Not converted to actual costs yet.</p>
              ) : (
                <ul className="flex flex-col gap-1 text-[13px]">
                  {c.consumptions.map((x) => (
                    <li key={x.id} className="flex items-center justify-between gap-2">
                      <Link href={wsPath(`/finance/entries/${x.entryId}`)} className="text-primary hover:underline">
                        {x.entryTitle}
                      </Link>
                      <span className="flex items-center gap-2">
                        <Money value={x.amount} />
                        {x.reversedAt ? <Badge>Reversed</Badge> : null}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
            <CommitmentDrawer open={edit} onClose={() => setEdit(false)} existing={c} />
            <ReasonDialog
              open={cancelOpen}
              onOpenChange={setCancelOpen}
              title="Cancel Commitment"
              body="The remaining committed amount is released. Conversions already posted stay as actual costs."
              confirmLabel="Cancel Commitment"
              destructive
              loading={cancel.isPending}
              error={error}
              onConfirm={(reason) =>
                void cancel
                  .run({ params: { ...params, commitmentId: c.id }, body: { reason } }, { ifMatch: c.rowVersion })
                  .then(() => setCancelOpen(false))
                  .catch((e) => setError(apiMessage(e)))
              }
            />
            <Dialog
              open={convertOpen}
              onOpenChange={setConvertOpen}
              size="small"
              title="Convert to Entry"
              description="Creates a draft expense linked to this commitment. Posting it moves the amount from Committed to Actual."
              footer={
                <>
                  <Button onClick={() => setConvertOpen(false)}>Cancel</Button>
                  <Button
                    variant="primary"
                    loading={convert.isPending}
                    disabled={!date || !/^\d+(\.\d+)?$/.test(amount.trim())}
                    onClick={() =>
                      void convert
                        .run({ params: { ...params, commitmentId: c.id }, body: { amount: amount.trim(), recognitionDate: date } })
                        .then((entry) => {
                          toast.success('Draft expense created');
                          router.push(wsPath(`/finance/entries/${entry.id}`));
                        })
                        .catch((e) => setError(apiMessage(e)))
                    }
                  >
                    Create Draft
                  </Button>
                </>
              }
            >
              <div className="flex flex-col gap-4">
                {error ? <Banner tone="danger">{error}</Banner> : null}
                <Field label="Amount" required helper={`Up to ${c.remaining.amount} ${c.remaining.currency}`}>
                  <AmountInput currency={c.remaining.currency} value={amount} onChange={(e) => decimalOk(e.target.value) && setAmount(e.target.value)} />
                </Field>
                <Field label="Recognition Date" required>
                  <DateInput value={date} onChange={(e) => setDate(e.target.value)} />
                </Field>
              </div>
            </Dialog>
          </div>
        ) : null}
      </QueryState>
    </Drawer>
  );
};
