'use client';
import { DownloadSimple, Export, LockSimple, Plus } from '@phosphor-icons/react';
import { useEffect, useMemo, useState } from 'react';
import { exportEndpoints, type ExportDatasetInfo, type ExportJobItem } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { EXPORT_STATES } from '@castlane/domain';
import {
  Avatar,
  Badge,
  Banner,
  Button,
  Checkbox,
  ConfirmDialog,
  DataTable,
  DateInput,
  Drawer,
  EmptyState,
  Field,
  Input,
  Menu,
  MultiSelect,
  NoResults,
  PageHeader,
  RadioGroup,
  Select,
  StatusBadge,
  Switch,
  Toolbar,
  formatBytes,
  formatDateTime,
  type Column,
} from '@castlane/ui';
import { EntitySelect } from '@/components/common/entity-select';
import { QueryState } from '@/components/common/query-state';
import { useApiInfinite, useApiMutation, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';
import { useCan, useWorkspace } from '@/lib/workspace-context';
import type { LookupType } from '@castlane/api-contracts';
import '../inbox/labels';

type Filters = 'state' | 'mine' | 'new' | 'dataset' | 'open' | 'prefill';

/** S54 Export Center: request, track and download permitted exports (files expire after 7 days). */
export const ExportsScreen = () => {
  const { workspace, user } = useWorkspace();
  const can = useCan();
  const { state, set, list } = useUrlState<Filters>();
  const params = { workspaceId: workspace.id };
  const jobs = useApiInfinite(exportEndpoints.list, { params, query: { state: list('state') as ExportJobItem['state'][], mine: state.mine === '1' ? true : undefined } });
  const invalidate = ['exports.list', 'exports.get'];
  const download = useApiMutation(exportEndpoints.download, { silentErrors: false });
  const cancel = useApiMutation(exportEndpoints.cancel, { invalidate, successMessage: 'Export cancelled' });
  const remove = useApiMutation(exportEndpoints.remove, { invalidate, successMessage: 'File deleted' });
  const retry = useApiMutation(exportEndpoints.retry, { invalidate, successMessage: 'Export queued again' });
  const [confirmDelete, setConfirmDelete] = useState<ExportJobItem | null>(null);
  const filtered = !!(list('state').length || state.mine);

  const startDownload = async (e: ExportJobItem) => {
    const r = await download.run({ params: { ...params, exportId: e.id } });
    window.location.assign(r.url);
  };

  const columns: Column<ExportJobItem>[] = [
    {
      key: 'dataset',
      header: 'Export',
      sticky: true,
      minWidth: 220,
      cell: (e) => (
        <span className="flex flex-col">
          <span className="font-medium text-fg">{e.datasetLabel}</span>
          <span className="text-[12px] text-fg-2">
            {e.format.toUpperCase()} · {e.fields.length} field{e.fields.length === 1 ? '' : 's'}
            {Object.keys(e.filters).length ? ` · ${Object.keys(e.filters).length} filter${Object.keys(e.filters).length === 1 ? '' : 's'}` : ''}
          </span>
        </span>
      ),
    },
    {
      key: 'classification',
      header: 'Classification',
      minWidth: 120,
      cell: (e) => (e.classification === 'normal' ? <Badge>Normal</Badge> : <Badge tone="warning" icon={<LockSimple size={12} aria-hidden />}>{label('classification', e.classification)}</Badge>),
    },
    {
      key: 'requestedBy',
      header: 'Requested By',
      minWidth: 170,
      cell: (e) => (
        <span className="flex items-center gap-2">
          <Avatar name={e.requestedBy.displayName} src={e.requestedBy.avatarUrl} size={24} decorative />
          {e.own ? 'You' : e.requestedBy.displayName}
        </span>
      ),
    },
    {
      key: 'state',
      header: 'State',
      minWidth: 150,
      cell: (e) => (
        <span className="flex flex-col gap-1">
          <StatusBadge status={e.state} label={label('exportState', e.state)} />
          {e.state === 'running' ? <span className="text-[12px] text-fg-2">{e.progress}%</span> : null}
          {e.errorMessage ? <span className="text-[12px] text-danger">{e.errorMessage}</span> : null}
        </span>
      ),
    },
    { key: 'created', header: 'Requested', minWidth: 160, cell: (e) => formatDateTime(e.createdAt, user.timezone) },
    { key: 'boundary', header: 'Data As Of', minWidth: 160, cell: (e) => formatDateTime(e.sourceBoundAt, user.timezone) },
    { key: 'expires', header: 'Expires', minWidth: 160, cell: (e) => (e.expiresAt ? formatDateTime(e.expiresAt, user.timezone) : '—') },
    { key: 'size', header: 'Size', align: 'right', minWidth: 90, cell: (e) => (e.byteSize !== null ? formatBytes(e.byteSize) : '—') },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      minWidth: 170,
      align: 'right',
      cell: (e) => (
        <span className="flex justify-end gap-1">
          {e.permissions.download ? (
            <Button size="sm" icon={<DownloadSimple size={14} />} loading={download.isPending && download.variables?.input.params?.exportId === e.id} onClick={() => void startDownload(e)}>
              Download
            </Button>
          ) : null}
          {e.permissions.retry ? (
            <Button size="sm" onClick={() => void retry.run({ params: { ...params, exportId: e.id } }, { ifMatch: e.rowVersion })}>
              Retry Failed
            </Button>
          ) : null}
          {e.permissions.cancel || e.permissions.delete ? (
            <Menu
              label="More actions"
              trigger={
                <Button size="sm" variant="ghost">
                  More
                </Button>
              }
              items={[
                { label: 'Cancel Export', hidden: !e.permissions.cancel, onSelect: () => void cancel.run({ params: { ...params, exportId: e.id } }, { ifMatch: e.rowVersion }) },
                { label: 'Delete File', destructive: true, hidden: !e.permissions.delete, onSelect: () => setConfirmDelete(e) },
              ]}
            />
          ) : null}
        </span>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Export Center"
        description="Exports contain only records you may see, as of the moment you requested them. Files are private, downloads are checked again, and files expire after 7 days."
        actions={
          can('exports.create') ? (
            <Button variant="primary" icon={<Plus size={14} weight="bold" />} onClick={() => set({ new: '1' })}>
              Request Export
            </Button>
          ) : undefined
        }
      />
      <Toolbar>
        <div className="w-full sm:w-[220px]">
          <MultiSelect aria-label="State" placeholder="Any state" value={list('state')} onChange={(v) => set({ state: v.join(',') || null })} options={EXPORT_STATES.map((s) => ({ value: s, label: label('exportState', s) }))} />
        </div>
        <Switch label="Only my exports" checked={state.mine === '1'} onCheckedChange={(v) => set({ mine: v ? '1' : null })} />
      </Toolbar>
      <QueryState query={jobs}>
        <DataTable
          caption="Exports"
          rows={jobs.items}
          columns={columns}
          getRowId={(e) => e.id}
          density={user.density}
          selectedRowId={state.open ?? null}
          hasMore={jobs.hasNextPage}
          loadingMore={jobs.isFetchingNextPage}
          onLoadMore={() => void jobs.fetchNextPage()}
          empty={
            filtered ? (
              <NoResults onClear={() => set({ state: null, mine: null })} />
            ) : (
              <EmptyState
                icon={<Export size={28} />}
                title="No exports yet"
                description="Request an export to download permitted records as CSV or XLSX."
                action={can('exports.create') ? <Button variant="primary" onClick={() => set({ new: '1' })}>Request Export</Button> : undefined}
              />
            )
          }
        />
      </QueryState>
      <RequestExportDrawer open={state.new === '1'} initialDataset={state.dataset} prefill={state.prefill} onClose={() => set({ new: null, dataset: null, prefill: null })} />
      <ConfirmDialog
        open={!!confirmDelete}
        onOpenChange={(o) => !o && setConfirmDelete(null)}
        title="Delete this export file?"
        body="The generated file is removed now instead of at expiry. Copies already downloaded cannot be revoked. The export record stays in the history."
        confirmLabel="Delete File"
        destructive
        loading={remove.isPending}
        onConfirm={async () => {
          if (!confirmDelete) return;
          await remove.run({ params: { ...params, exportId: confirmDelete.id } }, { ifMatch: confirmDelete.rowVersion });
          setConfirmDelete(null);
        }}
      />
    </div>
  );
};

type FilterValue = string | string[] | null;

const FilterControl = ({ f, value, onChange }: { f: ExportDatasetInfo['filters'][number]; value: FilterValue; onChange: (v: FilterValue) => void }) => {
  if (f.type === 'enum')
    return <MultiSelect aria-label={f.label} value={(value as string[] | null) ?? []} onChange={(v) => onChange(v.length ? v : null)} options={(f.enumValues ?? []).map((v) => ({ value: v, label: label('status', v) }))} placeholder="Any" />;
  if (f.type === 'reference' && f.lookup) return <EntitySelect type={f.lookup as LookupType} aria-label={f.label} clearable value={(value as string | null) ?? null} onChange={(v) => onChange(v)} placeholder="Any" />;
  if (f.type === 'date') return <DateInput value={(value as string | null) ?? ''} onChange={(e) => onChange(e.target.value || null)} />;
  return <Input value={(value as string | null) ?? ''} onChange={(e) => onChange(e.target.value || null)} maxLength={200} />;
};

/** Request Export: dataset → fields (sensitive flagged) → filters → format; Preview Fields shows sample rows. */
/** `prefill` is a URL-encoded query string of filter values for `initialDataset` (e.g. from the Audit Log). */
const RequestExportDrawer = ({ open, initialDataset, prefill, onClose }: { open: boolean; initialDataset?: string; prefill?: string; onClose: () => void }) => {
  const { workspace } = useWorkspace();
  const params = { workspaceId: workspace.id };
  const datasets = useApiQuery(exportEndpoints.datasets, { params }, { enabled: open });
  const [dataset, setDataset] = useState<string | null>(null);
  const [fields, setFields] = useState<string[]>([]);
  const [filters, setFilters] = useState<Record<string, FilterValue>>({});
  const [format, setFormat] = useState<'csv' | 'xlsx'>('csv');
  const [error, setError] = useState<string | null>(null);
  const d = useMemo(() => datasets.data?.find((x) => x.key === dataset) ?? null, [datasets.data, dataset]);
  useEffect(() => {
    if (!open) return;
    if (!dataset && datasets.data?.length) setDataset(datasets.data.find((x) => x.key === initialDataset)?.key ?? datasets.data[0]!.key);
  }, [open, datasets.data, dataset, initialDataset]);
  useEffect(() => {
    if (d) {
      setFields(d.columns.filter((c) => c.default && c.available).map((c) => c.key));
      const initial: Record<string, FilterValue> = {};
      if (prefill && d.key === initialDataset) {
        const given = new URLSearchParams(prefill);
        for (const f of d.filters) {
          const v = given.get(f.key);
          if (v) initial[f.key] = f.type === 'enum' ? v.split(',') : v;
        }
      }
      setFilters(initial);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d]);
  const cleanFilters = Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== null && v !== '' && !(Array.isArray(v) && !v.length))) as Record<string, string | string[]>;
  const preview = useApiMutation(exportEndpoints.preview, { silentErrors: true });
  const create = useApiMutation(exportEndpoints.create, { invalidate: ['exports.list', 'exports.get'], successMessage: 'Export requested. It appears here when the file is ready.', silentErrors: true });
  const privateSelected = !!d?.columns.some((c) => c.sensitive && fields.includes(c.key));
  const reset = () => {
    setDataset(null);
    setFields([]);
    setFilters({});
    setError(null);
    preview.reset();
  };
  const submit = async () => {
    if (!d) return;
    setError(null);
    try {
      await create.run({ params, body: { dataset: d.key, format, fields, filters: cleanFilters } });
      reset();
      onClose();
    } catch (e) {
      setError(isApiError(e) ? e.message : 'The export could not be requested.');
    }
  };
  return (
    <Drawer
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          reset();
          onClose();
        }
      }}
      title="Request Export"
      description="Fields, filters and the data boundary are fixed when you request the export."
      width={760}
      footer={
        <>
          <Button onClick={() => void preview.run({ params, body: { dataset: d!.key, fields, filters: cleanFilters } }).catch((e) => setError(isApiError(e) ? e.message : 'Preview failed.'))} disabled={!d || !fields.length} loading={preview.isPending}>
            Preview Fields
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={!d || !fields.length} loading={create.isPending}>
            Request Export
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <QueryState query={datasets}>
          {datasets.data?.length === 0 ? (
            <EmptyState title="Nothing to export" description="Your role does not include any exportable dataset." />
          ) : (
            <>
              <Field label="Dataset" required>
                <Select value={dataset} onChange={(v) => setDataset(v)} options={(datasets.data ?? []).map((x) => ({ value: x.key, label: x.label, description: x.classification !== 'normal' ? `${label('classification', x.classification)} data` : undefined }))} />
              </Field>
              <Field label="Format" required>
                <RadioGroup label="Format" orientation="horizontal" value={format} onValueChange={setFormat} options={[{ value: 'csv', label: 'CSV (UTF-8)' }, { value: 'xlsx', label: 'XLSX' }]} />
              </Field>
              {d ? (
                <fieldset className="flex flex-col gap-2">
                  <legend className="mb-1 text-[12px] font-[550] text-fg">Fields</legend>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {d.columns.map((c) => (
                      <Checkbox
                        key={c.key}
                        checked={fields.includes(c.key)}
                        onCheckedChange={(v) => setFields((cur) => (v ? [...cur, c.key] : cur.filter((k) => k !== c.key)))}
                        label={
                          <span className="inline-flex items-center gap-1">
                            {c.label}
                            {c.sensitive ? <LockSimple size={12} aria-label="Private field" /> : null}
                          </span>
                        }
                        description={!c.available ? 'Requires access you do not have' : c.sensitive ? 'Private field' : undefined}
                      />
                    ))}
                  </div>
                </fieldset>
              ) : null}
              {privateSelected ? <Banner tone="warning">Private fields are selected. Only you can download this file, and access is checked again at download time.</Banner> : null}
              {d?.filters.length ? (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {d.filters.map((f) => (
                    <Field key={f.key} label={f.label}>
                      <FilterControl f={f} value={filters[f.key] ?? null} onChange={(v) => setFilters((cur) => ({ ...cur, [f.key]: v }))} />
                    </Field>
                  ))}
                </div>
              ) : null}
              {preview.data ? (
                <div className="flex flex-col gap-2">
                  {preview.data.warnings.map((w) => (
                    <Banner key={w} tone="info">
                      {w}
                    </Banner>
                  ))}
                  <DataTable
                    caption="Preview of the first rows"
                    density="compact"
                    rows={preview.data.rows.map((r, i) => ({ ...r, __i: i }))}
                    getRowId={(r) => String(r.__i)}
                    columns={preview.data.columns.map((c, i) => ({ key: c.key, header: c.label, sticky: i === 0, minWidth: 120, cell: (r: Record<string, unknown>) => (r[c.key] === null ? <span className="text-fg-muted">—</span> : String(r[c.key])) }))}
                    empty={<p className="text-[13px] text-fg-2">No records match these filters. The export would contain the header row only.</p>}
                  />
                </div>
              ) : null}
            </>
          )}
        </QueryState>
      </div>
    </Drawer>
  );
};
