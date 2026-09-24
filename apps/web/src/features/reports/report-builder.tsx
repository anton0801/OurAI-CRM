'use client';
import { useRouter } from 'next/navigation';
import { DotsThree } from '@phosphor-icons/react';
import { useMemo, useState } from 'react';
import { reportEndpoints as R, type ReportConfig, type ReportDatasetInfo, type ReportDetail, type ReportResult } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { CONTENT_FORMATS, PERIOD_PRESETS, PLATFORMS, REPORT_CHART_TYPES, REPORT_LIMITS, TIME_GRAINS } from '@castlane/domain';
import { Badge, Banner, Button, DateInput, Drawer, Field, IconButton, Input, Menu, MultiSelect, PageHeader, Panel, PermissionDenied, Select, Skeleton, Textarea, formatDateTime } from '@castlane/ui';
import { ConflictDialog } from '@/components/common/conflict';
import { MultiEntitySelect } from '@/components/common/entity-select';
import { MultiMemberSelect } from '@/components/common/pickers';
import { QueryState } from '@/components/common/query-state';
import { useApiMutation, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';
import { errorMessage, useInsightsMutation } from '../metrics/common';
import '../metrics/labels';
import { ResultView } from './result-view';
import { ScheduleDialog, SchedulesList, ShareDialog } from './report-dialogs';

type Dim = ReportConfig['dimensions'][number];
const RELATIVE = PERIOD_PRESETS.filter((p) => p !== 'custom');

const defaultConfig = (dataset: ReportConfig['dataset']): ReportConfig => ({
  dataset,
  dimensions: [],
  metrics: [],
  filters: {},
  timeGrain: 'week',
  sort: [],
  chart: 'table',
  datePolicy: { kind: 'relative', preset: 'last_30_days' },
});

export const NewReportScreen = () => {
  const can = useCan();
  if (!can('reports.create')) return <PermissionDenied description="You can open reports shared with you but not create new ones." />;
  return <ReportEditor />;
};

export const ReportScreen = ({ reportId }: { reportId: string }) => {
  const { workspace } = useWorkspace();
  const q = useApiQuery(R.get, { params: { workspaceId: workspace.id, reportId } });
  return <QueryState query={q}>{q.data ? <ReportEditor key={`${q.data.id}:${q.data.rowVersion}`} report={q.data} /> : null}</QueryState>;
};

/** S52 Report Builder: dataset → metrics (≤8) → dimensions (≤3) → filters, period, chart; preview, save, share, schedule, snapshot, export. */
const ReportEditor = ({ report }: { report?: ReportDetail }) => {
  const { workspace } = useWorkspace();
  const can = useCan();
  const router = useRouter();
  const wsPath = useWsPath();
  const p = { workspaceId: workspace.id };
  const datasets = useApiQuery(R.datasets, { params: p }, { staleTime: 5 * 60_000 });
  const [name, setName] = useState(report?.name ?? '');
  const [config, setConfig] = useState<ReportConfig | null>(report?.config ?? null);
  const [changeNote, setChangeNote] = useState('');
  const [preview, setPreview] = useState<ReportResult | null>(null);
  const [errors, setErrors] = useState<{ field: string; message: string }[]>([]);
  const [dialog, setDialog] = useState<null | 'share' | 'schedule' | 'versions'>(null);
  const [conflict, setConflict] = useState(false);
  const saved = useApiQuery(R.run, { params: { ...p, reportId: report?.id ?? '' }, body: {} }, { enabled: !!report && report.datasetAvailable && !report.archivedAt });
  const previewM = useApiMutation(R.preview, { silentErrors: true });
  const create = useInsightsMutation(R.create, { successMessage: 'Report saved' });
  const update = useInsightsMutation(R.update, { successMessage: 'Report saved as a new version' });
  const duplicate = useInsightsMutation(R.duplicate, { successMessage: 'Report duplicated' });
  const snapshot = useInsightsMutation(R.snapshot, { successMessage: 'Snapshot saved' });
  const archive = useInsightsMutation(R.archive, { successMessage: 'Report archived' });
  const restore = useInsightsMutation(R.restore, { successMessage: 'Report restored' });

  const list = datasets.data ?? [];
  const cfg = config ?? (list[0] ? defaultConfig(list[0].key) : null);
  const ds = list.find((d) => d.key === cfg?.dataset) ?? null;
  const editable = !report || report.permissions.edit;
  const setCfg = (patch: Partial<ReportConfig>) => {
    if (!cfg) return;
    setConfig({ ...cfg, ...patch });
    setErrors([]);
  };

  const fail = (e: unknown) => {
    if (isApiError(e) && e.code === 'VERSION_CONFLICT') return setConflict(true);
    if (isApiError(e) && e.fieldErrors.length) return setErrors(e.fieldErrors.map((f) => ({ field: f.field, message: f.message })));
    setErrors([{ field: 'form', message: errorMessage(e) }]);
  };
  const runPreview = async () => {
    if (!cfg) return;
    try {
      setPreview(await previewM.run({ params: p, body: { config: cfg } }));
      setErrors([]);
    } catch (e) {
      fail(e);
    }
  };
  const save = async () => {
    if (!cfg) return;
    if (!name.trim()) return setErrors([{ field: 'name', message: 'Name the report.' }]);
    try {
      if (!report) {
        const r = await create.run({ params: p, body: { name: name.trim(), config: cfg } });
        router.push(wsPath(`/reports/${r.id}`));
      } else {
        await update.run({ params: { ...p, reportId: report.id }, body: { name: name.trim(), config: cfg, changeNote: changeNote.trim() || undefined } }, { ifMatch: report.rowVersion });
        setChangeNote('');
      }
    } catch (e) {
      fail(e);
    }
  };

  if (datasets.isLoading) return <Skeleton className="h-[480px] w-full" />;
  if (!list.length) return <PermissionDenied description="Your role has no report datasets." />;
  if (!cfg || !ds) return null;
  const result = preview ?? saved.data ?? null;
  const dirty = !!report && (name !== report.name || JSON.stringify(cfg) !== JSON.stringify(report.config));

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        crumbs={[{ label: 'Reports', href: wsPath('/reports') }, { label: report?.name ?? 'New Report' }]}
        title={report?.name ?? 'New Report'}
        meta={
          report ? (
            <>
              <Badge tone={report.sharing === 'shared' ? 'info' : 'neutral'}>{label('reportSharing', report.sharing)}</Badge>
              <span className="text-[13px] text-fg-2">
                Version {report.configVersion} · owner {report.owner.displayName}
              </span>
              {report.archivedAt ? <Badge tone="warning">Archived</Badge> : null}
            </>
          ) : undefined
        }
        actions={
          <>
            {editable && !report?.archivedAt ? (
              <Button variant="primary" loading={create.isPending || update.isPending} onClick={() => void save()}>
                {report ? 'Save Changes' : 'Save Report'}
              </Button>
            ) : null}
            {report && report.permissions.snapshot && !report.archivedAt ? (
              <Button
                loading={snapshot.isPending}
                onClick={async () => {
                  try {
                    const s = await snapshot.run({ params: { ...p, reportId: report.id }, body: {} });
                    router.push(wsPath(`/reports/snapshots/${s.id}`));
                  } catch (e) {
                    fail(e);
                  }
                }}
              >
                Save Snapshot
              </Button>
            ) : null}
            {report ? (
              <Menu
                label="More report actions"
                trigger={<IconButton label="More" variant="secondary" icon={<DotsThree size={18} weight="bold" />} />}
                items={[
                  { label: 'Share', onSelect: () => setDialog('share'), hidden: !report.permissions.share || !!report.archivedAt },
                  { label: 'Schedule', onSelect: () => setDialog('schedule'), hidden: !report.permissions.schedule || !!report.archivedAt },
                  {
                    label: 'Export CSV or XLSX',
                    href: wsPath(`/exports?new=1&dataset=report_result&prefill=${encodeURIComponent(`reportId=${report.id}`)}`),
                    hidden: !report.permissions.export,
                  },
                  {
                    label: 'Duplicate',
                    hidden: !report.permissions.duplicate,
                    onSelect: async () => {
                      try {
                        const d = await duplicate.run({ params: { ...p, reportId: report.id }, body: {} });
                        router.push(wsPath(`/reports/${d.id}`));
                      } catch (e) {
                        fail(e);
                      }
                    },
                  },
                  { label: 'Version History', onSelect: () => setDialog('versions') },
                  {
                    label: report.archivedAt ? 'Restore' : 'Archive',
                    separatorBefore: true,
                    destructive: !report.archivedAt,
                    hidden: !report.permissions.archive,
                    onSelect: async () => {
                      try {
                        if (report.archivedAt) await restore.run({ params: { ...p, reportId: report.id } }, { ifMatch: report.rowVersion });
                        else await archive.run({ params: { ...p, reportId: report.id }, body: {} }, { ifMatch: report.rowVersion });
                      } catch (e) {
                        fail(e);
                      }
                    },
                  },
                ]}
              />
            ) : null}
          </>
        }
      />
      {report && !report.datasetAvailable ? <Banner tone="warning">You no longer have access to the data of this report. Ask its owner, or duplicate it with a dataset you can use.</Banner> : null}
      {report && !editable ? <Banner tone="info">This report is shared with you. It shows only the data you have access to; duplicate it to make your own version.</Banner> : null}
      {errors.length ? (
        <Banner tone="danger">
          <ul className="flex flex-col gap-0.5">
            {errors.map((e) => (
              <li key={`${e.field}:${e.message}`}>{e.message}</li>
            ))}
          </ul>
        </Banner>
      ) : null}

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[380px_minmax(0,1fr)]">
        <Panel title="Configuration" bodyClassName="flex flex-col gap-4 p-4">
          <Field label="Report name" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} disabled={!editable} />
          </Field>
          <ConfigForm config={cfg} dataset={ds} datasets={list} onChange={setCfg} disabled={!editable} />
          {report && editable ? (
            <Field label="Change note (optional)" helper="Saved with the new version.">
              <Textarea value={changeNote} onChange={(e) => setChangeNote(e.target.value)} rows={2} maxLength={500} />
            </Field>
          ) : null}
          <Button onClick={() => void runPreview()} loading={previewM.isPending} disabled={!cfg.metrics.length}>
            Preview
          </Button>
          {dirty ? <p className="text-[12px] text-fg-2">Unsaved changes: saving creates version {report!.configVersion + 1}.</p> : null}
        </Panel>
        <div className="flex min-w-0 flex-col gap-4">
          {result ? (
            <ResultView result={result} config={cfg} />
          ) : saved.isLoading ? (
            <Skeleton className="h-[320px] w-full" />
          ) : (
            <Panel>
              <p className="py-10 text-center text-[13px] text-fg-2">{cfg.metrics.length ? 'Preview the report to see its result.' : 'Choose at least one metric, then preview the report.'}</p>
            </Panel>
          )}
          {report ? <SchedulesList report={report} /> : null}
        </div>
      </div>
      {report && dialog === 'share' ? <ShareDialog report={report} onClose={() => setDialog(null)} onConflict={() => setConflict(true)} /> : null}
      {report && dialog === 'schedule' ? <ScheduleDialog report={report} onClose={() => setDialog(null)} /> : null}
      {report && dialog === 'versions' ? (
        <VersionsDrawer
          reportId={report.id}
          onClose={() => setDialog(null)}
          onLoad={(v) => {
            setConfig(v.config);
            setName(v.name);
            setPreview(null);
            setDialog(null);
          }}
          editable={editable}
        />
      ) : null}
      <ConflictDialog open={conflict} onOpenChange={setConflict} onReload={() => window.location.reload()} />
      <span className="sr-only" aria-live="polite">
        {preview ? `Preview updated: ${preview.rowCount} rows.` : ''}
      </span>
    </div>
  );
};

/** Dataset, metrics, dimensions (allowed join graph), filters, period, chart and sort. */
const ConfigForm = ({ config, dataset, datasets, onChange, disabled }: { config: ReportConfig; dataset: ReportDatasetInfo; datasets: ReportDatasetInfo[]; onChange: (p: Partial<ReportConfig>) => void; disabled?: boolean }) => {
  const chosen = dataset.metrics.filter((m) => config.metrics.includes(m.key));
  const allowedDims = useMemo(() => dataset.dimensions.filter((d) => chosen.every((m) => m.dimensions.includes(d.key))), [dataset, chosen]);
  const nonAdditive = chosen.some((m) => !m.additive);
  const hasPeriod = config.dimensions.includes('period');
  const f = config.filters;
  const has = (k: ReportDatasetInfo['filters'][number]) => dataset.filters.includes(k);
  return (
    <div className="flex flex-col gap-4">
      <Field label="Dataset" required helper={dataset.restricted ? 'Restricted data: shared or scheduled reports must be limited to specific projects.' : dataset.description}>
        <Select
          value={config.dataset}
          disabled={disabled}
          onChange={(v) => v && onChange({ ...defaultConfig(v), datePolicy: config.datePolicy })}
          options={datasets.map((d) => ({ value: d.key, label: d.label, description: d.restricted ? 'Restricted' : undefined }))}
        />
      </Field>
      <Field label={`Metrics (up to ${REPORT_LIMITS.maxMetrics})`} required>
        <MultiSelect
          value={config.metrics}
          disabled={disabled}
          max={REPORT_LIMITS.maxMetrics}
          onChange={(v) => {
            const next = dataset.metrics.filter((m) => v.includes(m.key));
            onChange({ metrics: v, dimensions: config.dimensions.filter((d) => next.every((m) => m.dimensions.includes(d))) });
          }}
          options={dataset.metrics.map((m) => ({ value: m.key, label: `${m.label}`, description: m.rate ? 'Rate (weighted, never averaged)' : m.additive ? 'Adds up' : 'Computed per row' }))}
        />
      </Field>
      <Field label={`Dimensions (up to ${REPORT_LIMITS.maxDimensions})`} helper="Only breakdowns every chosen metric supports are offered; facts are aggregated before rows are combined.">
        <MultiSelect
          value={config.dimensions}
          disabled={disabled}
          max={REPORT_LIMITS.maxDimensions}
          onChange={(v) => onChange({ dimensions: v as Dim[], chart: config.chart === 'line' && !v.includes('period') ? 'table' : config.chart })}
          options={dataset.dimensions.map((d) => ({ value: d.key, label: d.label, disabled: !allowedDims.some((a) => a.key === d.key) }))}
        />
      </Field>
      {hasPeriod ? (
        <Field label="Time grain">
          <Select value={config.timeGrain} disabled={disabled} onChange={(v) => v && onChange({ timeGrain: v })} options={TIME_GRAINS.map((g) => ({ value: g, label: label('timeGrain', g) }))} />
        </Field>
      ) : null}
      <Field label="Period">
        <Select
          value={config.datePolicy.kind === 'fixed' ? 'fixed' : config.datePolicy.preset}
          disabled={disabled}
          onChange={(v) => {
            if (!v) return;
            if (v === 'fixed') onChange({ datePolicy: { kind: 'fixed', from: new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) } });
            else onChange({ datePolicy: { kind: 'relative', preset: v as (typeof RELATIVE)[number] } });
          }}
          options={[...RELATIVE.map((p) => ({ value: p as string, label: `${label('periodPreset', p)} (moves with time)` })), { value: 'fixed', label: 'Fixed dates' }]}
        />
      </Field>
      {config.datePolicy.kind === 'fixed' ? (
        <div className="grid grid-cols-2 gap-2">
          <Field label="From">
            <DateInput value={config.datePolicy.from} disabled={disabled} onChange={(e) => e.target.value && config.datePolicy.kind === 'fixed' && onChange({ datePolicy: { ...config.datePolicy, from: e.target.value } })} />
          </Field>
          <Field label="To">
            <DateInput value={config.datePolicy.to} disabled={disabled} onChange={(e) => e.target.value && config.datePolicy.kind === 'fixed' && onChange({ datePolicy: { ...config.datePolicy, to: e.target.value } })} />
          </Field>
        </div>
      ) : null}
      {has('projectIds') ? (
        <Field label="Projects" helper={dataset.restricted ? 'Required before sharing or scheduling this report.' : undefined}>
          <MultiEntitySelect type="project" value={f.projectIds ?? []} disabled={disabled} placeholder="All projects in your access" onChange={(v) => onChange({ filters: { ...f, projectIds: v.length ? v : undefined } })} />
        </Field>
      ) : null}
      {has('accountIds') ? (
        <Field label="Accounts">
          <MultiEntitySelect type="account" value={f.accountIds ?? []} disabled={disabled} placeholder="All accounts" onChange={(v) => onChange({ filters: { ...f, accountIds: v.length ? v : undefined } })} />
        </Field>
      ) : null}
      {has('platforms') ? (
        <Field label="Platforms">
          <MultiSelect value={f.platforms ?? []} disabled={disabled} placeholder="All platforms" onChange={(v) => onChange({ filters: { ...f, platforms: v.length ? v : undefined } })} options={PLATFORMS.map((x) => ({ value: x, label: label('platform', x) }))} />
        </Field>
      ) : null}
      {has('formats') ? (
        <Field label="Content types">
          <MultiSelect value={f.formats ?? []} disabled={disabled} placeholder="All content types" onChange={(v) => onChange({ filters: { ...f, formats: v.length ? v : undefined } })} options={CONTENT_FORMATS.map((x) => ({ value: x, label: label('contentFormat', x) }))} />
        </Field>
      ) : null}
      {has('memberIds') ? (
        <Field label="Members">
          <MultiMemberSelect value={f.memberIds ?? []} disabled={disabled} placeholder="All members" onChange={(v) => onChange({ filters: { ...f, memberIds: v.length ? v : undefined } })} />
        </Field>
      ) : null}
      {has('statuses') && dataset.statusOptions.length ? (
        <Field label="Statuses">
          <MultiSelect value={f.statuses ?? []} disabled={disabled} placeholder="All statuses" onChange={(v) => onChange({ filters: { ...f, statuses: v.length ? v : undefined } })} options={dataset.statusOptions} />
        </Field>
      ) : null}
      <Field label="Chart">
        <Select
          value={config.chart}
          disabled={disabled}
          onChange={(v) => v && onChange({ chart: v })}
          options={REPORT_CHART_TYPES.map((c) => ({
            value: c,
            label: label('reportChart', c),
            disabled: (c === 'line' && !hasPeriod) || (c === 'stacked_bar' && nonAdditive),
            description: c === 'line' && !hasPeriod ? 'Needs the Period dimension' : c === 'stacked_bar' && nonAdditive ? 'Only for metrics that add up' : undefined,
          }))}
        />
      </Field>
      <div className="grid grid-cols-[minmax(0,1fr)_120px] gap-2">
        <Field label="Sort by">
          <Select
            value={config.sort[0]?.key ?? null}
            disabled={disabled}
            clearable
            placeholder="Default"
            onChange={(v) => onChange({ sort: v ? [{ key: v, direction: config.sort[0]?.direction ?? 'desc' }] : [] })}
            options={[...config.dimensions.map((d) => ({ value: d as string, label: dataset.dimensions.find((x) => x.key === d)?.label ?? d })), ...chosen.map((m) => ({ value: m.key, label: m.label }))]}
          />
        </Field>
        <Field label="Direction">
          <Select
            value={config.sort[0]?.direction ?? 'desc'}
            disabled={disabled || !config.sort.length}
            onChange={(v) => v && config.sort[0] && onChange({ sort: [{ key: config.sort[0].key, direction: v }] })}
            options={[
              { value: 'desc', label: 'Descending' },
              { value: 'asc', label: 'Ascending' },
            ]}
          />
        </Field>
      </div>
    </div>
  );
};

const VersionsDrawer = ({ reportId, onClose, onLoad, editable }: { reportId: string; onClose: () => void; onLoad: (v: { name: string; config: ReportConfig }) => void; editable: boolean }) => {
  const { workspace, user } = useWorkspace();
  const q = useApiQuery(R.versions, { params: { workspaceId: workspace.id, reportId } });
  return (
    <Drawer open onOpenChange={(v) => !v && onClose()} title="Version History" description="Every saved configuration is kept. Loading a version puts it in the editor; saving creates a new version.">
      <QueryState query={q}>
        <ol className="flex flex-col divide-y divide-line text-[13px]">
          {(q.data ?? []).map((v) => (
            <li key={v.versionNo} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="min-w-0">
                <span className="font-medium text-fg">Version {v.versionNo}</span>
                <span className="block text-fg-2">
                  {v.createdBy?.displayName ?? 'Unknown member'} · {formatDateTime(v.createdAt, user.timezone)}
                  {v.changeNote ? ` · ${v.changeNote}` : ''}
                </span>
              </span>
              {editable ? (
                <Button size="sm" onClick={() => onLoad(v)}>
                  Load
                </Button>
              ) : null}
            </li>
          ))}
        </ol>
      </QueryState>
    </Drawer>
  );
};
