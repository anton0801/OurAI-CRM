import { and, desc, eq, gte, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { can } from '@castlane/authorization';
import { automationActionEffects, automationRules, automationRuleVersions, automationRuns, incidents, workspaces, type DbOrTx } from '@castlane/database';
import {
  AppError,
  AUTOMATION_LIMITS,
  AUTOMATION_RETRY_DELAYS_SECONDS,
  automationChainVerdict,
  automationThrottleUntil,
  clampPageSize,
  decodeCursor,
  encodeCursor,
  evaluateAutomationConditions,
  newId,
  nextAutomationSlot,
  OPERATOR_LABELS,
  uuidFromHex,
  type AutomationChainVerdict,
} from '@castlane/domain';
import { entityHref, type AutomationRunRow } from '@castlane/api-contracts';
import { audit } from '../core/audit';
import { executeSystemCommand } from '../core/command';
import { sha256 } from '../core/crypto';
import { all, dbOf, type AppServices, type CommandContext, type QueryContext } from '../core/context';
import { emit } from '../core/events';
import { enqueueJob } from '../core/jobs';
import { defineConsumer, defineJob, defineSchedule, systemJobContext, type OutboxEventRecord } from '../core/jobs-registry';
import { notify } from '../core/notify';
import { assertVersion, lockById, stamp, touch } from '../core/rows';
import { plannedEffects, runAutomationActions } from './actions';
import { ALL_TRIGGER_EVENT_TYPES, triggerDef, triggersForEvent } from './catalog';
import { authorityGaps, describeGaps, rulePrincipal } from './principal';
import { loadAutomationRecord, recordInRuleScope } from './records';
import { configOfVersion, pauseAutomationRule, ruleAuthScope, type AutomationRuleRowDb } from './rules';

/**
 * Automation runtime (§19). Event triggers arrive through the transactional outbox (consumer →
 * run row keyed by event + rule version → job); deadline and schedule triggers are found by a
 * periodic tick with deadline keys (entity + deadline revision + threshold). A run executes as
 * the rule principal (owner ∩ scope), checks the causation chain (depth ≤ 5, no self-repeat,
 * ≤ 50 created tasks/notifications per root event) and the hourly rate, then performs its actions
 * with idempotent effect keys.
 */

type RunRow = typeof automationRuns.$inferSelect;

const REVALIDATE_EVENTS = ['member.access_changed', 'member.deactivated', 'member.suspended', 'project.member_ended', 'account.assignment_ended', 'role.updated', 'project.direction_transferred'];

export interface NewRunInput {
  workspaceId: string;
  ruleId: string;
  ruleVersionId: string;
  eventId: string;
  rootEventId: string;
  depth: number;
  operationKey: string;
  triggerEvent: string;
  entityType: string | null;
  entityId: string | null;
  eventPayload?: Record<string, unknown>;
  at: Date;
}

/** Insert a run once per operation key and queue its execution (at-least-once safe). */
export const createAutomationRun = async (db: DbOrTx, input: NewRunInput): Promise<string | null> => {
  const id = newId();
  const inserted = await db
    .insert(automationRuns)
    .values({
      id,
      workspaceId: input.workspaceId,
      createdAt: input.at,
      updatedAt: input.at,
      rowVersion: 1,
      ruleId: input.ruleId,
      ruleVersionId: input.ruleVersionId,
      eventId: input.eventId,
      rootEventId: input.rootEventId,
      depth: input.depth,
      operationKey: input.operationKey,
      state: 'pending',
      triggerEvent: input.triggerEvent,
      entityType: input.entityType,
      entityId: input.entityId,
      eventPayload: input.eventPayload ?? {},
    })
    .onConflictDoNothing()
    .returning({ id: automationRuns.id });
  if (!inserted.length) return null;
  await enqueueJob(db, {
    type: 'automation.run',
    workspaceId: input.workspaceId,
    payload: { runId: id },
    idempotencyKey: `automation.run:${id}:0`,
    causation: { rootEventId: input.rootEventId, parentEventId: input.eventId, depth: input.depth },
  });
  return id;
};

const enabledRules = async (db: DbOrTx, ws: string, triggerKeys?: string[]) =>
  db
    .select({ rule: automationRules, version: automationRuleVersions })
    .from(automationRules)
    .innerJoin(automationRuleVersions, eq(automationRuleVersions.id, automationRules.enabledVersionId))
    .where(
      and(
        eq(automationRules.workspaceId, ws),
        eq(automationRules.state, 'enabled'),
        isNull(automationRules.archivedAt),
        triggerKeys ? inArray(sql`${automationRuleVersions.trigger}->>'event'`, triggerKeys) : undefined,
      ),
    );

// ——— Event triggers (outbox consumer) ———

export const dispatchAutomationEvent = async (tx: DbOrTx, e: OutboxEventRecord, app: AppServices) => {
  if (!e.workspaceId) return;
  if (REVALIDATE_EVENTS.includes(e.eventType)) {
    await enqueueJob(tx, { type: 'automation.revalidate', workspaceId: e.workspaceId, payload: { reason: e.eventType }, idempotencyKey: `automation.revalidate:${e.id}` });
    return;
  }
  const defs = triggersForEvent(e.eventType);
  if (!defs.length) return;
  const rules = await enabledRules(tx, e.workspaceId, defs.map((d) => d.key));
  for (const { rule, version } of rules) {
    const def = triggerDef(version.trigger.event);
    if (!def?.entityType || !def.entityFromEvent) continue;
    const entityId = await def.entityFromEvent(tx, e);
    if (!entityId) continue;
    const record = await loadAutomationRecord(tx, e.workspaceId, def.entityType, entityId, app.clock.now(), e.payload);
    if (!record || !recordInRuleScope(rule, record)) continue;
    await createAutomationRun(tx, {
      workspaceId: e.workspaceId,
      ruleId: rule.id,
      ruleVersionId: version.id,
      eventId: e.id,
      rootEventId: e.rootEventId,
      depth: e.depth,
      operationKey: `event:${e.id}:${version.id}`,
      triggerEvent: def.key,
      entityType: def.entityType,
      entityId,
      eventPayload: e.payload,
      at: app.clock.now(),
    });
  }
};

defineConsumer({ name: 'automation.dispatch', events: [...ALL_TRIGGER_EVENT_TYPES, ...REVALIDATE_EVENTS], handle: dispatchAutomationEvent });

// ——— Run execution ———

const conditionSummary = (results: ReturnType<typeof evaluateAutomationConditions>['results'], labels: Map<string, string>) =>
  results
    .filter((r) => !r.passed)
    .map((r) => `${labels.get(r.field) ?? r.field} ${OPERATOR_LABELS[r.operator]} ${Array.isArray(r.expected) ? r.expected.join(', ') : String(r.expected)}${r.reason ? ` (${r.reason})` : ''}`)
    .join('; ');

const CHAIN_LABEL: Record<Exclude<AutomationChainVerdict, { ok: true }>['code'], string> = {
  DEPTH_LIMIT: 'causation depth limit reached',
  RECURSION: 'the rule tried to trigger itself',
  BUDGET_EXCEEDED: 'action budget exceeded',
};

/** T141: stop + alert (system incident deduplicated per rule and root event, Inbox for the owner). */
const raiseChainAlert = async (c: CommandContext, rule: AutomationRuleRowDb, run: RunRow, v: Exclude<AutomationChainVerdict, { ok: true }>) => {
  const now = c.app.clock.now();
  await c.tx
    .insert(incidents)
    .values({
      ...stamp(c),
      id: newId(),
      kind: 'system',
      severity: v.code === 'RECURSION' ? 'medium' : 'high',
      title: `Automation “${rule.name}” stopped: ${CHAIN_LABEL[v.code]}`.slice(0, 200),
      description: `${v.message} Root event ${run.rootEventId}, depth ${run.depth}. No further actions were created for this chain.`,
      state: 'open',
      alertKey: `automation.chain:${rule.id}:${run.rootEventId}:${v.code}`,
    })
    .onConflictDoNothing();
  await audit(c, { action: 'automation.chain_stopped', entityType: 'automation_rule', entityId: rule.id, metadata: { runId: run.id, code: v.code, rootEventId: run.rootEventId, depth: run.depth } });
  if (rule.ownerMembershipId)
    await notify(c.tx, {
      workspaceId: rule.workspaceId,
      recipientMembershipIds: [rule.ownerMembershipId],
      eventType: 'automation.chain_stopped',
      eventKey: `automation.chain_stopped:${rule.id}:${run.rootEventId}:${v.code}`,
      kind: 'general',
      title: `Automation “${rule.name}” was stopped: ${CHAIN_LABEL[v.code]}`,
      excerpt: v.message,
      entityType: 'automation_rule',
      entityId: rule.id,
      excludeActor: false,
      at: now,
    });
};

export const effectsInChain = async (db: DbOrTx, ws: string, rootEventId: string) => {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(automationActionEffects)
    .innerJoin(automationRuns, eq(automationRuns.id, automationActionEffects.runId))
    .where(and(eq(automationActionEffects.workspaceId, ws), eq(automationRuns.rootEventId, rootEventId), inArray(automationActionEffects.entityType, ['task', 'notification'])));
  return Number(r?.n ?? 0);
};

const workspaceZone = async (db: DbOrTx, ws: string) => (await db.select({ tz: workspaces.timezone }).from(workspaces).where(eq(workspaces.id, ws)))[0]?.tz ?? 'UTC';

/** Execute one run (idempotent: only pending/throttled runs do anything). */
export const executeAutomationRun = async (app: AppServices, workspaceId: string, runId: string) => {
  const sys = await systemJobContext(app, workspaceId, ['automations.read']);
  return executeSystemCommand(sys, async (c) => {
    const now = c.app.clock.now();
    const [run] = await c.tx.select().from(automationRuns).where(and(eq(automationRuns.workspaceId, workspaceId), eq(automationRuns.id, runId))).for('update');
    if (!run || (run.state !== 'pending' && run.state !== 'throttled')) return { runId, state: run?.state ?? 'missing', executed: false };
    if (run.notBefore && run.notBefore.getTime() > now.getTime()) return { runId, state: run.state, executed: false };
    const finish = async (state: RunRow['state'], code: string | null, message: string | null, results: RunRow['actionResults'] = []) => {
      await c.tx
        .update(automationRuns)
        .set({ state, errorCode: code, errorMessage: message?.slice(0, 1000) ?? null, actionResults: results, finishedAt: now, notBefore: null, attempts: run.attempts + 1, ...touch(c, automationRuns) })
        .where(eq(automationRuns.id, run.id));
      return { runId, state, executed: state === 'succeeded' || state === 'failed', code };
    };
    const [rule] = await c.tx.select().from(automationRules).where(and(eq(automationRules.workspaceId, workspaceId), eq(automationRules.id, run.ruleId))).for('update');
    if (!rule || rule.archivedAt) return finish('skipped', 'RULE_ARCHIVED', 'The rule was archived before this run started.');
    if (rule.state !== 'enabled') return finish('skipped', rule.state === 'disabled' ? 'RULE_DISABLED' : 'RULE_PAUSED', 'The rule is not enabled.');
    // A run is bound to the version that matched its event (operation and effect keys include it). If another
    // version was enabled since, the old configuration is not replayed and the new one never matched this
    // event: the run is skipped (safe side), never executed with a stale or a different configuration.
    if (rule.enabledVersionId !== run.ruleVersionId)
      return finish('skipped', 'VERSION_CHANGED', 'Another version of the rule was enabled after this run was queued. The run was not executed.');
    const [version] = await c.tx.select().from(automationRuleVersions).where(eq(automationRuleVersions.id, run.ruleVersionId));
    const def = version ? triggerDef(version.trigger.event) : undefined;
    if (!version || !def) return finish('failed', 'INVALID_RULE', 'The rule version or its trigger is no longer available.');
    const config = configOfVersion(version);

    // Execution principal: the owner's current rights, narrowed to the rule scope (T142).
    const p = await rulePrincipal(c.app, rule, { causation: { rootEventId: run.rootEventId, parentEventId: run.eventId, depth: run.depth }, db: c.tx });
    if (!p.ok) {
      const msg = p.problem === 'needs_owner' ? 'Needs Owner: the rule has no owner.' : 'Needs Owner: the rule owner is no longer an active member.';
      const out = await finish('skipped', 'NEEDS_OWNER', msg);
      await pauseAutomationRule(c, rule.id, 'paused_needs_owner', msg);
      return out;
    }
    const gaps = await authorityGaps(c.tx, workspaceId, rule, config, p.ownerAccess);
    if (gaps.length) {
      const msg = `The owner no longer holds ${describeGaps(gaps)} in the rule scope. Nothing was done.`;
      const out = await finish('failed', 'OWNER_ACCESS', msg);
      await pauseAutomationRule(c, rule.id, 'paused_requires_attention', msg);
      return out;
    }
    let record = null;
    if (def.entityType) {
      if (!run.entityType || !run.entityId) return finish('failed', 'INVALID_RULE', 'The run has no triggering record.');
      record = await loadAutomationRecord(c.tx, workspaceId, run.entityType, run.entityId, now, run.eventPayload);
      if (!record) return finish('skipped', 'RECORD_NOT_FOUND', 'The triggering record no longer exists.');
      if (!recordInRuleScope(rule, record)) return finish('skipped', 'OUT_OF_SCOPE', 'The record is no longer inside the rule scope.');
      if (!can(p.ctx.actor.access, record.readPermission, record.scope)) {
        const msg = 'The owner can no longer open the triggering record. Nothing was done.';
        const out = await finish('failed', 'OWNER_ACCESS', msg);
        await pauseAutomationRule(c, rule.id, 'paused_requires_attention', msg);
        return out;
      }
    }

    // Causation chain (T141).
    const [prior] = await c.tx
      .select({ id: automationRuns.id })
      .from(automationRuns)
      .where(and(eq(automationRuns.workspaceId, workspaceId), eq(automationRuns.rootEventId, run.rootEventId), eq(automationRuns.ruleId, rule.id), ne(automationRuns.id, run.id), inArray(automationRuns.state, ['running', 'succeeded', 'failed', 'dead'])))
      .limit(1);
    const verdict = automationChainVerdict({
      depth: run.depth,
      ruleAlreadyInChain: !!prior,
      effectsInChain: await effectsInChain(c.tx, workspaceId, run.rootEventId),
      plannedEffects: await plannedEffects(c.tx, workspaceId, config),
    });
    if (!verdict.ok) {
      const out = await finish(verdict.code === 'RECURSION' ? 'skipped' : 'failed', verdict.code, verdict.message);
      await raiseChainAlert(c, rule, run, verdict);
      return out;
    }

    // Hourly rate: excess runs wait; the event is not dropped.
    const recent = await c.tx
      .select({ startedAt: automationRuns.startedAt })
      .from(automationRuns)
      .where(and(eq(automationRuns.workspaceId, workspaceId), eq(automationRuns.ruleId, rule.id), gte(automationRuns.startedAt, new Date(now.getTime() - 3_600_000)), ne(automationRuns.id, run.id)));
    const until = automationThrottleUntil(recent.map((r) => r.startedAt!).filter(Boolean), now);
    if (until) {
      await c.tx.update(automationRuns).set({ state: 'throttled', notBefore: until, ...touch(c, automationRuns) }).where(eq(automationRuns.id, run.id));
      await enqueueJob(c.tx, { type: 'automation.run', workspaceId, payload: { runId }, runAt: until, idempotencyKey: `automation.run:${runId}:throttled:${until.toISOString()}` });
      return { runId, state: 'throttled', executed: false, until: until.toISOString() };
    }

    const evaluation = evaluateAutomationConditions(config.conditions, record?.facts ?? {}, def.fields, now);
    if (!evaluation.matched) return finish('skipped', 'CONDITIONS_NOT_MET', `Conditions not met: ${conditionSummary(evaluation.results, new Map(def.fields.map((f) => [f.key, f.label])))}`);

    await c.tx.update(automationRuns).set({ state: 'running', startedAt: now }).where(eq(automationRuns.id, run.id));
    const pc: CommandContext = { ...p.ctx, tx: c.tx, emitted: c.emitted };
    const results = await runAutomationActions(pc, {
      rule,
      config,
      trigger: def,
      record,
      effectBase: `${run.eventId}:${run.ruleVersionId}`,
      runId: run.id,
      zone: await workspaceZone(c.tx, workspaceId),
      now,
      dryRun: false,
    });
    const failed = results.filter((r) => !r.ok);
    const authFailure = results.some((r) => r.authFailure);
    const out = await finish(
      failed.length ? 'failed' : 'succeeded',
      failed.length ? (authFailure ? 'OWNER_ACCESS' : 'ACTION_FAILED') : null,
      failed.length ? failed.map((f) => `Action ${f.index + 1} (${f.type}): ${f.error}`).join(' ') : null,
      results.map((r) => ({ index: r.index, type: r.type, ok: r.ok, skipped: r.skipped, entityType: r.entityType ?? undefined, entityId: r.entityId ?? undefined, error: r.error ?? undefined, note: r.note ?? undefined, effects: r.effects })),
    );
    const [ruleRow] = await c.tx
      .update(automationRules)
      .set({ lastRunAt: now, failureCount: failed.length ? rule.failureCount + 1 : 0 })
      .where(eq(automationRules.id, rule.id))
      .returning();
    if (authFailure) await pauseAutomationRule(c, rule.id, 'paused_requires_attention', 'The owner’s rights were refused for an action. Nothing further was done.');
    await emit(c, { type: 'automation_rule.run_finished', entityType: 'automation_rule', entityId: rule.id, revision: ruleRow!.rowVersion, payload: { runId: run.id, state: out.state } });
    return out;
  });
};

/** Record a transient failure on the run (the job retries with 30 s, 2 min, 10 min, 30 min, 2 h). */
const recordAttemptFailure = async (app: AppServices, workspaceId: string, runId: string, error: unknown, attempt: number) => {
  const exhausted = attempt > AUTOMATION_RETRY_DELAYS_SECONDS.length; // 1 attempt + 5 retries
  await app.db
    .update(automationRuns)
    .set({
      state: exhausted ? 'dead' : 'pending',
      errorCode: exhausted ? 'RETRIES_EXHAUSTED' : 'TRANSIENT',
      errorMessage: `Attempt ${attempt} failed: ${((error as Error).message ?? 'error').slice(0, 400)}`,
      attempts: attempt,
      finishedAt: exhausted ? app.clock.now() : null,
      updatedAt: app.clock.now(),
    })
    .where(and(eq(automationRuns.workspaceId, workspaceId), eq(automationRuns.id, runId), inArray(automationRuns.state, ['pending', 'running', 'throttled'])));
};

defineJob('automation.run', 'light', async ({ app, job }) => {
  if (!job.workspaceId) return { skipped: true };
  const runId = String(job.payload.runId);
  try {
    return await executeAutomationRun(app, job.workspaceId, runId);
  } catch (e) {
    await recordAttemptFailure(app, job.workspaceId, runId, e, job.attempts);
    throw e;
  }
});

// ——— Deadline and schedule triggers ———

const deterministicEventId = (key: string) => uuidFromHex(sha256(key));

/** Causation of a record created by an earlier automation effect (chains through deadline triggers). */
const causationOfEntity = async (db: DbOrTx, ws: string, entityId: string) => {
  const [r] = await db
    .select({ rootEventId: automationRuns.rootEventId, depth: automationRuns.depth, eventId: automationRuns.eventId })
    .from(automationActionEffects)
    .innerJoin(automationRuns, eq(automationRuns.id, automationActionEffects.runId))
    .where(and(eq(automationActionEffects.workspaceId, ws), eq(automationActionEffects.entityId, entityId)))
    .orderBy(desc(automationRuns.depth))
    .limit(1);
  return r ?? null;
};

export const scanRuleDeadlines = async (app: AppServices, rule: AutomationRuleRowDb, version: typeof automationRuleVersions.$inferSelect) => {
  const def = triggerDef(version.trigger.event);
  if (!def?.scan || !def.entityType) return 0;
  const now = app.clock.now();
  const threshold = version.trigger.thresholdHours ?? def.defaultThresholdHours ?? 0;
  const candidates = await def.scan(app.db, rule.workspaceId, rule, threshold, now, AUTOMATION_LIMITS.deadlineScanBatch * 10);
  let created = 0;
  for (let i = 0; i < candidates.length && created < AUTOMATION_LIMITS.deadlineScanBatch; i += 100) {
    const page = candidates.slice(i, i + 100).map((cand) => ({ ...cand, operationKey: `deadline:${version.id}:${cand.deadlineKey}` }));
    const existing = await app.db
      .select({ key: automationRuns.operationKey })
      .from(automationRuns)
      .where(and(eq(automationRuns.workspaceId, rule.workspaceId), inArray(automationRuns.operationKey, page.map((p) => p.operationKey))));
    const known = new Set(existing.map((e) => e.key));
    for (const cand of page) {
      if (known.has(cand.operationKey) || created >= AUTOMATION_LIMITS.deadlineScanBatch) continue;
      const eventId = deterministicEventId(cand.operationKey);
      const origin = await causationOfEntity(app.db, rule.workspaceId, cand.entityId);
      const id = await createAutomationRun(app.db, {
        workspaceId: rule.workspaceId,
        ruleId: rule.id,
        ruleVersionId: version.id,
        eventId,
        rootEventId: origin?.rootEventId ?? eventId,
        depth: origin ? origin.depth + 1 : 0,
        operationKey: cand.operationKey,
        triggerEvent: def.key,
        entityType: def.entityType,
        entityId: cand.entityId,
        at: now,
      });
      if (id) created++;
    }
  }
  return created;
};

export const runScheduledRule = async (app: AppServices, rule: AutomationRuleRowDb, version: typeof automationRuleVersions.$inferSelect) => {
  const schedule = version.trigger.schedule;
  if (!schedule) return false;
  const now = app.clock.now();
  const zone = await workspaceZone(app.db, rule.workspaceId);
  if (!rule.nextScheduledAt) {
    await app.db.update(automationRules).set({ nextScheduledAt: nextAutomationSlot(schedule, zone, now) }).where(eq(automationRules.id, rule.id));
    return false;
  }
  if (rule.nextScheduledAt.getTime() > now.getTime()) return false;
  const slot = rule.nextScheduledAt;
  // Only the latest missed slot runs (no burst of missed runs after downtime).
  const moved = await app.db
    .update(automationRules)
    .set({ nextScheduledAt: nextAutomationSlot(schedule, zone, now) })
    .where(and(eq(automationRules.id, rule.id), eq(automationRules.nextScheduledAt, slot)))
    .returning({ id: automationRules.id });
  if (!moved.length) return false;
  const operationKey = `schedule:${version.id}:${slot.toISOString()}`;
  const eventId = deterministicEventId(operationKey);
  return !!(await createAutomationRun(app.db, {
    workspaceId: rule.workspaceId,
    ruleId: rule.id,
    ruleVersionId: version.id,
    eventId,
    rootEventId: eventId,
    depth: 0,
    operationKey,
    triggerEvent: version.trigger.event,
    entityType: null,
    entityId: null,
    at: now,
  }));
};

/** One pass over enabled deadline/schedule rules of every workspace. */
export const runAutomationTick = async (app: AppServices, opts: { workspaceId?: string } = {}) => {
  const rows = await app.db
    .select({ rule: automationRules, version: automationRuleVersions })
    .from(automationRules)
    .innerJoin(automationRuleVersions, eq(automationRuleVersions.id, automationRules.enabledVersionId))
    .where(
      and(
        eq(automationRules.state, 'enabled'),
        isNull(automationRules.archivedAt),
        opts.workspaceId ? eq(automationRules.workspaceId, opts.workspaceId) : undefined,
        or(sql`${automationRuleVersions.trigger}->>'event' LIKE 'schedule.%'`, inArray(sql`${automationRuleVersions.trigger}->>'event'`, ['task.due_soon', 'task.overdue', 'checkpoint.due', 'checkpoint.overdue', 'shift.report_overdue', 'account.metrics_stale'])),
      ),
    );
  let runs = 0;
  for (const { rule, version } of rows) {
    const def = triggerDef(version.trigger.event);
    if (def?.kind === 'schedule') runs += (await runScheduledRule(app, rule, version)) ? 1 : 0;
    else if (def?.kind === 'deadline') runs += await scanRuleDeadlines(app, rule, version);
  }
  return { rules: rows.length, runs };
};

defineJob('automation.tick', 'light', async ({ app }) => runAutomationTick(app));
defineSchedule({ name: 'automation.tick', everySeconds: 60, jobType: 'automation.tick' });

// ——— Owner revalidation (T142, F12) ———

/** Pause enabled rules whose owner is gone or no longer covers the rule scope (no unauthorized action). */
export const revalidateAutomationRules = async (app: AppServices, workspaceId: string) => {
  const sys = await systemJobContext(app, workspaceId, ['automations.read']);
  const rules = await enabledRules(app.db, workspaceId);
  let paused = 0;
  for (const { rule, version } of rules) {
    const p = await rulePrincipal(app, rule);
    let target: { state: 'paused_needs_owner' | 'paused_requires_attention'; reason: string } | null = null;
    if (!p.ok) target = { state: 'paused_needs_owner', reason: p.problem === 'needs_owner' ? 'Needs Owner: the rule has no owner.' : 'Needs Owner: the rule owner is no longer an active member.' };
    else {
      const gaps = await authorityGaps(app.db, workspaceId, rule, configOfVersion(version), p.ownerAccess);
      if (gaps.length) target = { state: 'paused_requires_attention', reason: `The owner no longer holds ${describeGaps(gaps)} in the rule scope.` };
    }
    if (target && (await executeSystemCommand(sys, (c) => pauseAutomationRule(c, rule.id, target!.state, target!.reason)))) paused++;
  }
  return { rules: rules.length, paused };
};

defineJob('automation.revalidate', 'light', async ({ app, job }) => (job.workspaceId ? revalidateAutomationRules(app, job.workspaceId) : { skipped: true }));

// ——— Runs: read models and Retry ———

export const runRecordLabels = async (ctx: QueryContext | CommandContext, runs: Pick<RunRow, 'entityType' | 'entityId'>[]) => {
  const db = dbOf(ctx);
  const out = new Map<string, string>();
  const byType = new Map<string, string[]>();
  for (const r of runs) if (r.entityType && r.entityId) byType.set(r.entityType, [...(byType.get(r.entityType) ?? []), r.entityId]);
  for (const [type, ids] of byType) {
    const unique = [...new Set(ids)];
    for (const id of unique) {
      const rec = await loadAutomationRecord(db, ctx.actor.workspaceId, type, id, ctx.app.clock.now());
      if (rec) out.set(`${type}:${id}`, rec.label);
    }
  }
  return out;
};

const versionNumbers = async (ctx: QueryContext | CommandContext, runs: RunRow[]) => {
  const ids = [...new Set(runs.map((r) => r.ruleVersionId))];
  if (!ids.length) return new Map<string, number>();
  const rows = await dbOf(ctx).select({ id: automationRuleVersions.id, n: automationRuleVersions.versionNo }).from(automationRuleVersions).where(inArray(automationRuleVersions.id, ids));
  return new Map(rows.map((r) => [r.id, r.n]));
};

export const toAutomationRunRows = async (ctx: QueryContext | CommandContext, runs: RunRow[], canRetry: boolean): Promise<AutomationRunRow[]> => {
  const [labels, versions] = await all(ctx, [() => runRecordLabels(ctx, runs), () => versionNumbers(ctx, runs)] as const);
  const ws = ctx.actor.workspaceId;
  return runs.map((r) => ({
    id: r.id,
    ruleId: r.ruleId,
    ruleVersionId: r.ruleVersionId,
    versionNo: versions.get(r.ruleVersionId) ?? null,
    state: r.state,
    triggerEvent: r.triggerEvent,
    eventId: r.eventId,
    rootEventId: r.rootEventId,
    depth: r.depth,
    operationKey: r.operationKey,
    record:
      r.entityType && r.entityId
        ? { entityType: r.entityType, entityId: r.entityId, label: labels.get(`${r.entityType}:${r.entityId}`) ?? null, href: labels.has(`${r.entityType}:${r.entityId}`) ? entityHref(ws, r.entityType, r.entityId) : null }
        : null,
    attempts: r.attempts,
    startedAt: r.startedAt?.toISOString() ?? null,
    finishedAt: r.finishedAt?.toISOString() ?? null,
    notBefore: r.notBefore?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    errorCode: r.errorCode,
    errorMessage: r.errorMessage,
    actionResults: r.actionResults.map((a) => ({
      index: a.index,
      type: a.type,
      ok: a.ok,
      skipped: a.skipped,
      entityType: a.entityType ?? null,
      entityId: a.entityId ?? null,
      href: a.entityType && a.entityId ? entityHref(ws, a.entityType, a.entityId) : null,
      error: a.error ?? null,
      note: a.note ?? null,
      effects: a.effects,
    })),
    canRetry: canRetry && (r.state === 'failed' || r.state === 'dead'),
    rowVersion: r.rowVersion,
  }));
};

const readableRule = async (ctx: QueryContext | CommandContext, ruleId: string) => {
  const [rule] = await dbOf(ctx).select().from(automationRules).where(and(eq(automationRules.workspaceId, ctx.actor.workspaceId), eq(automationRules.id, ruleId)));
  if (!rule || !can(ctx.actor.access, 'automations.read', ruleAuthScope(rule))) throw new AppError('NOT_FOUND', 'Automation rule was not found.');
  return rule;
};

export const listAutomationRuns = async (ctx: QueryContext, ruleId: string, input: { cursor?: string; pageSize?: number; state?: RunRow['state'][] }) => {
  const rule = await readableRule(ctx, ruleId);
  const size = clampPageSize(input.pageSize);
  const c = input.cursor ? decodeCursor(input.cursor) : null;
  const rows = await ctx.app.db
    .select()
    .from(automationRuns)
    .where(
      and(
        eq(automationRuns.workspaceId, ctx.actor.workspaceId),
        eq(automationRuns.ruleId, ruleId),
        input.state?.length ? inArray(automationRuns.state, input.state) : undefined,
        c ? or(lt(automationRuns.createdAt, new Date(String(c.v[0]))), and(eq(automationRuns.createdAt, new Date(String(c.v[0]))), lt(automationRuns.id, c.id))) : undefined,
      ),
    )
    .orderBy(desc(automationRuns.createdAt), desc(automationRuns.id))
    .limit(size + 1);
  const hasMore = rows.length > size;
  const page = hasMore ? rows.slice(0, size) : rows;
  const last = page[page.length - 1];
  const canRetry = !rule.archivedAt && rule.state === 'enabled' && can(ctx.actor.access, 'automations.edit', ruleAuthScope(rule));
  return { items: await toAutomationRunRows(ctx, page, canRetry), hasMore, nextCursor: hasMore && last ? encodeCursor({ v: [last.createdAt.toISOString()], id: last.id }) : null };
};

export const getAutomationRun = async (ctx: QueryContext | CommandContext, runId: string) => {
  const [run] = await dbOf(ctx).select().from(automationRuns).where(and(eq(automationRuns.workspaceId, ctx.actor.workspaceId), eq(automationRuns.id, runId)));
  if (!run) throw new AppError('NOT_FOUND', 'Run was not found.');
  const rule = await readableRule(ctx, run.ruleId);
  const canRetry = !rule.archivedAt && rule.state === 'enabled' && can(ctx.actor.access, 'automations.edit', ruleAuthScope(rule));
  return (await toAutomationRunRows(ctx, [run], canRetry))[0]!;
};

/**
 * Retry Failed Run: the same operation key and effect keys are reused, so effects that already
 * happened are not repeated; the owner's access is re-checked when the run executes.
 */
export const retryAutomationRun = async (ctx: CommandContext, runId: string, input: { reason: string }) => {
  const run = await lockById(ctx, automationRuns, runId, 'Run');
  const rule = await readableRule(ctx, run.ruleId);
  if (!can(ctx.actor.access, 'automations.edit', ruleAuthScope(rule))) throw new AppError('FORBIDDEN', 'You cannot retry runs of this rule.');
  assertVersion(ctx, run);
  if (run.state !== 'failed' && run.state !== 'dead') throw new AppError('INVALID_STATE', 'Only failed runs can be retried.');
  if (rule.archivedAt || rule.state !== 'enabled') throw new AppError('INVALID_STATE', 'Enable the rule before retrying its runs.');
  if (rule.enabledVersionId !== run.ruleVersionId) throw new AppError('INVALID_STATE', 'This run belongs to a version of the rule that is no longer enabled, so it cannot be retried.');
  const [row] = await ctx.tx
    .update(automationRuns)
    .set({ state: 'pending', errorCode: null, errorMessage: null, finishedAt: null, startedAt: null, notBefore: null, ...touch(ctx, automationRuns) })
    .where(eq(automationRuns.id, runId))
    .returning();
  await enqueueJob(ctx.tx, {
    type: 'automation.run',
    workspaceId: ctx.actor.workspaceId,
    payload: { runId },
    idempotencyKey: `automation.run:${runId}:retry:${row!.rowVersion}`,
    causation: { rootEventId: run.rootEventId, parentEventId: run.eventId, depth: run.depth },
  });
  await audit(ctx, { action: 'automation.run_retried', entityType: 'automation_rule', entityId: rule.id, reason: input.reason, metadata: { runId, operationKey: run.operationKey } });
  await emit(ctx, { type: 'automation_rule.run_retried', entityType: 'automation_rule', entityId: rule.id, payload: { runId } });
  return runId;
};

void isNull;
