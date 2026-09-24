import { and, asc, count, desc, eq, ilike, inArray, isNull, sql } from 'drizzle-orm';
import {
  experimentPublications,
  experimentRevisions,
  experimentVariants,
  experiments,
  metricByKey,
  METRIC_CATALOG,
  metricObservations,
  metricValues,
  projects,
  publications,
} from '@castlane/database';
import { AppError, assertTransition, newId, normalizeKey } from '@castlane/domain';
import { allowed, authorizeObject, authorizeRead, requirePermission, whereAll } from '../core/access';
import { audit, diffFields } from '../core/audit';
import { all, dbOf, type CommandContext, type QueryContext } from '../core/context';
import { emit } from '../core/events';
import { loadMemberRefs, refOrUnknown } from '../core/members';
import { assertVersion, stamp, touch } from '../core/rows';
import { indexSearchDocument } from '../core/search';
import { assertAssetUsable, finishPage, keysetWhere, pageSizeOf, thumbUrl } from '../accounts/helpers';
import { memberCan } from '../work/shared';
import { activePublicationPolicy } from './checkpoints';
import { EXPERIMENT_TRANSITIONS, classifyComparable, comparisonTolerance, summarizeComparable, type ExperimentStatus, type Segment } from './logic';
import { toPublicationRows } from './publications';
import { canPublication, experimentScope, experimentVisibility, type ExperimentRowDb } from './scope';

/**
 * Experiments (S35, §12): a hypothesis with variants, a primary metric and a comparison window fixed
 * before start; changes after start are plan revisions with a reason. Results compare only values
 * observed at the same post age — never a randomized-test claim, never statistical significance, and
 * never an automatic winner (the owner selects a variant with an explanation when concluding).
 */

type Ctx = QueryContext | CommandContext;
const fieldFail = (field: string, code: string, message: string) => new AppError('VALIDATION_FAILED', message, { fieldErrors: [{ field, code, message }] });

/** Metrics a comparison can use: cumulative per-publication values (views, likes…). */
export const EXPERIMENT_METRICS = METRIC_CATALOG.filter((m) => m.entityType === 'publication' && m.observationKind === 'cumulative' && m.aggregation === 'checkpoint_value');

export const experimentMetricOptions = (ctx: QueryContext) => {
  requirePermission(ctx, 'experiments.read');
  return EXPERIMENT_METRICS.map((m) => ({ key: m.key, label: `Publication ${m.label.toLowerCase()}`, description: m.description }));
};

const metricLabel = (key: string) => {
  const m = metricByKey(key);
  return m ? `Publication ${m.label.toLowerCase()}` : key;
};

// ——— Read model ———

const rowExtras = async (ctx: Ctx, rows: ExperimentRowDb[]) => {
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const ids = rows.map((r) => r.id);
  const [variants, links, projectRows, refs] = await all(ctx, [
    () => (ids.length ? db.select().from(experimentVariants).where(and(eq(experimentVariants.workspaceId, ws), inArray(experimentVariants.experimentId, ids))).orderBy(asc(experimentVariants.position)) : Promise.resolve([])),
    () =>
      ids.length
        ? db
            .select({ experimentId: experimentPublications.experimentId, variantId: experimentPublications.variantId, n: count() })
            .from(experimentPublications)
            .innerJoin(publications, eq(publications.id, experimentPublications.publicationId))
            // Counts only placements the member may read.
            .where(whereAll(eq(experimentPublications.workspaceId, ws), inArray(experimentPublications.experimentId, ids), sql`${publications.deletedAt} IS NULL`))
            .groupBy(experimentPublications.experimentId, experimentPublications.variantId)
        : Promise.resolve([]),
    () => {
      const pids = [...new Set(rows.map((r) => r.projectId))];
      return pids.length ? db.select({ id: projects.id, name: projects.name }).from(projects).where(and(eq(projects.workspaceId, ws), inArray(projects.id, pids))) : Promise.resolve([]);
    },
    () => loadMemberRefs(db, ws, rows.map((r) => r.ownerMembershipId)),
  ] as const);
  return { variants, links, projectNames: new Map(projectRows.map((p) => [p.id, p.name])), refs };
};

export const toExperimentRows = async (ctx: Ctx, rows: ExperimentRowDb[]) => {
  if (!rows.length) return [];
  const x = await rowExtras(ctx, rows);
  return rows.map((e) => {
    const vs = x.variants.filter((v) => v.experimentId === e.id);
    const countOf = (variantId: string) => x.links.filter((l) => l.experimentId === e.id && l.variantId === variantId).reduce((a, l) => a + Number(l.n), 0);
    return {
      id: e.id,
      hypothesis: e.hypothesis,
      project: { id: e.projectId, name: x.projectNames.get(e.projectId) ?? 'Project' },
      owner: refOrUnknown(x.refs, e.ownerMembershipId)!,
      status: e.status,
      primaryMetricKey: e.primaryMetricKey,
      primaryMetricLabel: metricLabel(e.primaryMetricKey),
      observationWindowHours: e.observationWindowHours,
      minimumSample: e.minimumSample,
      startAt: e.startAt?.toISOString() ?? null,
      endAt: e.endAt?.toISOString() ?? null,
      variants: vs.map((v) => ({
        id: v.id,
        name: v.name,
        description: v.description,
        position: v.position,
        thumbnailAssetId: v.thumbnailAssetId,
        thumbnailUrl: thumbUrl(e.workspaceId, v.thumbnailAssetId, 320),
        publicationCount: countOf(v.id),
      })),
      publicationCount: vs.reduce((a, v) => a + countOf(v.id), 0),
      planVersion: e.planVersion,
      archivedAt: e.archivedAt?.toISOString() ?? null,
      updatedAt: e.updatedAt.toISOString(),
      rowVersion: e.rowVersion,
    };
  });
};

export const listExperiments = async (ctx: QueryContext, input: { cursor?: string; pageSize?: number; q?: string; projectId?: string; status?: ExperimentStatus[]; ownerMembershipId?: string; includeArchived?: boolean }) => {
  requirePermission(ctx, 'experiments.read');
  const size = pageSizeOf(input.pageSize);
  const expr = sql`${experiments.updatedAt}`;
  const rows = await dbOf(ctx)
    .select()
    .from(experiments)
    .where(
      whereAll(
        eq(experiments.workspaceId, ctx.actor.workspaceId),
        experimentVisibility(ctx),
        input.includeArchived || input.status?.includes('archived') ? undefined : isNull(experiments.archivedAt),
        input.status?.length ? inArray(experiments.status, input.status) : undefined,
        input.projectId ? eq(experiments.projectId, input.projectId) : undefined,
        input.ownerMembershipId ? eq(experiments.ownerMembershipId, input.ownerMembershipId) : undefined,
        input.q ? ilike(experiments.hypothesis, `%${input.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`) : undefined,
        keysetWhere(expr, experiments.id, 'desc', input.cursor, 'timestamp'),
      ),
    )
    .orderBy(desc(expr), desc(experiments.id))
    .limit(size + 1);
  return finishPage(rows, size, (r) => r.updatedAt.toISOString(), (page) => toExperimentRows(ctx, page));
};

const loadExperiment = async (ctx: Ctx, id: string, opts: { lock?: boolean } = {}) => {
  const q = dbOf(ctx).select().from(experiments).where(and(eq(experiments.workspaceId, ctx.actor.workspaceId), eq(experiments.id, id)));
  const [e] = opts.lock && 'tx' in ctx ? await q.for('update') : await q;
  if (!e) throw new AppError('NOT_FOUND', 'Experiment was not found.');
  authorizeRead(ctx, 'experiments.read', experimentScope(e));
  return e;
};

export const getExperiment = async (ctx: Ctx, id: string) => {
  const e = await loadExperiment(ctx, id);
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const [[row], links, revisions, dup] = await all(ctx, [
    () => toExperimentRows(ctx, [e]),
    () =>
      db
        .select({ link: experimentPublications, p: publications })
        .from(experimentPublications)
        .innerJoin(publications, eq(publications.id, experimentPublications.publicationId))
        .where(and(eq(experimentPublications.workspaceId, ws), eq(experimentPublications.experimentId, id), isNull(publications.deletedAt)))
        .orderBy(asc(experimentPublications.createdAt)),
    () => db.select().from(experimentRevisions).where(and(eq(experimentRevisions.workspaceId, ws), eq(experimentRevisions.experimentId, id))).orderBy(desc(experimentRevisions.planVersion)),
    () => (e.duplicatedFromId ? db.select().from(experiments).where(and(eq(experiments.workspaceId, ws), eq(experiments.id, e.duplicatedFromId))) : Promise.resolve([])),
  ] as const);
  const visible = links.filter((l) => canPublication(ctx, 'publications.read', l.p));
  const views = new Map((await toPublicationRows(ctx, visible.map((l) => l.p))).map((v) => [v.id, v]));
  const scope = experimentScope(e);
  const write = allowed(ctx, 'experiments.write', scope);
  const selected = e.selectedVariantId ? row!.variants.find((v) => v.id === e.selectedVariantId) : undefined;
  const dupRow = dup[0];
  return {
    ...row!,
    limitations: e.limitations,
    resultNote: e.resultNote,
    selectedVariant: selected ? { id: selected.id, name: selected.name } : null,
    planFrozenAt: e.planFrozenAt?.toISOString() ?? null,
    conclusion: (e.conclusion as never) ?? null,
    duplicatedFrom: dupRow && allowed(ctx, 'experiments.read', experimentScope(dupRow)) ? { id: dupRow.id, hypothesis: dupRow.hypothesis } : null,
    publications: visible.map((l) => ({ linkId: l.link.id, variantId: l.link.variantId, segment: l.link.segment, publication: views.get(l.p.id)! })),
    hiddenPublications: links.length - visible.length,
    revisions: revisions.map((r) => ({ id: r.id, planVersion: r.planVersion, reason: r.reason, createdAt: r.createdAt.toISOString(), snapshot: r.snapshot })),
    permissions: {
      update: write && (e.status === 'draft' || e.status === 'running'),
      start: write && e.status === 'draft',
      conclude: write && e.status === 'running',
      linkPublications: write && (e.status === 'draft' || e.status === 'running'),
      archive: write && (e.status === 'draft' || e.status === 'concluded'),
      duplicate: allowed(ctx, 'experiments.write', { projectId: e.projectId }),
    },
  };
};

// ——— Commands ———

const indexExperiment = (ctx: CommandContext, e: ExperimentRowDb) =>
  indexSearchDocument(ctx.tx, {
    workspaceId: ctx.actor.workspaceId,
    entityType: 'experiment',
    entityId: e.id,
    title: e.hypothesis.slice(0, 200),
    body: [e.hypothesis, e.limitations, e.resultNote].filter(Boolean).join('\n'),
    projectId: e.projectId,
    permission: 'experiments.read',
    ownerMembershipId: e.ownerMembershipId,
    assigneeMembershipIds: [e.ownerMembershipId],
    archived: e.status === 'archived',
    status: e.status,
    at: ctx.app.clock.now(),
  });

type VariantInput = { id?: string; name: string; description?: string | null; thumbnailAssetId?: string | null };

const validateVariants = async (ctx: CommandContext, variants: VariantInput[]) => {
  if (variants.length < 2) throw fieldFail('variants', 'TOO_FEW', 'Define at least two variants.');
  const keys = variants.map((v) => normalizeKey(v.name));
  if (new Set(keys).size !== keys.length) throw fieldFail('variants', 'DUPLICATE_NAME', 'Variant names must be different.');
  for (const [i, v] of variants.entries()) if (v.thumbnailAssetId) await assertAssetUsable(ctx, v.thumbnailAssetId, `variants.${i}.thumbnailAssetId`, { imageOnly: true });
};

const validatePlan = (input: { primaryMetricKey?: string; startAt?: string | null; endAt?: string | null }) => {
  if (input.primaryMetricKey && !EXPERIMENT_METRICS.some((m) => m.key === input.primaryMetricKey))
    throw fieldFail('primaryMetricKey', 'UNSUPPORTED', 'Choose a publication metric that is recorded per post (views, likes…).');
  if (input.startAt && input.endAt && new Date(input.endAt) <= new Date(input.startAt)) throw fieldFail('endAt', 'BEFORE_START', 'The end must be after the start.');
};

const assertExperimentOwner = async (ctx: CommandContext, ownerMembershipId: string, projectId: string) => {
  const r = await memberCan(ctx.app.db, ctx.actor.workspaceId, ownerMembershipId, 'experiments.read', { objectType: 'experiment', projectId, ownerMembershipId, assignedMembershipIds: [ownerMembershipId] }, ctx.app.clock.now());
  if (!r.active) throw fieldFail('ownerMembershipId', 'INACTIVE', 'Choose an active member.');
  if (!r.ok) throw fieldFail('ownerMembershipId', 'NO_ACCESS', `${r.name ?? 'This member'} cannot access experiments of this project.`);
};

const planSnapshot = async (ctx: CommandContext, e: ExperimentRowDb) => {
  const vs = await ctx.tx.select().from(experimentVariants).where(eq(experimentVariants.experimentId, e.id)).orderBy(asc(experimentVariants.position));
  return {
    hypothesis: e.hypothesis,
    primaryMetricKey: e.primaryMetricKey,
    observationWindowHours: e.observationWindowHours,
    minimumSample: e.minimumSample,
    startAt: e.startAt?.toISOString() ?? null,
    endAt: e.endAt?.toISOString() ?? null,
    limitations: e.limitations,
    ownerMembershipId: e.ownerMembershipId,
    variants: vs.map((v) => ({ id: v.id, name: v.name, description: v.description })),
  };
};

export interface ExperimentInput {
  hypothesis?: string;
  projectId?: string;
  ownerMembershipId?: string;
  primaryMetricKey?: string;
  observationWindowHours?: number;
  minimumSample?: number;
  startAt?: string | null;
  endAt?: string | null;
  limitations?: string | null;
  variants?: VariantInput[];
  reason?: string;
}

export const createExperiment = async (ctx: CommandContext, input: Required<Pick<ExperimentInput, 'hypothesis' | 'projectId' | 'ownerMembershipId' | 'primaryMetricKey' | 'observationWindowHours' | 'minimumSample' | 'variants'>> & ExperimentInput, opts: { duplicatedFromId?: string } = {}) => {
  requirePermission(ctx, 'experiments.write');
  const [p] = await ctx.tx.select().from(projects).where(and(eq(projects.workspaceId, ctx.actor.workspaceId), eq(projects.id, input.projectId)));
  const pScope = p ? { objectType: 'project', objectId: p.id, projectId: p.id, directionId: p.directionId, ownerMembershipId: p.ownerMembershipId } : null;
  if (!p || p.deletedAt || !pScope || !(allowed(ctx, 'experiments.read', pScope) || allowed(ctx, 'projects.read', pScope))) throw fieldFail('projectId', 'NOT_FOUND', 'Choose a project you can access.');
  if (!allowed(ctx, 'experiments.write', pScope)) throw new AppError('FORBIDDEN', 'You cannot create experiments in this project.');
  if (p.status === 'archived') throw fieldFail('projectId', 'ARCHIVED', 'The project is archived.');
  validatePlan(input);
  await validateVariants(ctx, input.variants);
  await assertExperimentOwner(ctx, input.ownerMembershipId, p.id);
  const id = newId();
  const [row] = await ctx.tx
    .insert(experiments)
    .values({
      ...stamp(ctx),
      id,
      projectId: p.id,
      ownerMembershipId: input.ownerMembershipId,
      hypothesis: input.hypothesis.trim(),
      primaryMetricKey: input.primaryMetricKey,
      observationWindowHours: input.observationWindowHours,
      minimumSample: input.minimumSample,
      startAt: input.startAt ? new Date(input.startAt) : null,
      endAt: input.endAt ? new Date(input.endAt) : null,
      limitations: input.limitations?.trim() || null,
      status: 'draft',
      planVersion: 1,
      duplicatedFromId: opts.duplicatedFromId ?? null,
    })
    .returning();
  for (const [i, v] of input.variants.entries())
    await ctx.tx.insert(experimentVariants).values({ ...stamp(ctx), id: newId(), experimentId: id, name: v.name.trim(), description: v.description?.trim() || null, thumbnailAssetId: v.thumbnailAssetId ?? null, position: i });
  await audit(ctx, { action: 'experiment.created', entityType: 'experiment', entityId: id, projectId: p.id, diff: diffFields(null, row!, ['hypothesis', 'primaryMetricKey', 'observationWindowHours', 'minimumSample', 'ownerMembershipId']), metadata: opts.duplicatedFromId ? { duplicatedFrom: opts.duplicatedFromId } : undefined });
  await emit(ctx, { type: 'experiment.created', entityType: 'experiment', entityId: id, revision: 1 });
  await indexExperiment(ctx, row!);
  return id;
};

const lockForChange = async (ctx: CommandContext, id: string, opts: { skipVersion?: boolean } = {}) => {
  const e = await loadExperiment(ctx, id, { lock: true });
  authorizeObject(ctx, 'experiments.write', experimentScope(e), 'experiments.read');
  if (!opts.skipVersion) assertVersion(ctx, e);
  return e;
};

/** After start, any plan change is a revision: plan_version + 1 with the reason and the new plan snapshot. */
const recordRevision = async (ctx: CommandContext, e: ExperimentRowDb, reason: string) => {
  const [row] = await ctx.tx.update(experiments).set({ planVersion: e.planVersion + 1, ...touch(ctx, experiments) }).where(eq(experiments.id, e.id)).returning();
  await ctx.tx.insert(experimentRevisions).values({ ...stamp(ctx), id: newId(), experimentId: e.id, planVersion: row!.planVersion, snapshot: await planSnapshot(ctx, row!), reason });
  return row!;
};

export const updateExperiment = async (ctx: CommandContext, id: string, input: ExperimentInput) => {
  const e = await lockForChange(ctx, id);
  if (e.status !== 'draft' && e.status !== 'running') throw new AppError('INVALID_STATE', 'A concluded or archived experiment cannot change. Duplicate the hypothesis to test it again.');
  const running = e.status === 'running';
  if (running && !input.reason) throw fieldFail('reason', 'REQUIRED', 'The experiment is running: give a reason for this plan revision.');
  validatePlan({ primaryMetricKey: input.primaryMetricKey, startAt: input.startAt !== undefined ? input.startAt : e.startAt?.toISOString(), endAt: input.endAt !== undefined ? input.endAt : e.endAt?.toISOString() });
  const patch: Partial<ExperimentRowDb> = {};
  if (input.hypothesis !== undefined) patch.hypothesis = input.hypothesis.trim();
  if (input.primaryMetricKey !== undefined) patch.primaryMetricKey = input.primaryMetricKey;
  if (input.observationWindowHours !== undefined) patch.observationWindowHours = input.observationWindowHours;
  if (input.minimumSample !== undefined) patch.minimumSample = input.minimumSample;
  if (input.startAt !== undefined) patch.startAt = input.startAt ? new Date(input.startAt) : null;
  if (input.endAt !== undefined) patch.endAt = input.endAt ? new Date(input.endAt) : null;
  if (input.limitations !== undefined) patch.limitations = input.limitations?.trim() || null;
  if (input.ownerMembershipId && input.ownerMembershipId !== e.ownerMembershipId) {
    await assertExperimentOwner(ctx, input.ownerMembershipId, e.projectId);
    patch.ownerMembershipId = input.ownerMembershipId;
  }
  if (input.variants) {
    await validateVariants(ctx, input.variants);
    const existing = await ctx.tx.select().from(experimentVariants).where(eq(experimentVariants.experimentId, id));
    const keep = new Set(input.variants.map((v) => v.id).filter(Boolean));
    for (const v of input.variants) if (v.id && !existing.some((x) => x.id === v.id)) throw fieldFail('variants', 'NOT_FOUND', 'A variant does not belong to this experiment.');
    for (const x of existing.filter((x) => !keep.has(x.id))) {
      const [linked] = await ctx.tx.select({ n: count() }).from(experimentPublications).where(eq(experimentPublications.variantId, x.id));
      if (Number(linked?.n ?? 0) > 0) throw new AppError('INVALID_STATE', `The variant "${x.name}" has linked publications. Unlink them before removing it.`);
      await ctx.tx.delete(experimentVariants).where(eq(experimentVariants.id, x.id));
    }
    for (const [i, v] of input.variants.entries()) {
      const values = { name: v.name.trim(), description: v.description?.trim() || null, thumbnailAssetId: v.thumbnailAssetId ?? null, position: i };
      if (v.id) await ctx.tx.update(experimentVariants).set({ ...values, ...touch(ctx, experimentVariants) }).where(eq(experimentVariants.id, v.id));
      else await ctx.tx.insert(experimentVariants).values({ ...stamp(ctx), id: newId(), experimentId: id, ...values });
    }
  }
  let [row] = await ctx.tx.update(experiments).set({ ...patch, ...touch(ctx, experiments) }).where(eq(experiments.id, id)).returning();
  if (running) row = await recordRevision(ctx, row!, input.reason!);
  await audit(ctx, {
    action: running ? 'experiment.plan_revised' : 'experiment.updated',
    entityType: 'experiment',
    entityId: id,
    projectId: e.projectId,
    reason: input.reason ?? null,
    diff: diffFields(e, row!, ['hypothesis', 'primaryMetricKey', 'observationWindowHours', 'minimumSample', 'startAt', 'endAt', 'limitations', 'ownerMembershipId', 'planVersion']),
    metadata: input.variants ? { variants: input.variants.map((v) => v.name) } : undefined,
  });
  await emit(ctx, { type: 'experiment.updated', entityType: 'experiment', entityId: id, revision: row!.rowVersion });
  await indexExperiment(ctx, row!);
  return id;
};

export const startExperiment = async (ctx: CommandContext, id: string, input: { startAt?: string }) => {
  const e = await lockForChange(ctx, id);
  assertTransition(EXPERIMENT_TRANSITIONS, e.status, 'running', 'experiment');
  const [variants] = await ctx.tx.select({ n: count() }).from(experimentVariants).where(eq(experimentVariants.experimentId, id));
  if (Number(variants?.n ?? 0) < 2) throw new AppError('INVALID_STATE', 'Define at least two variants before starting.');
  const now = ctx.app.clock.now();
  const startAt = input.startAt ? new Date(input.startAt) : (e.startAt ?? now);
  if (e.endAt && e.endAt <= startAt) throw fieldFail('startAt', 'AFTER_END', 'The start must be before the planned end.');
  const [row] = await ctx.tx.update(experiments).set({ status: 'running', startAt, planFrozenAt: now, ...touch(ctx, experiments) }).where(eq(experiments.id, id)).returning();
  await ctx.tx.insert(experimentRevisions).values({ ...stamp(ctx), id: newId(), experimentId: id, planVersion: row!.planVersion, snapshot: await planSnapshot(ctx, row!), reason: 'Plan frozen at start' });
  await audit(ctx, { action: 'experiment.started', entityType: 'experiment', entityId: id, projectId: e.projectId, diff: { status: { from: e.status, to: 'running' } } });
  await emit(ctx, { type: 'experiment.started', entityType: 'experiment', entityId: id, revision: row!.rowVersion });
  await indexExperiment(ctx, row!);
  return id;
};

export const concludeExperiment = async (ctx: CommandContext, id: string, input: { findings: string; limitations: string; selectedVariantId?: string | null; selectionRationale?: string }) => {
  const e = await lockForChange(ctx, id);
  assertTransition(EXPERIMENT_TRANSITIONS, e.status, 'concluded', 'experiment');
  if (input.selectedVariantId) {
    const [v] = await ctx.tx.select().from(experimentVariants).where(and(eq(experimentVariants.id, input.selectedVariantId), eq(experimentVariants.experimentId, id)));
    if (!v) throw fieldFail('selectedVariantId', 'NOT_FOUND', 'Choose a variant of this experiment.');
    if (!input.selectionRationale?.trim()) throw fieldFail('selectionRationale', 'REQUIRED', 'Explain why this variant is selected (it is a judgement, not proof of causality).');
    if (e.ownerMembershipId !== ctx.actor.membershipId && !ctx.actor.access.isOwner) throw new AppError('FORBIDDEN', 'Only the experiment owner selects a variant.');
  }
  const evidence = await computeExperimentResults(ctx, e);
  const now = ctx.app.clock.now();
  const conclusion = {
    findings: input.findings.trim(),
    limitations: input.limitations.trim(),
    selectedVariantId: input.selectedVariantId ?? null,
    selectionRationale: input.selectedVariantId ? (input.selectionRationale?.trim() ?? null) : null,
    concludedAt: now.toISOString(),
    concludedBy: ctx.actor.displayName,
    evidence: evidence as unknown as Record<string, unknown>,
  };
  const [row] = await ctx.tx
    .update(experiments)
    .set({ status: 'concluded', resultNote: conclusion.findings, limitations: conclusion.limitations, selectedVariantId: conclusion.selectedVariantId, conclusion, endAt: e.endAt ?? now, ...touch(ctx, experiments) })
    .where(eq(experiments.id, id))
    .returning();
  await audit(ctx, { action: 'experiment.concluded', entityType: 'experiment', entityId: id, projectId: e.projectId, reason: conclusion.selectionRationale, diff: { status: { from: e.status, to: 'concluded' } }, metadata: { resultStatus: evidence.status } });
  await emit(ctx, { type: 'experiment.concluded', entityType: 'experiment', entityId: id, revision: row!.rowVersion });
  await indexExperiment(ctx, row!);
  return id;
};

export const duplicateExperiment = async (ctx: CommandContext, id: string, input: { projectId?: string }) => {
  const e = await loadExperiment(ctx, id);
  const variants = await ctx.tx.select().from(experimentVariants).where(eq(experimentVariants.experimentId, id)).orderBy(asc(experimentVariants.position));
  const owner = ctx.actor.membershipId ?? e.ownerMembershipId;
  return createExperiment(
    ctx,
    {
      hypothesis: e.hypothesis,
      projectId: input.projectId ?? e.projectId,
      ownerMembershipId: owner,
      primaryMetricKey: e.primaryMetricKey,
      observationWindowHours: e.observationWindowHours,
      minimumSample: e.minimumSample,
      limitations: e.limitations,
      variants: variants.map((v) => ({ name: v.name, description: v.description, thumbnailAssetId: v.thumbnailAssetId })),
    },
    { duplicatedFromId: id },
  );
};

export const linkExperimentPublications = async (ctx: CommandContext, id: string, input: { variantId: string; publicationIds: string[]; segment: Segment; reason?: string }) => {
  const e = await lockForChange(ctx, id);
  if (e.status !== 'draft' && e.status !== 'running') throw new AppError('INVALID_STATE', 'Publications can be linked while the experiment is a draft or running.');
  if (e.status === 'running' && !input.reason) throw fieldFail('reason', 'REQUIRED', 'The experiment is running: give a reason for this plan revision.');
  const [v] = await ctx.tx.select().from(experimentVariants).where(and(eq(experimentVariants.id, input.variantId), eq(experimentVariants.experimentId, id)));
  if (!v) throw fieldFail('variantId', 'NOT_FOUND', 'Choose a variant of this experiment.');
  const ids = [...new Set(input.publicationIds)];
  const pubs = await ctx.tx.select().from(publications).where(and(eq(publications.workspaceId, ctx.actor.workspaceId), inArray(publications.id, ids)));
  for (const pid of ids) {
    const p = pubs.find((x) => x.id === pid);
    if (!p || p.deletedAt || !canPublication(ctx, 'publications.read', p)) throw fieldFail('publicationIds', 'NOT_FOUND', 'Choose publications you can access.');
    if (p.projectId !== e.projectId) throw fieldFail('publicationIds', 'OTHER_PROJECT', 'Link publications of the experiment’s project only.');
    if (p.status === 'cancelled') throw fieldFail('publicationIds', 'CANCELLED', 'Cancelled placements cannot be compared.');
  }
  const existing = await ctx.tx.select({ publicationId: experimentPublications.publicationId }).from(experimentPublications).where(and(eq(experimentPublications.experimentId, id), inArray(experimentPublications.publicationId, ids)));
  if (existing.length) throw new AppError('DUPLICATE', 'Some publications are already linked to this experiment.', { fieldErrors: [{ field: 'publicationIds', code: 'ALREADY_LINKED', message: 'Some publications are already linked to this experiment.' }] });
  for (const pid of ids) await ctx.tx.insert(experimentPublications).values({ ...stamp(ctx), id: newId(), experimentId: id, variantId: v.id, publicationId: pid, segment: input.segment });
  let row = (await ctx.tx.update(experiments).set({ ...touch(ctx, experiments) }).where(eq(experiments.id, id)).returning())[0]!;
  if (e.status === 'running') row = await recordRevision(ctx, row, input.reason!);
  await audit(ctx, { action: 'experiment.publications_linked', entityType: 'experiment', entityId: id, projectId: e.projectId, reason: input.reason ?? null, metadata: { variant: v.name, publicationIds: ids, segment: input.segment } });
  await emit(ctx, { type: 'experiment.updated', entityType: 'experiment', entityId: id, revision: row.rowVersion });
  return id;
};

export const unlinkExperimentPublication = async (ctx: CommandContext, id: string, linkId: string, input: { reason?: string }) => {
  const e = await lockForChange(ctx, id);
  if (e.status !== 'draft' && e.status !== 'running') throw new AppError('INVALID_STATE', 'The linked publications of a concluded experiment are frozen.');
  if (e.status === 'running' && !input.reason) throw fieldFail('reason', 'REQUIRED', 'The experiment is running: give a reason for this plan revision.');
  const [l] = await ctx.tx.select().from(experimentPublications).where(and(eq(experimentPublications.id, linkId), eq(experimentPublications.experimentId, id)));
  if (!l) throw new AppError('NOT_FOUND', 'Link was not found.');
  await ctx.tx.delete(experimentPublications).where(eq(experimentPublications.id, linkId));
  let row = (await ctx.tx.update(experiments).set({ ...touch(ctx, experiments) }).where(eq(experiments.id, id)).returning())[0]!;
  if (e.status === 'running') row = await recordRevision(ctx, row, input.reason!);
  await audit(ctx, { action: 'experiment.publication_unlinked', entityType: 'experiment', entityId: id, projectId: e.projectId, reason: input.reason ?? null, metadata: { publicationId: l.publicationId } });
  await emit(ctx, { type: 'experiment.updated', entityType: 'experiment', entityId: id, revision: row.rowVersion });
  return id;
};

export const archiveExperiment = async (ctx: CommandContext, id: string, input: { reason?: string }, opts: { skipVersion?: boolean } = {}) => {
  const e = await lockForChange(ctx, id, opts);
  if (e.status === 'running') throw new AppError('INVALID_STATE', 'Conclude the running experiment before archiving it.');
  assertTransition(EXPERIMENT_TRANSITIONS, e.status, 'archived', 'experiment');
  const at = ctx.app.clock.now();
  const [row] = await ctx.tx
    .update(experiments)
    .set({ status: 'archived', archivedAt: at, archivedBy: ctx.actor.userId, archiveReason: input.reason ?? null, ...touch(ctx, experiments) })
    .where(eq(experiments.id, id))
    .returning();
  await audit(ctx, { action: 'experiment.archived', entityType: 'experiment', entityId: id, projectId: e.projectId, reason: input.reason, diff: { status: { from: e.status, to: 'archived' } } });
  await emit(ctx, { type: 'experiment.archived', entityType: 'experiment', entityId: id, revision: row!.rowVersion });
  await indexExperiment(ctx, row!);
  return id;
};

// ——— Comparable results ———

const USABLE_QUALITY = ['unverified', 'reviewed'] as const;

export const computeExperimentResults = async (ctx: Ctx, e: ExperimentRowDb) => {
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const now = ctx.app.clock.now();
  const [variants, links, policy] = await all(ctx, [
    () => db.select().from(experimentVariants).where(and(eq(experimentVariants.workspaceId, ws), eq(experimentVariants.experimentId, e.id))).orderBy(asc(experimentVariants.position)),
    () =>
      db
        .select({ link: experimentPublications, p: publications })
        .from(experimentPublications)
        .innerJoin(publications, eq(publications.id, experimentPublications.publicationId))
        .where(and(eq(experimentPublications.workspaceId, ws), eq(experimentPublications.experimentId, e.id), isNull(publications.deletedAt))),
    () => activePublicationPolicy(db, ws),
  ] as const);
  // Only placements the member may read enter the comparison (no values leak through results).
  const visible = links.filter((l) => canPublication(ctx, 'publications.read', l.p));
  const pubIds = visible.map((l) => l.p.id);
  const obs = pubIds.length
    ? await db
        .select({ publicationId: metricObservations.publicationId, observedAt: metricObservations.observedAt, value: metricValues.value, availability: metricValues.availability })
        .from(metricObservations)
        .innerJoin(metricValues, and(eq(metricValues.observationId, metricObservations.id), eq(metricValues.metricKey, e.primaryMetricKey)))
        .where(
          and(
            eq(metricObservations.workspaceId, ws),
            inArray(metricObservations.publicationId, pubIds),
            eq(metricObservations.kind, 'cumulative'),
            eq(metricObservations.canonical, true),
            inArray(metricObservations.qualityState, [...USABLE_QUALITY]),
          ),
        )
    : [];
  const tolerance = comparisonTolerance(e.observationWindowHours, policy.entries);
  const titles = new Map((await toPublicationRows(ctx, visible.map((l) => l.p))).map((v) => [v.id, v.title]));
  const items = visible.map((l) =>
    classifyComparable(
      {
        publicationId: l.p.id,
        variantId: l.link.variantId,
        segment: l.link.segment,
        publishedAt: l.p.status === 'published' ? l.p.actualPublishedAt : null,
        removed: false,
        observations: obs.filter((o) => o.publicationId === l.p.id).map((o) => ({ observedAt: o.observedAt, value: o.availability === 'known' ? o.value : null })),
      },
      now,
      e.observationWindowHours,
      tolerance,
    ),
  );
  const summary = summarizeComparable(items, variants.map((v) => v.id), e.minimumSample);
  const names = new Map(variants.map((v) => [v.id, v.name]));
  return {
    metricKey: e.primaryMetricKey,
    metricLabel: metricLabel(e.primaryMetricKey),
    windowHours: e.observationWindowHours,
    toleranceHours: tolerance,
    evaluatedAt: now.toISOString(),
    method: `Median and mean of values observed ${e.observationWindowHours} h after publication (± ${tolerance} h); organic and paid placements are summarised separately; outliers use 1.5 × IQR fences.`,
    caveat: 'Organic comparison of placements, not a randomized A/B test. No statistical significance is calculated; the owner decides and explains any selected variant.',
    status: summary.status,
    reasons: summary.reasons,
    segments: summary.segments.map((s) => ({
      segment: s.segment,
      variants: s.variants.map((v) => ({
        variantId: v.variantId,
        name: names.get(v.variantId) ?? 'Variant',
        sampleSize: v.sampleSize,
        median: v.median,
        mean: v.mean,
        min: v.min,
        max: v.max,
        outliers: v.outliers.map((o) => ({ publicationId: o.key, value: o.value })),
        excluded: v.excluded,
      })),
    })),
    items: items.map((i) => {
      const p = visible.find((l) => l.p.id === i.publicationId)!.p;
      return {
        publicationId: i.publicationId,
        title: titles.get(i.publicationId) ?? 'Content',
        variantId: i.variantId,
        segment: i.segment,
        state: i.state,
        actualPublishedAt: p.actualPublishedAt?.toISOString() ?? null,
        ageHours: i.ageHours,
        value: i.value,
        observedAt: i.observedAt?.toISOString() ?? null,
        observedAgeHours: i.observedAgeHours,
      };
    }),
  };
};

export const getExperimentResults = async (ctx: QueryContext, id: string) => computeExperimentResults(ctx, await loadExperiment(ctx, id));

