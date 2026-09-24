'use client';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AnyEndpoint, CheckpointRow, MetricEntityRef, MetricValueDto, ObservationSummary } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { DateTime } from '@castlane/domain';
import { Badge, StatusBadge, Tooltip, formatDateTime, formatNumber, type Tone } from '@castlane/ui';
import { useApiMutation, type MutationOptions } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useWsPath } from '@/lib/workspace-context';
import './labels';

// ——— Microcopy (§31.2) ———

export const NO_DATA = 'No data recorded for this period.';
export const NOT_CALCULABLE = 'This rate cannot be calculated from the available data.';
export const OUT_OF_WINDOW = 'Recorded outside the target window';
export const STALE_REPORT = 'Stale report: Updated source data is available. Refresh this report.';

// ——— Time helpers (the API speaks UTC ISO; inputs are local to an explicit zone) ———

export const toLocalInput = (iso: string | null | undefined, zone: string) => (iso ? DateTime.fromISO(iso).setZone(zone).toFormat("yyyy-LL-dd'T'HH:mm") : '');

export const fromLocalInput = (value: string, zone: string): string | null => {
  if (!value) return null;
  const d = DateTime.fromISO(value, { zone });
  return d.isValid ? (d.toUTC().toISO() as string) : null;
};

export const errorMessage = (e: unknown, fallback = 'The action could not be completed.') => (isApiError(e) ? e.message : fallback);

/** Relative age of a source ("3 h ago") for KPI tooltips and freshness lines. */
export const sourceAge = (iso: string | null | undefined) => {
  if (!iso) return 'No source records';
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (mins < 60) return `${mins} min ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)} h ago`;
  return `${Math.round(mins / 1440)} days ago`;
};

// ——— Metric values ———

const UNIT_SUFFIX: Record<string, string> = { percent: '%', hours: 'h', seconds: 's', ratio: '', score: '', count: '', number: '' };

/** Numeric value of a metric for charts: null unless the value is known or partial (never 0 for unknown). */
export const chartNumber = (v: MetricValueDto | undefined | null): number | null => (v && v.value !== null && (v.status === 'known' || v.status === 'partial') ? Number(v.value) : null);

/** Text of a metric value: the number with its unit, or its availability state — never a fake 0. */
export const formatMetric = (v: MetricValueDto | undefined | null): string => {
  if (!v) return 'No data';
  if (v.value === null) return v.status === 'not_defined' && v.unit === 'percent' ? 'Not Defined' : label('metricStatus', v.status);
  const digits = v.unit === 'percent' || v.unit === 'hours' || v.unit === 'money' ? 2 : v.unit === 'ratio' ? 4 : 1;
  const n = v.unit === 'money' ? formatNumber(v.value, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : formatNumber(v.value, { maximumFractionDigits: digits });
  const suffix = v.unit === 'money' ? ` ${v.currency ?? ''}` : UNIT_SUFFIX[v.unit] ? (v.unit === 'percent' ? '%' : ` ${UNIT_SUFFIX[v.unit]}`) : '';
  return `${n}${suffix}`.trim();
};

/** Details line under a value: coverage, exclusions, missing fields, note. */
export const metricDetails = (v: MetricValueDto | undefined | null): string[] => {
  if (!v) return [];
  return [
    v.status === 'partial' ? 'Partial' : null,
    v.sampleSize !== undefined ? `Sample: ${v.sampleSize}` : null,
    v.coverage ? `Coverage: ${v.coverage.usable} of ${v.coverage.expected}` : null,
    ...(v.excluded ?? []).map((e) => `Excluded ${e.count}: ${e.reason}`),
    v.missing?.length ? `Missing: ${v.missing.join(', ')}` : null,
    v.note ?? null,
    v.status === 'not_defined' && v.unit === 'percent' ? NOT_CALCULABLE : null,
  ].filter((x): x is string => !!x);
};

/** A metric value with its availability state; unknown values are muted text, never zero. */
export const MetricValueText = ({ value, className }: { value: MetricValueDto | undefined | null; className?: string }) => {
  const text = formatMetric(value);
  const details = metricDetails(value);
  const body = (
    <span className={className}>
      <span className={value && value.value !== null ? 'font-mono tabular-nums text-fg' : 'text-fg-muted'}>{text}</span>
      {value?.status === 'partial' ? <span className="ml-1 text-[11px] text-warning">Partial</span> : null}
    </span>
  );
  return details.length ? (
    <Tooltip content={<span className="flex max-w-[280px] flex-col gap-0.5">{details.map((d) => <span key={d}>{d}</span>)}</span>}>
      <span tabIndex={0} className="rounded-[4px] focus-visible:outline-2 focus-visible:outline-[var(--c-focus)]">
        {body}
      </span>
    </Tooltip>
  ) : (
    body
  );
};

/** Stored observation value by availability (T103: "Unknown" and 0 are different things). */
export const ObservationValue = ({ availability, value, unit }: { availability: string; value: string | null; unit?: string }) =>
  availability === 'known' && value !== null ? (
    <span className="font-mono tabular-nums text-fg">
      {formatNumber(value, { maximumFractionDigits: 6 })}
      {unit === 'seconds' ? ' s' : ''}
    </span>
  ) : (
    <span className="text-fg-muted">{label('valueAvailability', availability)}</span>
  );

// ——— Badges ———

const QUALITY_TONE: Record<string, Tone> = { unverified: 'neutral', reviewed: 'success', superseded: 'neutral', pending_correction: 'warning', rejected: 'danger' };
export const QualityBadge = ({ quality }: { quality: string }) => <Badge tone={QUALITY_TONE[quality] ?? 'neutral'}>{label('metricQuality', quality)}</Badge>;

export const TimingBadge = ({ timing }: { timing: string | null | undefined }) =>
  timing ? (
    <Badge tone={timing === 'on_time' ? 'success' : 'warning'} title={timing === 'on_time' ? undefined : OUT_OF_WINDOW}>
      {label('checkpointTiming', timing)}
    </Badge>
  ) : null;

export const CheckpointStatusBadge = ({ status }: { status: CheckpointRow['status'] }) => <StatusBadge status={status} label={label('checkpointStatus', status)} />;

export const SourceText = ({ o }: { o: Pick<ObservationSummary, 'sourceType' | 'sourceNamespace'> }) => (
  <span className="text-fg-2">
    {label('metricSourceType', o.sourceType)}
    {o.sourceNamespace && o.sourceNamespace !== 'manual' ? ` · ${o.sourceNamespace}` : ''}
  </span>
);

export const EntityLink = ({ entity, children }: { entity: MetricEntityRef; children?: ReactNode }) => {
  const wsPath = useWsPath();
  return (
    <Link href={wsPath(entity.href)} className="min-w-0 font-medium text-fg hover:underline">
      {children ?? entity.label}
    </Link>
  );
};

export const EntityCell = ({ entity }: { entity: MetricEntityRef }) => (
  <span className="flex min-w-0 flex-col">
    <EntityLink entity={entity} />
    <span className="truncate text-[12px] text-fg-2">
      {[entity.sublabel, entity.platform ? label('platform', entity.platform) : null].filter(Boolean).join(' · ')}
    </span>
  </span>
);

export const When = ({ iso, zone }: { iso: string | null | undefined; zone?: string }) => <span className="whitespace-nowrap">{formatDateTime(iso, zone)}</span>;

// ——— Mutations ———

/** Mutation that refreshes metrics, analytics and report queries after success (inline errors). */
export const useInsightsMutation = <EP extends AnyEndpoint>(ep: EP, opts: Omit<MutationOptions<EP>, 'invalidate'> & { also?: string[] } = {}) => {
  const qc = useQueryClient();
  const { also, ...rest } = opts;
  return useApiMutation(ep, {
    silentErrors: true,
    ...rest,
    onSuccess: async (data, input) => {
      const prefixes = ['metrics.', 'analytics.', 'reports.', ...(also ?? [])];
      await qc.invalidateQueries({ predicate: (q) => prefixes.some((p) => String(q.queryKey[0] ?? '').startsWith(p)) });
      await rest.onSuccess?.(data, input);
    },
  });
};
