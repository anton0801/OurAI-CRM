import { and, asc, eq, gte, ilike, inArray, isNull, sql } from 'drizzle-orm';
import { can, listFilter } from '@castlane/authorization';
import {
  budgetVersions,
  budgets,
  compensationRuleVersions,
  compensationRules,
  financeCategories,
  financialAllocations,
  financialEntries,
  financialEntryLines,
  roles,
  settlements,
} from '@castlane/database';
import { AppError, localDate } from '@castlane/domain';
import { requireAnyPermission, requirePermission } from '../core/access';
import { defineArchiveHandler } from '../core/archive-registry';
import { audit } from '../core/audit';
import { dbOf } from '../core/context';
import { emit } from '../core/events';
import { defineLookup, likePattern } from '../core/lookup-registry';
import { isActiveMember, loadMemberRefs } from '../core/members';
import { notify } from '../core/notify';
import { defineResponsibilityProvider } from '../core/responsibility-registry';
import { touch } from '../core/rows';
import { defineLinkAccess } from '../media/link-access';
import { archiveBudget, budgetScope } from './budgets';
import { archiveCategory, FINANCE_READERS } from './categories';
import { financeScopes } from './common';
import { archiveRule } from './compensation-rules';

// ——— Pickers ———

const CLASS_LABEL: Record<string, string> = {
  revenue: 'Revenue',
  contra_revenue: 'Contra-revenue',
  fee: 'Fee',
  operating_expense: 'Operating expense',
  compensation_expense: 'Compensation expense',
  fx_difference: 'FX difference',
};

defineLookup({
  type: 'finance_category',
  async search(ctx, input) {
    requireAnyPermission(ctx, FINANCE_READERS);
    const rows = await dbOf(ctx)
      .select()
      .from(financeCategories)
      .where(
        and(
          eq(financeCategories.workspaceId, ctx.actor.workspaceId),
          input.ids?.length ? inArray(financeCategories.id, input.ids) : undefined,
          !input.ids?.length && !input.includeArchived ? isNull(financeCategories.archivedAt) : undefined,
          input.status?.length ? inArray(financeCategories.accountingClass, input.status as never[]) : undefined,
          input.q ? ilike(financeCategories.name, likePattern(input.q)) : undefined,
        ),
      )
      .orderBy(asc(financeCategories.sortOrder), asc(financeCategories.name))
      .limit(input.ids?.length ? Math.max(input.ids.length, input.limit) : Math.max(input.limit, 50));
    return rows.map((r) => ({ id: r.id, label: r.name, sublabel: CLASS_LABEL[r.accountingClass] ?? r.accountingClass, status: r.accountingClass, projectId: null, archived: !!r.archivedAt }));
  },
});

defineLookup({
  type: 'budget',
  async search(ctx, input) {
    requirePermission(ctx, 'budgets.read');
    const f = listFilter(ctx.actor.access, 'budgets.read');
    const rows = await dbOf(ctx)
      .select()
      .from(budgets)
      .where(
        and(
          eq(budgets.workspaceId, ctx.actor.workspaceId),
          f.kind === 'all' ? undefined : f.kind === 'scoped' && f.projectIds.length ? and(eq(budgets.scopeType, 'project'), inArray(budgets.scopeId, f.projectIds)) : sql`false`,
          input.ids?.length ? inArray(budgets.id, input.ids) : undefined,
          !input.ids?.length && !input.includeArchived ? isNull(budgets.archivedAt) : undefined,
          input.projectId ? and(eq(budgets.scopeType, 'project'), eq(budgets.scopeId, input.projectId)) : undefined,
          input.q ? ilike(budgets.name, likePattern(input.q)) : undefined,
        ),
      )
      .orderBy(asc(budgets.name))
      .limit(input.limit);
    return rows.map((r) => ({
      id: r.id,
      label: r.name,
      sublabel: `${r.periodStart} – ${r.periodEnd} · ${r.currency.trim()}`,
      status: r.approvedVersionId ? 'approved' : 'draft',
      projectId: r.scopeType === 'project' ? r.scopeId : null,
      archived: !!r.archivedAt,
    }));
  },
});

defineLookup({
  type: 'compensation_rule',
  async search(ctx, input) {
    if (!can(ctx.actor.access, 'compensation.rules.read')) throw new AppError('FORBIDDEN', 'You do not have permission to perform this action.');
    const rows = await dbOf(ctx)
      .select()
      .from(compensationRules)
      .where(
        and(
          eq(compensationRules.workspaceId, ctx.actor.workspaceId),
          input.ids?.length ? inArray(compensationRules.id, input.ids) : undefined,
          !input.ids?.length && !input.includeArchived ? isNull(compensationRules.archivedAt) : undefined,
          input.q ? ilike(compensationRules.name, likePattern(input.q)) : undefined,
        ),
      )
      .orderBy(asc(compensationRules.name))
      .limit(input.limit);
    const refs = await loadMemberRefs(dbOf(ctx), ctx.actor.workspaceId, rows.map((r) => r.recipientMembershipId));
    const roleIds = rows.map((r) => r.recipientRoleId).filter((x): x is string => !!x);
    const rs = roleIds.length ? await dbOf(ctx).select({ id: roles.id, name: roles.name }).from(roles).where(inArray(roles.id, roleIds)) : [];
    return rows.map((r) => ({
      id: r.id,
      label: r.name,
      sublabel: r.recipientMembershipId ? (refs.get(r.recipientMembershipId)?.displayName ?? null) : `Role: ${rs.find((x) => x.id === r.recipientRoleId)?.name ?? 'Role'}`,
      status: r.currentVersionId ? 'approved' : 'draft',
      projectId: null,
      archived: !!r.archivedAt,
    }));
  },
});

// ——— Evidence files authorise through the finance record ———

defineLinkAccess('financial_entry', {
  permission: 'finance.documents.read',
  scope: async (ctx, id) => {
    const [e] = await dbOf(ctx).select().from(financialEntries).where(and(eq(financialEntries.workspaceId, ctx.actor.workspaceId), eq(financialEntries.id, id)));
    if (!e) return null;
    const allocs = await dbOf(ctx).select({ projectId: financialAllocations.projectId }).from(financialAllocations).where(eq(financialAllocations.entryId, id));
    const scopes = financeScopes('financial_entry', id, allocs.map((a) => a.projectId), e.accountId);
    const readable = scopes.find((s) => can(ctx.actor.access, 'finance.documents.read', s)) ?? scopes[0]!;
    return { ...readable, label: e.title, href: `/w/${e.workspaceId}/finance/entries/${e.id}` };
  },
});

defineLinkAccess('settlement', {
  permission: 'finance.documents.read',
  scope: async (ctx, id) => {
    const [s] = await dbOf(ctx).select().from(settlements).where(and(eq(settlements.workspaceId, ctx.actor.workspaceId), eq(settlements.id, id)));
    return s ? { objectType: 'settlement', objectId: s.id, label: s.paymentReference ?? 'Settlement', href: `/w/${s.workspaceId}/finance/settlements?open=${s.id}` } : null;
  },
});

// ——— Archive screen ———

defineArchiveHandler({
  entityType: 'budget',
  label: 'Budget',
  preview: async (ctx, id) => {
    const [b] = await dbOf(ctx).select().from(budgets).where(and(eq(budgets.workspaceId, ctx.actor.workspaceId), eq(budgets.id, id)));
    if (!b || !can(ctx.actor.access, 'budgets.read', budgetScope(b))) throw new AppError('NOT_FOUND', 'Budget was not found.');
    if (!can(ctx.actor.access, 'budgets.write', budgetScope(b))) throw new AppError('FORBIDDEN', 'You do not have permission to perform this action.');
    const drafts = await dbOf(ctx).select({ id: budgetVersions.id }).from(budgetVersions).where(and(eq(budgetVersions.budgetId, id), inArray(budgetVersions.state, ['draft', 'submitted'])));
    const today = ctx.app.clock.now().toISOString().slice(0, 10);
    return {
      title: b.name,
      rowVersion: b.rowVersion,
      items: [
        ...(drafts.length ? [{ kind: 'draft_versions', label: 'Unapproved budget versions', count: drafts.length, blocking: false, resolution: 'They stay as history.' }] : []),
        ...(b.periodEnd >= today && b.approvedVersionId ? [{ kind: 'active_period', label: 'The budget period is still running', count: 1, blocking: false, resolution: 'Alerts stop for archived budgets; actual costs are still recorded.' }] : []),
      ],
    };
  },
  archive: async (ctx, id, input) => {
    await archiveBudget(ctx, id, { reason: input.reason });
  },
  restorePreview: async (ctx, id) => {
    const [b] = await dbOf(ctx).select().from(budgets).where(and(eq(budgets.workspaceId, ctx.actor.workspaceId), eq(budgets.id, id)));
    if (!b || !can(ctx.actor.access, 'budgets.write', budgetScope(b))) throw new AppError('NOT_FOUND', 'Budget was not found.');
    return { title: b.name, items: [] };
  },
  restore: async (ctx, id) => {
    await archiveBudget(ctx, id, { restore: true });
  },
});

defineArchiveHandler({
  entityType: 'compensation_rule',
  label: 'Compensation rule',
  preview: async (ctx, id) => {
    if (!can(ctx.actor.access, 'compensation.rules.write')) throw new AppError('FORBIDDEN', 'You do not have permission to perform this action.');
    const [r] = await dbOf(ctx).select().from(compensationRules).where(and(eq(compensationRules.workspaceId, ctx.actor.workspaceId), eq(compensationRules.id, id)));
    if (!r) throw new AppError('NOT_FOUND', 'Rule was not found.');
    const open = await dbOf(ctx).select({ id: compensationRuleVersions.id }).from(compensationRuleVersions).where(and(eq(compensationRuleVersions.ruleId, id), eq(compensationRuleVersions.state, 'approved'), isNull(compensationRuleVersions.effectiveTo)));
    return {
      title: r.name,
      rowVersion: r.rowVersion,
      items: open.length ? [{ kind: 'open_version', label: 'Approved version without an end date', count: open.length, blocking: true, resolution: 'End the rule first.' }] : [],
    };
  },
  archive: async (ctx, id, input) => {
    await archiveRule(ctx, id, { reason: input.reason });
  },
  restore: async (ctx, id) => {
    await archiveRule(ctx, id, { restore: true });
  },
});

defineArchiveHandler({
  entityType: 'finance_category',
  label: 'Finance category',
  preview: async (ctx, id) => {
    requirePermission(ctx, 'finance.post');
    const [c] = await dbOf(ctx).select().from(financeCategories).where(and(eq(financeCategories.workspaceId, ctx.actor.workspaceId), eq(financeCategories.id, id)));
    if (!c) throw new AppError('NOT_FOUND', 'Category was not found.');
    const [n] = await dbOf(ctx)
      .select({ n: sql<number>`count(*)` })
      .from(financialEntryLines)
      .innerJoin(financialEntries, eq(financialEntries.id, financialEntryLines.entryId))
      .where(and(eq(financialEntryLines.categoryId, id), inArray(financialEntries.state, ['draft', 'submitted', 'rejected'])));
    return {
      title: c.name,
      rowVersion: c.rowVersion,
      items: Number(n?.n ?? 0) ? [{ kind: 'draft_lines', label: 'Unposted lines use this category', count: Number(n?.n ?? 0), blocking: false, resolution: 'They must choose an active category before posting.' }] : [],
    };
  },
  archive: async (ctx, id, input) => {
    await archiveCategory(ctx, id, { reason: input.reason }, { skipVersion: true });
  },
  restore: async (ctx, id) => {
    await archiveCategory(ctx, id, { restore: true }, { skipVersion: true });
  },
});

// ——— Deactivation (F12): budgets owned by the member need a successor ———

defineResponsibilityProvider({
  kind: 'finance.budget_owner',
  label: 'Budget ownership',
  unassignedBehaviour: 'Budgets always need an owner: choose a successor who receives the threshold alerts.',
  list: async (ctx, membershipId) => {
    const today = localDate(ctx.app.clock.now(), ctx.actor.timezone);
    const rows = await dbOf(ctx)
      .select()
      .from(budgets)
      .where(and(eq(budgets.workspaceId, ctx.actor.workspaceId), eq(budgets.ownerMembershipId, membershipId), isNull(budgets.archivedAt), gte(budgets.periodEnd, today)));
    return rows.map((b) => ({
      kind: 'finance.budget_owner',
      entityType: 'budget',
      entityId: b.id,
      title: b.name,
      projectId: b.scopeType === 'project' ? b.scopeId : null,
      dueAt: null,
      requiresSuccessor: true,
    }));
  },
  transfer: async (ctx, fromMembershipId, resolutions) => {
    for (const r of resolutions) {
      if (!r.successorMembershipId) throw new AppError('VALIDATION_FAILED', 'Choose a new owner for every budget.', { fieldErrors: [{ field: r.entityId, code: 'REQUIRED', message: 'Choose a new owner.' }] });
      if (!(await isActiveMember(ctx.tx, ctx.actor.workspaceId, r.successorMembershipId))) throw new AppError('VALIDATION_FAILED', 'The new owner must be an active member.');
      const [b] = await ctx.tx.select().from(budgets).where(and(eq(budgets.workspaceId, ctx.actor.workspaceId), eq(budgets.id, r.entityId), eq(budgets.ownerMembershipId, fromMembershipId))).for('update');
      if (!b) continue;
      await ctx.tx.update(budgets).set({ ownerMembershipId: r.successorMembershipId, ...touch(ctx, budgets) }).where(eq(budgets.id, b.id));
      await audit(ctx, { action: 'budget.owner_transferred', entityType: 'budget', entityId: b.id, sensitivity: 'finance', metadata: { from: fromMembershipId, to: r.successorMembershipId } });
      await emit(ctx, { type: 'budget.updated', entityType: 'budget', entityId: b.id });
      await notify(ctx.tx, {
        workspaceId: ctx.actor.workspaceId,
        recipientMembershipIds: [r.successorMembershipId],
        eventType: 'finance.budget_owner_assigned',
        eventKey: `finance.budget_owner_assigned:${b.id}:${r.successorMembershipId}`,
        kind: 'assignment',
        title: `You now own the budget "${b.name}"`,
        entityType: 'budget',
        entityId: b.id,
        actorMembershipId: ctx.actor.membershipId,
        at: ctx.app.clock.now(),
      });
    }
  },
});

