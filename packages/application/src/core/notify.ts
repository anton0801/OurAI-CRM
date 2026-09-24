import { and, eq, inArray } from 'drizzle-orm';
import { memberships, notifications, userPreferences, type DbOrTx } from '@castlane/database';
import { newId, DateTime } from '@castlane/domain';
import { streamEvent } from './events';
import { enqueueJob } from './jobs';

export type NotificationKind =
  | 'mention'
  | 'assignment'
  | 'review_request'
  | 'due_reminder'
  | 'security'
  | 'general';

export interface NotifyInput {
  workspaceId: string;
  recipientMembershipIds: string[];
  eventType: string;
  /** Dedupe key; combined with recipient + channel it is unique. */
  eventKey: string;
  kind: NotificationKind;
  title: string;
  excerpt?: string | null;
  entityType?: string;
  entityId?: string;
  projectId?: string | null;
  actorMembershipId?: string | null;
  sensitive?: boolean;
  at: Date;
  /** Skip the actor themselves (default true). */
  excludeActor?: boolean;
  /** false = In-App Inbox only, never an email copy (e.g. automation rules set to Inbox Only). Default true. */
  email?: boolean;
}

const PREF_KEY: Record<NotificationKind, 'mentions' | 'assignments' | 'reviewRequests' | 'dueReminders' | null> = {
  mention: 'mentions',
  assignment: 'assignments',
  review_request: 'reviewRequests',
  due_reminder: 'dueReminders',
  security: null,
  general: null,
};

/** True when `at` falls inside the quiet-hours window in the recipient's zone. */
export const inQuietHours = (at: Date, zone: string, start: string, end: string): boolean => {
  const local = DateTime.fromJSDate(at, { zone });
  const minutes = local.hour * 60 + local.minute;
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  const s = (sh ?? 0) * 60 + (sm ?? 0);
  const e = (eh ?? 0) * 60 + (em ?? 0);
  return s <= e ? minutes >= s && minutes < e : minutes >= s || minutes < e;
};

export const quietHoursEnd = (at: Date, zone: string, end: string): Date => {
  const [eh, em] = end.split(':').map(Number);
  let d = DateTime.fromJSDate(at, { zone }).set({ hour: eh ?? 8, minute: em ?? 0, second: 0, millisecond: 0 });
  if (d.toJSDate() <= at) d = d.plus({ days: 1 });
  return d.toUTC().toJSDate();
};

/**
 * Create in-app notifications (always immediate) and, when the recipient opted in, an email
 * notification that respects quiet hours (security alerts are never deferred). Repeated events
 * with the same key never create duplicates or inflate unread counts.
 */
export const notify = async (db: DbOrTx, input: NotifyInput): Promise<number> => {
  let recipients = [...new Set(input.recipientMembershipIds.filter(Boolean))];
  if (input.excludeActor !== false && input.actorMembershipId)
    recipients = recipients.filter((r) => r !== input.actorMembershipId);
  if (recipients.length === 0) return 0;

  const members = await db
    .select({ id: memberships.id, userId: memberships.userId, status: memberships.status })
    .from(memberships)
    .where(and(eq(memberships.workspaceId, input.workspaceId), inArray(memberships.id, recipients)));
  const active = members.filter((m) => m.status === 'active');
  if (active.length === 0) return 0;
  const prefs = await db
    .select()
    .from(userPreferences)
    .where(
      inArray(
        userPreferences.userId,
        active.map((m) => m.userId),
      ),
    );
  const prefByUser = new Map(prefs.map((p) => [p.userId, p]));

  let created = 0;
  for (const m of active) {
    const pref = prefByUser.get(m.userId);
    const prefKey = PREF_KEY[input.kind];
    const wants = prefKey ? (pref?.notifications?.[prefKey] ?? true) : true;
    if (!wants && input.kind !== 'security') continue;
    const inserted = await db
      .insert(notifications)
      .values({
        id: newId(),
        workspaceId: input.workspaceId,
        createdAt: input.at,
        updatedAt: input.at,
        recipientMembershipId: m.id,
        eventType: input.eventType,
        eventKey: input.eventKey,
        channel: 'in_app',
        title: input.title,
        excerpt: input.sensitive ? null : (input.excerpt ?? null),
        entityType: input.entityType,
        entityId: input.entityId,
        projectId: input.projectId ?? null,
        actorMembershipId: input.actorMembershipId ?? null,
        sensitive: input.sensitive ?? false,
        security: input.kind === 'security',
        deliveryState: 'delivered',
        deliveredAt: input.at,
      })
      .onConflictDoNothing()
      .returning({ id: notifications.id });
    if (inserted.length === 0) continue;
    created++;
    await streamEvent(db, { workspaceId: input.workspaceId, kind: 'inbox', recipientMembershipId: m.id });

    const emailImmediate = pref?.notifications?.emailImmediate ?? false;
    if (input.kind === 'security' || (emailImmediate && input.email !== false)) {
      const zone = pref?.timezone ?? 'UTC';
      const quiet =
        input.kind !== 'security' && inQuietHours(input.at, zone, pref?.quietHoursStart ?? '22:00', pref?.quietHoursEnd ?? '08:00');
      const deliverAt = quiet ? quietHoursEnd(input.at, zone, pref?.quietHoursEnd ?? '08:00') : input.at;
      await enqueueJob(db, {
        type: 'mail.notification',
        workspaceId: input.workspaceId,
        payload: { notificationId: inserted[0]!.id, membershipId: m.id },
        runAt: deliverAt,
        idempotencyKey: `mail.notification:${input.eventKey}:${m.id}`,
      });
    }
  }
  return created;
};
