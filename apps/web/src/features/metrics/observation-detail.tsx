'use client';
import Link from 'next/link';
import { DotsThree } from '@phosphor-icons/react';
import { useMemo, useState } from 'react';
import { metricsEndpoints as M, type ObservationDetail } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { Badge, Banner, Button, DescriptionList, Dialog, Drawer, Field, IconButton, Menu, PageHeader, Panel, Textarea, formatDateTime } from '@castlane/ui';
import { ConflictDialog } from '@/components/common/conflict';
import { useEditBase } from '@/lib/edit-base';
import { QueryState } from '@/components/common/query-state';
import { useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';
import { useWorkspace, useWsPath } from '@/lib/workspace-context';
import { EntityLink, MetricValueText, ObservationValue, QualityBadge, SourceText, TimingBadge, errorMessage, useInsightsMutation } from './common';
import { ValuesEditor } from './entry-form';

const ACTIVE = ['unverified', 'reviewed'];

/** S50 Metric Revision view: values, provenance, checkpoint, evidence, revisions and the correction workflow. */
export const ObservationDetailScreen = ({ observationId }: { observationId: string }) => {
  const { workspace, user } = useWorkspace();
  const wsPath = useWsPath();
  const { state, set } = useUrlState<'correct'>();
  const q = useApiQuery(M.get, { params: { workspaceId: workspace.id, observationId } });
  const [dialog, setDialog] = useState<null | 'review' | 'canonical' | 'reject'>(null);
  const [conflict, setConflict] = useState(false);
  const zone = user.timezone;

  return (
    <QueryState query={q}>
      {q.data
        ? (() => {
            const o = q.data;
            const active = ACTIVE.includes(o.qualityState);
            const canCorrect = o.permissions.revise && active && !o.hasPendingCorrection;
            return (
              <div className="flex flex-col gap-5">
                <PageHeader
                  crumbs={[{ label: 'Metrics', href: wsPath('/metrics?tab=observations') }, { label: o.entity.label }]}
                  title={`${o.entity.label} · ${label('observationDataset', o.dataset)}`}
                  meta={
                    <>
                      <QualityBadge quality={o.qualityState} />
                      <Badge tone={o.canonical ? 'success' : 'neutral'}>{o.canonical ? 'Used in reports' : 'Excluded from reports'}</Badge>
                      {o.checkpoint ? <TimingBadge timing={o.checkpoint.timing} /> : null}
                      <span className="text-[13px] text-fg-2">Revision {o.revisionNo}</span>
                    </>
                  }
                  actions={
                    <>
                      {canCorrect ? (
                        <Button variant="primary" onClick={() => set({ correct: '1' })}>
                          Submit Correction
                        </Button>
                      ) : null}
                      {o.permissions.markReviewed && o.qualityState === 'unverified' ? <Button onClick={() => setDialog('review')}>Mark Reviewed</Button> : null}
                      <Menu
                        label="More actions"
                        trigger={<IconButton label="More" variant="secondary" icon={<DotsThree size={18} weight="bold" />} />}
                        items={[
                          { label: 'Open Source Entity', href: wsPath(o.entity.href) },
                          { label: o.canonical ? 'Exclude from Reports' : 'Use in Reports', onSelect: () => setDialog('canonical'), hidden: !o.permissions.setCanonical || !active },
                          { label: 'Add Metrics for This Entity', href: wsPath(`/metrics/new?${o.entity.type === 'publication' ? `publicationId=${o.entity.id}` : `accountId=${o.entity.accountId}&entityType=${o.entity.type}`}`) },
                        ]}
                      />
                    </>
                  }
                />
                {o.qualityState === 'superseded' ? <Banner tone="info">A newer revision of this record is in use. This revision is kept for history.</Banner> : null}
                {o.checkpoint && o.checkpoint.timing !== 'on_time' ? (
                  <Banner tone="warning">Recorded outside the target window: the real observed time is kept and the value is excluded from standard checkpoint comparisons.</Banner>
                ) : null}
                {o.pendingCorrection ? <PendingCorrection o={o} onConflict={() => setConflict(true)} onReject={() => setDialog('reject')} /> : null}

                <Panel title="Values">
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[420px] text-left text-[13px]">
                      <caption className="sr-only">Recorded values</caption>
                      <thead>
                        <tr className="border-b border-line">
                          <th scope="col" className="py-2 pr-3 font-[550] text-fg-2">
                            Metric
                          </th>
                          <th scope="col" className="py-2 pr-3 text-right font-[550] text-fg-2">
                            Value
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {o.values.map((v) => (
                          <tr key={v.metricKey} className="border-b border-line last:border-b-0">
                            <th scope="row" className="py-2 pr-3 font-normal text-fg">
                              {v.label}
                            </th>
                            <td className="py-2 pr-3 text-right">
                              <ObservationValue availability={v.availability} value={v.value} unit={v.unit} />
                              {v.currency ? <span className="ml-1 text-fg-2">{v.currency}</span> : null}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {o.completeness ? (
                    <p className="mt-3 text-[13px] text-fg-2">
                      Required checkpoint fields present: <MetricValueText value={o.completeness} />
                    </p>
                  ) : null}
                </Panel>

                <Panel title="Source and time">
                  <DescriptionList
                    items={[
                      { label: 'Observed at', value: formatDateTime(o.observedAt, zone) },
                      { label: 'Period', value: o.periodStart ? `${formatDateTime(o.periodStart, zone)} – ${formatDateTime(o.periodEnd, zone)}` : null, hidden: o.kind !== 'period' },
                      { label: 'Recorded for', value: <EntityLink entity={o.entity} /> },
                      { label: 'Segment', value: label('metricSegment', o.segment) },
                      { label: 'Source', value: <SourceText o={o} /> },
                      { label: 'Source note', value: o.sourceNote },
                      { label: 'Entered', value: `${o.enteredBy?.displayName ?? 'Unknown member'} · ${formatDateTime(o.enteredAt, zone)}` },
                      { label: 'Reviewed', value: o.reviewedBy ? `${o.reviewedBy.displayName} · ${formatDateTime(o.reviewedAt, zone)}` : null, hidden: !o.reviewedBy },
                      { label: 'Checkpoint', value: o.checkpoint ? `${o.checkpoint.label} (expected ${formatDateTime(o.checkpoint.expectedAt, zone)})` : null, hidden: !o.checkpoint },
                      { label: 'Definition set', value: `v${o.definitionSetVersion}` },
                      { label: 'Warnings', value: o.warnings.map((w) => label('metricWarning', w)).join(', '), hidden: !o.warnings.length },
                      { label: 'Warning note', value: o.warningNote, hidden: !o.warningNote },
                      { label: 'Correction reason', value: o.correctionReason, hidden: !o.correctionReason },
                    ]}
                  />
                </Panel>

                {o.evidence.length ? (
                  <Panel title="Evidence">
                    <ul className="flex flex-col gap-1 text-[13px]">
                      {o.evidence.map((e) => (
                        <li key={e.assetId}>
                          <Link href={wsPath(`/library?asset=${e.assetId}`)} className="text-primary hover:underline">
                            {e.name}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </Panel>
                ) : null}

                {o.alternates.length || o.conflicts.length ? (
                  <Panel title="Other records for the same moment or period" description="Only one source per moment is used in reports; overlapping periods are never summed.">
                    <ul className="flex flex-col divide-y divide-line text-[13px]">
                      {[...o.alternates.map((a) => ({ id: a.id, text: `${label('metricSourceType', a.sourceType)} · ${a.sourceNamespace}`, canonical: a.canonical })), ...o.conflicts.map((c) => ({ id: c.id, text: `Overlapping period ${formatDateTime(c.periodStart, zone)} – ${formatDateTime(c.periodEnd, zone)} · ${c.sourceNamespace}`, canonical: c.canonical }))].map((x) => (
                        <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                          <Link href={wsPath(`/metrics/${x.id}`)} className="hover:underline">
                            {x.text}
                          </Link>
                          <Badge tone={x.canonical ? 'success' : 'neutral'}>{x.canonical ? 'Used in reports' : 'Excluded'}</Badge>
                        </li>
                      ))}
                    </ul>
                  </Panel>
                ) : null}

                <Panel title="Revision history">
                  <ol className="flex flex-col divide-y divide-line text-[13px]">
                    {o.revisions.map((r) => (
                      <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                        <span className="min-w-0">
                          <Link href={wsPath(`/metrics/${r.id}`)} className="font-medium text-fg hover:underline">
                            Revision {r.revisionNo}
                          </Link>
                          <span className="text-fg-2">
                            {' '}
                            · {r.enteredBy?.displayName ?? 'Unknown member'} · {formatDateTime(r.enteredAt, zone)}
                            {r.correctionReason ? ` · ${r.correctionReason}` : ''}
                          </span>
                        </span>
                        <span className="flex items-center gap-2">
                          {r.current ? <Badge tone="info">Viewing</Badge> : null}
                          <QualityBadge quality={r.qualityState} />
                        </span>
                      </li>
                    ))}
                  </ol>
                </Panel>

                {state.correct === '1' && canCorrect ? <CorrectionDrawer o={o} onClose={() => set({ correct: null })} /> : null}
                {dialog === 'review' ? <ReasonDialog o={o} mode="review" onClose={() => setDialog(null)} onConflict={() => setConflict(true)} /> : null}
                {dialog === 'canonical' ? <ReasonDialog o={o} mode="canonical" onClose={() => setDialog(null)} onConflict={() => setConflict(true)} /> : null}
                {dialog === 'reject' ? <ReasonDialog o={o} mode="reject" onClose={() => setDialog(null)} onConflict={() => setConflict(true)} /> : null}
                <ConflictDialog
                  open={conflict}
                  onOpenChange={setConflict}
                  onReload={() => {
                    setConflict(false);
                    void q.refetch();
                  }}
                />
              </div>
            );
          })()
        : null}
    </QueryState>
  );
};

/** Review Correction: current and proposed values side by side; the approver is never the submitter. */
const PendingCorrection = ({ o, onConflict, onReject }: { o: ObservationDetail; onConflict: () => void; onReject: () => void }) => {
  const { workspace, user } = useWorkspace();
  const pc = o.pendingCorrection!;
  const [error, setError] = useState<string | null>(null);
  const approve = useInsightsMutation(M.approveRevision, { successMessage: 'Correction approved' });
  return (
    <Panel
      title="Correction awaiting review"
      description={`${pc.enteredBy?.displayName ?? 'A member'} · ${formatDateTime(pc.enteredAt, user.timezone)}. The current values stay in use until the correction is approved.`}
      actions={
        o.permissions.approve ? (
          <>
            <Button onClick={onReject}>Reject</Button>
            <Button
              variant="primary"
              loading={approve.isPending}
              onClick={async () => {
                setError(null);
                try {
                  await approve.run({ params: { workspaceId: workspace.id, revisionId: pc.id }, body: {} }, { ifMatch: pc.rowVersion });
                } catch (e) {
                  if (isApiError(e) && e.code === 'VERSION_CONFLICT') onConflict();
                  else setError(errorMessage(e));
                }
              }}
            >
              Approve Correction
            </Button>
          </>
        ) : undefined
      }
    >
      {pc.correctionReason ? <p className="mb-3 text-[13px] text-fg">Reason: {pc.correctionReason}</p> : null}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[420px] text-left text-[13px]">
          <caption className="sr-only">Changed values</caption>
          <thead>
            <tr className="border-b border-line">
              <th scope="col" className="py-2 pr-3 font-[550] text-fg-2">
                Metric
              </th>
              <th scope="col" className="py-2 pr-3 text-right font-[550] text-fg-2">
                Current
              </th>
              <th scope="col" className="py-2 pr-3 text-right font-[550] text-fg-2">
                Proposed
              </th>
            </tr>
          </thead>
          <tbody>
            {pc.diff.map((d) => (
              <tr key={d.metricKey} className="border-b border-line last:border-b-0">
                <th scope="row" className="py-2 pr-3 font-normal text-fg">
                  {d.label}
                </th>
                <td className="py-2 pr-3 text-right">{d.from ? <ObservationValue availability={d.from.availability} value={d.from.value} /> : <span className="text-fg-muted">Not recorded</span>}</td>
                <td className="py-2 pr-3 text-right font-semibold">{d.to ? <ObservationValue availability={d.to.availability} value={d.to.value} /> : <span className="text-fg-muted">Not recorded</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error ? <p className="mt-2 text-[13px] text-danger">{error}</p> : null}
    </Panel>
  );
};

/** Submit Correction: a new revision of the same key that waits for review (T106). */
const CorrectionDrawer = ({ o, onClose }: { o: ObservationDetail; onClose: () => void }) => {
  const { workspace } = useWorkspace();
  const catalog = useApiQuery(M.catalog, { params: { workspaceId: workspace.id } }, { staleTime: 5 * 60_000 });
  const fields = useMemo(
    () => (catalog.data?.fields ?? []).filter((f) => f.entityType === o.entity.type && f.observationKind === o.kind && f.version === o.definitionSetVersion),
    [catalog.data, o],
  );
  const cellsOf = (x: ObservationDetail) => Object.fromEntries(x.values.map((v) => [v.metricKey, { availability: v.availability as '' | typeof v.availability, value: v.value ?? '', currency: v.currency ?? workspace.baseCurrency }]));
  const [cells, setCells] = useState(() => cellsOf(o));
  // The correction is proposed against the observation as the drawer opened (T162).
  const edit = useEditBase(o, { onReload: (x) => setCells(cellsOf(x)) });
  const shown = edit.start ?? o;
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const revise = useInsightsMutation(M.revise, { successMessage: 'Correction submitted for review' });
  const dirty = reason.length > 0 || JSON.stringify(cells) !== JSON.stringify(cellsOf(shown));
  const submit = async () => {
    setErrors({});
    const values = fields
      .filter((f) => cells[f.key]?.availability)
      .map((f) => ({ metricKey: f.key, availability: cells[f.key]!.availability as 'known', value: cells[f.key]!.availability === 'known' ? cells[f.key]!.value.trim() || null : null, currency: f.valueType === 'money' ? cells[f.key]!.currency : null }));
    try {
      await revise.run({ params: { workspaceId: workspace.id, observationId: o.id }, body: { values, reason, warningNote: note.trim() || null } }, { ifMatch: edit.version });
      onClose();
    } catch (e) {
      if (edit.catchConflict(e)) return;
      if (isApiError(e) && e.fieldErrors.length) {
        const out: Record<string, string> = {};
        for (const fe of e.fieldErrors) {
          const field = fe.field.replace(/^body\./, '');
          const m = /^values\.(\d+)\./.exec(field);
          out[m ? `value:${values[Number(m[1])]?.metricKey}` : field] ??= fe.message;
        }
        setErrors(out);
      } else setErrors({ form: errorMessage(e) });
    }
  };
  return (
    <>
      <Drawer
        open
        onOpenChange={(v) => !v && onClose()}
        width={760}
        dirty={dirty}
        title="Submit Correction"
        description="The corrected values wait for review; the current values stay in use until an approver accepts them."
        footer={
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" loading={revise.isPending} onClick={() => void submit()}>
              Submit Correction
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <ValuesEditor fields={fields} cells={cells} errors={errors} currency={workspace.baseCurrency} onChange={(key, patch) => setCells((c) => ({ ...c, [key]: { availability: '', value: '', currency: workspace.baseCurrency, ...c[key], ...patch } }))} />
          {errors.values ? <p className="text-[13px] text-danger">{errors.values}</p> : null}
          <Field label="Reason for the correction" required error={errors.reason}>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={1000} />
          </Field>
          {errors.warningNote ? (
            <Field label="Note about the warning" required error={errors.warningNote}>
              <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={1000} />
            </Field>
          ) : null}
          {errors.form ? <Banner tone="danger">{errors.form}</Banner> : null}
        </div>
      </Drawer>
      <ConflictDialog {...edit.conflictDialog} />
    </>
  );
};

/** Mark Reviewed (optional note), Use in / Exclude from Reports (reason) and Reject Correction (reason). */
const ReasonDialog = ({ o, mode, onClose, onConflict }: { o: ObservationDetail; mode: 'review' | 'canonical' | 'reject'; onClose: () => void; onConflict: () => void }) => {
  const { workspace } = useWorkspace();
  const p = { workspaceId: workspace.id };
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const review = useInsightsMutation(M.markReviewed, { successMessage: 'Marked as reviewed' });
  const canonical = useInsightsMutation(M.setCanonical, { successMessage: o.canonical ? 'Excluded from reports' : 'Used in reports' });
  const reject = useInsightsMutation(M.rejectRevision, { successMessage: 'Correction rejected' });
  const copy = {
    review: { title: 'Mark Reviewed', description: 'Confirm that the values match the source. Another member than the one who entered them must review.', field: 'Note (optional)', action: 'Mark Reviewed', required: false },
    canonical: {
      title: o.canonical ? 'Exclude from Reports' : 'Use in Reports',
      description: o.canonical ? 'Reports stop using this record. The record itself stays unchanged.' : 'Reports use this record instead of the other source for the same moment or period.',
      field: 'Reason',
      action: o.canonical ? 'Exclude from Reports' : 'Use in Reports',
      required: true,
    },
    reject: { title: 'Reject Correction', description: 'The proposed values are not applied; the member who submitted them is notified with your reason.', field: 'Reason', action: 'Reject Correction', required: true },
  }[mode];
  const pending = review.isPending || canonical.isPending || reject.isPending;
  const submit = async () => {
    setError(null);
    if (copy.required && text.trim().length < 3) return setError('Enter a reason.');
    try {
      if (mode === 'review') await review.run({ params: { ...p, observationId: o.id }, body: { note: text.trim() || undefined } }, { ifMatch: o.rowVersion });
      if (mode === 'canonical') await canonical.run({ params: { ...p, observationId: o.id }, body: { canonical: !o.canonical, reason: text.trim() } }, { ifMatch: o.rowVersion });
      if (mode === 'reject') await reject.run({ params: { ...p, revisionId: o.pendingCorrection!.id }, body: { reason: text.trim() } }, { ifMatch: o.pendingCorrection!.rowVersion });
      onClose();
    } catch (e) {
      if (isApiError(e) && e.code === 'VERSION_CONFLICT') {
        onClose();
        onConflict();
      } else setError(errorMessage(e));
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(v) => !v && onClose()}
      size="small"
      title={copy.title}
      description={copy.description}
      dirty={text.length > 0}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant={mode === 'reject' ? 'danger' : 'primary'} loading={pending} onClick={() => void submit()}>
            {copy.action}
          </Button>
        </>
      }
    >
      <Field label={copy.field} required={copy.required} error={error}>
        <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={1000} />
      </Field>
    </Dialog>
  );
};
