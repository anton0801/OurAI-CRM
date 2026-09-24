import { and, asc, desc, eq, gt, inArray, lt, ne, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { can } from '@castlane/authorization';
import { counterIssue, valueCompleteness, checkpointTiming, type CheckpointTiming } from '@castlane/analytics';
import { assets, metricCheckpoints, metricObservations, metricValues, publications, socialAccounts } from '@castlane/database';
import type { MetricEntityRef, ObservationDetail, ObservationSummary } from '@castlane/api-contracts';
import { AppError, METRIC_INPUT_LIMITS, clampPageSize, decodeCursor, encodeCursor, isDecimalString, isSupportedCurrency, newId, notFound, toBig, type FieldError } from '@castlane/domain';
import { allowed, authorizeObject, authorizeRead, requirePermission, scopePredicate } from '../core/access';
import { audit } from '../core/audit';
import { all, dbOf, type CommandContext, type QueryContext } from '../core/context';
import { emit } from '../core/events';
import { loadMemberRefs, refOrUnknown } from '../core/members';
import { notify } from '../core/notify';
import { assertVersion, lockById, stamp, touch } from '../core/rows';
import { canReadAsset, linkAsset } from '../media/assets';
import {
  HEADLINE_FIELDS,
  activePolicy,
  checkpointLabel,
  datasetKeyOf,
  fieldsFor,
  loadFieldDefinitions,
  requiredMetricsFor,
  type FieldDefinition,
  type MetricEntityType,
  type ObservationKind,
} from './catalog';
import { accountLabelOf, iso, loadProjectNames, plainDecimal, type Ctx } from './common';

type ObservationRow = typeof metricObservations.$inferSelect;
type ValueRow = typeof metricValues.$inferSelect;
type CheckpointRowDb = typeof metricCheckpoints.$inferSelect;
type Availability = ValueRow['availability'];
type Segment = ObservationRow['segment'];
type SourceType = ObservationRow['sourceType'];

/** Quality states of the revision currently in use (superseded / rejected / pending never count). */
export const ACTIVE_QUALITY = ['unverified', 'reviewed'] as const;
export const activeObservation = (t = metricObservations): SQL => sql`${t.qualityState} IN ('unverified', 'reviewed')`;

/** Warnings that need an explanatory note when the entry is saved anyway (§15.3). */
export const NOTE_REQUIRED_WARNINGS = new Set(['REACH_ABOVE_IMPRESSIONS', 'COMPLETIONS_ABOVE_VIEWS', 'CUMULATIVE_DECREASE', 'PERIOD_OVERLAP']);

export const LATE_OBSERVATION_TEXT = 'Recorded outside the target window';

// ——— Entities ———

export interface MetricEntity {
  type: MetricEntityType;
  id: string;
  accountId: string;
  projectId: string;
  publicationId: string | null;
  platform: (typeof socialAccounts.$inferSelect)['platform'];
  label: string;
  sublabel: string | null;
  publishedAt: Date | null;
  publicationStatus: string | null;
  accountStatus: string;
  ofm: boolean;
  ownerMembershipId: string;
}

export const entityScope = (e: { projectId: string; accountId: string }, objectId?: string) => ({
  objectType: 'metric_observation',
  objectId: objectId ?? null,
  projectId: e.projectId,
  accountId: e.accountId,
});

export const entityRefOf = (e: MetricEntity): MetricEntityRef => ({
  type: e.type,
  id: e.id,
  label: e.label,
  sublabel: e.sublabel,
  accountId: e.accountId,
  projectId: e.projectId,
  publicationId: e.publicationId,
  platform: e.platform,
  href: e.type === 'publication' ? `/publications/${e.id}` : `/accounts/${e.accountId}`,
});

/** Load metric entities (accounts / OFM accounts / publications) of the workspace by (type, id). */
export const loadEntities = async (ctx: Ctx, keys: { type: MetricEntityType; id: string }[]): Promise<Map<string, MetricEntity>> => {
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const out = new Map<string, MetricEntity>();
  const pubIds = [...new Set(keys.filter((k) => k.type === 'publication').map((k) => k.id))];
  const pubRows = pubIds.length
    ? await db
        .select({ id: publications.id, accountId: publications.accountId, projectId: publications.projectId, status: publications.status, actualPublishedAt: publications.actualPublishedAt, ownerMembershipId: publications.ownerMembershipId, contentItemId: publications.contentItemId })
        .from(publications)
        .where(and(eq(publications.workspaceId, ws), inArray(publications.id, pubIds), sql`${publications.deletedAt} IS NULL`))
    : [];
  const titles = pubRows.length
    ? await db.execute<{ id: string; title: string }>(sql`SELECT id, title FROM content_items WHERE workspace_id = ${ws} AND id IN (${sql.join(pubRows.map((p) => sql`${p.contentItemId}::uuid`), sql`, `)})`)
    : { rows: [] as { id: string; title: string }[] };
  const titleBy = new Map(titles.rows.map((r) => [r.id, r.title]));
  const accountIds = [...new Set([...keys.filter((k) => k.type !== 'publication').map((k) => k.id), ...pubRows.map((p) => p.accountId)])];
  const accRows = accountIds.length ? await db.select().from(socialAccounts).where(and(eq(socialAccounts.workspaceId, ws), inArray(socialAccounts.id, accountIds), sql`${socialAccounts.deletedAt} IS NULL`)) : [];
  const accBy = new Map(accRows.map((a) => [a.id, a]));
  const projectInfo = await loadProjectNames(db, ws, accRows.map((a) => a.projectId));
  for (const k of keys) {
    if (k.type === 'publication') {
      const p = pubRows.find((x) => x.id === k.id);
      const a = p ? accBy.get(p.accountId) : undefined;
      if (!p || !a) continue;
      out.set(`publication:${k.id}`, {
        type: 'publication',
        id: p.id,
        accountId: p.accountId,
        projectId: p.projectId,
        publicationId: p.id,
        platform: a.platform,
        label: titleBy.get(p.contentItemId) ?? 'Publication',
        sublabel: accountLabelOf(a),
        publishedAt: p.actualPublishedAt,
        publicationStatus: p.status,
        accountStatus: a.status,
        ofm: false,
        ownerMembershipId: p.ownerMembershipId,
      });
    } else {
      const a = accBy.get(k.id);
      if (!a) continue;
      const proj = projectInfo.get(a.projectId);
      out.set(`${k.type}:${k.id}`, {
        type: k.type,
        id: a.id,
        accountId: a.id,
        projectId: a.projectId,
        publicationId: null,
        platform: a.platform,
        label: accountLabelOf(a),
        sublabel: proj?.name ?? null,
        publishedAt: null,
        publicationStatus: null,
        accountStatus: a.status,
        ofm: !!proj && proj.ofmEnabled && proj.type !== 'series',
        ownerMembershipId: a.ownerMembershipId,
      });
    }
  }
  return out;
};

export const loadEntity = async (ctx: Ctx, type: MetricEntityType, id: string) => (await loadEntities(ctx, [{ type, id }])).get(`${type}:${id}`) ?? null;

// ——— Input normalisation & checks ———

export interface ObservationInputValue {
  metricKey: string;
  availability: Availability;
  value?: string | null;
  currency?: string | null;
}

export interface ObservationCreateInput {
  entityType: MetricEntityType;
  entityId: string;
  kind: ObservationKind;
  observedAt: string;
  periodStart?: string | null;
  periodEnd?: string | null;
  platformTimezone?: string | null;
  definitionSetVersion?: number;
  segment?: Segment;
  sourceType: SourceType;
  sourceNamespace?: string;
  sourceNote: string;
  evidenceAssetIds?: string[];
  values: ObservationInputValue[];
  warningNote?: string | null;
  checkpointId?: string | null;
}

export interface NormalizedValue {
  metricKey: string;
  availability: Availability;
  value: string | null;
  currency: string | null;
  unit: string;
  valueType: FieldDefinition['valueType'];
  label: string;
}

export const normalizeNamespace = (ns: string | undefined | null) => (ns ?? 'manual').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '_').slice(0, 60) || 'manual';

/** Duplicate key (§15.3): entity + definition set + kind + observed_at or period + segment + source namespace. */
export const observationDedupeKey = (o: { entityType: string; entityId: string; definitionSetVersion: number; kind: string; observedAt: Date; periodStart: Date | null; periodEnd: Date | null; segment: string; sourceNamespace: string }) =>
  `${observationSlot(o)}:${o.sourceNamespace}`;

/** The same key without the source: several sources of one period share a slot, one is canonical. */
export const observationSlot = (o: { entityType: string; entityId: string; definitionSetVersion: number; kind: string; observedAt: Date; periodStart: Date | null; periodEnd: Date | null; segment: string }) =>
  `${o.entityType}:${o.entityId}:v${o.definitionSetVersion}:${o.kind}:${o.kind === 'period' && o.periodStart && o.periodEnd ? `${o.periodStart.toISOString()}/${o.periodEnd.toISOString()}` : o.observedAt.toISOString()}:${o.segment}`;

const slotOfKey = (dedupeKey: string) => dedupeKey.slice(0, dedupeKey.lastIndexOf(':'));

/** Values of one observation checked against the catalogue (compatibility, units, counters, money). */
export const checkValues = (defs: FieldDefinition[], allowedFields: FieldDefinition[], values: ObservationInputValue[], errors: FieldError[]): NormalizedValue[] => {
  const out: NormalizedValue[] = [];
  const seen = new Set<string>();
  values.forEach((v, i) => {
    const f = allowedFields.find((d) => d.key === v.metricKey);
    const path = `values.${i}`;
    if (!f) {
      errors.push({
        field: `${path}.metricKey`,
        code: 'INCOMPATIBLE_DEFINITION',
        message: defs.some((d) => d.key === v.metricKey) ? `${v.metricKey} is not part of this observation type and definition set.` : `Unknown metric ${v.metricKey}.`,
      });
      return;
    }
    if (seen.has(v.metricKey)) {
      errors.push({ field: `${path}.metricKey`, code: 'DUPLICATE_FIELD', message: `${f.label} is listed twice.` });
      return;
    }
    seen.add(v.metricKey);
    const raw = v.value === undefined || v.value === null ? null : String(v.value).trim();
    const value = raw === '' ? null : raw;
    const currency = v.currency ? v.currency.trim().toUpperCase() : null;
    if (v.availability !== 'known') {
      if (value !== null) errors.push({ field: `${path}.value`, code: 'VALUE_WITHOUT_KNOWN', message: `Mark ${f.label} as Known to enter a value, or clear it.` });
      out.push({ metricKey: f.key, availability: v.availability, value: null, currency: null, unit: f.unit, valueType: f.valueType, label: f.label });
      return;
    }
    if (value === null) {
      errors.push({ field: `${path}.value`, code: 'REQUIRED', message: `Enter ${f.label} or mark it Unknown.` });
      return;
    }
    if (!isDecimalString(value)) {
      errors.push({ field: `${path}.value`, code: 'NOT_A_NUMBER', message: `${f.label}: enter a number.` });
      return;
    }
    if (f.valueType === 'integer') {
      const issue = counterIssue(value, METRIC_INPUT_LIMITS.counterMax);
      if (issue) {
        errors.push({ field: `${path}.value`, code: 'INVALID_COUNTER', message: `${f.label}: ${issue}` });
        return;
      }
    } else if (toBig(value).lt(0)) {
      errors.push({ field: `${path}.value`, code: 'NEGATIVE', message: `${f.label} cannot be negative.` });
      return;
    }
    if (f.valueType === 'money') {
      if (!currency || !isSupportedCurrency(currency)) {
        errors.push({ field: `${path}.currency`, code: 'CURRENCY_REQUIRED', message: `${f.label}: choose the currency.` });
        return;
      }
    } else if (currency) {
      errors.push({ field: `${path}.currency`, code: 'CURRENCY_NOT_ALLOWED', message: `${f.label} has no currency.` });
      return;
    }
    const decimals = (value.split('.')[1] ?? '').length;
    if (decimals > 6) {
      errors.push({ field: `${path}.value`, code: 'TOO_PRECISE', message: `${f.label}: use at most 6 decimals.` });
      return;
    }
    out.push({ metricKey: f.key, availability: 'known', value: toBig(value).toString(), currency: f.valueType === 'money' ? currency : null, unit: f.unit, valueType: f.valueType, label: f.label });
  });
  return out;
};

const valueOf = (vals: NormalizedValue[], key: string) => {
  const v = vals.find((x) => x.metricKey.endsWith(`.${key}`) && x.availability === 'known');
  return v?.value ?? null;
};

/** Plausibility warnings between fields of the same observation (§15.3) — warnings, not prohibitions. */
export const crossFieldWarnings = (vals: NormalizedValue[]): FieldError[] => {
  const w: FieldError[] = [];
  const reach = valueOf(vals, 'reach');
  const impressions = valueOf(vals, 'impressions');
  if (reach && impressions && toBig(reach).gt(toBig(impressions)))
    w.push({ field: 'values', code: 'REACH_ABOVE_IMPRESSIONS', message: 'Reach is higher than impressions. Source definitions can differ — add a note that explains it.' });
  const completions = valueOf(vals, 'completions');
  const views = valueOf(vals, 'views');
  if (completions && views && toBig(completions).gt(toBig(views)))
    w.push({ field: 'values', code: 'COMPLETIONS_ABOVE_VIEWS', message: 'Completed views are higher than views. Check the source and add a note.' });
  return w;
};

export interface ObservationCheck {
  errors: FieldError[];
  warnings: FieldError[];
  entity: MetricEntity | null;
  values: NormalizedValue[];
  observedAt: Date | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  definitionSetVersion: number;
  segment: Segment;
  sourceNamespace: string;
  duplicate: ObservationRow | null;
  alternate: ObservationRow | null;
  checkpoint: { row: CheckpointRowDb; timing: CheckpointTiming } | null;
  requiresWarningNote: boolean;
  dedupeKey: string | null;
  completeness: ReturnType<typeof valueCompleteness> | null;
}

const parseInstant = (v: string | null | undefined) => (v ? new Date(v) : null);

/**
 * Full preflight of an entry: entity access, dataset/definition compatibility, value rules, time
 * rules, duplicate key, alternate sources, cumulative decrease, overlapping periods, checkpoint.
 */
export const checkObservation = async (ctx: Ctx, input: ObservationCreateInput): Promise<ObservationCheck> => {
  const errors: FieldError[] = [];
  const warnings: FieldError[] = [];
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const now = ctx.app.clock.now();
  const definitionSetVersion = input.definitionSetVersion ?? 1;
  const segment = input.segment ?? 'unknown';
  const sourceNamespace = normalizeNamespace(input.sourceNamespace);
  const base: ObservationCheck = {
    errors,
    warnings,
    entity: null,
    values: [],
    observedAt: null,
    periodStart: null,
    periodEnd: null,
    definitionSetVersion,
    segment,
    sourceNamespace,
    duplicate: null,
    alternate: null,
    checkpoint: null,
    requiresWarningNote: false,
    dedupeKey: null,
    completeness: null,
  };

  const entity = await loadEntity(ctx, input.entityType, input.entityId);
  if (!entity) throw notFound(input.entityType === 'publication' ? 'Publication' : 'Account');
  authorizeObject(ctx, 'metrics.write', entityScope(entity), 'metrics.read');
  base.entity = entity;

  if (input.entityType === 'ofm_account' && !entity.ofm) errors.push({ field: 'entityType', code: 'NOT_OFM', message: 'OFM results can be recorded only for accounts of OFM-enabled Model or Influencer projects.' });
  if (entity.type === 'publication' && (entity.publicationStatus !== 'published' || !entity.publishedAt))
    errors.push({ field: 'entityId', code: 'NOT_PUBLISHED', message: 'Metrics can be recorded after the publication is confirmed as published.' });

  const dataset = datasetKeyOf(input.entityType, input.kind);
  if (!dataset) errors.push({ field: 'kind', code: 'INVALID_KIND', message: input.entityType === 'publication' ? 'Publications take cumulative observations.' : input.entityType === 'ofm_account' ? 'OFM results are recorded for a period.' : 'Accounts take snapshot or period observations.' });

  const defs = await loadFieldDefinitions(ctx);
  const allowedFields = dataset ? fieldsFor(defs, input.entityType, input.kind, definitionSetVersion) : [];
  if (dataset && allowedFields.length === 0) errors.push({ field: 'definitionSetVersion', code: 'UNKNOWN_DEFINITION_SET', message: `Definition set v${definitionSetVersion} has no fields for this observation type.` });
  const values = checkValues(defs, allowedFields, input.values, errors);
  base.values = values;
  if (values.length && !values.some((v) => v.availability === 'known'))
    errors.push({ field: 'values', code: 'NO_KNOWN_VALUE', message: 'Enter at least one known value. To close a request without data, use Mark Unavailable.' });

  // Times (§15.3): observed_at ≤ now + 5 min; period end > start and already over; cumulative after publication.
  const observedAt = parseInstant(input.observedAt);
  const tolerance = METRIC_INPUT_LIMITS.futureToleranceMinutes * 60_000;
  base.observedAt = observedAt;
  if (!observedAt || Number.isNaN(observedAt.getTime())) errors.push({ field: 'observedAt', code: 'REQUIRED', message: 'Enter when the values were observed.' });
  else if (observedAt.getTime() > now.getTime() + tolerance) errors.push({ field: 'observedAt', code: 'IN_FUTURE', message: 'Observed At cannot be in the future.' });
  const periodStart = parseInstant(input.periodStart);
  const periodEnd = parseInstant(input.periodEnd);
  if (input.kind === 'period') {
    if (!periodStart) errors.push({ field: 'periodStart', code: 'REQUIRED', message: 'Enter the period start.' });
    if (!periodEnd) errors.push({ field: 'periodEnd', code: 'REQUIRED', message: 'Enter the period end.' });
    if (periodStart && periodEnd) {
      if (periodEnd.getTime() <= periodStart.getTime()) errors.push({ field: 'periodEnd', code: 'BEFORE_START', message: 'The period end must be after its start.' });
      else if (periodEnd.getTime() > now.getTime() + tolerance) errors.push({ field: 'periodEnd', code: 'PERIOD_NOT_OVER', message: 'Results of a period that has not ended cannot be recorded.' });
      else if (observedAt && observedAt.getTime() + tolerance < periodEnd.getTime()) errors.push({ field: 'observedAt', code: 'BEFORE_PERIOD_END', message: 'Observed At must be at or after the period end.' });
    }
    base.periodStart = periodStart;
    base.periodEnd = periodEnd;
  } else if (periodStart || periodEnd) {
    errors.push({ field: 'periodStart', code: 'NOT_A_PERIOD', message: 'Snapshot and cumulative observations have no period; use Observed At.' });
  }
  if (input.kind === 'cumulative' && observedAt && entity.publishedAt && observedAt.getTime() < entity.publishedAt.getTime())
    errors.push({ field: 'observedAt', code: 'BEFORE_PUBLICATION', message: 'Cumulative results cannot be observed before the publication went live.' });

  // Evidence must exist and be readable by the member.
  const evidence = [...new Set(input.evidenceAssetIds ?? [])];
  if (evidence.length) {
    const rows = await db.select().from(assets).where(and(eq(assets.workspaceId, ws), inArray(assets.id, evidence)));
    for (const id of evidence) {
      const a = rows.find((r) => r.id === id);
      if (!a || !(await canReadAsset(ctx, a))) errors.push({ field: 'evidenceAssetIds', code: 'NOT_FOUND', message: 'An evidence file was not found or is not available to you.' });
    }
  }

  warnings.push(...crossFieldWarnings(values));

  if (observedAt && !Number.isNaN(observedAt.getTime()) && dataset && (input.kind !== 'period' || (periodStart && periodEnd))) {
    const keyInput = { entityType: input.entityType, entityId: input.entityId, definitionSetVersion, kind: input.kind, observedAt, periodStart, periodEnd, segment, sourceNamespace };
    base.dedupeKey = observationDedupeKey(keyInput);
    const slot = observationSlot(keyInput);
    const sameSlot = await db
      .select()
      .from(metricObservations)
      .where(and(eq(metricObservations.workspaceId, ws), activeObservation(), sql`left(${metricObservations.dedupeKey}, ${slot.length + 1}) = ${`${slot}:`}`));
    base.duplicate = sameSlot.find((r) => r.dedupeKey === base.dedupeKey) ?? null;
    base.alternate = sameSlot.find((r) => r.dedupeKey !== base.dedupeKey && r.canonical) ?? null;
    if (!base.duplicate && base.alternate)
      warnings.push({
        field: 'sourceNamespace',
        code: 'ALTERNATE_SOURCE',
        message: `Another source (${base.alternate.sourceNamespace}) already reports this ${input.kind === 'period' ? 'period' : 'moment'}. That record stays in use for reports; you can switch the source on the saved record.`,
      });

    // Cumulative totals should not decrease (T107: a decrease is a source correction, not negative views).
    if (input.kind === 'cumulative') {
      const earlier = await db
        .select({ key: metricValues.metricKey, value: metricValues.value, observedAt: metricObservations.observedAt })
        .from(metricValues)
        .innerJoin(metricObservations, eq(metricObservations.id, metricValues.observationId))
        .where(
          and(
            eq(metricObservations.workspaceId, ws),
            eq(metricObservations.entityType, 'publication'),
            eq(metricObservations.entityId, input.entityId),
            eq(metricObservations.segment, segment),
            eq(metricObservations.definitionSetVersion, definitionSetVersion),
            eq(metricObservations.canonical, true),
            activeObservation(),
            lt(metricObservations.observedAt, observedAt),
            eq(metricValues.availability, 'known'),
          ),
        )
        .orderBy(desc(metricObservations.observedAt));
      for (const v of values) {
        if (v.availability !== 'known' || v.valueType === 'decimal') continue;
        const prev = earlier.find((e) => e.key === v.metricKey);
        if (prev?.value && toBig(v.value!).lt(toBig(prev.value)))
          warnings.push({
            field: 'values',
            code: 'CUMULATIVE_DECREASE',
            message: `${v.label} is lower than the ${toBig(prev.value).toString()} recorded at ${prev.observedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC. It is treated as a source correction, not as negative consumption — add the reason.`,
          });
      }
    }

    // Overlapping periods of the same entity/segment/definition set are never summed (T105).
    if (input.kind === 'period' && periodStart && periodEnd && periodEnd > periodStart) {
      const overlaps = await db
        .select()
        .from(metricObservations)
        .where(
          and(
            eq(metricObservations.workspaceId, ws),
            eq(metricObservations.entityType, input.entityType),
            eq(metricObservations.entityId, input.entityId),
            eq(metricObservations.kind, 'period'),
            eq(metricObservations.segment, segment),
            eq(metricObservations.definitionSetVersion, definitionSetVersion),
            eq(metricObservations.canonical, true),
            activeObservation(),
            lt(metricObservations.periodStart, periodEnd),
            gt(metricObservations.periodEnd, periodStart),
            sql`NOT (${metricObservations.periodStart} = ${periodStart} AND ${metricObservations.periodEnd} = ${periodEnd})`,
          ),
        )
        .limit(5);
      for (const o of overlaps)
        warnings.push({
          field: 'periodStart',
          code: 'PERIOD_OVERLAP',
          message: `This period overlaps ${o.periodStart!.toISOString().slice(0, 10)} – ${o.periodEnd!.toISOString().slice(0, 10)} (${o.sourceNamespace}). Overlapping periods are never summed until one of them is excluded from reports.`,
        });
    }

    // Checkpoint: explicit choice (Metrics Inbox) or the pending checkpoint whose window contains observed_at.
    const cpEntityType = input.entityType === 'publication' ? 'publication' : 'account';
    const eligibleKind = input.entityType === 'publication' ? input.kind === 'cumulative' : input.entityType === 'account' && input.kind === 'snapshot';
    if (input.checkpointId) {
      const [cp] = await db.select().from(metricCheckpoints).where(and(eq(metricCheckpoints.workspaceId, ws), eq(metricCheckpoints.id, input.checkpointId)));
      if (!cp || cp.entityId !== (cpEntityType === 'publication' ? input.entityId : entity.accountId) || cp.entityType !== cpEntityType || !eligibleKind)
        errors.push({ field: 'checkpointId', code: 'CHECKPOINT_MISMATCH', message: 'This checkpoint belongs to another entity or observation type.' });
      else if (cp.state !== 'pending') errors.push({ field: 'checkpointId', code: 'CHECKPOINT_CLOSED', message: `This checkpoint is already ${cp.state}.` });
      else base.checkpoint = { row: cp, timing: checkpointTiming(observedAt, cp.windowStart, cp.windowEnd) };
    } else if (eligibleKind) {
      const [cp] = await db
        .select()
        .from(metricCheckpoints)
        .where(
          and(
            eq(metricCheckpoints.workspaceId, ws),
            eq(metricCheckpoints.entityType, cpEntityType),
            eq(metricCheckpoints.entityId, cpEntityType === 'publication' ? input.entityId : entity.accountId),
            eq(metricCheckpoints.state, 'pending'),
            sql`${metricCheckpoints.windowStart} <= ${observedAt} AND ${metricCheckpoints.windowEnd} >= ${observedAt}`,
          ),
        )
        .orderBy(sql`abs(extract(epoch FROM (${metricCheckpoints.expectedAt} - ${observedAt})))`)
        .limit(1);
      if (cp) base.checkpoint = { row: cp, timing: 'on_time' };
    }
    if (base.checkpoint && base.checkpoint.timing !== 'on_time')
      warnings.push({ field: 'observedAt', code: base.checkpoint.timing === 'late' ? 'CHECKPOINT_LATE' : 'CHECKPOINT_EARLY', message: `${LATE_OBSERVATION_TEXT}: the real observed time is kept and the value is excluded from standard checkpoint comparisons.` });
    if (base.checkpoint) {
      const policy = await activePolicy(ctx);
      base.completeness = valueCompleteness(values, requiredMetricsFor(base.checkpoint.row.checkpointKey, policy.config));
    }
  }

  base.requiresWarningNote = warnings.some((w) => NOTE_REQUIRED_WARNINGS.has(w.code));
  if (base.requiresWarningNote && !input.warningNote?.trim()) errors.push({ field: 'warningNote', code: 'NOTE_REQUIRED', message: 'Add a note explaining the warning before saving.' });
  return base;
};

// ——— Commands ———

export interface CreateObservationOptions {
  importJobId?: string | null;
}

/** Save one observation, its values, evidence links and the checkpoint it completes. */
export const createObservation = async (ctx: CommandContext, input: ObservationCreateInput, opts: CreateObservationOptions = {}): Promise<string> => {
  requirePermission(ctx, 'metrics.write');
  const c = await checkObservation(ctx, input);
  if (c.errors.length) throw new AppError('VALIDATION_FAILED', c.errors[0]!.message, { fieldErrors: c.errors });
  const entity = c.entity!;
  const slot = observationSlot({ entityType: input.entityType, entityId: input.entityId, definitionSetVersion: c.definitionSetVersion, kind: input.kind, observedAt: c.observedAt!, periodStart: c.periodStart, periodEnd: c.periodEnd, segment: c.segment });
  // Serialise entries of one slot so canonical selection and duplicate detection stay consistent.
  await ctx.tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`metric-slot:${ctx.actor.workspaceId}:${slot}`}))`);
  const [dup] = await ctx.tx
    .select({ id: metricObservations.id })
    .from(metricObservations)
    .where(and(eq(metricObservations.workspaceId, ctx.actor.workspaceId), eq(metricObservations.dedupeKey, c.dedupeKey!), activeObservation()));
  if (dup)
    throw new AppError('DUPLICATE', 'These values were already recorded for the same moment, period and source. Submit a correction of that record or skip this entry.', { details: { observationId: dup.id } });
  const [alt] = await ctx.tx
    .select({ id: metricObservations.id })
    .from(metricObservations)
    .where(and(eq(metricObservations.workspaceId, ctx.actor.workspaceId), activeObservation(), eq(metricObservations.canonical, true), sql`left(${metricObservations.dedupeKey}, ${slot.length + 1}) = ${`${slot}:`}`));
  const id = newId();
  const now = ctx.app.clock.now();
  await ctx.tx.insert(metricObservations).values({
    ...stamp(ctx),
    id,
    entityType: input.entityType,
    entityId: input.entityId,
    accountId: entity.accountId,
    projectId: entity.projectId,
    publicationId: entity.publicationId,
    kind: input.kind,
    observedAt: c.observedAt!,
    periodStart: c.periodStart,
    periodEnd: c.periodEnd,
    platformTimezone: input.platformTimezone ?? null,
    definitionSetVersion: c.definitionSetVersion,
    segment: c.segment,
    sourceType: input.sourceType,
    sourceNamespace: c.sourceNamespace,
    sourceNote: input.sourceNote.trim(),
    evidenceAssetIds: [...new Set(input.evidenceAssetIds ?? [])],
    enteredAt: now,
    enteredByMembershipId: ctx.actor.membershipId,
    qualityState: 'unverified',
    revisionNo: 1,
    rootObservationId: id,
    warnings: c.warnings.map((w) => w.code),
    warningNote: input.warningNote?.trim() || null,
    dedupeKey: c.dedupeKey!,
    canonical: !alt,
    checkpointId: c.checkpoint?.row.id ?? null,
    importJobId: opts.importJobId ?? null,
  });
  await insertValues(ctx, id, c.values, c.definitionSetVersion);
  if (c.checkpoint) await completeCheckpoint(ctx, c.checkpoint.row.id, id, c.observedAt!);
  await linkEvidence(ctx, id, input.evidenceAssetIds ?? []);
  await audit(ctx, {
    action: 'metric_observation.created',
    entityType: 'metric_observation',
    entityId: id,
    projectId: entity.projectId,
    metadata: {
      entityType: input.entityType,
      entityId: input.entityId,
      kind: input.kind,
      observedAt: c.observedAt!.toISOString(),
      periodStart: iso(c.periodStart),
      periodEnd: iso(c.periodEnd),
      sourceType: input.sourceType,
      sourceNamespace: c.sourceNamespace,
      values: c.values.map((v) => ({ key: v.metricKey, availability: v.availability, value: v.value })),
      warnings: c.warnings.map((w) => w.code),
      canonical: !alt,
    },
  });
  await emit(ctx, { type: 'metric_observation.created', entityType: 'metric_observation', entityId: id, revision: 1, payload: { entityType: input.entityType, kind: input.kind } });
  return id;
};

const insertValues = async (ctx: CommandContext, observationId: string, values: NormalizedValue[], definitionVersion: number) => {
  if (!values.length) return;
  await ctx.tx.insert(metricValues).values(
    values.map((v) => ({
      ...stamp(ctx),
      id: newId(),
      observationId,
      metricKey: v.metricKey,
      definitionVersion,
      value: v.value,
      availability: v.availability,
      unit: v.unit,
      currency: v.currency,
    })),
  );
};

/** Mark the checkpoint Completed with the real observation (T068: timing from the actual observed_at). */
export const completeCheckpoint = async (ctx: CommandContext, checkpointId: string, observationId: string, observedAt: Date) => {
  const [cp] = await ctx.tx.select().from(metricCheckpoints).where(and(eq(metricCheckpoints.workspaceId, ctx.actor.workspaceId), eq(metricCheckpoints.id, checkpointId))).for('update');
  if (!cp || cp.state !== 'pending') return false;
  const timing = checkpointTiming(observedAt, cp.windowStart, cp.windowEnd);
  await ctx.tx
    .update(metricCheckpoints)
    .set({ state: 'completed', completedObservationId: observationId, timing, ...touch(ctx, metricCheckpoints) })
    .where(eq(metricCheckpoints.id, cp.id));
  await audit(ctx, { action: 'metric_checkpoint.completed', entityType: 'metric_checkpoint', entityId: cp.id, projectId: cp.projectId, metadata: { observationId, timing, observedAt: observedAt.toISOString() } });
  await emit(ctx, { type: 'metric_checkpoint.completed', entityType: 'metric_checkpoint', entityId: cp.id, revision: cp.rowVersion + 1, payload: { timing } });
  return true;
};

/** Evidence stays attached to the observation (links only when the member may link files). */
const linkEvidence = async (ctx: CommandContext, observationId: string, assetIds: string[]) => {
  for (const assetId of [...new Set(assetIds)]) {
    await ctx.tx.execute(sql`SAVEPOINT metric_evidence`);
    try {
      await linkAsset(ctx, assetId, { target: { entityType: 'metric_observation', entityId: observationId, role: 'evidence' }, holding: true });
      await ctx.tx.execute(sql`RELEASE SAVEPOINT metric_evidence`);
    } catch (e) {
      await ctx.tx.execute(sql`ROLLBACK TO SAVEPOINT metric_evidence`);
      if (!(e instanceof AppError)) throw e;
    }
  }
};

/** Bulk entry grid: every row saved (or rejected) on its own; duplicates are reported, never replaced. */
export const bulkCreateObservations = async (ctx: CommandContext, rows: ObservationCreateInput[]) => {
  requirePermission(ctx, 'metrics.write');
  const results: { index: number; ok: boolean; observationId: string | null; errors: FieldError[]; duplicateOf: string | null }[] = [];
  for (let i = 0; i < rows.length; i++) {
    await ctx.tx.execute(sql`SAVEPOINT metric_bulk_row`);
    try {
      const id = await createObservation(ctx, rows[i]!);
      await ctx.tx.execute(sql`RELEASE SAVEPOINT metric_bulk_row`);
      results.push({ index: i, ok: true, observationId: id, errors: [], duplicateOf: null });
    } catch (e) {
      await ctx.tx.execute(sql`ROLLBACK TO SAVEPOINT metric_bulk_row`);
      if (!(e instanceof AppError)) throw e;
      const fieldErrors = e.fieldErrors?.length ? e.fieldErrors : [{ field: 'row', code: e.code, message: e.message }];
      results.push({ index: i, ok: false, observationId: null, errors: fieldErrors, duplicateOf: e.code === 'DUPLICATE' ? ((e.details?.observationId as string | undefined) ?? null) : null });
    }
  }
  const created = results.filter((r) => r.ok).length;
  return { created, failed: results.length - created, results };
};

const lockObservation = async (ctx: CommandContext, id: string) => {
  const o = await lockById(ctx, metricObservations, id, 'Observation');
  return o;
};

const loadValues = async (ctx: Ctx, observationIds: string[]) =>
  observationIds.length ? dbOf(ctx).select().from(metricValues).where(and(eq(metricValues.workspaceId, ctx.actor.workspaceId), inArray(metricValues.observationId, observationIds))) : [];

/**
 * Submit Correction: a new revision of the same key awaiting review. The current values stay in
 * use until an approver accepts it (T106); only one correction per record can wait at a time.
 */
export const submitCorrection = async (
  ctx: CommandContext,
  id: string,
  input: { values: ObservationInputValue[]; reason: string; sourceType?: SourceType; sourceNote?: string; evidenceAssetIds?: string[]; warningNote?: string | null },
) => {
  const cur = await lockObservation(ctx, id);
  authorizeObject(ctx, 'metrics.revise', entityScope(cur, cur.id), 'metrics.read');
  assertVersion(ctx, cur);
  if (!(ACTIVE_QUALITY as readonly string[]).includes(cur.qualityState))
    throw new AppError('INVALID_STATE', cur.qualityState === 'superseded' ? 'A newer revision of this record exists. Correct the current revision.' : 'Only the revision in use can be corrected.');
  const [pending] = await ctx.tx
    .select({ id: metricObservations.id })
    .from(metricObservations)
    .where(and(eq(metricObservations.workspaceId, ctx.actor.workspaceId), eq(metricObservations.rootObservationId, cur.rootObservationId), eq(metricObservations.qualityState, 'pending_correction')));
  if (pending) throw new AppError('INVALID_STATE', 'A correction of this record is already awaiting review.', { details: { revisionId: pending.id } });
  const defs = await loadFieldDefinitions(ctx);
  const allowedFields = fieldsFor(defs, cur.entityType, cur.kind, cur.definitionSetVersion);
  const errors: FieldError[] = [];
  const values = checkValues(defs, allowedFields, input.values, errors);
  if (values.length && !values.some((v) => v.availability === 'known')) errors.push({ field: 'values', code: 'NO_KNOWN_VALUE', message: 'Enter at least one known value.' });
  const current = await loadValues(ctx, [cur.id]);
  const same =
    values.length === current.length &&
    values.every((v) => {
      const c = current.find((x) => x.metricKey === v.metricKey);
      return c && c.availability === v.availability && (c.value === null ? v.value === null : v.value !== null && toBig(c.value).eq(toBig(v.value))) && (c.currency?.trim() ?? null) === v.currency;
    });
  if (!errors.length && same) errors.push({ field: 'values', code: 'NO_CHANGE', message: 'The correction does not change any value.' });
  const warnings = crossFieldWarnings(values);
  if (warnings.length && !input.warningNote?.trim()) errors.push({ field: 'warningNote', code: 'NOTE_REQUIRED', message: 'Add a note explaining the warning before saving.' });
  if (input.evidenceAssetIds?.length) {
    const rows = await ctx.tx.select().from(assets).where(and(eq(assets.workspaceId, ctx.actor.workspaceId), inArray(assets.id, input.evidenceAssetIds)));
    for (const aid of input.evidenceAssetIds) {
      const a = rows.find((r) => r.id === aid);
      if (!a || !(await canReadAsset(ctx, a))) errors.push({ field: 'evidenceAssetIds', code: 'NOT_FOUND', message: 'An evidence file was not found or is not available to you.' });
    }
  }
  if (errors.length) throw new AppError('VALIDATION_FAILED', errors[0]!.message, { fieldErrors: errors });
  const [maxRev] = await ctx.tx
    .select({ n: sql<number>`max(${metricObservations.revisionNo})::int` })
    .from(metricObservations)
    .where(and(eq(metricObservations.workspaceId, ctx.actor.workspaceId), eq(metricObservations.rootObservationId, cur.rootObservationId)));
  const revId = newId();
  const now = ctx.app.clock.now();
  await ctx.tx.insert(metricObservations).values({
    ...stamp(ctx),
    id: revId,
    entityType: cur.entityType,
    entityId: cur.entityId,
    accountId: cur.accountId,
    projectId: cur.projectId,
    publicationId: cur.publicationId,
    kind: cur.kind,
    observedAt: cur.observedAt,
    periodStart: cur.periodStart,
    periodEnd: cur.periodEnd,
    platformTimezone: cur.platformTimezone,
    definitionSetVersion: cur.definitionSetVersion,
    segment: cur.segment,
    sourceType: input.sourceType ?? cur.sourceType,
    sourceNamespace: cur.sourceNamespace,
    sourceNote: input.sourceNote?.trim() || cur.sourceNote,
    evidenceAssetIds: input.evidenceAssetIds ? [...new Set(input.evidenceAssetIds)] : cur.evidenceAssetIds,
    enteredAt: now,
    enteredByMembershipId: ctx.actor.membershipId,
    qualityState: 'pending_correction',
    revisionNo: (maxRev?.n ?? cur.revisionNo) + 1,
    rootObservationId: cur.rootObservationId,
    supersedesId: cur.id,
    correctionReason: input.reason.trim(),
    warnings: warnings.map((w) => w.code),
    warningNote: input.warningNote?.trim() || null,
    dedupeKey: cur.dedupeKey,
    canonical: cur.canonical,
    checkpointId: cur.checkpointId,
  });
  await insertValues(ctx, revId, values, cur.definitionSetVersion);
  if (input.evidenceAssetIds?.length) await linkEvidence(ctx, revId, input.evidenceAssetIds);
  // The record under correction changes state (a correction waits): concurrent edits see a new version.
  await ctx.tx.update(metricObservations).set({ ...touch(ctx, metricObservations) }).where(eq(metricObservations.id, cur.id));
  await audit(ctx, {
    action: 'metric_observation.correction_submitted',
    entityType: 'metric_observation',
    entityId: cur.id,
    projectId: cur.projectId,
    reason: input.reason,
    metadata: { revisionId: revId, values: values.map((v) => ({ key: v.metricKey, availability: v.availability, value: v.value })) },
  });
  await emit(ctx, { type: 'metric_observation.correction_submitted', entityType: 'metric_observation', entityId: cur.id, payload: { revisionId: revId } });
  return revId;
};

const lockPendingRevision = async (ctx: CommandContext, revisionId: string, action: string) => {
  const rev = await lockObservation(ctx, revisionId);
  authorizeObject(ctx, action, entityScope(rev, rev.id), 'metrics.read');
  assertVersion(ctx, rev);
  if (rev.qualityState !== 'pending_correction') throw new AppError('INVALID_STATE', 'This correction is no longer awaiting review.');
  return rev;
};

/** Approve Correction: old revision Superseded, the correction becomes the canonical record (T106). */
export const approveCorrection = async (ctx: CommandContext, revisionId: string, input: { decisionNote?: string }) => {
  const rev = await lockPendingRevision(ctx, revisionId, 'metrics.approve');
  if (rev.enteredByMembershipId && rev.enteredByMembershipId === ctx.actor.membershipId && !ctx.actor.access.isOwner)
    throw new AppError('FORBIDDEN', 'A correction must be approved by another member.');
  const prev = rev.supersedesId ? await lockObservation(ctx, rev.supersedesId) : null;
  if (!prev || !(ACTIVE_QUALITY as readonly string[]).includes(prev.qualityState)) throw new AppError('INVALID_STATE', 'The corrected record is no longer current.');
  const now = ctx.app.clock.now();
  await ctx.tx.update(metricObservations).set({ qualityState: 'superseded', ...touch(ctx, metricObservations) }).where(eq(metricObservations.id, prev.id));
  await ctx.tx
    .update(metricObservations)
    .set({ qualityState: 'reviewed', reviewedBy: ctx.actor.membershipId, reviewedAt: now, decisionNote: input.decisionNote?.trim() || null, canonical: prev.canonical, ...touch(ctx, metricObservations) })
    .where(eq(metricObservations.id, rev.id));
  await ctx.tx
    .update(metricCheckpoints)
    .set({ completedObservationId: rev.id, ...touch(ctx, metricCheckpoints) })
    .where(and(eq(metricCheckpoints.workspaceId, ctx.actor.workspaceId), eq(metricCheckpoints.completedObservationId, prev.id)));
  const [oldVals, newVals] = await all(ctx, [() => loadValues(ctx, [prev.id]), () => loadValues(ctx, [rev.id])] as const);
  const diff: Record<string, { from?: unknown; to?: unknown }> = {};
  for (const k of new Set([...oldVals.map((v) => v.metricKey), ...newVals.map((v) => v.metricKey)])) {
    const a = oldVals.find((v) => v.metricKey === k);
    const b = newVals.find((v) => v.metricKey === k);
    const fa = a ? (a.availability === 'known' ? a.value : a.availability) : null;
    const fb = b ? (b.availability === 'known' ? b.value : b.availability) : null;
    if (fa !== fb) diff[k] = { from: fa, to: fb };
  }
  await audit(ctx, { action: 'metric_observation.correction_approved', entityType: 'metric_observation', entityId: rev.id, projectId: rev.projectId, reason: input.decisionNote ?? null, diff, metadata: { supersededId: prev.id } });
  await emit(ctx, { type: 'metric_observation.corrected', entityType: 'metric_observation', entityId: rev.id, payload: { supersededId: prev.id } });
  if (rev.enteredByMembershipId)
    await notify(ctx.tx, {
      workspaceId: ctx.actor.workspaceId,
      recipientMembershipIds: [rev.enteredByMembershipId],
      eventType: 'metric.correction_approved',
      eventKey: `metric.correction_approved:${rev.id}`,
      kind: 'general',
      title: 'Your metric correction was approved',
      entityType: 'metric_observation',
      entityId: rev.id,
      projectId: rev.projectId,
      actorMembershipId: ctx.actor.membershipId,
      at: now,
    });
  return rev.id;
};

export const rejectCorrection = async (ctx: CommandContext, revisionId: string, input: { reason: string }) => {
  const rev = await lockPendingRevision(ctx, revisionId, 'metrics.approve');
  const now = ctx.app.clock.now();
  await ctx.tx
    .update(metricObservations)
    .set({ qualityState: 'rejected', reviewedBy: ctx.actor.membershipId, reviewedAt: now, decisionNote: input.reason.trim(), ...touch(ctx, metricObservations) })
    .where(eq(metricObservations.id, rev.id));
  if (rev.supersedesId) await ctx.tx.update(metricObservations).set({ ...touch(ctx, metricObservations) }).where(eq(metricObservations.id, rev.supersedesId));
  await audit(ctx, { action: 'metric_observation.correction_rejected', entityType: 'metric_observation', entityId: rev.id, projectId: rev.projectId, reason: input.reason });
  await emit(ctx, { type: 'metric_observation.correction_rejected', entityType: 'metric_observation', entityId: rev.id });
  if (rev.enteredByMembershipId)
    await notify(ctx.tx, {
      workspaceId: ctx.actor.workspaceId,
      recipientMembershipIds: [rev.enteredByMembershipId],
      eventType: 'metric.correction_rejected',
      eventKey: `metric.correction_rejected:${rev.id}`,
      kind: 'general',
      title: 'Your metric correction was not approved',
      excerpt: input.reason,
      entityType: 'metric_observation',
      entityId: rev.id,
      projectId: rev.projectId,
      actorMembershipId: ctx.actor.membershipId,
      at: now,
    });
  return rev.supersedesId ?? rev.id;
};

/** Mark Reviewed: an unverified entry becomes a reviewed source record (not by the member who entered it). */
export const markObservationReviewed = async (ctx: CommandContext, id: string, input: { note?: string }) => {
  const o = await lockObservation(ctx, id);
  authorizeObject(ctx, 'metrics.approve', entityScope(o, o.id), 'metrics.read');
  assertVersion(ctx, o);
  if (o.qualityState !== 'unverified') throw new AppError('INVALID_STATE', o.qualityState === 'reviewed' ? 'This record is already reviewed.' : 'Only a current unverified record can be marked reviewed.');
  if (o.enteredByMembershipId === ctx.actor.membershipId && !ctx.actor.access.isOwner) throw new AppError('FORBIDDEN', 'Another member must review the values you entered.');
  await ctx.tx
    .update(metricObservations)
    .set({ qualityState: 'reviewed', reviewedBy: ctx.actor.membershipId, reviewedAt: ctx.app.clock.now(), decisionNote: input.note?.trim() || null, ...touch(ctx, metricObservations) })
    .where(eq(metricObservations.id, id));
  await audit(ctx, { action: 'metric_observation.reviewed', entityType: 'metric_observation', entityId: id, projectId: o.projectId, reason: input.note ?? null });
  await emit(ctx, { type: 'metric_observation.reviewed', entityType: 'metric_observation', entityId: id });
  return id;
};

/**
 * Use in Reports / Exclude from Reports: one canonical record per slot (alternate sources) and a
 * consistent set of periods (overlaps are resolved by excluding records, never by summing).
 */
export const setObservationCanonical = async (ctx: CommandContext, id: string, input: { canonical: boolean; reason: string }) => {
  const o = await lockObservation(ctx, id);
  authorizeObject(ctx, 'metrics.revise', entityScope(o, o.id), 'metrics.read');
  assertVersion(ctx, o);
  if (!(ACTIVE_QUALITY as readonly string[]).includes(o.qualityState)) throw new AppError('INVALID_STATE', 'Only the revision in use can be selected for reports.');
  if (o.canonical === input.canonical) throw new AppError('INVALID_STATE', input.canonical ? 'This record is already used in reports.' : 'This record is already excluded from reports.');
  const slot = slotOfKey(o.dedupeKey);
  await ctx.tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`metric-slot:${ctx.actor.workspaceId}:${slot}`}))`);
  const switched: string[] = [];
  if (input.canonical) {
    const others = await ctx.tx
      .update(metricObservations)
      .set({ canonical: false, ...touch(ctx, metricObservations) })
      .where(
        and(
          eq(metricObservations.workspaceId, ctx.actor.workspaceId),
          ne(metricObservations.id, id),
          eq(metricObservations.canonical, true),
          sql`left(${metricObservations.dedupeKey}, ${slot.length + 1}) = ${`${slot}:`}`,
          notInArray(metricObservations.qualityState, ['rejected']),
        ),
      )
      .returning({ id: metricObservations.id });
    switched.push(...others.map((r) => r.id));
  }
  // The whole revision chain carries the choice (a later correction keeps it).
  await ctx.tx
    .update(metricObservations)
    .set({ canonical: input.canonical, ...touch(ctx, metricObservations) })
    .where(and(eq(metricObservations.workspaceId, ctx.actor.workspaceId), eq(metricObservations.rootObservationId, o.rootObservationId)));
  await audit(ctx, {
    action: input.canonical ? 'metric_observation.used_in_reports' : 'metric_observation.excluded_from_reports',
    entityType: 'metric_observation',
    entityId: id,
    projectId: o.projectId,
    reason: input.reason,
    metadata: { replaced: switched },
  });
  await emit(ctx, { type: 'metric_observation.canonical_changed', entityType: 'metric_observation', entityId: id, payload: { canonical: input.canonical } });
  return id;
};

// ——— Read models ———

const observationScopeSql = (ctx: Ctx) => scopePredicate(ctx, 'metrics.read', { projectId: metricObservations.projectId, accountId: metricObservations.accountId });

export const toObservationSummaries = async (ctx: Ctx, rows: ObservationRow[]): Promise<ObservationSummary[]> => {
  if (!rows.length) return [];
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const [entities, refs, values, cps, pendings, defs, policy] = await all(ctx, [
    () => loadEntities(ctx, rows.map((r) => ({ type: r.entityType, id: r.entityId }))),
    () => loadMemberRefs(db, ws, rows.map((r) => r.enteredByMembershipId)),
    () => loadValues(ctx, rows.map((r) => r.id)),
    () => {
      const ids = [...new Set(rows.map((r) => r.checkpointId).filter((x): x is string => !!x))];
      return ids.length ? db.select().from(metricCheckpoints).where(and(eq(metricCheckpoints.workspaceId, ws), inArray(metricCheckpoints.id, ids))) : Promise.resolve([] as CheckpointRowDb[]);
    },
    () =>
      db
        .select({ root: metricObservations.rootObservationId })
        .from(metricObservations)
        .where(and(eq(metricObservations.workspaceId, ws), eq(metricObservations.qualityState, 'pending_correction'), inArray(metricObservations.rootObservationId, [...new Set(rows.map((r) => r.rootObservationId))]))),
    () => loadFieldDefinitions(ctx),
    () => activePolicy(ctx),
  ] as const);
  const pendingRoots = new Set(pendings.map((p) => p.root));
  return rows.map((r) => {
    const e = entities.get(`${r.entityType}:${r.entityId}`);
    const vals = values.filter((v) => v.observationId === r.id);
    const dataset = datasetKeyOf(r.entityType, r.kind) ?? 'account_snapshot';
    const cp = cps.find((c) => c.id === r.checkpointId);
    return {
      id: r.id,
      rootObservationId: r.rootObservationId,
      revisionNo: r.revisionNo,
      entity: e
        ? entityRefOf(e)
        : { type: r.entityType, id: r.entityId, label: 'Unavailable record', sublabel: null, accountId: r.accountId, projectId: r.projectId, publicationId: r.publicationId, platform: null, href: `/accounts/${r.accountId}` },
      dataset,
      kind: r.kind,
      observedAt: r.observedAt.toISOString(),
      periodStart: iso(r.periodStart),
      periodEnd: iso(r.periodEnd),
      platformTimezone: r.platformTimezone,
      definitionSetVersion: r.definitionSetVersion,
      segment: r.segment,
      sourceType: r.sourceType,
      sourceNamespace: r.sourceNamespace,
      sourceNote: r.sourceNote,
      enteredAt: r.enteredAt.toISOString(),
      enteredBy: refOrUnknown(refs, r.enteredByMembershipId),
      qualityState: r.qualityState,
      canonical: r.canonical,
      warnings: r.warnings,
      checkpoint: cp ? { id: cp.id, key: cp.checkpointKey, label: checkpointLabel(cp.checkpointKey, policy.config), timing: cp.completedObservationId === r.id || cp.completedObservationId === r.supersedesId ? cp.timing : null, expectedAt: cp.expectedAt.toISOString() } : null,
      knownCount: vals.filter((v) => v.availability === 'known').length,
      valueCount: vals.length,
      headline: HEADLINE_FIELDS[dataset]
        .map((k) => {
          const v = vals.find((x) => x.metricKey === k);
          return v ? { metricKey: k, label: defs.find((d) => d.key === k)?.label ?? k, availability: v.availability, value: plainDecimal(v.value) } : null;
        })
        .filter((x): x is NonNullable<typeof x> => !!x),
      hasPendingCorrection: pendingRoots.has(r.rootObservationId) && r.qualityState !== 'pending_correction',
      rowVersion: r.rowVersion,
    };
  });
};

export interface ListObservationsInput {
  cursor?: string;
  pageSize?: number;
  entityType?: MetricEntityType;
  accountId?: string;
  projectId?: string;
  publicationId?: string;
  kind?: ObservationKind;
  quality?: ObservationRow['qualityState'][];
  sourceType?: SourceType;
  from?: string;
  to?: string;
  includeHistory?: boolean;
}

export const listObservations = async (ctx: QueryContext, input: ListObservationsInput) => {
  requirePermission(ctx, 'metrics.read');
  const size = clampPageSize(input.pageSize);
  const c = input.cursor ? decodeCursor(input.cursor) : null;
  const t = metricObservations;
  const rows = await ctx.app.db
    .select()
    .from(t)
    .where(
      and(
        eq(t.workspaceId, ctx.actor.workspaceId),
        observationScopeSql(ctx),
        input.includeHistory || input.quality?.length ? undefined : activeObservation(),
        input.quality?.length ? inArray(t.qualityState, input.quality) : undefined,
        input.entityType ? eq(t.entityType, input.entityType) : undefined,
        input.accountId ? eq(t.accountId, input.accountId) : undefined,
        input.projectId ? eq(t.projectId, input.projectId) : undefined,
        input.publicationId ? eq(t.publicationId, input.publicationId) : undefined,
        input.kind ? eq(t.kind, input.kind) : undefined,
        input.sourceType ? eq(t.sourceType, input.sourceType) : undefined,
        input.from ? sql`${t.observedAt} >= ${new Date(input.from)}` : undefined,
        input.to ? sql`${t.observedAt} < ${new Date(input.to)}` : undefined,
        c ? or(lt(t.observedAt, new Date(String(c.v[0]))), and(eq(t.observedAt, new Date(String(c.v[0]))), lt(t.id, c.id))) : undefined,
      ),
    )
    .orderBy(desc(t.observedAt), desc(t.id))
    .limit(size + 1);
  const hasMore = rows.length > size;
  const pageRows = hasMore ? rows.slice(0, size) : rows;
  const last = pageRows[pageRows.length - 1];
  return { items: await toObservationSummaries(ctx, pageRows), hasMore, nextCursor: hasMore && last ? encodeCursor({ v: [last.observedAt.toISOString()], id: last.id }) : null };
};

const valueView = (defs: FieldDefinition[], v: ValueRow) => {
  const d = defs.find((x) => x.key === v.metricKey);
  return { metricKey: v.metricKey, label: d?.label ?? v.metricKey, unit: v.unit, valueType: d?.valueType ?? 'decimal', availability: v.availability, value: plainDecimal(v.value), currency: v.currency?.trim() ?? null };
};

export const getObservation = async (ctx: Ctx, id: string): Promise<ObservationDetail> => {
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const [o] = await db.select().from(metricObservations).where(and(eq(metricObservations.workspaceId, ws), eq(metricObservations.id, id)));
  if (!o) throw notFound('Observation');
  authorizeRead(ctx, 'metrics.read', entityScope(o, o.id));
  const [summary] = await toObservationSummaries(ctx, [o]);
  const [chain, values, defs, policy] = await all(ctx, [
    () => db.select().from(metricObservations).where(and(eq(metricObservations.workspaceId, ws), eq(metricObservations.rootObservationId, o.rootObservationId))).orderBy(asc(metricObservations.revisionNo)),
    () => loadValues(ctx, [o.id]),
    () => loadFieldDefinitions(ctx),
    () => activePolicy(ctx),
  ] as const);
  const pending = chain.find((r) => r.qualityState === 'pending_correction') ?? null;
  const current = chain.find((r) => (ACTIVE_QUALITY as readonly string[]).includes(r.qualityState)) ?? null;
  const refs = await loadMemberRefs(db, ws, [...chain.map((r) => r.enteredByMembershipId), ...chain.map((r) => r.reviewedBy)]);
  let pendingCorrection: ObservationDetail['pendingCorrection'] = null;
  if (pending) {
    const [pv, cv] = await all(ctx, [() => loadValues(ctx, [pending.id]), () => loadValues(ctx, current ? [current.id] : [])] as const);
    const keys = [...new Set([...cv.map((v) => v.metricKey), ...pv.map((v) => v.metricKey)])];
    pendingCorrection = {
      id: pending.id,
      revisionNo: pending.revisionNo,
      enteredBy: refOrUnknown(refs, pending.enteredByMembershipId),
      enteredAt: pending.enteredAt.toISOString(),
      correctionReason: pending.correctionReason,
      sourceNote: pending.sourceNote,
      rowVersion: pending.rowVersion,
      diff: keys.map((k) => {
        const a = cv.find((v) => v.metricKey === k);
        const b = pv.find((v) => v.metricKey === k);
        return { metricKey: k, label: defs.find((d) => d.key === k)?.label ?? k, from: a ? { availability: a.availability, value: plainDecimal(a.value) } : null, to: b ? { availability: b.availability, value: plainDecimal(b.value) } : null };
      }),
    };
  }
  const slot = slotOfKey(o.dedupeKey);
  const [alternates, conflicts] = await all(ctx, [
    () =>
      db
        .select()
        .from(metricObservations)
        .where(and(eq(metricObservations.workspaceId, ws), activeObservation(), ne(metricObservations.rootObservationId, o.rootObservationId), sql`left(${metricObservations.dedupeKey}, ${slot.length + 1}) = ${`${slot}:`}`)),
    () =>
      o.kind === 'period' && o.periodStart && o.periodEnd
        ? db
            .select()
            .from(metricObservations)
            .where(
              and(
                eq(metricObservations.workspaceId, ws),
                eq(metricObservations.entityType, o.entityType),
                eq(metricObservations.entityId, o.entityId),
                eq(metricObservations.kind, 'period'),
                eq(metricObservations.segment, o.segment),
                eq(metricObservations.definitionSetVersion, o.definitionSetVersion),
                activeObservation(),
                ne(metricObservations.rootObservationId, o.rootObservationId),
                lt(metricObservations.periodStart, o.periodEnd),
                gt(metricObservations.periodEnd, o.periodStart),
                sql`NOT (${metricObservations.periodStart} = ${o.periodStart} AND ${metricObservations.periodEnd} = ${o.periodEnd})`,
              ),
            )
            .limit(20)
        : Promise.resolve([] as ObservationRow[]),
  ] as const);
  // Evidence: only files the member may read (unreadable ones are omitted, not revealed).
  const evidence: ObservationDetail['evidence'] = [];
  if (o.evidenceAssetIds.length) {
    const rows = await db.select().from(assets).where(and(eq(assets.workspaceId, ws), inArray(assets.id, o.evidenceAssetIds)));
    for (const a of rows)
      if (await canReadAsset(ctx, a))
        evidence.push({ assetId: a.id, name: a.name, thumbnailUrl: a.kind === 'image' || a.kind === 'video' ? `/api/v1/workspaces/${ws}/assets/${a.id}/thumbnail?size=128` : null, status: null });
  }
  const scope = entityScope(o, o.id);
  const isActive = (ACTIVE_QUALITY as readonly string[]).includes(o.qualityState);
  const cp = summary!.checkpoint ? await db.select().from(metricCheckpoints).where(eq(metricCheckpoints.id, summary!.checkpoint.id)) : [];
  const required = cp[0] ? requiredMetricsFor(cp[0].checkpointKey, policy.config) : [];
  return {
    ...summary!,
    values: values.map((v) => valueView(defs, v)),
    warningNote: o.warningNote,
    correctionReason: o.correctionReason,
    supersedesId: o.supersedesId,
    reviewedBy: refOrUnknown(refs, o.reviewedBy),
    reviewedAt: iso(o.reviewedAt),
    completeness: required.length ? valueCompleteness(values.map((v) => ({ metricKey: v.metricKey, availability: v.availability })), required) : null,
    evidence,
    revisions: chain.map((r) => ({
      id: r.id,
      revisionNo: r.revisionNo,
      qualityState: r.qualityState,
      enteredAt: r.enteredAt.toISOString(),
      enteredBy: refOrUnknown(refs, r.enteredByMembershipId),
      correctionReason: r.correctionReason ?? (r.qualityState === 'rejected' ? r.decisionNote : null),
      reviewedBy: refOrUnknown(refs, r.reviewedBy),
      reviewedAt: iso(r.reviewedAt),
      current: r.id === current?.id,
    })),
    pendingCorrection,
    alternates: alternates.map((a) => ({ id: a.id, sourceNamespace: a.sourceNamespace, sourceType: a.sourceType, canonical: a.canonical, enteredAt: a.enteredAt.toISOString() })),
    conflicts: conflicts.map((c) => ({ id: c.id, periodStart: iso(c.periodStart), periodEnd: iso(c.periodEnd), sourceNamespace: c.sourceNamespace, canonical: c.canonical })),
    permissions: {
      revise: isActive && !pending && allowed(ctx, 'metrics.revise', scope),
      approve: !!pending && allowed(ctx, 'metrics.approve', scope) && (pending.enteredByMembershipId !== ctx.actor.membershipId || ctx.actor.access.isOwner),
      markReviewed: o.qualityState === 'unverified' && allowed(ctx, 'metrics.approve', scope) && (o.enteredByMembershipId !== ctx.actor.membershipId || ctx.actor.access.isOwner),
      setCanonical: isActive && allowed(ctx, 'metrics.revise', scope),
    },
  };
};

/** Validate endpoint result (changes nothing). */
export const validateObservation = async (ctx: QueryContext, input: ObservationCreateInput) => {
  requirePermission(ctx, 'metrics.write');
  const c = await checkObservation(ctx, input);
  const policy = await activePolicy(ctx);
  return {
    ok: c.errors.length === 0 && !c.duplicate,
    errors: c.errors,
    warnings: c.warnings,
    duplicate: c.duplicate ? { observationId: c.duplicate.id, qualityState: c.duplicate.qualityState, sourceNamespace: c.duplicate.sourceNamespace } : null,
    checkpoint: c.checkpoint
      ? { id: c.checkpoint.row.id, key: c.checkpoint.row.checkpointKey, label: checkpointLabel(c.checkpoint.row.checkpointKey, policy.config), timing: c.checkpoint.timing, expectedAt: c.checkpoint.row.expectedAt.toISOString() }
      : null,
    completeness: c.completeness,
    requiresWarningNote: c.requiresWarningNote,
  };
};

/** Whether the member may add metrics to the entity (UI courtesy; commands re-check). */
export const canAddMetrics = (ctx: Ctx, e: { projectId: string; accountId: string }) => can(ctx.actor.access, 'metrics.write', entityScope(e));

