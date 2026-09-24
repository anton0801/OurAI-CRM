import { and, eq, gt, isNull, ne } from 'drizzle-orm';
import { sessions, type DbOrTx } from '@castlane/database';
import { newId } from '@castlane/domain';
import { randomToken, sha256 } from '../core/crypto';

export const SESSION_IDLE_HOURS = 12;
export const SESSION_ABSOLUTE_DAYS = 7;
export const SESSION_COOKIE = 'castlane_session';
export const PRE_CSRF_COOKIE = 'castlane_csrf';

export interface SessionMeta {
  userAgent?: string | null;
  ipHash?: string | null;
  workspaceId?: string | null;
}

export const createSession = async (
  db: DbOrTx,
  userId: string,
  at: Date,
  meta: SessionMeta,
  opts: { mfaVerified: boolean },
): Promise<{ token: string; sessionId: string; absoluteExpiresAt: Date }> => {
  const token = randomToken(32);
  const id = newId();
  const absoluteExpiresAt = new Date(at.getTime() + SESSION_ABSOLUTE_DAYS * 86_400_000);
  await db.insert(sessions).values({
    id,
    tokenHash: sha256(token),
    userId,
    csrfSecret: randomToken(24),
    createdAt: at,
    lastSeenAt: at,
    idleExpiresAt: new Date(at.getTime() + SESSION_IDLE_HOURS * 3_600_000),
    absoluteExpiresAt,
    mfaVerifiedAt: opts.mfaVerified ? at : null,
    recentAuthAt: at,
    userAgent: meta.userAgent?.slice(0, 300) ?? null,
    ipHash: meta.ipHash ?? null,
    currentWorkspaceId: meta.workspaceId ?? null,
  });
  return { token, sessionId: id, absoluteExpiresAt };
};

export type SessionRow = typeof sessions.$inferSelect;

/** A resolved session; `previousSeenAt` is the last activity before this request (workspace idle policies). */
export type ResolvedSession = SessionRow & { previousSeenAt: Date };

/** Resolve a session token; expired or revoked sessions resolve to null. Extends the idle window. */
export const resolveSession = async (db: DbOrTx, token: string, at: Date): Promise<ResolvedSession | null> => {
  if (!token || token.length > 200) return null;
  const [found] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.tokenHash, sha256(token)), isNull(sessions.revokedAt)))
    .limit(1);
  if (!found) return null;
  const s: ResolvedSession = { ...found, previousSeenAt: found.lastSeenAt };
  if (s.idleExpiresAt <= at || s.absoluteExpiresAt <= at) return null;
  // Touch at most once per minute to avoid write amplification.
  if (at.getTime() - s.lastSeenAt.getTime() > 60_000) {
    const idle = new Date(Math.min(at.getTime() + SESSION_IDLE_HOURS * 3_600_000, s.absoluteExpiresAt.getTime()));
    await db.update(sessions).set({ lastSeenAt: at, idleExpiresAt: idle }).where(eq(sessions.id, s.id));
    s.lastSeenAt = at;
    s.idleExpiresAt = idle;
  }
  return s;
};

export const revokeSession = async (db: DbOrTx, sessionId: string, at: Date, reason: string) => {
  await db.update(sessions).set({ revokedAt: at, revokeReason: reason }).where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
};

export const revokeUserSessions = async (
  db: DbOrTx,
  userId: string,
  at: Date,
  reason: string,
  exceptSessionId?: string,
): Promise<number> => {
  const res = await db
    .update(sessions)
    .set({ revokedAt: at, revokeReason: reason })
    .where(
      and(
        eq(sessions.userId, userId),
        isNull(sessions.revokedAt),
        gt(sessions.absoluteExpiresAt, at),
        exceptSessionId ? ne(sessions.id, exceptSessionId) : undefined,
      ),
    )
    .returning({ id: sessions.id });
  return res.length;
};
