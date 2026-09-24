'use client';
import Link from 'next/link';
import { ArrowCounterClockwise, CheckCircle, DownloadSimple, FloppyDisk, WarningCircle } from '@phosphor-icons/react';
import { useEffect, useMemo, useState } from 'react';
import { entityHref, importEndpoints, type ImportDatasetInfo, type ImportJobDetail, type ImportOptionsInput, type ImportRowItem } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import {
  Badge,
  Banner,
  Button,
  Checkbox,
  ConfirmDialog,
  DataTable,
  Dialog,
  Field,
  Input,
  KpiStrip,
  PageHeader,
  Panel,
  RadioGroup,
  Select,
  StatusBadge,
  Switch,
  Tabs,
  formatBytes,
  formatDateTime,
  type Column,
} from '@castlane/ui';
import { ConflictDialog } from '@/components/common/conflict';
import { QueryState } from '@/components/common/query-state';
import { useApiInfinite, useApiMutation, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useWorkspace } from '@/lib/workspace-context';
import '../inbox/labels';

const BUSY = new Set(['uploaded', 'validating', 'committing']);
const DATASET_ENTITY: Record<string, string> = { projects: 'project', accounts: 'account', tasks: 'task', references: 'reference', metric_observations: 'metric_observation', ofm_contacts: 'ofm_contact', financial_drafts: 'financial_entry' };

const STEPS = [
  { key: 'upload', label: 'Upload', states: ['uploaded'] },
  { key: 'map', label: 'Map & Validate', states: ['parsed', 'validating', 'needs_revalidation', 'failed'] },
  { key: 'review', label: 'Review', states: ['validated'] },
  { key: 'confirm', label: 'Import', states: ['committing'] },
  { key: 'result', label: 'Result', states: ['committed', 'undone'] },
];

/** Import job detail: mapping, options, immutable validation report, preview, confirm, result and undo. */
export const ImportJobView = ({ importId }: { importId: string }) => {
  const { workspace, user } = useWorkspace();
  const params = { workspaceId: workspace.id, importId };
  const job = useApiQuery(importEndpoints.get, { params }, { refetchInterval: (q) => (q.state.data && BUSY.has(q.state.data.state) ? 2000 : false) });
  const datasets = useApiQuery(importEndpoints.datasets, { params: { workspaceId: workspace.id } }, { staleTime: 60_000 });
  const j = job.data;
  const d = datasets.data?.find((x) => x.key === j?.dataset);
  const stepIndex = j ? STEPS.findIndex((s) => s.states.includes(j.state)) : -1;
  return (
    <QueryState query={job}>
      {j ? (
        <div className="flex flex-col gap-5">
          <PageHeader
            title={j.fileName}
            crumbs={[{ label: 'Import Center' }, { label: j.datasetLabel }]}
            meta={
              <>
                <StatusBadge status={j.state} label={label('importState', j.state)} />
                <span className="text-[13px] text-fg-2">
                  {j.datasetLabel} · {j.fileKind.toUpperCase()} · {formatBytes(j.byteSize)}
                  {j.rowCount !== null ? ` · ${j.rowCount.toLocaleString('en-US')} rows` : ''} · uploaded {formatDateTime(j.createdAt, user.timezone)} by {j.requestedBy.displayName}
                </span>
              </>
            }
            actions={j.permissions.cancel ? <CancelImport job={j} /> : undefined}
          />
          <ol className="flex flex-wrap gap-2 text-[12px]" aria-label="Import steps">
            {STEPS.map((s, i) => (
              <li key={s.key} aria-current={i === stepIndex ? 'step' : undefined} className={`rounded-[6px] border px-2 py-1 ${i === stepIndex ? 'border-primary bg-selection text-fg' : i < stepIndex ? 'border-line text-fg-2' : 'border-line text-fg-muted'}`}>
                {i + 1}. {s.label}
              </li>
            ))}
          </ol>
          {j.progress ? (
            <Banner tone="info">
              <span aria-live="polite">
                {j.state === 'committing' ? 'Importing' : j.state === 'validating' ? 'Validating' : 'Checking the file'} — {j.progress.percent}%{j.progress.note ? ` (${j.progress.note})` : ''}
              </span>
            </Banner>
          ) : BUSY.has(j.state) ? (
            <Banner tone="info">{j.state === 'uploaded' ? 'Your file is being checked and prepared.' : j.state === 'validating' ? 'Validation is queued.' : 'The import is queued.'}</Banner>
          ) : null}
          {j.state === 'needs_revalidation' ? <Banner tone="warning">{j.errorMessage ?? 'Some records changed after validation. Validate again before importing.'}</Banner> : null}
          {j.state === 'failed' ? <Banner tone="danger">{j.errorMessage ?? 'The import failed without changes.'}</Banner> : null}
          {j.state === 'parsed' && j.errorMessage ? <Banner tone="warning">{j.errorMessage}</Banner> : null}
          {j.state === 'cancelled' ? <Banner tone="info">This import was cancelled. No records were changed.</Banner> : null}
          {d && j.permissions.validate ? <MappingPanel job={j} dataset={d} /> : null}
          {j.validationReport && ['validated', 'needs_revalidation', 'committing', 'committed', 'undone'].includes(j.state) ? <ReportPanel job={j} dataset={d} /> : null}
          {j.state === 'validated' ? <ConfirmPanel job={j} /> : null}
          {j.result && (j.state === 'committed' || j.state === 'undone') ? <ResultPanel job={j} /> : null}
        </div>
      ) : null}
    </QueryState>
  );
};

const CancelImport = ({ job }: { job: ImportJobDetail }) => {
  const { workspace } = useWorkspace();
  const [open, setOpen] = useState(false);
  const cancel = useApiMutation(importEndpoints.cancel, { invalidate: ['imports.get', 'imports.list', 'imports.rows'], successMessage: 'Import cancelled. No records were changed.' });
  return (
    <>
      <Button variant="danger-secondary" onClick={() => setOpen(true)}>
        Cancel Import
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Cancel this import?"
        body="The staged rows and the validation report are discarded. No records have been changed."
        confirmLabel="Cancel Import"
        destructive
        loading={cancel.isPending}
        onConfirm={async () => {
          await cancel.run({ params: { workspaceId: workspace.id, importId: job.id }, body: {} }, { ifMatch: job.rowVersion });
          setOpen(false);
        }}
      />
    </>
  );
};

const NOT_IMPORTED = '__none__';

const MappingPanel = ({ job, dataset }: { job: ImportJobDetail; dataset: ImportDatasetInfo }) => {
  const { workspace, user } = useWorkspace();
  const params = { workspaceId: workspace.id, importId: job.id };
  const initialMapping = Object.keys(job.mapping).length ? job.mapping : job.suggestedMapping;
  const [mapping, setMapping] = useState<Record<string, string | null>>(initialMapping);
  const [options, setOptions] = useState<ImportOptionsInput>(() => ({
    timezone: job.options?.timezone ?? user.timezone,
    currency: job.options?.currency,
    dateFormat: job.options?.dateFormat ?? 'iso',
    decimalSeparator: job.options?.decimalSeparator ?? '.',
    duplicatePolicy: job.options?.duplicatePolicy ?? dataset.duplicatePolicies[0]!,
    acceptCachedFormulaValues: job.options?.acceptCachedFormulaValues ?? false,
  }));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [conflict, setConflict] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [mapName, setMapName] = useState('');
  const [mapShared, setMapShared] = useState(false);
  useEffect(() => setMapping(Object.keys(job.mapping).length ? job.mapping : job.suggestedMapping), [job.id, job.headers.join('|')]); // eslint-disable-line react-hooks/exhaustive-deps
  const saved = useApiQuery(importEndpoints.mappings, { params: { workspaceId: workspace.id, dataset: job.dataset } });
  const validate = useApiMutation(importEndpoints.validate, { invalidate: ['imports.get', 'imports.list', 'imports.rows'], silentErrors: true, successMessage: 'Validation started' });
  const reparse = useApiMutation(importEndpoints.reparse, { invalidate: ['imports.get', 'imports.list', 'imports.rows'], successMessage: 'Parsing the file again' });
  const saveMapping = useApiMutation(importEndpoints.saveMapping, { invalidate: ['imports.mappings'], successMessage: 'Mapping saved' });
  const headerOptions = [{ value: NOT_IMPORTED, label: 'Not imported' }, ...job.headers.map((h) => ({ value: h, label: h }))];
  const run = async () => {
    setErrors({});
    try {
      await validate.run({ params, body: { mapping, options } }, { ifMatch: job.rowVersion });
    } catch (e) {
      if (isApiError(e) && e.code === 'VERSION_CONFLICT') setConflict(true);
      else if (isApiError(e) && e.fieldErrors.length) setErrors(Object.fromEntries(e.fieldErrors.map((f) => [f.field.replace(/^body\./, ''), f.message])));
      else setErrors({ _: isApiError(e) ? e.message : 'Validation could not start.' });
    }
  };
  return (
    <Panel title="Map columns and choose options" description="Match each field to a column of your file. Required fields are marked with *.">
      <div className="flex flex-col gap-5">
        {errors._ ? <Banner tone="danger">{errors._}</Banner> : null}
        {saved.data?.length ? (
          <div className="w-full sm:w-[320px]">
            <Field label="Apply saved mapping">
              <Select
                value={null}
                placeholder="Choose a saved mapping"
                onChange={(id) => {
                  const m = saved.data?.find((x) => x.id === id);
                  if (m) setMapping(Object.fromEntries(dataset.columns.map((c) => [c.key, m.mapping[c.key] && job.headers.includes(m.mapping[c.key]!) ? m.mapping[c.key]! : null])));
                }}
                options={saved.data.map((m) => ({ value: m.id, label: m.name, description: m.shared ? 'Shared' : 'Personal' }))}
              />
            </Field>
          </div>
        ) : null}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {dataset.columns.map((c) => (
            <Field key={c.key} label={c.label} required={c.required} helper={c.description ?? undefined} error={errors[`mapping.${c.key}`] ?? null}>
              <Select value={mapping[c.key] ?? NOT_IMPORTED} onChange={(v) => setMapping((m) => ({ ...m, [c.key]: !v || v === NOT_IMPORTED ? null : v }))} options={headerOptions} />
            </Field>
          ))}
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Time zone for dates and times" required helper="Local times in the file are read in this zone." error={errors['options.timezone'] ?? null}>
            <Input value={options.timezone} onChange={(e) => setOptions((o) => ({ ...o, timezone: e.target.value }))} />
          </Field>
          <Field label="Date format" required>
            <Select
              value={options.dateFormat}
              onChange={(v) => setOptions((o) => ({ ...o, dateFormat: (v ?? 'iso') as ImportOptionsInput['dateFormat'] }))}
              options={[
                { value: 'iso', label: 'ISO (YYYY-MM-DD)' },
                { value: 'dd.mm.yyyy', label: 'DD.MM.YYYY' },
                { value: 'dd/mm/yyyy', label: 'DD/MM/YYYY' },
                { value: 'mm/dd/yyyy', label: 'MM/DD/YYYY' },
              ]}
            />
          </Field>
          <Field label="Decimal separator" required helper="Numbers with thousands separators are rejected instead of guessed.">
            <Select value={options.decimalSeparator} onChange={(v) => setOptions((o) => ({ ...o, decimalSeparator: (v ?? '.') as '.' | ',' }))} options={[{ value: '.', label: 'Point (1234.56)' }, { value: ',', label: 'Comma (1234,56)' }]} />
          </Field>
          {job.fileKind === 'csv' ? (
            <Field label="Column delimiter" helper={`Detected: ${job.delimiter === ';' ? 'semicolon' : 'comma'}. Changing it parses the file again.`}>
              <Select
                value={job.delimiter ?? ','}
                onChange={(v) => v && v !== job.delimiter && void reparse.run({ params, body: { delimiter: v as ',' | ';' } }, { ifMatch: job.rowVersion })}
                options={[{ value: ',', label: 'Comma' }, { value: ';', label: 'Semicolon' }]}
              />
            </Field>
          ) : null}
        </div>
        <Field label="Existing records" required>
          <RadioGroup
            label="Duplicate policy"
            value={options.duplicatePolicy}
            onValueChange={(v) => setOptions((o) => ({ ...o, duplicatePolicy: v }))}
            options={dataset.duplicatePolicies.map((p) => ({ value: p, label: label('duplicatePolicy', p) }))}
          />
        </Field>
        {job.hasFormulaCells ? (
          <Checkbox
            checked={!!options.acceptCachedFormulaValues}
            onCheckedChange={(v) => setOptions((o) => ({ ...o, acceptCachedFormulaValues: v }))}
            label="Import cached formula values"
            description="The workbook contains formulas. They are never calculated here; only the values stored in the file are used and each is labelled Cached Formula Value."
          />
        ) : null}
        <div className="flex flex-wrap justify-between gap-2">
          <Button icon={<FloppyDisk size={14} />} onClick={() => setSaveOpen(true)}>
            Save Mapping
          </Button>
          <Button variant="primary" onClick={() => void run()} loading={validate.isPending} disabled={job.state === 'validating'}>
            {job.state === 'validated' || job.state === 'needs_revalidation' ? 'Validate Again' : 'Validate'}
          </Button>
        </div>
      </div>
      <Dialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        size="small"
        title="Save mapping"
        dirty={!!mapName}
        footer={
          <>
            <Button onClick={() => setSaveOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={mapName.trim().length < 2}
              loading={saveMapping.isPending}
              onClick={async () => {
                await saveMapping.run({ params: { workspaceId: workspace.id, dataset: job.dataset }, body: { name: mapName, mapping, shared: mapShared } });
                setMapName('');
                setSaveOpen(false);
              }}
            >
              Save Mapping
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="Name" required>
            <Input value={mapName} onChange={(e) => setMapName(e.target.value)} maxLength={120} />
          </Field>
          <Switch label="Share with the team" checked={mapShared} onCheckedChange={setMapShared} />
        </div>
      </Dialog>
      <ConflictDialog open={conflict} onOpenChange={setConflict} onReload={() => window.location.reload()} />
    </Panel>
  );
};

const ReportPanel = ({ job, dataset }: { job: ImportJobDetail; dataset?: ImportDatasetInfo }) => {
  const { workspace } = useWorkspace();
  const r = job.validationReport!;
  const [tab, setTab] = useState<'all' | 'error' | 'warning'>('all');
  const rows = useApiInfinite(importEndpoints.rows, { params: { workspaceId: workspace.id, importId: job.id }, query: { pageSize: 100, status: tab === 'all' ? undefined : tab === 'error' ? ['error'] : ['warning', 'skipped'] } });
  const mapped = useMemo(() => (dataset?.columns ?? []).filter((c) => job.mapping[c.key]), [dataset, job.mapping]);
  const columns: Column<ImportRowItem>[] = [
    { key: 'row', header: 'Row', sticky: true, align: 'right', minWidth: 60, cell: (x) => x.rowNo },
    {
      key: 'status',
      header: 'Outcome',
      minWidth: 120,
      cell: (x) => (x.status === 'error' ? <Badge tone="danger">Error</Badge> : x.action === 'skip' ? <Badge>Skip</Badge> : x.action === 'update' ? <Badge tone="info">Update</Badge> : <Badge tone="success">Create</Badge>),
    },
    ...mapped.map((c) => ({ key: c.key, header: c.label, minWidth: 140, cell: (x: ImportRowItem) => <span className="line-clamp-2">{x.raw[job.mapping[c.key]!] || <span className="text-fg-muted">—</span>}</span> })),
    {
      key: 'issues',
      header: 'Issues',
      minWidth: 280,
      cell: (x) =>
        x.errors.length || x.warnings.length ? (
          <ul className="flex flex-col gap-0.5 text-[12px]">
            {x.errors.map((e, i) => (
              <li key={`e${i}`} className="flex items-start gap-1 text-danger">
                <WarningCircle size={12} className="mt-0.5 shrink-0" aria-hidden /> {e.message}
              </li>
            ))}
            {x.warnings.map((w, i) => (
              <li key={`w${i}`} className="text-warning">
                {w.message}
              </li>
            ))}
          </ul>
        ) : (
          <span className="text-fg-muted">—</span>
        ),
    },
  ];
  return (
    <Panel
      title={`Validation report #${r.reportNo}`}
      description={`Validated ${formatDateTime(r.validatedAt)} by ${r.validatedBy}. Review changes before importing. No records have been changed yet.`}
      actions={
        r.totals.errors + r.totals.warnings > 0 ? (
          <a href={`/api/v1/workspaces/${workspace.id}/imports/${job.id}/error-report`} className="inline-flex h-9 items-center gap-2 rounded-[8px] border border-line bg-surface px-3 text-[13px] font-semibold text-fg hover:bg-surface-2">
            <DownloadSimple size={14} aria-hidden /> Download Errors
          </a>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-4">
        <KpiStrip
          items={[
            { label: 'Rows', value: r.totals.rows.toLocaleString('en-US') },
            { label: 'Create / Update', value: `${r.totals.create} / ${r.totals.update}` },
            { label: 'Skip', value: r.totals.skip },
            { label: 'Rows with errors', value: r.totals.errorRows, hint: r.totals.warningRows ? `${r.totals.warningRows} with warnings` : 'No warnings' },
          ]}
        />
        {r.byIssue.length ? (
          <ul className="flex flex-col gap-1 text-[13px]">
            {r.byIssue.map((i) => (
              <li key={`${i.severity}:${i.field}:${i.code}`} className={i.severity === 'error' ? 'text-danger' : 'text-warning'}>
                {i.severity === 'error' ? 'Error' : 'Warning'} · {i.count}× {i.message}
              </li>
            ))}
          </ul>
        ) : (
          <p className="flex items-center gap-2 text-[13px] text-fg-2">
            <CheckCircle size={14} className="text-primary" aria-hidden /> No errors or warnings.
          </p>
        )}
        <Tabs
          label="Preview rows"
          value={tab}
          onValueChange={(v) => setTab(v as never)}
          items={[
            { value: 'all', label: 'First rows' },
            { value: 'error', label: 'Errors', count: r.totals.errorRows },
            { value: 'warning', label: 'Warnings & skipped', count: r.totals.warningRows + r.totals.skip },
          ]}
        />
        <QueryState query={rows}>
          <DataTable
            caption="Preview of staged rows"
            density="compact"
            rows={rows.items}
            columns={columns}
            getRowId={(x) => x.id}
            hasMore={rows.hasNextPage}
            loadingMore={rows.isFetchingNextPage}
            onLoadMore={() => void rows.fetchNextPage()}
            empty={<p className="py-4 text-[13px] text-fg-2">No rows in this view.</p>}
          />
        </QueryState>
      </div>
    </Panel>
  );
};

const ConfirmPanel = ({ job }: { job: ImportJobDetail }) => {
  const { workspace } = useWorkspace();
  const r = job.validationReport!;
  const hasWarnings = r.totals.warningRows > 0 || r.byIssue.some((i) => i.severity === 'warning');
  const [ack, setAck] = useState(false);
  const commit = useApiMutation(importEndpoints.commit, { invalidate: ['imports.get', 'imports.list', 'imports.rows'], successMessage: 'Import confirmed. Changes are being applied in one step.' });
  if (r.totals.errorRows > 0)
    return <Banner tone="danger">Fix the {r.totals.errorRows} row{r.totals.errorRows === 1 ? '' : 's'} with errors in your file (or change the mapping) and validate again. Rows with errors are never imported partially.</Banner>;
  return (
    <Panel title="Confirm Import" description="All rows are applied together in one transaction, or none at all.">
      <div className="flex flex-col gap-3">
        <p className="text-[14px] text-fg">
          {r.totals.create} record{r.totals.create === 1 ? '' : 's'} will be created, {r.totals.update} updated and {r.totals.skip} skipped. Imports never grant roles and never post finance.
        </p>
        {hasWarnings ? <Checkbox checked={ack} onCheckedChange={setAck} label="I reviewed the warnings and want to import anyway" /> : null}
        {job.permissions.commit ? (
          <div>
            <Button
              variant="primary"
              disabled={hasWarnings && !ack}
              loading={commit.isPending}
              onClick={() => void commit.run({ params: { workspaceId: workspace.id, importId: job.id }, body: { validationToken: job.validationToken!, warningsAccepted: ack } }, { ifMatch: job.rowVersion })}
            >
              Confirm Import
            </Button>
          </div>
        ) : (
          <Banner tone="info">A member who may confirm imports has to confirm this one. Share the link to this page with them.</Banner>
        )}
      </div>
    </Panel>
  );
};

const ResultPanel = ({ job }: { job: ImportJobDetail }) => {
  const { workspace } = useWorkspace();
  const res = job.result!;
  const params = { workspaceId: workspace.id, importId: job.id };
  const [reason, setReason] = useState('');
  const preview = useApiMutation(importEndpoints.undoPreview);
  const undo = useApiMutation(importEndpoints.undo, { invalidate: ['imports.get', 'imports.list', 'imports.rows'], successMessage: 'Undo Import finished' });
  const [open, setOpen] = useState(false);
  const entity = DATASET_ENTITY[job.dataset];
  return (
    <Panel
      title={job.state === 'undone' ? 'Result (import undone)' : 'Result'}
      description={job.committedAt ? `Imported ${formatDateTime(job.committedAt)}.` : undefined}
      actions={
        job.permissions.undo ? (
          <Button icon={<ArrowCounterClockwise size={14} />} onClick={() => setOpen(true)}>
            Undo Import
          </Button>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-3">
        <KpiStrip items={[{ label: 'Created', value: res.created }, { label: 'Updated', value: res.updated }, { label: 'Skipped', value: res.skipped }, { label: 'Removed by undo', value: res.undo ? res.undo.removed : '—' }]} />
        {entity && res.createdIds.length ? (
          <details>
            <summary className="cursor-pointer text-[13px] font-semibold text-primary">Open Result ({res.createdIds.length} created)</summary>
            <ul className="mt-2 flex flex-wrap gap-2">
              {res.createdIds.slice(0, 200).map((id, i) => (
                <li key={id}>
                  <Link href={entityHref(workspace.id, entity, id)} className="text-[13px] text-primary hover:underline">
                    Record {i + 1}
                  </Link>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) preview.reset();
        }}
        title="Undo Import"
        description="Only records created by this import that nobody changed and nothing depends on are removed (moved to the trash). Updated records are not reverted."
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            {preview.data ? (
              <Button
                variant="danger"
                disabled={!preview.data.removable.length}
                loading={undo.isPending}
                onClick={async () => {
                  await undo.run({ params, body: { previewToken: preview.data!.token } }, { ifMatch: job.rowVersion });
                  setOpen(false);
                  preview.reset();
                }}
              >
                Remove {preview.data.removable.length} Record{preview.data.removable.length === 1 ? '' : 's'}
              </Button>
            ) : (
              <Button variant="primary" loading={preview.isPending} onClick={() => void preview.run({ params, body: { reason: reason || undefined } })}>
                Check What Can Be Undone
              </Button>
            )}
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {!preview.data ? (
            <Field label="Reason" helper="Recorded in the audit log.">
              <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} />
            </Field>
          ) : (
            <>
              <p className="text-[14px] text-fg">
                {preview.data.removable.length} can be removed. {preview.data.obstacles.length} stay because they changed or other records depend on them
                {preview.data.notReverted ? `; ${preview.data.notReverted} updated records are not reverted` : ''}.
              </p>
              {preview.data.obstacles.length ? (
                <div>
                  <p className="mb-1 text-[12px] font-[550] text-fg">Obstacles — archive or correct these manually</p>
                  <ul className="flex flex-col gap-1 text-[13px]">
                    {preview.data.obstacles.map((o) => (
                      <li key={o.entityId}>
                        {entity ? (
                          <Link href={entityHref(workspace.id, entity, o.entityId)} className="text-primary hover:underline">
                            {o.title}
                          </Link>
                        ) : (
                          o.title
                        )}
                        <span className="text-fg-2"> — {o.reason}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          )}
        </div>
      </Dialog>
    </Panel>
  );
};
