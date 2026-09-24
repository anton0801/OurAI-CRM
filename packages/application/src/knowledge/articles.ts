import { and, asc, count, desc, eq, gt, ilike, inArray, isNull, lt, max, or, sql, type SQL } from 'drizzle-orm';
import { hasAnywhere } from '@castlane/authorization';
import {
  articleAcknowledgements,
  articleCategories,
  articles,
  articleVersions,
  assetLinks,
  assets,
  auditEvents,
  directions,
  projects,
  readingAssignments,
  type DbOrTx,
} from '@castlane/database';
import { AppError, clampPageSize, decodeCursor, encodeCursor, newId, notFound } from '@castlane/domain';
import { emptyRichTextDoc, type ImpactItem, type RichTextDocument } from '@castlane/api-contracts';
import { allowed, requirePermission, whereAll } from '../core/access';
import { audit, diffFields } from '../core/audit';
import { all, dbOf, type CommandContext, type QueryContext } from '../core/context';
import { emit } from '../core/events';
import { isActiveMember, loadMemberRefs, refOrUnknown, type MemberRef } from '../core/members';
import { assertVersion, stamp, touch } from '../core/rows';
import { indexSearchDocument, removeSearchDocument } from '../core/search';
import { canReadAsset, listEntityFiles, loadUserMemberRefs } from '../media/assets';
import { articleVisibility, canManage, canManageScope, canReadPublished, canSeeArticle } from './access';
import { assertActiveCategory } from './categories';
import { diffDocs, normalizeDoc, pinAssetVersions, referencedAssets, wordCount } from './rich-text';

type ArticleRow = typeof articles.$inferSelect;
type VersionRow = typeof articleVersions.$inferSelect;
export type ArticleScopeType = ArticleRow['scopeType'];

/** Authorization scope object of an article (explain/deny evaluation, link access). */
export const articleObjectScope = (a: Pick<ArticleRow, 'id' | 'scopeType' | 'scopeId' | 'ownerMembershipId'>) => ({
  objectType: 'article',
  objectId: a.id,
  projectId: a.scopeType === 'project' ? a.scopeId : null,
  directionId: a.scopeType === 'direction' ? a.scopeId : null,
  ownerMembershipId: a.ownerMembershipId,
});

const DRAFT_AUDIT_SESSION_MS = 30 * 60_000;

export const loadArticleRow = async (ctx: QueryContext | CommandContext, id: string, lock = false): Promise<ArticleRow> => {
  const q = dbOf(ctx).select().from(articles).where(and(eq(articles.workspaceId, ctx.actor.workspaceId), eq(articles.id, id)));
  const [a] = lock && 'tx' in ctx ? await q.for('update') : await q;
  if (!a) throw notFound('Article');
  return a;
};

/** Load an article the actor may see (published text in scope, or the draft as editor); otherwise 404. */
export const loadVisibleArticle = async (ctx: QueryContext | CommandContext, id: string, lock = false) => {
  const a = await loadArticleRow(ctx, id, lock);
  if (!canSeeArticle(ctx.actor.access, a)) throw notFound('Article');
  return a;
};

/** Editor action on an article: 404 when invisible, 403 when visible but not manageable. */
const authorizeManage = (ctx: QueryContext, a: ArticleRow, permission: 'knowledge.write' | 'knowledge.publish' = 'knowledge.write') => {
  if (!canSeeArticle(ctx.actor.access, a)) throw notFound('Article');
  if (!canManage(ctx.actor.access, a, permission))
    throw new AppError('FORBIDDEN', permission === 'knowledge.publish' ? 'You cannot publish or assign this article.' : 'You cannot edit this article.');
};

// ——— Read models ———

const scopeLabels = async (ctx: QueryContext, rows: ArticleRow[]) => {
  const db = dbOf(ctx);
  const pids = [...new Set(rows.filter((r) => r.scopeType === 'project' && r.scopeId).map((r) => r.scopeId!))];
  const dids = [...new Set(rows.filter((r) => r.scopeType === 'direction' && r.scopeId).map((r) => r.scopeId!))];
  const [ps, ds] = await all(ctx, [
    () => (pids.length ? db.select({ id: projects.id, name: projects.name }).from(projects).where(and(eq(projects.workspaceId, ctx.actor.workspaceId), inArray(projects.id, pids))) : Promise.resolve([])),
    () => (dids.length ? db.select({ id: directions.id, name: directions.name }).from(directions).where(and(eq(directions.workspaceId, ctx.actor.workspaceId), inArray(directions.id, dids))) : Promise.resolve([])),
  ] as const);
  const names = new Map<string, string>([...ps.map((p) => [p.id, p.name] as const), ...ds.map((d) => [d.id, d.name] as const)]);
  return (a: ArticleRow) => ({
    type: a.scopeType,
    id: a.scopeId,
    label:
      a.scopeType === 'workspace'
        ? 'Whole workspace'
        : a.scopeType === 'project'
          ? allowed(ctx, 'projects.read', { projectId: a.scopeId }) ? (names.get(a.scopeId!) ?? null) : null
          : allowed(ctx, 'directions.read', { directionId: a.scopeId }) || hasAnywhere(ctx.actor.access, 'directions.read') ? (names.get(a.scopeId!) ?? null) : null,
  });
};

const rowExtras = async (ctx: QueryContext, rows: ArticleRow[]) => {
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const catIds = [...new Set(rows.map((r) => r.categoryId))];
  const pubIds = rows.map((r) => r.publishedVersionId).filter((x): x is string => !!x);
  const me = ctx.actor.membershipId;
  const [cats, pubs, mine, refs, labelOf] = await all(ctx, [
    () => (catIds.length ? db.select().from(articleCategories).where(and(eq(articleCategories.workspaceId, ws), inArray(articleCategories.id, catIds))) : Promise.resolve([])),
    () =>
      pubIds.length
        ? db.select({ id: articleVersions.id, versionNo: articleVersions.versionNo, publishedAt: articleVersions.publishedAt }).from(articleVersions).where(inArray(articleVersions.id, pubIds))
        : Promise.resolve([]),
    () =>
      pubIds.length && me
        ? db
            .select()
            .from(readingAssignments)
            .where(and(eq(readingAssignments.workspaceId, ws), eq(readingAssignments.membershipId, me), inArray(readingAssignments.articleVersionId, pubIds)))
        : Promise.resolve([]),
    () => loadMemberRefs(db, ws, rows.map((r) => r.ownerMembershipId)),
    () => scopeLabels(ctx, rows),
  ] as const);
  return {
    cats: new Map(cats.map((c) => [c.id, c])),
    pubs: new Map(pubs.map((p) => [p.id, p])),
    mine: new Map(mine.map((m) => [m.articleVersionId, m])),
    refs,
    labelOf,
  };
};

const isOverdue = (dueAt: Date | null, status: string, now: Date) => status === 'open' && !!dueAt && dueAt < now;

const toRow = (ctx: QueryContext, a: ArticleRow, x: Awaited<ReturnType<typeof rowExtras>>) => {
  const c = x.cats.get(a.categoryId);
  const pub = a.publishedVersionId ? x.pubs.get(a.publishedVersionId) : undefined;
  const mine = a.publishedVersionId ? x.mine.get(a.publishedVersionId) : undefined;
  const manage = canManage(ctx.actor.access, a);
  const now = ctx.app.clock.now();
  return {
    id: a.id,
    title: a.title,
    status: a.status,
    category: { id: a.categoryId, name: c?.name ?? 'Unknown category', archived: !!c?.archivedAt },
    scope: x.labelOf(a),
    owner: refOrUnknown(x.refs, a.ownerMembershipId)!,
    requiredReading: a.requiredReading,
    publishedVersionNo: pub?.versionNo ?? null,
    publishedAt: pub?.publishedAt?.toISOString() ?? null,
    ...(manage ? { hasDraft: !!a.draftVersionId } : {}),
    lastReviewedAt: a.lastReviewedAt?.toISOString() ?? null,
    updatedAt: a.updatedAt.toISOString(),
    rowVersion: a.rowVersion,
    myReading:
      mine && (mine.status === 'open' || mine.status === 'acknowledged')
        ? { status: mine.status, dueAt: mine.dueAt?.toISOString() ?? null, overdue: isOverdue(mine.dueAt, mine.status, now) }
        : null,
  };
};

const escapeLike = (q: string) => `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;

export interface ListArticlesInput {
  cursor?: string;
  pageSize?: number;
  q?: string;
  categoryId?: string;
  status?: ArticleRow['status'][];
  scopeType?: ArticleScopeType;
  projectId?: string;
  directionId?: string;
  ownerMembershipId?: string;
  required?: boolean;
  myReading?: 'open' | 'acknowledged';
  includeArchived?: boolean;
  sort?: 'updatedAt' | 'title';
  direction?: 'asc' | 'desc';
}

export const listArticles = async (ctx: QueryContext, input: ListArticlesInput) => {
  requirePermission(ctx, 'knowledge.read');
  const size = clampPageSize(input.pageSize);
  const sortKey = input.sort ?? 'updatedAt';
  const col: SQL | typeof articles.updatedAt = sortKey === 'title' ? sql`lower(${articles.title})` : articles.updatedAt;
  const dir = input.direction ?? (sortKey === 'title' ? 'asc' : 'desc');
  const op = sql.raw(dir === 'asc' ? '>' : '<');
  const c = input.cursor ? decodeCursor(input.cursor) : null;
  let cursorCond: SQL | undefined;
  if (c) {
    const v = sortKey === 'title' ? String(c.v[0]) : new Date(String(c.v[0]));
    cursorCond = sql`(${col} ${op} ${v} OR (${col} = ${v} AND ${articles.id} ${op} ${c.id}))`;
  }
  const me = ctx.actor.membershipId;
  const statusFilter = input.status?.length ? input.status : undefined;
  const where = whereAll(
    eq(articles.workspaceId, ctx.actor.workspaceId),
    articleVisibility(ctx),
    statusFilter ? inArray(articles.status, statusFilter) : input.includeArchived ? undefined : sql`${articles.status} <> 'archived'`,
    input.categoryId ? eq(articles.categoryId, input.categoryId) : undefined,
    input.scopeType ? eq(articles.scopeType, input.scopeType) : undefined,
    input.projectId ? and(eq(articles.scopeType, 'project'), eq(articles.scopeId, input.projectId)) : undefined,
    input.directionId ? and(eq(articles.scopeType, 'direction'), eq(articles.scopeId, input.directionId)) : undefined,
    input.ownerMembershipId ? eq(articles.ownerMembershipId, input.ownerMembershipId) : undefined,
    input.required !== undefined ? eq(articles.requiredReading, input.required) : undefined,
    input.myReading && me
      ? sql`EXISTS (SELECT 1 FROM reading_assignments ra WHERE ra.article_id = ${articles.id} AND ra.membership_id = ${me}
          AND ra.article_version_id = ${articles.publishedVersionId} AND ra.status = ${input.myReading})`
      : undefined,
    input.q
      ? or(
          ilike(articles.title, escapeLike(input.q)),
          sql`EXISTS (SELECT 1 FROM article_versions v WHERE v.id = ${articles.publishedVersionId} AND v.body_text ILIKE ${escapeLike(input.q)})`,
        )
      : undefined,
    cursorCond,
  );
  const rows = await dbOf(ctx)
    .select()
    .from(articles)
    .where(where)
    .orderBy(dir === 'asc' ? asc(col) : desc(col), dir === 'asc' ? asc(articles.id) : desc(articles.id))
    .limit(size + 1);
  const hasMore = rows.length > size;
  const page = hasMore ? rows.slice(0, size) : rows;
  const x = await rowExtras(ctx, page);
  const last = page[page.length - 1];
  const lastValue = last ? (sortKey === 'title' ? last.title.toLowerCase() : last.updatedAt.toISOString()) : null;
  return { items: page.map((a) => toRow(ctx, a, x)), hasMore, nextCursor: hasMore && last ? encodeCursor({ v: [lastValue], id: last.id }) : null };
};

const versionSummary = (v: VersionRow, userRefs: Map<string, MemberRef>, memberRefs: Map<string, MemberRef>) => ({
  id: v.id,
  versionNo: v.versionNo,
  state: v.state,
  title: v.title,
  revisionKind: v.revisionKind,
  changeNote: v.changeNote,
  publishedAt: v.publishedAt?.toISOString() ?? null,
  publishedBy: v.publishedBy ? refOrUnknown(memberRefs, v.publishedBy) : null,
  createdAt: v.createdAt.toISOString(),
  createdBy: v.createdBy ? (userRefs.get(v.createdBy) ?? null) : null,
  updatedAt: v.updatedAt.toISOString(),
  wordCount: wordCount(v.bodyText),
});

const versionRefs = async (ctx: QueryContext, vs: VersionRow[]) => {
  const db = dbOf(ctx);
  const [userRefs, memberRefs] = await all(ctx, [
    () => loadUserMemberRefs(db, ctx.actor.workspaceId, vs.map((v) => v.createdBy)),
    () => loadMemberRefs(db, ctx.actor.workspaceId, vs.map((v) => v.publishedBy)),
  ] as const);
  return { userRefs, memberRefs };
};

const versionDetail = (v: VersionRow, r: Awaited<ReturnType<typeof versionRefs>>) => ({ ...versionSummary(v, r.userRefs, r.memberRefs), body: v.body as RichTextDocument });

export const getArticle = async (ctx: QueryContext, id: string) => {
  requirePermission(ctx, 'knowledge.read');
  const a = await loadVisibleArticle(ctx, id);
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const s = ctx.actor.access;
  const manage = canManage(s, a);
  const publishRight = canManage(s, a, 'knowledge.publish');
  const readsPublished = !!a.publishedVersionId && canReadPublished(s, a);
  const me = ctx.actor.membershipId;
  const ids = [a.publishedVersionId, manage ? a.draftVersionId : null].filter((x): x is string => !!x);
  const [vs, x, [vc], myAssignments, myAck, attachments, summary] = await all(ctx, [
    () => (ids.length ? db.select().from(articleVersions).where(and(eq(articleVersions.workspaceId, ws), inArray(articleVersions.id, ids))) : Promise.resolve([] as VersionRow[])),
    () => rowExtras(ctx, [a]),
    () => db.select({ n: count() }).from(articleVersions).where(and(eq(articleVersions.workspaceId, ws), eq(articleVersions.articleId, a.id), manage ? undefined : sql`${articleVersions.state} <> 'draft'`)),
    () =>
      me
        ? db
            .select({ ra: readingAssignments, versionNo: articleVersions.versionNo })
            .from(readingAssignments)
            .innerJoin(articleVersions, eq(articleVersions.id, readingAssignments.articleVersionId))
            .where(and(eq(readingAssignments.workspaceId, ws), eq(readingAssignments.articleId, a.id), eq(readingAssignments.membershipId, me), inArray(readingAssignments.status, ['open', 'acknowledged'])))
            .orderBy(desc(articleVersions.versionNo))
            .limit(1)
        : Promise.resolve([]),
    () =>
      me
        ? db
            .select({ ack: articleAcknowledgements, versionNo: articleVersions.versionNo })
            .from(articleAcknowledgements)
            .innerJoin(articleVersions, eq(articleVersions.id, articleAcknowledgements.articleVersionId))
            .where(and(eq(articleAcknowledgements.workspaceId, ws), eq(articleAcknowledgements.articleId, a.id), eq(articleAcknowledgements.membershipId, me)))
            .orderBy(desc(articleVersions.versionNo))
            .limit(1)
        : Promise.resolve([]),
    () => listEntityFiles(ctx, 'article', a.id).catch(() => []),
    () =>
      manage || publishRight
        ? db
            .select({
              open: sql<number>`count(*) FILTER (WHERE ${readingAssignments.status} = 'open')`,
              acknowledged: sql<number>`count(*) FILTER (WHERE ${readingAssignments.status} = 'acknowledged')`,
              overdue: sql<number>`count(*) FILTER (WHERE ${readingAssignments.status} = 'open' AND ${readingAssignments.dueAt} < ${ctx.app.clock.now()})`,
            })
            .from(readingAssignments)
            .where(and(eq(readingAssignments.workspaceId, ws), eq(readingAssignments.articleId, a.id), a.publishedVersionId ? eq(readingAssignments.articleVersionId, a.publishedVersionId) : sql`false`))
        : Promise.resolve(null),
  ] as const);
  const refs = await versionRefs(ctx, vs);
  const pub = vs.find((v) => v.id === a.publishedVersionId);
  const draft = vs.find((v) => v.id === a.draftVersionId);
  const row = toRow(ctx, a, x);
  const now = ctx.app.clock.now();
  const mine = myAssignments[0];
  const ack = myAck[0];
  const published = a.status !== 'archived' && !!pub;
  return {
    ...row,
    published: pub && (readsPublished || manage) ? versionDetail(pub, refs) : null,
    ...(manage ? { draft: draft ? versionDetail(draft, refs) : null } : {}),
    myReading: mine
      ? {
          assignmentId: mine.ra.id,
          versionId: mine.ra.articleVersionId,
          versionNo: mine.versionNo,
          status: mine.ra.status,
          dueAt: mine.ra.dueAt?.toISOString() ?? null,
          assignedAt: mine.ra.createdAt.toISOString(),
          overdue: isOverdue(mine.ra.dueAt, mine.ra.status, now),
        }
      : null,
    myAcknowledgement: ack ? { versionId: ack.ack.articleVersionId, versionNo: ack.versionNo, acknowledgedAt: ack.ack.acknowledgedAt.toISOString() } : null,
    acknowledgedCurrent: !!ack && ack.ack.articleVersionId === a.publishedVersionId,
    attachments: attachments.filter((f) => f.role === 'attachment'),
    ...(summary ? { readingSummary: { open: Number(summary[0]?.open ?? 0), acknowledged: Number(summary[0]?.acknowledged ?? 0), overdue: Number(summary[0]?.overdue ?? 0) } } : {}),
    archivedAt: a.archivedAt?.toISOString() ?? null,
    versionCount: Number(vc?.n ?? 0),
    permissions: {
      edit: manage && a.status !== 'archived',
      publish: publishRight && a.status !== 'archived' && !!a.draftVersionId,
      archive: manage,
      assignReading: publishRight && published,
      acknowledge: hasAnywhere(s, 'knowledge.acknowledge') && published && readsPublished,
      createTask: published && readsPublished && hasAnywhere(s, 'tasks.create'),
      viewReadingStatus: manage || publishRight,
      attach: manage && a.status !== 'archived' && allowed(ctx, 'assets.upload', { projectId: a.scopeType === 'project' ? a.scopeId : null }),
    },
  };
};

export const listArticleVersions = async (ctx: QueryContext, id: string) => {
  const a = await loadVisibleArticle(ctx, id);
  const manage = canManage(ctx.actor.access, a);
  const vs = await dbOf(ctx)
    .select()
    .from(articleVersions)
    .where(and(eq(articleVersions.workspaceId, ctx.actor.workspaceId), eq(articleVersions.articleId, a.id), manage ? undefined : sql`${articleVersions.state} <> 'draft'`))
    .orderBy(desc(articleVersions.versionNo));
  const refs = await versionRefs(ctx, vs);
  return vs.map((v) => versionSummary(v, refs.userRefs, refs.memberRefs));
};

const loadVisibleVersion = async (ctx: QueryContext, a: ArticleRow, versionId: string) => {
  const [v] = await dbOf(ctx).select().from(articleVersions).where(and(eq(articleVersions.workspaceId, ctx.actor.workspaceId), eq(articleVersions.articleId, a.id), eq(articleVersions.id, versionId)));
  if (!v) throw notFound('Version');
  if (v.state === 'draft' && !canManage(ctx.actor.access, a)) throw notFound('Version');
  if (v.state !== 'draft' && !canReadPublished(ctx.actor.access, a) && !canManage(ctx.actor.access, a)) throw notFound('Version');
  return v;
};

export const getArticleVersion = async (ctx: QueryContext, id: string, versionId: string) => {
  const a = await loadVisibleArticle(ctx, id);
  const v = await loadVisibleVersion(ctx, a, versionId);
  return versionDetail(v, await versionRefs(ctx, [v]));
};

export const compareArticleVersions = async (ctx: QueryContext, id: string, input: { from: string; to: string }) => {
  const a = await loadVisibleArticle(ctx, id);
  const from = await loadVisibleVersion(ctx, a, input.from);
  const to = await loadVisibleVersion(ctx, a, input.to);
  const refs = await versionRefs(ctx, [from, to]);
  const d = diffDocs(from.body as RichTextDocument, to.body as RichTextDocument);
  return {
    from: versionSummary(from, refs.userRefs, refs.memberRefs),
    to: versionSummary(to, refs.userRefs, refs.memberRefs),
    titleChanged: from.title !== to.title,
    summary: { added: d.added, removed: d.removed, changed: d.changed, wordsBefore: wordCount(from.bodyText), wordsAfter: wordCount(to.bodyText) },
    changes: d.changes,
    truncated: d.truncated,
  };
};

// ——— Search & embedded files ———

/** Only the published text is searchable, in the article's scope; drafts never are. */
export const indexArticle = async (db: DbOrTx, a: ArticleRow, published: Pick<VersionRow, 'title' | 'bodyText'> | null, at: Date) => {
  if (!a.publishedVersionId || !published) {
    await removeSearchDocument(db, a.workspaceId, 'article', a.id);
    return;
  }
  await indexSearchDocument(db, {
    workspaceId: a.workspaceId,
    entityType: 'article',
    entityId: a.id,
    title: published.title,
    body: published.bodyText,
    projectId: a.scopeType === 'project' ? a.scopeId : null,
    directionId: a.scopeType === 'direction' ? a.scopeId : null,
    permission: 'knowledge.read',
    ownerMembershipId: a.ownerMembershipId,
    archived: a.status === 'archived',
    status: a.status,
    at,
  });
};

const reindex = async (ctx: CommandContext, a: ArticleRow) => {
  const [pub] = a.publishedVersionId
    ? await ctx.tx.select({ title: articleVersions.title, bodyText: articleVersions.bodyText }).from(articleVersions).where(eq(articleVersions.id, a.publishedVersionId))
    : [];
  await indexArticle(ctx.tx, a, pub ?? null, ctx.app.clock.now());
};

const bodyError = (issues: { field: string; code: string; message: string }[]) =>
  new AppError('VALIDATION_FAILED', issues[0]?.message ?? 'The article text needs attention.', { fieldErrors: issues });

/**
 * Files used in the body must be readable by the editor, non-restricted (readers would only see a
 * placeholder) and images must be images. Returns the current version of each referenced file.
 */
const validateEmbeddedAssets = async (ctx: CommandContext, doc: RichTextDocument) => {
  const refs = referencedAssets(doc);
  const current = new Map<string, string>();
  if (!refs.length) return current;
  const rows = await ctx.tx.select().from(assets).where(and(eq(assets.workspaceId, ctx.actor.workspaceId), inArray(assets.id, refs.map((r) => r.assetId))));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const issues: { field: string; code: string; message: string }[] = [];
  for (const r of refs) {
    const a = byId.get(r.assetId);
    if (!a || !(await canReadAsset(ctx, a))) {
      issues.push({ field: 'body', code: 'FILE_NOT_FOUND', message: 'A file used in the text does not exist or you cannot access it.' });
      continue;
    }
    if (a.sensitivity === 'restricted') issues.push({ field: 'body', code: 'RESTRICTED_FILE', message: `Restricted media cannot be embedded in articles (“${a.name}”).` });
    if (r.kind === 'image' && a.kind !== 'image') issues.push({ field: 'body', code: 'NOT_AN_IMAGE', message: `“${a.name}” is not an image.` });
    if (a.kind === 'external_link') issues.push({ field: 'body', code: 'EXTERNAL_LINK', message: `“${a.name}” is an external link; add it as a text link instead.` });
    if (a.currentVersionId) current.set(a.id, a.currentVersionId);
  }
  if (issues.length) throw bodyError(issues);
  return current;
};

/** Keep one non-holding 'embedded' link per file referenced by the draft or published text. */
const syncEmbeddedLinks = async (ctx: CommandContext, a: ArticleRow, docs: RichTextDocument[]) => {
  const wanted = new Set(docs.flatMap((d) => referencedAssets(d).map((r) => r.assetId)));
  const existing = await ctx.tx
    .select()
    .from(assetLinks)
    .where(and(eq(assetLinks.workspaceId, ctx.actor.workspaceId), eq(assetLinks.entityType, 'article'), eq(assetLinks.entityId, a.id), eq(assetLinks.role, 'embedded'), isNull(assetLinks.removedAt)));
  const have = new Set(existing.map((l) => l.assetId));
  const projectId = a.scopeType === 'project' ? a.scopeId : null;
  for (const id of wanted)
    if (!have.has(id)) await ctx.tx.insert(assetLinks).values({ ...stamp(ctx), id: newId(), assetId: id, entityType: 'article', entityId: a.id, role: 'embedded', projectId });
  for (const l of existing)
    if (!l.holding && !wanted.has(l.assetId))
      await ctx.tx.update(assetLinks).set({ removedAt: ctx.app.clock.now(), removedBy: ctx.actor.userId, ...touch(ctx, assetLinks) }).where(eq(assetLinks.id, l.id));
};

// ——— Commands ———

const assertScopeTarget = async (ctx: CommandContext, scopeType: ArticleScopeType, scopeId: string | null | undefined) => {
  const field = (message: string) => new AppError('VALIDATION_FAILED', message, { fieldErrors: [{ field: 'scopeId', code: 'INVALID', message }] });
  if (scopeType === 'workspace') {
    if (!canManageScope(ctx.actor.access, 'workspace', null)) throw new AppError('FORBIDDEN', 'Only workspace-wide knowledge editors can create or move articles to the whole workspace.');
    return null;
  }
  if (!scopeId) throw field(scopeType === 'project' ? 'Choose a project.' : 'Choose a direction.');
  if (scopeType === 'project') {
    const [p] = await ctx.tx.select({ id: projects.id }).from(projects).where(and(eq(projects.workspaceId, ctx.actor.workspaceId), eq(projects.id, scopeId)));
    if (!p || !allowed(ctx, 'projects.read', { projectId: scopeId })) throw field('Choose a project you can access.');
  } else {
    const [d] = await ctx.tx.select({ id: directions.id }).from(directions).where(and(eq(directions.workspaceId, ctx.actor.workspaceId), eq(directions.id, scopeId)));
    if (!d) throw field('Choose an existing direction.');
  }
  if (!canManageScope(ctx.actor.access, scopeType, scopeId)) throw new AppError('FORBIDDEN', 'You cannot manage knowledge articles in this scope.');
  return scopeId;
};

const assertOwner = async (ctx: CommandContext, membershipId: string) => {
  if (!(await isActiveMember(ctx.tx, ctx.actor.workspaceId, membershipId)))
    throw new AppError('VALIDATION_FAILED', 'The owner must be an active member.', { fieldErrors: [{ field: 'ownerMembershipId', code: 'INACTIVE', message: 'The owner must be an active member.' }] });
};

export const createArticle = async (
  ctx: CommandContext,
  input: { title: string; categoryId: string; scopeType: ArticleScopeType; scopeId?: string | null; ownerMembershipId: string; requiredReading?: boolean; body?: RichTextDocument },
) => {
  requirePermission(ctx, 'knowledge.write');
  await assertActiveCategory(ctx, input.categoryId);
  const scopeId = await assertScopeTarget(ctx, input.scopeType, input.scopeId);
  await assertOwner(ctx, input.ownerMembershipId);
  const n = normalizeDoc(input.body ?? emptyRichTextDoc());
  if (n.issues.length) throw bodyError(n.issues);
  await validateEmbeddedAssets(ctx, n.doc);
  const id = newId();
  const versionId = newId();
  const title = input.title.trim();
  await ctx.tx.insert(articles).values({
    ...stamp(ctx),
    id,
    categoryId: input.categoryId,
    title,
    scopeType: input.scopeType,
    scopeId,
    ownerMembershipId: input.ownerMembershipId,
    status: 'draft',
    requiredReading: input.requiredReading ?? false,
  });
  await ctx.tx.insert(articleVersions).values({ ...stamp(ctx), id: versionId, articleId: id, versionNo: 1, title, body: n.doc, bodyText: n.text, state: 'draft' });
  const [row] = await ctx.tx.update(articles).set({ draftVersionId: versionId }).where(eq(articles.id, id)).returning();
  await syncEmbeddedLinks(ctx, row!, [n.doc]);
  await audit(ctx, {
    action: 'article.created',
    entityType: 'article',
    entityId: id,
    projectId: row!.scopeType === 'project' ? row!.scopeId : null,
    diff: diffFields(null, row!, ['title', 'categoryId', 'scopeType', 'scopeId', 'ownerMembershipId', 'requiredReading']),
  });
  await emit(ctx, { type: 'article.created', entityType: 'article', entityId: id, revision: row!.rowVersion });
  return id;
};

/** Aggregate autosaves: one "draft saved" history entry per editing session (§33.3). */
const recentDraftAudit = async (ctx: CommandContext, articleId: string) => {
  const [r] = await ctx.tx
    .select({ id: auditEvents.id })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.workspaceId, ctx.actor.workspaceId),
        eq(auditEvents.entityType, 'article'),
        eq(auditEvents.entityId, articleId),
        eq(auditEvents.action, 'article.draft_saved'),
        ctx.actor.membershipId ? eq(auditEvents.actorMembershipId, ctx.actor.membershipId) : undefined,
        gt(auditEvents.occurredAt, new Date(ctx.app.clock.now().getTime() - DRAFT_AUDIT_SESSION_MS)),
      ),
    )
    .limit(1);
  return !!r;
};

const nextVersionNo = async (ctx: CommandContext, articleId: string) => {
  const [m] = await ctx.tx.select({ n: max(articleVersions.versionNo) }).from(articleVersions).where(eq(articleVersions.articleId, articleId));
  return Number(m?.n ?? 0) + 1;
};

/**
 * Save the draft (explicit Save Draft or autosave, If-Match). Published versions never change:
 * the first edit after publishing starts a new draft version from the published text.
 */
export const updateArticle = async (
  ctx: CommandContext,
  id: string,
  input: {
    title?: string;
    categoryId?: string;
    scopeType?: ArticleScopeType;
    scopeId?: string | null;
    ownerMembershipId?: string;
    requiredReading?: boolean;
    body?: RichTextDocument;
    autosave?: boolean;
  },
) => {
  const a = await loadArticleRow(ctx, id, true);
  authorizeManage(ctx, a);
  assertVersion(ctx, a);
  if (a.status === 'archived') throw new AppError('INVALID_STATE', 'Archived articles are read-only. Restore the article to edit it.');
  const patch: Partial<ArticleRow> = {};
  if (input.categoryId && input.categoryId !== a.categoryId) {
    await assertActiveCategory(ctx, input.categoryId);
    patch.categoryId = input.categoryId;
  }
  if (input.scopeType && (input.scopeType !== a.scopeType || (input.scopeId ?? null) !== a.scopeId)) {
    patch.scopeId = await assertScopeTarget(ctx, input.scopeType, input.scopeId);
    patch.scopeType = input.scopeType;
  }
  if (input.ownerMembershipId && input.ownerMembershipId !== a.ownerMembershipId) {
    await assertOwner(ctx, input.ownerMembershipId);
    patch.ownerMembershipId = input.ownerMembershipId;
  }
  if (input.requiredReading !== undefined && input.requiredReading !== a.requiredReading) patch.requiredReading = input.requiredReading;

  let contentChanged = false;
  if (input.title !== undefined || input.body !== undefined) {
    let draft: VersionRow | undefined;
    if (a.draftVersionId) [draft] = await ctx.tx.select().from(articleVersions).where(eq(articleVersions.id, a.draftVersionId)).for('update');
    let base: VersionRow | undefined = draft;
    if (!draft && a.publishedVersionId) [base] = await ctx.tx.select().from(articleVersions).where(eq(articleVersions.id, a.publishedVersionId));
    const title = (input.title ?? base?.title ?? a.title).trim();
    const n = normalizeDoc(input.body ?? ((base?.body as RichTextDocument | undefined) ?? emptyRichTextDoc()));
    if (n.issues.length) throw bodyError(n.issues);
    await validateEmbeddedAssets(ctx, n.doc);
    if (draft) {
      contentChanged = draft.title !== title || JSON.stringify(draft.body) !== JSON.stringify(n.doc);
      if (contentChanged)
        await ctx.tx.update(articleVersions).set({ title, body: n.doc, bodyText: n.text, ...touch(ctx, articleVersions) }).where(eq(articleVersions.id, draft.id));
    } else {
      const vid = newId();
      await ctx.tx.insert(articleVersions).values({ ...stamp(ctx), id: vid, articleId: a.id, versionNo: await nextVersionNo(ctx, a.id), title, body: n.doc, bodyText: n.text, state: 'draft' });
      patch.draftVersionId = vid;
      contentChanged = true;
    }
    // The list title follows the draft until the first publication, then the published version.
    if (!a.publishedVersionId && title !== a.title) patch.title = title;
    const docs = [n.doc];
    if (a.publishedVersionId) {
      const [pub] = await ctx.tx.select({ body: articleVersions.body }).from(articleVersions).where(eq(articleVersions.id, a.publishedVersionId));
      if (pub) docs.push(pub.body as RichTextDocument);
    }
    await syncEmbeddedLinks(ctx, { ...a, ...patch }, docs);
  }
  const [row] = await ctx.tx.update(articles).set({ ...patch, ...touch(ctx, articles) }).where(eq(articles.id, id)).returning();
  const metaDiff = diffFields(a, row!, ['categoryId', 'scopeType', 'scopeId', 'ownerMembershipId', 'requiredReading']);
  if (Object.keys(metaDiff).length)
    await audit(ctx, {
      action: patch.scopeType ? 'article.scope_changed' : 'article.updated',
      entityType: 'article',
      entityId: id,
      projectId: row!.scopeType === 'project' ? row!.scopeId : null,
      diff: metaDiff,
    });
  if (contentChanged && !(input.autosave && (await recentDraftAudit(ctx, id))))
    await audit(ctx, { action: 'article.draft_saved', entityType: 'article', entityId: id, projectId: row!.scopeType === 'project' ? row!.scopeId : null, metadata: { autosave: !!input.autosave } });
  await emit(ctx, { type: 'article.updated', entityType: 'article', entityId: id, revision: row!.rowVersion });
  if (patch.scopeType || patch.ownerMembershipId) await reindex(ctx, row!);
  return id;
};

/** Discard the unpublished draft of a published article (a never-published draft is archived instead). */
export const discardDraft = async (ctx: CommandContext, id: string) => {
  const a = await loadArticleRow(ctx, id, true);
  authorizeManage(ctx, a);
  assertVersion(ctx, a);
  if (!a.draftVersionId) throw new AppError('INVALID_STATE', 'There is no draft to discard.');
  if (!a.publishedVersionId) throw new AppError('INVALID_STATE', 'This article was never published. Archive it instead of discarding the draft.');
  const [draft] = await ctx.tx.select().from(articleVersions).where(eq(articleVersions.id, a.draftVersionId)).for('update');
  const [row] = await ctx.tx.update(articles).set({ draftVersionId: null, ...touch(ctx, articles) }).where(eq(articles.id, id)).returning();
  if (draft && draft.state === 'draft') await ctx.tx.delete(articleVersions).where(and(eq(articleVersions.id, draft.id), eq(articleVersions.state, 'draft')));
  const [pub] = await ctx.tx.select({ body: articleVersions.body }).from(articleVersions).where(eq(articleVersions.id, a.publishedVersionId));
  await syncEmbeddedLinks(ctx, row!, pub ? [pub.body as RichTextDocument] : []);
  await audit(ctx, { action: 'article.draft_discarded', entityType: 'article', entityId: id, metadata: { versionNo: draft?.versionNo ?? null } });
  await emit(ctx, { type: 'article.updated', entityType: 'article', entityId: id, revision: row!.rowVersion });
  return id;
};

/** Revert creates a new draft from an earlier version (§14); history is never rewritten. */
export const revertArticle = async (ctx: CommandContext, id: string, input: { versionId: string }) => {
  const a = await loadArticleRow(ctx, id, true);
  authorizeManage(ctx, a);
  assertVersion(ctx, a);
  if (a.status === 'archived') throw new AppError('INVALID_STATE', 'Restore the article before reverting.');
  const [src] = await ctx.tx.select().from(articleVersions).where(and(eq(articleVersions.articleId, a.id), eq(articleVersions.id, input.versionId)));
  if (!src) throw notFound('Version');
  if (src.state === 'draft') throw new AppError('INVALID_STATE', 'Choose a published version to revert to.');
  let draftId = a.draftVersionId;
  if (draftId) {
    await ctx.tx.update(articleVersions).set({ title: src.title, body: src.body, bodyText: src.bodyText, ...touch(ctx, articleVersions) }).where(eq(articleVersions.id, draftId));
  } else {
    draftId = newId();
    await ctx.tx.insert(articleVersions).values({ ...stamp(ctx), id: draftId, articleId: a.id, versionNo: await nextVersionNo(ctx, a.id), title: src.title, body: src.body, bodyText: src.bodyText, state: 'draft' });
  }
  const [row] = await ctx.tx.update(articles).set({ draftVersionId: draftId, ...touch(ctx, articles) }).where(eq(articles.id, id)).returning();
  await audit(ctx, { action: 'article.reverted', entityType: 'article', entityId: id, metadata: { fromVersionNo: src.versionNo } });
  await emit(ctx, { type: 'article.updated', entityType: 'article', entityId: id, revision: row!.rowVersion });
  return id;
};

export interface PublishHooks {
  /** Carries/renews reading requests for the new version (reading.ts). */
  afterPublish: (ctx: CommandContext, a: ArticleRow, v: VersionRow, previousPublishedId: string | null) => Promise<{ rerequested: number; carried: number }>;
}

let publishHooks: PublishHooks | null = null;
export const setPublishHooks = (h: PublishHooks) => {
  publishHooks = h;
};

/**
 * Publish Version (T082): the draft becomes a frozen published version (files pinned to their
 * current stored version and held by holding links), the previous published version is
 * superseded, and further edits start a new draft. Major revisions of required reading create new
 * acknowledgement requests; earlier acknowledgements stay (T084).
 */
export const publishArticle = async (ctx: CommandContext, id: string, input: { versionId: string; revisionKind: 'major' | 'minor'; changeNote?: string }) => {
  const a = await loadArticleRow(ctx, id, true);
  authorizeManage(ctx, a, 'knowledge.publish');
  assertVersion(ctx, a);
  if (a.status === 'archived') throw new AppError('INVALID_STATE', 'Restore the article before publishing.');
  if (!a.draftVersionId || a.draftVersionId !== input.versionId)
    throw new AppError('INVALID_STATE', 'Only the current draft can be published. Reload the article.', { details: { draftVersionId: a.draftVersionId } });
  const [draft] = await ctx.tx.select().from(articleVersions).where(eq(articleVersions.id, a.draftVersionId)).for('update');
  if (!draft || draft.state !== 'draft') throw new AppError('INVALID_STATE', 'This version was already published.');
  if (!draft.bodyText.trim())
    throw new AppError('VALIDATION_FAILED', 'Add content before publishing.', { fieldErrors: [{ field: 'body', code: 'REQUIRED', message: 'Add content before publishing.' }] });
  const current = await validateEmbeddedAssets(ctx, draft.body as RichTextDocument);
  const missing = referencedAssets(draft.body as RichTextDocument).filter((r) => !r.versionId && !current.has(r.assetId));
  if (missing.length)
    throw new AppError('VALIDATION_FAILED', 'A file used in the text is still being checked. Publish when it is available.', {
      fieldErrors: [{ field: 'body', code: 'FILE_NOT_READY', message: 'A file used in the text is still being checked.' }],
    });
  const pinned = pinAssetVersions(draft.body as RichTextDocument, current);
  const at = ctx.app.clock.now();
  const [v] = await ctx.tx
    .update(articleVersions)
    .set({
      body: pinned,
      state: 'published',
      revisionKind: input.revisionKind,
      changeNote: input.changeNote?.trim() || null,
      publishedAt: at,
      publishedBy: ctx.actor.membershipId,
      ...touch(ctx, articleVersions),
    })
    .where(eq(articleVersions.id, draft.id))
    .returning();
  const previous = a.publishedVersionId;
  if (previous) await ctx.tx.update(articleVersions).set({ state: 'superseded', ...touch(ctx, articleVersions) }).where(eq(articleVersions.id, previous));
  const [row] = await ctx.tx
    .update(articles)
    .set({ title: v!.title, status: 'published', publishedVersionId: v!.id, draftVersionId: null, lastReviewedAt: at, ...touch(ctx, articles) })
    .where(eq(articles.id, id))
    .returning();
  // The published version holds exactly the file versions it shows.
  const projectId = row!.scopeType === 'project' ? row!.scopeId : null;
  for (const r of referencedAssets(pinned)) {
    if (!r.versionId) continue;
    const [exists] = await ctx.tx
      .select({ id: assetLinks.id })
      .from(assetLinks)
      .where(
        and(
          eq(assetLinks.workspaceId, ctx.actor.workspaceId),
          eq(assetLinks.entityType, 'article'),
          eq(assetLinks.entityId, id),
          eq(assetLinks.assetId, r.assetId),
          eq(assetLinks.assetVersionId, r.versionId),
          eq(assetLinks.holding, true),
          isNull(assetLinks.removedAt),
        ),
      );
    if (!exists)
      await ctx.tx.insert(assetLinks).values({ ...stamp(ctx), id: newId(), assetId: r.assetId, assetVersionId: r.versionId, entityType: 'article', entityId: id, role: 'embedded', projectId, holding: true });
  }
  await syncEmbeddedLinks(ctx, row!, [pinned]);
  const reading = publishHooks ? await publishHooks.afterPublish(ctx, row!, v!, previous) : { rerequested: 0, carried: 0 };
  await audit(ctx, {
    action: 'article.published',
    entityType: 'article',
    entityId: id,
    projectId,
    metadata: { versionNo: v!.versionNo, revisionKind: input.revisionKind, reReadingRequests: reading.rerequested, carriedRequests: reading.carried },
  });
  await emit(ctx, { type: 'article.published', entityType: 'article', entityId: id, revision: row!.rowVersion, payload: { versionId: v!.id, revisionKind: input.revisionKind } });
  await indexArticle(ctx.tx, row!, v!, at);
  return id;
};

export const markArticleReviewed = async (ctx: CommandContext, id: string, input: { note?: string }) => {
  const a = await loadArticleRow(ctx, id, true);
  authorizeManage(ctx, a, 'knowledge.publish');
  assertVersion(ctx, a);
  if (a.status !== 'published') throw new AppError('INVALID_STATE', 'Only published articles can be marked as reviewed.');
  const [row] = await ctx.tx.update(articles).set({ lastReviewedAt: ctx.app.clock.now(), ...touch(ctx, articles) }).where(eq(articles.id, id)).returning();
  await audit(ctx, { action: 'article.reviewed', entityType: 'article', entityId: id, reason: input.note?.trim() || null });
  await emit(ctx, { type: 'article.updated', entityType: 'article', entityId: id, revision: row!.rowVersion });
  return id;
};

const openRequests = async (ctx: QueryContext | CommandContext, articleId: string) => {
  const [r] = await dbOf(ctx)
    .select({ n: count() })
    .from(readingAssignments)
    .where(and(eq(readingAssignments.workspaceId, ctx.actor.workspaceId), eq(readingAssignments.articleId, articleId), eq(readingAssignments.status, 'open')));
  return Number(r?.n ?? 0);
};

export const articleArchivePreview = async (ctx: QueryContext, id: string) => {
  const a = await loadVisibleArticle(ctx, id);
  authorizeManage(ctx, a);
  const items: ImpactItem[] = [];
  const open = await openRequests(ctx, a.id);
  if (open) items.push({ kind: 'open_reading', label: 'Open reading requests (will be withdrawn)', count: open, blocking: false, resolution: 'Acknowledgements already given are kept.' });
  if (a.draftVersionId && a.publishedVersionId) items.push({ kind: 'draft', label: 'Unpublished draft (kept, read-only)', count: 1, blocking: false });
  return { title: a.title, rowVersion: a.rowVersion, items };
};

export const archiveArticle = async (ctx: CommandContext, id: string, input: { reason?: string }, opts: { skipVersion?: boolean } = {}) => {
  const a = await loadArticleRow(ctx, id, true);
  authorizeManage(ctx, a);
  if (!opts.skipVersion) assertVersion(ctx, a);
  if (a.status === 'archived') return id;
  const at = ctx.app.clock.now();
  const [row] = await ctx.tx
    .update(articles)
    .set({ status: 'archived', archivedAt: at, archivedBy: ctx.actor.userId, archiveReason: input.reason?.trim() || null, ...touch(ctx, articles) })
    .where(eq(articles.id, id))
    .returning();
  const closed = await ctx.tx
    .update(readingAssignments)
    .set({ status: 'cancelled', closedAt: at, closeReason: 'Article archived', ...touch(ctx, readingAssignments) })
    .where(and(eq(readingAssignments.workspaceId, ctx.actor.workspaceId), eq(readingAssignments.articleId, id), eq(readingAssignments.status, 'open')))
    .returning({ id: readingAssignments.id });
  await audit(ctx, { action: 'article.archived', entityType: 'article', entityId: id, reason: input.reason, metadata: { withdrawnRequests: closed.length } });
  await emit(ctx, { type: 'article.archived', entityType: 'article', entityId: id, revision: row!.rowVersion });
  await reindex(ctx, row!);
  return id;
};

export const restoreArticle = async (ctx: CommandContext, id: string, opts: { skipVersion?: boolean } = {}) => {
  const a = await loadArticleRow(ctx, id, true);
  authorizeManage(ctx, a);
  if (!opts.skipVersion) assertVersion(ctx, a);
  if (a.status !== 'archived') throw new AppError('INVALID_STATE', 'This article is not archived.');
  const [row] = await ctx.tx
    .update(articles)
    .set({ status: a.publishedVersionId ? 'published' : 'draft', archivedAt: null, archivedBy: null, archiveReason: null, ...touch(ctx, articles) })
    .where(eq(articles.id, id))
    .returning();
  await audit(ctx, { action: 'article.restored', entityType: 'article', entityId: id });
  await emit(ctx, { type: 'article.restored', entityType: 'article', entityId: id, revision: row!.rowVersion });
  await reindex(ctx, row!);
  return id;
};
