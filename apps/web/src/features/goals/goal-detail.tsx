'use client';
import { ArrowSquareOut, ChatCircleText, CheckCircle, DotsThree, PencilSimple } from '@phosphor-icons/react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { goalEndpoints, type GoalDetail } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { isDecimalString } from '@castlane/domain';
import {
  Avatar,
  Badge,
  Banner,
  Button,
  ConfirmDialog,
  DataTable,
  DescriptionList,
  Dialog,
  EmptyState,
  Field,
  IconButton,
  Input,
  Menu,
  PageHeader,
  Panel,
  StatusBadge,
  Textarea,
  formatDate,
  formatDateTime,
  formatNumber,
  type Column,
  type MenuItem,
} from '@castlane/ui';
import { ConflictDialog } from '@/components/common/conflict';
import { QueryState } from '@/components/common/query-state';
import { useApiMutation, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';
import { useWorkspace, useWsPath } from '@/lib/workspace-context';
import { GoalFormDrawer } from './goal-form';
import { GoalProgress } from './goal-progress';
import { goalTargetText } from './goals-screen';
import { MeasuredValue, UNAVAILABLE_TEXT, formatMeasured, hasMeasuredValue } from './measured';
import './labels';

type Revision = GoalDetail['revisions'][number];

const FORMULA: Record<GoalDetail['targetType'], string> = {
  absolute: 'Progress = current ÷ target',
  increase_by: 'Progress = (current − baseline) ÷ target',
  decrease_to: 'Progress = (baseline − current) ÷ (baseline − target)',
};

const num = (v: string | null) => (v === null ? null : formatNumber(v, { maximumFractionDigits: 2 }));

/** S53 Goal detail: progress, current value source, target history (revisions) and check-ins. */
export const GoalDetailScreen = ({ goalId }: { goalId: string }) => {
  const { workspace, user } = useWorkspace();
  const wsPath = useWsPath();
  const { state, set } = useUrlState<'edit' | 'checkin' | 'close'>();
  const params = { workspaceId: workspace.id, goalId };
  const q = useApiQuery(goalEndpoints.get, { params });
  const [archiveOpen, setArchiveOpen] = useState(false);

  return (
    <QueryState query={q}>
      {q.data
        ? (() => {
            const g = q.data;
            const archived = g.status === 'archived';
            const closed = g.status === 'closed';
            const menu: MenuItem[] = [
              { label: 'Open Sources', href: g.sources?.href, hidden: !g.sources },
              { label: archived ? 'Restore' : 'Archive', onSelect: () => setArchiveOpen(true), hidden: !g.permissions.archive, destructive: !archived, separatorBefore: !!g.sources },
            ];
            const revisionColumns: Column<Revision>[] = [
              { key: 'no', header: 'Revision', minWidth: 90, cell: (r) => `#${r.revisionNo}${r.revisionNo === g.revisionNo ? ' (current)' : ''}` },
              { key: 'type', header: 'Target type', minWidth: 120, cell: (r) => label('goalTargetType', r.targetType) },
              { key: 'target', header: 'Target', align: 'right', minWidth: 110, cell: (r) => <span className="tabular-nums">{goalTargetText({ ...r, unit: g.unit })}</span> },
              { key: 'baseline', header: 'Baseline', align: 'right', minWidth: 100, cell: (r) => (r.baselineValue === null ? <span className="text-fg-muted">None</span> : <span className="tabular-nums">{num(r.baselineValue)}</span>) },
              { key: 'period', header: 'Period', minWidth: 180, cell: (r) => `${formatDate(r.periodStart)} – ${formatDate(r.periodEnd)}` },
              { key: 'from', header: 'Effective from', minWidth: 120, cell: (r) => formatDate(r.effectiveFrom) },
              { key: 'reason', header: 'Reason', minWidth: 200, cell: (r) => r.reason ?? <span className="text-fg-muted">Initial target</span> },
              {
                key: 'by',
                header: 'Changed by',
                minWidth: 190,
                cell: (r) => (
                  <span className="flex flex-col">
                    <span>{r.createdBy?.displayName ?? 'System'}</span>
                    <span className="text-[12px] text-fg-2">{formatDateTime(r.createdAt, user.timezone)}</span>
                  </span>
                ),
              },
            ];
            const current = closed && g.achievedValue !== null ? { ...g.current.value, status: 'known' as const, value: g.achievedValue } : g.current.value;
            return (
              <div className="flex flex-col gap-5">
                <PageHeader
                  crumbs={[{ label: 'Goals', href: wsPath('/goals') }, { label: g.name }]}
                  title={g.name}
                  meta={
                    <>
                      <StatusBadge status={g.status} label={label('goalStatus', g.status)} />
                      <span className="text-[13px] text-fg-2">
                        {label('goalScope', g.scope.type)}: {g.scope.label}
                      </span>
                      <span className="flex items-center gap-1.5 text-[13px] text-fg-2">
                        <Avatar name={g.owner.displayName} src={g.owner.avatarUrl} size={24} decorative /> {g.owner.displayName}
                      </span>
                      <span className="text-[13px] text-fg-2">Revision {g.revisionNo}</span>
                    </>
                  }
                  actions={
                    <>
                      {g.permissions.edit ? (
                        <Button icon={<PencilSimple size={14} />} onClick={() => set({ edit: '1' })}>
                          {g.periodStarted ? 'Edit Future Target' : 'Edit'}
                        </Button>
                      ) : null}
                      {g.permissions.checkIn ? (
                        <Button icon={<ChatCircleText size={14} />} onClick={() => set({ checkin: '1' })}>
                          Check In
                        </Button>
                      ) : null}
                      {g.permissions.close ? (
                        <Button variant="primary" icon={<CheckCircle size={14} />} onClick={() => set({ close: '1' })}>
                          Close Goal
                        </Button>
                      ) : null}
                      {menu.some((m) => !m.hidden) ? <Menu label="More actions" trigger={<IconButton label="More actions" icon={<DotsThree size={18} weight="bold" />} variant="secondary" />} items={menu} /> : null}
                    </>
                  }
                />
                {archived ? <Banner tone="info">This goal is archived. Its revisions and check-ins are kept; restore it to edit or check in again.</Banner> : null}
                {closed ? (
                  <Banner tone="info">
                    Closed {formatDateTime(g.closedAt, user.timezone)}. Achieved value and source completeness were stored at closing. Later metric corrections do not change them.
                  </Banner>
                ) : null}
                {!g.metric.available ? <Banner tone="warning">The metric of this goal is not visible to your role, so the current value is not shown.</Banner> : null}
                <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
                  <Panel title="Progress">
                    <div className="flex flex-col gap-5">
                      <GoalProgress goal={g} size="large" />
                      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                        <Stat label={closed ? 'Achieved' : 'Current'}>
                          <MeasuredValue value={current} className="tabular-nums" />
                        </Stat>
                        <Stat label="Target">{goalTargetText(g)}</Stat>
                        <Stat label="Baseline">{g.baselineValue === null ? <span className="text-fg-muted">None</span> : num(g.baselineValue)}</Stat>
                        <Stat label="Completeness">{g.completeness === null ? <span className="text-fg-muted">Not reported</span> : `${formatNumber(g.completeness, { maximumFractionDigits: 0 })}%`}</Stat>
                      </div>
                      <p className="text-[13px] text-fg-2">
                        {g.current.source === 'metric' ? (
                          <>
                            Measured by the canonical metric <span className="font-medium text-fg">{g.metric.label}</span> as of {formatDateTime(g.current.asOf, user.timezone)}.
                          </>
                        ) : g.current.source === 'manual' ? (
                          <>
                            <Badge tone="info">Manual</Badge> Manually recorded in a check-in{g.current.manualSource ? ` — source: ${g.current.manualSource}` : ''}. The canonical metric has no value for this period.
                          </>
                        ) : (
                          <>{hasMeasuredValue(g.current.value) ? null : UNAVAILABLE_TEXT[g.current.value.status]} Add a check-in with a manual value and its source, or record the underlying data.</>
                        )}
                      </p>
                      {g.current.value.excluded?.length ? (
                        <ul className="list-disc pl-5 text-[13px] text-fg-2">
                          {g.current.value.excluded.map((x) => (
                            <li key={x.reason}>
                              {x.count} excluded: {x.reason}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      {closed ? (
                        <div className="rounded-[8px] border border-line p-3">
                          <p className="text-[12px] font-[550] text-fg-2">Assessment</p>
                          <p className="mt-1 whitespace-pre-wrap text-[14px]">{g.assessment}</p>
                        </div>
                      ) : null}
                    </div>
                  </Panel>
                  <Panel title="Details">
                    <DescriptionList
                      columns={1}
                      items={[
                        { label: 'Metric', value: `${g.metric.label} (${g.metric.id})` },
                        { label: 'Unit', value: `${g.unit}${g.metric.rate ? ' (rate)' : ''}` },
                        { label: 'Target type', value: `${label('goalTargetType', g.targetType)} — ${FORMULA[g.targetType]}` },
                        { label: 'Direction', value: label('goalDirection', g.direction), hidden: g.targetType !== 'absolute' },
                        { label: 'Period', value: `${formatDate(g.periodStart)} – ${formatDate(g.periodEnd)}` },
                        { label: 'Scope', value: `${label('goalScope', g.scope.type)}: ${g.scope.label}` },
                        {
                          label: 'Linked campaigns',
                          value: g.linkedCampaigns.length ? (
                            <span className="flex flex-wrap gap-1.5">
                              {g.linkedCampaigns.map((c) => (
                                <Link key={c.id} href={wsPath(`/campaigns/${c.id}`)} className="text-primary hover:underline">
                                  {c.name}
                                </Link>
                              ))}
                            </span>
                          ) : null,
                        },
                        {
                          label: 'Sources',
                          value: g.sources ? (
                            <Link href={g.sources.href} className="inline-flex items-center gap-1 text-primary hover:underline">
                              {g.sources.label} <ArrowSquareOut size={12} aria-hidden />
                            </Link>
                          ) : null,
                        },
                      ]}
                    />
                  </Panel>
                </div>
                <Panel title="Target History" description="Changing the target after the period started creates a revision; earlier targets stay here.">
                  <DataTable caption="Goal revisions" rows={g.revisions} columns={revisionColumns} getRowId={(r) => String(r.revisionNo)} density={user.density} />
                </Panel>
                <Panel
                  title="Check-ins"
                  actions={
                    g.permissions.checkIn ? (
                      <Button size="sm" onClick={() => set({ checkin: '1' })}>
                        Check In
                      </Button>
                    ) : undefined
                  }
                >
                  {g.checkIns.length === 0 ? (
                    <EmptyState title="No check-ins yet" description="Owners add a note on progress, optionally with a manually recorded value and its source." />
                  ) : (
                    <ol className="flex flex-col divide-y divide-line">
                      {g.checkIns.map((c) => (
                        <li key={c.id} className="flex gap-3 py-3 first:pt-0 last:pb-0">
                          <Avatar name={c.member.displayName} src={c.member.avatarUrl} size={24} decorative />
                          <div className="flex min-w-0 flex-1 flex-col gap-1">
                            <p className="text-[13px] text-fg-2">
                              <span className="font-medium text-fg">{c.member.displayName}</span> · {formatDateTime(c.createdAt, user.timezone)}
                            </p>
                            <p className="whitespace-pre-wrap text-[14px]">{c.note}</p>
                            {c.manualValue !== null ? (
                              <p className="flex flex-wrap items-center gap-1.5 text-[13px]">
                                <Badge tone="info">Manual</Badge>
                                <span className="tabular-nums font-medium">{num(c.manualValue)}</span>
                                <span className="text-fg-2">Source: {c.manualSource}</span>
                              </p>
                            ) : c.measuredValue !== null ? (
                              <p className="text-[13px] text-fg-2">Metric value at check-in: {num(c.measuredValue)}</p>
                            ) : null}
                          </div>
                        </li>
                      ))}
                    </ol>
                  )}
                </Panel>
                {g.permissions.edit ? <GoalFormDrawer open={state.edit === '1'} onClose={() => set({ edit: null })} goal={g} /> : null}
                <CheckInDialog goal={g} open={state.checkin === '1'} onOpenChange={(o) => set({ checkin: o ? '1' : null })} />
                <CloseGoalDialog goal={g} open={state.close === '1'} onOpenChange={(o) => set({ close: o ? '1' : null })} />
                <ArchiveGoalDialog goal={g} open={archiveOpen} onOpenChange={setArchiveOpen} />
              </div>
            );
          })()
        : null}
    </QueryState>
  );
};

const Stat = ({ label: text, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex min-w-0 flex-col">
    <span className="text-[12px] font-[550] text-fg-2">{text}</span>
    <span className="text-[16px] font-medium tabular-nums">{children}</span>
  </div>
);

const errorText = (e: unknown, fallback: string) => (isApiError(e) ? e.message : fallback);

const CheckInDialog = ({ goal, open, onOpenChange }: { goal: GoalDetail; open: boolean; onOpenChange: (o: boolean) => void }) => {
  const { workspace } = useWorkspace();
  const [note, setNote] = useState('');
  const [value, setValue] = useState('');
  const [source, setSource] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    if (open) {
      setNote('');
      setValue('');
      setSource('');
      setError(null);
      setFieldErrors({});
    }
  }, [open]);
  const m = useApiMutation(goalEndpoints.checkIn, { invalidate: ['goals.'], successMessage: 'Check-in added', silentErrors: true });
  const localErrors: Record<string, string> = {};
  if (value && !isDecimalString(value.trim())) localErrors.manualValue = 'Enter a number, e.g. 1200 or 12.5.';
  if (value && source.trim().length < 3) localErrors.manualSource = 'Describe where the value comes from.';
  const invalid = note.trim().length < 3 || Object.keys(localErrors).length > 0;
  const submit = () =>
    void m
      .run({ params: { workspaceId: workspace.id, goalId: goal.id }, body: { note: note.trim(), manualValue: value.trim() || null, manualSource: value.trim() ? source.trim() : null } })
      .then(() => onOpenChange(false))
      .catch((e) => {
        setError(errorText(e, 'The check-in could not be saved.'));
        if (isApiError(e)) setFieldErrors(Object.fromEntries(e.fieldErrors.map((x) => [x.field.replace(/^body\./, ''), x.message])));
      });
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Check In"
      description={`Progress note for ${goal.name}. A manual value is labelled Manual and used only when the metric has no value.`}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={m.isPending} disabled={invalid} onClick={submit}>
            Add Check-in
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <Field label="Note" required error={fieldErrors.note} helper="At least 3 characters.">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Manual value" error={localErrors.manualValue ?? fieldErrors.manualValue} helper={`Optional, in ${goal.unit}.`}>
            <Input value={value} onChange={(e) => setValue(e.target.value)} inputMode="decimal" />
          </Field>
          <Field label="Source of the value" required={!!value} error={localErrors.manualSource ?? fieldErrors.manualSource} helper="E.g. platform export, partner report.">
            <Input value={source} onChange={(e) => setSource(e.target.value)} maxLength={300} disabled={!value} />
          </Field>
        </div>
      </div>
    </Dialog>
  );
};

const CloseGoalDialog = ({ goal, open, onOpenChange }: { goal: GoalDetail; open: boolean; onOpenChange: (o: boolean) => void }) => {
  const { workspace } = useWorkspace();
  const [assessment, setAssessment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  useEffect(() => {
    if (open) {
      setAssessment('');
      setError(null);
    }
  }, [open]);
  const m = useApiMutation(goalEndpoints.close, { invalidate: ['goals.'], successMessage: 'Goal closed', silentErrors: true });
  const submit = () =>
    void m
      .run({ params: { workspaceId: workspace.id, goalId: goal.id }, body: { assessment: assessment.trim() } }, { ifMatch: goal.rowVersion })
      .then(() => onOpenChange(false))
      .catch((e) => {
        if (isApiError(e) && e.code === 'VERSION_CONFLICT') setConflict(true);
        else setError(errorText(e, 'The goal could not be closed.'));
      });
  return (
    <>
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
        title="Close Goal"
        description="The current value is stored as the achieved value together with source completeness. Metrics themselves are not changed."
        footer={
          <>
            <Button onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button variant="primary" loading={m.isPending} disabled={assessment.trim().length < 3} onClick={submit}>
              Close Goal
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {error ? <Banner tone="danger">{error}</Banner> : null}
          <DescriptionList
            items={[
              { label: 'Achieved value', value: hasMeasuredValue(goal.current.value) ? `${formatMeasured(goal.current.value)}${goal.current.source === 'manual' ? ' (Manual)' : ''}` : UNAVAILABLE_TEXT[goal.current.value.status] },
              { label: 'Target', value: goalTargetText(goal) },
              { label: 'Progress', value: <GoalProgress goal={goal} /> },
              { label: 'Completeness', value: goal.completeness === null ? 'Not reported' : `${formatNumber(goal.completeness, { maximumFractionDigits: 0 })}%` },
            ]}
          />
          <Field label="Assessment" required helper="What was achieved and why. At least 3 characters.">
            <Textarea value={assessment} onChange={(e) => setAssessment(e.target.value)} maxLength={2000} />
          </Field>
        </div>
      </Dialog>
      <ConflictDialog open={conflict} onOpenChange={setConflict} onReload={() => window.location.reload()} />
    </>
  );
};

const ArchiveGoalDialog = ({ goal, open, onOpenChange }: { goal: GoalDetail; open: boolean; onOpenChange: (o: boolean) => void }) => {
  const { workspace } = useWorkspace();
  const restore = goal.status === 'archived';
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (open) setReason('');
  }, [open]);
  const m = useApiMutation(goalEndpoints.archive, { invalidate: ['goals.'], successMessage: restore ? 'Goal restored' : 'Goal archived' });
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={restore ? 'Restore Goal' : 'Archive Goal'}
      body={restore ? 'The goal returns to its previous status with all revisions and check-ins.' : 'The goal leaves lists and progress summaries. Revisions and check-ins are kept, and it can be restored.'}
      confirmLabel={restore ? 'Restore' : 'Archive'}
      destructive={!restore}
      loading={m.isPending}
      onConfirm={() =>
        void m
          .run({ params: { workspaceId: workspace.id, goalId: goal.id }, body: { restore: restore || undefined, reason: reason.trim() || undefined } }, { ifMatch: goal.rowVersion })
          .then(() => onOpenChange(false))
          .catch(() => undefined)
      }
    >
      <Field label="Reason" helper="Optional.">
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} />
      </Field>
    </ConfirmDialog>
  );
};
