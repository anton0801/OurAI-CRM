import { and, asc, count, desc, eq, gt, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
import {
  articleAcknowledgements,
  articleCategories,
  articles,
  articleVersions,
  memberships,
  projectMemberships,
  readingAssignments,
  roleAssignments,
  roles,
} from '@castlane/database';
import { AppError, clampPageSize, decodeCursor, encodeCursor, newId, notFound } from '@castlane/domain';
import { hasAnywhere } from '@castlane/authorization';
import { allowed, requirePermission } from '../core/access';
import { audit } from '../core/audit';
import { dbOf, type CommandContext, type QueryContext } from '../core/context';
import { emit } from '../core/events';
import { loadMemberRefs, refOrUnknown } from '../core/members';
import { notify } from '../core/notify';
import { stamp, touch } from '../core/rows';
import { canManage, canReadPublished, canSeeArticle, memberSnapshots, publishedReadVisibility } from './access';
import { loadArticleRow, loadVisibleArticle, setPublishHooks } from './articles';

type ArticleRow = typeof articles.$inferSelect;
type VersionRow = typeof articleVersions.$inferSelect;

const MAX_AUDIENCE = 1000;

const readingNotice = async (ctx: CommandContext, a: ArticleRow, v: VersionRow, recipients: string[], updated: boolean, dueAt: Date | null) => {
  if (!recipients.length) return;
  await notify(ctx.tx, {
    workspaceId: ctx.actor.workspaceId,
    recipientMembershipIds: recipients,
    eventType: updated ? 'knowledge.reading_renewed' : 'knowledge.reading_assigned',
    eventKey: `knowledge.reading:${v.id}`,
    kind: 'assignment',
    title: updated ? `Updated required reading: ${a.title} (version ${v.versionNo})` : `Required reading: ${a.title}`,
    excerpt: dueAt ? `Acknowledge by ${dueAt.toISOString().slice(0, 10)}.` : 'Read the article and confirm with Acknowledge Read.',
    entityType: 'article',
    entityId: a.id,
    projectId: a.scopeType === 'project' ? a.scopeId : null,
    actorMembershipId: ctx.actor.membershipId,
    at: ctx.app.clock.now(),
  });
};

/**
 * After a publication: open requests for older versions are superseded by requests for the new
 * version (acknowledging an old text never counts for a new one). A major revision of required
 * reading also asks everyone who acknowledged an earlier version to read again; their earlier
 * acknowledgement stays as a fact (T084). Members who lost access are not asked.
 */
const afterPublish = async (ctx: CommandContext, a: ArticleRow, v: VersionRow, previous: string | null) => {
  if (!previous) return { rerequested: 0, carried: 0 };
  const at = ctx.app.clock.now();
  const ws = ctx.actor.workspaceId;
  const snapshots = memberSnapshots(ctx.app, ws);
  const open = await ctx.tx
    .select()
    .from(readingAssignments)
    .where(and(eq(readingAssignments.workspaceId, ws), eq(readingAssignments.articleId, a.id), eq(readingAssignments.status, 'open'), ne(readingAssignments.articleVersionId, v.id)))
    .for('update');
  const recipients: string[] = [];
  let carried = 0;
  const handled = new Set<string>();
  for (const o of open) {
    await ctx.tx
      .update(readingAssignments)
      .set({ status: 'superseded', closedAt: at, closeReason: `Replaced by version ${v.versionNo}`, ...touch(ctx, readingAssignments) })
      .where(eq(readingAssignments.id, o.id));
    if (handled.has(o.membershipId)) continue;
    handled.add(o.membershipId);
    const snap = await snapshots(o.membershipId);
    if (!snap || !canReadPublished(snap, a)) continue;
    const inserted = await ctx.tx
      .insert(readingAssignments)
      .values({ ...stamp(ctx), id: newId(), articleId: a.id, articleVersionId: v.id, membershipId: o.membershipId, dueAt: o.dueAt, status: 'open', source: 'revision', assignedByMembershipId: ctx.actor.membershipId })
      .onConflictDoNothing()
      .returning({ id: readingAssignments.id });
    if (inserted.length) {
      carried++;
      recipients.push(o.membershipId);
    }
  }
  let rerequested = 0;
  if (v.revisionKind === 'major' && a.requiredReading) {
    const acked = await ctx.tx
      .selectDistinctOn([readingAssignments.membershipId], { membershipId: readingAssignments.membershipId })
      .from(readingAssignments)
      .where(and(eq(readingAssignments.workspaceId, ws), eq(readingAssignments.articleId, a.id), eq(readingAssignments.status, 'acknowledged'), ne(readingAssignments.articleVersionId, v.id)))
      .orderBy(readingAssignments.membershipId, desc(readingAssignments.createdAt));
    for (const k of acked) {
      if (handled.has(k.membershipId)) continue;
      handled.add(k.membershipId);
      const snap = await snapshots(k.membershipId);
      if (!snap || !canReadPublished(snap, a)) continue;
      const inserted = await ctx.tx
        .insert(readingAssignments)
        .values({ ...stamp(ctx), id: newId(), articleId: a.id, articleVersionId: v.id, membershipId: k.membershipId, status: 'open', source: 'revision', assignedByMembershipId: ctx.actor.membershipId })
        .onConflictDoNothing()
        .returning({ id: readingAssignments.id });
      if (inserted.length) {
        rerequested++;
        recipients.push(k.membershipId);
      }
    }
  }
  if (v.revisionKind === 'major') await readingNotice(ctx, a, v, recipients, true, null);
  return { rerequested, carried };
};

setPublishHooks({ afterPublish });

const expandAudience = async (ctx: CommandContext, input: { membershipIds: string[]; roleIds: string[]; projectIds: string[] }) => {
  const ws = ctx.actor.workspaceId;
  const at = ctx.app.clock.now();
  const source = new Map<string, 'member' | 'role' | 'project'>();
  for (const id of input.membershipIds) source.set(id, 'member');
  if (input.roleIds.length) {
    const found = await ctx.tx.select({ id: roles.id }).from(roles).where(and(eq(roles.workspaceId, ws), inArray(roles.id, input.roleIds)));
    if (found.length !== new Set(input.roleIds).size)
      throw new AppError('VALIDATION_FAILED', 'Choose existing roles.', { fieldErrors: [{ field: 'roleIds', code: 'NOT_FOUND', message: 'Choose existing roles.' }] });
    const holders = await ctx.tx
      .selectDistinct({ membershipId: roleAssignments.membershipId })
      .from(roleAssignments)
      .where(
        and(
          eq(roleAssignments.workspaceId, ws),
          inArray(roleAssignments.roleId, input.roleIds),
          isNull(roleAssignments.revokedAt),
          lte(roleAssignments.validFrom, at),
          or(isNull(roleAssignments.validTo), gt(roleAssignments.validTo, at)),
        ),
      );
    for (const h of holders) if (!source.has(h.membershipId)) source.set(h.membershipId, 'role');
  }
  if (input.projectIds.length) {
    for (const pid of input.projectIds)
      if (!allowed(ctx, 'projects.read', { projectId: pid }))
        throw new AppError('VALIDATION_FAILED', 'Choose projects you can access.', { fieldErrors: [{ field: 'projectIds', code: 'NOT_FOUND', message: 'Choose projects you can access.' }] });
    const team = await ctx.tx
      .selectDistinct({ membershipId: projectMemberships.membershipId })
      .from(projectMemberships)
      .where(
        and(
          eq(projectMemberships.workspaceId, ws),
          inArray(projectMemberships.projectId, input.projectIds),
          lte(projectMemberships.validFrom, at),
          or(isNull(projectMemberships.validTo), gt(projectMemberships.validTo, at)),
        ),
      );
    for (const t of team) if (!source.has(t.membershipId)) source.set(t.membershipId, 'project');
  }
  if (source.size > MAX_AUDIENCE) throw new AppError('VALIDATION_FAILED', `Assign reading to at most ${MAX_AUDIENCE} members at a time.`);
  return source;
};

/**
 * Assign Reading (§33.2): acknowledgement requests for members, role holders or project teams,
 * for the current published version. Only active members who can read the article are asked;
 * nobody is asked twice for the same version.
 */
export const assignReading = async (
  ctx: CommandContext,
  id: string,
  input: { versionId: string; membershipIds: string[]; roleIds: string[]; projectIds: string[]; dueAt?: string | null },
) => {
  const a = await loadArticleRow(ctx, id, true);
  if (!canSeeArticle(ctx.actor.access, a)) throw notFound('Article');
  if (!canManage(ctx.actor.access, a, 'knowledge.publish')) throw new AppError('FORBIDDEN', 'You cannot assign reading for this article.');
  if (a.status !== 'published' || !a.publishedVersionId) throw new AppError('INVALID_STATE', 'Publish the article before assigning reading.');
  if (input.versionId !== a.publishedVersionId) throw new AppError('INVALID_STATE', 'A newer version was published. Assign reading for the current version.', { details: { currentVersionId: a.publishedVersionId } });
  const dueAt = input.dueAt ? new Date(input.dueAt) : null;
  if (dueAt && dueAt <= ctx.app.clock.now())
    throw new AppError('VALIDATION_FAILED', 'Choose a future date and time.', { fieldErrors: [{ field: 'dueAt', code: 'MUST_BE_FUTURE', message: 'Choose a future date and time.' }] });
  const [v] = await ctx.tx.select().from(articleVersions).where(eq(articleVersions.id, a.publishedVersionId));
  const audience = await expandAudience(ctx, input);
  const ids = [...audience.keys()];
  const ms = ids.length ? await ctx.tx.select({ id: memberships.id, status: memberships.status }).from(memberships).where(and(eq(memberships.workspaceId, ctx.actor.workspaceId), inArray(memberships.id, ids))) : [];
  const active = new Set(ms.filter((m) => m.status === 'active').map((m) => m.id));
  const existing = ids.length
    ? await ctx.tx.select().from(readingAssignments).where(and(eq(readingAssignments.articleVersionId, v!.id), inArray(readingAssignments.membershipId, ids)))
    : [];
  const byMember = new Map(existing.map((e) => [e.membershipId, e]));
  const acks = ids.length
    ? await ctx.tx.select().from(articleAcknowledgements).where(and(eq(articleAcknowledgements.articleVersionId, v!.id), inArray(articleAcknowledgements.membershipId, ids)))
    : [];
  const ackBy = new Map(acks.map((k) => [k.membershipId, k]));
  const snapshots = memberSnapshots(ctx.app, ctx.actor.workspaceId);
  let created = 0;
  let alreadyAssigned = 0;
  let skippedNoAccess = 0;
  let skippedInactive = 0;
  const recipients: string[] = [];
  for (const [mid, src] of audience) {
    if (!active.has(mid)) {
      skippedInactive++;
      continue;
    }
    const snap = await snapshots(mid);
    if (!snap || !canReadPublished(snap, a)) {
      skippedNoAccess++;
      continue;
    }
    const prior = byMember.get(mid);
    const ack = ackBy.get(mid);
    if (prior && prior.status !== 'cancelled') {
      alreadyAssigned++;
      continue;
    }
    const values = {
      status: ack ? ('acknowledged' as const) : ('open' as const),
      acknowledgedAt: ack?.acknowledgedAt ?? null,
      dueAt,
      source: src,
      assignedByMembershipId: ctx.actor.membershipId,
      closedAt: null,
      closeReason: null,
    };
    if (prior) await ctx.tx.update(readingAssignments).set({ ...values, ...touch(ctx, readingAssignments) }).where(eq(readingAssignments.id, prior.id));
    else await ctx.tx.insert(readingAssignments).values({ ...stamp(ctx), id: newId(), articleId: a.id, articleVersionId: v!.id, membershipId: mid, ...values });
    if (ack) alreadyAssigned++;
    else {
      created++;
      recipients.push(mid);
    }
  }
  if (!a.requiredReading) await ctx.tx.update(articles).set({ requiredReading: true, ...touch(ctx, articles) }).where(eq(articles.id, a.id));
  await readingNotice(ctx, a, v!, recipients, false, dueAt);
  await audit(ctx, {
    action: 'article.reading_assigned',
    entityType: 'article',
    entityId: a.id,
    projectId: a.scopeType === 'project' ? a.scopeId : null,
    metadata: { versionNo: v!.versionNo, created, alreadyAssigned, skippedNoAccess, skippedInactive, roles: input.roleIds.length, projects: input.projectIds.length },
  });
  await emit(ctx, { type: 'article.reading_assigned', entityType: 'article', entityId: a.id, payload: { versionId: v!.id } });
  return { created, alreadyAssigned, skippedNoAccess, skippedInactive };
};

/**
 * Acknowledge Read (T083): an explicit action for the current published version — opening the
 * article never counts. Idempotent per member and version; fulfils the member's open request.
 */
export const acknowledgeArticle = async (ctx: CommandContext, id: string, input: { versionId: string }) => {
  requirePermission(ctx, 'knowledge.acknowledge');
  const a = await loadArticleRow(ctx, id, true);
  if (!a.publishedVersionId || !canReadPublished(ctx.actor.access, a)) throw notFound('Article');
  if (a.status !== 'published') throw new AppError('INVALID_STATE', 'Archived articles cannot be acknowledged.');
  if (input.versionId !== a.publishedVersionId)
    throw new AppError('INVALID_STATE', 'A newer version was published. Read the current version before acknowledging it.', { details: { currentVersionId: a.publishedVersionId } });
  const me = ctx.actor.membershipId!;
  const at = ctx.app.clock.now();
  const [v] = await ctx.tx.select({ id: articleVersions.id, versionNo: articleVersions.versionNo }).from(articleVersions).where(eq(articleVersions.id, a.publishedVersionId));
  const inserted = await ctx.tx
    .insert(articleAcknowledgements)
    .values({ ...stamp(ctx), id: newId(), articleId: a.id, articleVersionId: v!.id, membershipId: me, acknowledgedAt: at })
    .onConflictDoNothing()
    .returning();
  const [ack] = inserted.length
    ? inserted
    : await ctx.tx.select().from(articleAcknowledgements).where(and(eq(articleAcknowledgements.articleVersionId, v!.id), eq(articleAcknowledgements.membershipId, me)));
  const fulfilled = await ctx.tx
    .update(readingAssignments)
    .set({ status: 'acknowledged', acknowledgedAt: ack!.acknowledgedAt, closedAt: at, ...touch(ctx, readingAssignments) })
    .where(and(eq(readingAssignments.articleVersionId, v!.id), eq(readingAssignments.membershipId, me), eq(readingAssignments.status, 'open')))
    .returning({ id: readingAssignments.id });
  if (inserted.length) {
    await audit(ctx, { action: 'article.acknowledged', entityType: 'article', entityId: a.id, metadata: { versionNo: v!.versionNo, fulfilledRequests: fulfilled.length } });
    await emit(ctx, { type: 'article.acknowledged', entityType: 'article', entityId: a.id, payload: { versionId: v!.id } });
  }
  return { versionId: v!.id, versionNo: v!.versionNo, acknowledgedAt: ack!.acknowledgedAt.toISOString(), fulfilledRequests: fulfilled.length };
};

/** Acknowledgement requests of one article (editors and publishers of the article). */
export const listReadingStatus = async (ctx: QueryContext, id: string, input: { status?: ('open' | 'acknowledged' | 'cancelled' | 'superseded')[]; cursor?: string; pageSize?: number }) => {
  const a = await loadVisibleArticle(ctx, id);
  if (!canManage(ctx.actor.access, a) && !canManage(ctx.actor.access, a, 'knowledge.publish')) throw new AppError('FORBIDDEN', 'Only the article’s editors can see who acknowledged it.');
  const size = clampPageSize(input.pageSize);
  const c = input.cursor ? decodeCursor(input.cursor) : null;
  const rows = await dbOf(ctx)
    .select({ ra: readingAssignments, versionNo: articleVersions.versionNo })
    .from(readingAssignments)
    .innerJoin(articleVersions, eq(articleVersions.id, readingAssignments.articleVersionId))
    .where(
      and(
        eq(readingAssignments.workspaceId, ctx.actor.workspaceId),
        eq(readingAssignments.articleId, a.id),
        input.status?.length ? inArray(readingAssignments.status, input.status) : undefined,
        c
          ? or(
              sql`${readingAssignments.createdAt} < ${new Date(String(c.v[0]))}`,
              and(eq(readingAssignments.createdAt, new Date(String(c.v[0]))), sql`${readingAssignments.id} < ${c.id}`),
            )
          : undefined,
      ),
    )
    .orderBy(desc(readingAssignments.createdAt), desc(readingAssignments.id))
    .limit(size + 1);
  const hasMore = rows.length > size;
  const page = hasMore ? rows.slice(0, size) : rows;
  const refs = await loadMemberRefs(dbOf(ctx), ctx.actor.workspaceId, page.map((r) => r.ra.membershipId));
  const now = ctx.app.clock.now();
  const items = page.map(({ ra, versionNo }) => ({
    id: ra.id,
    member: refOrUnknown(refs, ra.membershipId)!,
    versionId: ra.articleVersionId,
    versionNo,
    status: ra.status,
    source: ra.source,
    dueAt: ra.dueAt?.toISOString() ?? null,
    overdue: ra.status === 'open' && !!ra.dueAt && ra.dueAt < now,
    assignedAt: ra.createdAt.toISOString(),
    acknowledgedAt: ra.acknowledgedAt?.toISOString() ?? null,
    closeReason: ra.closeReason,
  }));
  const last = page[page.length - 1];
  return { items, hasMore, nextCursor: hasMore && last ? encodeCursor({ v: [last.ra.createdAt.toISOString()], id: last.ra.id }) : null };
};

export const cancelReading = async (ctx: CommandContext, assignmentId: string, reason: string) => {
  const [ra] = await ctx.tx
    .select()
    .from(readingAssignments)
    .where(and(eq(readingAssignments.workspaceId, ctx.actor.workspaceId), eq(readingAssignments.id, assignmentId)))
    .for('update');
  if (!ra) throw notFound('Reading request');
  const a = await loadArticleRow(ctx, ra.articleId);
  if (!canManage(ctx.actor.access, a) && !canManage(ctx.actor.access, a, 'knowledge.publish')) throw notFound('Reading request');
  if (!canManage(ctx.actor.access, a, 'knowledge.publish')) throw new AppError('FORBIDDEN', 'You cannot withdraw reading requests for this article.');
  if (ra.status !== 'open') throw new AppError('INVALID_STATE', 'Only open requests can be withdrawn.');
  await ctx.tx
    .update(readingAssignments)
    .set({ status: 'cancelled', closedAt: ctx.app.clock.now(), closeReason: reason.trim(), ...touch(ctx, readingAssignments) })
    .where(eq(readingAssignments.id, ra.id));
  await audit(ctx, { action: 'article.reading_withdrawn', entityType: 'article', entityId: a.id, reason, metadata: { membershipId: ra.membershipId } });
  await emit(ctx, { type: 'article.reading_withdrawn', entityType: 'article', entityId: a.id });
  return { ok: true as const };
};

/** My Work — Required Reading: the member's own requests for articles they can still read. */
export const myReading = async (ctx: QueryContext, input: { status?: 'open' | 'acknowledged'; cursor?: string; pageSize?: number }) => {
  const me = ctx.actor.membershipId;
  if (!me || !hasAnywhere(ctx.actor.access, 'knowledge.read')) return { items: [], hasMore: false, nextCursor: null };
  const status = input.status ?? 'open';
  const size = clampPageSize(input.pageSize);
  const c = input.cursor ? decodeCursor(input.cursor) : null;
  const rows = await dbOf(ctx)
    .select({ ra: readingAssignments, a: articles, v: articleVersions, categoryName: articleCategories.name })
    .from(readingAssignments)
    .innerJoin(articles, and(eq(articles.workspaceId, readingAssignments.workspaceId), eq(articles.id, readingAssignments.articleId)))
    .innerJoin(articleVersions, eq(articleVersions.id, readingAssignments.articleVersionId))
    .innerJoin(articleCategories, eq(articleCategories.id, articles.categoryId))
    .where(
      and(
        eq(readingAssignments.workspaceId, ctx.actor.workspaceId),
        eq(readingAssignments.membershipId, me),
        eq(readingAssignments.status, status),
        eq(articles.status, 'published'),
        publishedReadVisibility(ctx),
        c
          ? or(
              sql`${readingAssignments.createdAt} < ${new Date(String(c.v[0]))}`,
              and(eq(readingAssignments.createdAt, new Date(String(c.v[0]))), sql`${readingAssignments.id} < ${c.id}`),
            )
          : undefined,
      ),
    )
    .orderBy(desc(readingAssignments.createdAt), desc(readingAssignments.id))
    .limit(size + 1);
  const hasMore = rows.length > size;
  const page = hasMore ? rows.slice(0, size) : rows;
  const now = ctx.app.clock.now();
  const items = page.map(({ ra, a, v, categoryName }) => ({
    assignmentId: ra.id,
    articleId: a.id,
    title: v.title,
    categoryName,
    versionId: v.id,
    versionNo: v.versionNo,
    revisionKind: v.revisionKind,
    status: ra.status,
    dueAt: ra.dueAt?.toISOString() ?? null,
    overdue: ra.status === 'open' && !!ra.dueAt && ra.dueAt < now,
    assignedAt: ra.createdAt.toISOString(),
    acknowledgedAt: ra.acknowledgedAt?.toISOString() ?? null,
  }));
  const last = page[page.length - 1];
  return { items, hasMore, nextCursor: hasMore && last ? encodeCursor({ v: [last.ra.createdAt.toISOString()], id: last.ra.id }) : null };
};

/** Roles that can be chosen as a reading audience, with active holders. */
export const readingAudiences = async (ctx: QueryContext) => {
  requirePermission(ctx, 'knowledge.publish');
  const at = ctx.app.clock.now();
  const rows = await dbOf(ctx)
    .select({
      id: roles.id,
      name: roles.name,
      memberCount: sql<number>`count(DISTINCT ${roleAssignments.membershipId}) FILTER (WHERE ${memberships.status} = 'active')`,
    })
    .from(roles)
    .leftJoin(
      roleAssignments,
      and(
        eq(roleAssignments.roleId, roles.id),
        isNull(roleAssignments.revokedAt),
        lte(roleAssignments.validFrom, at),
        or(isNull(roleAssignments.validTo), gt(roleAssignments.validTo, at)),
      ),
    )
    .leftJoin(memberships, eq(memberships.id, roleAssignments.membershipId))
    .where(and(eq(roles.workspaceId, ctx.actor.workspaceId), isNull(roles.archivedAt)))
    .groupBy(roles.id, roles.name)
    .orderBy(asc(roles.name));
  return { roles: rows.map((r) => ({ id: r.id, name: r.name, memberCount: Number(r.memberCount) })) };
};

/** Open reading requests of a member (deactivation impact preview). */
export const openReadingOf = async (ctx: QueryContext | CommandContext, membershipId: string) => {
  const [r] = await dbOf(ctx)
    .select({ n: count() })
    .from(readingAssignments)
    .where(and(eq(readingAssignments.workspaceId, ctx.actor.workspaceId), eq(readingAssignments.membershipId, membershipId), eq(readingAssignments.status, 'open')));
  return Number(r?.n ?? 0);
};
