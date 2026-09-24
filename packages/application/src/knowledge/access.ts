import { and, eq, inArray, isNotNull, or, sql, type SQL } from 'drizzle-orm';
import { hasAnywhere, listFilter, type AccessSnapshot } from '@castlane/authorization';
import { articles, memberships } from '@castlane/database';
import { loadAccessSnapshot } from '../core/access';
import type { AppServices, QueryContext } from '../core/context';

type ArticleRow = typeof articles.$inferSelect;

/**
 * Article audience (S38/S39): a published article is read by members holding knowledge.read in
 * the article's scope —
 *   • workspace articles: anyone holding knowledge.read anywhere (regulations for the whole team);
 *   • direction articles: members whose read scope covers the direction or one of its projects;
 *   • project articles: members whose read scope covers the project (incl. via its accounts).
 * Drafts are visible only to editors (knowledge.write in the scope — workspace articles need a
 * workspace-wide grant; direction articles a direction grant) and to the article owner/author.
 */
export interface Audience {
  none: boolean;
  all: boolean;
  projectIds: string[];
  directionIds: string[];
}

export const audienceOf = (s: AccessSnapshot, permission: string, mode: 'read' | 'manage'): Audience => {
  const f = listFilter(s, permission);
  if (f.kind === 'none') return { none: true, all: false, projectIds: [], directionIds: [] };
  if (f.kind === 'all') return { none: false, all: true, projectIds: [], directionIds: [] };
  const projects = new Set(f.projectIds);
  const dirs = new Set<string>();
  if (mode === 'read') {
    for (const acc of f.accountIds) {
      const p = s.accountProject.get(acc);
      if (p) projects.add(p);
    }
    for (const p of projects) {
      const d = s.projectDirection.get(p);
      if (d) dirs.add(d);
    }
  }
  for (const g of s.grants) if (g.permissions.has(permission) && g.scopeType === 'direction' && g.scopeId) dirs.add(g.scopeId);
  for (const d of s.denies) if (d.objectType === 'direction' && d.objectId && (d.permission === permission || d.permission === '*')) dirs.delete(d.objectId);
  return { none: false, all: false, projectIds: [...projects], directionIds: [...dirs] };
};

export type ArticleScopeRef = Pick<ArticleRow, 'scopeType' | 'scopeId' | 'ownerMembershipId'> & { createdBy?: string | null };

const coveredBy = (aud: Audience, a: ArticleScopeRef, mode: 'read' | 'manage') => {
  if (aud.none) return false;
  if (aud.all) return true;
  if (a.scopeType === 'workspace') return mode === 'read';
  if (a.scopeType === 'project') return !!a.scopeId && aud.projectIds.includes(a.scopeId);
  return !!a.scopeId && aud.directionIds.includes(a.scopeId);
};

/** Readers of the published text. */
export const canReadPublished = (s: AccessSnapshot, a: ArticleScopeRef) => coveredBy(audienceOf(s, 'knowledge.read', 'read'), a, 'read');

/** Editors (drafts, metadata, archive): knowledge.write in scope, or the owner/author holding knowledge.write. */
export const canManage = (s: AccessSnapshot, a: ArticleScopeRef, permission: 'knowledge.write' | 'knowledge.publish' = 'knowledge.write') =>
  coveredBy(audienceOf(s, permission, 'manage'), a, 'manage') ||
  (hasAnywhere(s, permission) && (a.ownerMembershipId === s.membershipId || (!!a.createdBy && a.createdBy === s.userId)));

/** Anything about the article is visible (published text, or the draft for editors). */
export const canSeeArticle = (s: AccessSnapshot, a: ArticleScopeRef & { publishedVersionId: string | null }) =>
  (!!a.publishedVersionId && canReadPublished(s, a)) || canManage(s, a);

const scopeSql = (aud: Audience, mode: 'read' | 'manage'): SQL | undefined => {
  if (aud.none) return sql`false`;
  if (aud.all) return undefined;
  const parts: SQL[] = [];
  if (mode === 'read') parts.push(eq(articles.scopeType, 'workspace'));
  if (aud.projectIds.length) parts.push(and(eq(articles.scopeType, 'project'), inArray(articles.scopeId, aud.projectIds))!);
  if (aud.directionIds.length) parts.push(and(eq(articles.scopeType, 'direction'), inArray(articles.scopeId, aud.directionIds))!);
  return parts.length ? or(...parts) : sql`false`;
};

/** SQL form of `canSeeArticle` (applied before paging and counts). */
export const articleVisibility = (ctx: QueryContext): SQL | undefined => {
  const s = ctx.actor.access;
  const read = scopeSql(audienceOf(s, 'knowledge.read', 'read'), 'read');
  const manage = scopeSql(audienceOf(s, 'knowledge.write', 'manage'), 'manage');
  if (read === undefined || manage === undefined) {
    // Unrestricted readers still must not see never-published drafts of others unless they manage them.
    if (manage === undefined) return undefined;
    return or(isNotNull(articles.publishedVersionId), manage, ownOrAuthored(ctx))!;
  }
  return or(and(isNotNull(articles.publishedVersionId), read), manage, ownOrAuthored(ctx))!;
};

const ownOrAuthored = (ctx: QueryContext): SQL => {
  if (!hasAnywhere(ctx.actor.access, 'knowledge.write')) return sql`false`;
  const parts: SQL[] = [];
  if (ctx.actor.membershipId) parts.push(eq(articles.ownerMembershipId, ctx.actor.membershipId));
  if (ctx.actor.userId) parts.push(eq(articles.createdBy, ctx.actor.userId));
  return parts.length ? or(...parts)! : sql`false`;
};

/** Can the member manage articles in this scope (without the owner/author exception)? Used for create and scope changes. */
export const canManageScope = (
  s: AccessSnapshot,
  scopeType: ArticleRow['scopeType'],
  scopeId: string | null,
  permission: 'knowledge.write' | 'knowledge.publish' = 'knowledge.write',
) => coveredBy(audienceOf(s, permission, 'manage'), { scopeType, scopeId, ownerMembershipId: '' }, 'manage');

/** SQL: published articles the actor can read (acknowledgement lists, My Work). */
export const publishedReadVisibility = (ctx: QueryContext): SQL | undefined => scopeSql(audienceOf(ctx.actor.access, 'knowledge.read', 'read'), 'read');

/**
 * Access snapshots of other members (reading audiences, re-requests after a major revision).
 * Loaded on the pool with current grants; cached per call.
 */
export const memberSnapshots = (app: AppServices, workspaceId: string) => {
  const cache = new Map<string, AccessSnapshot | null>();
  return async (membershipId: string): Promise<AccessSnapshot | null> => {
    if (cache.has(membershipId)) return cache.get(membershipId)!;
    const [m] = await app.db.select({ userId: memberships.userId, status: memberships.status }).from(memberships).where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.id, membershipId)));
    const snap = m && m.status === 'active' ? await loadAccessSnapshot(app.db, workspaceId, m.userId, app.clock.now()) : null;
    cache.set(membershipId, snap && snap.membershipStatus === 'active' ? snap : null);
    return cache.get(membershipId)!;
  };
};
