import { and, eq, isNull, notInArray } from 'drizzle-orm';
import { assetLinks, assetVersions, contentItems, contentVersionAssets, projects, socialAccounts } from '@castlane/database';
import { isAppError } from '@castlane/domain';
import type { CommandContext, QueryContext } from '../core/context';
import { systemJobContext } from '../core/jobs-registry';
import { indexSearchDocument } from '../core/search';
import { accountLabel } from '../accounts/accounts';
import { linkAsset, removeAssetLink } from '../media/assets';
import type { PublicationRowDb } from './scope';

/**
 * Internal helpers of the publishing module: system sub-contexts for side effects the acting member
 * may not hold permissions for (holding file links, measurement tasks), and search indexing.
 */

/**
 * A system actor inside the caller's transaction, holding only `permissions` at workspace scope. Used
 * for effects of a permitted command that belong to other modules (e.g. a Publisher confirming a post
 * creates measurement tasks and holding file links although they cannot create tasks or link files).
 */
export const systemSubContext = async (ctx: CommandContext, permissions: string[]): Promise<CommandContext> => {
  const sys = await systemJobContext(ctx.app, ctx.actor.workspaceId, permissions, { requestId: ctx.request.requestId, causation: ctx.request.causation });
  return { ...sys, request: { ...sys.request, source: ctx.request.source }, tx: ctx.tx, emitted: ctx.emitted };
};

export const publicationTitle = async (ctx: QueryContext | CommandContext, p: Pick<PublicationRowDb, 'contentItemId' | 'accountId'>) => {
  const db = 'tx' in ctx ? ctx.tx : ctx.app.db;
  const [c] = await db.select({ title: contentItems.title }).from(contentItems).where(and(eq(contentItems.workspaceId, ctx.actor.workspaceId), eq(contentItems.id, p.contentItemId)));
  const [a] = await db.select().from(socialAccounts).where(and(eq(socialAccounts.workspaceId, ctx.actor.workspaceId), eq(socialAccounts.id, p.accountId)));
  return { title: c?.title ?? 'Content', accountLabel: a ? accountLabel(a) : 'Account', account: a ?? null };
};

/** Host and path segments of a URL as separate words, so a post can be found by its short code. */
const urlWords = (url: string | null) => {
  if (!url) return null;
  try {
    const u = new URL(url);
    return [u.hostname.replace(/^www\./, ''), ...u.pathname.split('/').filter(Boolean)].join(' ');
  } catch {
    return null;
  }
};

/** Search projection: content title + account; caption, post URL and destination are searchable text. */
export const indexPublication = async (ctx: CommandContext, p: PublicationRowDb) => {
  const t = await publicationTitle(ctx, p);
  const [proj] = await ctx.tx.select({ directionId: projects.directionId }).from(projects).where(eq(projects.id, p.projectId));
  await indexSearchDocument(ctx.tx, {
    workspaceId: ctx.actor.workspaceId,
    entityType: 'publication',
    entityId: p.id,
    title: `${t.title} — ${t.accountLabel}`,
    body: [p.caption, p.externalPostUrl, urlWords(p.externalPostUrl), p.cta, p.destinationUrl, p.descriptiveTags.join(' ')].filter(Boolean).join('\n'),
    projectId: p.projectId,
    accountId: p.accountId,
    directionId: proj?.directionId ?? null,
    permission: 'publications.read',
    ownerMembershipId: p.ownerMembershipId,
    assigneeMembershipIds: [p.ownerMembershipId],
    archived: !!p.archivedAt || !!p.deletedAt,
    status: p.status,
    at: ctx.app.clock.now(),
  });
  return t;
};

/**
 * Link the asset versions of the pinned content version to the placement, so the publisher can open
 * the approved files (F07). On Mark Published the links become holding (the exact file versions of a
 * published placement cannot be deleted). Links to previously pinned versions that never went out are
 * removed; holding links are never removed.
 */
export const syncPublicationFiles = async (ctx: CommandContext, p: Pick<PublicationRowDb, 'id'>, versionId: string | null, holding: boolean) => {
  const sys = await systemSubContext(ctx, ['assets.read', 'assets.link', 'assets.restricted.read', 'publications.read']);
  const files = versionId
    ? await ctx.tx
        .select({ assetVersionId: contentVersionAssets.assetVersionId, assetId: assetVersions.assetId })
        .from(contentVersionAssets)
        .innerJoin(assetVersions, and(eq(assetVersions.workspaceId, contentVersionAssets.workspaceId), eq(assetVersions.id, contentVersionAssets.assetVersionId)))
        .where(and(eq(contentVersionAssets.workspaceId, ctx.actor.workspaceId), eq(contentVersionAssets.contentVersionId, versionId)))
        .orderBy(contentVersionAssets.position)
    : [];
  for (const f of files) {
    try {
      await linkAsset(sys, f.assetId, { versionId: f.assetVersionId, target: { entityType: 'publication', entityId: p.id, role: 'content_version' }, holding });
    } catch (e) {
      // An archived or removed file stays reachable through the content item; the placement is still valid.
      if (!isAppError(e)) throw e;
    }
  }
  const keep = files.map((f) => f.assetVersionId);
  const stale = await ctx.tx
    .select({ id: assetLinks.id })
    .from(assetLinks)
    .where(
      and(
        eq(assetLinks.workspaceId, ctx.actor.workspaceId),
        eq(assetLinks.entityType, 'publication'),
        eq(assetLinks.entityId, p.id),
        eq(assetLinks.role, 'content_version'),
        eq(assetLinks.holding, false),
        isNull(assetLinks.removedAt),
        keep.length ? notInArray(assetLinks.assetVersionId, keep) : undefined,
      ),
    );
  for (const s of stale) await removeAssetLink(sys, s.id, 'The placement now uses another content version.');
  return files.length;
};

export const uniqueIds = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((x): x is string => !!x))];
