import { and, asc, count, desc, eq, inArray, isNull, max, sql } from 'drizzle-orm';
import {
  assetLinks,
  assets,
  assetVersions,
  characters,
  characterVersions,
  comments,
  contentCharacters,
  contentItems,
  contentVersionAssets,
  contentVersions,
  projects,
  reviewDecisions,
  reviews,
  templateVersions,
} from '@castlane/database';
import { AppError, newId, notFound } from '@castlane/domain';
import { allowed } from '../core/access';
import { audit } from '../core/audit';
import { all, dbOf, type CommandContext, type QueryContext } from '../core/context';
import { emit } from '../core/events';
import { isActiveMember, loadMemberRefs, refOrUnknown } from '../core/members';
import { notify } from '../core/notify';
import { assertVersion, stamp, touch } from '../core/rows';
import { canReadAsset, loadUserMemberRefs } from '../media/assets';
import { memberCan } from '../work/shared';
import { contentBriefView, contentDeliverableSlots, indexContent, recordStageEvent, reviewPolicyOfProject } from './content';
import { fileThumbnailUrl, loadVersionFiles, primaryFile, toVersionFileView } from './files';
import { checklistFor, MULTI_FILE_SLOTS, reviewPolicyVersion, reviewSteps, submitRequirements, type BriefFields, type ChecklistItem, type ContentSlot } from './rules';
import { assertContentWritable, authorizeContentAction, contentScope, fieldError, loadProjectOf, lockContent, readableContent, type ContentRow } from './scope';

type VersionRow = typeof contentVersions.$inferSelect;
type ReviewRow = typeof reviews.$inferSelect;

const DRAFT_STAGES = ['ready', 'production', 'review', 'changes_requested'] as const;

/** Display state of a version from its own facts and its reviews (latest round decides). */
export const versionState = (v: VersionRow, rs: ReviewRow[]) => {
  if (!v.submittedAt) return 'draft' as const;
  if (v.approvalRevokedAt) return 'revoked' as const;
  if (v.approvedAt) return 'approved' as const;
  const latest = [...rs].sort((a, b) => b.roundNo - a.roundNo || b.stepOrder - a.stepOrder)[0];
  if (!latest || latest.status === 'pending') return 'submitted' as const;
  if (latest.status === 'changes_requested') return 'changes_requested' as const;
  return 'superseded' as const;
};

/** Open blocking threads on a version (review comments and review-level comments bound to it). */
export const openBlockingCount = async (db: QueryContext['app']['db'] | CommandContext['tx'], workspaceId: string, versionId: string) => {
  const [r] = await db
    .select({ n: count() })
    .from(comments)
    .where(
      and(
        eq(comments.workspaceId, workspaceId),
        eq(comments.targetVersionId, versionId),
        eq(comments.severity, 'blocking'),
        sql`${comments.state} <> 'resolved'`,
        isNull(comments.deletedAt),
        isNull(comments.replyToId),
      ),
    );
  return Number(r?.n ?? 0);
};

const canUpload = (ctx: QueryContext, c: ContentRow) => allowed(ctx, 'content.upload', contentScope(c)) || allowed(ctx, 'content.edit', contentScope(c));

const summaries = async (ctx: QueryContext | CommandContext, c: ContentRow, versions: VersionRow[]) => {
  const db = dbOf(ctx);
  const ids = versions.map((v) => v.id);
  const [rs, files] = await all(ctx, [
    () => (ids.length ? db.select().from(reviews).where(and(eq(reviews.workspaceId, ctx.actor.workspaceId), inArray(reviews.targetId, ids))) : Promise.resolve([] as ReviewRow[])),
    () => loadVersionFiles(db, ctx.actor.workspaceId, ids),
  ] as const);
  const refs = await loadMemberRefs(db, ctx.actor.workspaceId, versions.map((v) => v.submittedBy));
  const byUser = await loadMemberRefsByUser(ctx, versions.map((v) => v.createdBy));
  return versions.map((v) => {
    const vf = files.filter((f) => f.contentVersionId === v.id);
    return {
      id: v.id,
      contentId: c.id,
      versionNo: v.versionNo,
      note: v.note,
      fixesClaimed: v.fixesClaimed,
      state: versionState(v, rs.filter((r) => r.targetId === v.id)),
      submittedAt: v.submittedAt?.toISOString() ?? null,
      submittedBy: refOrUnknown(refs, v.submittedBy),
      approvedAt: v.approvedAt?.toISOString() ?? null,
      approvalRevokedAt: v.approvalRevokedAt?.toISOString() ?? null,
      approvalRevokedReason: v.approvalRevokedReason,
      isLatest: c.currentVersionId === v.id,
      isApproved: c.approvedVersionId === v.id,
      fileCount: vf.length,
      thumbnailUrl: fileThumbnailUrl(ctx.actor.workspaceId, primaryFile(vf), 256),
      createdAt: v.createdAt.toISOString(),
      createdBy: v.createdBy ? (byUser.get(v.createdBy) ?? null) : null,
      rowVersion: v.rowVersion,
    };
  });
};

const loadMemberRefsByUser = (ctx: QueryContext | CommandContext, userIds: (string | null)[]) => loadUserMemberRefs(dbOf(ctx), ctx.actor.workspaceId, userIds);

export const listContentVersions = async (ctx: QueryContext | CommandContext, contentId: string) => {
  const c = await readableContent(ctx, contentId);
  const rows = await dbOf(ctx).select().from(contentVersions).where(and(eq(contentVersions.workspaceId, ctx.actor.workspaceId), eq(contentVersions.contentItemId, c.id))).orderBy(desc(contentVersions.versionNo));
  return summaries(ctx, c, rows);
};

const baseChecklist = async (ctx: QueryContext | CommandContext, c: ContentRow) => {
  if (!c.templateVersionId) return checklistFor(c.format);
  const [v] = await dbOf(ctx).select({ config: templateVersions.config }).from(templateVersions).where(eq(templateVersions.id, c.templateVersionId));
  return checklistFor(c.format, v?.config.checklist);
};

/** Version detail for the content page and the Review Studio. */
export const contentVersionDetail = async (ctx: QueryContext | CommandContext, c: ContentRow, versionId: string) => {
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const [v] = await db.select().from(contentVersions).where(and(eq(contentVersions.workspaceId, ws), eq(contentVersions.id, versionId), eq(contentVersions.contentItemId, c.id)));
  if (!v) throw notFound('Version');
  const [[summary], files, rs, charRows, slots, base, blocking] = await all(ctx, [
    () => summaries(ctx, c, [v]),
    () => loadVersionFiles(db, ws, [v.id]),
    () => db.select().from(reviews).where(and(eq(reviews.workspaceId, ws), eq(reviews.targetId, v.id))).orderBy(asc(reviews.roundNo), asc(reviews.stepOrder)),
    () =>
      v.characterVersionIds.length
        ? db
            .select({ versionId: characterVersions.id, characterId: characters.id, name: characters.name, versionNo: characterVersions.versionNo })
            .from(characterVersions)
            .innerJoin(characters, eq(characters.id, characterVersions.characterId))
            .where(inArray(characterVersions.id, v.characterVersionIds))
        : Promise.resolve([] as { versionId: string; characterId: string; name: string; versionNo: number }[]),
    () => contentDeliverableSlots(ctx, c),
    () => baseChecklist(ctx, c),
    () => openBlockingCount(db, ws, v.id),
  ] as const);
  const decisions = rs.length ? await db.select().from(reviewDecisions).where(inArray(reviewDecisions.reviewId, rs.map((r) => r.id))).orderBy(desc(reviewDecisions.decidedAt)) : [];
  const refs = await loadMemberRefs(db, ws, decisions.map((d) => d.decidedByMembershipId));
  const draft = !v.submittedAt;
  // Draft versions show the live characters of the content; submitted ones their frozen snapshot.
  const liveChars = draft
    ? await db
        .select({ versionId: characterVersions.id, characterId: characters.id, name: characters.name, versionNo: characterVersions.versionNo })
        .from(contentCharacters)
        .innerJoin(characterVersions, eq(characterVersions.id, contentCharacters.characterVersionId))
        .innerJoin(characters, eq(characters.id, characterVersions.characterId))
        .where(eq(contentCharacters.contentItemId, c.id))
    : [];
  const readableChars = (draft ? liveChars : charRows).map((r) => ({
    versionId: r.versionId,
    characterId: allowed(ctx, 'characters.read', { projectId: c.projectId }) ? r.characterId : null,
    name: allowed(ctx, 'characters.read', { projectId: c.projectId }) ? r.name : null,
    versionNo: r.versionNo,
  }));
  const baseLabels = new Set(base.map((b) => b.label));
  const writable = draft && !c.archivedAt && c.stage !== 'archived';
  return {
    ...summary!,
    files: files.map((f) => toVersionFileView(ctx, f)),
    checklist: (v.checklist as ChecklistItem[]).map((i) => ({ ...i, fromTemplate: baseLabels.has(i.label) })),
    briefSnapshot: draft ? null : contentBriefView(v.briefSnapshot as BriefFields),
    characterVersions: readableChars,
    deliverableSlots: slots.map((s) => ({ ...s, filled: files.some((f) => f.slot === s.slot) })),
    submitMissing: draft
      ? submitRequirements({ format: c.format, slots, files: files.map((f) => ({ slot: f.slot, status: f.status, fileName: f.fileName })), checklist: v.checklist as ChecklistItem[], captionDraft: (c.brief as BriefFields).captionDraft })
      : [],
    reviews: rs.map((r) => {
      const d = decisions.find((x) => x.reviewId === r.id);
      return {
        id: r.id,
        roundNo: r.roundNo,
        stepKind: r.stepKind,
        status: r.status,
        decidedAt: r.decidedAt?.toISOString() ?? null,
        decision: d ? { kind: d.decision, summary: d.summary, by: refOrUnknown(refs, d.decidedByMembershipId), at: d.decidedAt.toISOString() } : null,
      };
    }),
    openBlocking: blocking,
    permissions: {
      edit: writable && canUpload(ctx, c),
      upload: writable && canUpload(ctx, c),
      submit: draft && !c.archivedAt && ['production', 'changes_requested'].includes(c.stage) && allowed(ctx, 'content.submit', contentScope(c)),
      comment: !c.archivedAt,
    },
  };
};

/** Deep links to a version (comment notifications) resolve to the content page or its review. */
export const resolveContentVersion = async (ctx: QueryContext, versionId: string) => {
  const [v] = await ctx.app.db.select().from(contentVersions).where(and(eq(contentVersions.workspaceId, ctx.actor.workspaceId), eq(contentVersions.id, versionId)));
  if (!v) throw notFound('Version');
  await readableContent(ctx, v.contentItemId);
  const [r] = await ctx.app.db.select({ id: reviews.id }).from(reviews).where(and(eq(reviews.workspaceId, ctx.actor.workspaceId), eq(reviews.targetId, v.id))).orderBy(desc(reviews.roundNo), desc(reviews.stepOrder)).limit(1);
  return { contentId: v.contentItemId, versionNo: v.versionNo, reviewId: r?.id ?? null };
};

export const getContentVersion = async (ctx: QueryContext | CommandContext, contentId: string, versionId: string) => {
  const c = await readableContent(ctx, contentId);
  return contentVersionDetail(ctx, c, versionId);
};

const lockVersion = async (ctx: CommandContext, c: ContentRow, versionId: string) => {
  const [v] = await ctx.tx
    .select()
    .from(contentVersions)
    .where(and(eq(contentVersions.workspaceId, ctx.actor.workspaceId), eq(contentVersions.id, versionId), eq(contentVersions.contentItemId, c.id)))
    .for('update');
  if (!v) throw notFound('Version');
  return v;
};

const assertDraft = (v: VersionRow) => {
  if (v.submittedAt) throw new AppError('INVALID_STATE', `Version ${v.versionNo} was submitted and can no longer change. Start a new version.`);
};

const authorizeUpload = async (ctx: CommandContext, c: ContentRow) => {
  if (!canUpload(ctx, c)) await authorizeContentAction(ctx, c, 'content.upload');
  assertContentWritable(c);
};

/**
 * Start a new draft version (monotonic number, at most one draft per content item — also a DB
 * unique index). Unchanged files of an earlier version may be reused (immutable blobs).
 */
export const createContentVersion = async (ctx: CommandContext, contentId: string, input: { note?: string; fixesClaimed?: string; copyFilesFromVersionId?: string }) => {
  const c = await lockContent(ctx, contentId);
  await authorizeUpload(ctx, c);
  if (!(DRAFT_STAGES as readonly string[]).includes(c.stage))
    throw new AppError(
      'INVALID_STATE',
      c.stage === 'approved' ? 'This content is approved. Start a New Revision (with a reason) before uploading a new version.' : 'Versions are uploaded once the content is Ready or in Production.',
    );
  const [draft] = await ctx.tx.select({ id: contentVersions.id, versionNo: contentVersions.versionNo }).from(contentVersions).where(and(eq(contentVersions.contentItemId, c.id), isNull(contentVersions.submittedAt)));
  if (draft) throw new AppError('INVALID_STATE', `Version ${draft.versionNo} is still a draft. Add files to it or submit it first.`, { details: { draftVersionId: draft.id } });
  const [{ n } = { n: 0 }] = await ctx.tx.select({ n: max(contentVersions.versionNo) }).from(contentVersions).where(eq(contentVersions.contentItemId, c.id));
  const versionNo = Number(n ?? 0) + 1;
  const id = newId();
  await ctx.tx.insert(contentVersions).values({
    ...stamp(ctx),
    id,
    contentItemId: c.id,
    versionNo,
    note: input.note?.trim() || null,
    fixesClaimed: input.fixesClaimed?.trim() || null,
    checklist: await baseChecklist(ctx, c),
  });
  if (input.copyFilesFromVersionId) {
    const [src] = await ctx.tx.select().from(contentVersions).where(and(eq(contentVersions.id, input.copyFilesFromVersionId), eq(contentVersions.contentItemId, c.id)));
    if (!src) throw fieldError('copyFilesFromVersionId', 'NOT_FOUND', 'Choose a version of this content.');
    const files = await ctx.tx.select().from(contentVersionAssets).where(eq(contentVersionAssets.contentVersionId, src.id));
    for (const f of files) {
      await ctx.tx.insert(contentVersionAssets).values({ ...stamp(ctx), id: newId(), contentVersionId: id, slot: f.slot, assetVersionId: f.assetVersionId, position: f.position });
      await ensureFileLink(ctx, c, id, f.assetVersionId, f.slot);
    }
  }
  await ctx.tx.update(contentItems).set({ updatedAt: ctx.app.clock.now() }).where(eq(contentItems.id, c.id));
  await audit(ctx, { action: 'content.version_created', entityType: 'content_item', entityId: c.id, projectId: c.projectId, metadata: { versionId: id, versionNo, reusedFrom: input.copyFilesFromVersionId ?? null } });
  await emit(ctx, { type: 'content_version.created', entityType: 'content_version', entityId: id, revision: 1, payload: { contentId: c.id } });
  return id;
};

/** Checklist edits: members tick items and may add optional ones; template/default items keep their mandatory flag. */
export const updateContentVersion = async (
  ctx: CommandContext,
  contentId: string,
  versionId: string,
  input: { note?: string | null; fixesClaimed?: string | null; checklist?: { label: string; done: boolean; mandatory: boolean }[] },
) => {
  const c = await lockContent(ctx, contentId);
  await authorizeUpload(ctx, c);
  const v = await lockVersion(ctx, c, versionId);
  assertVersion(ctx, v);
  assertDraft(v);
  const patch: Partial<VersionRow> = {};
  if (input.note !== undefined) patch.note = input.note?.trim() || null;
  if (input.fixesClaimed !== undefined) patch.fixesClaimed = input.fixesClaimed?.trim() || null;
  if (input.checklist !== undefined) {
    const base = await baseChecklist(ctx, c);
    const labels = input.checklist.map((i) => i.label.trim());
    if (new Set(labels).size !== labels.length) throw fieldError('checklist', 'DUPLICATE', 'Checklist items must be unique.');
    for (const b of base) {
      const i = input.checklist.find((x) => x.label.trim() === b.label);
      if (!i) throw fieldError('checklist', 'REQUIRED_ITEM', `“${b.label}” is part of the required checklist and cannot be removed.`);
      if (b.mandatory && !i.mandatory) throw fieldError('checklist', 'MANDATORY', `“${b.label}” is mandatory.`);
    }
    // Only producers/leads may add new mandatory items.
    const canEdit = allowed(ctx, 'content.edit', contentScope(c));
    for (const i of input.checklist) if (i.mandatory && !base.some((b) => b.label === i.label.trim()) && !canEdit) throw fieldError('checklist', 'FORBIDDEN', 'Only producers and leads can add mandatory checklist items.');
    patch.checklist = input.checklist.map((i) => ({ label: i.label.trim(), done: i.done, mandatory: i.mandatory }));
  }
  await ctx.tx.update(contentVersions).set({ ...patch, ...touch(ctx, contentVersions) }).where(eq(contentVersions.id, v.id));
  await audit(ctx, { action: 'content.version_updated', entityType: 'content_item', entityId: c.id, projectId: c.projectId, metadata: { versionId: v.id, versionNo: v.versionNo, checklistChanged: input.checklist !== undefined } });
  await emit(ctx, { type: 'content_version.updated', entityType: 'content_version', entityId: v.id, revision: v.rowVersion + 1, payload: { contentId: c.id } });
  return v.id;
};

/** Link the stored file to the version so members who read the content may read the file (link access). */
const ensureFileLink = async (ctx: CommandContext, c: ContentRow, versionId: string, assetVersionId: string, slot: string) => {
  const [av] = await ctx.tx.select({ assetId: assetVersions.assetId }).from(assetVersions).where(eq(assetVersions.id, assetVersionId));
  if (!av) return;
  const [existing] = await ctx.tx
    .select({ id: assetLinks.id })
    .from(assetLinks)
    .where(and(eq(assetLinks.workspaceId, ctx.actor.workspaceId), eq(assetLinks.assetId, av.assetId), eq(assetLinks.assetVersionId, assetVersionId), eq(assetLinks.entityType, 'content_version'), eq(assetLinks.entityId, versionId), isNull(assetLinks.removedAt)));
  if (existing) return;
  await ctx.tx.insert(assetLinks).values({ ...stamp(ctx), id: newId(), assetId: av.assetId, assetVersionId, entityType: 'content_version', entityId: versionId, role: slot, projectId: c.projectId });
};

/**
 * Put a file version into a deliverable slot of the draft. Files that are still uploading or being
 * checked may be attached (they block Submit until Available — T038); rejected files may not.
 */
export const attachVersionFile = async (ctx: CommandContext, contentId: string, versionId: string, input: { slot: ContentSlot; assetVersionId: string; replaceFileId?: string }) => {
  const c = await lockContent(ctx, contentId);
  await authorizeUpload(ctx, c);
  const v = await lockVersion(ctx, c, versionId);
  assertDraft(v);
  const [av] = await ctx.tx.select().from(assetVersions).where(and(eq(assetVersions.workspaceId, ctx.actor.workspaceId), eq(assetVersions.id, input.assetVersionId)));
  if (!av || av.deletedAt) throw fieldError('assetVersionId', 'NOT_FOUND', 'Choose a file you can access.');
  const [a] = await ctx.tx.select().from(assets).where(eq(assets.id, av.assetId));
  if (!a || !(await canReadAsset(ctx, a))) throw fieldError('assetVersionId', 'NOT_FOUND', 'Choose a file you can access.');
  if (a.kind === 'external_link') throw fieldError('assetVersionId', 'EXTERNAL_LINK', 'External links are not stored files and cannot be a deliverable.');
  if (av.status === 'rejected' || av.status === 'failed') throw fieldError('assetVersionId', 'REJECTED', 'This file was rejected by the checks. Upload it again.');
  const existing = await ctx.tx.select().from(contentVersionAssets).where(eq(contentVersionAssets.contentVersionId, v.id));
  if (existing.some((e) => e.assetVersionId === av.id && e.slot === input.slot)) return v.id;
  if (input.replaceFileId) {
    const old = existing.find((e) => e.id === input.replaceFileId);
    if (!old) throw fieldError('replaceFileId', 'NOT_FOUND', 'The file to replace is not in this version.');
    await ctx.tx.delete(contentVersionAssets).where(eq(contentVersionAssets.id, old.id));
    await unlinkFile(ctx, v.id, old.assetVersionId);
  } else if (!MULTI_FILE_SLOTS.has(input.slot)) {
    for (const old of existing.filter((e) => e.slot === input.slot)) {
      await ctx.tx.delete(contentVersionAssets).where(eq(contentVersionAssets.id, old.id));
      await unlinkFile(ctx, v.id, old.assetVersionId);
    }
  }
  const remaining = await ctx.tx.select({ position: contentVersionAssets.position }).from(contentVersionAssets).where(and(eq(contentVersionAssets.contentVersionId, v.id), eq(contentVersionAssets.slot, input.slot)));
  const position = remaining.length ? Math.max(...remaining.map((r) => r.position)) + 1 : 0;
  await ctx.tx.insert(contentVersionAssets).values({ ...stamp(ctx), id: newId(), contentVersionId: v.id, slot: input.slot, assetVersionId: av.id, position });
  await ensureFileLink(ctx, c, v.id, av.id, input.slot);
  await ctx.tx.update(contentVersions).set({ ...touch(ctx, contentVersions) }).where(eq(contentVersions.id, v.id));
  await audit(ctx, { action: 'content.version_file_added', entityType: 'content_item', entityId: c.id, projectId: c.projectId, metadata: { versionId: v.id, versionNo: v.versionNo, slot: input.slot, assetVersionId: av.id } });
  await emit(ctx, { type: 'content_version.updated', entityType: 'content_version', entityId: v.id, payload: { contentId: c.id } });
  return v.id;
};

const unlinkFile = async (ctx: CommandContext, versionId: string, assetVersionId: string) => {
  await ctx.tx
    .update(assetLinks)
    .set({ removedAt: ctx.app.clock.now(), removedBy: ctx.actor.userId })
    .where(and(eq(assetLinks.workspaceId, ctx.actor.workspaceId), eq(assetLinks.entityType, 'content_version'), eq(assetLinks.entityId, versionId), eq(assetLinks.assetVersionId, assetVersionId), isNull(assetLinks.removedAt)));
};

export const removeVersionFile = async (ctx: CommandContext, contentId: string, versionId: string, fileId: string) => {
  const c = await lockContent(ctx, contentId);
  await authorizeUpload(ctx, c);
  const v = await lockVersion(ctx, c, versionId);
  assertDraft(v);
  const [f] = await ctx.tx.select().from(contentVersionAssets).where(and(eq(contentVersionAssets.id, fileId), eq(contentVersionAssets.contentVersionId, v.id)));
  if (!f) return v.id;
  await ctx.tx.delete(contentVersionAssets).where(eq(contentVersionAssets.id, f.id));
  const stillUsed = await ctx.tx.select({ n: count() }).from(contentVersionAssets).where(and(eq(contentVersionAssets.contentVersionId, v.id), eq(contentVersionAssets.assetVersionId, f.assetVersionId)));
  if (!Number(stillUsed[0]?.n ?? 0)) await unlinkFile(ctx, v.id, f.assetVersionId);
  await ctx.tx.update(contentVersions).set({ ...touch(ctx, contentVersions) }).where(eq(contentVersions.id, v.id));
  await audit(ctx, { action: 'content.version_file_removed', entityType: 'content_item', entityId: c.id, projectId: c.projectId, metadata: { versionId: v.id, versionNo: v.versionNo, slot: f.slot } });
  await emit(ctx, { type: 'content_version.updated', entityType: 'content_version', entityId: v.id, payload: { contentId: c.id } });
  return v.id;
};

/** Eligible reviewer: active member with content.approve in the content's scope (and on the policy list, when one exists). */
export const assertEligibleReviewer = async (ctx: CommandContext, c: ContentRow, membershipId: string, field = 'reviewerMembershipId') => {
  if (!(await isActiveMember(ctx.tx, ctx.actor.workspaceId, membershipId))) throw fieldError(field, 'INACTIVE', 'Choose an active member as reviewer.');
  const r = await memberCan(ctx.app.db, ctx.actor.workspaceId, membershipId, 'content.approve', { ...contentScope(c), assignedMembershipIds: [membershipId] }, ctx.app.clock.now());
  if (!r.ok) throw fieldError(field, 'NOT_ELIGIBLE', `${r.name ?? 'This member'} cannot approve content in this project.`);
  const [p] = await ctx.tx.select({ reviewPolicy: projects.reviewPolicy }).from(projects).where(eq(projects.id, c.projectId));
  const list = p?.reviewPolicy?.eligibleReviewerMembershipIds;
  if (list?.length && !list.includes(membershipId)) throw fieldError(field, 'NOT_ELIGIBLE', 'This member is not on the project’s list of eligible reviewers.');
};

/**
 * Submit for Review (§10.1 Production → Review): required deliverables uploaded, every file
 * Available (T038), mandatory checklist done. Freezes the version (brief snapshot, character
 * versions; DB trigger keeps it immutable), points Latest at it and opens a review round with a
 * snapshot of the project's review policy.
 */
export const submitContentVersion = async (ctx: CommandContext, contentId: string, input: { versionId: string; reviewPolicyVersion?: string; reviewerMembershipId?: string }) => {
  const c = await lockContent(ctx, contentId);
  await authorizeContentAction(ctx, c, 'content.submit');
  assertVersion(ctx, c);
  assertContentWritable(c);
  if (c.stage === 'review') throw new AppError('INVALID_STATE', 'A version of this content is already in review. Wait for the decision.');
  if (c.stage !== 'production' && c.stage !== 'changes_requested')
    throw new AppError('INVALID_STATE', c.stage === 'approved' ? 'This content is approved. Start a New Revision before submitting another version.' : 'Only content in Production can be submitted for review.');
  const v = await lockVersion(ctx, c, input.versionId);
  assertDraft(v);
  const p = await loadProjectOf(ctx, c.projectId);
  if (p.status !== 'active') throw new AppError('INVALID_STATE', 'The project is not active.');
  const policy = reviewPolicyOfProject(p);
  if (input.reviewPolicyVersion && input.reviewPolicyVersion !== reviewPolicyVersion(policy))
    throw new AppError('INVALID_STATE', 'The project’s review policy changed. Check the review steps and submit again.', { details: { reviewPolicyVersion: reviewPolicyVersion(policy) } });
  const files = await loadVersionFiles(ctx.tx, ctx.actor.workspaceId, [v.id]);
  const slots = await contentDeliverableSlots(ctx, c);
  const missing = submitRequirements({ format: c.format, slots, files: files.map((f) => ({ slot: f.slot, status: f.status, fileName: f.fileName })), checklist: v.checklist as ChecklistItem[], captionDraft: (c.brief as BriefFields).captionDraft });
  if (missing.length)
    throw new AppError('INVALID_STATE', `Version ${v.versionNo} cannot be submitted yet: ${missing.map((m) => m.message).join(' ')}`, { details: { missing }, fieldErrors: missing });
  const reviewer = input.reviewerMembershipId ?? c.reviewerMembershipId;
  if (reviewer) {
    await assertEligibleReviewer(ctx, c, reviewer);
    if (reviewer === ctx.actor.membershipId && !policy.allowSelfReview) throw fieldError('reviewerMembershipId', 'SELF_REVIEW', 'You cannot review your own version. Choose another reviewer.');
  }
  const at = ctx.app.clock.now();
  const chars = await ctx.tx.select({ v: contentCharacters.characterVersionId }).from(contentCharacters).where(eq(contentCharacters.contentItemId, c.id));
  await ctx.tx
    .update(contentVersions)
    .set({ submittedAt: at, submittedBy: ctx.actor.membershipId, briefSnapshot: c.brief, characterVersionIds: chars.map((x) => x.v), ...touch(ctx, contentVersions) })
    .where(eq(contentVersions.id, v.id));
  // A newer submission supersedes any pending review of an older version of this content.
  await ctx.tx
    .update(reviews)
    .set({ status: 'superseded', decidedAt: at, ...touch(ctx, reviews) })
    .where(and(eq(reviews.workspaceId, ctx.actor.workspaceId), eq(reviews.subjectId, c.id), eq(reviews.targetType, 'content_version'), eq(reviews.status, 'pending')));
  const [{ round } = { round: 0 }] = await ctx.tx.select({ round: max(reviews.roundNo) }).from(reviews).where(and(eq(reviews.subjectId, c.id), eq(reviews.targetType, 'content_version')));
  const steps = reviewSteps(policy);
  const reviewId = newId();
  await ctx.tx.insert(reviews).values({
    ...stamp(ctx),
    id: reviewId,
    targetType: 'content_version',
    targetId: v.id,
    subjectId: c.id,
    projectId: c.projectId,
    roundNo: Number(round ?? 0) + 1,
    stepKind: steps[0]!,
    stepOrder: 1,
    status: 'pending',
    reviewerMembershipId: reviewer ?? null,
    authorMembershipId: ctx.actor.membershipId,
    submittedAt: at,
    dueAt: c.dueAt,
    policySnapshot: { steps, allowSelfReview: policy.allowSelfReview, requiredApprovals: 1 },
  });
  if (c.stage === 'changes_requested') await recordStageEvent(ctx, c.id, 'changes_requested', 'production', 'Revision submitted');
  const [row] = await ctx.tx
    .update(contentItems)
    .set({ stage: 'review', currentVersionId: v.id, ...touch(ctx, contentItems) })
    .where(eq(contentItems.id, c.id))
    .returning();
  await recordStageEvent(ctx, c.id, 'production', 'review', `Version ${v.versionNo} submitted`);
  await audit(ctx, { action: 'content.version_submitted', entityType: 'content_item', entityId: c.id, projectId: c.projectId, metadata: { versionId: v.id, versionNo: v.versionNo, reviewId, steps, files: files.length } });
  await emit(ctx, { type: 'content.submitted', entityType: 'content_item', entityId: c.id, revision: row!.rowVersion, payload: { versionId: v.id, reviewId, format: c.format } });
  await emit(ctx, { type: 'review.created', entityType: 'review', entityId: reviewId, revision: 1, payload: { contentId: c.id } });
  await indexContent(ctx, row!);
  await notify(ctx.tx, {
    workspaceId: c.workspaceId,
    recipientMembershipIds: [reviewer ?? p.ownerMembershipId],
    eventType: 'review.requested',
    eventKey: `review.requested:${reviewId}`,
    kind: 'review_request',
    title: `Review requested: ${c.title} v${v.versionNo}`,
    excerpt: v.fixesClaimed ? `Fixes: ${v.fixesClaimed.slice(0, 140)}` : null,
    entityType: 'review',
    entityId: reviewId,
    projectId: c.projectId,
    actorMembershipId: ctx.actor.membershipId,
    at,
  });
  return c.id;
};

