import { and, eq } from 'drizzle-orm';
import { memberships, userPreferences, users, workspaces, type DbOrTx } from '@castlane/database';
import { loadAccessSnapshot } from '../core/access';
import type { Actor } from '../core/context';
import type { SessionRow } from './sessions';

/**
 * Resolve the workspace actor for a session. Returns null when the user has no membership in the
 * workspace (the caller answers 404 — the workspace's existence is not revealed).
 */
export const resolveWorkspaceActor = async (
  db: DbOrTx,
  session: SessionRow,
  workspaceId: string,
  at: Date,
): Promise<Actor | null> => {
  const access = await loadAccessSnapshot(db, workspaceId, session.userId, at);
  if (!access) return null;
  const [row] = await db
    .select({ displayName: users.displayName, userTz: userPreferences.timezone, wsTz: workspaces.timezone, status: memberships.status })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .leftJoin(userPreferences, eq(userPreferences.userId, users.id))
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, session.userId)));
  if (!row) return null;
  return {
    kind: 'user',
    userId: session.userId,
    membershipId: access.membershipId,
    workspaceId,
    displayName: row.displayName,
    access,
    sessionId: session.id,
    mfaVerifiedAt: session.mfaVerifiedAt,
    recentAuthAt: session.recentAuthAt,
    timezone: row.userTz ?? row.wsTz,
  };
};
