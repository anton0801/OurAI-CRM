'use client';
import { FileText, Plus } from '@phosphor-icons/react';
import { useState } from 'react';
import {
  campaignEndpoints as C,
  sourceReportEndpoints as SR,
  trackingLinkEndpoints as TL,
  type CampaignDetail,
  type CampaignResults,
  type SourceReportRow,
} from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { ATTRIBUTION_TYPES, PUBLICATION_STATUSES } from '@castlane/domain';
import { Badge, Banner, BarChart, Button, DataTable, DateTimeInput, DescriptionList, Dialog, EmptyState, Field, Input, Panel, Select, Textarea, formatDateTime, type Column } from '@castlane/ui';
import { ConflictDialog } from '@/components/common/conflict';
import { QueryState } from '@/components/common/query-state';
import { AssetThumb, FileUploader } from '@/components/media/file-uploader';
import { useApiMutation, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useWorkspace } from '@/lib/workspace-context';
import { fromLocalInput, toLocalInput } from '@/features/tasks/format';
import { CAMPAIGN_INVALIDATE, RESULTS_NOTE } from './labels';

const SourceValue = ({ v }: { v: CampaignResults['totals']['clicks'] }) =>
  v.value !== null ? <span className="font-mono tabular-nums">{v.value}</span> : <span className="text-fg-muted" title={v.note ?? undefined}>{v.note ?? 'Not reported'}</span>;

/** S34 Results tab: placements by status and source-reported values only (never derived from tagged links). */
export const CampaignResultsTab = ({ campaign: c }: { campaign: CampaignDetail }) => {
  const { workspace, user } = useWorkspace();
  const results = useApiQuery(C.results, { params: { workspaceId: workspace.id, campaignId: c.id } });
  const reports = useApiQuery(SR.list, { params: { workspaceId: workspace.id, campaignId: c.id } });
  const [editing, setEditing] = useState<SourceReportRow | 'new' | null>(null);
  const canManage = c.permissions.manageReports && c.status !== 'archived';

  const reportColumns: Column<SourceReportRow>[] = [
    { key: 'source', header: 'Source', sticky: true, minWidth: 160, cell: (r) => <span className="font-medium text-fg">{r.sourceName}</span> },
    { key: 'period', header: 'Period', minWidth: 240, cell: (r) => `${formatDateTime(r.periodStart, user.timezone)} – ${formatDateTime(r.periodEnd, user.timezone)}` },
    { key: 'clicks', header: 'Clicks', align: 'right', minWidth: 90, cell: (r) => (r.clicks === null ? <span className="text-fg-muted">Not reported</span> : r.clicks) },
    { key: 'conversions', header: 'Conversions', align: 'right', minWidth: 110, cell: (r) => (r.conversions === null ? <span className="text-fg-muted">Not reported</span> : r.conversions) },
    { key: 'attribution', header: 'Attribution', minWidth: 170, cell: (r) => <Badge tone={r.attributionLabel === 'source_reported' ? 'success' : 'warning'}>{label('attribution', r.attributionLabel)}</Badge> },
    { key: 'link', header: 'Tagged link', minWidth: 140, cell: (r) => r.trackingLink?.label ?? <span className="text-fg-muted">—</span> },
    {
      key: 'evidence',
      header: 'Evidence',
      minWidth: 90,
      cell: (r) => (r.evidenceAssetId ? <AssetThumb workspaceId={workspace.id} assetId={r.evidenceAssetId} size={64} className="h-8 w-8" alt={`Evidence for ${r.sourceName}`} /> : <span className="text-fg-muted">—</span>),
    },
    { key: 'by', header: 'Entered by', minWidth: 140, cell: (r) => r.enteredBy?.displayName ?? <span className="text-fg-muted">—</span> },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      minWidth: 90,
      hidden: !canManage,
      cell: (r) => (
        <Button size="sm" variant="ghost" onClick={() => setEditing(r)}>
          Correct
        </Button>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13px] text-fg-2">{RESULTS_NOTE}</p>
      <QueryState query={results}>
        {results.data ? (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Panel title="Placements">
              <DescriptionList
                columns={1}
                items={[
                  ...PUBLICATION_STATUSES.map((s) => ({ label: label('publicationStatus', s), value: results.data!.publications[s] ?? 0 })),
                  { label: 'Removed or unavailable', value: results.data.removedOrUnavailable },
                ]}
              />
            </Panel>
            <Panel title="Reported totals" className="lg:col-span-2">
              <DescriptionList
                items={[
                  { label: 'Clicks', value: <SourceValue v={results.data.totals.clicks} /> },
                  { label: 'Conversions', value: <SourceValue v={results.data.totals.conversions} /> },
                  { label: 'Tagged links', value: results.data.trackingLinks },
                  { label: 'Goals', value: results.data.goals.length ? results.data.goals.map((g) => `${g.metricKey}: ${g.target} ${g.unit}`).join(' · ') : null },
                ]}
              />
              {results.data.sources.length ? (
                <div className="mt-4">
                  <BarChart
                    title="Reported values by source"
                    data={results.data.sources.map((s, i) => ({
                      key: `${s.sourceName}-${i}`,
                      label: s.sourceName,
                      values: { clicks: s.clicks.value === null ? null : Number(s.clicks.value), conversions: s.conversions.value === null ? null : Number(s.conversions.value) },
                    }))}
                    series={[
                      { key: 'clicks', label: 'Clicks' },
                      { key: 'conversions', label: 'Conversions' },
                    ]}
                    height={220}
                  />
                </div>
              ) : null}
            </Panel>
            <Panel title="By source" className="lg:col-span-3">
              {results.data.sources.length ? (
                <DataTable
                  caption="Results by source"
                  rows={results.data.sources}
                  getRowId={(s) => `${s.sourceName}-${s.attributionLabel}`}
                  density={user.density}
                  columns={[
                    { key: 'source', header: 'Source', sticky: true, minWidth: 160, cell: (s) => <span className="font-medium text-fg">{s.sourceName}</span> },
                    { key: 'attribution', header: 'Attribution', minWidth: 170, cell: (s) => label('attribution', s.attributionLabel) },
                    { key: 'reports', header: 'Reports', align: 'right', minWidth: 80, cell: (s) => s.reports },
                    { key: 'clicks', header: 'Clicks', align: 'right', minWidth: 120, cell: (s) => <SourceValue v={s.clicks} /> },
                    { key: 'conversions', header: 'Conversions', align: 'right', minWidth: 120, cell: (s) => <SourceValue v={s.conversions} /> },
                    { key: 'rate', header: 'Conversion rate', align: 'right', minWidth: 140, cell: (s) => (s.conversionRate.value !== null ? `${s.conversionRate.value}%` : <SourceValue v={s.conversionRate} />) },
                    {
                      key: 'period',
                      header: 'Period',
                      minWidth: 220,
                      cell: (s) => (
                        <span className="flex flex-col">
                          <span>
                            {formatDateTime(s.periodStart, user.timezone)} – {formatDateTime(s.periodEnd, user.timezone)}
                          </span>
                          {s.overlapping ? <span className="text-[12px] text-warning">Reports overlap; values are not added together.</span> : null}
                        </span>
                      ),
                    },
                  ]}
                />
              ) : (
                <p className="text-[14px] text-fg-2">No source reports yet. Add the values a platform, partner or shop reported for this campaign.</p>
              )}
            </Panel>
          </div>
        ) : null}
      </QueryState>
      <Panel
        title="Source reports"
        actions={
          canManage ? (
            <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={() => setEditing('new')}>
              Add Source Report
            </Button>
          ) : undefined
        }
      >
        <QueryState query={reports}>
          {reports.data && reports.data.length ? (
            <DataTable caption="Source reports" rows={reports.data} columns={reportColumns} getRowId={(r) => r.id} density={user.density} />
          ) : (
            <EmptyState
              icon={<FileText size={28} />}
              title="No source reports"
              description="Clicks and conversions appear only from reports you enter, with the period they cover and an attribution label."
              action={canManage ? <Button variant="primary" onClick={() => setEditing('new')}>Add Source Report</Button> : undefined}
            />
          )}
        </QueryState>
      </Panel>
      {editing ? <SourceReportDialog campaign={c} report={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
    </div>
  );
};

const toInt = (v: string): number | null | 'invalid' => {
  const t = v.trim();
  if (!t) return null;
  return /^\d{1,13}$/.test(t) ? Number(t) : 'invalid';
};

/** Add Source Report / Correct: a period, values (empty = not reported) and a required attribution label. */
const SourceReportDialog = ({ campaign: c, report, onClose }: { campaign: CampaignDetail; report: SourceReportRow | null; onClose: () => void }) => {
  const { workspace, user } = useWorkspace();
  const tz = user.timezone;
  const links = useApiQuery(TL.list, { params: { workspaceId: workspace.id }, query: { campaignId: c.id } });
  const [sourceName, setSourceName] = useState(report?.sourceName ?? '');
  const [start, setStart] = useState(toLocalInput(report?.periodStart ?? null, tz));
  const [end, setEnd] = useState(toLocalInput(report?.periodEnd ?? null, tz));
  const [clicks, setClicks] = useState(report?.clicks?.toString() ?? '');
  const [conversions, setConversions] = useState(report?.conversions?.toString() ?? '');
  const [attribution, setAttribution] = useState<SourceReportRow['attributionLabel']>(report?.attributionLabel ?? 'source_reported');
  const [trackingLinkId, setLinkId] = useState<string | null>(report?.trackingLink?.id ?? null);
  const [evidence, setEvidence] = useState<string | null>(report?.evidenceAssetId ?? null);
  const [note, setNote] = useState(report?.note ?? '');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const create = useApiMutation(SR.create, { invalidate: CAMPAIGN_INVALIDATE, silentErrors: true, successMessage: 'Source report added' });
  const update = useApiMutation(SR.update, { invalidate: CAMPAIGN_INVALIDATE, silentErrors: true, successMessage: 'Source report corrected' });
  const pending = create.isPending || update.isPending;

  const submit = async () => {
    const next: Record<string, string> = {};
    const cl = toInt(clicks);
    const cv = toInt(conversions);
    const periodStart = fromLocalInput(start, tz);
    const periodEnd = fromLocalInput(end, tz);
    if (sourceName.trim().length < 2) next.sourceName = 'Name the source (2–120 characters).';
    if (!periodStart) next.periodStart = 'Choose when the reported period starts.';
    if (!periodEnd) next.periodEnd = 'Choose when the reported period ends.';
    else if (periodStart && periodEnd <= periodStart) next.periodEnd = 'The period must end after it starts.';
    if (cl === 'invalid') next.clicks = 'Enter a whole number, or leave it empty.';
    if (cv === 'invalid') next.conversions = 'Enter a whole number, or leave it empty.';
    if (cl === null && cv === null) next.clicks = 'Enter at least one reported value. Leave a value empty when the source does not report it.';
    if (attribution === 'manual_assignment' && !note.trim()) next.note = 'Explain the manual assignment (who assigned it and why).';
    if (report && reason.trim().length < 3) next.reason = 'Give a reason for the correction (at least 3 characters).';
    setErrors(next);
    setError(null);
    if (Object.keys(next).length) return;
    const body = {
      sourceName: sourceName.trim(),
      periodStart: periodStart!,
      periodEnd: periodEnd!,
      clicks: cl as number | null,
      conversions: cv as number | null,
      attributionLabel: attribution,
      trackingLinkId,
      evidenceAssetId: evidence,
      note: note.trim() || null,
    };
    try {
      if (report) await update.run({ params: { workspaceId: workspace.id, reportId: report.id }, body: { ...body, reason: reason.trim() } }, { ifMatch: report.rowVersion });
      else await create.run({ params: { workspaceId: workspace.id, campaignId: c.id }, body });
      onClose();
    } catch (e) {
      if (isApiError(e) && e.code === 'VERSION_CONFLICT') setConflict(true);
      else if (isApiError(e) && e.fieldErrors.length) setErrors(Object.fromEntries(e.fieldErrors.map((f) => [f.field.replace(/^body\./, ''), f.message])));
      else setError(isApiError(e) ? e.message : 'The report could not be saved.');
    }
  };

  return (
    <>
      <Dialog
        open
        onOpenChange={(o) => !o && onClose()}
        title={report ? 'Correct source report' : 'Add Source Report'}
        description="Enter the values exactly as the source reported them. Castlane does not count clicks itself."
        dirty={!!sourceName || !!clicks || !!conversions}
        footer={
          <>
            <Button onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button variant="primary" loading={pending} onClick={() => void submit()}>
              {report ? 'Save Correction' : 'Add Report'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {error ? <Banner tone="danger">{error}</Banner> : null}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Source" required error={errors.sourceName} helper="e.g. Shop dashboard, partner report, link shortener.">
              <Input value={sourceName} onChange={(e) => setSourceName(e.target.value)} maxLength={120} autoFocus />
            </Field>
            <Field label="Attribution" required error={errors.attributionLabel}>
              <Select value={attribution} onChange={(v) => v && setAttribution(v)} options={ATTRIBUTION_TYPES.map((a) => ({ value: a, label: label('attribution', a) }))} />
            </Field>
            <Field label="Period start" required error={errors.periodStart}>
              <DateTimeInput value={start} onChange={(e) => setStart(e.target.value)} timezone={tz} />
            </Field>
            <Field label="Period end" required error={errors.periodEnd} helper="Reports cannot cover a future period.">
              <DateTimeInput value={end} onChange={(e) => setEnd(e.target.value)} timezone={tz} />
            </Field>
            <Field label="Clicks" error={errors.clicks} helper="Empty = not reported (not zero).">
              <Input value={clicks} onChange={(e) => setClicks(e.target.value)} inputMode="numeric" />
            </Field>
            <Field label="Conversions" error={errors.conversions} helper="Empty = not reported (not zero).">
              <Input value={conversions} onChange={(e) => setConversions(e.target.value)} inputMode="numeric" />
            </Field>
            <Field label="Tagged link" error={errors.trackingLinkId} className="sm:col-span-2">
              <Select value={trackingLinkId} onChange={setLinkId} clearable placeholder="Not tied to a tagged link" options={(links.data ?? []).map((l) => ({ value: l.id, label: l.label, description: l.builtUrl }))} />
            </Field>
          </div>
          <Field label="Note" required={attribution === 'manual_assignment'} error={errors.note} helper={attribution === 'manual_assignment' ? 'Who assigned the values and why.' : 'Optional.'}>
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={2000} />
          </Field>
          <div className="flex flex-col gap-2">
            <span className="text-[14px] font-medium text-fg">Evidence</span>
            {evidence ? (
              <div className="flex items-center gap-3">
                <AssetThumb workspaceId={workspace.id} assetId={evidence} size={64} className="h-12 w-12" alt="Report evidence" />
                <Button size="sm" variant="ghost" onClick={() => setEvidence(null)}>
                  Remove
                </Button>
              </div>
            ) : (
              <FileUploader
                workspaceId={workspace.id}
                purpose="evidence"
                projectId={c.projects[0]?.id ?? null}
                multiple={false}
                compact
                label="Upload Screenshot or Export"
                hint="Optional proof of the reported values."
                onUploaded={(u) => u.assetId && setEvidence(u.assetId)}
              />
            )}
            {errors.evidenceAssetId ? <span className="text-[13px] text-danger">{errors.evidenceAssetId}</span> : null}
          </div>
          {report ? (
            <Field label="Reason for correction" required error={errors.reason}>
              <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={2000} />
            </Field>
          ) : null}
        </div>
      </Dialog>
      <ConflictDialog open={conflict} onOpenChange={setConflict} onReload={() => window.location.reload()} />
    </>
  );
};
