import { and, asc, eq, gt, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { accountAssignments, projects, socialAccounts } from '@castlane/database';
import { newId } from '@castlane/domain';
import { allowed, requirePermission, whereAll } from '../core/access';
import { defineArchiveHandler } from '../core/archive-registry';
import { audit } from '../core/audit';
import { dbOf, type CommandContext } from '../core/context';
import { emit } from '../core/events';
import { defineLookup, likePattern } from '../core/lookup-registry';
import { notify } from '../core/notify';
import { defineResponsibilityProvider } from '../core/responsibility-registry';
import { stamp, touch } from '../core/rows';
import { defineLinkAccess } from '../media/link-access';
import { accountArchivePreview, accountLabel, indexAccount, loadAccount, restoreAccount, transitionAccount } from './accounts';
import { endAccountAssignment } from './assignments';
import { bumpAccessRevision } from './helpers';
import { accountVisibility, scopeOfAccount } from './scope';

const PLATFORM_LABEL: Record<string, string> = { instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube', x: 'X', onlyfans: 'OnlyFans', fansly: 'Fansly', other: 'Custom' };

// ——— Picker ———

defineLookup({
  type: 'account',
  async search(ctx, input) {
    requirePermission(ctx, 'accounts.read');
    const rows = await dbOf(ctx)
      .select({ a: socialAccounts, projectName: projects.name })
      .from(socialAccounts)
      .leftJoin(projects, and(eq(projects.workspaceId, socialAccounts.workspaceId), eq(projects.id, socialAccounts.projectId)))
      .where(
        whereAll(
          eq(socialAccounts.workspaceId, ctx.actor.workspaceId),
          isNull(socialAccounts.deletedAt),
          accountVisibility(ctx, 'accounts.read'),
          input.ids?.length ? inArray(socialAccounts.id, input.ids) : undefined,
          !input.ids?.length && !input.includeArchived ? isNull(socialAccounts.archivedAt) : undefined,
          input.projectId ? eq(socialAccounts.projectId, input.projectId) : undefined,
          input.status?.length ? inArray(socialAccounts.status, input.status as never[]) : undefined,
          input.q
            ? or(ilike(socialAccounts.handle, likePattern(input.q)), ilike(socialAccounts.displayName, likePattern(input.q)), ilike(socialAccounts.canonicalUrl, likePattern(input.q)))
            : undefined,
        ),
      )
      .orderBy(asc(sql`lower(coalesce(${socialAccounts.handle}, ${socialAccounts.displayName}, ${socialAccounts.canonicalUrl}))`))
      .limit(input.ids?.length ? Math.max(input.ids.length, input.limit) : input.limit);
    return rows.map(({ a, projectName }) => ({
      id: a.id,
      label: accountLabel(a),
      sublabel: [PLATFORM_LABEL[a.platform], projectName].filter(Boolean).join(' · ') || null,
      status: a.status,
      projectId: a.projectId,
      archived: !!a.archivedAt,
    }));
  },
});

// ——— Files linked to accounts (avatars, evidence) authorise through the account ———

defineLinkAccess('account', {
  permission: 'accounts.read',
  scope: async (ctx, id) => {
    const [a] = await dbOf(ctx).select().from(socialAccounts).where(and(eq(socialAccounts.workspaceId, ctx.actor.workspaceId), eq(socialAccounts.id, id)));
    if (!a || a.deletedAt) return null;
    return { ...(await scopeOfAccount(ctx, a)), label: accountLabel(a), href: `/w/${a.workspaceId}/accounts/${a.id}` };
  },
});

// ——— Archive screen ———

defineArchiveHandler({
  entityType: 'account',
  label: 'Account',
  preview: accountArchivePreview,
  archive: async (ctx, id, input) => {
    await transitionAccount(ctx, id, { targetState: 'archived', reason: input.reason }, { skipVersion: true });
  },
  restorePreview: async (ctx, id) => {
    const a = await loadAccount(ctx, id);
    const scope = await scopeOfAccount(ctx, a);
    if (!allowed(ctx, 'accounts.archive', scope)) return { title: accountLabel(a), items: [{ kind: 'forbidden', label: 'You cannot restore this account', count: 1, blocking: true }] };
    const [dup] = await dbOf(ctx)
      .select({ id: socialAccounts.id })
      .from(socialAccounts)
      .where(and(eq(socialAccounts.workspaceId, ctx.actor.workspaceId), eq(socialAccounts.identityKey, a.identityKey), isNull(socialAccounts.archivedAt), isNull(socialAccounts.deletedAt)));
    return {
      title: accountLabel(a),
      items: dup ? [{ kind: 'identity_conflict', label: 'Another active account uses the same profile link', count: 1, blocking: true, resolution: 'Archive or change the other account first.' }] : [],
    };
  },
  restore: async (ctx, id) => {
    await restoreAccount(ctx, id, {}, { skipVersion: true });
  },
});

// ——— Deactivation impact (F12): account ownership and assignments ———

defineResponsibilityProvider({
  kind: 'accounts.owner',
  label: 'Account ownership',
  unassignedBehaviour: 'Ownership moves to the owner of the account’s project.',
  async list(ctx, membershipId) {
    const rows = await dbOf(ctx)
      .select()
      .from(socialAccounts)
      .where(and(eq(socialAccounts.workspaceId, ctx.actor.workspaceId), eq(socialAccounts.ownerMembershipId, membershipId), isNull(socialAccounts.archivedAt), isNull(socialAccounts.deletedAt)));
    return rows.map((a) => ({ kind: 'accounts.owner', entityType: 'account', entityId: a.id, title: accountLabel(a), projectId: a.projectId, dueAt: null, requiresSuccessor: true }));
  },
  async transfer(ctx, fromMembershipId, resolutions) {
    for (const r of resolutions) {
      const a = await loadAccount(ctx, r.entityId, { lock: true });
      if (a.ownerMembershipId !== fromMembershipId) continue;
      let successor = r.successorMembershipId;
      if (!successor) {
        const [p] = await ctx.tx.select({ owner: projects.ownerMembershipId }).from(projects).where(and(eq(projects.workspaceId, ctx.actor.workspaceId), eq(projects.id, a.projectId)));
        successor = p && p.owner !== fromMembershipId ? p.owner : null;
      }
      if (!successor) continue;
      await reassignOwner(ctx, a.id, fromMembershipId, successor);
    }
  },
});

const reassignOwner = async (ctx: CommandContext, accountId: string, from: string, to: string) => {
  const [row] = await ctx.tx
    .update(socialAccounts)
    .set({ ownerMembershipId: to, ...touch(ctx, socialAccounts) })
    .where(eq(socialAccounts.id, accountId))
    .returning();
  await audit(ctx, { action: 'account.owner_transferred', entityType: 'account', entityId: accountId, projectId: row!.projectId, diff: { ownerMembershipId: { from, to } } });
  await emit(ctx, { type: 'account.updated', entityType: 'account', entityId: accountId, revision: row!.rowVersion });
  await indexAccount(ctx, row!);
  await bumpAccessRevision(ctx.tx, [from, to]);
  await notify(ctx.tx, {
    workspaceId: ctx.actor.workspaceId,
    recipientMembershipIds: [to],
    eventType: 'account.owner_assigned',
    eventKey: `account.owner_assigned:${accountId}:${to}:${row!.rowVersion}`,
    kind: 'assignment',
    title: `You own the account ${accountLabel(row!)}`,
    entityType: 'account',
    entityId: accountId,
    projectId: row!.projectId,
    actorMembershipId: ctx.actor.membershipId,
    at: ctx.app.clock.now(),
  });
};

defineResponsibilityProvider({
  kind: 'accounts.assignment',
  label: 'Account assignments',
  unassignedBehaviour: 'The assignment ends; the account owner keeps responsibility.',
  async list(ctx, membershipId) {
    const now = ctx.app.clock.now();
    const rows = await dbOf(ctx)
      .select({ id: accountAssignments.id, duty: accountAssignments.duty, a: socialAccounts })
      .from(accountAssignments)
      .innerJoin(socialAccounts, and(eq(socialAccounts.workspaceId, accountAssignments.workspaceId), eq(socialAccounts.id, accountAssignments.accountId)))
      .where(
        and(
          eq(accountAssignments.workspaceId, ctx.actor.workspaceId),
          eq(accountAssignments.membershipId, membershipId),
          or(isNull(accountAssignments.validTo), gt(accountAssignments.validTo, now)),
        ),
      );
    return rows.map((r) => ({
      kind: 'accounts.assignment',
      entityType: 'account_assignment',
      entityId: r.id,
      title: `${accountLabel(r.a)} — ${r.duty.replace(/_/g, ' ')}`,
      projectId: r.a.projectId,
      dueAt: null,
      requiresSuccessor: false,
    }));
  },
  async transfer(ctx, fromMembershipId, resolutions) {
    for (const r of resolutions) {
      const [row] = await ctx.tx
        .select()
        .from(accountAssignments)
        .where(and(eq(accountAssignments.workspaceId, ctx.actor.workspaceId), eq(accountAssignments.id, r.entityId), eq(accountAssignments.membershipId, fromMembershipId)));
      if (!row || row.validTo) continue;
      await endAccountAssignment(ctx, row.accountId, row.id, 'Member deactivated', { skipAuth: true });
      if (!r.successorMembershipId) continue;
      const [open] = await ctx.tx
        .select({ id: accountAssignments.id })
        .from(accountAssignments)
        .where(and(eq(accountAssignments.accountId, row.accountId), eq(accountAssignments.membershipId, r.successorMembershipId), eq(accountAssignments.duty, row.duty), isNull(accountAssignments.validTo)));
      if (open) continue;
      const id = newId();
      await ctx.tx.insert(accountAssignments).values({
        ...stamp(ctx),
        id,
        accountId: row.accountId,
        membershipId: r.successorMembershipId,
        duty: row.duty,
        supervisorMembershipId: row.supervisorMembershipId,
        validFrom: ctx.app.clock.now(),
      });
      await bumpAccessRevision(ctx.tx, [r.successorMembershipId]);
      await audit(ctx, { action: 'account.member_assigned', entityType: 'account', entityId: row.accountId, metadata: { membershipId: r.successorMembershipId, duty: row.duty, transferredFrom: fromMembershipId } });
      await emit(ctx, { type: 'account.member_assigned', entityType: 'account', entityId: row.accountId, payload: { assignmentId: id } });
      const a = await loadAccount(ctx, row.accountId);
      await indexAccount(ctx, a);
      await notify(ctx.tx, {
        workspaceId: ctx.actor.workspaceId,
        recipientMembershipIds: [r.successorMembershipId],
        eventType: 'account.assigned',
        eventKey: `account.assigned:${id}`,
        kind: 'assignment',
        title: `You were assigned to ${accountLabel(a)}`,
        entityType: 'account',
        entityId: row.accountId,
        projectId: a.projectId,
        actorMembershipId: ctx.actor.membershipId,
        at: ctx.app.clock.now(),
      });
    }
  },
});

