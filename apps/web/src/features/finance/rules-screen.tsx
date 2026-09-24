'use client';
import { Plus, Scales } from '@phosphor-icons/react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { financeEndpoints as F, type RuleDetail, type RuleRow, type RuleVersionInput, type RuleVersionView } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { COMPENSATION_RULE_TYPES, HOURLY_SOURCES, PRORATION_POLICIES, RESPONSIBILITIES, REVENUE_SHARE_BASES } from '@castlane/domain';
import {
  AmountInput,
  Avatar,
  Badge,
  Banner,
  Button,
  DataTable,
  DateInput,
  Dialog,
  Drawer,
  EmptyState,
  Field,
  Input,
  MultiSelect,
  NoResults,
  PageHeader,
  Panel,
  Select,
  StatusBadge,
  Switch,
  Toolbar,
  formatDate,
  humanize,
  type Column,
} from '@castlane/ui';
import { MultiEntitySelect } from '@/components/common/entity-select';
import { ConflictDialog } from '@/components/common/conflict';
import { useEditBase } from '@/lib/edit-base';
import { MemberSelect } from '@/components/common/pickers';
import { QueryState } from '@/components/common/query-state';
import { useDebounced } from '@/components/common/use-debounced';
import { useApiInfinite, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';
import { CurrencySelect, FinanceNav, Money, ReasonDialog, apiMessage, decimalOk, isConflict, monthPeriod, useFinanceParams, useGuardedAction, useFinanceMutation } from './common';
import { RunLinesTable } from './member-compensation';

type Keys = 'q' | 'type' | 'recipient' | 'archived' | 'open' | 'create';
type RuleType = (typeof COMPENSATION_RULE_TYPES)[number];

const fieldErrorsOf = (e: unknown) => (isApiError(e) ? Object.fromEntries(e.fieldErrors.map((x) => [x.field.replace(/^body\./, ''), x.message])) : {});

export const rateText = (v: Pick<RuleVersionView, 'type' | 'rate' | 'ratePercent' | 'revenueBasis'> | null) =>
  !v ? '—' : v.type === 'revenue_share' ? `${v.ratePercent ?? '—'}% of ${label('revenueBasis', v.revenueBasis)}` : v.rate ? `${v.rate.amount} ${v.rate.currency}${v.type === 'hourly' ? ' / hour' : v.type === 'per_approved_unit' ? ' / unit' : ' / month'}` : '—';

const effectiveText = (v: Pick<RuleVersionView, 'effectiveFrom' | 'effectiveTo'>) => `${formatDate(v.effectiveFrom)} – ${v.effectiveTo ? `${formatDate(v.effectiveTo)} (exclusive)` : 'open-ended'}`;

/** S58 Compensation Rules: versioned, reproducible rules. Simulation never accrues anything. */
export const RulesScreen = () => {
  const can = useCan();
  const { user } = useWorkspace();
  const params = useFinanceParams();
  const { state, set, list } = useUrlState<Keys>();
  const [search, setSearch] = useState(state.q ?? '');
  const q = useDebounced(search, 250);
  const query = { q: q.length >= 2 ? q : undefined, type: list('type') as RuleType[], recipientMembershipId: state.recipient, includeArchived: state.archived === '1' ? true : undefined };
  const data = useApiInfinite(F.rulesList, { params, query });
  const filtered = !!(query.q || query.type.length || query.recipientMembershipId);
  const columns: Column<RuleRow>[] = [
    {
      key: 'name',
      header: 'Rule',
      sticky: true,
      minWidth: 220,
      cell: (r) => (
        <span className="flex flex-col">
          <span className="font-medium text-fg">{r.name}</span>
          <span className="font-mono text-[11px] text-fg-2">
            {r.componentKey}
            {r.stackGroup ? ` · stack ${r.stackGroup}` : ''}
          </span>
        </span>
      ),
    },
    {
      key: 'recipient',
      header: 'Recipient',
      minWidth: 180,
      cell: (r) =>
        r.recipient ? (
          <span className="flex items-center gap-2">
            <Avatar name={r.recipient.displayName} src={r.recipient.avatarUrl ?? null} size={28} decorative />
            <span className="truncate">{r.recipient.displayName}</span>
          </span>
        ) : (
          <span>Role: {r.role?.name ?? '—'}</span>
        ),
    },
    { key: 'type', header: 'Type', minWidth: 150, cell: (r) => label('ruleType', (r.currentVersion ?? r.draftVersion)?.type) },
    { key: 'rate', header: 'Rate', minWidth: 170, cell: (r) => rateText(r.currentVersion ?? r.draftVersion) },
    { key: 'effective', header: 'Effective', minWidth: 220, cell: (r) => (r.currentVersion ? effectiveText(r.currentVersion) : <span className="text-fg-muted">Not approved</span>) },
    {
      key: 'state',
      header: 'Status',
      minWidth: 170,
      cell: (r) => (
        <span className="flex flex-wrap gap-1">
          {r.currentVersion ? <StatusBadge status={r.currentVersion.state} label={label('ruleState', r.currentVersion.state)} /> : null}
          {r.draftVersion ? <Badge tone="info">Draft v{r.draftVersion.versionNo}</Badge> : null}
          {r.archivedAt ? <Badge>Archived</Badge> : null}
        </span>
      ),
    },
  ];
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Compensation Rules"
        description="Who earns what, from which source and base. Approved versions never change; a new version starts a new effective period."
        actions={
          can('compensation.rules.write') ? (
            <Button variant="primary" icon={<Plus size={14} weight="bold" />} onClick={() => set({ create: '1' })}>
              New Rule
            </Button>
          ) : undefined
        }
      />
      <FinanceNav />
      <Toolbar>
        <div className="w-full sm:w-[220px]">
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              set({ q: e.target.value || null });
            }}
            placeholder="Search rules"
            aria-label="Search rules"
          />
        </div>
        <div className="w-[190px]">
          <MultiSelect aria-label="Type" placeholder="Type" value={list('type')} onChange={(v) => set({ type: v.join(',') || null })} options={COMPENSATION_RULE_TYPES.map((t) => ({ value: t, label: label('ruleType', t) }))} />
        </div>
        <div className="w-[200px]">
          <MemberSelect aria-label="Recipient" placeholder="Recipient" value={state.recipient} onChange={(v) => set({ recipient: v })} clearable />
        </div>
        <div className="px-1">
          <Switch label="Show archived" checked={state.archived === '1'} onCheckedChange={(v) => set({ archived: v ? '1' : null })} />
        </div>
      </Toolbar>
      <QueryState query={data}>
        {data.items.length === 0 && !data.isFetching ? (
          filtered ? (
            <NoResults onClear={() => { setSearch(''); set({ q: null, type: null, recipient: null }); }} />
          ) : (
            <EmptyState
              icon={<Scales size={28} />}
              title="No compensation rules"
              description="Define fixed, hourly, per-unit or revenue-share rules. Runs calculate from approved rule versions only."
              action={can('compensation.rules.write') ? <Button variant="primary" onClick={() => set({ create: '1' })}>New Rule</Button> : undefined}
            />
          )
        ) : (
          <DataTable
            caption="Compensation rules"
            rows={data.items}
            columns={columns}
            getRowId={(r) => r.id}
            density={user.density}
            onRowClick={(r) => set({ open: r.id }, { replace: false })}
            selectedRowId={state.open ?? null}
            hasMore={data.hasNextPage}
            loadingMore={data.isFetchingNextPage}
            onLoadMore={() => void data.fetchNextPage()}
          />
        )}
      </QueryState>
      <RuleCreateDrawer open={state.create === '1'} onOpenChange={(o) => !o && set({ create: null })} onCreated={(id) => set({ create: null, open: id })} />
      {state.open ? <RuleDrawer id={state.open} onClose={() => set({ open: null })} /> : null}
    </div>
  );
};

type VersionForm = {
  type: RuleType;
  effectiveFrom: string;
  effectiveTo: string;
  rate: string;
  ratePercent: string;
  currency: string;
  revenueBasis: (typeof REVENUE_SHARE_BASES)[number] | null;
  hourlySource: (typeof HOURLY_SOURCES)[number] | null;
  proration: (typeof PRORATION_POLICIES)[number];
  eligibleProjectIds: string[];
  contributorResponsibility: string | null;
};

const blankVersion = (currency: string, from?: RuleVersionView | null): VersionForm =>
  from
    ? {
        type: from.type,
        effectiveFrom: new Date().toISOString().slice(0, 10),
        effectiveTo: '',
        rate: from.rate?.amount ?? '',
        ratePercent: from.ratePercent ?? '',
        currency: from.currency,
        revenueBasis: from.revenueBasis,
        hourlySource: from.hourlySource,
        proration: from.proration,
        eligibleProjectIds: from.eligibleProjects.map((p) => p.id),
        contributorResponsibility: from.contributorResponsibility,
      }
    : { type: 'fixed_period', effectiveFrom: `${new Date().toISOString().slice(0, 7)}-01`, effectiveTo: '', rate: '', ratePercent: '', currency, revenueBasis: null, hourlySource: null, proration: 'calendar_days', eligibleProjectIds: [], contributorResponsibility: null };

const versionBody = (v: VersionForm): RuleVersionInput => ({
  type: v.type,
  effectiveFrom: v.effectiveFrom,
  effectiveTo: v.effectiveTo || null,
  rate: v.type === 'revenue_share' ? null : v.rate.trim() || null,
  ratePercent: v.type === 'revenue_share' ? v.ratePercent.trim() || null : null,
  currency: v.currency,
  revenueBasis: v.type === 'revenue_share' ? v.revenueBasis : null,
  hourlySource: v.type === 'hourly' ? v.hourlySource : null,
  proration: v.type === 'fixed_period' ? v.proration : 'none',
  eligibleProjectIds: v.eligibleProjectIds,
  contributorResponsibility: v.type === 'per_approved_unit' ? v.contributorResponsibility : null,
});

/** Version fields; a percentage cannot be saved without its base and source. */
const VersionFields = ({ value: v, onChange, errors, prefix = 'version.' }: { value: VersionForm; onChange: (v: VersionForm) => void; errors: Record<string, string>; prefix?: string }) => {
  const set = (p: Partial<VersionForm>) => onChange({ ...v, ...p });
  const e = (k: string) => errors[`${prefix}${k}`];
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <Field label="Type" required error={e('type')} className="sm:col-span-2">
        <Select value={v.type} onChange={(t) => t && set({ type: t })} options={COMPENSATION_RULE_TYPES.map((t) => ({ value: t, label: label('ruleType', t) }))} />
      </Field>
      <Field label="Effective From" required error={e('effectiveFrom')}>
        <DateInput value={v.effectiveFrom} onChange={(x) => set({ effectiveFrom: x.target.value })} />
      </Field>
      <Field label="Effective To" error={e('effectiveTo')} helper="Exclusive end date. Leave empty for open-ended.">
        <DateInput value={v.effectiveTo} onChange={(x) => set({ effectiveTo: x.target.value })} />
      </Field>
      {v.type === 'revenue_share' ? (
        <>
          <Field label="Share" required error={e('ratePercent')}>
            <div className="relative flex items-center">
              <Input inputMode="decimal" className="pr-8 text-right font-mono" value={v.ratePercent} onChange={(x) => decimalOk(x.target.value) && set({ ratePercent: x.target.value })} />
              <span className="pointer-events-none absolute right-3 text-[12px] text-fg-2">%</span>
            </div>
          </Field>
          <Field label="Base Metric" required error={e('revenueBasis')} helper="Only revenue explicitly attributed to the recipient counts.">
            <Select value={v.revenueBasis} onChange={(b) => set({ revenueBasis: b })} options={REVENUE_SHARE_BASES.map((b) => ({ value: b, label: label('revenueBasis', b) }))} placeholder="Choose a base" />
          </Field>
        </>
      ) : (
        <Field label={v.type === 'fixed_period' ? 'Monthly Amount' : v.type === 'hourly' ? 'Hourly Rate' : 'Amount per Approved Unit'} required error={e('rate')}>
          <AmountInput currency={v.currency} value={v.rate} onChange={(x) => decimalOk(x.target.value) && set({ rate: x.target.value })} />
        </Field>
      )}
      <Field label="Currency" required error={e('currency')}>
        <CurrencySelect value={v.currency} onChange={(c) => set({ currency: c })} />
      </Field>
      {v.type === 'hourly' ? (
        <Field label="Hours Source" required error={e('hourlySource')} helper="Exactly one source, so overlapping time entries and shifts are never paid twice.">
          <Select value={v.hourlySource} onChange={(s) => set({ hourlySource: s })} options={HOURLY_SOURCES.map((s) => ({ value: s, label: label('hourlySource', s) }))} placeholder="Choose a source" />
        </Field>
      ) : null}
      {v.type === 'fixed_period' ? (
        <Field label="Proration" error={e('proration')} helper="Partial months: calendar days of the effective period.">
          <Select value={v.proration} onChange={(p) => p && set({ proration: p })} options={PRORATION_POLICIES.map((p) => ({ value: p, label: label('proration', p) }))} />
        </Field>
      ) : null}
      {v.type === 'per_approved_unit' ? (
        <Field label="Contributor Responsibility" error={e('contributorResponsibility')} helper="Optional. Limits units to work done in this responsibility.">
          <Select value={v.contributorResponsibility} onChange={(r) => set({ contributorResponsibility: r })} clearable options={RESPONSIBILITIES.map((r) => ({ value: r, label: humanize(r) }))} placeholder="Any" />
        </Field>
      ) : null}
      <Field label="Eligible Projects" error={e('eligibleProjectIds')} helper="Empty means all projects the recipient works on." className="sm:col-span-2">
        <MultiEntitySelect type="project" value={v.eligibleProjectIds} onChange={(ids) => set({ eligibleProjectIds: ids })} placeholder="All projects" />
      </Field>
      <p className="text-[12px] text-fg-2 sm:col-span-2">Refund policy: refunds after a run was approved become negative adjustments in the next open run; paid amounts are never changed.</p>
    </div>
  );
};

const RuleCreateDrawer = ({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (id: string) => void }) => {
  const { workspace } = useWorkspace();
  const params = useFinanceParams();
  const [name, setName] = useState('');
  const [recipient, setRecipient] = useState<string | null>(null);
  const [component, setComponent] = useState('');
  const [stackGroup, setStackGroup] = useState('');
  const [version, setVersion] = useState<VersionForm>(blankVersion(workspace.baseCurrency));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setName('');
      setRecipient(null);
      setComponent('');
      setStackGroup('');
      setVersion(blankVersion(workspace.baseCurrency));
      setErrors({});
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const create = useFinanceMutation(F.rulesCreate, { invalidate: ['finance.'], silentErrors: true, successMessage: 'Rule created as a draft' });
  const componentKey = component.trim() || version.type;
  const submit = async () => {
    setError(null);
    const e: Record<string, string> = {};
    if (name.trim().length < 2) e.name = 'Use 2–120 characters.';
    if (!recipient) e.recipientMembershipId = 'Choose the recipient.';
    if (!/^[a-z0-9_]{2,60}$/.test(componentKey)) e.componentKey = 'Use lowercase letters, digits and _';
    setErrors(e);
    if (Object.keys(e).length) return;
    try {
      const r = await create.run({ params, body: { name: name.trim(), recipientScopeType: 'member', recipientMembershipId: recipient, componentKey, stackGroup: stackGroup.trim() || null, version: versionBody(version) } });
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
      width={760}
      title="New Compensation Rule"
      description="The first version is a draft until it is approved."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)} disabled={create.isPending}>
            Cancel
          </Button>
          <Button variant="primary" loading={create.isPending} onClick={() => void submit()}>
            Create Rule
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Name" required error={errors.name} className="sm:col-span-2">
            <Input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="e.g. Chatter hourly pay" />
          </Field>
          <Field label="Member" required error={errors.recipientMembershipId}>
            <MemberSelect value={recipient} onChange={setRecipient} />
          </Field>
          <Field label="Component" error={errors.componentKey} helper="Rules with the same component and recipient cannot overlap.">
            <Input value={component} maxLength={60} placeholder={version.type} onChange={(e) => setComponent(e.target.value.toLowerCase())} />
          </Field>
          <Field label="Stack Group" error={errors.stackGroup} helper="Revenue-share rules that may apply together share a stack group (total at most 100%)." className="sm:col-span-2">
            <Input value={stackGroup} maxLength={60} onChange={(e) => setStackGroup(e.target.value)} />
          </Field>
        </div>
        <Panel title="Version 1">
          <VersionFields value={version} onChange={setVersion} errors={errors} />
        </Panel>
      </div>
    </Drawer>
  );
};

type RuleDialog = 'version' | 'end' | 'simulate' | null;

const RuleDrawer = ({ id, onClose }: { id: string; onClose: () => void }) => {
  const params = useFinanceParams();
  const q = useApiQuery(F.rulesGet, { params: { ...params, ruleId: id } });
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} width={760} title={q.data?.name ?? 'Compensation Rule'} description={q.data ? (q.data.recipient ? q.data.recipient.displayName : `Role: ${q.data.role?.name ?? ''}`) : undefined}>
      <QueryState query={q}>{q.data ? <RuleBody r={q.data} refetch={() => void q.refetch()} /> : null}</QueryState>
    </Drawer>
  );
};

const RuleBody = ({ r, refetch }: { r: RuleDetail; refetch: () => void }) => {
  const wsPath = useWsPath();
  const { user } = useWorkspace();
  const params = useFinanceParams();
  const rp = { ...params, ruleId: r.id };
  const [dialog, setDialog] = useState<RuleDialog>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const guard = useGuardedAction();
  const approve = useFinanceMutation(F.rulesApprove, { invalidate: ['finance.'], silentErrors: true, successMessage: 'Rule version approved' });
  const end = useFinanceMutation(F.rulesEnd, { invalidate: ['finance.'], silentErrors: true, successMessage: 'Rule ended' });
  const [endDate, setEndDate] = useState('');
  const fail = (e: unknown) => (isConflict(e) ? setConflict(true) : setError(apiMessage(e)));
  const draft = r.draftVersion;
  const current = r.currentVersion;
  return (
    <div className="flex flex-col gap-4">
      {error ? <Banner tone="danger">{error}</Banner> : null}
      {draft && current ? <Banner tone="info">A newer version is awaiting review.</Banner> : null}
      <div className="flex items-center gap-3">
        {r.recipient ? <Avatar name={r.recipient.displayName} src={r.recipient.avatarUrl ?? null} size={28} decorative /> : null}
        <span className="text-[13px] text-fg-2">
          Component <span className="font-mono">{r.componentKey}</span>
          {r.stackGroup ? ` · stack group ${r.stackGroup}` : ''}
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        {draft && r.permissions.approve ? (
          <Button variant="primary" loading={approve.isPending} onClick={() => void guard.act(async () => { await approve.run({ params: rp, body: { versionId: draft.id } }, { ifMatch: r.rowVersion }); }, fail)}>
            Approve Rule
          </Button>
        ) : null}
        {r.permissions.createVersion && !draft ? <Button onClick={() => setDialog('version')}>Create Version</Button> : null}
        {r.permissions.simulate && (draft || current) ? <Button onClick={() => setDialog('simulate')}>Simulate on Period</Button> : null}
        {current && current.state === 'approved' && r.permissions.end ? (
          <Button variant="danger-secondary" onClick={() => { setError(null); setEndDate(new Date().toISOString().slice(0, 10)); setDialog('end'); }}>
            End Rule
          </Button>
        ) : null}
      </div>
      <Panel title="Versions">
        <ul className="flex flex-col divide-y divide-line">
          {r.versions.map((v) => (
            <li key={v.id} className="flex flex-col gap-1 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-2">
                  <span className="font-semibold">v{v.versionNo}</span>
                  <StatusBadge status={v.state} label={label('ruleState', v.state)} />
                  <Badge>{label('ruleType', v.type)}</Badge>
                </span>
                <span className="text-[13px] font-medium">{rateText(v)}</span>
              </div>
              <span className="text-[12px] text-fg-2">{effectiveText(v)}</span>
              <span className="text-[12px] text-fg-2">
                {v.hourlySource ? `Source: ${label('hourlySource', v.hourlySource)} · ` : ''}
                {v.type === 'fixed_period' ? `Proration: ${label('proration', v.proration)} · ` : ''}
                {v.contributorResponsibility ? `Responsibility: ${humanize(v.contributorResponsibility)} · ` : ''}
                Projects: {v.eligibleProjects.length ? v.eligibleProjects.map((p) => p.name).join(', ') : 'All'}
              </span>
              <span className="text-[12px] text-fg-2">
                {v.approvedAt ? `Approved ${formatDate(v.approvedAt, user.timezone)}${v.approvedBy ? ` by ${v.approvedBy.displayName}` : ''}` : `Created ${formatDate(v.createdAt, user.timezone)}`}
                {v.endedAt ? ` · ended ${formatDate(v.endedAt, user.timezone)}` : ''}
              </span>
            </li>
          ))}
        </ul>
      </Panel>
      <Panel title="Affected Runs" description="Runs that used a version of this rule">
        {r.affectedRuns.length === 0 ? (
          <p className="text-[13px] text-fg-2">Not used by any run yet.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-[13px]">
            {r.affectedRuns.map((run) => (
              <li key={run.id} className="flex items-center justify-between gap-2">
                <Link href={wsPath(`/finance/compensation/runs/${run.id}`)} className="text-primary hover:underline">
                  {formatDate(run.periodStart)} – {formatDate(run.periodEnd)}
                </Link>
                <StatusBadge status={run.state} label={label('runState', run.state)} />
              </li>
            ))}
          </ul>
        )}
      </Panel>
      {dialog === 'version' ? <VersionDialog r={r} onClose={() => setDialog(null)} /> : null}
      {dialog === 'simulate' ? <SimulateDialog r={r} onClose={() => setDialog(null)} /> : null}
      <ReasonDialog
        open={dialog === 'end' && !!current}
        onOpenChange={(o) => !o && setDialog(null)}
        title="End Rule"
        body="The approved version stops applying from the end date (exclusive). Periods already calculated are not changed."
        confirmLabel="End Rule"
        destructive
        dateLabel="End Date (exclusive)"
        defaultDate={endDate}
        loading={end.isPending}
        error={error}
        onConfirm={(reason, date) =>
          void guard.act(async () => {
            await end.run({ params: rp, body: { versionId: current!.id, effectiveTo: date, reason } }, { ifMatch: r.rowVersion });
            setDialog(null);
          }, fail)
        }
      />
      <ConflictDialog open={conflict} onOpenChange={setConflict} onReload={() => { setConflict(false); refetch(); }} />
      {guard.dialog}
    </div>
  );
};

const VersionDialog = ({ r, onClose }: { r: RuleDetail; onClose: () => void }) => {
  const { workspace } = useWorkspace();
  const params = useFinanceParams();
  const [v, setV] = useState<VersionForm>(blankVersion(workspace.baseCurrency, r.currentVersion));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  // The new version is proposed against the rule as the dialog opened; a conflict keeps the input (T162).
  const edit = useEditBase(r);
  const m = useFinanceMutation(F.rulesCreateVersion, { invalidate: ['finance.'], silentErrors: true, successMessage: 'Draft version created' });
  return (
    <>
      <Dialog
        open
        onOpenChange={(o) => !o && onClose()}
        size="wide"
        title="Create Version"
        description="A new draft version. Once approved it takes over from its effective date; the previous version is not overwritten."
        footer={
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              loading={m.isPending}
              onClick={() =>
                void m
                  .run({ params: { ...params, ruleId: r.id }, body: { version: versionBody(v) } }, { ifMatch: edit.version })
                  .then(onClose)
                  .catch((e) => {
                    if (edit.catchConflict(e)) return;
                    setErrors(fieldErrorsOf(e));
                    setError(apiMessage(e));
                  })
              }
            >
              Create Version
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {error ? <Banner tone="danger">{error}</Banner> : null}
          <VersionFields value={v} onChange={setV} errors={errors} />
        </div>
      </Dialog>
      <ConflictDialog {...edit.conflictDialog} />
    </>
  );
};

type SimResult = { lines: Parameters<typeof RunLinesTable>[0]['lines']; totals: { recipient: { displayName: string }; currency: string; total: { amount: string; currency: string } }[]; conflicts: { versionId: string; code: string; message: string }[]; stack: { revenueSharePercent: string; rules: { versionId: string; ratePercent: string | null; name?: string }[] } };

const SimulateDialog = ({ r, onClose }: { r: RuleDetail; onClose: () => void }) => {
  const params = useFinanceParams();
  const versions = r.versions.filter((v) => v.state !== 'ended');
  const [versionId, setVersionId] = useState<string | null>(r.draftVersion?.id ?? r.currentVersion?.id ?? versions[0]?.id ?? null);
  const last = new Date();
  last.setUTCMonth(last.getUTCMonth() - 1);
  const init = monthPeriod(last.toISOString().slice(0, 7));
  const [start, setStart] = useState(init.periodStart);
  const [end, setEnd] = useState(init.periodEnd);
  const [result, setResult] = useState<SimResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const m = useFinanceMutation(F.rulesSimulate, { silentErrors: true });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="wide"
      title="Simulate on Period"
      description="Shows what this version would calculate from approved source records. Nothing is accrued or saved."
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button
            variant="primary"
            loading={m.isPending}
            disabled={!versionId || !start || !end || end < start}
            onClick={() =>
              void m
                .run({ params: { ...params, ruleId: r.id }, body: { versionId: versionId!, periodStart: start, periodEnd: end } })
                .then((x) => {
                  setError(null);
                  setResult(x as SimResult);
                })
                .catch((e) => setError(apiMessage(e)))
            }
          >
            Simulate
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Version" required>
            <Select value={versionId} onChange={setVersionId} options={versions.map((v) => ({ value: v.id, label: `v${v.versionNo} · ${label('ruleState', v.state)}` }))} />
          </Field>
          <Field label="Period Start" required>
            <DateInput value={start} onChange={(e) => setStart(e.target.value)} />
          </Field>
          <Field label="Period End" required>
            <DateInput value={end} onChange={(e) => setEnd(e.target.value)} />
          </Field>
        </div>
        {result ? (
          <div className="flex flex-col gap-3">
            {result.conflicts.map((c) => (
              <Banner key={`${c.versionId}-${c.code}`} tone="danger">
                {c.message}
              </Banner>
            ))}
            {result.stack.rules.length > 1 ? (
              <Banner tone="info">
                Revenue-share stack: {result.stack.rules.map((s) => `${s.name ?? 'rule'} ${s.ratePercent ?? '—'}%`).join(' + ')} = {result.stack.revenueSharePercent}%
              </Banner>
            ) : null}
            <div className="flex flex-wrap gap-4 text-[14px]">
              {result.totals.length === 0 ? <span className="text-fg-2">Nothing would be calculated for this period.</span> : null}
              {result.totals.map((t) => (
                <span key={`${t.recipient.displayName}-${t.currency}`}>
                  {t.recipient.displayName}: <Money value={t.total} strong />
                </span>
              ))}
            </div>
            {result.lines.length ? <RunLinesTable lines={result.lines} caption="Simulated lines" /> : null}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
};
