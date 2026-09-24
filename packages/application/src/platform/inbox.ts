import { and, count, desc, eq, isNotNull, isNull, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import { entityHref } from '@castlane/api-contracts';
import { notifications } from '@castlane/database';
import { AppError, clampPageSize, decodeCursor, encodeCursor, notFound } from '@castlane/domain';
import type { CommandContext, QueryContext } from '../core/context';
import { dbOf } from '../core/context';
import { streamEvent } from '../core/events';
import { loadMemberRefs } from '../core/members';
import { accessKey, readableProjectNames, resolveEntityAccess } from './entity-access';

type NotificationRow = typeof notifications.$inferSelect;

export interface InboxFilterInput {
  view?: 'unread' | 'all' | 'archived';
  eventType?: string;
  projectId?: string;
}

const requireMember = (ctx: QueryContext): string => {
  if (!ctx.actor.membershipId) throw new AppError('FORBIDDEN', 'Only members have an inbox.');
  return ctx.actor.membershipId;
};

const ownScope = (ctx: QueryContext): SQL =>
  and(eq(notifications.workspaceId, ctx.actor.workspaceId), eq(notifications.recipientMembershipId, requireMember(ctx)), eq(notifications.channel, 'in_app'))!;

const viewCondition = (view: InboxFilterInput['view']) =>
  view === 'archived' ? isNotNull(notifications.archivedAt) : view === 'all' ? isNull(notifications.archivedAt) : and(isNull(notifications.readAt), isNull(notifications.archivedAt));

/**
 * Serialise notifications for the recipient. Excerpts and thumbnails are re-checked against the
 * recipient's current access: when access to the object was revoked, the excerpt and thumbnail are
 * removed (the safe title stays) and the item is flagged.
 */
const toItems = async (ctx: QueryContext, rows: NotificationRow[]) => {
  const access = await resolveEntityAccess(
    ctx,
    rows.filter((r) => r.entityType && r.entityId).map((r) => ({ entityType: r.entityType!, entityId: r.entityId!, projectId: r.projectId })),
  );
  const refs = await loadMemberRefs(dbOf(ctx), ctx.actor.workspaceId, rows.map((r) => r.actorMembershipId));
  return rows.map((r) => {
    const a = r.entityType && r.entityId ? access.get(accessKey({ entityType: r.entityType, entityId: r.entityId })) : undefined;
    const revoked = !!a && !a.readable;
    return {
      id: r.id,
      eventType: r.eventType,
      title: r.title,
      excerpt: revoked || r.sensitive ? null : r.excerpt,
      entityType: r.entityType,
      entityId: r.entityId,
      projectId: r.projectId,
      href: r.entityType && r.entityId ? entityHref(ctx.actor.workspaceId, r.entityType, r.entityId, { projectId: r.projectId }) : null,
      actor: r.actorMembershipId ? (refs.get(r.actorMembershipId) ?? null) : null,
      thumbnailUrl: !revoked && a?.thumbnailAssetId ? `/api/v1/workspaces/${ctx.actor.workspaceId}/assets/${a.thumbnailAssetId}/thumbnail?size=64` : null,
      accessRevoked: revoked,
      security: r.security,
      sensitive: r.sensitive,
      readAt: r.readAt?.toISOString() ?? null,
      archivedAt: r.archivedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      rowVersion: r.rowVersion,
    };
  });
};

export const listNotifications = async (ctx: QueryContext, input: InboxFilterInput & { cursor?: string; pageSize?: number }) => {
  const size = clampPageSize(input.pageSize);
  const c = input.cursor ? decodeCursor(input.cursor) : null;
  const rows = await dbOf(ctx)
    .select()
    .from(notifications)
    .where(
      and(
        ownScope(ctx),
        viewCondition(input.view ?? 'unread'),
        input.eventType ? eq(notifications.eventType, input.eventType) : undefined,
        input.projectId ? eq(notifications.projectId, input.projectId) : undefined,
        c ? or(lt(notifications.createdAt, new Date(String(c.v[0]))), and(eq(notifications.createdAt, new Date(String(c.v[0]))), lt(notifications.id, c.id))) : undefined,
      ),
    )
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(size + 1);
  const hasMore = rows.length > size;
  const pageRows = hasMore ? rows.slice(0, size) : rows;
  const last = pageRows[pageRows.length - 1];
  return {
    items: await toItems(ctx, pageRows),
    hasMore,
    nextCursor: hasMore && last ? encodeCursor({ v: [last.createdAt.toISOString()], id: last.id }) : null,
  };
};

/** Filter options built only from the member's own notifications; project names only when readable. */
export const notificationFacets = async (ctx: QueryContext) => {
  const db = dbOf(ctx);
  const types = await db
    .select({ eventType: notifications.eventType, total: count(), unread: sql<number>`count(*) FILTER (WHERE ${notifications.readAt} IS NULL)::int` })
    .from(notifications)
    .where(and(ownScope(ctx), isNull(notifications.archivedAt)))
    .groupBy(notifications.eventType)
    .orderBy(notifications.eventType);
  const projectRows = await db
    .selectDistinct({ projectId: notifications.projectId })
    .from(notifications)
    .where(and(ownScope(ctx), isNotNull(notifications.projectId)))
    .limit(500);
  const names = await readableProjectNames(ctx, projectRows.map((p) => p.projectId!));
  return {
    eventTypes: types.map((t) => ({ eventType: t.eventType, total: Number(t.total), unread: Number(t.unread) })),
    projects: [...names.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
  };
};

const loadOwn = async (ctx: CommandContext, id: string) => {
  const [n] = await ctx.tx.select().from(notifications).where(and(ownScope(ctx), eq(notifications.id, id))).for('update');
  // Another member's notification is indistinguishable from a missing one.
  if (!n) throw notFound('Notification');
  return n;
};

const inboxChanged = (ctx: CommandContext) =>
  streamEvent(ctx.tx, { workspaceId: ctx.actor.workspaceId, kind: 'inbox', recipientMembershipId: ctx.actor.membershipId! });

/** Read / unread is the recipient's own state; it never completes or changes the underlying work. */
export const setNotificationRead = async (ctx: CommandContext, id: string, read: boolean) => {
  const n = await loadOwn(ctx, id);
  const wantRead = read ? (n.readAt ?? ctx.app.clock.now()) : null;
  if ((n.readAt === null) !== (wantRead === null)) {
    await ctx.tx
      .update(notifications)
      .set({ readAt: wantRead, updatedAt: ctx.app.clock.now(), rowVersion: sql`${notifications.rowVersion} + 1` })
      .where(eq(notifications.id, id));
    await inboxChanged(ctx);
  }
  const [row] = await ctx.tx.select().from(notifications).where(eq(notifications.id, id));
  return (await toItems(ctx, [row!]))[0]!;
};

export const setNotificationArchived = async (ctx: CommandContext, id: string, archived: boolean) => {
  const n = await loadOwn(ctx, id);
  const at = ctx.app.clock.now();
  if (!!n.archivedAt !== archived) {
    await ctx.tx
      .update(notifications)
      .set({ archivedAt: archived ? at : null, readAt: archived ? (n.readAt ?? at) : n.readAt, updatedAt: at, rowVersion: sql`${notifications.rowVersion} + 1` })
      .where(eq(notifications.id, id));
    await inboxChanged(ctx);
  }
  const [row] = await ctx.tx.select().from(notifications).where(eq(notifications.id, id));
  return (await toItems(ctx, [row!]))[0]!;
};

const markFilter = (ctx: QueryContext, f: { eventType?: string; projectId?: string }) =>
  and(
    ownScope(ctx),
    isNull(notifications.readAt),
    isNull(notifications.archivedAt),
    f.eventType ? eq(notifications.eventType, f.eventType) : undefined,
    f.projectId ? eq(notifications.projectId, f.projectId) : undefined,
  );

/** Preview for Mark All Read: how many own unread notifications the current filter covers. */
export const markReadPreview = async (ctx: QueryContext, f: { eventType?: string; projectId?: string }) => {
  const asOf = ctx.app.clock.now();
  const [r] = await dbOf(ctx)
    .select({ n: count() })
    .from(notifications)
    .where(and(markFilter(ctx, f), lte(notifications.createdAt, asOf)));
  return { count: Number(r?.n ?? 0), asOf: asOf.toISOString() };
};

/** Mark the previewed set read; notifications that arrived after the preview stay unread. */
export const markNotificationsRead = async (ctx: CommandContext, f: { eventType?: string; projectId?: string; asOf: string }) => {
  const asOf = new Date(f.asOf);
  if (asOf.getTime() > ctx.app.clock.now().getTime() + 60_000) throw new AppError('VALIDATION_FAILED', 'The preview time is in the future. Preview again.');
  const rows = await ctx.tx
    .update(notifications)
    .set({ readAt: ctx.app.clock.now(), updatedAt: ctx.app.clock.now(), rowVersion: sql`${notifications.rowVersion} + 1` })
    .where(and(markFilter(ctx, f), lte(notifications.createdAt, asOf)))
    .returning({ id: notifications.id });
  if (rows.length) await inboxChanged(ctx);
  return { updated: rows.length };
};
