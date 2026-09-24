import { median, percentile } from '@castlane/analytics';
import {
  allocateLargestRemainder,
  Big,
  DateTime,
  parseAmountToMinor,
  toBig,
  type EnumValue,
  type TransitionTable,
  CAMPAIGN_STATUSES,
  EXPERIMENT_STATUSES,
  METRIC_SEGMENTS,
  PUBLICATION_STATUSES,
  ROUND_HALF_EVEN,
} from '@castlane/domain';

/**
 * Pure rules of the publishing module (no database): state tables, checkpoint windows, plan weeks,
 * conflict windows, comparable-results statistics and exact cost splits. Unit-tested next to this file.
 */

export type PublicationStatus = EnumValue<typeof PUBLICATION_STATUSES>;
export type CampaignStatus = EnumValue<typeof CAMPAIGN_STATUSES>;
export type ExperimentStatus = EnumValue<typeof EXPERIMENT_STATUSES>;
export type Segment = EnumValue<typeof METRIC_SEGMENTS>;

/** §12: Draft → Scheduled → Published; Scheduled → Failed/Cancelled; Failed → Scheduled (retry) or Cancelled. */
export const PUBLICATION_TRANSITIONS: TransitionTable<PublicationStatus> = {
  draft: ['scheduled'],
  scheduled: ['published', 'failed', 'cancelled'],
  failed: ['scheduled', 'cancelled'],
  published: [],
  cancelled: [],
};

export const CAMPAIGN_TRANSITIONS: TransitionTable<CampaignStatus> = {
  planned: ['active', 'closed'],
  active: ['closed'],
  closed: ['active', 'archived'],
  archived: ['closed'],
};

export const EXPERIMENT_TRANSITIONS: TransitionTable<ExperimentStatus> = {
  draft: ['running', 'archived'],
  running: ['concluded'],
  concluded: ['archived'],
  archived: [],
};

/** Two placements on one account closer than this are flagged (§12). */
export const CONFLICT_WINDOW_MINUTES = 15;
/** Mark Published accepts an actual time at most this far in the future (clock skew, §12). */
export const PUBLISH_SKEW_MINUTES = 5;
/** Default grace for "published on plan" (M09, workspace setting publicationGraceMinutes). */
export const DEFAULT_GRACE_MINUTES = 15;

export const withinConflictWindow = (a: Date, b: Date, minutes = CONFLICT_WINDOW_MINUTES): boolean =>
  Math.abs(a.getTime() - b.getTime()) < minutes * 60_000;

export interface CheckpointPolicyEntry {
  key: string;
  offsetHours: number;
  toleranceHours: number;
}

/** 24 → "24h", 168 → "7d", 12 → "12h". */
export const checkpointLabel = (offsetHours: number): string => (offsetHours > 24 && offsetHours % 24 === 0 ? `${offsetHours / 24}d` : `${offsetHours}h`);

/**
 * Checkpoints of one publication from its actual publication time: expected = published + offset,
 * target window = expected ± tolerance. Elapsed windows are computed in UTC (§12).
 */
export const checkpointWindows = (publishedAt: Date, policy: CheckpointPolicyEntry[]) =>
  policy.map((p) => {
    const expectedAt = new Date(publishedAt.getTime() + p.offsetHours * 3_600_000);
    const tol = p.toleranceHours * 3_600_000;
    return {
      key: p.key,
      label: checkpointLabel(p.offsetHours),
      offsetHours: p.offsetHours,
      expectedAt,
      windowStart: new Date(expectedAt.getTime() - tol),
      windowEnd: new Date(expectedAt.getTime() + tol),
    };
  });

/** Observation timing against a checkpoint window: outside the window is Early/Late, never silently on time. */
export const checkpointTiming = (observedAt: Date, windowStart: Date, windowEnd: Date): 'early' | 'on_time' | 'late' =>
  observedAt.getTime() < windowStart.getTime() ? 'early' : observedAt.getTime() > windowEnd.getTime() ? 'late' : 'on_time';

/** The plan week containing a moment, in the workspace zone (Monday 00:00 by default). */
export const planWeekOf = (moment: Date, zone: string, weekStartsOn: 'monday' | 'sunday' = 'monday') => {
  const local = DateTime.fromJSDate(moment, { zone }).startOf('day');
  const diff = weekStartsOn === 'monday' ? local.weekday - 1 : local.weekday % 7;
  const start = local.minus({ days: diff });
  return planWeekBounds(start.toISODate() as string, zone);
};

/** UTC bounds [start, end) of the week that starts on a local date (DST-safe: 7 local days, not 168 h). */
export const planWeekBounds = (weekStart: string, zone: string) => {
  const start = DateTime.fromISO(weekStart, { zone }).startOf('day');
  const end = start.plus({ days: 7 });
  return {
    weekStart: start.toISODate() as string,
    weekEnd: end.minus({ days: 1 }).toISODate() as string,
    start: start.toUTC().toJSDate(),
    end: end.toUTC().toJSDate(),
  };
};

/** M09 on-time test against the frozen baseline time (not the current plan). */
export const onTimeAgainstBaseline = (baselineAt: Date | null, publishedAt: Date | null, graceMinutes = DEFAULT_GRACE_MINUTES): boolean | null =>
  baselineAt && publishedAt ? publishedAt.getTime() <= baselineAt.getTime() + graceMinutes * 60_000 : null;

// ——— Experiments: comparable results (§12, T072) ———

export type ComparableState = 'comparable' | 'not_published' | 'too_young' | 'no_observation_in_window' | 'unknown_value' | 'removed';

export interface ComparableObservation {
  observedAt: Date;
  /** Known values only carry a decimal string; unknown / not provided are null (never 0). */
  value: string | null;
}

export interface ComparableInput {
  publicationId: string;
  variantId: string;
  segment: Segment;
  publishedAt: Date | null;
  removed: boolean;
  observations: ComparableObservation[];
}

export interface ComparableItem {
  publicationId: string;
  variantId: string;
  segment: Segment;
  state: ComparableState;
  ageHours: number | null;
  value: string | null;
  observedAt: Date | null;
  observedAgeHours: number | null;
}

const hours = (ms: number) => Math.round((ms / 3_600_000) * 100) / 100;

/** Tolerance around the comparison age: the matching checkpoint policy when there is one, else window/12 (≥ 1 h). */
export const comparisonTolerance = (windowHours: number, policy: CheckpointPolicyEntry[]): number =>
  policy.find((p) => p.offsetHours === windowHours)?.toleranceHours ?? Math.max(1, Math.round((windowHours / 12) * 100) / 100);

/**
 * Classify one linked placement: it is comparable only when it is published, at least `windowHours`
 * old, and has an observation taken at that same post age (± tolerance). The closest such
 * observation is used; an observation at another age is never compared (unequal post ages).
 */
export const classifyComparable = (item: ComparableInput, now: Date, windowHours: number, toleranceHours: number): ComparableItem => {
  const base = { publicationId: item.publicationId, variantId: item.variantId, segment: item.segment };
  if (!item.publishedAt) return { ...base, state: 'not_published', ageHours: null, value: null, observedAt: null, observedAgeHours: null };
  const ageHours = hours(now.getTime() - item.publishedAt.getTime());
  if (item.removed) return { ...base, state: 'removed', ageHours, value: null, observedAt: null, observedAgeHours: null };
  const target = item.publishedAt.getTime() + windowHours * 3_600_000;
  const tol = toleranceHours * 3_600_000;
  const inWindow = item.observations
    .filter((o) => Math.abs(o.observedAt.getTime() - target) <= tol)
    .sort((a, b) => Math.abs(a.observedAt.getTime() - target) - Math.abs(b.observedAt.getTime() - target) || b.observedAt.getTime() - a.observedAt.getTime());
  const best = inWindow[0];
  if (!best) {
    const state: ComparableState = now.getTime() < target - tol ? 'too_young' : 'no_observation_in_window';
    // Show when the nearest value was observed (e.g. only at 36 h) — its value never enters the comparison.
    const nearest = [...item.observations].sort((a, b) => Math.abs(a.observedAt.getTime() - target) - Math.abs(b.observedAt.getTime() - target))[0];
    return { ...base, state, ageHours, value: null, observedAt: nearest?.observedAt ?? null, observedAgeHours: nearest ? hours(nearest.observedAt.getTime() - item.publishedAt.getTime()) : null };
  }
  const observedAgeHours = hours(best.observedAt.getTime() - item.publishedAt.getTime());
  if (best.value === null) return { ...base, state: 'unknown_value', ageHours, value: null, observedAt: best.observedAt, observedAgeHours };
  return { ...base, state: 'comparable', ageHours, value: best.value, observedAt: best.observedAt, observedAgeHours };
};

export interface SampleStats {
  sampleSize: number;
  median: string | null;
  mean: string | null;
  min: string | null;
  max: string | null;
  /** Tukey fences (1.5 × IQR) when the sample has at least 4 values; otherwise none are flagged. */
  outliers: { key: string; value: string }[];
}

const fmt = (b: Big) => b.round(4, ROUND_HALF_EVEN).toString();

export const sampleStats = (values: { key: string; value: string }[]): SampleStats => {
  if (values.length === 0) return { sampleSize: 0, median: null, mean: null, min: null, max: null, outliers: [] };
  const nums = values.map((v) => toBig(v.value));
  const sorted = [...nums].sort((a, b) => a.cmp(b));
  const sum = nums.reduce((a, b) => a.plus(b), new Big(0));
  let outliers: { key: string; value: string }[] = [];
  if (values.length >= 4) {
    const q1 = toBig(percentile(sorted, 25)!);
    const q3 = toBig(percentile(sorted, 75)!);
    const iqr = q3.minus(q1);
    const lo = q1.minus(iqr.times(1.5));
    const hi = q3.plus(iqr.times(1.5));
    outliers = values.filter((v) => toBig(v.value).lt(lo) || toBig(v.value).gt(hi));
  }
  return {
    sampleSize: values.length,
    median: fmt(toBig(median(sorted)!)),
    mean: fmt(sum.div(values.length)),
    min: sorted[0]!.toString(),
    max: sorted[sorted.length - 1]!.toString(),
    outliers,
  };
};

export interface VariantSummary extends SampleStats {
  variantId: string;
  excluded: Record<ComparableState, number>;
}

/**
 * Comparable results per segment and variant. The status is `comparable` only when every variant
 * has at least `minimumSample` comparable values in a segment; there is deliberately no winner —
 * the owner chooses one with an explanation when concluding.
 */
export const summarizeComparable = (items: ComparableItem[], variantIds: string[], minimumSample: number) => {
  const segments = [...new Set(items.map((i) => i.segment))].sort((a, b) => METRIC_SEGMENTS.indexOf(a) - METRIC_SEGMENTS.indexOf(b));
  const reasons: string[] = [];
  const out = segments.map((segment) => ({
    segment,
    variants: variantIds.map((variantId): VariantSummary => {
      const mine = items.filter((i) => i.segment === segment && i.variantId === variantId);
      const excluded = { comparable: 0, not_published: 0, too_young: 0, no_observation_in_window: 0, unknown_value: 0, removed: 0 } as Record<ComparableState, number>;
      for (const i of mine) if (i.state !== 'comparable') excluded[i.state]++;
      return { variantId, excluded, ...sampleStats(mine.filter((i) => i.state === 'comparable').map((i) => ({ key: i.publicationId, value: i.value! }))) };
    }),
  }));
  if (items.length === 0) return { status: 'no_data' as const, reasons: ['No placements are linked yet.'], segments: out };
  if (items.every((i) => i.state !== 'comparable')) reasons.push('No placement has a value observed at the comparison age yet.');
  if (items.some((i) => i.state === 'too_young')) reasons.push('Some placements are younger than the comparison window; their values are not compared.');
  if (items.some((i) => i.state === 'no_observation_in_window')) reasons.push('Some placements have no observation at the comparison age (observations at other ages are Not Comparable).');
  if (items.some((i) => i.state === 'unknown_value')) reasons.push('Some observations do not report this metric (unknown is not zero).');
  const variantsOf = out.flatMap((s) => s.variants);
  let status: 'comparable' | 'not_comparable' | 'insufficient_sample';
  if (variantsOf.every((v) => v.sampleSize >= minimumSample)) status = 'comparable';
  else if (variantsOf.some((v) => v.sampleSize === 0)) status = 'not_comparable';
  else status = 'insufficient_sample';
  if (status === 'insufficient_sample') reasons.push(`Each variant needs at least ${minimumSample} comparable placement(s) per segment.`);
  if (status === 'not_comparable' && items.some((i) => i.state === 'comparable')) reasons.push('At least one variant has no comparable placement in a segment.');
  return { status, reasons, segments: out };
};

// ——— Campaign cost split (T071) ———

export type CostSplitMethod = 'equal' | 'weights' | 'amounts';

/**
 * Split an amount (minor units) across projects. Equal/weights use the largest-remainder method so
 * the parts always sum exactly to the source; exact amounts must add up to the source themselves.
 */
export const splitCostMinor = (
  totalMinor: bigint,
  currency: string,
  method: CostSplitMethod,
  shares: { projectId: string; weight?: string; amount?: string }[],
): { ok: true; parts: Map<string, bigint> } | { ok: false; error: string } => {
  const ids = shares.map((s) => s.projectId);
  if (new Set(ids).size !== ids.length) return { ok: false, error: 'Each project can appear only once.' };
  if (shares.length === 0) return { ok: false, error: 'Choose at least one project.' };
  if (method === 'amounts') {
    const parts = new Map<string, bigint>();
    for (const s of shares) {
      if (!s.amount) return { ok: false, error: 'Enter an amount for every project.' };
      try {
        parts.set(s.projectId, parseAmountToMinor(s.amount, currency));
      } catch {
        return { ok: false, error: `Amounts must use at most the minor units of ${currency}.` };
      }
    }
    const sum = [...parts.values()].reduce((a, b) => a + b, 0n);
    if (sum !== totalMinor) return { ok: false, error: 'The amounts must add up exactly to the line amount.' };
    return { ok: true, parts };
  }
  const weighted = shares.map((s) => ({ key: s.projectId, weight: method === 'equal' ? '1' : (s.weight ?? '') }));
  if (weighted.some((w) => !/^\d+(\.\d+)?$/.test(w.weight))) return { ok: false, error: 'Enter a weight for every project.' };
  if (weighted.every((w) => toBig(w.weight).eq(0))) return { ok: false, error: 'At least one weight must be above zero.' };
  return { ok: true, parts: allocateLargestRemainder(totalMinor, weighted) };
};

/** Share of a part in percent with 4 decimals (stored as the allocation's share_percent). */
export const sharePercent = (part: bigint, total: bigint): string | null =>
  total === 0n ? null : toBig(part.toString()).div(toBig(total.toString())).times(100).round(4, ROUND_HALF_EVEN).toFixed(4);

// ——— Campaign source reports ———

export interface SourceReportInput {
  id: string;
  sourceName: string;
  attributionLabel: string;
  periodStart: Date;
  periodEnd: Date;
  clicks: number | null;
  conversions: number | null;
}

/**
 * Per-source totals. Reports of one source whose periods overlap are not summed (the data would be
 * counted twice); unknown values stay unknown. Different sources are never deduplicated here, so the
 * cross-source total is labelled as a sum of reported values.
 */
export const summarizeSources = (reports: SourceReportInput[]) => {
  const bySource = new Map<string, SourceReportInput[]>();
  for (const r of reports) {
    const key = `${r.sourceName.trim().toLowerCase()}|${r.attributionLabel}`;
    bySource.set(key, [...(bySource.get(key) ?? []), r]);
  }
  const sources = [...bySource.values()].map((rows) => {
    const sorted = [...rows].sort((a, b) => a.periodStart.getTime() - b.periodStart.getTime());
    let overlapping = false;
    for (let i = 1; i < sorted.length; i++) if (sorted[i]!.periodStart.getTime() < sorted[i - 1]!.periodEnd.getTime()) overlapping = true;
    const sum = (k: 'clicks' | 'conversions') => {
      if (overlapping) return { value: null, note: 'Reports of this source overlap in time; choose non-overlapping periods.' };
      const known = sorted.map((r) => r[k]).filter((v): v is number => v !== null);
      if (known.length === 0) return { value: null, note: 'Not reported by this source.' };
      const partial = known.length < sorted.length;
      return { value: String(known.reduce((a, b) => a + b, 0)), note: partial ? 'Some reports of this source did not include this value.' : null };
    };
    const clicks = sum('clicks');
    const conversions = sum('conversions');
    const bothKnownRows = sorted.filter((r) => r.clicks !== null && r.conversions !== null);
    let conversionRate: { value: string | null; note: string | null } = { value: null, note: 'This rate cannot be calculated from the available data.' };
    if (!overlapping && bothKnownRows.length === sorted.length && bothKnownRows.length > 0) {
      const c = bothKnownRows.reduce((a, r) => a + r.clicks!, 0);
      const v = bothKnownRows.reduce((a, r) => a + r.conversions!, 0);
      conversionRate = c > 0 ? { value: toBig(v).div(c).times(100).round(2, ROUND_HALF_EVEN).toFixed(2), note: null } : { value: null, note: 'No reported clicks: the rate is not defined.' };
    }
    return {
      sourceName: sorted[0]!.sourceName,
      attributionLabel: sorted[0]!.attributionLabel,
      reports: sorted.length,
      clicks,
      conversions,
      conversionRate,
      overlapping,
      periodStart: sorted[0]!.periodStart,
      periodEnd: new Date(Math.max(...sorted.map((r) => r.periodEnd.getTime()))),
    };
  });
  const total = (k: 'clicks' | 'conversions') => {
    const vals = sources.map((s) => s[k].value).filter((v): v is string => v !== null);
    if (vals.length === 0) return { value: null, note: 'No data recorded for this period.' };
    return {
      value: vals.reduce((a, b) => a.plus(toBig(b)), new Big(0)).toString(),
      note: sources.length > 1 ? 'Sum of source-reported values; sources are not deduplicated and may overlap.' : null,
    };
  };
  return { sources, totals: { clicks: total('clicks'), conversions: total('conversions') } };
};
