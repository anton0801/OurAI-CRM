'use client';
import Link from 'next/link';
import { Plus, Trash } from '@phosphor-icons/react';
import { useMemo, useState } from 'react';
import { metricsEndpoints as M, type EndpointBody, type EndpointResponse } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { METRIC_INPUT_LIMITS, METRIC_SOURCE_TYPES } from '@castlane/domain';
import { Badge, Banner, Button, Checkbox, DateTimeInput, Field, IconButton, Input, Select, Skeleton, Textarea } from '@castlane/ui';
import { EntitySelect } from '@/components/common/entity-select';
import { useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useWorkspace, useWsPath } from '@/lib/workspace-context';
import { errorMessage, fromLocalInput, toLocalInput, useInsightsMutation } from './common';

type Dataset = 'account_snapshot' | 'account_period' | 'publication_cumulative';
const DATASETS: Record<Dataset, { entityType: 'account' | 'publication'; kind: 'snapshot' | 'period' | 'cumulative'; headline: string[] }> = {
  account_snapshot: { entityType: 'account', kind: 'snapshot', headline: ['account.followers', 'account.following', 'account.total_posts'] },
  account_period: { entityType: 'account', kind: 'period', headline: ['account.views', 'account.impressions', 'account.reach', 'account.profile_visits', 'account.link_clicks'] },
  publication_cumulative: { entityType: 'publication', kind: 'cumulative', headline: ['publication.views', 'publication.likes', 'publication.comments', 'publication.shares', 'publication.saves'] },
};

interface Row {
  id: number;
  entityId: string | null;
  cells: Record<string, string>;
}

/** Cell text → availability: empty = not recorded; ? = Unknown; n/p = Not Provided; n/a = Not Applicable. */
const parseCell = (text: string) => {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  if (t === '?' || t === 'unknown') return { availability: 'unknown' as const, value: null };
  if (t === 'n/p' || t === 'np') return { availability: 'not_provided' as const, value: null };
  if (t === 'n/a' || t === 'na') return { availability: 'not_applicable' as const, value: null };
  return { availability: 'known' as const, value: text.replace(/\s/g, '') };
};

type Result = EndpointResponse<typeof M.bulk>['results'][number];

/** Bulk Entry grid (S50): one observation per row with shared time and source; invalid rows are reported and never saved. */
export const BulkEntry = () => {
  const { workspace, user } = useWorkspace();
  const wsPath = useWsPath();
  const zone = user.timezone;
  const p = { workspaceId: workspace.id };
  const catalog = useApiQuery(M.catalog, { params: p }, { staleTime: 5 * 60_000 });
  const [dataset, setDataset] = useState<Dataset>('account_snapshot');
  const [allFields, setAllFields] = useState(false);
  const [observedAt, setObservedAt] = useState(toLocalInput(new Date().toISOString(), zone));
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [sourceType, setSourceType] = useState<(typeof METRIC_SOURCE_TYPES)[number]>('manual');
  const [namespace, setNamespace] = useState('manual');
  const [note, setNote] = useState('');
  const [rows, setRows] = useState<Row[]>([{ id: 1, entityId: null, cells: {} }]);
  const [results, setResults] = useState<Result[] | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const bulk = useInsightsMutation(M.bulk);
  const spec = DATASETS[dataset];
  const defSet = catalog.data?.definitionSets.find((d) => d.current)?.version ?? 1;
  const fields = useMemo(() => {
    const all = (catalog.data?.fields ?? []).filter((f) => f.entityType === spec.entityType && f.observationKind === spec.kind && f.version === defSet && f.active);
    return allFields ? all : all.filter((f) => spec.headline.includes(f.key));
  }, [catalog.data, spec, defSet, allFields]);

  const submit = async () => {
    setFormError(null);
    const used = rows.filter((r) => r.entityId);
    if (!used.length) return setFormError('Add at least one row with an account or publication.');
    const common = {
      kind: spec.kind,
      observedAt: fromLocalInput(spec.kind === 'period' && !observedAt ? periodEnd : observedAt, zone) ?? '',
      periodStart: spec.kind === 'period' ? fromLocalInput(periodStart, zone) : null,
      periodEnd: spec.kind === 'period' ? fromLocalInput(periodEnd, zone) : null,
      definitionSetVersion: defSet,
      segment: 'unknown' as const,
      sourceType,
      sourceNamespace: namespace.trim() || 'manual',
      sourceNote: note.trim(),
      evidenceAssetIds: [],
    };
    const body: EndpointBody<typeof M.bulk> = {
      rows: used.map((r) => ({
        ...common,
        entityType: spec.entityType,
        entityId: r.entityId!,
        values: fields.flatMap((f) => {
          const v = parseCell(r.cells[f.key] ?? '');
          return v ? [{ metricKey: f.key, ...v, currency: null }] : [];
        }),
      })),
    };
    try {
      const res = await bulk.run({ params: p, body });
      setResults(res.results);
    } catch (e) {
      setFormError(isApiError(e) && e.fieldErrors.length ? e.fieldErrors[0]!.message : errorMessage(e));
    }
  };

  if (catalog.isLoading) return <Skeleton className="h-80 w-full" />;
  const usedRows = rows.filter((r) => r.entityId);

  return (
    <div className="flex flex-col gap-5">
      <section className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Field label="What to record" required>
          <Select
            value={dataset}
            onChange={(v) => {
              if (!v) return;
              setDataset(v);
              setRows([{ id: 1, entityId: null, cells: {} }]);
              setResults(null);
            }}
            options={(Object.keys(DATASETS) as Dataset[]).map((d) => ({ value: d, label: label('observationDataset', d) }))}
          />
        </Field>
        {spec.kind === 'period' ? (
          <>
            <Field label="Period start" required>
              <DateTimeInput timezone={zone} value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
            </Field>
            <Field label="Period end" required>
              <DateTimeInput timezone={zone} value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
            </Field>
          </>
        ) : null}
        <Field label="Observed at" required helper="Shared by every row.">
          <DateTimeInput timezone={zone} value={observedAt} onChange={(e) => setObservedAt(e.target.value)} />
        </Field>
        <Field label="Source type" required>
          <Select value={sourceType} onChange={(v) => v && setSourceType(v)} options={METRIC_SOURCE_TYPES.map((s) => ({ value: s, label: label('metricSourceType', s) }))} />
        </Field>
        <Field label="Source name">
          <Input value={namespace} onChange={(e) => setNamespace(e.target.value)} maxLength={60} />
        </Field>
        <Field label="Source note" required className="md:col-span-3">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={2000} />
        </Field>
      </section>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12px] text-fg-2">Empty cell = not recorded · ? = Unknown · n/p = Not Provided · n/a = Not Applicable. Enter 0 only when the source reports 0.</p>
        <Checkbox checked={allFields} onCheckedChange={setAllFields} label="Show all fields" />
      </div>

      <div className="overflow-x-auto rounded-[12px] border border-line">
        <table className="w-full min-w-[720px] text-left text-[13px]">
          <caption className="sr-only">Bulk metric entry</caption>
          <thead>
            <tr className="border-b border-line bg-surface-2">
              <th scope="col" className="w-[260px] px-3 py-2 font-[550] text-fg-2">
                {spec.entityType === 'publication' ? 'Publication' : 'Account'}
              </th>
              {fields.map((f) => (
                <th key={f.key} scope="col" className="min-w-[110px] px-3 py-2 text-right font-[550] text-fg-2">
                  {f.label}
                </th>
              ))}
              <th scope="col" className="w-[120px] px-3 py-2 font-[550] text-fg-2">
                Result
              </th>
              <th scope="col" className="w-12 px-2 py-2">
                <span className="sr-only">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const idx = usedRows.indexOf(r);
              const res = results && idx >= 0 ? results[idx] : undefined;
              return (
                <tr key={r.id} className="border-b border-line last:border-b-0 align-top">
                  <td className="px-3 py-2">
                    <EntitySelect
                      type={spec.entityType === 'publication' ? 'publication' : 'account'}
                      aria-label={`Row ${r.id} ${spec.entityType}`}
                      value={r.entityId}
                      onChange={(v) => setRows((rs) => rs.map((x) => (x.id === r.id ? { ...x, entityId: v } : x)))}
                    />
                  </td>
                  {fields.map((f) => (
                    <td key={f.key} className="px-2 py-2">
                      <Input
                        aria-label={`Row ${r.id} ${f.label}`}
                        className="text-right font-mono tabular-nums"
                        value={r.cells[f.key] ?? ''}
                        onChange={(e) => setRows((rs) => rs.map((x) => (x.id === r.id ? { ...x, cells: { ...x.cells, [f.key]: e.target.value } } : x)))}
                      />
                    </td>
                  ))}
                  <td className="px-3 py-2">
                    {res ? (
                      res.ok ? (
                        <Link href={wsPath(`/metrics/${res.observationId}`)} className="hover:underline">
                          <Badge tone="success">Saved</Badge>
                        </Link>
                      ) : (
                        <span className="flex flex-col gap-1">
                          <Badge tone="danger">Not saved</Badge>
                          {res.duplicateOf ? (
                            <Link href={wsPath(`/metrics/${res.duplicateOf}`)} className="text-[12px] text-primary hover:underline">
                              Already recorded
                            </Link>
                          ) : (
                            <span className="text-[12px] text-danger">{res.errors[0]?.message}</span>
                          )}
                        </span>
                      )
                    ) : null}
                  </td>
                  <td className="px-2 py-2">
                    <IconButton label={`Remove row ${r.id}`} variant="ghost" icon={<Trash size={16} />} onClick={() => setRows((rs) => (rs.length > 1 ? rs.filter((x) => x.id !== r.id) : rs))} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {formError ? <Banner tone="danger">{formError}</Banner> : null}
      {results ? (
        <Banner tone={results.every((r) => r.ok) ? 'success' : 'warning'}>
          {results.filter((r) => r.ok).length} of {results.length} rows saved. Rows that were not saved changed nothing; fix them and submit them again.
        </Banner>
      ) : null}
      <div className="flex flex-wrap justify-between gap-2 border-t border-line pt-4">
        <Button
          icon={<Plus size={14} />}
          onClick={() => setRows((rs) => [...rs, { id: Math.max(...rs.map((x) => x.id)) + 1, entityId: null, cells: {} }])}
          disabled={rows.length >= METRIC_INPUT_LIMITS.bulkRows}
        >
          Add Row
        </Button>
        <Button variant="primary" loading={bulk.isPending} onClick={() => void submit()}>
          Save Rows
        </Button>
      </div>
    </div>
  );
};
