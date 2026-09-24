import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { memberships, notifications, userPreferences, users, workspaces } from '@castlane/database';
import { DateTime } from '@castlane/domain';
import { enqueueJob } from '../core/jobs';
import { defineJob, defineSchedule } from '../core/jobs-registry';
import { inQuietHours } from '../core/notify';

/**
 * When the optional daily digest is due for one recipient: once per local calendar day, at the end
 * of their quiet hours (default 08:00 in their zone) or later, never inside quiet hours.
 * Returns the local date the digest belongs to, or null when it is not due now.
 */
export const digestDue = (now: Date, zone: string, quietStart: string, quietEnd: string): string | null => {
  if (inQuietHours(now, zone, quietStart, quietEnd)) return null;
  const local = DateTime.fromJSDate(now, { zone });
  const [h, m] = quietEnd.split(':').map(Number);
  const sendFrom = local.set({ hour: h ?? 8, minute: m ?? 0, second: 0, millisecond: 0 });
  if (local < sendFrom) return null;
  return local.toISODate();
};

/**
 * Daily digest e-mail (section 20): only for members who opted in, only a count and a link to the
 * Inbox (no titles, amounts or aliases), deferred by quiet hours, at most one per local day.
 * Security alerts are never part of this: they are e-mailed immediately by `notify`.
 */
defineJob('notifications.digest', 'light', async ({ app }) => {
  const now = app.clock.now();
  const rows = await app.db
    .select({
      membershipId: memberships.id,
      workspaceId: memberships.workspaceId,
      email: users.displayEmail,
      userTz: userPreferences.timezone,
      wsTz: workspaces.timezone,
      workspaceName: workspaces.name,
      quietStart: userPreferences.quietHoursStart,
      quietEnd: userPreferences.quietHoursEnd,
    })
    .from(userPreferences)
    .innerJoin(users, eq(users.id, userPreferences.userId))
    .innerJoin(memberships, eq(memberships.userId, users.id))
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .where(and(sql`(${userPreferences.notifications} ->> 'dailyDigest')::boolean = true`, eq(memberships.status, 'active'), eq(users.status, 'active'), isNull(users.anonymizedAt)));
  let queued = 0;
  for (const r of rows) {
    const zone = r.userTz ?? r.wsTz;
    const day = digestDue(now, zone, r.quietStart, r.quietEnd);
    if (!day) continue;
    const [c] = await app.db
      .select({ n: sql<number>`count(*)::int` })
      .from(notifications)
      .where(
        and(
          eq(notifications.workspaceId, r.workspaceId),
          eq(notifications.recipientMembershipId, r.membershipId),
          eq(notifications.channel, 'in_app'),
          isNull(notifications.readAt),
          isNull(notifications.archivedAt),
          gt(notifications.createdAt, new Date(now.getTime() - 24 * 3_600_000)),
        ),
      );
    const n = Number(c?.n ?? 0);
    if (n === 0) continue;
    const id = await enqueueJob(app.db, {
      type: 'mail.send',
      workspaceId: r.workspaceId,
      payload: {
        template: 'digest',
        to: r.email,
        vars: { count: n, inboxUrl: `${app.config.APP_ORIGIN}/w/${r.workspaceId}/inbox`, workspaceName: r.workspaceName },
        related: { entityType: 'membership', entityId: r.membershipId },
      },
      // One digest per member and local day, whatever the number of scheduler runs or replicas.
      idempotencyKey: `digest:${r.membershipId}:${day}`,
    });
    if (id) queued++;
  }
  return { candidates: rows.length, queued };
});

defineSchedule({ name: 'notifications.digest', everySeconds: 3600, jobType: 'notifications.digest' });
