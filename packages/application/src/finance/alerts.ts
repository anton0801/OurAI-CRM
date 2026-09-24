import { and, eq, isNull } from 'drizzle-orm';
import { budgetAlerts, budgets } from '@castlane/database';
import { newId, newlyCrossedThresholds } from '@castlane/domain';
import { audit } from '../core/audit';
import type { CommandContext } from '../core/context';
import { emit } from '../core/events';
import { notify } from '../core/notify';
import { stamp } from '../core/rows';
import { budgetsCovering, computeBudget } from './budget-figures';
import { workspaceFinance } from './common';

type BudgetRow = typeof budgets.$inferSelect;

/**
 * Threshold alerts (default 80/100/120 %): each crossing notifies the budget owner once per budget
 * version until an explicit reset. Alerts never block recording real spending.
 */
export const evaluateBudgetAlertsFor = async (ctx: CommandContext, list: BudgetRow[]) => {
  if (!list.length) return;
  const { baseCurrency } = await workspaceFinance(ctx);
  for (const b of list) {
    if (!b.approvedVersionId || b.archivedAt) continue;
    const comp = await computeBudget(ctx, b, baseCurrency);
    if (!comp) continue;
    const active = await ctx.tx
      .select({ threshold: budgetAlerts.threshold })
      .from(budgetAlerts)
      .where(and(eq(budgetAlerts.workspaceId, ctx.actor.workspaceId), eq(budgetAlerts.budgetVersionId, b.approvedVersionId), isNull(budgetAlerts.resetAt)));
    const crossed = newlyCrossedThresholds(comp.total.consumedPercent, b.alertThresholds, active.map((a) => a.threshold));
    for (const t of crossed) {
      const id = newId();
      const inserted = await ctx.tx
        .insert(budgetAlerts)
        .values({ ...stamp(ctx), id, budgetVersionId: b.approvedVersionId, threshold: t, crossedAt: ctx.app.clock.now() })
        .onConflictDoNothing()
        .returning({ id: budgetAlerts.id });
      if (!inserted.length) continue;
      await audit(ctx, { action: 'budget.threshold_crossed', entityType: 'budget', entityId: b.id, sensitivity: 'finance', metadata: { threshold: t, versionId: b.approvedVersionId } });
      await emit(ctx, { type: 'budget.threshold_crossed', entityType: 'budget', entityId: b.id, payload: { threshold: t } });
      await notify(ctx.tx, {
        workspaceId: ctx.actor.workspaceId,
        recipientMembershipIds: [b.ownerMembershipId],
        eventType: 'finance.budget_threshold',
        eventKey: `finance.budget_threshold:${id}`,
        kind: 'general',
        title: `Budget "${b.name}" reached ${t}% of plan`,
        excerpt: 'Spending and open commitments crossed an alert threshold. Recording expenses is not blocked.',
        entityType: 'budget',
        entityId: b.id,
        projectId: b.scopeType === 'project' ? b.scopeId : null,
        actorMembershipId: ctx.actor.membershipId,
        excludeActor: false,
        at: ctx.app.clock.now(),
      });
    }
  }
};

export const evaluateBudgetAlerts = async (ctx: CommandContext, input: { projectIds: string[]; campaignIds: string[]; date: string }) => {
  const list = await budgetsCovering(ctx, input);
  await evaluateBudgetAlertsFor(ctx, list);
};
