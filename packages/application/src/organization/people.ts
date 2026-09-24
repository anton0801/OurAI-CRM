import { and, eq, ilike, inArray, or } from 'drizzle-orm';
import { can, hasAnywhere } from '@castlane/authorization';
import { memberships, users } from '@castlane/database';
import { loadAccessSnapshot } from '../core/access';
import type { QueryContext } from '../core/context';

/**
 * Member picker. Everyone may pick colleagues by name (needed for assignments); e-mail addresses
 * are only returned to members with members.read. With `projectId` + `permission`, only people who
 * would actually hold that permission on the project are returned (e.g. eligible reviewers).
 */
export const lookupPeople = async (
  ctx: QueryContext,
  input: { q?: string; projectId?: string; permission?: string; includeInactive?: boolean; limit: number },
) => {
  const showEmail = hasAnywhere(ctx.actor.access, 'members.read');
  const rows = await ctx.app.db
    .select({
      id: memberships.id,
      status: memberships.status,
      title: memberships.title,
      name: users.displayName,
      email: users.displayEmail,
      userId: users.id,
      avatar: users.avatarAssetId,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.workspaceId, ctx.actor.workspaceId),
        input.includeInactive ? undefined : inArray(memberships.status, ['active']),
        input.q ? or(ilike(users.displayName, `%${input.q.replace(/[%_\\]/g, '')}%`), showEmail ? ilike(users.displayEmail, `%${input.q.replace(/[%_\\]/g, '')}%`) : undefined) : undefined,
      ),
    )
    .orderBy(users.displayName)
    .limit(input.projectId && input.permission ? 500 : input.limit);

  let filtered = rows;
  if (input.projectId && input.permission) {
    const at = ctx.app.clock.now();
    const out: typeof rows = [];
    for (const r of rows) {
      const snap = await loadAccessSnapshot(ctx.app.db, ctx.actor.workspaceId, r.userId, at);
      if (snap && can(snap, input.permission, { projectId: input.projectId })) out.push(r);
      if (out.length >= input.limit) break;
    }
    filtered = out;
  }
  return filtered.slice(0, input.limit).map((r) => ({
    membershipId: r.id,
    displayName: r.name,
    email: showEmail ? r.email : null,
    avatarUrl: r.avatar ? `/api/v1/avatars/${r.userId}` : null,
    status: r.status,
    title: r.title,
  }));
};
