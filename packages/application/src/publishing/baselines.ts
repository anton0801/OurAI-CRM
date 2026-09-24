import { and, asc, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { hasAnywhere } from '@castlane/authorization';
import { planBaselineItems, planBaselines, publications, socialAccounts, workspaces, projects, contentItems } from '@castlane/database';
import { AppError, isIsoDate, newId } from '@castlane/domain';
import { requirePermission, whereAll } from '../core/access';
import { executeSystemCommand } from '../core/command';
import { dbOf, type AppServices, type CommandContext, type QueryContext } from '../core/context';
import { audit } from '../core/audit';
import { emit } from '../core/events';
import { systemJobContext } from '../core/jobs-registry';
import { stamp, touch } from '../core/rows';
import { accountLabel } from '../accounts/accounts';
import { onTimeAgainstBaseline, planWeekBounds, planWeekOf } from './logic';
import { toPublicationRows } from './publications';
import { publicationVisibility, workspacePlanSettings } from './scope';

/**
 * Weekly plan baselines (§12, M09/M10). At Monday 00:00 workspace time the scheduled placements of
 * the week are frozen with `baseline_scheduled_at` = their schedule at that moment. Placements
 * scheduled into a frozen week later are "Added After Baseline"; a placement moved out of the week
 * keeps its original row (T067); cancelled placements stay in the cohort with the reason.
 */

const PLANNED = ['scheduled', 'published', 'failed'] as const;

/** Freeze one week (idempotent: the (workspace, week) row is unique). Returns the baseline id. */
export const freezePlanWeek = async (ctx: CommandContext, weekStart: string, timezone: string) => {
  const { start, end } = planWeekBounds(weekStart, timezone);
  const at = ctx.app.clock.now();
  const inserted = await ctx.tx
    .insert(planBaselines)
    .values({ ...stamp(ctx), id: newId(), weekStart, frozenAt: at, timezone })
    .onConflictDoNothing()
    .returning();
  if (!inserted.length) {
    const [existing] = await ctx.tx.select().from(planBaselines).where(and(eq(planBaselines.workspaceId, ctx.actor.workspaceId), eq(planBaselines.weekStart, weekStart)));
    return { id: existing!.id, created: false };
  }
  const b = inserted[0]!;
  const rows = await ctx.tx
    .select({ id: publications.id, accountId: publications.accountId, projectId: publications.projectId, scheduledAt: publications.scheduledAt })
    .from(publications)
    .where(
      and(
        eq(publications.workspaceId, ctx.actor.workspaceId),
        isNull(publications.deletedAt),
        inArray(publications.status, [...PLANNED]),
        gte(publications.scheduledAt, start),
        lt(publications.scheduledAt, end),
      ),
    );
  for (const r of rows)
    await ctx.tx
      .insert(planBaselineItems)
      .values({ ...stamp(ctx), id: newId(), baselineId: b.id, publicationId: r.id, accountId: r.accountId, projectId: r.projectId, baselineScheduledAt: r.scheduledAt, addedAfterBaseline: false })
      .onConflictDoNothing();
  await audit(ctx, { action: 'plan_baseline.frozen', entityType: 'plan_baseline', entityId: b.id, metadata: { weekStart, items: rows.length } });
  await emit(ctx, { type: 'plan_baseline.frozen', entityType: 'plan_baseline', entityId: b.id, payload: { weekStart } });
  return { id: b.id, created: true };
};

/**
 * Keep frozen plans consistent when a placement is (re)scheduled: joining a frozen week it did not
 * belong to adds an "Added After Baseline" row; leaving its week keeps the original row untouched.
 */
export const baselineOnSchedule = async (ctx: CommandContext, p: { id: string; accountId: string; projectId: string }, newAt: Date) => {
  const s = await workspacePlanSettings(ctx.tx, ctx.actor.workspaceId);
  const week = planWeekOf(newAt, s.timezone, s.weekStartsOn);
  const [b] = await ctx.tx.select().from(planBaselines).where(and(eq(planBaselines.workspaceId, ctx.actor.workspaceId), eq(planBaselines.weekStart, week.weekStart)));
  if (!b) return null;
  await ctx.tx
    .insert(planBaselineItems)
    .values({ ...stamp(ctx), id: newId(), baselineId: b.id, publicationId: p.id, accountId: p.accountId, projectId: p.projectId, baselineScheduledAt: null, addedAfterBaseline: true })
    .onConflictDoNothing();
  return week.weekStart;
};

/** Cancelled after the freeze: the row stays in the cohort (denominator) with the reason (M09). */
export const baselineOnCancel = async (ctx: CommandContext, publicationId: string, reason: string) => {
  const at = ctx.app.clock.now();
  await ctx.tx
    .update(planBaselineItems)
    .set({ removedAfterBaselineAt: at, removalReason: reason, ...touch(ctx, planBaselineItems) })
    .where(and(eq(planBaselineItems.workspaceId, ctx.actor.workspaceId), eq(planBaselineItems.publicationId, publicationId), isNull(planBaselineItems.removedAfterBaselineAt)));
};

/** Frozen weeks a move would touch (schedule preview). */
export const baselineEffects = async (ctx: QueryContext | CommandContext, p: { id: string }, newAt: Date) => {
  const db = dbOf(ctx);
  const s = await workspacePlanSettings(db, ctx.actor.workspaceId);
  const target = planWeekOf(newAt, s.timezone, s.weekStartsOn).weekStart;
  const memberships = await db
    .select({ weekStart: planBaselines.weekStart })
    .from(planBaselineItems)
    .innerJoin(planBaselines, eq(planBaselines.id, planBaselineItems.baselineId))
    .where(and(eq(planBaselineItems.workspaceId, ctx.actor.workspaceId), eq(planBaselineItems.publicationId, p.id)));
  const effects: { weekStart: string; effect: 'kept_in_original_week' | 'added_after_baseline' }[] = [];
  for (const m of memberships) if (m.weekStart !== target) effects.push({ weekStart: m.weekStart, effect: 'kept_in_original_week' });
  if (!memberships.some((m) => m.weekStart === target)) {
    const [b] = await db.select({ id: planBaselines.id }).from(planBaselines).where(and(eq(planBaselines.workspaceId, ctx.actor.workspaceId), eq(planBaselines.weekStart, target)));
    if (b) effects.push({ weekStart: target, effect: 'added_after_baseline' });
  }
  return effects;
};

// ——— Read model: Original vs Current plan of one week ———

export const planBaselineWeekView = async (ctx: QueryContext | CommandContext, input: { weekStart: string; projectId?: string; accountId?: string }) => {
  requirePermission(ctx, 'publications.read');
  if (!isIsoDate(input.weekStart)) throw new AppError('VALIDATION_FAILED', 'Choose a week.', { fieldErrors: [{ field: 'weekStart', code: 'INVALID', message: 'Choose a week.' }] });
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const s = await workspacePlanSettings(db, ws);
  // Normalise any date to the start of its plan week.
  const bounds = planWeekOf(planWeekBounds(input.weekStart, s.timezone).start, s.timezone, s.weekStartsOn);
  const [b] = await db.select().from(planBaselines).where(and(eq(planBaselines.workspaceId, ws), eq(planBaselines.weekStart, bounds.weekStart)));
  const filters = whereAll(
    input.projectId ? eq(publications.projectId, input.projectId) : undefined,
    input.accountId ? eq(publications.accountId, input.accountId) : undefined,
  );
  const original = b
    ? await db
        .select({ item: planBaselineItems, p: publications, title: contentItems.title, account: socialAccounts, projectName: projects.name })
        .from(planBaselineItems)
        .innerJoin(publications, eq(publications.id, planBaselineItems.publicationId))
        .leftJoin(contentItems, eq(contentItems.id, publications.contentItemId))
        .leftJoin(socialAccounts, eq(socialAccounts.id, publications.accountId))
        .leftJoin(projects, eq(projects.id, publications.projectId))
        .where(and(eq(planBaselineItems.baselineId, b.id), publicationVisibility(ctx), filters))
        .orderBy(asc(sql`coalesce(${planBaselineItems.baselineScheduledAt}, ${publications.scheduledAt})`), asc(publications.id))
    : [];
  const current = await db
    .select()
    .from(publications)
    .where(
      whereAll(
        eq(publications.workspaceId, ws),
        isNull(publications.deletedAt),
        publicationVisibility(ctx),
        inArray(publications.status, [...PLANNED]),
        or(and(gte(publications.scheduledAt, bounds.start), lt(publications.scheduledAt, bounds.end)), and(gte(publications.actualPublishedAt, bounds.start), lt(publications.actualPublishedAt, bounds.end))),
        filters,
      ),
    )
    .orderBy(asc(publications.scheduledAt), asc(publications.id))
    .limit(500);
  const now = ctx.app.clock.now();
  return {
    weekStart: bounds.weekStart,
    weekEnd: bounds.weekEnd,
    timezone: s.timezone,
    graceMinutes: s.graceMinutes,
    baseline: b ? { id: b.id, frozenAt: b.frozenAt.toISOString() } : null,
    original: original.map(({ item, p, title, account, projectName }) => ({
      publicationId: p.id,
      title: title ?? 'Content',
      account: { id: p.accountId, label: account ? accountLabel(account) : 'Account', platform: account?.platform ?? 'other' },
      project: { id: p.projectId, name: projectName ?? 'Project' },
      status: p.status,
      baselineScheduledAt: item.baselineScheduledAt?.toISOString() ?? null,
      currentScheduledAt: p.scheduledAt?.toISOString() ?? null,
      actualPublishedAt: p.actualPublishedAt?.toISOString() ?? null,
      addedAfterBaseline: item.addedAfterBaseline,
      removedAfterBaselineAt: item.removedAfterBaselineAt?.toISOString() ?? null,
      removalReason: item.removalReason,
      movedOutOfWeek: !!p.scheduledAt && (p.scheduledAt < bounds.start || p.scheduledAt >= bounds.end),
      onTimeAgainstBaseline: item.addedAfterBaseline ? null : onTimeAgainstBaseline(item.baselineScheduledAt, p.status === 'published' ? p.actualPublishedAt : null, s.graceMinutes),
    })),
    current: await toPublicationRows(ctx, current),
    canFreeze: !b && hasAnywhere(ctx.actor.access, 'publications.correct') && now >= bounds.start && now < bounds.end,
  };
};

/** Manual freeze of the current week when the automatic freeze has not happened yet (e.g. right after setup). */
export const freezeCurrentPlanWeek = async (ctx: CommandContext, input: { weekStart: string }) => {
  requirePermission(ctx, 'publications.correct');
  const s = await workspacePlanSettings(ctx.tx, ctx.actor.workspaceId);
  const current = planWeekOf(ctx.app.clock.now(), s.timezone, s.weekStartsOn);
  if (input.weekStart !== current.weekStart)
    throw new AppError('INVALID_STATE', 'Only the current week can be frozen; past plans cannot be rebuilt after the fact.', { details: { currentWeekStart: current.weekStart } });
  await freezePlanWeek(ctx, current.weekStart, s.timezone);
  return planBaselineWeekView(ctx, { weekStart: current.weekStart });
};

/** Scheduler entry point: freeze the current week of every workspace once its week has started. */
export const runPlanFreeze = async (app: AppServices) => {
  const rows = await app.db.select({ id: workspaces.id, timezone: workspaces.timezone, weekStartsOn: workspaces.weekStartsOn }).from(workspaces);
  let frozen = 0;
  for (const w of rows) {
    const week = planWeekOf(app.clock.now(), w.timezone, w.weekStartsOn);
    const [existing] = await app.db.select({ id: planBaselines.id }).from(planBaselines).where(and(eq(planBaselines.workspaceId, w.id), eq(planBaselines.weekStart, week.weekStart)));
    if (existing) continue;
    const base = await systemJobContext(app, w.id, ['publications.read']);
    const r = await executeSystemCommand(base, (ctx) => freezePlanWeek(ctx, week.weekStart, w.timezone));
    if (r.created) frozen++;
  }
  return { frozen };
};
