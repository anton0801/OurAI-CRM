import { and, eq, inArray } from 'drizzle-orm';
import { hasAnywhere, isFinancePermission, OWNER_ONLY_GRANTABLE } from '@castlane/authorization';
import { directions, projects, roles, socialAccounts, type DbOrTx, type ProposedGrant } from '@castlane/database';
import { AppError } from '@castlane/domain';
import type { QueryContext } from '../core/context';

/**
 * Validate that the actor may grant these roles at these scopes. Rules (section 7.1):
 *  - the protected Owner role is only ever assigned through ownership transfer;
 *  - only an Owner assigns Admin or any role containing finance permissions / finance.manage;
 *  - everyone else may only grant permissions they hold themselves (no escalation);
 *  - scope objects must exist in this workspace.
 */
export const validateGrants = async (
  db: DbOrTx,
  ctx: QueryContext,
  grants: ProposedGrant[],
): Promise<{ ok: true } | { ok: false; code: 'invalid_role' | 'invalid_scope'; message: string }> => {
  if (grants.length === 0) return { ok: false, code: 'invalid_role', message: 'Choose at least one role.' };
  const roleRows = await db
    .select()
    .from(roles)
    .where(and(eq(roles.workspaceId, ctx.actor.workspaceId), inArray(roles.id, grants.map((g) => g.roleId))));
  const byId = new Map(roleRows.map((r) => [r.id, r]));
  const access = ctx.actor.access;
  for (const g of grants) {
    const role = byId.get(g.roleId);
    if (!role || role.archivedAt) return { ok: false, code: 'invalid_role', message: 'The selected role does not exist.' };
    if (role.isProtected || role.key === 'owner')
      return { ok: false, code: 'invalid_role', message: 'The Owner role can only be passed on through ownership transfer.' };
    const needsOwner =
      role.key === 'admin' || role.permissions.some((p) => isFinancePermission(p) || OWNER_ONLY_GRANTABLE.includes(p));
    if (needsOwner && !access.isOwner)
      return { ok: false, code: 'invalid_role', message: `Only the workspace Owner can grant the ${role.name} role.` };
    if (!access.isOwner && !role.permissions.every((p) => hasAnywhere(access, p)))
      return { ok: false, code: 'invalid_role', message: `You cannot grant permissions you do not hold (${role.name}).` };

    const scopeNeedsId = g.scopeType === 'direction' || g.scopeType === 'project' || g.scopeType === 'account';
    if (scopeNeedsId !== !!g.scopeId) return { ok: false, code: 'invalid_scope', message: 'The selected scope is incomplete.' };
    if (g.scopeType === 'direction') {
      const [d] = await db.select({ id: directions.id }).from(directions).where(and(eq(directions.workspaceId, ctx.actor.workspaceId), eq(directions.id, g.scopeId!)));
      if (!d) return { ok: false, code: 'invalid_scope', message: 'The selected direction does not exist.' };
    }
    if (g.scopeType === 'project') {
      const [p] = await db.select({ id: projects.id }).from(projects).where(and(eq(projects.workspaceId, ctx.actor.workspaceId), eq(projects.id, g.scopeId!)));
      if (!p) return { ok: false, code: 'invalid_scope', message: 'The selected project does not exist.' };
    }
    if (g.scopeType === 'account') {
      const [a] = await db.select({ id: socialAccounts.id }).from(socialAccounts).where(and(eq(socialAccounts.workspaceId, ctx.actor.workspaceId), eq(socialAccounts.id, g.scopeId!)));
      if (!a) return { ok: false, code: 'invalid_scope', message: 'The selected account does not exist.' };
    }
  }
  return { ok: true };
};

export const assertGrants = async (db: DbOrTx, ctx: QueryContext, grants: ProposedGrant[]) => {
  const r = await validateGrants(db, ctx, grants);
  if (!r.ok) throw new AppError('FORBIDDEN', r.message, { details: { code: r.code } });
};
