import { and, asc, eq, ilike, inArray, isNull } from 'drizzle-orm';
import { can } from '@castlane/authorization';
import { automationRules, automationRuleVersions } from '@castlane/database';
import { AppError } from '@castlane/domain';
import { requirePermission } from '../core/access';
import { defineArchiveHandler, tableArchiveList } from '../core/archive-registry';
import { dbOf } from '../core/context';
import { defineLookup, likePattern } from '../core/lookup-registry';
import { loadAccessSnapshot } from '../core/access';
import { defineResponsibilityProvider } from '../core/responsibility-registry';
import { memberships } from '@castlane/database';
import { findById } from '../core/rows';
import { authorityGaps, describeGaps } from './principal';
import { archiveAutomationRule, configOfVersion, pauseAutomationRule, reassignAutomationOwner, ruleAuthScope, ruleVisibilitySql } from './rules';

defineLookup({
  type: 'automation',
  async search(ctx, input) {
    requirePermission(ctx, 'automations.read');
    const rows = await dbOf(ctx)
      .select()
      .from(automationRules)
      .where(
        and(
          eq(automationRules.workspaceId, ctx.actor.workspaceId),
          ruleVisibilitySql(ctx),
          input.ids?.length ? inArray(automationRules.id, input.ids) : undefined,
          !input.ids?.length && !input.includeArchived ? isNull(automationRules.archivedAt) : undefined,
          input.status?.length ? inArray(automationRules.state, input.status as never[]) : undefined,
          input.q ? ilike(automationRules.name, likePattern(input.q)) : undefined,
        ),
      )
      .orderBy(asc(automationRules.name))
      .limit(input.ids?.length ? Math.max(input.ids.length, input.limit) : input.limit);
    return rows.map((r) => ({ id: r.id, label: r.name, sublabel: r.state.replace(/_/g, ' '), status: r.state, projectId: r.scopeType === 'project' ? r.scopeId : null, archived: !!r.archivedAt }));
  },
});

defineArchiveHandler({
  entityType: 'automation_rule',
  label: 'Automation rule',
  async preview(ctx, id) {
    const r = await findById(ctx, automationRules, id, 'Automation rule');
    if (!can(ctx.actor.access, 'automations.read', ruleAuthScope(r))) throw new AppError('NOT_FOUND', 'Automation rule was not found.');
    if (!can(ctx.actor.access, 'automations.edit', ruleAuthScope(r))) throw new AppError('FORBIDDEN', 'You cannot archive this rule.');
    return {
      title: r.name,
      rowVersion: r.rowVersion,
      items: r.state === 'enabled' ? [{ kind: 'enabled_rule', label: 'The rule is enabled and will be disabled; runs that have not started are cancelled', count: 1, blocking: false }] : [],
    };
  },
  archive: async (ctx, id, input) => {
    await archiveAutomationRule(ctx, id, { reason: input.reason }, { skipVersion: true });
  },
  restorePreview: async (ctx, id) => {
    const r = await findById(ctx, automationRules, id, 'Automation rule');
    if (!can(ctx.actor.access, 'automations.edit', ruleAuthScope(r))) throw new AppError('NOT_FOUND', 'Automation rule was not found.');
    return { title: r.name, items: [{ kind: 'restored_disabled', label: 'The rule is restored as Disabled', count: 1, blocking: false }] };
  },
  restore: async (ctx, id) => {
    await archiveAutomationRule(ctx, id, { restore: true }, { skipVersion: true });
  },
  list: (ctx, input) => tableArchiveList(ctx, input, { table: automationRules, title: automationRules.name, scope: ruleVisibilitySql(ctx) }),
});

/**
 * F12: rules owned by a deactivated member. Enabled rules need a successor who covers the rule
 * scope; without one the rule becomes Needs Owner and pauses (it never runs ownerless).
 */
defineResponsibilityProvider({
  kind: 'automations.owner',
  label: 'Automation rule ownership',
  unassignedBehaviour: 'The rule loses its owner and is paused as Needs Owner until someone takes it over.',
  async list(ctx, membershipId) {
    const rows = await dbOf(ctx)
      .select()
      .from(automationRules)
      .where(and(eq(automationRules.workspaceId, ctx.actor.workspaceId), eq(automationRules.ownerMembershipId, membershipId), isNull(automationRules.archivedAt)))
      .orderBy(asc(automationRules.name));
    return rows.map((r) => ({
      kind: 'automations.owner',
      entityType: 'automation_rule',
      entityId: r.id,
      title: `Automation rule “${r.name}”`,
      projectId: r.scopeType === 'project' ? r.scopeId : null,
      dueAt: null,
      requiresSuccessor: r.state === 'enabled',
    }));
  },
  async transfer(ctx, fromMembershipId, resolutions) {
    for (const res of resolutions) {
      const [r] = await ctx.tx.select().from(automationRules).where(and(eq(automationRules.workspaceId, ctx.actor.workspaceId), eq(automationRules.id, res.entityId))).for('update');
      if (!r || r.ownerMembershipId !== fromMembershipId) continue;
      if (res.successorMembershipId) {
        // The successor must be able to act across the rule scope (responsibility providers validate access).
        const [m] = await ctx.tx.select({ userId: memberships.userId, status: memberships.status }).from(memberships).where(and(eq(memberships.workspaceId, ctx.actor.workspaceId), eq(memberships.id, res.successorMembershipId)));
        if (!m || m.status !== 'active') throw new AppError('INVALID_STATE', `The new owner of “${r.name}” must be an active member.`);
        const versionId = r.enabledVersionId ?? r.currentVersionId;
        const [v] = versionId ? await ctx.tx.select().from(automationRuleVersions).where(eq(automationRuleVersions.id, versionId)) : [];
        const access = await loadAccessSnapshot(ctx.app.db, ctx.actor.workspaceId, m.userId, ctx.app.clock.now());
        const gaps = v && access ? await authorityGaps(ctx.tx, ctx.actor.workspaceId, r, configOfVersion(v), access) : [];
        if (gaps.length) throw new AppError('INVALID_STATE', `The new owner of “${r.name}” lacks ${describeGaps(gaps)} in the rule scope. Choose someone who covers it.`);
        await reassignAutomationOwner(ctx, r.id, fromMembershipId, res.successorMembershipId);
      } else {
        await reassignAutomationOwner(ctx, r.id, fromMembershipId, null);
        if (r.state === 'enabled') await pauseAutomationRule(ctx, r.id, 'paused_needs_owner', 'Needs Owner: the previous owner was deactivated.');
      }
    }
  },
});
