import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { eventStream, memberships, notifications, type Db } from '@castlane/database';

export interface StreamEvent {
  seq: number;
  kind: 'entity_changed' | 'inbox' | 'job_progress' | 'access_changed';
  entityType: string | null;
  entityId: string | null;
  revision: number | null;
}

/** Events after `afterSeq` visible to this member (inbox/job events only for their recipient). */
export const readStream = async (db: Db, workspaceId: string, membershipId: string, afterSeq: number, limit = 200): Promise<StreamEvent[]> => {
  const rows = await db
    .select()
    .from(eventStream)
    .where(
      and(
        eq(eventStream.workspaceId, workspaceId),
        gt(eventStream.seq, afterSeq),
        or(isNull(eventStream.recipientMembershipId), eq(eventStream.recipientMembershipId, membershipId)),
      ),
    )
    .orderBy(eventStream.seq)
    .limit(limit);
  return rows.map((r) => ({ seq: r.seq, kind: r.kind, entityType: r.entityType, entityId: r.entityId, revision: r.revision }));
};

/** Oldest retained sequence; a Last-Event-ID older than this requires a full resync. */
export const streamHead = async (db: Db, workspaceId: string): Promise<{ min: number; max: number }> => {
  const res = await db.execute<{ min: number | null; max: number | null }>(
    sql`SELECT min(seq) AS min, max(seq) AS max FROM ${eventStream} WHERE workspace_id = ${workspaceId}`,
  );
  return { min: Number(res.rows[0]?.min ?? 0), max: Number(res.rows[0]?.max ?? 0) };
};

export const membershipStillActive = async (db: Db, membershipId: string, accessRevision: number): Promise<'active' | 'changed' | 'revoked'> => {
  const [m] = await db.select({ status: memberships.status, rev: memberships.accessRevision }).from(memberships).where(eq(memberships.id, membershipId));
  if (!m || m.status !== 'active') return 'revoked';
  return m.rev === accessRevision ? 'active' : 'changed';
};

export const unreadCount = async (db: Db, workspaceId: string, membershipId: string): Promise<number> => {
  const res = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM ${notifications}
    WHERE workspace_id = ${workspaceId} AND recipient_membership_id = ${membershipId}
      AND channel = 'in_app' AND read_at IS NULL AND archived_at IS NULL`);
  return Number(res.rows[0]?.n ?? 0);
};
