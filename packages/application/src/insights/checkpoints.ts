import { and, asc, desc, eq, gt, gte, inArray, lt, lte, max, or, sql, type SQL } from 'drizzle-orm';
import { hasAnywhere } from '@castlane/authorization';
import { snapshotChange, valueCompleteness } from '@castlane/analytics';
import { contentItems, metricCheckpoints, metricObservations, metricValues, publications, socialAccounts, workspaces } from '@castlane/database';
import type { CheckpointRow, ReviewQueueItem } from '@castlane/api-contracts';
import { AppError, DateTime, clampPageSize, decodeCursor, encodeCursor, newId, notFound } from '@castlane/domain';
import { allowed, authorizeObject, authorizeRead, requirePermission, scopePredicate } from '../core/access';
import { audit } from '../core/audit';
import { all, dbOf, type AppServices, type CommandContext, type QueryContext } from '../core/context';
import { emit } from '../core/events';
import { loadMemberRefs, refOrUnknown } from '../core/members';
import { notify } from '../core/notify';
import { assertVersion, lockById, stamp, touch } from '../core/rows';
import { ACCOUNT_CHECKPOINT_KEY, activePolicy, checkpointLabel, requiredMetricsFor, type PolicyRow } from './catalog';
import { iso, loadAccounts, localIsoDate, plainDecimal, type Ctx } from './common';
import { activeObservation, entityRefOf, entityScope, loadEntities, toObservationSummaries } from './observations';

type CheckpointRowDb = typeof metricCheckpoints.$inferSelect;
type Status = CheckpointRow['status'];

/** Status of a checkpoint relative to its window: Upcoming → Due (in window) → Overdue. */
export const checkpointStatusAt = (cp: Pick<CheckpointRowDb, 'state' | 'windowStart' | 'windowEnd'>, now: Date): Status => {
  if (cp.state !== 'pending') return cp.state;
  if (now.getTime() < cp.windowStart.getTime()) return 'upcoming';
  if (now.getTime() <= cp.windowEnd.getTime()) return 'due';
  return 'overdue';
};

const checkpointScopeSql = (ctx: Ctx) => scopePredicate(ctx, 'metrics.read', { projectId: metricCheckpoints.projectId, accountId: metricCheckpoints.accountId });

export const toCheckpointRows = async (ctx: Ctx, rows: CheckpointRowDb[]): Promise<CheckpointRow[]> => {
  if (!rows.length) return [];
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const obsIds = [...new Set(rows.map((r) => r.completedObservationId).filter((x): x is string => !!x))];
  const [entities, observations, values, policy] = await all(ctx, [
    () => loadEntities(ctx, rows.map((r) => ({ type: r.entityType === 'publication' ? ('publication' as const) : ('account' as const), id: r.entityId }))),
    () => (obsIds.length ? db.select().from(metricObservations).where(and(eq(metricObservations.workspaceId, ws), inArray(metricObservations.id, obsIds))) : Promise.resolve([])),
    () => (obsIds.length ? db.select().from(metricValues).where(and(eq(metricValues.workspaceId, ws), inArray(metricValues.observationId, obsIds))) : Promise.resolve([])),
    () => activePolicy(ctx),
  ] as const);
  const refs = await loadMemberRefs(db, ws, [...rows.map((r) => r.assigneeMembershipId), ...observations.map((o) => o.enteredByMembershipId)]);
  const now = ctx.app.clock.now();
  return rows.map((r) => {
    const e = entities.get(`${r.entityType === 'publication' ? 'publication' : 'account'}:${r.entityId}`);
    const o = observations.find((x) => x.id === r.completedObservationId);
    const required = requiredMetricsFor(r.checkpointKey, policy.config);
    const scope = { projectId: r.projectId, accountId: r.accountId };
    return {
      id: r.id,
      entity: e
        ? entityRefOf(e)
        : { type: r.entityType, id: r.entityId, label: 'Unavailable record', sublabel: null, accountId: r.accountId, projectId: r.projectId, publicationId: r.publicationId, platform: null, href: `/accounts/${r.accountId}` },
      checkpointKey: r.checkpointKey,
      label: checkpointLabel(r.checkpointKey, policy.config),
      policyVersion: r.policyVersion,
      expectedAt: r.expectedAt.toISOString(),
      windowStart: r.windowStart.toISOString(),
      windowEnd: r.windowEnd.toISOString(),
      state: r.state,
      status: checkpointStatusAt(r, now),
      timing: r.timing,
      observationId: r.completedObservationId,
      observedAt: iso(o?.observedAt),
      enteredAt: iso(o?.enteredAt),
      reporter: o ? refOrUnknown(refs, o.enteredByMembershipId) : null,
      source: o ? { type: o.sourceType, namespace: o.sourceNamespace } : null,
      completeness: o ? valueCompleteness(values.filter((v) => v.observationId === o.id), required) : null,
      assignee: refOrUnknown(refs, r.assigneeMembershipId),
      missingReason: r.missingReason,
      requiredMetrics: required,
      rowVersion: r.rowVersion,
      permissions: {
        addMetrics: r.state === 'pending' && allowed(ctx, 'metrics.write', scope),
        markMissing: r.state === 'pending' && allowed(ctx, 'metrics.write', scope),
      },
    };
  });
};

type Tab = 'due' | 'overdue' | 'upcoming' | 'submitted' | 'missing' | 'all';

const tabWhere = (tab: Tab, now: Date): SQL | undefined => {
  const t = metricCheckpoints;
  switch (tab) {
    case 'due':
      return sql`${t.state} = 'pending' AND ${t.windowStart} <= ${now} AND ${t.windowEnd} >= ${now}`;
    case 'overdue':
      return sql`${t.state} = 'pending' AND ${t.windowEnd} < ${now}`;
    case 'upcoming':
      return sql`${t.state} = 'pending' AND ${t.windowStart} > ${now} AND ${t.expectedAt} <= ${new Date(now.getTime() + 7 * 86_400_000)}`;
    case 'submitted':
      return eq(t.state, 'completed');
    case 'missing':
      return eq(t.state, 'missing');
    default:
      return undefined;
  }
};

export interface ListCheckpointsInput {
  tab: Tab;
  cursor?: string;
  pageSize?: number;
  entityType?: 'account' | 'publication' | 'ofm_account';
  accountId?: string;
  projectId?: string;
  publicationId?: string;
  mine?: boolean;
}

/** Metrics Inbox list (S49), scope in SQL before pagination. */
export const listCheckpoints = async (ctx: QueryContext, input: ListCheckpointsInput) => {
  requirePermission(ctx, 'metrics.read');
  const t = metricCheckpoints;
  const size = clampPageSize(input.pageSize);
  const now = ctx.app.clock.now();
  const byUpdate = input.tab === 'submitted' || input.tab === 'missing';
  const desc_ = input.tab === 'all' || byUpdate;
  const sortCol = byUpdate ? t.updatedAt : t.expectedAt;
  const c = input.cursor ? decodeCursor(input.cursor) : null;
  const cmp = desc_ ? lt : gt;
  const rows = await ctx.app.db
    .select()
    .from(t)
    .where(
      and(
        eq(t.workspaceId, ctx.actor.workspaceId),
        checkpointScopeSql(ctx),
        tabWhere(input.tab, now),
        input.tab === 'all' ? undefined : sql`${t.state} <> 'cancelled'`,
        input.entityType ? eq(t.entityType, input.entityType === 'ofm_account' ? 'account' : input.entityType) : undefined,
        input.accountId ? eq(t.accountId, input.accountId) : undefined,
        input.projectId ? eq(t.projectId, input.projectId) : undefined,
        input.publicationId ? eq(t.publicationId, input.publicationId) : undefined,
        input.mine ? eq(t.assigneeMembershipId, ctx.actor.membershipId ?? '00000000-0000-4000-8000-000000000000') : undefined,
        c ? or(cmp(sortCol, new Date(String(c.v[0]))), and(eq(sortCol, new Date(String(c.v[0]))), cmp(t.id, c.id))) : undefined,
      ),
    )
    .orderBy(desc_ ? desc(sortCol) : asc(sortCol), desc_ ? desc(t.id) : asc(t.id))
    .limit(size + 1);
  const hasMore = rows.length > size;
  const pageRows = hasMore ? rows.slice(0, size) : rows;
  const last = pageRows[pageRows.length - 1];
  return {
    items: await toCheckpointRows(ctx, pageRows),
    hasMore,
    nextCursor: hasMore && last ? encodeCursor({ v: [(byUpdate ? last.updatedAt : last.expectedAt).toISOString()], id: last.id }) : null,
  };
};

export const getCheckpoint = async (ctx: Ctx, id: string) => {
  const [cp] = await dbOf(ctx).select().from(metricCheckpoints).where(and(eq(metricCheckpoints.workspaceId, ctx.actor.workspaceId), eq(metricCheckpoints.id, id)));
  if (!cp) throw notFound('Checkpoint');
  authorizeRead(ctx, 'metrics.read', { objectType: 'metric_checkpoint', objectId: cp.id, projectId: cp.projectId, accountId: cp.accountId });
  return (await toCheckpointRows(ctx, [cp]))[0]!;
};

/** Mark Unavailable: closes the request as Missing with a reason — never creates zero values (S49, T114). */
export const markCheckpointMissing = async (ctx: CommandContext, id: string, input: { reason: string }) => {
  const cp = await lockById(ctx, metricCheckpoints, id, 'Checkpoint');
  authorizeObject(ctx, 'metrics.write', { objectType: 'metric_checkpoint', objectId: cp.id, projectId: cp.projectId, accountId: cp.accountId }, 'metrics.read');
  assertVersion(ctx, cp);
  if (cp.state !== 'pending') throw new AppError('INVALID_STATE', `This checkpoint is already ${cp.state}.`);
  await ctx.tx.update(metricCheckpoints).set({ state: 'missing', missingReason: input.reason.trim(), ...touch(ctx, metricCheckpoints) }).where(eq(metricCheckpoints.id, id));
  await audit(ctx, { action: 'metric_checkpoint.marked_missing', entityType: 'metric_checkpoint', entityId: id, projectId: cp.projectId, reason: input.reason });
  await emit(ctx, { type: 'metric_checkpoint.missing', entityType: 'metric_checkpoint', entityId: id, revision: cp.rowVersion + 1 });
  return id;
};

/** Overlapping canonical period observations of the same entity/segment/definition (conflicts). */
const conflictSql = (ctx: Ctx) => sql`
  SELECT DISTINCT a.id FROM metric_observations a
  JOIN metric_observations b ON b.workspace_id = a.workspace_id AND b.entity_type = a.entity_type AND b.entity_id = a.entity_id
    AND b.kind = 'period' AND b.segment = a.segment AND b.definition_set_version = a.definition_set_version AND b.id <> a.id
    AND b.canonical AND b.quality_state IN ('unverified', 'reviewed')
    AND tstzrange(b.period_start, b.period_end) && tstzrange(a.period_start, a.period_end)
  WHERE a.workspace_id = ${ctx.actor.workspaceId} AND a.kind = 'period' AND a.canonical AND a.quality_state IN ('unverified', 'reviewed')`;

export const inboxSummary = async (ctx: QueryContext, input: { mine?: boolean }) => {
  requirePermission(ctx, 'metrics.read');
  const t = metricCheckpoints;
  const now = ctx.app.clock.now();
  const scope = checkpointScopeSql(ctx);
  const mine = input.mine ? eq(t.assigneeMembershipId, ctx.actor.membershipId ?? '00000000-0000-4000-8000-000000000000') : undefined;
  const count = async (tab: Tab) => {
    const [r] = await ctx.app.db
      .select({ n: sql<number>`count(*)::int` })
      .from(t)
      .where(and(eq(t.workspaceId, ctx.actor.workspaceId), scope, tabWhere(tab, now), mine));
    return r?.n ?? 0;
  };
  const obsScope = scopePredicate(ctx, 'metrics.read', { projectId: metricObservations.projectId, accountId: metricObservations.accountId });
  const [due, overdue, upcoming, submitted, missing, pending, conflicts] = await all(ctx, [
    () => count('due'),
    () => count('overdue'),
    () => count('upcoming'),
    () => count('submitted'),
    () => count('missing'),
    () =>
      ctx.app.db
        .select({ n: sql<number>`count(*)::int` })
        .from(metricObservations)
        .where(and(eq(metricObservations.workspaceId, ctx.actor.workspaceId), obsScope, eq(metricObservations.qualityState, 'pending_correction'))),
    () =>
      ctx.app.db
        .select({ n: sql<number>`count(*)::int` })
        .from(metricObservations)
        .where(and(eq(metricObservations.workspaceId, ctx.actor.workspaceId), obsScope, sql`${metricObservations.id} IN (${conflictSql(ctx)})`)),
  ] as const);
  return { due, overdue, upcoming, submitted, missing, needsReview: (pending[0]?.n ?? 0) + (conflicts[0]?.n ?? 0) };
};

/** Needs Review: corrections awaiting approval, overlapping periods, unverified entries saved with warnings. */
export const reviewQueue = async (ctx: QueryContext, input: { entityType?: 'account' | 'publication' | 'ofm_account'; accountId?: string; projectId?: string; publicationId?: string; limit: number }): Promise<ReviewQueueItem[]> => {
  requirePermission(ctx, 'metrics.read');
  const o = metricObservations;
  const db = ctx.app.db;
  const ws = ctx.actor.workspaceId;
  const filters = and(
    eq(o.workspaceId, ws),
    scopePredicate(ctx, 'metrics.read', { projectId: o.projectId, accountId: o.accountId }),
    input.entityType ? eq(o.entityType, input.entityType) : undefined,
    input.accountId ? eq(o.accountId, input.accountId) : undefined,
    input.projectId ? eq(o.projectId, input.projectId) : undefined,
    input.publicationId ? eq(o.publicationId, input.publicationId) : undefined,
  );
  const [pending, conflicts, unverified] = await all(ctx, [
    () => db.select().from(o).where(and(filters, eq(o.qualityState, 'pending_correction'))).orderBy(asc(o.enteredAt)).limit(input.limit),
    () => db.select().from(o).where(and(filters, sql`${o.id} IN (${conflictSql(ctx)})`)).orderBy(asc(o.periodStart)).limit(input.limit),
    () =>
      db
        .select()
        .from(o)
        .where(and(filters, eq(o.qualityState, 'unverified'), sql`jsonb_array_length(${o.warnings}) > 0`, sql`${o.warnings} ?| array['REACH_ABOVE_IMPRESSIONS','COMPLETIONS_ABOVE_VIEWS','CUMULATIVE_DECREASE','PERIOD_OVERLAP']`))
        .orderBy(desc(o.enteredAt))
        .limit(input.limit),
  ] as const);
  const currentIds = pending.map((p) => p.supersedesId).filter((x): x is string => !!x);
  const currents = currentIds.length ? await db.select().from(o).where(and(eq(o.workspaceId, ws), inArray(o.id, currentIds))) : [];
  const summaries = await toObservationSummaries(ctx, [...currents, ...conflicts, ...unverified]);
  const byId = new Map(summaries.map((s) => [s.id, s]));
  const refs = await loadMemberRefs(db, ws, [...pending, ...unverified, ...conflicts].map((p) => p.enteredByMembershipId));
  const out: ReviewQueueItem[] = [];
  for (const p of pending) {
    const s = p.supersedesId ? byId.get(p.supersedesId) : undefined;
    if (!s) continue;
    out.push({ kind: 'correction', observation: s, pendingRevisionId: p.id, pendingRowVersion: p.rowVersion, submittedBy: refOrUnknown(refs, p.enteredByMembershipId), submittedAt: p.enteredAt.toISOString(), reason: p.correctionReason });
  }
  for (const c of conflicts) {
    const s = byId.get(c.id);
    if (s) out.push({ kind: 'conflict', observation: s, pendingRevisionId: null, pendingRowVersion: null, submittedBy: refOrUnknown(refs, c.enteredByMembershipId), submittedAt: c.enteredAt.toISOString(), reason: 'Overlapping periods are not summed. Exclude one record from reports or record a non-overlapping breakdown.' });
  }
  for (const u of unverified) {
    if (out.some((x) => x.observation.id === u.id)) continue;
    const s = byId.get(u.id);
    if (s) out.push({ kind: 'unverified', observation: s, pendingRevisionId: null, pendingRowVersion: null, submittedBy: refOrUnknown(refs, u.enteredByMembershipId), submittedAt: u.enteredAt.toISOString(), reason: u.warningNote });
  }
  return out.slice(0, input.limit);
};

/** My Work → Metric Checkpoints (assigned to me, visible in my metrics scope). */
export const myCheckpoints = async (ctx: QueryContext) => {
  if (!hasAnywhere(ctx.actor.access, 'metrics.read') || !ctx.actor.membershipId) return { overdue: [], due: [], upcoming: [], canRead: false };
  const t = metricCheckpoints;
  const now = ctx.app.clock.now();
  const base = and(eq(t.workspaceId, ctx.actor.workspaceId), checkpointScopeSql(ctx), eq(t.assigneeMembershipId, ctx.actor.membershipId));
  const [overdue, due, upcoming] = await all(ctx, [
    () => ctx.app.db.select().from(t).where(and(base, tabWhere('overdue', now))).orderBy(asc(t.expectedAt)).limit(20),
    () => ctx.app.db.select().from(t).where(and(base, tabWhere('due', now))).orderBy(asc(t.expectedAt)).limit(20),
    () => ctx.app.db.select().from(t).where(and(base, tabWhere('upcoming', now))).orderBy(asc(t.expectedAt)).limit(20),
  ] as const);
  const rows = await toCheckpointRows(ctx, [...overdue, ...due, ...upcoming]);
  const pick = (ids: CheckpointRowDb[]) => ids.map((r) => rows.find((x) => x.id === r.id)!).filter(Boolean);
  return { overdue: pick(overdue), due: pick(due), upcoming: pick(upcoming), canRead: true };
};

// ——— Checkpoint creation ———

/**
 * Publication checkpoints (24 h and 7 d by default, §12) from the active versioned policy. The
 * publications module creates them on Mark Published; this helper writes exactly the same rows
 * (`occurrence_key = publication:{id}:{policyKey}`, assignee = publication owner), so running it
 * after Mark Published is a no-op (T065). Used for backfills and tests.
 */
export const ensurePublicationCheckpoints = async (
  ctx: CommandContext,
  pub: { id: string; accountId: string; projectId: string; actualPublishedAt: Date; assigneeMembershipId?: string | null },
): Promise<string[]> => {
  const policy = await activePolicy(ctx);
  const created: string[] = [];
  for (const rule of policy.config.publication) {
    const expected = new Date(pub.actualPublishedAt.getTime() + rule.offsetHours * 3_600_000);
    const tol = rule.toleranceHours * 3_600_000;
    const id = newId();
    const rows = await ctx.tx
      .insert(metricCheckpoints)
      .values({
        ...stamp(ctx),
        id,
        entityType: 'publication',
        entityId: pub.id,
        accountId: pub.accountId,
        projectId: pub.projectId,
        publicationId: pub.id,
        checkpointKey: rule.key,
        policyVersion: policy.version,
        expectedAt: expected,
        windowStart: new Date(expected.getTime() - tol),
        windowEnd: new Date(expected.getTime() + tol),
        occurrenceKey: `publication:${pub.id}:${rule.key}`,
        assigneeMembershipId: pub.assigneeMembershipId ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: metricCheckpoints.id });
    if (rows[0]) {
      created.push(rows[0].id);
      await emit(ctx, { type: 'metric_checkpoint.created', entityType: 'metric_checkpoint', entityId: rows[0].id, revision: 1, payload: { key: rule.key } });
    }
  }
  return created;
};

/** Pending checkpoints of a publication that failed, was cancelled or had its date corrected (completed ones stay). */
export const cancelPublicationCheckpoints = async (ctx: CommandContext, publicationId: string, reason: string) => {
  const rows = await ctx.tx
    .update(metricCheckpoints)
    .set({ state: 'cancelled', cancelledReason: reason, ...touch(ctx, metricCheckpoints) })
    .where(and(eq(metricCheckpoints.workspaceId, ctx.actor.workspaceId), eq(metricCheckpoints.publicationId, publicationId), eq(metricCheckpoints.state, 'pending')))
    .returning({ id: metricCheckpoints.id });
  for (const r of rows) await emit(ctx, { type: 'metric_checkpoint.cancelled', entityType: 'metric_checkpoint', entityId: r.id });
  return rows.length;
};

/**
 * Account snapshot occurrences for a cadence in the workspace zone: daily at HH:MM, weekly on the
 * chosen weekday, monthly on the first chosen weekday of the month.
 */
export const accountOccurrences = (cadence: 'daily' | 'weekly' | 'monthly', dayOfWeek: number, time: string, zone: string, now: Date): { previous: Date; next: Date } => {
  const [hh, mm] = time.split(':').map(Number);
  const at = (d: DateTime) => d.set({ hour: hh ?? 10, minute: mm ?? 0, second: 0, millisecond: 0 });
  const local = DateTime.fromJSDate(now, { zone });
  const wd = Math.min(7, Math.max(1, dayOfWeek));
  const firstWeekdayOfMonth = (d: DateTime) => {
    const first = d.startOf('month');
    return at(first.plus({ days: (wd - first.weekday + 7) % 7 }));
  };
  let candidate: DateTime;
  let step: (d: DateTime, n: number) => DateTime;
  if (cadence === 'daily') {
    candidate = at(local);
    step = (d, n) => d.plus({ days: n });
  } else if (cadence === 'weekly') {
    candidate = at(local.set({ weekday: wd as 1 | 2 | 3 | 4 | 5 | 6 | 7 }));
    step = (d, n) => d.plus({ weeks: n });
  } else {
    candidate = firstWeekdayOfMonth(local);
    step = (d, n) => firstWeekdayOfMonth(d.plus({ months: n }).startOf('month'));
  }
  if (candidate.toMillis() > now.getTime()) return { previous: step(candidate, -1).toJSDate(), next: candidate.toJSDate() };
  return { previous: candidate.toJSDate(), next: step(candidate, 1).toJSDate() };
};

const ACCOUNT_WINDOW_BEFORE_MS = 12 * 3_600_000;
const ACCOUNT_LOOKAHEAD_MS = 24 * 3_600_000;

/** Ensure the current/next account snapshot checkpoints exist for every active account of a workspace. */
export const generateAccountCheckpoints = async (app: AppServices, workspaceId: string, policy: PolicyRow) => {
  const now = app.clock.now();
  const [w] = await app.db.select({ tz: workspaces.timezone }).from(workspaces).where(eq(workspaces.id, workspaceId));
  const zone = w?.tz ?? 'UTC';
  const accounts = await app.db
    .select()
    .from(socialAccounts)
    .where(and(eq(socialAccounts.workspaceId, workspaceId), eq(socialAccounts.status, 'active'), sql`${socialAccounts.archivedAt} IS NULL AND ${socialAccounts.deletedAt} IS NULL`));
  const grace = policy.config.account.graceHours * 3_600_000;
  let created = 0;
  for (const a of accounts) {
    const { previous, next } = accountOccurrences(a.metricsCadence, a.metricsDayOfWeek, a.metricsTime, zone, now);
    const candidates = [previous, next].filter(
      (t) => (t.getTime() + grace > now.getTime() && t.getTime() >= a.createdAt.getTime()) && t.getTime() - ACCOUNT_LOOKAHEAD_MS <= now.getTime(),
    );
    for (const t of candidates) {
      const rows = await app.db
        .insert(metricCheckpoints)
        .values({
          id: newId(),
          workspaceId,
          createdAt: now,
          updatedAt: now,
          rowVersion: 1,
          entityType: 'account',
          entityId: a.id,
          accountId: a.id,
          projectId: a.projectId,
          checkpointKey: ACCOUNT_CHECKPOINT_KEY,
          policyVersion: policy.version,
          expectedAt: t,
          windowStart: new Date(t.getTime() - ACCOUNT_WINDOW_BEFORE_MS),
          windowEnd: new Date(t.getTime() + grace),
          occurrenceKey: `acct:${a.id}:${localIsoDate(t, zone)}`,
          assigneeMembershipId: a.ownerMembershipId,
        })
        .onConflictDoNothing()
        .returning({ id: metricCheckpoints.id });
      created += rows.length;
    }
  }
  return created;
};

/**
 * "Metrics update needed" once per account snapshot checkpoint when it becomes due (deterministic
 * event key). Publication checkpoints are reminded through the measurement tasks the publications
 * module creates on Mark Published, so they are not notified twice.
 */
export const notifyDueCheckpoints = async (app: AppServices, workspaceId: string, policy: PolicyRow) => {
  const now = app.clock.now();
  const due = await app.db
    .select()
    .from(metricCheckpoints)
    .where(
      and(
        eq(metricCheckpoints.workspaceId, workspaceId),
        eq(metricCheckpoints.entityType, 'account'),
        eq(metricCheckpoints.state, 'pending'),
        lte(metricCheckpoints.windowStart, now),
        gte(metricCheckpoints.expectedAt, new Date(now.getTime() - 2 * 86_400_000)),
        lte(metricCheckpoints.expectedAt, new Date(now.getTime() + ACCOUNT_LOOKAHEAD_MS)),
      ),
    )
    .limit(1000);
  if (!due.length) return 0;
  const accounts = await loadAccounts(app.db, workspaceId, due.map((d) => d.accountId));
  let sent = 0;
  for (const cp of due) {
    const acc = accounts.get(cp.accountId);
    const recipient = cp.assigneeMembershipId ?? acc?.ownerMembershipId ?? null;
    if (!recipient) continue;
    sent += await notify(app.db, {
      workspaceId,
      recipientMembershipIds: [recipient],
      eventType: 'metric.checkpoint_due',
      eventKey: `metric.checkpoint_due:${cp.id}`,
      kind: 'due_reminder',
      title: 'Metrics update needed',
      excerpt: `${acc?.label ?? 'Account'} · ${checkpointLabel(cp.checkpointKey, policy.config)}`,
      entityType: 'metric_checkpoint',
      entityId: cp.id,
      projectId: cp.projectId,
      at: now,
      excludeActor: false,
    });
  }
  return sent;
};

/** Scheduled maintenance: account snapshot checkpoints and due notifications in every workspace. */
export const runCheckpointMaintenance = async (app: AppServices) => {
  const wss = await app.db.select({ id: workspaces.id }).from(workspaces);
  let created = 0;
  let notified = 0;
  for (const w of wss) {
    const ctxLike = { app, actor: { workspaceId: w.id } } as unknown as QueryContext;
    const policy = await activePolicy(ctxLike);
    created += await generateAccountCheckpoints(app, w.id, policy);
    notified += await notifyDueCheckpoints(app, w.id, policy);
  }
  return { created, notified };
};

// ——— Account / publication metrics tabs ———

const defaultRange = (ctx: Ctx, from?: string, to?: string) => {
  const zone = ctx.actor.timezone;
  const today = DateTime.fromJSDate(ctx.app.clock.now(), { zone }).startOf('day');
  const toDate = to ?? today.toISODate()!;
  const fromDate = from ?? today.minus({ days: 89 }).toISODate()!;
  if (fromDate > toDate) throw new AppError('VALIDATION_FAILED', 'The period must end on or after its start.', { fieldErrors: [{ field: 'to', code: 'INVALID_PERIOD', message: 'The period must end on or after its start.' }] });
  return {
    fromDate,
    toDate,
    start: DateTime.fromISO(fromDate, { zone }).startOf('day').toUTC().toJSDate(),
    end: DateTime.fromISO(toDate, { zone }).startOf('day').plus({ days: 1 }).toUTC().toJSDate(),
  };
};

/** Account Detail → Metrics (S20): follower snapshots chart + table, period results, freshness. */
export const accountMetrics = async (ctx: QueryContext, accountId: string, input: { from?: string; to?: string }) => {
  const acc = (await loadAccounts(ctx.app.db, ctx.actor.workspaceId, [accountId])).get(accountId);
  if (!acc) throw notFound('Account');
  const scope = { objectType: 'account', objectId: acc.id, projectId: acc.projectId, accountId: acc.id };
  authorizeRead(ctx, 'metrics.read', scope);
  const range = defaultRange(ctx, input.from, input.to);
  const o = metricObservations;
  const db = ctx.app.db;
  const ws = ctx.actor.workspaceId;
  const inRange = and(sql`${o.observedAt} >= ${range.start}`, sql`${o.observedAt} < ${range.end}`);
  const [followerRows, snapshots, periods, fresh, openCps, entities] = await all(ctx, [
    () =>
      db
        .select({ id: o.id, observedAt: o.observedAt, segment: o.segment, ns: o.sourceNamespace, availability: metricValues.availability, value: metricValues.value })
        .from(o)
        .innerJoin(metricValues, and(eq(metricValues.observationId, o.id), eq(metricValues.metricKey, 'account.followers')))
        .where(and(eq(o.workspaceId, ws), eq(o.entityType, 'account'), eq(o.entityId, accountId), eq(o.kind, 'snapshot'), eq(o.canonical, true), activeObservation(), inRange))
        .orderBy(asc(o.observedAt)),
    () => db.select().from(o).where(and(eq(o.workspaceId, ws), eq(o.accountId, accountId), eq(o.kind, 'snapshot'), activeObservation(), inRange)).orderBy(desc(o.observedAt)).limit(50),
    () => db.select().from(o).where(and(eq(o.workspaceId, ws), eq(o.accountId, accountId), eq(o.kind, 'period'), activeObservation(), inRange)).orderBy(desc(o.observedAt)).limit(50),
    () =>
      db
        .select({ observed: max(o.observedAt), entered: max(o.enteredAt) })
        .from(o)
        .where(and(eq(o.workspaceId, ws), eq(o.accountId, accountId), activeObservation(), sql`${o.entityType} <> 'publication'`)),
    () =>
      db
        .select()
        .from(metricCheckpoints)
        .where(and(eq(metricCheckpoints.workspaceId, ws), eq(metricCheckpoints.entityType, 'account'), eq(metricCheckpoints.entityId, accountId), eq(metricCheckpoints.state, 'pending')))
        .orderBy(asc(metricCheckpoints.expectedAt))
        .limit(10),
    () => loadEntities(ctx, [{ type: 'account', id: accountId }]),
  ] as const);
  // Totals only: organic/paid segment breakdowns are never mixed with combined totals.
  const totals = followerRows.filter((r) => r.segment === 'unknown' || r.segment === 'combined');
  const known = totals.filter((r) => r.availability === 'known' && r.value !== null).map((r) => ({ observedAt: r.observedAt, value: r.value! }));
  const change = snapshotChange(known);
  const now = ctx.app.clock.now();
  const ent = entities.get(`account:${accountId}`)!;
  return {
    account: { id: acc.id, label: acc.label, platform: acc.platform, projectId: acc.projectId, metricsCadence: acc.metricsCadence, ofm: ent?.ofm ?? false },
    fromDate: range.fromDate,
    toDate: range.toDate,
    followers: {
      points: followerRows.map((r) => ({ observationId: r.id, observedAt: r.observedAt.toISOString(), availability: r.availability, value: plainDecimal(r.value), segment: r.segment, sourceNamespace: r.ns })),
      change: change.change,
      growth: change.growth,
      first: change.first ? { observedAt: change.first.observedAt.toISOString(), value: plainDecimal(change.first.value)! } : null,
      last: change.last ? { observedAt: change.last.observedAt.toISOString(), value: plainDecimal(change.last.value)! } : null,
    },
    snapshots: await toObservationSummaries(ctx, snapshots),
    periodObservations: await toObservationSummaries(ctx, periods),
    freshness: {
      lastObservedAt: iso(fresh[0]?.observed),
      lastEnteredAt: iso(fresh[0]?.entered),
      nextExpectedAt: iso(openCps.find((c) => c.expectedAt.getTime() >= now.getTime())?.expectedAt ?? openCps[0]?.expectedAt),
      overdue: openCps.some((c) => c.windowEnd.getTime() < now.getTime()),
    },
    checkpoints: await toCheckpointRows(ctx, openCps),
    permissions: { addMetrics: allowed(ctx, 'metrics.write', scope) },
  };
};

export const publicationMetrics = async (ctx: QueryContext, publicationId: string) => {
  const ent = (await loadEntities(ctx, [{ type: 'publication', id: publicationId }])).get(`publication:${publicationId}`);
  if (!ent) throw notFound('Publication');
  const scope = entityScope(ent);
  authorizeRead(ctx, 'metrics.read', scope);
  const db = ctx.app.db;
  const ws = ctx.actor.workspaceId;
  const [cps, obs] = await all(ctx, [
    () => db.select().from(metricCheckpoints).where(and(eq(metricCheckpoints.workspaceId, ws), eq(metricCheckpoints.publicationId, publicationId))).orderBy(asc(metricCheckpoints.expectedAt)),
    () => db.select().from(metricObservations).where(and(eq(metricObservations.workspaceId, ws), eq(metricObservations.publicationId, publicationId), activeObservation())).orderBy(desc(metricObservations.observedAt)).limit(100),
  ] as const);
  return { checkpoints: await toCheckpointRows(ctx, cps), observations: await toObservationSummaries(ctx, obs), permissions: { addMetrics: allowed(ctx, 'metrics.write', scope) } };
};

/** Content Detail → Results: each published placement with its checkpoints and latest cumulative values. */
export const contentResults = async (ctx: QueryContext, contentItemId: string) => {
  requirePermission(ctx, 'metrics.read');
  const db = ctx.app.db;
  const ws = ctx.actor.workspaceId;
  const [item] = await db.select({ id: contentItems.id, projectId: contentItems.projectId }).from(contentItems).where(and(eq(contentItems.workspaceId, ws), eq(contentItems.id, contentItemId)));
  if (!item) throw notFound('Content');
  const pubs = await db
    .select({ id: publications.id, accountId: publications.accountId, projectId: publications.projectId, publishedAt: publications.actualPublishedAt })
    .from(publications)
    .where(and(eq(publications.workspaceId, ws), eq(publications.contentItemId, contentItemId), eq(publications.status, 'published'), sql`${publications.deletedAt} IS NULL`))
    .orderBy(desc(publications.actualPublishedAt));
  const visible = pubs.filter((p) => allowed(ctx, 'metrics.read', { projectId: p.projectId, accountId: p.accountId }));
  if (!visible.length && pubs.length) authorizeRead(ctx, 'metrics.read', { projectId: item.projectId });
  const ids = visible.map((p) => p.id);
  const [entities, cps, obs] = ids.length
    ? await all(ctx, [
        () => loadEntities(ctx, ids.map((id) => ({ type: 'publication' as const, id }))),
        () => db.select().from(metricCheckpoints).where(and(eq(metricCheckpoints.workspaceId, ws), inArray(metricCheckpoints.publicationId, ids))).orderBy(asc(metricCheckpoints.expectedAt)),
        () =>
          db
            .select()
            .from(metricObservations)
            .where(and(eq(metricObservations.workspaceId, ws), inArray(metricObservations.publicationId, ids), eq(metricObservations.canonical, true), activeObservation()))
            .orderBy(desc(metricObservations.observedAt)),
      ] as const)
    : [new Map(), [], []] as const;
  const latestIds = new Map<string, (typeof obs)[number]>();
  for (const o of obs) if (o.publicationId && !latestIds.has(o.publicationId)) latestIds.set(o.publicationId, o);
  const [cpRows, latest] = [await toCheckpointRows(ctx, [...cps]), await toObservationSummaries(ctx, [...latestIds.values()])];
  return {
    placements: visible
      .map((p) => {
        const e = entities.get(`publication:${p.id}`);
        if (!e) return null;
        return {
          publication: entityRefOf(e),
          publishedAt: iso(p.publishedAt),
          checkpoints: cpRows.filter((c) => c.entity.publicationId === p.id),
          latest: latest.find((o) => o.entity.publicationId === p.id) ?? null,
          addMetrics: allowed(ctx, 'metrics.write', { projectId: p.projectId, accountId: p.accountId }),
        };
      })
      .filter((x): x is NonNullable<typeof x> => !!x),
    hidden: pubs.length - visible.length,
  };
};
