import { and, asc, count, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { hasAnywhere, listFilter } from '@castlane/authorization';
import { assets, assetVersions, characters, contentItems, projects, referenceLinks, references } from '@castlane/database';
import { AppError, newId, notFound, parseSafeUrl, REFERENCE_TAGS } from '@castlane/domain';
import { allowed, requirePermission, whereAll } from '../core/access';
import { audit, diffFields } from '../core/audit';
import { dbOf, type CommandContext, type QueryContext } from '../core/context';
import { emit } from '../core/events';
import { loadMemberRefs, refOrUnknown } from '../core/members';
import { assertVersion, lockById, stamp, touch } from '../core/rows';
import { indexSearchDocument } from '../core/search';
import { linkAsset } from '../media/assets';
import { assertAssetUsable, finishPage, keysetWhere, likeOf, pageSizeOf, projectNames, type SortKind } from '../accounts/helpers';
import { projectScopeOf } from './common';
import { createIdeaDraftFromReference } from './reference-idea';

/**
 * References (S21). A link is stored as a note and never downloaded (T034); a preview comes only
 * from an uploaded image. Workspace-wide references (no project) are visible to every member who
 * holds references.read; project references follow the project scope. Used references are
 * archived, never deleted; linked content keeps the reference id.
 */

export type ReferenceRow = typeof references.$inferSelect;
type ReferenceTag = (typeof REFERENCE_TAGS)[number];

export const referenceScope = (r: Pick<ReferenceRow, 'id' | 'projectId' | 'ownerMembershipId'>) => ({
  objectType: 'reference',
  objectId: r.id,
  projectId: r.projectId,
  ownerMembershipId: r.ownerMembershipId,
  assignedMembershipIds: [r.ownerMembershipId],
});

export const canReadReference = (ctx: QueryContext, r: ReferenceRow) =>
  allowed(ctx, 'references.read', referenceScope(r)) ||
  ((r.projectId === null || r.ownerMembershipId === ctx.actor.membershipId) && hasAnywhere(ctx.actor.access, 'references.read'));

export const canWriteReference = (ctx: QueryContext, r: ReferenceRow) =>
  allowed(ctx, 'references.write', referenceScope(r)) || (r.ownerMembershipId === ctx.actor.membershipId && hasAnywhere(ctx.actor.access, 'references.write'));

const referenceVisibility = (ctx: QueryContext): SQL | undefined => {
  const f = listFilter(ctx.actor.access, 'references.read');
  if (f.kind === 'all') return undefined;
  if (f.kind === 'none') return sql`false`;
  const parts: SQL[] = [isNull(references.projectId), eq(references.ownerMembershipId, ctx.actor.membershipId ?? '00000000-0000-4000-8000-000000000000')];
  if (f.projectIds.length) parts.push(inArray(references.projectId, f.projectIds));
  return or(...parts);
};

export const loadReference = async (ctx: QueryContext | CommandContext, id: string, opts: { lock?: boolean } = {}) => {
  const row =
    opts.lock && 'tx' in ctx
      ? await lockById(ctx, references, id, 'Reference')
      : (await dbOf(ctx).select().from(references).where(and(eq(references.workspaceId, ctx.actor.workspaceId), eq(references.id, id))))[0];
  if (!row || !canReadReference(ctx, row)) throw notFound('Reference');
  return row;
};

const authorizeWrite = (ctx: QueryContext, r: ReferenceRow) => {
  if (!canWriteReference(ctx, r)) throw new AppError('FORBIDDEN', 'You cannot change this reference.');
};

// ——— Read models ———

const rowsToViews = async (ctx: QueryContext | CommandContext, rows: ReferenceRow[]) => {
  if (!rows.length) return [];
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const ids = rows.map((r) => r.id);
  const assetIds = rows.map((r) => r.sourceAssetId).filter((x): x is string => !!x);
  const previewIds = rows.map((r) => r.previewAssetVersionId).filter((x): x is string => !!x);
  const usage = await db
    .select({ referenceId: referenceLinks.referenceId, targetType: referenceLinks.targetType, n: count() })
    .from(referenceLinks)
    .where(and(eq(referenceLinks.workspaceId, ws), inArray(referenceLinks.referenceId, ids)))
    .groupBy(referenceLinks.referenceId, referenceLinks.targetType);
  const sourceAssets = assetIds.length ? await db.select().from(assets).where(and(eq(assets.workspaceId, ws), inArray(assets.id, assetIds))) : [];
  const previews = previewIds.length
    ? await db.select({ id: assetVersions.id, assetId: assetVersions.assetId }).from(assetVersions).where(and(eq(assetVersions.workspaceId, ws), inArray(assetVersions.id, previewIds)))
    : [];
  const names = await projectNames(ctx, rows.map((r) => r.projectId));
  const refs = await loadMemberRefs(db, ws, rows.map((r) => r.ownerMembershipId));
  return rows.map((r) => {
    const u = (t: string) => Number(usage.find((x) => x.referenceId === r.id && x.targetType === t)?.n ?? 0);
    const src = sourceAssets.find((a) => a.id === r.sourceAssetId);
    const prev = previews.find((p) => p.id === r.previewAssetVersionId);
    const p = r.projectId ? names.get(r.projectId) : null;
    return {
      id: r.id,
      title: r.title,
      sourceUrl: r.sourceUrl,
      sourceAsset: src ? { id: src.id, name: src.name, kind: src.kind, restricted: src.sensitivity === 'restricted' } : null,
      previewUrl: prev ? `/api/v1/workspaces/${ws}/assets/${prev.assetId}/thumbnail?size=320&versionId=${prev.id}` : null,
      previewAssetId: prev?.assetId ?? null,
      whatToReuse: r.whatToReuse,
      notes: r.notes,
      tags: r.tags.filter((t): t is ReferenceTag => (REFERENCE_TAGS as readonly string[]).includes(t)),
      project: p ? { id: p.id, name: p.name } : null,
      author: refOrUnknown(refs, r.ownerMembershipId)!,
      usage: { projects: u('project'), characters: u('character'), content: u('content_item') },
      archivedAt: r.archivedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      rowVersion: r.rowVersion,
    };
  });
};

export interface ListReferencesInput {
  cursor?: string;
  pageSize?: number;
  q?: string;
  tag?: ReferenceTag[];
  projectId?: string;
  characterId?: string;
  ownerMembershipId?: string;
  includeArchived?: boolean;
  sort: 'updatedAt' | 'title' | 'createdAt';
  direction: 'asc' | 'desc';
}

const SORTS: Record<ListReferencesInput['sort'], { expr: SQL; kind: SortKind; value: (r: ReferenceRow) => string }> = {
  updatedAt: { expr: sql`${references.updatedAt}`, kind: 'timestamp', value: (r) => r.updatedAt.toISOString() },
  createdAt: { expr: sql`${references.createdAt}`, kind: 'timestamp', value: (r) => r.createdAt.toISOString() },
  title: { expr: sql`lower(${references.title})`, kind: 'text', value: (r) => r.title.toLowerCase() },
};

export const listReferences = async (ctx: QueryContext, input: ListReferencesInput) => {
  requirePermission(ctx, 'references.read');
  const size = pageSizeOf(input.pageSize);
  const s = SORTS[input.sort];
  const where = whereAll(
    eq(references.workspaceId, ctx.actor.workspaceId),
    referenceVisibility(ctx),
    input.includeArchived ? undefined : isNull(references.archivedAt),
    input.tag?.length ? sql`${references.tags} && ${sql`ARRAY[${sql.join(input.tag.map((t) => sql`${t}`), sql`, `)}]::text[]`}` : undefined,
    input.projectId
      ? or(
          eq(references.projectId, input.projectId),
          sql`EXISTS (SELECT 1 FROM reference_links rl WHERE rl.reference_id = ${references.id} AND rl.target_type = 'project' AND rl.target_id = ${input.projectId}::uuid)`,
        )
      : undefined,
    input.characterId
      ? sql`EXISTS (SELECT 1 FROM reference_links rl WHERE rl.reference_id = ${references.id} AND rl.target_type = 'character' AND rl.target_id = ${input.characterId}::uuid)`
      : undefined,
    input.ownerMembershipId ? eq(references.ownerMembershipId, input.ownerMembershipId) : undefined,
    input.q ? or(sql`${references.title} ILIKE ${likeOf(input.q)}`, sql`${references.whatToReuse} ILIKE ${likeOf(input.q)}`, sql`${references.notes} ILIKE ${likeOf(input.q)}`) : undefined,
    keysetWhere(s.expr, references.id, input.direction, input.cursor, s.kind),
  );
  const rows = await ctx.app.db
    .select()
    .from(references)
    .where(where)
    .orderBy(input.direction === 'asc' ? asc(s.expr) : desc(s.expr), input.direction === 'asc' ? asc(references.id) : desc(references.id))
    .limit(size + 1);
  return finishPage(rows, size, s.value, (page) => rowsToViews(ctx, page));
};

/** Links are listed only where the actor can read the target; others are counted, not named. */
const linkViews = async (ctx: QueryContext | CommandContext, r: ReferenceRow) => {
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const links = await db.select().from(referenceLinks).where(and(eq(referenceLinks.workspaceId, ws), eq(referenceLinks.referenceId, r.id))).orderBy(asc(referenceLinks.createdAt));
  const ids = (t: string) => links.filter((l) => l.targetType === t).map((l) => l.targetId);
  const [projectRows, characterRows, contentRows] = [
    ids('project').length ? await db.select().from(projects).where(and(eq(projects.workspaceId, ws), inArray(projects.id, ids('project')))) : [],
    ids('character').length ? await db.select().from(characters).where(and(eq(characters.workspaceId, ws), inArray(characters.id, ids('character')))) : [],
    ids('content_item').length ? await db.select().from(contentItems).where(and(eq(contentItems.workspaceId, ws), inArray(contentItems.id, ids('content_item')))) : [],
  ];
  const out: { id: string; targetType: 'project' | 'content_item' | 'character'; targetId: string; kind: 'link' | 'idea'; label: string; sublabel: string | null; href: string; createdAt: string }[] = [];
  let hidden = 0;
  for (const l of links) {
    const base = { id: l.id, targetType: l.targetType, targetId: l.targetId, kind: l.kind, createdAt: l.createdAt.toISOString() };
    if (l.targetType === 'project') {
      const p = projectRows.find((x) => x.id === l.targetId);
      if (p && !p.deletedAt && allowed(ctx, 'projects.read', projectScopeOf(p))) out.push({ ...base, label: p.name, sublabel: 'Project', href: `/w/${ws}/projects/${p.id}` });
      else hidden++;
    } else if (l.targetType === 'character') {
      const c = characterRows.find((x) => x.id === l.targetId);
      if (c && allowed(ctx, 'characters.read', { projectId: c.projectId })) out.push({ ...base, label: c.name, sublabel: 'Character', href: `/w/${ws}/projects/${c.projectId}/characters/${c.id}` });
      else hidden++;
    } else {
      const c = contentRows.find((x) => x.id === l.targetId);
      if (c && !c.deletedAt && allowed(ctx, 'content.read', { projectId: c.projectId, assignedMembershipIds: [c.ownerMembershipId, c.reviewerMembershipId], ownerMembershipId: c.ownerMembershipId }))
        out.push({ ...base, label: c.title, sublabel: `Content · ${c.stage}`, href: `/w/${ws}/content/${c.id}` });
      else hidden++;
    }
  }
  const ideaLink = links.find((l) => l.kind === 'idea');
  const idea = ideaLink ? contentRows.find((c) => c.id === ideaLink.targetId) : undefined;
  const ideaVisible = idea && out.some((o) => o.targetId === idea.id);
  return { links: out, hidden, idea: idea && ideaVisible ? { contentItemId: idea.id, title: idea.title, stage: idea.stage } : null };
};

export const getReference = async (ctx: QueryContext | CommandContext, id: string) => {
  const r = await loadReference(ctx, id);
  const [view] = await rowsToViews(ctx, [r]);
  const l = await linkViews(ctx, r);
  const canWrite = canWriteReference(ctx, r);
  return {
    ...view!,
    links: l.links,
    hiddenLinkCount: l.hidden,
    idea: l.idea,
    permissions: { update: canWrite && !r.archivedAt, archive: canWrite, createIdea: canWrite && !r.archivedAt && hasAnywhere(ctx.actor.access, 'content.create') },
  };
};

// ——— Commands ———

const indexReference = (ctx: CommandContext, r: ReferenceRow) =>
  indexSearchDocument(ctx.tx, {
    workspaceId: ctx.actor.workspaceId,
    entityType: 'reference',
    entityId: r.id,
    title: r.title,
    body: [r.whatToReuse, r.notes, r.tags.join(' '), r.sourceUrl].filter(Boolean).join('\n'),
    projectId: r.projectId,
    permission: 'references.read',
    ownerMembershipId: r.ownerMembershipId,
    assigneeMembershipIds: [r.ownerMembershipId],
    archived: !!r.archivedAt,
    thumbnailAssetId: null,
    at: ctx.app.clock.now(),
  });

export interface ReferenceInput {
  title?: string;
  sourceUrl?: string | null;
  sourceAssetId?: string | null;
  previewAssetId?: string | null;
  whatToReuse?: string;
  notes?: string | null;
  tags?: ReferenceTag[];
  projectId?: string | null;
}

const checkUrl = (url: string | null | undefined) => {
  if (!url) return null;
  // The link is a note: validated for scheme safety only, never fetched by the server.
  const u = parseSafeUrl(url);
  if (!u) throw new AppError('VALIDATION_FAILED', 'Enter a valid http(s) link.', { fieldErrors: [{ field: 'sourceUrl', code: 'INVALID_URL', message: 'Enter a valid http(s) link.' }] });
  return url.trim();
};

const checkProject = async (ctx: CommandContext, projectId: string | null | undefined) => {
  if (!projectId) return null;
  const [p] = await ctx.tx.select().from(projects).where(and(eq(projects.workspaceId, ctx.actor.workspaceId), eq(projects.id, projectId)));
  if (!p || p.deletedAt || !allowed(ctx, 'references.write', projectScopeOf(p)))
    throw new AppError('VALIDATION_FAILED', 'Choose a project where you can add references.', { fieldErrors: [{ field: 'projectId', code: 'INVALID', message: 'Choose a project where you can add references.' }] });
  if (p.status === 'archived') throw new AppError('VALIDATION_FAILED', 'This project is archived.', { fieldErrors: [{ field: 'projectId', code: 'ARCHIVED', message: 'This project is archived.' }] });
  return p.id;
};

const resolvePreview = async (ctx: CommandContext, input: { sourceAssetId?: string | null; previewAssetId?: string | null }) => {
  let source: typeof assets.$inferSelect | null = null;
  if (input.sourceAssetId) source = await assertAssetUsable(ctx, input.sourceAssetId, 'sourceAssetId');
  if (input.previewAssetId) {
    const preview = await assertAssetUsable(ctx, input.previewAssetId, 'previewAssetId', { imageOnly: true });
    return { source, preview, previewVersionId: preview.currentVersionId };
  }
  // Preview only from an uploaded image: a source image doubles as its own preview.
  if (source && source.kind === 'image') return { source, preview: source, previewVersionId: source.currentVersionId };
  return { source, preview: null, previewVersionId: null };
};

const linkFiles = async (ctx: CommandContext, referenceId: string, files: Awaited<ReturnType<typeof resolvePreview>>) => {
  if (files.source) await linkAsset(ctx, files.source.id, { target: { entityType: 'reference', entityId: referenceId, role: 'source' } });
  if (files.preview && files.preview.id !== files.source?.id) await linkAsset(ctx, files.preview.id, { target: { entityType: 'reference', entityId: referenceId, role: 'preview' } });
};

const cleanTags = (tags: ReferenceTag[] | undefined) => [...new Set(tags ?? [])];

export const createReference = async (ctx: CommandContext, input: ReferenceInput & { title: string; whatToReuse: string }) => {
  requirePermission(ctx, 'references.write');
  const sourceUrl = checkUrl(input.sourceUrl);
  if (!sourceUrl && !input.sourceAssetId)
    throw new AppError('VALIDATION_FAILED', 'Add a link or a file as the source.', {
      fieldErrors: [
        { field: 'sourceUrl', code: 'SOURCE_REQUIRED', message: 'Add a link or a file as the source.' },
        { field: 'sourceAssetId', code: 'SOURCE_REQUIRED', message: 'Add a link or a file as the source.' },
      ],
    });
  const projectId = await checkProject(ctx, input.projectId);
  const files = await resolvePreview(ctx, input);
  const id = newId();
  const [row] = await ctx.tx
    .insert(references)
    .values({
      ...stamp(ctx),
      id,
      title: input.title.trim(),
      sourceUrl,
      sourceAssetId: files.source?.id ?? null,
      previewAssetVersionId: files.previewVersionId,
      whatToReuse: input.whatToReuse.trim(),
      notes: input.notes ?? null,
      tags: cleanTags(input.tags),
      ownerMembershipId: ctx.actor.membershipId!,
      projectId,
    })
    .returning();
  await linkFiles(ctx, id, files);
  await audit(ctx, { action: 'reference.created', entityType: 'reference', entityId: id, projectId, diff: diffFields(null, row!, ['title', 'sourceUrl', 'tags', 'projectId']) });
  await emit(ctx, { type: 'reference.created', entityType: 'reference', entityId: id, revision: 1 });
  await indexReference(ctx, row!);
  return id;
};

export const updateReference = async (ctx: CommandContext, id: string, input: ReferenceInput) => {
  const r = await loadReference(ctx, id, { lock: true });
  authorizeWrite(ctx, r);
  assertVersion(ctx, r);
  if (r.archivedAt) throw new AppError('INVALID_STATE', 'Restore the reference before editing it.');
  const patch: Partial<ReferenceRow> = {};
  if (input.title !== undefined) patch.title = input.title.trim();
  if (input.sourceUrl !== undefined) patch.sourceUrl = checkUrl(input.sourceUrl);
  if (input.whatToReuse !== undefined) patch.whatToReuse = input.whatToReuse.trim();
  if (input.notes !== undefined) patch.notes = input.notes;
  if (input.tags !== undefined) patch.tags = cleanTags(input.tags);
  if (input.projectId !== undefined && input.projectId !== r.projectId) patch.projectId = await checkProject(ctx, input.projectId);
  let files: Awaited<ReturnType<typeof resolvePreview>> | null = null;
  if (input.sourceAssetId !== undefined || input.previewAssetId !== undefined) {
    files = await resolvePreview(ctx, {
      sourceAssetId: input.sourceAssetId === undefined ? r.sourceAssetId : input.sourceAssetId,
      previewAssetId: input.previewAssetId,
    });
    patch.sourceAssetId = files.source?.id ?? null;
    patch.previewAssetVersionId = files.previewVersionId;
  }
  const sourceUrl = patch.sourceUrl === undefined ? r.sourceUrl : patch.sourceUrl;
  const sourceAsset = patch.sourceAssetId === undefined ? r.sourceAssetId : patch.sourceAssetId;
  if (!sourceUrl && !sourceAsset)
    throw new AppError('VALIDATION_FAILED', 'A reference needs a link or a file as its source.', { fieldErrors: [{ field: 'sourceUrl', code: 'SOURCE_REQUIRED', message: 'A reference needs a link or a file as its source.' }] });
  const [row] = await ctx.tx.update(references).set({ ...patch, ...touch(ctx, references) }).where(eq(references.id, id)).returning();
  if (files) await linkFiles(ctx, id, files);
  await audit(ctx, { action: 'reference.updated', entityType: 'reference', entityId: id, projectId: row!.projectId, diff: diffFields(r, row!, ['title', 'sourceUrl', 'sourceAssetId', 'whatToReuse', 'tags', 'projectId']) });
  await emit(ctx, { type: 'reference.updated', entityType: 'reference', entityId: id, revision: row!.rowVersion });
  await indexReference(ctx, row!);
  return id;
};

/** The actor must be able to read the target it links (no linking to records outside scope). */
const assertLinkTarget = async (ctx: CommandContext, targetType: 'project' | 'content_item' | 'character', targetId: string) => {
  const ws = ctx.actor.workspaceId;
  const invalid = () => new AppError('VALIDATION_FAILED', 'Choose a record you can access.', { fieldErrors: [{ field: 'targetId', code: 'NOT_FOUND', message: 'Choose a record you can access.' }] });
  if (targetType === 'project') {
    const [p] = await ctx.tx.select().from(projects).where(and(eq(projects.workspaceId, ws), eq(projects.id, targetId)));
    if (!p || p.deletedAt || !allowed(ctx, 'projects.read', projectScopeOf(p))) throw invalid();
    return p.id;
  }
  if (targetType === 'character') {
    const [c] = await ctx.tx.select().from(characters).where(and(eq(characters.workspaceId, ws), eq(characters.id, targetId)));
    if (!c || !allowed(ctx, 'characters.read', { projectId: c.projectId })) throw invalid();
    return c.projectId;
  }
  const [c] = await ctx.tx.select().from(contentItems).where(and(eq(contentItems.workspaceId, ws), eq(contentItems.id, targetId)));
  if (!c || c.deletedAt || !allowed(ctx, 'content.read', { projectId: c.projectId, assignedMembershipIds: [c.ownerMembershipId, c.reviewerMembershipId], ownerMembershipId: c.ownerMembershipId })) throw invalid();
  return c.projectId;
};

export const linkReference = async (ctx: CommandContext, id: string, input: { targetType: 'project' | 'content_item' | 'character'; targetId: string }) => {
  const r = await loadReference(ctx, id, { lock: true });
  authorizeWrite(ctx, r);
  if (r.archivedAt) throw new AppError('INVALID_STATE', 'Restore the reference before linking it.');
  const projectId = await assertLinkTarget(ctx, input.targetType, input.targetId);
  const inserted = await ctx.tx
    .insert(referenceLinks)
    .values({ ...stamp(ctx), id: newId(), referenceId: id, targetType: input.targetType, targetId: input.targetId })
    .onConflictDoNothing()
    .returning({ id: referenceLinks.id });
  if (inserted.length) {
    await audit(ctx, { action: 'reference.linked', entityType: 'reference', entityId: id, projectId, metadata: { targetType: input.targetType, targetId: input.targetId } });
    await emit(ctx, { type: 'reference.linked', entityType: 'reference', entityId: id, payload: { targetType: input.targetType, targetId: input.targetId } });
  }
  return id;
};

export const unlinkReference = async (ctx: CommandContext, id: string, linkId: string) => {
  const r = await loadReference(ctx, id, { lock: true });
  authorizeWrite(ctx, r);
  const [l] = await ctx.tx.select().from(referenceLinks).where(and(eq(referenceLinks.workspaceId, ctx.actor.workspaceId), eq(referenceLinks.id, linkId), eq(referenceLinks.referenceId, id)));
  if (!l) throw notFound('Link');
  if (l.kind === 'idea') throw new AppError('INVALID_STATE', 'The idea created from this reference keeps its link.');
  await ctx.tx.delete(referenceLinks).where(eq(referenceLinks.id, linkId));
  await audit(ctx, { action: 'reference.unlinked', entityType: 'reference', entityId: id, projectId: r.projectId, metadata: { targetType: l.targetType, targetId: l.targetId } });
  await emit(ctx, { type: 'reference.unlinked', entityType: 'reference', entityId: id });
  return id;
};

/**
 * "Use as Idea" (T035): exactly one linked content draft in stage Idea per reference. Repeat calls
 * return the existing draft; a unique partial index on reference_links (kind = 'idea') backs this.
 */
export const useReferenceAsIdea = async (ctx: CommandContext, id: string, input: { projectId: string; format: (typeof contentItems.$inferSelect)['format']; title?: string }) => {
  const r = await loadReference(ctx, id, { lock: true });
  authorizeWrite(ctx, r);
  if (r.archivedAt) throw new AppError('INVALID_STATE', 'Restore the reference before creating an idea from it.');
  const [existing] = await ctx.tx.select().from(referenceLinks).where(and(eq(referenceLinks.referenceId, id), eq(referenceLinks.kind, 'idea')));
  if (existing) {
    const [c] = await ctx.tx.select().from(contentItems).where(eq(contentItems.id, existing.targetId));
    if (c && !c.deletedAt && !c.archivedAt) return { contentItemId: c.id, created: false };
    // The earlier idea was archived or removed: keep its link as history and allow a new idea.
    await ctx.tx.update(referenceLinks).set({ kind: 'link', ...touch(ctx, referenceLinks) }).where(eq(referenceLinks.id, existing.id));
  }
  const contentItemId = await createIdeaDraftFromReference(ctx, r, input);
  await ctx.tx.insert(referenceLinks).values({ ...stamp(ctx), id: newId(), referenceId: id, targetType: 'content_item', targetId: contentItemId, kind: 'idea' });
  await audit(ctx, { action: 'reference.used_as_idea', entityType: 'reference', entityId: id, projectId: input.projectId, metadata: { contentItemId } });
  await emit(ctx, { type: 'reference.linked', entityType: 'reference', entityId: id, payload: { targetType: 'content_item', targetId: contentItemId } });
  return { contentItemId, created: true };
};

export const archiveReference = async (ctx: CommandContext, id: string, input: { reason?: string }, opts: { skipVersion?: boolean } = {}) => {
  const r = await loadReference(ctx, id, { lock: true });
  authorizeWrite(ctx, r);
  if (!opts.skipVersion) assertVersion(ctx, r);
  if (r.archivedAt) throw new AppError('INVALID_STATE', 'This reference is already archived.');
  const [row] = await ctx.tx
    .update(references)
    .set({ archivedAt: ctx.app.clock.now(), archivedBy: ctx.actor.userId, archiveReason: input.reason ?? null, ...touch(ctx, references) })
    .where(eq(references.id, id))
    .returning();
  await audit(ctx, { action: 'reference.archived', entityType: 'reference', entityId: id, projectId: r.projectId, reason: input.reason ?? null });
  await emit(ctx, { type: 'reference.archived', entityType: 'reference', entityId: id, revision: row!.rowVersion });
  await indexReference(ctx, row!);
  return id;
};

export const restoreReference = async (ctx: CommandContext, id: string, opts: { skipVersion?: boolean } = {}) => {
  const r = await loadReference(ctx, id, { lock: true });
  authorizeWrite(ctx, r);
  if (!opts.skipVersion) assertVersion(ctx, r);
  if (!r.archivedAt) throw new AppError('INVALID_STATE', 'This reference is not archived.');
  const [row] = await ctx.tx.update(references).set({ archivedAt: null, archivedBy: null, archiveReason: null, ...touch(ctx, references) }).where(eq(references.id, id)).returning();
  await audit(ctx, { action: 'reference.restored', entityType: 'reference', entityId: id, projectId: r.projectId });
  await emit(ctx, { type: 'reference.restored', entityType: 'reference', entityId: id, revision: row!.rowVersion });
  await indexReference(ctx, row!);
  return id;
};
