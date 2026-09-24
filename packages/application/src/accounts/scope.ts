import { and, eq, gt, isNull, or, sql, type SQL } from 'drizzle-orm';
import { listFilter } from '@castlane/authorization';
import { accountAssignments, socialAccounts, type DbOrTx } from '@castlane/database';
import { dbOf, type CommandContext, type QueryContext } from '../core/context';

export type AccountRow = typeof socialAccounts.$inferSelect;
export type AccountStatus = AccountRow['status'];

/**
 * Authorization scope of an account: its project (→ direction), the account itself (assigned
 * accounts), and the people directly responsible for it (owner + open assignments).
 */
export const accountScope = (a: Pick<AccountRow, 'id' | 'projectId' | 'ownerMembershipId'>, assigned: string[] = []) => ({
  objectType: 'account',
  objectId: a.id,
  accountId: a.id,
  projectId: a.projectId,
  ownerMembershipId: a.ownerMembershipId,
  assignedMembershipIds: [a.ownerMembershipId, ...assigned],
});

export const openAssigneeIds = async (db: DbOrTx, workspaceId: string, accountId: string, at: Date): Promise<string[]> => {
  const rows = await db
    .select({ membershipId: accountAssignments.membershipId })
    .from(accountAssignments)
    .where(
      and(
        eq(accountAssignments.workspaceId, workspaceId),
        eq(accountAssignments.accountId, accountId),
        or(isNull(accountAssignments.validTo), gt(accountAssignments.validTo, at)),
      ),
    );
  return [...new Set(rows.map((r) => r.membershipId))];
};

export const scopeOfAccount = async (ctx: QueryContext | CommandContext, a: AccountRow) =>
  accountScope(a, await openAssigneeIds(dbOf(ctx), ctx.actor.workspaceId, a.id, ctx.app.clock.now()));

/**
 * SQL visibility predicate for account lists/lookups/exports, applied before pagination. Mirrors
 * `accountScope`: project/account grants, plus owner and open assignments for assigned-object grants.
 */
export const accountVisibility = (ctx: QueryContext, permission: string): SQL | undefined => {
  const f = listFilter(ctx.actor.access, permission);
  if (f.kind === 'all') return undefined;
  if (f.kind === 'none') return sql`false`;
  const parts: SQL[] = [];
  if (f.projectIds.length) parts.push(sql`${socialAccounts.projectId} IN (${sql.join(f.projectIds.map((p) => sql`${p}::uuid`), sql`, `)})`);
  if (f.accountIds.length) parts.push(sql`${socialAccounts.id} IN (${sql.join(f.accountIds.map((p) => sql`${p}::uuid`), sql`, `)})`);
  const me = f.assignedToMembershipId ?? f.ownRecordsMembershipId;
  if (me) parts.push(sql`${socialAccounts.ownerMembershipId} = ${me}::uuid`);
  if (f.assignedToMembershipId)
    parts.push(
      sql`EXISTS (SELECT 1 FROM account_assignments aa WHERE aa.account_id = ${socialAccounts.id} AND aa.membership_id = ${f.assignedToMembershipId}::uuid AND (aa.valid_to IS NULL OR aa.valid_to > ${ctx.app.clock.now()}))`,
    );
  if (!parts.length) return sql`false`;
  return parts.length === 1 ? parts[0] : sql`(${sql.join(parts, sql` OR `)})`;
};
