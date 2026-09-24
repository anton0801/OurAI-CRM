import { and, asc, eq, gt, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { hasAnywhere } from '@castlane/authorization';
import { METRIC_CATALOG, metricCheckpoints, metricDefinitions, metricObservations, metricValues, publications, savedReports, socialAccounts } from '@castlane/database';
import {
  AppError,
  METRIC_ENTITY_TYPES,
  METRIC_IMPORT_CONFLICT_ACTIONS,
  METRIC_SEGMENTS,
  OBSERVATION_KINDS,
  isAppError,
  isUuid,
  toBig,
} from '@castlane/domain';
import { allowed, requirePermission } from '../core/access';
import { audit } from '../core/audit';
import { dbOf, type CommandContext, type QueryContext } from '../core/context';
import { emit } from '../core/events';
import { defineExportDataset } from '../core/export-registry';
import { defineImportDataset, type ImportIssue } from '../core/import-registry';
import { defineJob, defineSchedule } from '../core/jobs-registry';
import { defineLookup, likePattern } from '../core/lookup-registry';
import { loadMemberRefs } from '../core/members';
import { touch } from '../core/rows';
import { defineLinkAccess } from '../media/link-access';
import { runCheckpointMaintenance } from './checkpoints';
import { loadAccounts, loadProjectNames, plainDecimal } from './common';
import {
  checkObservation,
  createObservation,
  entityScope,
  loadEntities,
  submitCorrection,
  type ObservationCreateInput,
  type ObservationInputValue,
} from './observations';
import { canReadReport, runSavedReport } from './reports/reports';

// ——— Jobs ———

defineJob('insights.checkpoints', 'light', async ({ app }) => runCheckpointMaintenance(app));
defineSchedule({ name: 'insights.checkpoints', everySeconds: 900, jobType: 'insights.checkpoints' });

// ——— Evidence files linked to observations ———

defineLinkAccess('metric_observation', {
  permission: 'metrics.read',
  scope: async (ctx, id) => {
    const [o] = await dbOf(ctx).select().from(metricObservations).where(and(eq(metricObservations.workspaceId, ctx.actor.workspaceId), eq(metricObservations.id, id)));
    return o ? { ...entityScope(o, o.id), label: 'Metric observation', href: `/w/${o.workspaceId}/metrics/${o.id}` } : null;
  },
});

// ——— Lookups ———

defineLookup({
  type: 'metric_definition',
  search: async (ctx, input) => {
    requirePermission(ctx, 'metrics.read');
    const d = metricDefinitions;
    const rows = await dbOf(ctx)
      .select()
      .from(d)
      .where(
        and(
          input.ids?.length ? inArray(d.id, input.ids) : undefined,
          input.includeArchived ? undefined : eq(d.active, true),
          input.q ? or(ilike(d.label, likePattern(input.q)), ilike(d.key, likePattern(input.q))) : undefined,
        ),
      )
      .orderBy(asc(d.key), asc(d.version))
      .limit(input.limit);
    return rows.map((r) => ({ id: r.id, label: `${r.label} (${r.key})`, sublabel: `${r.entityType.replace('_', ' ')} · ${r.observationKind} · v${r.version}`, status: r.active ? 'active' : 'retired', projectId: null, archived: !r.active }));
  },
});

defineLookup({
  type: 'saved_report',
  search: async (ctx, input) => {
    requirePermission(ctx, 'reports.read');
    const r = savedReports;
    const me = ctx.actor.membershipId ?? '00000000-0000-4000-8000-000000000000';
    const rows = await dbOf(ctx)
      .select()
      .from(r)
      .where(
        and(
          eq(r.workspaceId, ctx.actor.workspaceId),
          or(eq(r.ownerMembershipId, me), and(eq(r.sharing, 'shared'), sql`${me}::uuid = ANY(${r.sharedWithMembershipIds})`)),
          input.ids?.length ? inArray(r.id, input.ids) : undefined,
          input.includeArchived ? undefined : isNull(r.archivedAt),
          input.q ? ilike(r.name, likePattern(input.q)) : undefined,
        ),
      )
      .orderBy(asc(r.name))
      .limit(input.limit);
    return rows.filter((x) => canReadReport(ctx, x)).map((x) => ({ id: x.id, label: x.name, sublabel: x.dataset.replace('_', ' '), status: x.sharing, projectId: null, archived: !!x.archivedAt }));
  },
});

// ——— Import Center: metric observations (F09) ———

const asText = (v: unknown) => (v === null || v === undefined ? null : String(v).trim() || null);

const VALUE_TOKENS: Record<string, ObservationInputValue['availability']> = {
  'n/p': 'not_provided',
  np: 'not_provided',
  'not provided': 'not_provided',
  not_provided: 'not_provided',
  'n/a': 'not_applicable',
  na: 'not_applicable',
  'not applicable': 'not_applicable',
  not_applicable: 'not_applicable',
  unknown: 'unknown',
  '?': 'unknown',
};

const METRIC_KEYS = [...new Set(METRIC_CATALOG.map((m) => m.key))];

/** Resolve the entity of a row: stable id, profile URL or @handle (accounts), id or post URL (publications). */
const resolveEntityRef = async (ctx: QueryContext, entityType: string, raw: string): Promise<{ id?: string; error?: ImportIssue }> => {
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const lower = raw.toLowerCase();
  const trimmed = lower.replace(/\/+$/, '');
  if (entityType === 'publication') {
    const rows = isUuid(raw)
      ? await db.select({ id: publications.id }).from(publications).where(and(eq(publications.workspaceId, ws), eq(publications.id, raw)))
      : await db.select({ id: publications.id }).from(publications).where(and(eq(publications.workspaceId, ws), sql`lower(${publications.externalPostUrl}) = ${lower}`));
    if (rows.length === 1) return { id: rows[0]!.id };
    return { error: { field: 'entity', code: rows.length ? 'AMBIGUOUS' : 'UNKNOWN_ENTITY', message: rows.length ? `Several publications match "${raw}". Use the publication id.` : `Publication "${raw}" was not found.` } };
  }
  const handle = lower.replace(/^@/, '');
  const rows = isUuid(raw)
    ? await db.select({ id: socialAccounts.id }).from(socialAccounts).where(and(eq(socialAccounts.workspaceId, ws), eq(socialAccounts.id, raw), isNull(socialAccounts.deletedAt)))
    : await db
        .select({ id: socialAccounts.id })
        .from(socialAccounts)
        .where(
          and(
            eq(socialAccounts.workspaceId, ws),
            isNull(socialAccounts.deletedAt),
            or(sql`lower(${socialAccounts.handle}) = ${handle}`, sql`lower(rtrim(${socialAccounts.canonicalUrl}, '/')) = ${trimmed}`, sql`lower(rtrim(${socialAccounts.originalUrl}, '/')) = ${trimmed}`),
          ),
        );
  if (rows.length === 1) return { id: rows[0]!.id };
  return { error: { field: 'entity', code: rows.length ? 'AMBIGUOUS' : 'UNKNOWN_ENTITY', message: rows.length ? `Several accounts match "${raw}". Use the account id.` : `Account "${raw}" was not found.` } };
};

type ImportNormalized = ObservationCreateInput & { conflictAction: 'skip' | 'create_revision' | null };

defineImportDataset<ImportNormalized>({
  key: 'metric_observations',
  label: 'Metric Observations',
  permission: 'metrics.write',
  duplicatePolicies: ['skip', 'revise_existing', 'error'],
  columns: [
    { key: 'entity_type', label: 'Entity type', type: 'enum', required: true, enumValues: METRIC_ENTITY_TYPES, aliases: ['entity type', 'type'] },
    { key: 'entity', label: 'Entity (id, profile URL, @handle or post URL)', type: 'reference', required: true, aliases: ['account', 'publication', 'entity id'] },
    { key: 'kind', label: 'Observation kind', type: 'enum', required: true, enumValues: OBSERVATION_KINDS, aliases: ['observation type', 'kind'] },
    { key: 'observed_at', label: 'Observed at', type: 'datetime', required: true, aliases: ['observed', 'observed at', 'date'] },
    { key: 'period_start', label: 'Period start', type: 'datetime', aliases: ['from', 'start'] },
    { key: 'period_end', label: 'Period end', type: 'datetime', aliases: ['to', 'end'] },
    { key: 'segment', label: 'Segment', type: 'enum', enumValues: METRIC_SEGMENTS },
    { key: 'source_namespace', label: 'Source', type: 'text', aliases: ['source name'] },
    { key: 'source_note', label: 'Source note', type: 'long_text', required: true, aliases: ['note', 'source note'] },
    { key: 'definition_set_version', label: 'Definition set version', type: 'integer', aliases: ['definition set'] },
    { key: 'platform_timezone', label: 'Platform time zone', type: 'timezone' },
    { key: 'currency', label: 'Currency of money values', type: 'currency' },
    { key: 'conflict_action', label: 'If already recorded (skip / create_revision)', type: 'enum', enumValues: METRIC_IMPORT_CONFLICT_ACTIONS, aliases: ['on conflict'] },
    { key: 'warning_note', label: 'Warning note', type: 'long_text' },
    ...METRIC_KEYS.map((k) => {
      const m = METRIC_CATALOG.find((x) => x.key === k)!;
      return {
        key: k,
        label: `${m.label} — ${m.entityType.replace('_', ' ')} ${m.observationKind}`,
        type: 'text' as const,
        aliases: [k],
        description: 'A number (0 only when reported as 0), empty = not recorded, n/p = Not Provided, n/a = Not Applicable, unknown = Unknown.',
      };
    }),
  ],
  validate: async (ctx, row, opts) => {
    const errors: ImportIssue[] = [];
    const warnings: ImportIssue[] = [];
    const entityType = asText(row.entity_type) as ObservationCreateInput['entityType'];
    const ref = await resolveEntityRef(ctx, entityType, asText(row.entity) ?? '');
    const values: ObservationInputValue[] = [];
    for (const k of METRIC_KEYS) {
      const cell = asText(row[k]);
      if (cell === null) continue;
      const token = VALUE_TOKENS[cell.toLowerCase()];
      if (token) values.push({ metricKey: k, availability: token, value: null });
      else {
        const m = METRIC_CATALOG.find((x) => x.key === k)!;
        values.push({ metricKey: k, availability: 'known', value: cell.replace(/\s/g, ''), currency: m.valueType === 'money' ? (asText(row.currency) ?? null) : null });
      }
    }
    const input: ImportNormalized = {
      entityType,
      entityId: ref.id ?? '00000000-0000-4000-8000-000000000000',
      kind: asText(row.kind) as ObservationCreateInput['kind'],
      observedAt: String(row.observed_at),
      periodStart: asText(row.period_start),
      periodEnd: asText(row.period_end),
      platformTimezone: asText(row.platform_timezone),
      definitionSetVersion: typeof row.definition_set_version === 'number' ? row.definition_set_version : 1,
      segment: (asText(row.segment) as ObservationCreateInput['segment']) ?? 'unknown',
      sourceType: 'csv',
      sourceNamespace: asText(row.source_namespace) ?? 'csv',
      sourceNote: asText(row.source_note) ?? '',
      evidenceAssetIds: [],
      values,
      warningNote: asText(row.warning_note) ?? 'Warnings accepted when the import was confirmed.',
      conflictAction: (asText(row.conflict_action) as ImportNormalized['conflictAction']) ?? null,
    };
    if (ref.error) return { action: 'create', normalized: input, errors: [ref.error], warnings };
    if (!values.length) errors.push({ field: 'values', code: 'NO_VALUES', message: 'The row has no metric values.' });
    let c: Awaited<ReturnType<typeof checkObservation>>;
    try {
      c = await checkObservation(ctx, input);
    } catch (e) {
      if (isAppError(e) && (e.code === 'NOT_FOUND' || e.code === 'FORBIDDEN'))
        return { action: 'create', normalized: input, errors: [{ field: 'entity', code: 'NOT_ACCESSIBLE', message: 'The entity was not found or you cannot record metrics for it.' }], warnings };
      throw e;
    }
    errors.push(...c.errors.map((x) => ({ field: x.field, code: x.code, message: x.message })));
    warnings.push(...c.warnings.map((x) => ({ field: x.field, code: x.code, message: x.message })));
    if (c.duplicate) {
      // F09: never a silent replacement — Skip or Create Revision for this row.
      const choice = input.conflictAction ?? (opts.duplicatePolicy === 'revise_existing' ? 'create_revision' : opts.duplicatePolicy === 'skip' ? 'skip' : null);
      if (!choice) {
        errors.push({ field: 'entity', code: 'DUPLICATE', message: 'These values are already recorded for the same key. Choose Skip or Create Revision.' });
        return { action: 'create', normalized: input, errors, warnings, dedupeKey: c.dedupeKey ?? undefined };
      }
      if (choice === 'skip') return { action: 'skip', normalized: input, errors: [], warnings: [{ field: 'entity', code: 'DUPLICATE_SKIPPED', message: 'Already recorded; this row is skipped.' }], dedupeKey: c.dedupeKey ?? undefined };
      if (!allowed(ctx, 'metrics.revise', entityScope(c.duplicate))) {
        errors.push({ field: 'conflict_action', code: 'FORBIDDEN', message: 'You cannot submit corrections for this entity.' });
        return { action: 'update', normalized: input, errors, warnings, targetId: c.duplicate.id, targetRowVersion: c.duplicate.rowVersion };
      }
      const [pending] = await dbOf(ctx)
        .select({ id: metricObservations.id })
        .from(metricObservations)
        .where(and(eq(metricObservations.workspaceId, ctx.actor.workspaceId), eq(metricObservations.rootObservationId, c.duplicate.rootObservationId), eq(metricObservations.qualityState, 'pending_correction')));
      if (pending) errors.push({ field: 'conflict_action', code: 'CORRECTION_PENDING', message: 'A correction of this record is already awaiting review.' });
      const current = await dbOf(ctx).select().from(metricValues).where(eq(metricValues.observationId, c.duplicate.id));
      const same =
        values.length === current.length &&
        c.values.every((v) => {
          const cv = current.find((x) => x.metricKey === v.metricKey);
          return cv && cv.availability === v.availability && (cv.value === null ? v.value === null : v.value !== null && toBig(cv.value).eq(toBig(v.value)));
        });
      if (same) return { action: 'skip', normalized: input, errors: [], warnings: [{ field: 'entity', code: 'UNCHANGED', message: 'The same values are already recorded; nothing to revise.' }], dedupeKey: c.dedupeKey ?? undefined };
      return { action: 'update', normalized: input, errors: errors.filter((e) => e.code !== 'NOTE_REQUIRED'), warnings, targetId: c.duplicate.id, targetRowVersion: c.duplicate.rowVersion, dedupeKey: c.dedupeKey ?? undefined };
    }
    return { action: 'create', normalized: input, errors, warnings, dedupeKey: c.dedupeKey ?? undefined };
  },
  apply: async (ctx, row, v) => {
    const { conflictAction: _c, ...input } = row;
    if (v.action === 'update' && v.targetId)
      // The version seen at validation is the If-Match of the correction (a change since then conflicts).
      return submitCorrection({ ...ctx, request: { ...ctx.request, expectedVersion: v.targetRowVersion } }, v.targetId, {
        values: input.values,
        reason: `Imported correction: ${input.sourceNote}`.slice(0, 2000),
        sourceType: 'csv',
        sourceNote: input.sourceNote,
        warningNote: input.warningNote,
      });
    return createObservation(ctx, input);
  },
  undo: async (ctx, id) => {
    const [o] = await ctx.tx.select().from(metricObservations).where(and(eq(metricObservations.workspaceId, ctx.actor.workspaceId), eq(metricObservations.id, id))).for('update');
    if (!o) return;
    const [chain] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(metricObservations).where(eq(metricObservations.rootObservationId, o.rootObservationId));
    if (o.qualityState === 'pending_correction') {
      // An imported correction that nobody reviewed yet can be withdrawn.
      await ctx.tx.delete(metricValues).where(eq(metricValues.observationId, id));
      await ctx.tx.delete(metricObservations).where(eq(metricObservations.id, id));
    } else {
      if (o.revisionNo !== 1 || (chain?.n ?? 1) > 1 || o.rowVersion !== 1 || o.qualityState !== 'unverified')
        throw new AppError('INVALID_STATE', 'The observation was reviewed, corrected or changed after the import.');
      await ctx.tx
        .update(metricCheckpoints)
        .set({ state: 'pending', completedObservationId: null, timing: null, ...touch(ctx, metricCheckpoints) })
        .where(and(eq(metricCheckpoints.workspaceId, ctx.actor.workspaceId), eq(metricCheckpoints.completedObservationId, id)));
      await ctx.tx.delete(metricValues).where(eq(metricValues.observationId, id));
      await ctx.tx.delete(metricObservations).where(eq(metricObservations.id, id));
    }
    await audit(ctx, { action: 'metric_observation.import_undone', entityType: 'metric_observation', entityId: id, projectId: o.projectId });
    await emit(ctx, { type: 'metric_observation.removed', entityType: 'metric_observation', entityId: id });
  },
});

// ——— Export Center ———

defineExportDataset({
  key: 'metric_observations',
  label: 'Metric Observations',
  permission: 'metrics.read',
  classification: 'normal',
  columns: [
    { key: 'observation_id', label: 'Observation ID', type: 'id', default: true },
    { key: 'entity_type', label: 'Entity type', type: 'text', default: true },
    { key: 'entity', label: 'Entity', type: 'text', default: true },
    { key: 'account', label: 'Account', type: 'text', default: true },
    { key: 'project', label: 'Project', type: 'text', default: true },
    { key: 'kind', label: 'Kind', type: 'text', default: true },
    { key: 'observed_at', label: 'Observed at', type: 'datetime', default: true },
    { key: 'period_start', label: 'Period start', type: 'datetime', default: true },
    { key: 'period_end', label: 'Period end', type: 'datetime', default: true },
    { key: 'segment', label: 'Segment', type: 'text' },
    { key: 'definition_set_version', label: 'Definition set', type: 'integer' },
    { key: 'source_type', label: 'Source type', type: 'text', default: true },
    { key: 'source_namespace', label: 'Source', type: 'text', default: true },
    { key: 'quality_state', label: 'Quality', type: 'text', default: true },
    { key: 'revision_no', label: 'Revision', type: 'integer' },
    { key: 'canonical', label: 'Used in reports', type: 'boolean' },
    { key: 'metric_key', label: 'Metric', type: 'text', default: true },
    { key: 'availability', label: 'Availability', type: 'text', default: true },
    { key: 'value', label: 'Value', type: 'decimal', default: true },
    { key: 'unit', label: 'Unit', type: 'text', default: true },
    { key: 'currency', label: 'Currency', type: 'currency' },
    { key: 'entered_at', label: 'Entered at', type: 'datetime' },
    { key: 'entered_by', label: 'Entered by', type: 'text' },
  ],
  filters: [
    { key: 'projectId', label: 'Project', type: 'reference', lookup: 'project' },
    { key: 'accountId', label: 'Account', type: 'reference', lookup: 'account' },
    { key: 'entityType', label: 'Entity type', type: 'enum', enumValues: METRIC_ENTITY_TYPES },
    { key: 'from', label: 'Observed from', type: 'date' },
    { key: 'to', label: 'Observed until', type: 'date' },
  ],
  async *rows(ctx, input) {
    requirePermission(ctx, 'metrics.read');
    const o = metricObservations;
    const f = input.filters;
    const db = dbOf(ctx);
    const ws = ctx.actor.workspaceId;
    const { scopePredicate } = await import('../core/access');
    let cursor: { at: Date; id: string } | null = null;
    for (;;) {
      const batch: (typeof o.$inferSelect)[] = await db
        .select()
        .from(o)
        .where(
          and(
            eq(o.workspaceId, ws),
            sql`${o.qualityState} IN ('unverified', 'reviewed')`,
            sql`${o.createdAt} <= ${input.boundAt}`,
            scopePredicate(ctx, 'metrics.read', { projectId: o.projectId, accountId: o.accountId }),
            typeof f.projectId === 'string' && isUuid(f.projectId) ? eq(o.projectId, f.projectId) : undefined,
            typeof f.accountId === 'string' && isUuid(f.accountId) ? eq(o.accountId, f.accountId) : undefined,
            typeof f.entityType === 'string' && (METRIC_ENTITY_TYPES as readonly string[]).includes(f.entityType) ? eq(o.entityType, f.entityType as never) : undefined,
            typeof f.from === 'string' ? sql`${o.observedAt} >= ${f.from}::date` : undefined,
            typeof f.to === 'string' ? sql`${o.observedAt} < (${f.to}::date + 1)` : undefined,
            cursor ? or(gt(o.observedAt, cursor.at), and(eq(o.observedAt, cursor.at), gt(o.id, cursor.id))) : undefined,
          ),
        )
        .orderBy(asc(o.observedAt), asc(o.id))
        .limit(500);
      if (!batch.length) return;
      const [values, entities, accounts, projects, refs] = [
        await db.select().from(metricValues).where(and(eq(metricValues.workspaceId, ws), inArray(metricValues.observationId, batch.map((b) => b.id)))),
        await loadEntities(ctx, batch.map((b) => ({ type: b.entityType, id: b.entityId }))),
        await loadAccounts(db, ws, batch.map((b) => b.accountId)),
        await loadProjectNames(db, ws, batch.map((b) => b.projectId)),
        await loadMemberRefs(db, ws, batch.map((b) => b.enteredByMembershipId)),
      ];
      for (const b of batch) {
        for (const v of values.filter((x) => x.observationId === b.id).sort((x, y) => x.metricKey.localeCompare(y.metricKey))) {
          yield {
            observation_id: b.id,
            entity_type: b.entityType,
            entity: entities.get(`${b.entityType}:${b.entityId}`)?.label ?? null,
            account: accounts.get(b.accountId)?.label ?? null,
            project: projects.get(b.projectId)?.name ?? null,
            kind: b.kind,
            observed_at: b.observedAt.toISOString(),
            period_start: b.periodStart?.toISOString() ?? null,
            period_end: b.periodEnd?.toISOString() ?? null,
            segment: b.segment,
            definition_set_version: b.definitionSetVersion,
            source_type: b.sourceType,
            source_namespace: b.sourceNamespace,
            quality_state: b.qualityState,
            revision_no: b.revisionNo,
            canonical: b.canonical,
            metric_key: v.metricKey,
            availability: v.availability,
            // T103: an unknown value is an empty cell with its availability, never 0.
            value: v.availability === 'known' ? plainDecimal(v.value) : null,
            unit: v.unit,
            currency: v.currency?.trim() ?? null,
            entered_at: b.enteredAt.toISOString(),
            entered_by: b.enteredByMembershipId ? (refs.get(b.enteredByMembershipId)?.displayName ?? null) : null,
          };
        }
      }
      const last = batch[batch.length - 1]!;
      cursor = { at: last.observedAt, id: last.id };
    }
  },
});

defineExportDataset({
  key: 'report_result',
  label: 'Report Result',
  permission: 'reports.read',
  classification: 'private',
  columns: [
    { key: 'row', label: 'Row', type: 'integer', default: true },
    { key: 'dimension_1', label: 'Dimension 1', type: 'text', default: true },
    { key: 'dimension_2', label: 'Dimension 2', type: 'text', default: true },
    { key: 'dimension_3', label: 'Dimension 3', type: 'text', default: true },
    { key: 'metric', label: 'Metric', type: 'text', default: true },
    { key: 'value', label: 'Value', type: 'decimal', default: true },
    { key: 'status', label: 'Availability', type: 'text', default: true },
    { key: 'unit', label: 'Unit', type: 'text', default: true },
    { key: 'currency', label: 'Currency', type: 'currency', default: true },
    { key: 'note', label: 'Note', type: 'text' },
  ],
  filters: [{ key: 'reportId', label: 'Report', type: 'reference', lookup: 'saved_report' }],
  async *rows(ctx, input) {
    const reportId = input.filters.reportId;
    if (typeof reportId !== 'string' || !isUuid(reportId)) throw new AppError('VALIDATION_FAILED', 'Choose a report.', { fieldErrors: [{ field: 'filters.reportId', code: 'REQUIRED', message: 'Choose a report.' }] });
    if (!hasAnywhere(ctx.actor.access, 'reports.read')) throw new AppError('FORBIDDEN', 'You cannot export reports.');
    // The result is computed with the requester's current permissions (never the owner's).
    const result = await runSavedReport(ctx, reportId, {});
    const dims = result.columns.filter((c) => c.kind === 'dimension');
    const metrics = result.columns.filter((c) => c.kind === 'metric');
    let n = 0;
    for (const r of result.rows) {
      n++;
      for (const m of metrics) {
        const v = r.values[m.key];
        yield {
          row: n,
          dimension_1: dims[0] ? (r.dims[dims[0].key]?.label ?? null) : null,
          dimension_2: dims[1] ? (r.dims[dims[1].key]?.label ?? null) : null,
          dimension_3: dims[2] ? (r.dims[dims[2].key]?.label ?? null) : null,
          metric: m.label,
          value: v?.value ?? null,
          status: v?.status ?? 'no_data',
          unit: m.unit ?? null,
          currency: v?.currency ?? null,
          note: v?.note ?? null,
        };
      }
    }
    for (const m of metrics) {
      const v = result.totals[m.key];
      yield { row: 0, dimension_1: 'Total', dimension_2: null, dimension_3: null, metric: m.label, value: v?.value ?? null, status: v?.status ?? 'no_data', unit: m.unit ?? null, currency: v?.currency ?? null, note: v?.note ?? null };
    }
  },
});

