import { and, asc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { listFilter } from '@castlane/authorization';
import { characters, episodes, projects, references, scenes, seasons } from '@castlane/database';
import { notFound } from '@castlane/domain';
import { allowed, requirePermission, scopePredicate, whereAll } from '../core/access';
import { defineArchiveHandler } from '../core/archive-registry';
import { dbOf, type QueryContext } from '../core/context';
import { defineLookup, likePattern } from '../core/lookup-registry';
import { defineLinkAccess } from '../media/link-access';
import { archiveCharacter, characterArchivePreview, characterScope, loadCharacter, restoreCharacter } from './characters';
import { archiveReference, canReadReference, canWriteReference, loadReference, referenceScope, restoreReference } from './references';

// ——— Pickers ———

defineLookup({
  type: 'character',
  async search(ctx, input) {
    requirePermission(ctx, 'characters.read');
    const rows = await dbOf(ctx)
      .select({ c: characters, projectName: projects.name })
      .from(characters)
      .innerJoin(projects, and(eq(projects.workspaceId, characters.workspaceId), eq(projects.id, characters.projectId)))
      .where(
        whereAll(
          eq(characters.workspaceId, ctx.actor.workspaceId),
          scopePredicate(ctx, 'characters.read', { projectId: characters.projectId }),
          input.ids?.length ? inArray(characters.id, input.ids) : undefined,
          !input.ids?.length && !input.includeArchived ? isNull(characters.archivedAt) : undefined,
          input.projectId ? eq(characters.projectId, input.projectId) : undefined,
          input.q ? ilike(characters.name, likePattern(input.q)) : undefined,
        ),
      )
      .orderBy(asc(characters.name))
      .limit(input.ids?.length ? Math.max(input.ids.length, input.limit) : input.limit);
    return rows.map(({ c, projectName }) => ({
      id: c.id,
      label: c.name,
      sublabel: [projectName, c.isPrimary ? 'Primary' : null, c.role].filter(Boolean).join(' · ') || null,
      status: c.approvedVersionId ? 'approved' : 'draft',
      projectId: c.projectId,
      archived: !!c.archivedAt,
    }));
  },
});

defineLookup({
  type: 'season',
  async search(ctx, input) {
    requirePermission(ctx, 'series.read');
    const rows = await dbOf(ctx)
      .select({ s: seasons, projectName: projects.name })
      .from(seasons)
      .innerJoin(projects, and(eq(projects.workspaceId, seasons.workspaceId), eq(projects.id, seasons.projectId)))
      .where(
        whereAll(
          eq(seasons.workspaceId, ctx.actor.workspaceId),
          scopePredicate(ctx, 'series.read', { projectId: seasons.projectId }),
          input.ids?.length ? inArray(seasons.id, input.ids) : undefined,
          !input.ids?.length && !input.includeArchived ? isNull(seasons.archivedAt) : undefined,
          input.projectId ? eq(seasons.projectId, input.projectId) : undefined,
          input.q ? ilike(seasons.name, likePattern(input.q)) : undefined,
        ),
      )
      .orderBy(asc(projects.name), asc(seasons.orderNo))
      .limit(input.ids?.length ? Math.max(input.ids.length, input.limit) : input.limit);
    return rows.map(({ s, projectName }) => ({ id: s.id, label: s.name, sublabel: projectName, status: null, projectId: s.projectId, archived: !!s.archivedAt }));
  },
});

defineLookup({
  type: 'episode',
  async search(ctx, input) {
    requirePermission(ctx, 'series.read');
    const rows = await dbOf(ctx)
      .select({ e: episodes, seasonName: seasons.name })
      .from(episodes)
      .innerJoin(seasons, and(eq(seasons.workspaceId, episodes.workspaceId), eq(seasons.id, episodes.seasonId)))
      .where(
        whereAll(
          eq(episodes.workspaceId, ctx.actor.workspaceId),
          scopePredicate(ctx, 'series.read', { projectId: episodes.projectId }),
          input.ids?.length ? inArray(episodes.id, input.ids) : undefined,
          !input.ids?.length && !input.includeArchived ? isNull(episodes.archivedAt) : undefined,
          input.projectId ? eq(episodes.projectId, input.projectId) : undefined,
          input.parentId ? eq(episodes.seasonId, input.parentId) : undefined,
          input.q ? or(ilike(episodes.title, likePattern(input.q)), sql`${episodes.number}::text = ${input.q.trim()}`) : undefined,
        ),
      )
      .orderBy(asc(seasons.orderNo), asc(episodes.number))
      .limit(input.ids?.length ? Math.max(input.ids.length, input.limit) : input.limit);
    return rows.map(({ e, seasonName }) => ({
      id: e.id,
      label: `${e.number}. ${e.title}`,
      sublabel: `${seasonName} · ${e.language.toUpperCase()}`,
      status: null,
      projectId: e.projectId,
      archived: !!e.archivedAt,
    }));
  },
});

defineLookup({
  type: 'scene',
  async search(ctx, input) {
    requirePermission(ctx, 'series.read');
    const rows = await dbOf(ctx)
      .select({ s: scenes, episodeTitle: episodes.title, episodeNumber: episodes.number })
      .from(scenes)
      .innerJoin(episodes, and(eq(episodes.workspaceId, scenes.workspaceId), eq(episodes.id, scenes.episodeId)))
      .where(
        whereAll(
          eq(scenes.workspaceId, ctx.actor.workspaceId),
          scopePredicate(ctx, 'series.read', { projectId: scenes.projectId }),
          input.ids?.length ? inArray(scenes.id, input.ids) : undefined,
          !input.ids?.length && !input.includeArchived ? isNull(scenes.archivedAt) : undefined,
          input.projectId ? eq(scenes.projectId, input.projectId) : undefined,
          input.parentId ? eq(scenes.episodeId, input.parentId) : undefined,
          input.q ? ilike(scenes.title, likePattern(input.q)) : undefined,
        ),
      )
      .orderBy(asc(episodes.number), asc(scenes.orderNo))
      .limit(input.ids?.length ? Math.max(input.ids.length, input.limit) : input.limit);
    return rows.map(({ s, episodeTitle, episodeNumber }) => ({
      id: s.id,
      label: `${s.orderNo}. ${s.title}`,
      sublabel: `Episode ${episodeNumber}: ${episodeTitle}`,
      status: null,
      projectId: s.projectId,
      archived: !!s.archivedAt,
    }));
  },
});

const referenceLookupVisibility = (ctx: QueryContext) => {
  const f = listFilter(ctx.actor.access, 'references.read');
  if (f.kind === 'all') return undefined;
  if (f.kind === 'none') return sql`false`;
  const parts = [isNull(references.projectId), eq(references.ownerMembershipId, ctx.actor.membershipId ?? '00000000-0000-4000-8000-000000000000')];
  if (f.projectIds.length) parts.push(inArray(references.projectId, f.projectIds));
  return or(...parts);
};

defineLookup({
  type: 'reference',
  async search(ctx, input) {
    requirePermission(ctx, 'references.read');
    const rows = await dbOf(ctx)
      .select({ r: references, projectName: projects.name })
      .from(references)
      .leftJoin(projects, and(eq(projects.workspaceId, references.workspaceId), eq(projects.id, references.projectId)))
      .where(
        whereAll(
          eq(references.workspaceId, ctx.actor.workspaceId),
          referenceLookupVisibility(ctx),
          input.ids?.length ? inArray(references.id, input.ids) : undefined,
          !input.ids?.length && !input.includeArchived ? isNull(references.archivedAt) : undefined,
          input.projectId ? eq(references.projectId, input.projectId) : undefined,
          input.q ? or(ilike(references.title, likePattern(input.q)), ilike(references.whatToReuse, likePattern(input.q))) : undefined,
        ),
      )
      .orderBy(asc(references.title))
      .limit(input.ids?.length ? Math.max(input.ids.length, input.limit) : input.limit);
    return rows.map(({ r, projectName }) => ({
      id: r.id,
      label: r.title,
      sublabel: [projectName ?? 'Workspace', r.tags.join(', ') || null].filter(Boolean).join(' · '),
      status: null,
      projectId: r.projectId,
      archived: !!r.archivedAt,
    }));
  },
});

// ——— Files linked to characters, episodes, scenes and references authorise through them ———

defineLinkAccess('character', {
  permission: 'characters.read',
  scope: async (ctx, id) => {
    const [c] = await dbOf(ctx).select().from(characters).where(and(eq(characters.workspaceId, ctx.actor.workspaceId), eq(characters.id, id)));
    return c ? { ...characterScope(c), label: c.name, href: `/w/${c.workspaceId}/projects/${c.projectId}/characters/${c.id}` } : null;
  },
});

defineLinkAccess('episode', {
  permission: 'series.read',
  scope: async (ctx, id) => {
    const [e] = await dbOf(ctx).select().from(episodes).where(and(eq(episodes.workspaceId, ctx.actor.workspaceId), eq(episodes.id, id)));
    return e ? { objectType: 'episode', objectId: e.id, projectId: e.projectId, label: `Episode ${e.number}: ${e.title}`, href: `/w/${e.workspaceId}/projects/${e.projectId}/series?episode=${e.id}` } : null;
  },
});

defineLinkAccess('scene', {
  permission: 'series.read',
  scope: async (ctx, id) => {
    const [s] = await dbOf(ctx).select().from(scenes).where(and(eq(scenes.workspaceId, ctx.actor.workspaceId), eq(scenes.id, id)));
    return s ? { objectType: 'scene', objectId: s.id, projectId: s.projectId, label: s.title, href: `/w/${s.workspaceId}/projects/${s.projectId}/series?episode=${s.episodeId}` } : null;
  },
});

defineLinkAccess('reference', {
  permission: 'references.read',
  scope: async (ctx, id) => {
    const [r] = await dbOf(ctx).select().from(references).where(and(eq(references.workspaceId, ctx.actor.workspaceId), eq(references.id, id)));
    if (!r || !canReadReference(ctx, r)) return null;
    const base = referenceScope(r);
    if (allowed(ctx, 'references.read', base)) return { ...base, label: r.title, href: `/w/${r.workspaceId}/references?open=${r.id}` };
    // Workspace-wide (or own) references are readable by every references.read holder (decided by
    // canReadReference above); express that with a scope one of the actor's own grants covers.
    const f = listFilter(ctx.actor.access, 'references.read');
    const covered =
      f.kind === 'scoped' && f.projectIds[0]
        ? { projectId: f.projectIds[0] }
        : f.kind === 'scoped' && f.accountIds[0]
          ? { accountId: f.accountIds[0] }
          : { ownerMembershipId: ctx.actor.membershipId, assignedMembershipIds: [ctx.actor.membershipId] };
    return { objectType: 'reference', objectId: r.id, ...covered, label: r.title, href: `/w/${r.workspaceId}/references?open=${r.id}` };
  },
});

// ——— Archive screen ———

defineArchiveHandler({
  entityType: 'character',
  label: 'Character',
  preview: characterArchivePreview,
  archive: async (ctx, id, input) => {
    await archiveCharacter(ctx, id, { reason: input.reason }, { skipVersion: true });
  },
  restorePreview: async (ctx, id) => {
    const c = await loadCharacter(ctx, id);
    if (!allowed(ctx, 'characters.read', characterScope(c))) throw notFound('Character');
    return { title: c.name, items: [] };
  },
  restore: async (ctx, id) => {
    await restoreCharacter(ctx, id, { skipVersion: true });
  },
});

defineArchiveHandler({
  entityType: 'reference',
  label: 'Reference',
  preview: async (ctx, id) => {
    const r = await loadReference(ctx, id);
    const items = canWriteReference(ctx, r) ? [] : [{ kind: 'forbidden', label: 'You cannot archive this reference', count: 1, blocking: true }];
    return { title: r.title, rowVersion: r.rowVersion, items };
  },
  archive: async (ctx, id, input) => {
    await archiveReference(ctx, id, { reason: input.reason }, { skipVersion: true });
  },
  restorePreview: async (ctx, id) => {
    const r = await loadReference(ctx, id);
    return { title: r.title, items: [] };
  },
  restore: async (ctx, id) => {
    await restoreReference(ctx, id, { skipVersion: true });
  },
});

