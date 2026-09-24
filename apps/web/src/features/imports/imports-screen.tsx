'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, DownloadSimple, FileArrowUp, Plus, UploadSimple } from '@phosphor-icons/react';
import { useRef, useState } from 'react';
import { importEndpoints, type ImportJobSummary } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { IMPORT_STATES } from '@castlane/domain';
import { Avatar, Banner, Button, DataTable, EmptyState, Field, MultiSelect, NoResults, PageHeader, Panel, Select, StatusBadge, Toolbar, formatBytes, formatDateTime, type Column } from '@castlane/ui';
import { QueryState } from '@/components/common/query-state';
import { useApiInfinite, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';
import { ImportJobView } from './import-job';
import { uploadImportFile } from './upload';
import '../inbox/labels';

type Filters = 'state' | 'dataset' | 'open' | 'new';

/** S66 Import Center: upload → mapping → validation report → preview → Confirm Import → result. */
export const ImportsScreen = () => {
  const { workspace, user } = useWorkspace();
  const can = useCan();
  const wsPath = useWsPath();
  const router = useRouter();
  const { state, set, list } = useUrlState<Filters>();
  const params = { workspaceId: workspace.id };
  const jobs = useApiInfinite(importEndpoints.list, { params, query: { state: list('state') as ImportJobSummary['state'][], dataset: (state.dataset as never) || undefined } }, { enabled: !state.open && state.new !== '1' });

  if (state.open)
    return (
      <div className="flex flex-col gap-5">
        <Link href={wsPath('/imports')} className="inline-flex w-fit items-center gap-1 text-[13px] text-fg-2 hover:text-fg">
          <ArrowLeft size={14} aria-hidden /> All imports
        </Link>
        <ImportJobView importId={state.open} />
      </div>
    );
  if (state.new === '1') return <NewImport initialDataset={state.dataset} onCreated={(id) => router.replace(wsPath(`/imports?open=${id}`))} onCancel={() => set({ new: null })} />;

  const columns: Column<ImportJobSummary>[] = [
    { key: 'file', header: 'File', sticky: true, minWidth: 220, cell: (j) => <span className="font-medium text-fg">{j.fileName}</span> },
    { key: 'dataset', header: 'Dataset', minWidth: 130, cell: (j) => j.datasetLabel },
    { key: 'state', header: 'State', minWidth: 170, cell: (j) => <StatusBadge status={j.state} label={label('importState', j.state)} /> },
    { key: 'rows', header: 'Rows', align: 'right', minWidth: 80, cell: (j) => j.rowCount ?? '—' },
    { key: 'size', header: 'Size', align: 'right', minWidth: 90, cell: (j) => formatBytes(j.byteSize) },
    {
      key: 'by',
      header: 'Uploaded By',
      minWidth: 170,
      cell: (j) => (
        <span className="flex items-center gap-2">
          <Avatar name={j.requestedBy.displayName} src={j.requestedBy.avatarUrl} size={24} decorative />
          {j.requestedBy.displayName}
        </span>
      ),
    },
    { key: 'created', header: 'Uploaded', minWidth: 160, cell: (j) => formatDateTime(j.createdAt, user.timezone) },
  ];
  const filtered = !!(list('state').length || state.dataset);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Import Center"
        description="Import projects and other data from CSV or XLSX files. Nothing changes until you confirm a validated file; imports never grant roles or post finance."
        actions={
          can('imports.create') ? (
            <Button variant="primary" icon={<Plus size={14} weight="bold" />} onClick={() => set({ new: '1' })}>
              New Import
            </Button>
          ) : undefined
        }
      />
      <Toolbar>
        <div className="w-full sm:w-[240px]">
          <MultiSelect aria-label="State" placeholder="Any state" value={list('state')} onChange={(v) => set({ state: v.join(',') || null })} options={IMPORT_STATES.map((s) => ({ value: s, label: label('importState', s) }))} />
        </div>
      </Toolbar>
      <QueryState query={jobs}>
        <DataTable
          caption="Imports"
          rows={jobs.items}
          columns={columns}
          getRowId={(j) => j.id}
          density={user.density}
          onRowClick={(j) => set({ open: j.id })}
          hasMore={jobs.hasNextPage}
          loadingMore={jobs.isFetchingNextPage}
          onLoadMore={() => void jobs.fetchNextPage()}
          empty={
            filtered ? (
              <NoResults onClear={() => set({ state: null, dataset: null })} />
            ) : (
              <EmptyState
                icon={<FileArrowUp size={28} />}
                title="No imports yet"
                description="Download a template, fill it in, and upload it. You will review every change before anything is imported."
                action={can('imports.create') ? <Button variant="primary" onClick={() => set({ new: '1' })}>New Import</Button> : undefined}
              />
            )
          }
        />
      </QueryState>
    </div>
  );
};

const NewImport = ({ initialDataset, onCreated, onCancel }: { initialDataset?: string; onCreated: (id: string) => void; onCancel: () => void }) => {
  const { workspace } = useWorkspace();
  const datasets = useApiQuery(importEndpoints.datasets, { params: { workspaceId: workspace.id } });
  const [dataset, setDataset] = useState<string | null>(initialDataset ?? null);
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const chosen = dataset ?? datasets.data?.[0]?.key ?? null;
  const d = datasets.data?.find((x) => x.key === chosen);
  const tooBig = !!file && file.size > 20 * 1024 * 1024;
  const start = async () => {
    if (!file || !chosen) return;
    setError(null);
    setProgress(0);
    try {
      const job = await uploadImportFile(workspace.id, chosen, file, setProgress);
      onCreated(job.id);
    } catch (e) {
      setProgress(null);
      setError(isApiError(e) ? e.message : (e as Error).message);
    }
  };
  const templateUrl = (format: 'csv' | 'xlsx') => `/api/v1/workspaces/${workspace.id}/imports/datasets/${chosen}/template?format=${format}`;
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="New Import" crumbs={[{ label: 'Import Center' }, { label: 'New' }]} description="Review changes before importing. No records have been changed yet." />
      <QueryState query={datasets}>
        {datasets.data?.length === 0 ? (
          <EmptyState title="No datasets available" description="Your role does not allow importing any dataset. Ask a workspace administrator if you need to import data." />
        ) : (
          <div className="grid max-w-[920px] grid-cols-1 gap-4">
            {error ? <Banner tone="danger">{error}</Banner> : null}
            <Panel title="1. Dataset">
              <div className="flex flex-col gap-4">
                <Field label="Dataset" required>
                  <Select value={chosen} onChange={(v) => setDataset(v)} options={(datasets.data ?? []).map((x) => ({ value: x.key, label: x.label }))} />
                </Field>
                {d ? (
                  <div className="flex flex-col gap-2">
                    <p className="text-[13px] text-fg-2">
                      Columns: {d.columns.map((c) => `${c.label}${c.required ? '*' : ''}`).join(', ')}. Unknown projects, members or directions are reported as errors — the import never creates hidden records.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <a href={templateUrl('csv')} className="inline-flex h-9 items-center gap-2 rounded-[8px] border border-line bg-surface px-3 text-[13px] font-semibold text-fg hover:bg-surface-2">
                        <DownloadSimple size={14} aria-hidden /> Download Template (CSV)
                      </a>
                      <a href={templateUrl('xlsx')} className="inline-flex h-9 items-center gap-2 rounded-[8px] border border-line bg-surface px-3 text-[13px] font-semibold text-fg hover:bg-surface-2">
                        <DownloadSimple size={14} aria-hidden /> Download Template (XLSX)
                      </a>
                    </div>
                  </div>
                ) : null}
              </div>
            </Panel>
            <Panel title="2. File">
              <div className="flex flex-col gap-3">
                <p className="text-[13px] text-fg-2">CSV (UTF-8, comma or semicolon) or XLSX without macros; at most 20 MB and 20,000 rows. Formulas are never evaluated.</p>
                <div className="flex flex-wrap items-center gap-3">
                  <Button icon={<UploadSimple size={14} />} onClick={() => input.current?.click()} disabled={progress !== null}>
                    Choose File
                  </Button>
                  <span className="text-[13px] text-fg">{file ? `${file.name} · ${formatBytes(file.size)}` : 'No file chosen'}</span>
                  <input
                    ref={input}
                    type="file"
                    accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                    className="sr-only"
                    aria-label="Import file"
                    onChange={(e) => {
                      setFile(e.target.files?.[0] ?? null);
                      e.target.value = '';
                    }}
                  />
                </div>
                {tooBig ? <Banner tone="danger">The file is larger than 20 MB. Split it and import the parts separately.</Banner> : null}
                {progress !== null ? (
                  <div className="flex items-center gap-3 text-[13px] text-fg-2" aria-live="polite">
                    <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} aria-label="Upload progress">
                      <span className="block h-full bg-primary transition-[width]" style={{ width: `${progress}%` }} />
                    </span>
                    {progress < 100 ? `${progress}% uploaded` : 'Checking file…'}
                  </div>
                ) : null}
              </div>
            </Panel>
            <div className="flex flex-wrap justify-end gap-2">
              <Button onClick={onCancel} disabled={progress !== null && !error}>
                Cancel
              </Button>
              <Button variant="primary" onClick={() => void start()} disabled={!file || !chosen || tooBig} loading={progress !== null && !error}>
                Upload
              </Button>
            </div>
          </div>
        )}
      </QueryState>
    </div>
  );
};
