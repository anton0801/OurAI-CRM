import { and, eq, inArray } from 'drizzle-orm';
import { memberships, users, type DbOrTx } from '@castlane/database';

export interface MemberRef {
  membershipId: string;
  displayName: string;
  avatarUrl: string | null;
  former?: boolean;
}

/**
 * Resolve membership ids to display references. Deactivated members keep their historical name;
 * anonymised ones show "Former Member" (section 8.3).
 */
export const loadMemberRefs = async (db: DbOrTx, workspaceId: string, ids: (string | null | undefined)[]): Promise<Map<string, MemberRef>> => {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  const out = new Map<string, MemberRef>();
  if (unique.length === 0) return out;
  const rows = await db
    .select({
      id: memberships.id,
      snapshot: memberships.displayNameSnapshot,
      status: memberships.status,
      name: users.displayName,
      anonymizedAt: users.anonymizedAt,
      avatar: users.avatarAssetId,
      userId: users.id,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.workspaceId, workspaceId), inArray(memberships.id, unique)));
  for (const r of rows) {
    const former = r.status === 'deactivated';
    out.set(r.id, {
      membershipId: r.id,
      displayName: r.anonymizedAt ? 'Former Member' : former ? r.snapshot : r.name,
      avatarUrl: r.avatar && !r.anonymizedAt ? `/api/v1/avatars/${r.userId}` : null,
      former: former || undefined,
    });
  }
  return out;
};

export const refOrUnknown = (m: Map<string, MemberRef>, id: string | null | undefined): MemberRef | null =>
  id ? (m.get(id) ?? { membershipId: id, displayName: 'Unknown member', avatarUrl: null }) : null;

/** Require that a membership is active in the workspace (owners, assignees, reviewers). */
export const isActiveMember = async (db: DbOrTx, workspaceId: string, membershipId: string): Promise<boolean> => {
  const [m] = await db
    .select({ status: memberships.status })
    .from(memberships)
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.id, membershipId)));
  return m?.status === 'active';
};
