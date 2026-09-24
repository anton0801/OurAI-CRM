import { and, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { can } from '@castlane/authorization';
import {
  automationRules,
  automationRuleVersions,
  budgets,
  contentItems,
  deals,
  handovers,
  metricCheckpoints,
  publications,
  shifts,
  socialAccounts,
  tasks,
  workspaces,
} from '@castlane/database';
import { AppError, evaluateAutomationConditions, newId } from '@castlane/domain';
import type { AutomationDryRunResult, AutomationRuleConfig } from '@castlane/api-contracts';
import { allowed, scopePredicate } from '../core/access';
import { mapDbError } from '../core/command';
import type { CommandContext, QueryContext } from '../core/context';
import { dealVisibility } from '../partners/scope';
import { runAutomationActions } from './actions';
import { triggerDef, type TriggerDefinition } from './catalog';
import { authorityGaps, describeGaps, rulePrincipal } from './principal';
import { accountLabelOf, loadAutomationRecord, recordInRuleScope, type RuleScopeLike } from './records';
import { configOfVersion, ruleAuthScope, staticRuleErrors, validateRuleDraft } from './rules';

class DryRunRollback extends Error {
  constructor() {
    super('dry run rollback');
  }
}

const readRule = async (ctx: QueryContext, ruleId: string) => {
  const [rule] = await ctx.app.db.select().from(automationRules).where(and(eq(automationRules.workspaceId, ctx.actor.workspaceId), eq(automationRules.id, ruleId)));
  if (!rule || !can(ctx.actor.access, 'automations.read', ruleAuthScope(rule))) throw new AppError('NOT_FOUND', 'Automation rule was not found.');
  return rule;
};

/** Key-order-independent JSON (JSONB does not keep the key order of the submitted config). */
const canonicalJson = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : x));

/**
 * Dry Run (T139): conditions are evaluated purely; action previews run the real use cases as the
 * rule principal inside a transaction that is always rolled back — zero domain mutations, and
 * mail jobs never leave the transaction, so zero mail. No run or effect row is written.
 *
 * Any reader of the rule may dry-run its saved version. An unsaved configuration is a draft edit:
 * it needs automations.edit on the rule, passes the full rule validation, and the requester must
 * hold every permission it uses in the rule scope — the owner principal never previews for someone
 * actions they could not configure themselves.
 */
export const dryRunAutomationRule = async (ctx: QueryContext, ruleId: string, input: { sample: { entityType: string; entityId: string } | null; config?: AutomationRuleConfig }): Promise<AutomationDryRunResult> => {
  const rule = await readRule(ctx, ruleId);
  const [saved] = rule.currentVersionId ? await ctx.app.db.select().from(automationRuleVersions).where(eq(automationRuleVersions.id, rule.currentVersionId)) : [];
  const savedConfig = saved ? configOfVersion(saved) : null;
  const config = input.config ?? savedConfig;
  if (!config) throw new AppError('INVALID_STATE', 'The rule has no saved version.');
  const unsaved = !!input.config && !(savedConfig && canonicalJson(input.config) === canonicalJson(savedConfig));
  if (unsaved) {
    if (!allowed(ctx, 'automations.edit', ruleAuthScope(rule))) throw new AppError('FORBIDDEN', 'Only members who can edit this rule can dry-run unsaved changes. Run the saved version instead.');
    const v = await validateRuleDraft(ctx, { ownerMembershipId: rule.ownerMembershipId, scopeType: rule.scopeType, scopeId: rule.scopeId, config });
    if (v.errors.length) throw new AppError('VALIDATION_FAILED', 'Fix the rule before a dry run.', { fieldErrors: v.errors });
    const own = await authorityGaps(ctx.app.db, ctx.actor.workspaceId, rule, config, ctx.actor.access);
    if (own.length) throw new AppError('FORBIDDEN', `You lack ${describeGaps(own)} in the rule scope, so you cannot preview a configuration that uses it.`);
  } else {
    const check = staticRuleErrors(config);
    if (check.errors.length) throw new AppError('VALIDATION_FAILED', 'Fix the rule before a dry run.', { fieldErrors: check.errors });
  }
  const def = triggerDef(config.trigger.event)!;
  const now = ctx.app.clock.now();
  let record = null;
  if (def.entityType) {
    if (!input.sample) throw new AppError('VALIDATION_FAILED', 'Choose a sample record for the dry run.', { fieldErrors: [{ field: 'sample', code: 'REQUIRED', message: 'Choose a sample record.' }] });
    if (input.sample.entityType !== def.entityType) throw new AppError('VALIDATION_FAILED', 'The sample does not match the trigger.', { fieldErrors: [{ field: 'sample', code: 'MISMATCH', message: 'Choose a record of the trigger’s type.' }] });
    record = await loadAutomationRecord(ctx.app.db, ctx.actor.workspaceId, def.entityType, input.sample.entityId, now);
    // The requester must be able to open the sample (no existence leak).
    if (!record || !can(ctx.actor.access, record.readPermission, record.scope)) throw new AppError('NOT_FOUND', 'The sample record was not found.');
  }
  const labels = new Map(def.fields.map((f) => [f.key, f.label]));
  const evaluation = evaluateAutomationConditions(config.conditions, record?.facts ?? {}, def.fields, now);
  const blocked: string[] = [];
  if (record && !recordInRuleScope(rule, record)) blocked.push('The sample record is outside the rule scope, so the rule would not run for it.');
  const p = await rulePrincipal(ctx.app, rule, { causation: { rootEventId: newId(), parentEventId: null, depth: 0 } });
  let actions: AutomationDryRunResult['actions'] = [];
  if (!p.ok) blocked.push(p.problem === 'needs_owner' ? 'Needs Owner: assign an owner — the rule cannot run without one.' : 'Needs Owner: the owner is no longer an active member.');
  else {
    const gaps = await authorityGaps(ctx.app.db, ctx.actor.workspaceId, rule, config, p.ownerAccess);
    if (gaps.length) blocked.push(`The owner lacks ${describeGaps(gaps)} in the rule scope; the rule would pause as Requires Attention.`);
    const [ws] = await ctx.app.db.select({ tz: workspaces.timezone }).from(workspaces).where(eq(workspaces.id, ctx.actor.workspaceId));
    try {
      await ctx.app.db.transaction(async (tx) => {
        const pc: CommandContext = { ...p.ctx, tx, emitted: [] };
        const results = await runAutomationActions(pc, { rule, config, trigger: def, record, effectBase: `dryrun:${newId()}`, runId: null, zone: ws?.tz ?? 'UTC', now, dryRun: true });
        actions = results.map((r) => ({ index: r.index, type: r.type, ok: r.ok, preview: r.ok ? `${r.preview}${r.note ? ` ${r.note}` : ''}` : 'Would fail.', error: r.error ?? null }));
        throw new DryRunRollback();
      });
    } catch (e) {
      if (!(e instanceof DryRunRollback)) throw mapDbError(e);
    }
  }
  if (!evaluation.matched) blocked.push('Conditions are not met for this record, so no action would run.');
  return {
    record: record ? { entityType: record.entityType, entityId: record.entityId, label: record.label } : null,
    matched: evaluation.matched,
    blockedReason: blocked.length ? blocked.join(' ') : null,
    conditions: evaluation.results.map((r) => ({ index: r.index, field: r.field, label: labels.get(r.field) ?? r.field, operator: r.operator, expected: r.expected, actual: r.actual, passed: r.passed, reason: r.reason ?? null })),
    actions,
    rolledBack: true,
  };
};

const scopeFilter = (scope: RuleScopeLike, projectCol: SQL, accountCol?: SQL): SQL | undefined => {
  if (scope.scopeType === 'workspace' || !scope.scopeId) return undefined;
  if (scope.scopeType === 'project') return sql`${projectCol} = ${scope.scopeId}`;
  if (scope.scopeType === 'direction') return sql`${projectCol} IN (SELECT p.id FROM projects p WHERE p.direction_id = ${scope.scopeId})`;
  return accountCol ? sql`${accountCol} = ${scope.scopeId}` : sql`false`;
};

const like = (col: SQL, q?: string) => (q ? sql`${col} ILIKE ${`%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`}` : undefined);

/** Recent records a rule could run for: inside its scope and readable by the requester. */
export const automationDryRunSamples = async (ctx: QueryContext, ruleId: string, input: { trigger?: string; q?: string }) => {
  const rule = await readRule(ctx, ruleId);
  let def: TriggerDefinition | undefined = input.trigger ? triggerDef(input.trigger) : undefined;
  if (!def) {
    const [v] = rule.currentVersionId ? await ctx.app.db.select({ trigger: automationRuleVersions.trigger }).from(automationRuleVersions).where(eq(automationRuleVersions.id, rule.currentVersionId)) : [];
    def = v ? triggerDef(v.trigger.event) : undefined;
  }
  if (!def?.entityType) return [];
  const db = ctx.app.db;
  const ws = ctx.actor.workspaceId;
  const q = input.q?.trim() || undefined;
  const out: { entityType: string; entityId: string; label: string; at: string | null }[] = [];
  switch (def.entityType) {
    case 'task': {
      const rows = await db
        .select({ id: tasks.id, title: tasks.title, at: tasks.updatedAt })
        .from(tasks)
        .where(and(eq(tasks.workspaceId, ws), isNull(tasks.deletedAt), scopeFilter(rule, sql`${tasks.projectId}`, sql`${tasks.accountId}`), scopePredicate(ctx, 'tasks.read', { projectId: tasks.projectId, accountId: tasks.accountId, assigned: [tasks.assigneeMembershipId, tasks.reviewerMembershipId] }), like(sql`${tasks.title}`, q)))
        .orderBy(desc(tasks.updatedAt))
        .limit(10);
      for (const r of rows) out.push({ entityType: 'task', entityId: r.id, label: r.title, at: r.at.toISOString() });
      break;
    }
    case 'content_item': {
      const rows = await db
        .select({ id: contentItems.id, title: contentItems.title, at: contentItems.updatedAt })
        .from(contentItems)
        .where(and(eq(contentItems.workspaceId, ws), isNull(contentItems.deletedAt), scopeFilter(rule, sql`${contentItems.projectId}`), scopePredicate(ctx, 'content.read', { projectId: contentItems.projectId, assigned: [contentItems.ownerMembershipId, contentItems.reviewerMembershipId] }), like(sql`${contentItems.title}`, q)))
        .orderBy(desc(contentItems.updatedAt))
        .limit(10);
      for (const r of rows) out.push({ entityType: 'content_item', entityId: r.id, label: r.title, at: r.at.toISOString() });
      break;
    }
    case 'publication': {
      const rows = await db
        .select({ id: publications.id, title: contentItems.title, at: publications.updatedAt })
        .from(publications)
        .innerJoin(contentItems, eq(contentItems.id, publications.contentItemId))
        .where(and(eq(publications.workspaceId, ws), isNull(publications.deletedAt), scopeFilter(rule, sql`${publications.projectId}`, sql`${publications.accountId}`), scopePredicate(ctx, 'publications.read', { projectId: publications.projectId, accountId: publications.accountId, assigned: [publications.ownerMembershipId] }), like(sql`${contentItems.title}`, q)))
        .orderBy(desc(publications.updatedAt))
        .limit(10);
      for (const r of rows) out.push({ entityType: 'publication', entityId: r.id, label: r.title, at: r.at.toISOString() });
      break;
    }
    case 'metric_checkpoint': {
      const rows = await db
        .select({ id: metricCheckpoints.id, key: metricCheckpoints.checkpointKey, at: metricCheckpoints.expectedAt })
        .from(metricCheckpoints)
        .where(and(eq(metricCheckpoints.workspaceId, ws), scopeFilter(rule, sql`${metricCheckpoints.projectId}`, sql`${metricCheckpoints.accountId}`), scopePredicate(ctx, 'metrics.read', { projectId: metricCheckpoints.projectId, accountId: metricCheckpoints.accountId, assigned: [metricCheckpoints.assigneeMembershipId] })))
        .orderBy(desc(metricCheckpoints.expectedAt))
        .limit(10);
      for (const r of rows) out.push({ entityType: 'metric_checkpoint', entityId: r.id, label: `Checkpoint ${r.key}`, at: r.at.toISOString() });
      break;
    }
    case 'shift': {
      const rows = await db
        .select({ id: shifts.id, at: shifts.scheduledStart, state: shifts.state })
        .from(shifts)
        .where(and(eq(shifts.workspaceId, ws), scopeFilter(rule, sql`${shifts.projectId}`, sql`${shifts.primaryAccountId}`), scopePredicate(ctx, 'shifts.read.scope', { projectId: shifts.projectId, accountId: shifts.primaryAccountId, assigned: [shifts.membershipId] })))
        .orderBy(desc(shifts.scheduledStart))
        .limit(10);
      for (const r of rows) out.push({ entityType: 'shift', entityId: r.id, label: `Shift ${r.at.toISOString().slice(0, 16).replace('T', ' ')} UTC (${r.state})`, at: r.at.toISOString() });
      break;
    }
    case 'handover': {
      const rows = await db
        .select({ id: handovers.id, at: handovers.updatedAt, state: handovers.state })
        .from(handovers)
        .innerJoin(shifts, eq(shifts.id, handovers.fromShiftId))
        .where(and(eq(handovers.workspaceId, ws), scopeFilter(rule, sql`${shifts.projectId}`, sql`${handovers.accountId}`), scopePredicate(ctx, 'handovers.read', { projectId: shifts.projectId, accountId: handovers.accountId, assigned: [handovers.recipientMembershipId] })))
        .orderBy(desc(handovers.updatedAt))
        .limit(10);
      for (const r of rows) out.push({ entityType: 'handover', entityId: r.id, label: `Handover (${r.state})`, at: r.at.toISOString() });
      break;
    }
    case 'account': {
      const rows = await db
        .select({ id: socialAccounts.id, handle: socialAccounts.handle, displayName: socialAccounts.displayName, platform: socialAccounts.platform, at: socialAccounts.updatedAt })
        .from(socialAccounts)
        .where(and(eq(socialAccounts.workspaceId, ws), isNull(socialAccounts.deletedAt), scopeFilter(rule, sql`${socialAccounts.projectId}`, sql`${socialAccounts.id}`), scopePredicate(ctx, 'accounts.read', { projectId: socialAccounts.projectId, accountId: socialAccounts.id })))
        .orderBy(desc(socialAccounts.updatedAt))
        .limit(10);
      for (const r of rows) out.push({ entityType: 'account', entityId: r.id, label: accountLabelOf(r), at: r.at.toISOString() });
      break;
    }
    case 'deal': {
      const rows = await db
        .select({ id: deals.id, title: deals.title, at: deals.updatedAt })
        .from(deals)
        .where(
          and(
            eq(deals.workspaceId, ws),
            dealVisibility(ctx, 'deals.read'),
            rule.scopeType === 'workspace' ? undefined : sql`EXISTS (SELECT 1 FROM deal_projects dp WHERE dp.deal_id = ${deals.id} AND ${scopeFilter(rule, sql`dp.project_id`)})`,
            like(sql`${deals.title}`, q),
          ),
        )
        .orderBy(desc(deals.updatedAt))
        .limit(10);
      for (const r of rows) out.push({ entityType: 'deal', entityId: r.id, label: r.title, at: r.at.toISOString() });
      break;
    }
    case 'budget': {
      const rows = await db.select().from(budgets).where(and(eq(budgets.workspaceId, ws), isNull(budgets.archivedAt))).orderBy(desc(budgets.updatedAt)).limit(50);
      for (const b of rows) {
        const scope = { objectType: 'budget', objectId: b.id, projectId: b.scopeType === 'project' ? b.scopeId : null, directionId: b.scopeType === 'direction' ? b.scopeId : null, ownerMembershipId: b.ownerMembershipId };
        if (!can(ctx.actor.access, 'budgets.read', scope)) continue;
        if (rule.scopeType === 'project' && !(b.scopeType === 'project' && b.scopeId === rule.scopeId)) continue;
        if (rule.scopeType === 'direction' && !(b.scopeType === 'direction' && b.scopeId === rule.scopeId)) continue;
        if (rule.scopeType === 'account') continue;
        if (q && !b.name.toLowerCase().includes(q.toLowerCase())) continue;
        out.push({ entityType: 'budget', entityId: b.id, label: b.name, at: b.updatedAt.toISOString() });
        if (out.length >= 10) break;
      }
      break;
    }
  }
  return out;
};

void inArray;
