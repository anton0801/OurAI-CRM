import { and, asc, count, desc, eq, inArray, isNull, max, ne, sql } from 'drizzle-orm';
import {
  assets,
  assetVersions,
  characters,
  characterVersions,
  contentCharacters,
  contentItems,
  reviewDecisions,
  reviews,
  sceneCharacters,
  scenes,
  type CharacterProfile,
  type CharacterPrompt,
} from '@castlane/database';
import { AppError, newId, notFound, type FieldError } from '@castlane/domain';
import type { ImpactItem } from '@castlane/api-contracts';
import { allowed, authorizeObject, authorizeRead, requirePermission, scopePredicate, whereAll } from '../core/access';
import { audit, diffFields } from '../core/audit';
import { all, dbOf, type CommandContext, type QueryContext } from '../core/context';
import { emit } from '../core/events';
import { isActiveMember, loadMemberRefs, refOrUnknown } from '../core/members';
import { notify } from '../core/notify';
import { assertVersion, lockById, stamp, touch } from '../core/rows';
import { indexSearchDocument } from '../core/search';
import { linkAsset } from '../media/assets';
import { assertProjectOpen, loadProjectRow, memberCan, projectFor, projectScopeOf, type ProjectRow } from './common';
import { findSecretLikeValue } from './secrets';

export type CharacterRow = typeof characters.$inferSelect;
export type CharacterVersionRow = typeof characterVersions.$inferSelect;

export const MAX_REFERENCES = 12;

export const characterScope = (c: Pick<CharacterRow, 'id' | 'projectId'>) => ({ objectType: 'character', objectId: c.id, projectId: c.projectId });

export const loadCharacter = async (ctx: QueryContext | CommandContext, id: string, opts: { lock?: boolean } = {}): Promise<CharacterRow> =>
  opts.lock && 'tx' in ctx
    ? lockById(ctx, characters, id, 'Character')
    : (async () => {
        const [c] = await dbOf(ctx).select().from(characters).where(and(eq(characters.workspaceId, ctx.actor.workspaceId), eq(characters.id, id)));
        if (!c) throw notFound('Character');
        return c;
      })();

const loadVersion = async (ctx: QueryContext | CommandContext, id: string, opts: { lock?: boolean } = {}): Promise<CharacterVersionRow> =>
  opts.lock && 'tx' in ctx
    ? lockById(ctx, characterVersions, id, 'Character version')
    : (async () => {
        const [v] = await dbOf(ctx).select().from(characterVersions).where(and(eq(characterVersions.workspaceId, ctx.actor.workspaceId), eq(characterVersions.id, id)));
        if (!v) throw notFound('Character version');
        return v;
      })();

// ——— Validation ———

export interface VersionInput {
  profile?: CharacterProfile;
  prompts?: CharacterPrompt[];
  referenceAssetVersionIds?: string[];
  changeNote?: string | null;
}

const PROFILE_FIELDS: (keyof CharacterProfile)[] = [
  'fictionalIdentityNote',
  'appearance',
  'voice',
  'personality',
  'tone',
  'allowedVariation',
  'biography',
  'audience',
  'styleConstraints',
  'toolsSettings',
];

const cleanProfile = (p: CharacterProfile): CharacterProfile => {
  const out: CharacterProfile = {};
  for (const f of PROFILE_FIELDS) {
    const v = p[f];
    if (typeof v === 'string' && v.trim()) (out as Record<string, unknown>)[f] = v.trim();
  }
  if (p.adultAgeDeclaration) out.adultAgeDeclaration = { declared: !!p.adultAgeDeclaration.declared, ...(p.adultAgeDeclaration.statedAge ? { statedAge: p.adultAgeDeclaration.statedAge } : {}) };
  return out;
};

/** Prompt and profile fields must not carry credentials (API keys of generators etc.). */
const secretErrors = (input: VersionInput): FieldError[] => {
  const errors: FieldError[] = [];
  const msg = (kind: string) => `This looks like a ${kind}. Remove it — character profiles must not store API keys or other credentials.`;
  for (const f of PROFILE_FIELDS) {
    const kind = findSecretLikeValue(input.profile?.[f] as string | undefined);
    if (kind) errors.push({ field: `profile.${f}`, code: 'SECRET_NOT_ALLOWED', message: msg(kind) });
  }
  (input.prompts ?? []).forEach((p, i) => {
    for (const k of ['title', 'text', 'tool'] as const) {
      const kind = findSecretLikeValue(p[k]);
      if (kind) errors.push({ field: `prompts.${i}.${k}`, code: 'SECRET_NOT_ALLOWED', message: msg(kind) });
    }
  });
  const kind = findSecretLikeValue(input.changeNote ?? undefined);
  if (kind) errors.push({ field: 'changeNote', code: 'SECRET_NOT_ALLOWED', message: msg(kind) });
  return errors;
};

/** Reference portraits: image versions in this workspace the actor can read (max 12). */
const resolveReferences = async (ctx: CommandContext, ids: string[]) => {
  const unique = [...new Set(ids)];
  if (unique.length > MAX_REFERENCES)
    throw new AppError('VALIDATION_FAILED', `Use at most ${MAX_REFERENCES} reference images.`, { fieldErrors: [{ field: 'referenceAssetVersionIds', code: 'TOO_MANY', message: `Use at most ${MAX_REFERENCES} reference images.` }] });
  if (!unique.length) return [];
  const rows = await ctx.tx
    .select({ versionId: assetVersions.id, assetId: assets.id, kind: assets.kind, a: assets })
    .from(assetVersions)
    .innerJoin(assets, and(eq(assets.workspaceId, assetVersions.workspaceId), eq(assets.id, assetVersions.assetId)))
    .where(and(eq(assetVersions.workspaceId, ctx.actor.workspaceId), inArray(assetVersions.id, unique)));
  const bad = unique.filter((id) => !rows.some((r) => r.versionId === id));
  const notImage = rows.filter((r) => r.kind !== 'image');
  if (bad.length || notImage.length)
    throw new AppError('VALIDATION_FAILED', 'Reference images must be uploaded images you can access.', {
      fieldErrors: [{ field: 'referenceAssetVersionIds', code: 'INVALID', message: 'Reference images must be uploaded images you can access.' }],
    });
  return rows;
};

const linkReferences = async (ctx: CommandContext, characterId: string, refs: Awaited<ReturnType<typeof resolveReferences>>) => {
  for (const r of refs) await linkAsset(ctx, r.assetId, { versionId: r.versionId, target: { entityType: 'character', entityId: characterId, role: 'reference' } });
};

const declarationError = (p: ProjectRow, profile: CharacterProfile): FieldError | null => {
  if (!p.ofmEnabled) return null;
  if (profile.adultAgeDeclaration?.declared) return null;
  return { field: 'profile.adultAgeDeclaration', code: 'REQUIRED', message: 'OFM characters need an explicit adult age declaration before submission.' };
};

// ——— Read models ———

const versionViews = async (ctx: QueryContext | CommandContext, versions: CharacterVersionRow[]) => {
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const refIds = [...new Set(versions.flatMap((v) => v.referenceAssetVersionIds))];
  const versionIds = versions.map((v) => v.id);
  const [refRows, pending, decisions] = await all(ctx, [
    () =>
      refIds.length
        ? db
            .select({ versionId: assetVersions.id, assetId: assets.id, name: assets.name, status: assetVersions.status, sensitivity: assets.sensitivity })
            .from(assetVersions)
            .innerJoin(assets, and(eq(assets.workspaceId, assetVersions.workspaceId), eq(assets.id, assetVersions.assetId)))
            .where(and(eq(assetVersions.workspaceId, ws), inArray(assetVersions.id, refIds)))
        : Promise.resolve([]),
    () =>
      versionIds.length
        ? db
            .select()
            .from(reviews)
            .where(and(eq(reviews.workspaceId, ws), eq(reviews.targetType, 'character_version'), inArray(reviews.targetId, versionIds), eq(reviews.status, 'pending')))
        : Promise.resolve([]),
    () =>
      versionIds.length
        ? db
            .select({ d: reviewDecisions, targetId: reviews.targetId })
            .from(reviewDecisions)
            .innerJoin(reviews, and(eq(reviews.workspaceId, reviewDecisions.workspaceId), eq(reviews.id, reviewDecisions.reviewId)))
            .where(and(eq(reviewDecisions.workspaceId, ws), inArray(reviews.targetId, versionIds)))
            .orderBy(desc(reviewDecisions.decidedAt))
        : Promise.resolve([]),
  ] as const);
  const refs = await loadMemberRefs(db, ws, [
    ...versions.map((v) => v.approvedBy),
    ...pending.flatMap((r) => [r.reviewerMembershipId, r.authorMembershipId]),
    ...decisions.map((d) => d.d.decidedByMembershipId),
  ]);
  const refById = new Map(refRows.map((r) => [r.versionId, r]));
  return versions.map((v) => {
    const p = pending.find((r) => r.targetId === v.id);
    const last = decisions.find((d) => d.targetId === v.id);
    return {
      id: v.id,
      characterId: v.characterId,
      versionNo: v.versionNo,
      state: v.state,
      profile: v.profile,
      prompts: v.prompts,
      references: v.referenceAssetVersionIds
        .map((id) => refById.get(id))
        .filter((r): r is NonNullable<typeof r> => !!r)
        .map((r) => ({
          assetId: r.assetId,
          assetVersionId: r.versionId,
          name: r.name,
          status: r.status,
          thumbnailUrl: r.sensitivity === 'restricted' ? null : `/api/v1/workspaces/${ws}/assets/${r.assetId}/thumbnail?size=256&versionId=${r.versionId}`,
        })),
      changeNote: v.changeNote,
      submittedAt: v.submittedAt?.toISOString() ?? null,
      approvedAt: v.approvedAt?.toISOString() ?? null,
      approvedBy: refOrUnknown(refs, v.approvedBy),
      pendingReview: p ? { id: p.id, reviewer: refOrUnknown(refs, p.reviewerMembershipId), author: refOrUnknown(refs, p.authorMembershipId), submittedAt: p.submittedAt.toISOString() } : null,
      lastDecision: last
        ? { decision: last.d.decision, summary: last.d.summary, decidedAt: last.d.decidedAt.toISOString(), decidedBy: refOrUnknown(refs, last.d.decidedByMembershipId) }
        : null,
      createdAt: v.createdAt.toISOString(),
      rowVersion: v.rowVersion,
    };
  });
};

const summaries = async (ctx: QueryContext | CommandContext, rows: CharacterRow[]) => {
  if (!rows.length) return [];
  const db = dbOf(ctx);
  const ids = rows.map((r) => r.id);
  const versions = await db
    .select()
    .from(characterVersions)
    .where(and(eq(characterVersions.workspaceId, ctx.actor.workspaceId), inArray(characterVersions.characterId, ids)));
  return rows.map((c) => {
    const vs = versions.filter((v) => v.characterId === c.id);
    const approved = vs.find((v) => v.id === c.approvedVersionId) ?? null;
    const open = vs.find((v) => v.state === 'draft' || v.state === 'submitted') ?? null;
    const shown = approved ?? open ?? vs.sort((a, b) => b.versionNo - a.versionNo)[0] ?? null;
    const firstRef = shown?.referenceAssetVersionIds[0];
    return {
      id: c.id,
      projectId: c.projectId,
      name: c.name,
      role: c.role,
      isPrimary: c.isPrimary,
      approvedVersion: approved ? { id: approved.id, versionNo: approved.versionNo, approvedAt: approved.approvedAt?.toISOString() ?? null } : null,
      openVersion: open ? { id: open.id, versionNo: open.versionNo, state: open.state } : null,
      firstRef,
      referenceCount: shown?.referenceAssetVersionIds.length ?? 0,
      archivedAt: c.archivedAt?.toISOString() ?? null,
      updatedAt: c.updatedAt.toISOString(),
      rowVersion: c.rowVersion,
    };
  });
};

const withThumbs = async (ctx: QueryContext | CommandContext, list: Awaited<ReturnType<typeof summaries>>) => {
  const refIds = list.map((s) => s.firstRef).filter((x): x is string => !!x);
  const rows = refIds.length
    ? await dbOf(ctx)
        .select({ versionId: assetVersions.id, assetId: assetVersions.assetId, sensitivity: assets.sensitivity })
        .from(assetVersions)
        .innerJoin(assets, and(eq(assets.workspaceId, assetVersions.workspaceId), eq(assets.id, assetVersions.assetId)))
        .where(and(eq(assetVersions.workspaceId, ctx.actor.workspaceId), inArray(assetVersions.id, refIds)))
    : [];
  return list.map(({ firstRef, ...s }) => {
    const r = rows.find((x) => x.versionId === firstRef);
    return { ...s, thumbnailUrl: r && r.sensitivity !== 'restricted' ? `/api/v1/workspaces/${ctx.actor.workspaceId}/assets/${r.assetId}/thumbnail?size=128&versionId=${r.versionId}` : null };
  });
};

export const listCharacters = async (ctx: QueryContext, projectId: string, input: { includeArchived?: boolean } = {}) => {
  requirePermission(ctx, 'characters.read');
  await projectFor(ctx, projectId, 'characters.read');
  const rows = await ctx.app.db
    .select()
    .from(characters)
    .where(and(eq(characters.workspaceId, ctx.actor.workspaceId), eq(characters.projectId, projectId), input.includeArchived ? undefined : isNull(characters.archivedAt)))
    .orderBy(desc(characters.isPrimary), asc(characters.name));
  return withThumbs(ctx, await summaries(ctx, rows));
};

export const getCharacter = async (ctx: QueryContext | CommandContext, id: string) => {
  const c = await loadCharacter(ctx, id);
  const scope = characterScope(c);
  authorizeRead(ctx, 'characters.read', scope);
  const p = await loadProjectRow(ctx, c.projectId);
  const db = dbOf(ctx);
  const versions = await db.select().from(characterVersions).where(and(eq(characterVersions.workspaceId, ctx.actor.workspaceId), eq(characterVersions.characterId, id))).orderBy(desc(characterVersions.versionNo));
  const open = versions.find((v) => v.state === 'draft' || v.state === 'submitted') ?? null;
  const approved = versions.find((v) => v.id === c.approvedVersionId) ?? null;
  const views = await versionViews(ctx, [open, approved].filter((v): v is CharacterVersionRow => !!v));
  const [flagged] = await db
    .select({ n: count() })
    .from(contentItems)
    .where(
      and(
        eq(contentItems.workspaceId, ctx.actor.workspaceId),
        eq(contentItems.needsConsistencyReview, true),
        isNull(contentItems.archivedAt),
        isNull(contentItems.deletedAt),
        sql`${contentItems.id} IN (SELECT cc.content_item_id FROM content_characters cc JOIN character_versions cv ON cv.id = cc.character_version_id WHERE cv.character_id = ${id})`,
        scopePredicate(ctx, 'content.read', { projectId: contentItems.projectId, assigned: [contentItems.ownerMembershipId, contentItems.reviewerMembershipId], ownerMembership: contentItems.ownerMembershipId }),
      ),
    );
  const [summary] = await withThumbs(ctx, await summaries(ctx, [c]));
  const archived = !!c.archivedAt || p.status === 'archived';
  const canWrite = allowed(ctx, 'characters.write', scope);
  return {
    ...summary!,
    project: { id: p.id, name: p.name, type: p.type, ofmEnabled: p.ofmEnabled },
    versions: versions.map((v) => ({ id: v.id, versionNo: v.versionNo, state: v.state, changeNote: v.changeNote, approvedAt: v.approvedAt?.toISOString() ?? null, createdAt: v.createdAt.toISOString() })),
    open: open ? (views.find((v) => v.id === open.id) ?? null) : null,
    approved: approved ? (views.find((v) => v.id === approved.id) ?? null) : null,
    flaggedContentCount: Number(flagged?.n ?? 0),
    permissions: {
      write: canWrite && !archived,
      approve: allowed(ctx, 'characters.approve', scope) && !archived,
      archive: canWrite,
      setPrimary: canWrite && !archived && p.type !== 'series',
      uploadReferences: canWrite && !archived && (allowed(ctx, 'assets.upload', scope) || allowed(ctx, 'assets.link', scope)),
    },
  };
};

// ——— Commands ———

const indexCharacter = async (ctx: CommandContext, c: CharacterRow) => {
  const [v] = await ctx.tx
    .select()
    .from(characterVersions)
    .where(eq(characterVersions.id, c.approvedVersionId ?? c.currentVersionId ?? '00000000-0000-4000-8000-000000000000'));
  const p = v?.profile ?? {};
  await indexSearchDocument(ctx.tx, {
    workspaceId: ctx.actor.workspaceId,
    entityType: 'character',
    entityId: c.id,
    title: c.name,
    body: [c.role, p.appearance, p.personality, p.biography, p.audience].filter(Boolean).join('\n'),
    projectId: c.projectId,
    permission: 'characters.read',
    archived: !!c.archivedAt,
    status: c.isPrimary ? 'primary' : null,
    at: ctx.app.clock.now(),
  });
};

const setPrimaryInternal = async (ctx: CommandContext, c: CharacterRow, p: ProjectRow) => {
  if (p.type === 'series')
    throw new AppError('VALIDATION_FAILED', 'Only Model and Influencer projects have a primary character.', { fieldErrors: [{ field: 'isPrimary', code: 'NOT_APPLICABLE', message: 'Only Model and Influencer projects have a primary character.' }] });
  const previous = await ctx.tx
    .update(characters)
    .set({ isPrimary: false, ...touch(ctx, characters) })
    .where(and(eq(characters.workspaceId, ctx.actor.workspaceId), eq(characters.projectId, c.projectId), eq(characters.isPrimary, true), ne(characters.id, c.id)))
    .returning();
  for (const prev of previous) await indexCharacter(ctx, prev);
};

export const createCharacter = async (
  ctx: CommandContext,
  projectId: string,
  input: { name: string; role?: string | null; isPrimary?: boolean } & VersionInput,
) => {
  requirePermission(ctx, 'characters.write');
  const p = await projectFor(ctx, projectId, 'characters.read', 'characters.write');
  assertProjectOpen(p, 'characters');
  const errors = secretErrors(input);
  if (errors.length) throw new AppError('VALIDATION_FAILED', errors[0]!.message, { fieldErrors: errors });
  const refs = await resolveReferences(ctx, input.referenceAssetVersionIds ?? []);
  const id = newId();
  const versionId = newId();
  const [{ n: primaries } = { n: 0 }] = await ctx.tx
    .select({ n: count() })
    .from(characters)
    .where(and(eq(characters.workspaceId, ctx.actor.workspaceId), eq(characters.projectId, projectId), eq(characters.isPrimary, true), isNull(characters.archivedAt)));
  // Model/Influencer projects: the first character becomes primary unless the caller says otherwise.
  const primary = p.type !== 'series' && (input.isPrimary ?? Number(primaries) === 0);
  if (input.isPrimary && p.type === 'series')
    throw new AppError('VALIDATION_FAILED', 'Only Model and Influencer projects have a primary character.', { fieldErrors: [{ field: 'isPrimary', code: 'NOT_APPLICABLE', message: 'Only Model and Influencer projects have a primary character.' }] });
  const base = { ...stamp(ctx), id, projectId, name: input.name.trim(), role: input.role?.trim() || null, isPrimary: false } satisfies Partial<CharacterRow>;
  const [row] = await ctx.tx.insert(characters).values(base).returning();
  if (primary) {
    await setPrimaryInternal(ctx, row!, p);
    await ctx.tx.update(characters).set({ isPrimary: true }).where(eq(characters.id, id));
  }
  await ctx.tx.insert(characterVersions).values({
    ...stamp(ctx),
    id: versionId,
    characterId: id,
    versionNo: 1,
    state: 'draft',
    profile: cleanProfile(input.profile ?? {}),
    prompts: input.prompts ?? [],
    referenceAssetVersionIds: refs.map((r) => r.versionId),
    changeNote: input.changeNote?.trim() || null,
  });
  const [final] = await ctx.tx.update(characters).set({ currentVersionId: versionId }).where(eq(characters.id, id)).returning();
  await linkReferences(ctx, id, refs);
  await audit(ctx, { action: 'character.created', entityType: 'character', entityId: id, projectId, diff: diffFields(null, final!, ['name', 'role', 'isPrimary']) });
  await emit(ctx, { type: 'character.created', entityType: 'character', entityId: id, revision: final!.rowVersion });
  await indexCharacter(ctx, final!);
  return id;
};

export const updateCharacter = async (ctx: CommandContext, id: string, input: { name?: string; role?: string | null }) => {
  const c = await loadCharacter(ctx, id, { lock: true });
  authorizeObject(ctx, 'characters.write', characterScope(c), 'characters.read');
  assertVersion(ctx, c);
  if (c.archivedAt) throw new AppError('INVALID_STATE', 'Archived characters are read-only.');
  const patch: Partial<CharacterRow> = {};
  if (input.name !== undefined) patch.name = input.name.trim();
  if (input.role !== undefined) patch.role = input.role?.trim() || null;
  const [row] = await ctx.tx.update(characters).set({ ...patch, ...touch(ctx, characters) }).where(eq(characters.id, id)).returning();
  await audit(ctx, { action: 'character.updated', entityType: 'character', entityId: id, projectId: c.projectId, diff: diffFields(c, row!, ['name', 'role']) });
  await emit(ctx, { type: 'character.updated', entityType: 'character', entityId: id, revision: row!.rowVersion });
  await indexCharacter(ctx, row!);
  return id;
};

export const setPrimaryCharacter = async (ctx: CommandContext, id: string, input: { primary: boolean }) => {
  const c = await loadCharacter(ctx, id, { lock: true });
  authorizeObject(ctx, 'characters.write', characterScope(c), 'characters.read');
  assertVersion(ctx, c);
  if (c.archivedAt) throw new AppError('INVALID_STATE', 'Archived characters cannot be primary.');
  const p = await loadProjectRow(ctx, c.projectId);
  if (input.primary) await setPrimaryInternal(ctx, c, p);
  const [row] = await ctx.tx.update(characters).set({ isPrimary: input.primary, ...touch(ctx, characters) }).where(eq(characters.id, id)).returning();
  await audit(ctx, { action: 'character.primary_changed', entityType: 'character', entityId: id, projectId: c.projectId, diff: { isPrimary: { from: c.isPrimary, to: input.primary } } });
  await emit(ctx, { type: 'character.updated', entityType: 'character', entityId: id, revision: row!.rowVersion });
  await indexCharacter(ctx, row!);
  return id;
};

export const newCharacterVersion = async (ctx: CommandContext, characterId: string, input: VersionInput) => {
  const c = await loadCharacter(ctx, characterId, { lock: true });
  authorizeObject(ctx, 'characters.write', characterScope(c), 'characters.read');
  if (c.archivedAt) throw new AppError('INVALID_STATE', 'Archived characters are read-only.');
  const p = await loadProjectRow(ctx, c.projectId);
  assertProjectOpen(p, 'profile versions');
  const versions = await ctx.tx.select().from(characterVersions).where(eq(characterVersions.characterId, characterId)).orderBy(desc(characterVersions.versionNo));
  const open = versions.find((v) => v.state === 'draft' || v.state === 'submitted');
  if (open) throw new AppError('INVALID_STATE', `Version ${open.versionNo} is still ${open.state === 'draft' ? 'a draft' : 'awaiting approval'}. Finish it before starting a new version.`, { details: { openVersionId: open.id } });
  const source = versions.find((v) => v.id === c.approvedVersionId) ?? versions[0];
  const errors = secretErrors(input);
  if (errors.length) throw new AppError('VALIDATION_FAILED', errors[0]!.message, { fieldErrors: errors });
  const refs = input.referenceAssetVersionIds ? await resolveReferences(ctx, input.referenceAssetVersionIds) : null;
  const [{ m } = { m: 0 }] = await ctx.tx.select({ m: max(characterVersions.versionNo) }).from(characterVersions).where(eq(characterVersions.characterId, characterId));
  const id = newId();
  const versionNo = Number(m ?? 0) + 1;
  await ctx.tx.insert(characterVersions).values({
    ...stamp(ctx),
    id,
    characterId,
    versionNo,
    state: 'draft',
    // New drafts start from the approved profile; the approved snapshot itself never changes (T025).
    profile: input.profile ? cleanProfile(input.profile) : (source?.profile ?? {}),
    prompts: input.prompts ?? source?.prompts ?? [],
    referenceAssetVersionIds: refs ? refs.map((r) => r.versionId) : (source?.referenceAssetVersionIds ?? []),
    changeNote: input.changeNote?.trim() || null,
  });
  if (refs) await linkReferences(ctx, characterId, refs);
  const [row] = await ctx.tx.update(characters).set({ currentVersionId: id, ...touch(ctx, characters) }).where(eq(characters.id, characterId)).returning();
  await audit(ctx, { action: 'character.version_created', entityType: 'character', entityId: characterId, projectId: c.projectId, metadata: { versionNo, basedOn: source?.versionNo ?? null } });
  await emit(ctx, { type: 'character.version_created', entityType: 'character', entityId: characterId, revision: row!.rowVersion, payload: { versionId: id } });
  return characterId;
};

export const updateCharacterVersion = async (ctx: CommandContext, versionId: string, input: VersionInput) => {
  const v = await loadVersion(ctx, versionId, { lock: true });
  const c = await loadCharacter(ctx, v.characterId, { lock: true });
  authorizeObject(ctx, 'characters.write', characterScope(c), 'characters.read');
  assertVersion(ctx, v);
  if (c.archivedAt) throw new AppError('INVALID_STATE', 'Archived characters are read-only.');
  if (v.state !== 'draft') throw new AppError('INVALID_STATE', v.state === 'submitted' ? 'This version is awaiting approval and cannot be edited.' : 'Approved versions are frozen. Start a new version to change the profile.');
  const errors = secretErrors(input);
  if (errors.length) throw new AppError('VALIDATION_FAILED', errors[0]!.message, { fieldErrors: errors });
  const refs = input.referenceAssetVersionIds ? await resolveReferences(ctx, input.referenceAssetVersionIds) : null;
  const patch: Partial<CharacterVersionRow> = {};
  if (input.profile) patch.profile = cleanProfile(input.profile);
  if (input.prompts) patch.prompts = input.prompts;
  if (refs) patch.referenceAssetVersionIds = refs.map((r) => r.versionId);
  if (input.changeNote !== undefined) patch.changeNote = input.changeNote?.trim() || null;
  const [row] = await ctx.tx.update(characterVersions).set({ ...patch, ...touch(ctx, characterVersions) }).where(eq(characterVersions.id, versionId)).returning();
  if (refs) await linkReferences(ctx, c.id, refs);
  await ctx.tx.update(characters).set({ updatedAt: ctx.app.clock.now() }).where(eq(characters.id, c.id));
  // Draft text saves are aggregated in the activity feed as one "draft saved" entry per save.
  await audit(ctx, {
    action: 'character.draft_saved',
    entityType: 'character',
    entityId: c.id,
    projectId: c.projectId,
    metadata: { versionNo: v.versionNo, fields: Object.keys(patch) },
  });
  await emit(ctx, { type: 'character.updated', entityType: 'character', entityId: c.id, revision: row!.rowVersion });
  return c.id;
};

export const submitCharacterVersion = async (ctx: CommandContext, versionId: string, input: { reviewerMembershipId?: string | null }) => {
  const v = await loadVersion(ctx, versionId, { lock: true });
  const c = await loadCharacter(ctx, v.characterId, { lock: true });
  const scope = characterScope(c);
  authorizeObject(ctx, 'characters.write', scope, 'characters.read');
  assertVersion(ctx, v);
  if (c.archivedAt) throw new AppError('INVALID_STATE', 'Archived characters are read-only.');
  if (v.state !== 'draft') throw new AppError('INVALID_STATE', 'Only draft versions can be submitted.');
  const p = await loadProjectRow(ctx, c.projectId);
  assertProjectOpen(p, 'profile submissions');
  const decl = declarationError(p, v.profile);
  if (decl) throw new AppError('VALIDATION_FAILED', decl.message, { fieldErrors: [decl] });
  const refs = v.referenceAssetVersionIds.length
    ? await ctx.tx.select({ id: assetVersions.id, status: assetVersions.status }).from(assetVersions).where(inArray(assetVersions.id, v.referenceAssetVersionIds))
    : [];
  if (refs.some((r) => r.status !== 'available'))
    throw new AppError('INVALID_STATE', 'Some reference images are still being checked or were rejected. Wait until they are available or remove them.');
  const allowSelf = p.reviewPolicy?.allowSelfReview ?? false;
  if (input.reviewerMembershipId) {
    if (!(await isActiveMember(ctx.tx, ctx.actor.workspaceId, input.reviewerMembershipId)) || !(await memberCan(ctx, input.reviewerMembershipId, 'characters.approve', scope)))
      throw new AppError('VALIDATION_FAILED', 'Choose a reviewer who can approve character profiles in this project.', {
        fieldErrors: [{ field: 'reviewerMembershipId', code: 'NOT_ELIGIBLE', message: 'Choose a reviewer who can approve character profiles in this project.' }],
      });
    if (input.reviewerMembershipId === ctx.actor.membershipId && !allowSelf)
      throw new AppError('VALIDATION_FAILED', 'You cannot review your own profile version.', { fieldErrors: [{ field: 'reviewerMembershipId', code: 'SELF_REVIEW', message: 'You cannot review your own profile version.' }] });
  }
  const at = ctx.app.clock.now();
  const [{ rounds } = { rounds: 0 }] = await ctx.tx.select({ rounds: count() }).from(reviews).where(and(eq(reviews.targetId, versionId), eq(reviews.stepKind, 'release_approval')));
  const reviewId = newId();
  await ctx.tx.insert(reviews).values({
    ...stamp(ctx),
    id: reviewId,
    targetType: 'character_version',
    targetId: versionId,
    subjectId: c.id,
    projectId: c.projectId,
    roundNo: Number(rounds) + 1,
    stepKind: 'release_approval',
    stepOrder: 1,
    status: 'pending',
    reviewerMembershipId: input.reviewerMembershipId ?? null,
    authorMembershipId: ctx.actor.membershipId,
    submittedAt: at,
    policySnapshot: { steps: ['release_approval'], allowSelfReview: allowSelf, requiredApprovals: 1 },
  });
  const [row] = await ctx.tx.update(characterVersions).set({ state: 'submitted', submittedAt: at, reviewId, ...touch(ctx, characterVersions) }).where(eq(characterVersions.id, versionId)).returning();
  await audit(ctx, { action: 'character.version_submitted', entityType: 'character', entityId: c.id, projectId: c.projectId, metadata: { versionNo: v.versionNo, reviewId } });
  await emit(ctx, { type: 'character.version_submitted', entityType: 'character', entityId: c.id, revision: row!.rowVersion, payload: { versionId, reviewId } });
  const recipients = input.reviewerMembershipId ? [input.reviewerMembershipId] : [p.ownerMembershipId];
  await notify(ctx.tx, {
    workspaceId: ctx.actor.workspaceId,
    recipientMembershipIds: recipients,
    eventType: 'character.review_requested',
    eventKey: `character.review_requested:${reviewId}`,
    kind: 'review_request',
    title: `Review requested: ${c.name} profile v${v.versionNo}`,
    entityType: 'character',
    entityId: c.id,
    projectId: c.projectId,
    actorMembershipId: ctx.actor.membershipId,
    at,
  });
  return c.id;
};

const loadPendingReview = async (ctx: CommandContext, reviewId: string, versionId: string) => {
  const [r] = await ctx.tx.select().from(reviews).where(and(eq(reviews.workspaceId, ctx.actor.workspaceId), eq(reviews.id, reviewId))).for('update');
  if (!r || r.targetType !== 'character_version' || r.targetId !== versionId) throw notFound('Review');
  if (r.status !== 'pending') throw new AppError('INVALID_STATE', 'This review was already decided.');
  return r;
};

/**
 * Approve a submitted profile version: it becomes immutable (DB trigger), the previous approved
 * version is superseded, and content using other versions of the character is flagged Needs
 * Consistency Review — images are never changed (T025).
 */
export const approveCharacterVersion = async (ctx: CommandContext, versionId: string, input: { reviewId: string; note?: string }) => {
  const v = await loadVersion(ctx, versionId, { lock: true });
  const c = await loadCharacter(ctx, v.characterId, { lock: true });
  authorizeObject(ctx, 'characters.approve', characterScope(c), 'characters.read');
  assertVersion(ctx, v);
  if (v.state !== 'submitted') throw new AppError('INVALID_STATE', 'Only submitted versions can be approved.');
  const review = await loadPendingReview(ctx, input.reviewId, versionId);
  if (review.authorMembershipId === ctx.actor.membershipId && !review.policySnapshot.allowSelfReview)
    throw new AppError('FORBIDDEN', 'You cannot approve a profile version you submitted.');
  const p = await loadProjectRow(ctx, c.projectId);
  const decl = declarationError(p, v.profile);
  if (decl) throw new AppError('VALIDATION_FAILED', decl.message, { fieldErrors: [decl] });
  const at = ctx.app.clock.now();
  await ctx.tx.update(reviews).set({ status: 'approved', decidedAt: at, ...touch(ctx, reviews) }).where(eq(reviews.id, review.id));
  await ctx.tx.insert(reviewDecisions).values({ ...stamp(ctx), id: newId(), reviewId: review.id, decision: 'approved', summary: input.note?.trim() || null, decidedByMembershipId: ctx.actor.membershipId!, decidedAt: at, targetVersionId: versionId });
  const previousId = c.approvedVersionId;
  if (previousId) await ctx.tx.update(characterVersions).set({ state: 'superseded', ...touch(ctx, characterVersions) }).where(eq(characterVersions.id, previousId));
  const [row] = await ctx.tx
    .update(characterVersions)
    .set({ state: 'approved', approvedAt: at, approvedBy: ctx.actor.membershipId, ...touch(ctx, characterVersions) })
    .where(eq(characterVersions.id, versionId))
    .returning();
  const [char] = await ctx.tx.update(characters).set({ approvedVersionId: versionId, currentVersionId: versionId, ...touch(ctx, characters) }).where(eq(characters.id, c.id)).returning();
  const flagged = await flagDependentContent(ctx, c, versionId);
  await audit(ctx, {
    action: 'character.version_approved',
    entityType: 'character',
    entityId: c.id,
    projectId: c.projectId,
    metadata: { versionNo: v.versionNo, supersededVersionId: previousId, flaggedContent: flagged.length },
  });
  await emit(ctx, { type: 'character.version_approved', entityType: 'character', entityId: c.id, revision: row!.rowVersion, payload: { versionId, flaggedContent: flagged.length } });
  await indexCharacter(ctx, char!);
  if (review.authorMembershipId)
    await notify(ctx.tx, {
      workspaceId: ctx.actor.workspaceId,
      recipientMembershipIds: [review.authorMembershipId],
      eventType: 'character.version_approved',
      eventKey: `character.version_approved:${review.id}`,
      kind: 'general',
      title: `${c.name} profile v${v.versionNo} was approved`,
      entityType: 'character',
      entityId: c.id,
      projectId: c.projectId,
      actorMembershipId: ctx.actor.membershipId,
      at,
    });
  return c.id;
};

/** Mark content that uses other versions of this character; the content itself is not changed. */
const flagDependentContent = async (ctx: CommandContext, c: CharacterRow, approvedVersionId: string) => {
  const at = ctx.app.clock.now();
  const flagged = await ctx.tx
    .update(contentItems)
    .set({ needsConsistencyReview: true, updatedAt: at })
    .where(
      and(
        eq(contentItems.workspaceId, ctx.actor.workspaceId),
        eq(contentItems.needsConsistencyReview, false),
        isNull(contentItems.archivedAt),
        isNull(contentItems.deletedAt),
        sql`${contentItems.id} IN (SELECT cc.content_item_id FROM ${contentCharacters} cc JOIN ${characterVersions} cv ON cv.id = cc.character_version_id WHERE cv.character_id = ${c.id} AND cv.id <> ${approvedVersionId})`,
      ),
    )
    .returning({ id: contentItems.id, owner: contentItems.ownerMembershipId, projectId: contentItems.projectId });
  for (const f of flagged) await emit(ctx, { type: 'content_item.consistency_review_needed', entityType: 'content_item', entityId: f.id, payload: { characterId: c.id, versionId: approvedVersionId } });
  const owners = [...new Set(flagged.map((f) => f.owner).filter((x): x is string => !!x))];
  if (owners.length)
    await notify(ctx.tx, {
      workspaceId: ctx.actor.workspaceId,
      recipientMembershipIds: owners,
      eventType: 'content.consistency_review_needed',
      eventKey: `character.version_approved:${approvedVersionId}:content`,
      kind: 'general',
      title: `${c.name}’s profile changed — check content for consistency`,
      entityType: 'character',
      entityId: c.id,
      projectId: c.projectId,
      actorMembershipId: ctx.actor.membershipId,
      at,
    });
  return flagged;
};

export const requestCharacterChanges = async (ctx: CommandContext, versionId: string, input: { reviewId: string; summary: string }) => {
  const v = await loadVersion(ctx, versionId, { lock: true });
  const c = await loadCharacter(ctx, v.characterId, { lock: true });
  authorizeObject(ctx, 'characters.approve', characterScope(c), 'characters.read');
  assertVersion(ctx, v);
  if (v.state !== 'submitted') throw new AppError('INVALID_STATE', 'Only submitted versions can be returned.');
  const review = await loadPendingReview(ctx, input.reviewId, versionId);
  const at = ctx.app.clock.now();
  await ctx.tx.update(reviews).set({ status: 'changes_requested', decidedAt: at, ...touch(ctx, reviews) }).where(eq(reviews.id, review.id));
  await ctx.tx.insert(reviewDecisions).values({ ...stamp(ctx), id: newId(), reviewId: review.id, decision: 'changes_requested', summary: input.summary.trim(), decidedByMembershipId: ctx.actor.membershipId!, decidedAt: at, targetVersionId: versionId });
  const [row] = await ctx.tx.update(characterVersions).set({ state: 'draft', submittedAt: null, ...touch(ctx, characterVersions) }).where(eq(characterVersions.id, versionId)).returning();
  await audit(ctx, { action: 'character.changes_requested', entityType: 'character', entityId: c.id, projectId: c.projectId, reason: input.summary, metadata: { versionNo: v.versionNo, reviewId: review.id } });
  await emit(ctx, { type: 'character.changes_requested', entityType: 'character', entityId: c.id, revision: row!.rowVersion });
  if (review.authorMembershipId)
    await notify(ctx.tx, {
      workspaceId: ctx.actor.workspaceId,
      recipientMembershipIds: [review.authorMembershipId],
      eventType: 'character.changes_requested',
      eventKey: `character.changes_requested:${review.id}`,
      kind: 'general',
      title: `Changes requested: ${c.name} profile v${v.versionNo}`,
      excerpt: input.summary.slice(0, 200),
      entityType: 'character',
      entityId: c.id,
      projectId: c.projectId,
      actorMembershipId: ctx.actor.membershipId,
      at,
    });
  return c.id;
};

export const characterAffectedContent = async (ctx: QueryContext, characterId: string) => {
  const c = await loadCharacter(ctx, characterId);
  authorizeRead(ctx, 'characters.read', characterScope(c));
  const db = ctx.app.db;
  const base = and(
    eq(contentItems.workspaceId, ctx.actor.workspaceId),
    isNull(contentItems.deletedAt),
    sql`EXISTS (SELECT 1 FROM content_characters cc JOIN character_versions cv ON cv.id = cc.character_version_id WHERE cc.content_item_id = ${contentItems.id} AND cv.character_id = ${characterId})`,
  );
  const scope = scopePredicate(ctx, 'content.read', { projectId: contentItems.projectId, assigned: [contentItems.ownerMembershipId, contentItems.reviewerMembershipId], ownerMembership: contentItems.ownerMembershipId });
  const [total] = await db.select({ n: count() }).from(contentItems).where(base);
  const rows = await db
    .select({
      id: contentItems.id,
      title: contentItems.title,
      stage: contentItems.stage,
      format: contentItems.format,
      needsConsistencyReview: contentItems.needsConsistencyReview,
      updatedAt: contentItems.updatedAt,
      versionNo: sql<number>`(SELECT max(cv.version_no) FROM content_characters cc JOIN character_versions cv ON cv.id = cc.character_version_id WHERE cc.content_item_id = "content_items"."id" AND cv.character_id = ${characterId})`,
    })
    .from(contentItems)
    .where(whereAll(base, scope))
    .orderBy(desc(contentItems.needsConsistencyReview), desc(contentItems.updatedAt))
    .limit(200);
  return {
    items: rows.map((r) => ({ id: r.id, title: r.title, stage: r.stage, format: r.format, needsConsistencyReview: r.needsConsistencyReview, characterVersionNo: Number(r.versionNo), updatedAt: r.updatedAt.toISOString() })),
    hiddenCount: Math.max(0, Number(total?.n ?? 0) - rows.length),
  };
};

export const characterArchivePreview = async (ctx: QueryContext | CommandContext, id: string) => {
  const c = await loadCharacter(ctx, id);
  authorizeObject(ctx, 'characters.write', characterScope(c), 'characters.read');
  const db = dbOf(ctx);
  const [pending, sceneLinks, contentLinks] = await all(ctx, [
    () => db.select({ n: count() }).from(reviews).where(and(eq(reviews.workspaceId, ctx.actor.workspaceId), eq(reviews.subjectId, id), eq(reviews.targetType, 'character_version'), eq(reviews.status, 'pending'))),
    () =>
      db
        .select({ n: count() })
        .from(sceneCharacters)
        .innerJoin(characterVersions, eq(characterVersions.id, sceneCharacters.characterVersionId))
        .innerJoin(scenes, eq(scenes.id, sceneCharacters.sceneId))
        .where(and(eq(characterVersions.characterId, id), isNull(scenes.archivedAt))),
    () =>
      db
        .select({ n: count() })
        .from(contentCharacters)
        .innerJoin(characterVersions, eq(characterVersions.id, contentCharacters.characterVersionId))
        .where(eq(characterVersions.characterId, id)),
  ] as const);
  const n = (r: { n: number }[]) => Number(r[0]?.n ?? 0);
  const items: ImpactItem[] = [
    { kind: 'pending_review', label: 'Profile version awaiting approval', count: n(pending), blocking: n(pending) > 0, resolution: 'Approve or return the submitted version first.' },
    { kind: 'scene_links', label: 'Scenes using this character', count: n(sceneLinks), blocking: false, resolution: 'Scenes keep their character version links.' },
    { kind: 'content_links', label: 'Content items using this character', count: n(contentLinks), blocking: false, resolution: 'Content keeps its character version links.' },
  ];
  return { title: c.name, rowVersion: c.rowVersion, items: items.filter((i) => i.count > 0) };
};

export const archiveCharacter = async (ctx: CommandContext, id: string, input: { reason?: string }, opts: { skipVersion?: boolean } = {}) => {
  const c = await loadCharacter(ctx, id, { lock: true });
  authorizeObject(ctx, 'characters.write', characterScope(c), 'characters.read');
  if (!opts.skipVersion) assertVersion(ctx, c);
  if (c.archivedAt) throw new AppError('INVALID_STATE', 'This character is already archived.');
  const preview = await characterArchivePreview(ctx, id);
  const blocking = preview.items.filter((i) => i.blocking);
  if (blocking.length) throw new AppError('INVALID_STATE', 'Resolve the open obligations before archiving this character.', { details: { items: blocking } });
  const at = ctx.app.clock.now();
  const [row] = await ctx.tx
    .update(characters)
    .set({ archivedAt: at, archivedBy: ctx.actor.userId, archiveReason: input.reason ?? null, isPrimary: false, ...touch(ctx, characters) })
    .where(eq(characters.id, id))
    .returning();
  await audit(ctx, { action: 'character.archived', entityType: 'character', entityId: id, projectId: c.projectId, reason: input.reason ?? null });
  await emit(ctx, { type: 'character.archived', entityType: 'character', entityId: id, revision: row!.rowVersion });
  await indexCharacter(ctx, row!);
  return id;
};

export const restoreCharacter = async (ctx: CommandContext, id: string, opts: { skipVersion?: boolean } = {}) => {
  const c = await loadCharacter(ctx, id, { lock: true });
  authorizeObject(ctx, 'characters.write', characterScope(c), 'characters.read');
  if (!opts.skipVersion) assertVersion(ctx, c);
  if (!c.archivedAt) throw new AppError('INVALID_STATE', 'This character is not archived.');
  const p = await loadProjectRow(ctx, c.projectId);
  assertProjectOpen(p, 'characters');
  const [row] = await ctx.tx.update(characters).set({ archivedAt: null, archivedBy: null, archiveReason: null, ...touch(ctx, characters) }).where(eq(characters.id, id)).returning();
  await audit(ctx, { action: 'character.restored', entityType: 'character', entityId: id, projectId: c.projectId });
  await emit(ctx, { type: 'character.restored', entityType: 'character', entityId: id, revision: row!.rowVersion });
  await indexCharacter(ctx, row!);
  return id;
};

export { projectScopeOf };
