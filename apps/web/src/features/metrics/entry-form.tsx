'use client';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { metricsEndpoints as M, type EndpointBody, type MetricFieldDefinition, type ObservationDetail, type ObservationValidation } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { METRIC_ENTITY_TYPES, METRIC_SEGMENTS, METRIC_SOURCE_TYPES, VALUE_AVAILABILITY } from '@castlane/domain';
import { Badge, Banner, Button, DateTimeInput, Field, Input, Select, Skeleton, Textarea } from '@castlane/ui';
import { EntitySelect } from '@/components/common/entity-select';
import { FileUploader } from '@/components/media/file-uploader';
import { useApiMutation, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useWorkspace, useWsPath } from '@/lib/workspace-context';
import { errorMessage, fromLocalInput, MetricValueText, TimingBadge, toLocalInput, useInsightsMutation } from './common';

type EntityType = (typeof METRIC_ENTITY_TYPES)[number];
type Kind = 'snapshot' | 'period' | 'cumulative';
type Availability = (typeof VALUE_AVAILABILITY)[number];
type Body = EndpointBody<typeof M.create>;
interface Cell {
  availability: Availability | '';
  value: string;
  currency: string;
}

export interface ObservationFormInitial {
  entityType?: EntityType;
  entityId?: string | null;
  kind?: Kind;
  checkpointId?: string | null;
  /** Suggested observation time (defaults to now). */
  observedAt?: string | null;
}

const KINDS: Record<EntityType, Kind[]> = { account: ['snapshot', 'period'], publication: ['cumulative'], ofm_account: ['period'] };

const kindHelp: Record<Kind, string> = {
  snapshot: 'Values at one moment, such as followers shown on the profile.',
  period: 'Results reported for a closed period, such as a weekly insights export. Periods are never split or summed when they overlap.',
  cumulative: 'Totals of the publication so far (views, likes…). Later totals replace earlier ones; they are never added up.',
};

/**
 * S50 Metric Entry: entity, time semantics, source and evidence, then one row per catalogue field.
 * An empty row is not recorded; Unknown / Not Provided / Not Applicable stay distinct from 0.
 */
export const ObservationForm = ({ initial, onSaved, onCancel }: { initial?: ObservationFormInitial; onSaved: (o: ObservationDetail) => void; onCancel?: () => void }) => {
  const { workspace, user } = useWorkspace();
  const wsPath = useWsPath();
  const p = { workspaceId: workspace.id };
  const zone = user.timezone;
  const catalog = useApiQuery(M.catalog, { params: p }, { staleTime: 5 * 60_000 });
  const checkpoint = useApiQuery(M.checkpoint, { params: { ...p, checkpointId: initial?.checkpointId ?? '' } }, { enabled: !!initial?.checkpointId });

  const [entityType, setEntityType] = useState<EntityType>(initial?.entityType ?? 'account');
  const [entityId, setEntityId] = useState<string | null>(initial?.entityId ?? null);
  const [kind, setKind] = useState<Kind>(initial?.kind ?? KINDS[initial?.entityType ?? 'account'][0]!);
  const [observedAt, setObservedAt] = useState(toLocalInput(initial?.observedAt ?? new Date().toISOString(), zone));
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [segment, setSegment] = useState<(typeof METRIC_SEGMENTS)[number]>('unknown');
  const [sourceType, setSourceType] = useState<(typeof METRIC_SOURCE_TYPES)[number]>('manual');
  const [namespace, setNamespace] = useState('manual');
  const [sourceNote, setSourceNote] = useState('');
  const [evidence, setEvidence] = useState<string[]>([]);
  const [cells, setCells] = useState<Record<string, Cell>>({});
  const [warningNote, setWarningNote] = useState('');
  const [check, setCheck] = useState<ObservationValidation | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [duplicateOf, setDuplicateOf] = useState<string | null>(null);

  const defSet = catalog.data?.definitionSets.find((d) => d.current)?.version ?? 1;
  const fields = useMemo(
    () => (catalog.data?.fields ?? []).filter((f) => f.entityType === entityType && f.observationKind === kind && f.version === defSet && f.active),
    [catalog.data, entityType, kind, defSet],
  );
  const required = new Set(checkpoint.data?.requiredMetrics ?? []);

  const body = (): Body => ({
    entityType,
    entityId: entityId ?? '',
    kind,
    observedAt: fromLocalInput(kind === 'period' && !observedAt ? periodEnd : observedAt, zone) ?? '',
    periodStart: kind === 'period' ? fromLocalInput(periodStart, zone) : null,
    periodEnd: kind === 'period' ? fromLocalInput(periodEnd, zone) : null,
    platformTimezone: null,
    definitionSetVersion: defSet,
    segment,
    sourceType,
    sourceNamespace: namespace.trim() || 'manual',
    sourceNote: sourceNote.trim(),
    evidenceAssetIds: evidence,
    values: fields
      .filter((f) => cells[f.key]?.availability)
      .map((f) => {
        const c = cells[f.key]!;
        return { metricKey: f.key, availability: c.availability as Availability, value: c.availability === 'known' ? c.value.trim() || null : null, currency: f.valueType === 'money' ? c.currency || null : null };
      }),
    warningNote: warningNote.trim() || null,
    checkpointId: initial?.checkpointId ?? null,
  });

  const toErrors = (list: { field: string; message: string }[]) => {
    const out: Record<string, string> = {};
    for (const e of list) {
      const field = e.field.replace(/^body\./, '');
      const m = /^values\.(\d+)\./.exec(field);
      const key = m ? body().values[Number(m[1])]?.metricKey : null;
      out[key ? `value:${key}` : field] ??= e.message;
    }
    return out;
  };

  const validate = useApiMutation(M.validate, { silentErrors: true });
  const create = useInsightsMutation(M.create);

  const runCheck = async () => {
    setFormError(null);
    setDuplicateOf(null);
    if (!entityId) return setErrors({ entityId: 'Choose the account or publication.' });
    try {
      const r = await validate.run({ params: p, body: body() });
      setCheck(r);
      setErrors(toErrors(r.errors));
      if (r.duplicate) setDuplicateOf(r.duplicate.observationId);
      return r;
    } catch (e) {
      if (isApiError(e) && e.fieldErrors.length) setErrors(toErrors(e.fieldErrors));
      else setFormError(errorMessage(e));
      return null;
    }
  };

  const save = async () => {
    const r = await runCheck();
    if (!r || !r.ok || r.duplicate) return;
    if (r.requiresWarningNote && !warningNote.trim()) {
      setErrors((x) => ({ ...x, warningNote: 'Add a note explaining the warning before saving.' }));
      return;
    }
    try {
      const saved = await create.run({ params: p, body: body() });
      onSaved(saved);
    } catch (e) {
      if (isApiError(e) && e.code === 'DUPLICATE') setDuplicateOf((e.details?.observationId as string | undefined) ?? null);
      else if (isApiError(e) && e.fieldErrors.length) setErrors(toErrors(e.fieldErrors));
      else setFormError(errorMessage(e));
    }
  };

  const setCell = (key: string, patch: Partial<Cell>) => {
    setCells((c) => ({ ...c, [key]: { availability: '', value: '', currency: workspace.baseCurrency, ...c[key], ...patch } }));
    setCheck(null);
  };

  if (catalog.isLoading) return <Skeleton className="h-96 w-full" />;
  const cp = checkpoint.data;

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      noValidate
    >
      {cp ? (
        <Banner tone="info">
          {cp.label} for {cp.entity.label}: expected {toLocalInput(cp.expectedAt, zone).replace('T', ' ')} (window {toLocalInput(cp.windowStart, zone).slice(11)}–{toLocalInput(cp.windowEnd, zone).replace('T', ' ')}, {zone}). Enter
          the real time you read the values; an entry outside the window is kept and labelled Late or Early.
        </Banner>
      ) : null}

      <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Record for" required>
          <Select
            value={entityType}
            onChange={(v) => {
              if (!v) return;
              setEntityType(v);
              setEntityId(null);
              setKind(KINDS[v][0]!);
              setCells({});
              setCheck(null);
            }}
            options={METRIC_ENTITY_TYPES.map((t) => ({ value: t, label: label('metricEntityType', t) }))}
            disabled={!!initial?.checkpointId}
          />
        </Field>
        <Field label={entityType === 'publication' ? 'Publication' : 'Account'} required error={errors.entityId}>
          <EntitySelect
            type={entityType === 'publication' ? 'publication' : 'account'}
            value={entityId}
            onChange={(v) => {
              setEntityId(v);
              setCheck(null);
            }}
            placeholder={entityType === 'publication' ? 'Choose a published placement' : 'Choose an account'}
            disabled={!!initial?.checkpointId}
          />
        </Field>
        <Field label="Observation type" required helper={kindHelp[kind]}>
          <Select value={kind} onChange={(v) => {
              if (!v) return;
              setKind(v);
              setCells({});
              setCheck(null);
            }} options={KINDS[entityType].map((k) => ({ value: k, label: label('observationKind', k) }))} />
        </Field>
        <Field label="Segment" helper="Organic and paid breakdowns are never mixed with totals.">
          <Select value={segment} onChange={(v) => v && setSegment(v)} options={METRIC_SEGMENTS.map((s) => ({ value: s, label: label('metricSegment', s) }))} />
        </Field>
        {kind === 'period' ? (
          <>
            <Field label="Period start" required error={errors.periodStart}>
              <DateTimeInput timezone={zone} value={periodStart} onChange={(e) => {
                  setPeriodStart(e.target.value);
                  setCheck(null);
                }} />
            </Field>
            <Field label="Period end" required error={errors.periodEnd} helper="Results of a period can be recorded after it has ended.">
              <DateTimeInput timezone={zone} value={periodEnd} onChange={(e) => {
                  setPeriodEnd(e.target.value);
                  setCheck(null);
                }} />
            </Field>
          </>
        ) : null}
        <Field label="Observed at" required error={errors.observedAt} helper="When you read the values (the real time is kept, never rounded to a checkpoint).">
          <DateTimeInput timezone={zone} value={observedAt} onChange={(e) => {
              setObservedAt(e.target.value);
              setCheck(null);
            }} />
        </Field>
      </section>

      <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Source type" required>
          <Select value={sourceType} onChange={(v) => v && setSourceType(v)} options={METRIC_SOURCE_TYPES.map((s) => ({ value: s, label: label('metricSourceType', s) }))} />
        </Field>
        <Field label="Source name" helper="For example instagram_insights or agency_sheet. Different sources for the same moment are kept apart.">
          <Input value={namespace} onChange={(e) => setNamespace(e.target.value)} maxLength={60} />
        </Field>
        <Field label="Source note" required error={errors.sourceNote} helper="Where the numbers come from (screen, export, report)." className="md:col-span-2">
          <Textarea value={sourceNote} onChange={(e) => setSourceNote(e.target.value)} rows={2} maxLength={2000} />
        </Field>
        <div className="md:col-span-2">
          <p className="mb-1.5 text-[12px] font-[550] text-fg">Evidence (optional)</p>
          <FileUploader
            workspaceId={workspace.id}
            purpose="evidence"
            compact
            label="Upload screenshots or exports"
            hint="Evidence stays linked to this record."
            onUploaded={(i) => i.assetId && setEvidence((e) => (e.includes(i.assetId!) ? e : [...e, i.assetId!]))}
          />
          {errors.evidenceAssetIds ? <p className="mt-1 text-[12px] text-danger">{errors.evidenceAssetIds}</p> : null}
        </div>
      </section>

      <section aria-labelledby="values-title" className="flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="values-title" className="text-[16px] font-semibold text-fg">
            Values
          </h2>
          <p className="text-[12px] text-fg-2">Leave a row empty to not record it. Enter 0 only when the source reports 0.</p>
        </div>
        {errors.values ? <p className="text-[13px] text-danger">{errors.values}</p> : null}
        <ValuesEditor fields={fields} cells={cells} required={required} errors={errors} onChange={setCell} currency={workspace.baseCurrency} />
      </section>

      {check ? <CheckResult check={check} /> : null}
      {check?.requiresWarningNote || errors.warningNote ? (
        <Field label="Note about the warning" required error={errors.warningNote}>
          <Textarea value={warningNote} onChange={(e) => setWarningNote(e.target.value)} rows={2} maxLength={1000} />
        </Field>
      ) : null}
      {duplicateOf ? (
        <Banner
          tone="warning"
          action={
            <Link className="text-[13px] font-medium text-primary hover:underline" href={wsPath(`/metrics/${duplicateOf}?correct=1`)}>
              Open and Submit Correction
            </Link>
          }
        >
          These values were already recorded for the same moment, period and source. Submit a correction of that record or skip this entry.
        </Banner>
      ) : null}
      {formError ? <Banner tone="danger">{formError}</Banner> : null}

      <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-4">
        {onCancel ? (
          <Button type="button" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button type="button" onClick={() => void runCheck()} loading={validate.isPending}>
          Check Entry
        </Button>
        <Button type="submit" variant="primary" loading={create.isPending}>
          Save Metrics
        </Button>
      </div>
    </form>
  );
};

/** One row per catalogue field: availability and value; money fields carry their currency. */
export const ValuesEditor = ({
  fields,
  cells,
  required,
  errors,
  onChange,
  currency,
}: {
  fields: MetricFieldDefinition[];
  cells: Record<string, Cell>;
  required?: Set<string>;
  errors: Record<string, string>;
  onChange: (key: string, patch: Partial<Cell>) => void;
  currency: string;
}) =>
  fields.length === 0 ? (
    <p className="text-[13px] text-fg-2">Choose what the values are recorded for to see the fields.</p>
  ) : (
    <div className="overflow-x-auto rounded-[12px] border border-line">
      <table className="w-full min-w-[560px] text-left text-[13px]">
        <thead>
          <tr className="border-b border-line bg-surface-2">
            <th scope="col" className="px-3 py-2 font-[550] text-fg-2">
              Metric
            </th>
            <th scope="col" className="w-[190px] px-3 py-2 font-[550] text-fg-2">
              Availability
            </th>
            <th scope="col" className="w-[200px] px-3 py-2 font-[550] text-fg-2">
              Value
            </th>
          </tr>
        </thead>
        <tbody>
          {fields.map((f) => {
            const c = cells[f.key] ?? { availability: '', value: '', currency };
            const err = errors[`value:${f.key}`];
            return (
              <tr key={f.key} className="border-b border-line last:border-b-0 align-top">
                <th scope="row" className="px-3 py-2 font-normal">
                  <span className="flex flex-wrap items-center gap-1.5 font-medium text-fg">
                    {f.label}
                    {required?.has(f.key) ? <Badge tone="info">Required by checkpoint</Badge> : null}
                  </span>
                  <span className="block text-[12px] text-fg-2">{f.description}</span>
                </th>
                <td className="px-3 py-2">
                  <Select
                    aria-label={`${f.label} availability`}
                    value={c.availability || null}
                    placeholder="Not recorded"
                    clearable
                    onChange={(v) => onChange(f.key, { availability: v ?? '', value: v === 'known' ? c.value : '' })}
                    options={VALUE_AVAILABILITY.map((a) => ({ value: a, label: label('valueAvailability', a) }))}
                  />
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <Input
                        aria-label={`${f.label} value`}
                        aria-invalid={err ? true : undefined}
                        inputMode="decimal"
                        className="text-right font-mono tabular-nums"
                        value={c.value}
                        disabled={c.availability !== '' && c.availability !== 'known'}
                        onChange={(e) => onChange(f.key, { value: e.target.value, availability: e.target.value.trim() ? 'known' : c.availability === 'known' ? '' : c.availability })}
                      />
                      {f.valueType === 'money' ? (
                        <Input aria-label={`${f.label} currency`} className="w-[72px] uppercase" maxLength={3} value={c.currency} onChange={(e) => onChange(f.key, { currency: e.target.value.toUpperCase() })} />
                      ) : f.unit === 'seconds' ? (
                        <span className="text-[12px] text-fg-2">s</span>
                      ) : null}
                    </div>
                    {err ? <span className="text-[12px] text-danger">{err}</span> : null}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

const CheckResult = ({ check }: { check: ObservationValidation }) => (
  <div className="flex flex-col gap-2">
    {check.ok && !check.warnings.length && !check.duplicate ? <Banner tone="success">The entry is ready to save.</Banner> : null}
    {check.warnings.map((w) => (
      <Banner key={`${w.code}-${w.message}`} tone="warning">
        {w.message}
      </Banner>
    ))}
    {check.checkpoint ? (
      <p className="flex flex-wrap items-center gap-2 text-[13px] text-fg-2">
        Completes the checkpoint <span className="font-medium text-fg">{check.checkpoint.label}</span>
        <TimingBadge timing={check.checkpoint.timing} />
        {check.completeness ? (
          <>
            · required fields: <MetricValueText value={check.completeness} />
          </>
        ) : null}
      </p>
    ) : null}
  </div>
);
