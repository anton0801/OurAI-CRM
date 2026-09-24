import { and, eq, gt, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import { campaigns, contentItems, contentVersions, memberships, projects, publicationCorrections, publicationPlanRevisions, publications, socialAccounts, workspaces, type DbOrTx } from '@castlane/database';
import { AppError, assertTransition, DateTime, newId, normalizePostUrl, type FieldError } from '@castlane/domain';
import { allowed, authorizeObject, requirePermission } from '../core/access';
import { audit, diffFields } from '../core/audit';
import { dbOf, type CommandContext, type QueryContext } from '../core/context';
import { emit } from '../core/events';
import { notify } from '../core/notify';
import { assertVersion, stamp, touch } from '../core/rows';
import { resolveTags } from '../core/tags';
import { memberCan } from '../work/shared';
import { contentVersionPlacement } from '../production/reviews';
import { baselineEffects, baselineOnCancel, baselineOnSchedule } from './baselines';
import { createMeasurementTasks, createMissingUrlTask, createPublicationCheckpoints, recalculatePendingCheckpoints } from './checkpoints';
import { accountForPlanning } from './publications';
import { CONFLICT_WINDOW_MINUTES, PUBLICATION_TRANSITIONS, PUBLISH_SKEW_MINUTES, checkpointLabel } from './logic';
import { campaignProjectMap, canCampaign, canPublication, loadPublicationRow, publicationScope, type PublicationRowDb } from './scope';
import { indexPublication, syncPublicationFiles } from './support';

/**
 * Publication commands (§12, S32, F07). Status never changes by editing a field or by time passing:
 * Schedule, Mark Published, Fail, Cancel and Correct are explicit commands with their own gates.
 */

type Pub = PublicationRowDb;

const fieldFail = (field: string, code: string, message: string) => new AppError('VALIDATION_FAILED', message, { fieldErrors: [{ field, code, message }] });
const fieldsFail = (errors: FieldError[]) => new AppError('VALIDATION_FAILED', errors[0]?.message ?? 'Some fields need attention.', { fieldErrors: errors });

const ACCOUNT_STATUS_MESSAGE: Record<string, string> = {
  preparing: 'The account is still being prepared. Check manually that it can publish.',
  paused: 'The account is paused. Check manually that publishing is intended.',
  restricted: 'The account is restricted. New placements are blocked until a lead overrides with a reason.',
};

// ——— Shared validation ———

const loadContent = async (ctx: CommandContext, contentItemId: string, projectId: string) => {
  const [c] = await ctx.tx.select().from(contentItems).where(and(eq(contentItems.workspaceId, ctx.actor.workspaceId), eq(contentItems.id, contentItemId)));
  if (!c || c.deletedAt) throw fieldFail('contentItemId', 'NOT_FOUND', 'Choose content of the account’s project.');
  if (c.projectId !== projectId) throw fieldFail('contentItemId', 'OTHER_PROJECT', 'Choose content of the account’s project.');
  if (c.archivedAt || c.stage === 'archived') throw fieldFail('contentItemId', 'ARCHIVED', 'This content is archived.');
  return c;
};

const loadVersion = async (ctx: CommandContext, contentItemId: string, versionId: string) => {
  const [v] = await ctx.tx.select().from(contentVersions).where(and(eq(contentVersions.workspaceId, ctx.actor.workspaceId), eq(contentVersions.id, versionId)));
  if (!v || v.contentItemId !== contentItemId) throw fieldFail('contentVersionId', 'NOT_FOUND', 'The chosen version does not belong to this content.');
  return v;
};

/**
 * The single placeability check of a content version for scheduling (T061): it must belong to the
 * content item, be approved and not revoked. Merge note: swap the body for the content module's
 * `contentVersionPlacement` / `assertContentVersionPlaceable` (production/reviews.ts) — callers only
 * need `{ ok }` or the blocker code + message.
 */
export const ensurePlaceableVersion = async (
  db: DbOrTx,
  workspaceId: string,
  contentItemId: string,
  versionId: string,
): Promise<{ ok: true } | { ok: false; code: 'VERSION_NOT_FOUND' | 'APPROVAL_REVOKED' | 'VERSION_NOT_APPROVED'; message: string }> => {
  // Approval semantics are owned by the content module (approved and not revoked, T044).
  const r = await contentVersionPlacement(db, workspaceId, versionId);
  if (r.placeable) return r.contentItemId === contentItemId ? { ok: true } : { ok: false, code: 'VERSION_NOT_FOUND', message: 'The chosen version does not belong to this content.' };
  const [v] = await db
    .select({ contentItemId: contentVersions.contentItemId, approvalRevokedAt: contentVersions.approvalRevokedAt })
    .from(contentVersions)
    .where(and(eq(contentVersions.workspaceId, workspaceId), eq(contentVersions.id, versionId)));
  if (!v || v.contentItemId !== contentItemId) return { ok: false, code: 'VERSION_NOT_FOUND', message: 'The chosen version does not belong to this content.' };
  if (v.approvalRevokedAt) return { ok: false, code: 'APPROVAL_REVOKED', message: `${r.reason}` };
  return { ok: false, code: 'VERSION_NOT_APPROVED', message: `${r.reason} Only an approved version can be scheduled.` };
};

/** The owner must be an active member who can see the placement (account/project assignment). */
const assertOwner = async (ctx: CommandContext, ownerMembershipId: string, scope: ReturnType<typeof publicationScope>) => {
  const r = await memberCan(ctx.app.db, ctx.actor.workspaceId, ownerMembershipId, 'publications.read', { ...scope, ownerMembershipId, assignedMembershipIds: [ownerMembershipId] }, ctx.app.clock.now());
  if (!r.active) throw fieldFail('ownerMembershipId', 'INACTIVE', 'Choose an active member.');
  if (!r.ok) throw fieldFail('ownerMembershipId', 'NO_ACCESS', `${r.name ?? 'This member'} cannot access publications of this account. Assign them to the account or project first.`);
};

/** A primary campaign must be readable, not archived and include the placement's project. */
export const assertPrimaryCampaign = async (ctx: CommandContext, campaignId: string, projectId: string) => {
  const [c] = await ctx.tx.select().from(campaigns).where(and(eq(campaigns.workspaceId, ctx.actor.workspaceId), eq(campaigns.id, campaignId)));
  const projectIds = c ? ((await campaignProjectMap(ctx.tx, ctx.actor.workspaceId, [c.id])).get(c.id) ?? []) : [];
  if (!c || !canCampaign(ctx, 'campaigns.read', c, projectIds)) throw fieldFail('primaryCampaignId', 'NOT_FOUND', 'Choose a campaign you can access.');
  if (c.status === 'archived' || c.archivedAt) throw fieldFail('primaryCampaignId', 'ARCHIVED', 'This campaign is archived.');
  if (!projectIds.includes(projectId)) throw fieldFail('primaryCampaignId', 'OTHER_PROJECT', 'The campaign does not include this project. Add the project to the campaign first.');
  return c;
};

const postFacts = (ctx: CommandContext, input: { actualPublishedAt: string; externalUrl?: string | null; noUrlReason?: string | null }) => {
  const actual = new Date(input.actualPublishedAt);
  const errors: FieldError[] = [];
  if (actual.getTime() > ctx.app.clock.now().getTime() + PUBLISH_SKEW_MINUTES * 60_000)
    errors.push({ field: 'actualPublishedAt', code: 'IN_FUTURE', message: 'The actual publication time cannot be in the future.' });
  const url = input.externalUrl?.trim() || null;
  const reason = input.noUrlReason?.trim() || null;
  let normalized: string | null = null;
  if (url) {
    normalized = normalizePostUrl(url);
    if (!normalized) errors.push({ field: 'externalUrl', code: 'INVALID', message: 'Enter the https link of the published post.' });
  } else if (!reason) {
    const message = 'Enter the post URL, or explain why it is missing (10–500 characters).';
    errors.push({ field: 'externalUrl', code: 'URL_OR_REASON_REQUIRED', message }, { field: 'noUrlReason', code: 'URL_OR_REASON_REQUIRED', message });
  }
  if (errors.length) throw fieldsFail(errors);
  return { actualPublishedAt: actual, externalPostUrl: url, normalizedPostUrl: normalized, noUrlReason: url ? null : reason };
};

/** Friendly pre-check; the database unique index (workspace, normalized URL) is the guarantee (T066). */
const assertPostUrlFree = async (ctx: CommandContext, normalized: string | null, selfId: string) => {
  if (!normalized) return;
  const [other] = await ctx.tx
    .select()
    .from(publications)
    .where(and(eq(publications.workspaceId, ctx.actor.workspaceId), eq(publications.normalizedPostUrl, normalized), ne(publications.id, selfId)));
  if (!other) return;
  const message = 'This post URL is already recorded for another publication.';
  throw new AppError('DUPLICATE', message, {
    fieldErrors: [{ field: 'externalUrl', code: 'DUPLICATE_URL', message }],
    details: canPublication(ctx, 'publications.read', other) ? { publicationId: other.id } : {},
  });
};

const serialise = (v: unknown) => (v instanceof Date ? v.toISOString() : v);

// ——— Schedule gates (shared by preview and command) ———

export const evaluateScheduleGates = async (ctx: QueryContext | CommandContext, p: Pub, input: { scheduledAt: Date; timezone: string; contentVersionId?: string | null }) => {
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const now = ctx.app.clock.now();
  const blockers: { code: string; message: string }[] = [];
  const overridable: { code: string; message: string }[] = [];
  const warnings: { code: string; message: string }[] = [];
  if (p.archivedAt) blockers.push({ code: 'ARCHIVED', message: 'Restore the publication before scheduling it.' });
  if (!['draft', 'scheduled', 'failed'].includes(p.status)) blockers.push({ code: 'INVALID_STATUS', message: `A ${p.status} publication cannot be scheduled.` });
  if (input.scheduledAt.getTime() <= now.getTime()) blockers.push({ code: 'MUST_BE_FUTURE', message: 'Choose a future date and time.' });
  const [[account], [content], [project], [owner]] = [
    await db.select().from(socialAccounts).where(and(eq(socialAccounts.workspaceId, ws), eq(socialAccounts.id, p.accountId))),
    await db.select().from(contentItems).where(and(eq(contentItems.workspaceId, ws), eq(contentItems.id, p.contentItemId))),
    await db.select({ status: projects.status }).from(projects).where(and(eq(projects.workspaceId, ws), eq(projects.id, p.projectId))),
    await db.select({ status: memberships.status }).from(memberships).where(and(eq(memberships.workspaceId, ws), eq(memberships.id, p.ownerMembershipId))),
  ];
  if (!account || account.deletedAt || account.archivedAt || account.status === 'archived')
    blockers.push({ code: 'ACCOUNT_ARCHIVED', message: 'Archived accounts cannot receive new placements, even with an override.' });
  else if (account.status !== 'active') overridable.push({ code: `ACCOUNT_${account.status.toUpperCase()}`, message: ACCOUNT_STATUS_MESSAGE[account.status] ?? 'The account is not active.' });
  if (!project || project.status === 'archived' || project.status === 'completed')
    blockers.push({ code: 'PROJECT_CLOSED', message: 'The project is completed or archived and accepts no new placements.' });
  if (!content || content.deletedAt || content.archivedAt || content.stage === 'archived') blockers.push({ code: 'CONTENT_ARCHIVED', message: 'The content is archived.' });
  const versionId = input.contentVersionId ?? p.contentVersionId ?? content?.approvedVersionId ?? null;
  if (!versionId) blockers.push({ code: 'VERSION_REQUIRED', message: 'Choose the approved version to publish.' });
  else {
    const placeable = await ensurePlaceableVersion(db, ws, p.contentItemId, versionId);
    if (!placeable.ok) blockers.push({ code: placeable.code, message: placeable.message });
  }
  if (account?.captionMaxLength && p.caption && [...p.caption].length > account.captionMaxLength)
    blockers.push({ code: 'CAPTION_TOO_LONG', message: `The caption is longer than this account’s internal limit of ${account.captionMaxLength} characters.` });
  if (!owner || owner.status !== 'active') blockers.push({ code: 'OWNER_INACTIVE', message: 'Assign an owner before starting this work.' });
  const windowMs = CONFLICT_WINDOW_MINUTES * 60_000;
  const others = await db
    .select({ p: publications, title: contentItems.title })
    .from(publications)
    .leftJoin(contentItems, eq(contentItems.id, publications.contentItemId))
    .where(
      and(
        eq(publications.workspaceId, ws),
        eq(publications.accountId, p.accountId),
        ne(publications.id, p.id),
        isNull(publications.deletedAt),
        inArray(publications.status, ['scheduled', 'published']),
        gt(sql`coalesce(${publications.actualPublishedAt}, ${publications.scheduledAt})`, new Date(input.scheduledAt.getTime() - windowMs)),
        lt(sql`coalesce(${publications.actualPublishedAt}, ${publications.scheduledAt})`, new Date(input.scheduledAt.getTime() + windowMs)),
      ),
    )
    .limit(20);
  const conflicts = others.map((o) => ({
    publicationId: o.p.id,
    title: canPublication(ctx, 'publications.read', o.p) ? (o.title ?? 'Content') : 'Another placement',
    scheduledAt: (o.p.actualPublishedAt ?? o.p.scheduledAt)!.toISOString(),
    status: o.p.status,
  }));
  if (conflicts.length) warnings.push({ code: 'CONFLICT_15_MIN', message: 'Another placement on this account is within 15 minutes.' });
  return {
    blockers,
    overridable,
    warnings,
    conflicts,
    canOverride: allowed(ctx, 'publications.correct', publicationScope(p)),
    requiresReason: p.status === 'scheduled',
    baselines: await baselineEffects(ctx, p, input.scheduledAt),
    versionId,
  };
};

export const previewPublicationSchedule = async (ctx: QueryContext, id: string, q: { scheduledAt: string; timezone: string; contentVersionId?: string }) => {
  const p = await loadPublicationRow(ctx, id);
  authorizeObject(ctx, 'publications.write', publicationScope(p), 'publications.read');
  const at = new Date(q.scheduledAt);
  const g = await evaluateScheduleGates(ctx, p, { scheduledAt: at, timezone: q.timezone, contentVersionId: q.contentVersionId });
  return {
    allowed: g.blockers.length === 0 && (g.overridable.length === 0 || g.canOverride),
    blockers: g.blockers,
    overridable: g.overridable,
    warnings: g.warnings,
    conflicts: g.conflicts,
    canOverride: g.canOverride,
    requiresReason: g.requiresReason,
    baselines: g.baselines,
    localTime: DateTime.fromJSDate(at, { zone: q.timezone }).toFormat('ccc d LLL yyyy, HH:mm'),
    timezone: q.timezone,
  };
};

const FIELD_OF: Record<string, string> = {
  MUST_BE_FUTURE: 'scheduledAt',
  VERSION_REQUIRED: 'contentVersionId',
  VERSION_NOT_FOUND: 'contentVersionId',
  CAPTION_TOO_LONG: 'caption',
  OWNER_INACTIVE: 'ownerMembershipId',
};

const formatAt = (at: Date, zone: string) => `${DateTime.fromJSDate(at, { zone }).toFormat('d LLL yyyy, HH:mm')} (${zone})`;

// ——— Create / update ———

export interface PublicationCreateInput {
  contentItemId: string;
  accountId: string;
  contentVersionId?: string | null;
  ownerMembershipId: string;
  caption?: string | null;
  cta?: string | null;
  destinationUrl?: string | null;
  primaryCampaignId?: string | null;
  descriptiveTags?: string[];
  scheduledAt?: string | null;
  timezone?: string;
  schedule?: boolean;
  accountOverrideReason?: string;
  conflictOverrideReason?: string;
}

const prepareNew = async (ctx: CommandContext, input: Omit<PublicationCreateInput, 'schedule'>) => {
  const account = await accountForPlanning(ctx, input.accountId);
  const id = newId();
  const scope = publicationScope({ id, projectId: account.projectId, accountId: account.id, ownerMembershipId: input.ownerMembershipId });
  const content = await loadContent(ctx, input.contentItemId, account.projectId);
  if (input.contentVersionId) await loadVersion(ctx, content.id, input.contentVersionId);
  await assertOwner(ctx, input.ownerMembershipId, scope);
  if (input.primaryCampaignId) await assertPrimaryCampaign(ctx, input.primaryCampaignId, account.projectId);
  return { id, account, content };
};

/** Save Draft (S32). With `schedule` the Schedule gates run in the same transaction (one idempotent request). */
export const createPublication = async (ctx: CommandContext, input: PublicationCreateInput) => {
  requirePermission(ctx, 'publications.write');
  const { id, account, content } = await prepareNew(ctx, input);
  const tz = input.timezone ?? ctx.actor.timezone;
  const [row] = await ctx.tx
    .insert(publications)
    .values({
      ...stamp(ctx),
      id,
      contentItemId: content.id,
      contentVersionId: input.contentVersionId ?? null,
      accountId: account.id,
      projectId: account.projectId,
      ownerMembershipId: input.ownerMembershipId,
      caption: input.caption ?? null,
      cta: input.cta?.trim() || null,
      destinationUrl: input.destinationUrl ?? null,
      primaryCampaignId: input.primaryCampaignId ?? null,
      descriptiveTags: await resolveTags(ctx, input.descriptiveTags),
      status: 'draft',
      scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
      scheduleTimezone: tz,
      format: content.format,
    })
    .returning();
  await audit(ctx, {
    action: 'publication.created',
    entityType: 'publication',
    entityId: id,
    projectId: account.projectId,
    diff: diffFields(null, row!, ['contentItemId', 'contentVersionId', 'accountId', 'ownerMembershipId', 'primaryCampaignId', 'scheduledAt']),
  });
  await emit(ctx, { type: 'publication.created', entityType: 'publication', entityId: id, revision: 1, payload: { accountId: account.id, projectId: account.projectId } });
  await indexPublication(ctx, row!);
  if (input.schedule) {
    if (!input.scheduledAt) throw fieldFail('scheduledAt', 'REQUIRED', 'Choose the date and time to publish.');
    await schedulePublication(
      ctx,
      id,
      { scheduledAt: input.scheduledAt, timezone: tz, contentVersionId: input.contentVersionId ?? undefined, accountOverrideReason: input.accountOverrideReason, conflictOverrideReason: input.conflictOverrideReason },
      { skipVersion: true },
    );
  }
  return id;
};

export interface PublicationUpdateInput {
  contentItemId?: string;
  accountId?: string;
  contentVersionId?: string | null;
  ownerMembershipId?: string;
  caption?: string | null;
  cta?: string | null;
  destinationUrl?: string | null;
  primaryCampaignId?: string | null;
  descriptiveTags?: string[];
  scheduledAt?: string | null;
  timezone?: string;
}

export const updatePublication = async (ctx: CommandContext, id: string, input: PublicationUpdateInput) => {
  const p = await loadPublicationRow(ctx, id, { lock: true });
  authorizeObject(ctx, 'publications.write', publicationScope(p), 'publications.read');
  assertVersion(ctx, p);
  if (p.archivedAt) throw new AppError('INVALID_STATE', 'Archived publications are read-only.');
  if (!['draft', 'scheduled', 'failed'].includes(p.status))
    throw new AppError('INVALID_STATE', p.status === 'published' ? 'Published placements change only through Correct Publication with a reason.' : 'Cancelled placements cannot be edited.');
  const patch: Partial<Pub> = {};
  let projectId = p.projectId;
  if (input.accountId && input.accountId !== p.accountId) {
    if (p.status !== 'draft') throw fieldFail('accountId', 'LOCKED', 'Only a draft can move to another account. Cancel it and plan a new placement instead.');
    const a = await accountForPlanning(ctx, input.accountId);
    patch.accountId = a.id;
    patch.projectId = a.projectId;
    projectId = a.projectId;
  }
  const contentItemId = input.contentItemId ?? p.contentItemId;
  if (input.contentItemId && input.contentItemId !== p.contentItemId && p.status !== 'draft')
    throw fieldFail('contentItemId', 'LOCKED', 'Only a draft can change its content.');
  if (patch.projectId || (input.contentItemId && input.contentItemId !== p.contentItemId)) {
    const c = await loadContent(ctx, contentItemId, projectId);
    patch.contentItemId = c.id;
    patch.format = c.format;
    if (c.id !== p.contentItemId && input.contentVersionId === undefined) patch.contentVersionId = null;
  }
  if (input.contentVersionId !== undefined && input.contentVersionId !== p.contentVersionId) {
    if (input.contentVersionId) {
      await loadVersion(ctx, contentItemId, input.contentVersionId);
      if (p.status === 'scheduled') {
        const placeable = await ensurePlaceableVersion(ctx.tx, ctx.actor.workspaceId, contentItemId, input.contentVersionId);
        if (!placeable.ok) throw new AppError('INVALID_STATE', 'A scheduled placement can only pin an approved version.', { details: { blockers: [{ code: placeable.code, message: placeable.message }] } });
      }
    } else if (p.status === 'scheduled') throw fieldFail('contentVersionId', 'REQUIRED', 'A scheduled placement needs its approved version.');
    patch.contentVersionId = input.contentVersionId;
  }
  const nextOwner = input.ownerMembershipId ?? p.ownerMembershipId;
  const scope = publicationScope({ id, projectId, accountId: patch.accountId ?? p.accountId, ownerMembershipId: nextOwner });
  if (input.ownerMembershipId && input.ownerMembershipId !== p.ownerMembershipId) {
    await assertOwner(ctx, input.ownerMembershipId, scope);
    patch.ownerMembershipId = input.ownerMembershipId;
  } else if (patch.accountId) await assertOwner(ctx, nextOwner, scope);
  if (input.primaryCampaignId !== undefined && input.primaryCampaignId !== p.primaryCampaignId) {
    if (input.primaryCampaignId) await assertPrimaryCampaign(ctx, input.primaryCampaignId, projectId);
    patch.primaryCampaignId = input.primaryCampaignId;
  } else if (patch.projectId && p.primaryCampaignId) await assertPrimaryCampaign(ctx, p.primaryCampaignId, projectId);
  if (input.caption !== undefined) patch.caption = input.caption;
  if (input.cta !== undefined) patch.cta = input.cta?.trim() || null;
  if (input.destinationUrl !== undefined) patch.destinationUrl = input.destinationUrl;
  if (input.descriptiveTags !== undefined) patch.descriptiveTags = await resolveTags(ctx, input.descriptiveTags);
  if (input.scheduledAt !== undefined || input.timezone !== undefined) {
    if (p.status !== 'draft') {
      if (input.scheduledAt !== undefined && (input.scheduledAt ? new Date(input.scheduledAt).getTime() : null) !== (p.scheduledAt?.getTime() ?? null))
        throw fieldFail('scheduledAt', 'USE_RESCHEDULE', 'Use Reschedule to move a scheduled or failed placement; the move is recorded as a plan revision.');
    } else {
      if (input.scheduledAt !== undefined) patch.scheduledAt = input.scheduledAt ? new Date(input.scheduledAt) : null;
      if (input.timezone) patch.scheduleTimezone = input.timezone;
    }
  }
  // Caption limits of the account are checked immediately for scheduled placements.
  if (p.status === 'scheduled' && patch.caption) {
    const [a] = await ctx.tx.select({ limit: socialAccounts.captionMaxLength }).from(socialAccounts).where(eq(socialAccounts.id, p.accountId));
    if (a?.limit && [...patch.caption].length > a.limit) throw fieldFail('caption', 'CAPTION_TOO_LONG', `The caption is longer than this account’s internal limit of ${a.limit} characters.`);
  }
  const [row] = await ctx.tx.update(publications).set({ ...patch, ...touch(ctx, publications) }).where(eq(publications.id, id)).returning();
  if (p.status === 'scheduled' && patch.contentVersionId !== undefined) await syncPublicationFiles(ctx, row!, row!.contentVersionId, false);
  await audit(ctx, {
    action: 'publication.updated',
    entityType: 'publication',
    entityId: id,
    projectId: row!.projectId,
    diff: diffFields(p, row!, ['contentItemId', 'contentVersionId', 'accountId', 'ownerMembershipId', 'caption', 'cta', 'destinationUrl', 'primaryCampaignId', 'descriptiveTags', 'scheduledAt', 'scheduleTimezone']),
  });
  await emit(ctx, { type: 'publication.updated', entityType: 'publication', entityId: id, revision: row!.rowVersion });
  const t = await indexPublication(ctx, row!);
  if (patch.ownerMembershipId)
    await notify(ctx.tx, {
      workspaceId: ctx.actor.workspaceId,
      recipientMembershipIds: [patch.ownerMembershipId],
      eventType: 'publication.assigned',
      eventKey: `publication.assigned:${id}:${patch.ownerMembershipId}:${row!.rowVersion}`,
      kind: 'assignment',
      title: `You publish: ${t.title}`,
      excerpt: `${t.accountLabel}${row!.scheduledAt ? ` · ${formatAt(row!.scheduledAt, row!.scheduleTimezone ?? 'UTC')}` : ''}`,
      entityType: 'publication',
      entityId: id,
      projectId: row!.projectId,
      actorMembershipId: ctx.actor.membershipId,
      at: ctx.app.clock.now(),
    });
  return id;
};

// ——— Schedule / reschedule ———

export interface ScheduleInput {
  scheduledAt: string;
  timezone: string;
  contentVersionId?: string;
  reason?: string;
  accountOverrideReason?: string;
  conflictOverrideReason?: string;
}

export const schedulePublication = async (ctx: CommandContext, id: string, input: ScheduleInput, opts: { skipVersion?: boolean } = {}) => {
  const p = await loadPublicationRow(ctx, id, { lock: true });
  authorizeObject(ctx, 'publications.write', publicationScope(p), 'publications.read');
  if (!opts.skipVersion) assertVersion(ctx, p);
  if (p.archivedAt) throw new AppError('INVALID_STATE', 'Restore the publication before scheduling it.');
  const rescheduling = p.status === 'scheduled';
  if (!rescheduling) assertTransition(PUBLICATION_TRANSITIONS, p.status, 'scheduled', 'publication');
  const at = new Date(input.scheduledAt);
  const g = await evaluateScheduleGates(ctx, p, { scheduledAt: at, timezone: input.timezone, contentVersionId: input.contentVersionId });
  const domain = g.blockers.filter((b) => !FIELD_OF[b.code]);
  if (domain.length) throw new AppError('INVALID_STATE', domain[0]!.message, { details: { blockers: domain } });
  const fieldErrors = g.blockers.filter((b) => FIELD_OF[b.code]).map((b) => ({ field: FIELD_OF[b.code]!, code: b.code, message: b.message }));
  if (fieldErrors.length) throw fieldsFail(fieldErrors);
  if (g.overridable.length) {
    if (!input.accountOverrideReason)
      throw new AppError('INVALID_STATE', `${g.overridable[0]!.message} A lead can override with a reason.`, { details: { requiresOverride: true, overridable: g.overridable } });
    if (!g.canOverride) throw new AppError('FORBIDDEN', 'Only a lead can plan on an account that is not Active.');
  }
  if (g.conflicts.length && !input.conflictOverrideReason)
    throw new AppError('INVALID_STATE', 'Another placement on this account is within 15 minutes. Give a reason to keep both.', { details: { conflicts: g.conflicts } });
  if (rescheduling && !input.reason) throw fieldFail('reason', 'REQUIRED', 'Give a reason for moving the scheduled publication.');
  if (rescheduling && p.scheduledAt?.getTime() === at.getTime() && g.versionId === p.contentVersionId && p.scheduleTimezone === input.timezone)
    throw fieldFail('scheduledAt', 'UNCHANGED', 'Choose a different date or time.');
  const override =
    [g.overridable.length ? `Account status override: ${input.accountOverrideReason}` : null, g.conflicts.length ? `Kept despite a placement within 15 minutes: ${input.conflictOverrideReason}` : null]
      .filter(Boolean)
      .join('\n') || null;
  const now = ctx.app.clock.now();
  const [row] = await ctx.tx
    .update(publications)
    .set({
      status: 'scheduled',
      scheduledAt: at,
      scheduleTimezone: input.timezone,
      contentVersionId: g.versionId,
      originalScheduledAt: p.originalScheduledAt ?? at,
      overrideReason: override,
      ...touch(ctx, publications),
    })
    .where(eq(publications.id, id))
    .returning();
  const reason = input.reason ?? (p.status === 'failed' ? 'Retry after failure' : 'Scheduled');
  await ctx.tx.insert(publicationPlanRevisions).values({
    ...stamp(ctx),
    id: newId(),
    publicationId: id,
    fromScheduledAt: p.status === 'draft' ? null : p.scheduledAt,
    toScheduledAt: at,
    reason,
    changedAt: now,
  });
  await baselineOnSchedule(ctx, row!, at);
  if (g.versionId !== p.contentVersionId || p.status !== 'scheduled') await syncPublicationFiles(ctx, row!, g.versionId, false);
  const action = rescheduling ? 'publication.rescheduled' : p.status === 'failed' ? 'publication.retried' : 'publication.scheduled';
  await audit(ctx, {
    action,
    entityType: 'publication',
    entityId: id,
    projectId: row!.projectId,
    reason: [input.reason, override].filter(Boolean).join('\n') || null,
    diff: diffFields(p, row!, ['status', 'scheduledAt', 'scheduleTimezone', 'contentVersionId']),
  });
  await emit(ctx, { type: action, entityType: 'publication', entityId: id, revision: row!.rowVersion, payload: { accountId: row!.accountId, projectId: row!.projectId } });
  const t = await indexPublication(ctx, row!);
  await notify(ctx.tx, {
    workspaceId: ctx.actor.workspaceId,
    recipientMembershipIds: [row!.ownerMembershipId],
    eventType: action,
    eventKey: `${action}:${id}:${row!.rowVersion}`,
    kind: 'assignment',
    title: `${rescheduling ? 'Publication moved' : 'Publication scheduled'}: ${t.title}`,
    excerpt: `${t.accountLabel} · ${formatAt(at, input.timezone)}`,
    entityType: 'publication',
    entityId: id,
    projectId: row!.projectId,
    actorMembershipId: ctx.actor.membershipId,
    at: now,
  });
  return id;
};

// ——— Confirmation ———

const checkpointLabelFor = (p: Pub) => (c: { expectedAt: Date }) =>
  p.actualPublishedAt ? checkpointLabel(Math.round((c.expectedAt.getTime() - p.actualPublishedAt.getTime()) / 3_600_000)) : 'checkpoint';

/** Effects of a confirmed publication: checkpoints (once), measurement / URL tasks, holding file links, audit, events. */
const afterPublished = async (ctx: CommandContext, row: Pub, before: Pub | null) => {
  const t = await indexPublication(ctx, row);
  const created = await createPublicationCheckpoints(ctx, row);
  const accountRef = { label: t.accountLabel, projectId: t.account?.projectId ?? null };
  const taskIds = await createMeasurementTasks(ctx, row, t.title, accountRef, created, checkpointLabelFor(row));
  const urlTask = row.externalPostUrl ? null : await createMissingUrlTask(ctx, row, t.title, accountRef);
  if (row.contentVersionId) await syncPublicationFiles(ctx, row, row.contentVersionId, true);
  await audit(ctx, {
    action: row.historicalEntry ? 'publication.recorded_historical' : 'publication.published',
    entityType: 'publication',
    entityId: row.id,
    projectId: row.projectId,
    reason: row.noUrlReason ?? row.sourceNote ?? null,
    diff: diffFields(before, row, ['status', 'actualPublishedAt', 'externalPostUrl', 'noUrlReason']),
    metadata: { checkpoints: created.map((c) => c.checkpointKey), measurementTasks: taskIds.length, urlTask: !!urlTask },
  });
  await emit(ctx, {
    type: 'publication.published',
    entityType: 'publication',
    entityId: row.id,
    revision: row.rowVersion,
    payload: { accountId: row.accountId, projectId: row.projectId, historical: row.historicalEntry, urlMissing: !row.externalPostUrl },
  });
  if (created.length)
    await notify(ctx.tx, {
      workspaceId: ctx.actor.workspaceId,
      recipientMembershipIds: [row.ownerMembershipId],
      eventType: 'publication.checkpoints_created',
      eventKey: `publication.checkpoints_created:${row.id}`,
      kind: 'due_reminder',
      title: `Metrics update needed: ${t.title}`,
      excerpt: `Checkpoints ${created.map(checkpointLabelFor(row)).join(' and ')} after publication on ${t.accountLabel}.`,
      entityType: 'publication',
      entityId: row.id,
      projectId: row.projectId,
      actorMembershipId: ctx.actor.membershipId,
      excludeActor: false,
      at: ctx.app.clock.now(),
    });
};

export const markPublicationPublished = async (ctx: CommandContext, id: string, input: { actualPublishedAt: string; externalUrl?: string; noUrlReason?: string }) => {
  const p = await loadPublicationRow(ctx, id, { lock: true });
  authorizeObject(ctx, 'publications.confirm', publicationScope(p), 'publications.read');
  assertVersion(ctx, p);
  if (p.archivedAt) throw new AppError('INVALID_STATE', 'Restore the publication before confirming it.');
  assertTransition(PUBLICATION_TRANSITIONS, p.status, 'published', 'publication');
  const facts = postFacts(ctx, input);
  await assertPostUrlFree(ctx, facts.normalizedPostUrl, p.id);
  const [row] = await ctx.tx
    .update(publications)
    .set({ status: 'published', ...facts, availability: 'available', confirmedByMembershipId: ctx.actor.membershipId, ...touch(ctx, publications) })
    .where(eq(publications.id, id))
    .returning();
  await afterPublished(ctx, row!, p);
  return id;
};

/** Historical Published (§12): a separate command for a placement that already happened, with a source note. */
export const createHistoricalPublication = async (
  ctx: CommandContext,
  input: Omit<PublicationCreateInput, 'schedule' | 'scheduledAt' | 'timezone' | 'accountOverrideReason' | 'conflictOverrideReason'> & {
    actualPublishedAt: string;
    externalUrl?: string;
    noUrlReason?: string;
    sourceNote: string;
  },
) => {
  requirePermission(ctx, 'publications.confirm');
  const { id, account, content } = await prepareNew(ctx, input);
  const scope = publicationScope({ id, projectId: account.projectId, accountId: account.id, ownerMembershipId: input.ownerMembershipId });
  if (!allowed(ctx, 'publications.confirm', scope)) throw new AppError('FORBIDDEN', 'You cannot confirm publications on this account.');
  const facts = postFacts(ctx, input);
  await assertPostUrlFree(ctx, facts.normalizedPostUrl, id);
  const [row] = await ctx.tx
    .insert(publications)
    .values({
      ...stamp(ctx),
      id,
      contentItemId: content.id,
      contentVersionId: input.contentVersionId ?? null,
      accountId: account.id,
      projectId: account.projectId,
      ownerMembershipId: input.ownerMembershipId,
      caption: input.caption ?? null,
      cta: input.cta?.trim() || null,
      destinationUrl: input.destinationUrl ?? null,
      primaryCampaignId: input.primaryCampaignId ?? null,
      descriptiveTags: await resolveTags(ctx, input.descriptiveTags),
      status: 'published',
      ...facts,
      historicalEntry: true,
      sourceNote: input.sourceNote.trim(),
      confirmedByMembershipId: ctx.actor.membershipId,
      format: content.format,
    })
    .returning();
  await afterPublished(ctx, row!, null);
  return id;
};

export const failPublication = async (ctx: CommandContext, id: string, input: { reason: string }) => {
  const p = await loadPublicationRow(ctx, id, { lock: true });
  authorizeObject(ctx, 'publications.confirm', publicationScope(p), 'publications.read');
  assertVersion(ctx, p);
  assertTransition(PUBLICATION_TRANSITIONS, p.status, 'failed', 'publication');
  const [row] = await ctx.tx.update(publications).set({ status: 'failed', failureReason: input.reason, ...touch(ctx, publications) }).where(eq(publications.id, id)).returning();
  await audit(ctx, { action: 'publication.failed', entityType: 'publication', entityId: id, projectId: row!.projectId, reason: input.reason, diff: { status: { from: p.status, to: 'failed' } } });
  await emit(ctx, { type: 'publication.failed', entityType: 'publication', entityId: id, revision: row!.rowVersion, payload: { accountId: row!.accountId } });
  const t = await indexPublication(ctx, row!);
  await notify(ctx.tx, {
    workspaceId: ctx.actor.workspaceId,
    recipientMembershipIds: [row!.ownerMembershipId, t.account?.ownerMembershipId ?? null].filter((x): x is string => !!x),
    eventType: 'publication.failed',
    eventKey: `publication.failed:${id}:${row!.rowVersion}`,
    kind: 'general',
    title: `Publication failed: ${t.title}`,
    excerpt: `${t.accountLabel} · ${input.reason}`,
    entityType: 'publication',
    entityId: id,
    projectId: row!.projectId,
    actorMembershipId: ctx.actor.membershipId,
    at: ctx.app.clock.now(),
  });
  return id;
};

export const cancelPublication = async (ctx: CommandContext, id: string, input: { reason: string }) => {
  const p = await loadPublicationRow(ctx, id, { lock: true });
  authorizeObject(ctx, 'publications.write', publicationScope(p), 'publications.read');
  assertVersion(ctx, p);
  assertTransition(PUBLICATION_TRANSITIONS, p.status, 'cancelled', 'publication');
  const [row] = await ctx.tx.update(publications).set({ status: 'cancelled', cancelReason: input.reason, ...touch(ctx, publications) }).where(eq(publications.id, id)).returning();
  await baselineOnCancel(ctx, id, input.reason);
  await audit(ctx, { action: 'publication.cancelled', entityType: 'publication', entityId: id, projectId: row!.projectId, reason: input.reason, diff: { status: { from: p.status, to: 'cancelled' } } });
  await emit(ctx, { type: 'publication.cancelled', entityType: 'publication', entityId: id, revision: row!.rowVersion, payload: { accountId: row!.accountId } });
  await indexPublication(ctx, row!);
  return id;
};

const CORRECTABLE = ['actualPublishedAt', 'externalPostUrl', 'normalizedPostUrl', 'noUrlReason', 'caption', 'primaryCampaignId', 'contentVersionId'] as const;

export const correctPublication = async (
  ctx: CommandContext,
  id: string,
  input: {
    changes: { actualPublishedAt?: string; externalUrl?: string | null; noUrlReason?: string | null; caption?: string | null; primaryCampaignId?: string | null; contentVersionId?: string };
    reason: string;
    recalculateCheckpoints?: boolean;
  },
) => {
  const p = await loadPublicationRow(ctx, id, { lock: true });
  authorizeObject(ctx, 'publications.correct', publicationScope(p), 'publications.read');
  assertVersion(ctx, p);
  if (p.status !== 'published') throw new AppError('INVALID_STATE', 'Only published placements are corrected; plans change with Reschedule.');
  const c = input.changes;
  const patch: Partial<Pub> = {};
  if (c.actualPublishedAt !== undefined) {
    const d = new Date(c.actualPublishedAt);
    if (d.getTime() > ctx.app.clock.now().getTime() + PUBLISH_SKEW_MINUTES * 60_000) throw fieldFail('actualPublishedAt', 'IN_FUTURE', 'The actual publication time cannot be in the future.');
    if (d.getTime() !== p.actualPublishedAt?.getTime()) patch.actualPublishedAt = d;
  }
  if (c.externalUrl !== undefined) {
    if (c.externalUrl === null) {
      if (p.externalPostUrl) {
        const reason = c.noUrlReason?.trim() || null;
        if (!reason) throw fieldFail('noUrlReason', 'REQUIRED', 'Explain why the post URL is missing (10–500 characters).');
        Object.assign(patch, { externalPostUrl: null, normalizedPostUrl: null, noUrlReason: reason });
      }
    } else {
      const normalized = normalizePostUrl(c.externalUrl);
      if (!normalized) throw fieldFail('externalUrl', 'INVALID', 'Enter the https link of the published post.');
      if (normalized !== p.normalizedPostUrl || c.externalUrl.trim() !== p.externalPostUrl) {
        await assertPostUrlFree(ctx, normalized, p.id);
        Object.assign(patch, { externalPostUrl: c.externalUrl.trim(), normalizedPostUrl: normalized, noUrlReason: null });
      }
    }
  } else if (c.noUrlReason !== undefined && c.noUrlReason !== p.noUrlReason) {
    if (p.externalPostUrl) throw fieldFail('noUrlReason', 'URL_PRESENT', 'The post URL is recorded; remove it to record why it is missing.');
    if (!c.noUrlReason?.trim()) throw fieldFail('noUrlReason', 'REQUIRED', 'Explain why the post URL is missing (10–500 characters).');
    patch.noUrlReason = c.noUrlReason.trim();
  }
  if (c.caption !== undefined && c.caption !== p.caption) patch.caption = c.caption;
  if (c.primaryCampaignId !== undefined && c.primaryCampaignId !== p.primaryCampaignId) {
    if (c.primaryCampaignId) await assertPrimaryCampaign(ctx, c.primaryCampaignId, p.projectId);
    patch.primaryCampaignId = c.primaryCampaignId;
  }
  if (c.contentVersionId !== undefined && c.contentVersionId !== p.contentVersionId) {
    await loadVersion(ctx, p.contentItemId, c.contentVersionId);
    patch.contentVersionId = c.contentVersionId;
  }
  if (Object.keys(patch).length === 0) throw new AppError('VALIDATION_FAILED', 'Nothing to correct: the values are unchanged.');
  const merged = { ...p, ...patch };
  const before = Object.fromEntries(CORRECTABLE.filter((k) => k in patch).map((k) => [k, serialise(p[k])]));
  const after = Object.fromEntries(CORRECTABLE.filter((k) => k in patch).map((k) => [k, serialise(merged[k])]));
  await ctx.tx.insert(publicationCorrections).values({ ...stamp(ctx), id: newId(), publicationId: id, before, after, reason: input.reason });
  const [row] = await ctx.tx.update(publications).set({ ...patch, ...touch(ctx, publications) }).where(eq(publications.id, id)).returning();
  let moved = 0;
  if (patch.actualPublishedAt && p.actualPublishedAt && input.recalculateCheckpoints) moved = await recalculatePendingCheckpoints(ctx, p, p.actualPublishedAt, patch.actualPublishedAt);
  if (patch.contentVersionId) await syncPublicationFiles(ctx, row!, patch.contentVersionId, true);
  await audit(ctx, {
    action: 'publication.corrected',
    entityType: 'publication',
    entityId: id,
    projectId: row!.projectId,
    reason: input.reason,
    diff: diffFields(p, row!, ['actualPublishedAt', 'externalPostUrl', 'noUrlReason', 'caption', 'primaryCampaignId', 'contentVersionId']),
    metadata: { checkpointsMoved: moved },
  });
  await emit(ctx, { type: 'publication.corrected', entityType: 'publication', entityId: id, revision: row!.rowVersion });
  await indexPublication(ctx, row!);
  return id;
};

/** Removed/Unavailable external post (§9, T069): availability changes; status, facts and observations stay. */
export const setPublicationAvailability = async (ctx: CommandContext, id: string, input: { availability: Pub['availability']; effectiveAt?: string; reason: string }) => {
  const p = await loadPublicationRow(ctx, id, { lock: true });
  authorizeObject(ctx, 'publications.confirm', publicationScope(p), 'publications.read');
  assertVersion(ctx, p);
  if (p.status !== 'published') throw new AppError('INVALID_STATE', 'Availability is recorded for published placements only.');
  if (input.availability === p.availability) throw fieldFail('availability', 'UNCHANGED', 'The placement already has this availability.');
  const at = input.effectiveAt ? new Date(input.effectiveAt) : ctx.app.clock.now();
  if (at.getTime() > ctx.app.clock.now().getTime() + PUBLISH_SKEW_MINUTES * 60_000) throw fieldFail('effectiveAt', 'IN_FUTURE', 'The date cannot be in the future.');
  if (p.actualPublishedAt && at.getTime() < p.actualPublishedAt.getTime()) throw fieldFail('effectiveAt', 'BEFORE_PUBLISHED', 'The date cannot be before the publication time.');
  const [row] = await ctx.tx
    .update(publications)
    .set({ availability: input.availability, availabilityChangedAt: at, availabilityReason: input.reason, ...touch(ctx, publications) })
    .where(eq(publications.id, id))
    .returning();
  await audit(ctx, { action: 'publication.availability_changed', entityType: 'publication', entityId: id, projectId: row!.projectId, reason: input.reason, diff: { availability: { from: p.availability, to: input.availability } } });
  await emit(ctx, { type: 'publication.availability_changed', entityType: 'publication', entityId: id, revision: row!.rowVersion, payload: { availability: input.availability } });
  await indexPublication(ctx, row!);
  return id;
};

// ——— Archive / trash ———

export const publicationObligations = (p: Pub) => {
  const items: { kind: string; label: string; count: number; blocking: boolean; resolution?: string }[] = [];
  if (p.status === 'scheduled') items.push({ kind: 'scheduled', label: 'The placement is scheduled', count: 1, blocking: true, resolution: 'Cancel it or confirm the post first.' });
  if (p.status === 'published') items.push({ kind: 'history', label: 'Published facts and metric checkpoints', count: 1, blocking: false, resolution: 'Archived records remain available in historical reports.' });
  return items;
};

export const archivePublication = async (ctx: CommandContext, id: string, input: { reason?: string }, opts: { skipVersion?: boolean } = {}) => {
  const p = await loadPublicationRow(ctx, id, { lock: true });
  authorizeObject(ctx, 'publications.write', publicationScope(p), 'publications.read');
  if (!opts.skipVersion) assertVersion(ctx, p);
  if (p.archivedAt) throw new AppError('INVALID_STATE', 'The publication is already archived.');
  const blocking = publicationObligations(p).filter((i) => i.blocking);
  if (blocking.length) throw new AppError('INVALID_STATE', 'Cancel the scheduled placement or confirm it before archiving.', { details: { items: blocking } });
  const at = ctx.app.clock.now();
  const [row] = await ctx.tx
    .update(publications)
    .set({ archivedAt: at, archivedBy: ctx.actor.userId, archiveReason: input.reason ?? null, ...touch(ctx, publications) })
    .where(eq(publications.id, id))
    .returning();
  await audit(ctx, { action: 'publication.archived', entityType: 'publication', entityId: id, projectId: row!.projectId, reason: input.reason });
  await emit(ctx, { type: 'publication.archived', entityType: 'publication', entityId: id, revision: row!.rowVersion });
  await indexPublication(ctx, row!);
  return id;
};

export const restorePublication = async (ctx: CommandContext, id: string) => {
  const p = await loadPublicationRow(ctx, id, { lock: true });
  authorizeObject(ctx, 'publications.write', publicationScope(p), 'publications.read');
  if (!p.archivedAt) return id;
  const [row] = await ctx.tx.update(publications).set({ archivedAt: null, archivedBy: null, archiveReason: null, ...touch(ctx, publications) }).where(eq(publications.id, id)).returning();
  await audit(ctx, { action: 'publication.restored', entityType: 'publication', entityId: id, projectId: row!.projectId });
  await emit(ctx, { type: 'publication.restored', entityType: 'publication', entityId: id, revision: row!.rowVersion });
  await indexPublication(ctx, row!);
  return id;
};

/** Move Draft to Trash: drafts only (nothing was scheduled or confirmed yet). */
export const trashPublicationDraft = async (ctx: CommandContext, id: string, reason: string) => {
  const p = await loadPublicationRow(ctx, id, { lock: true });
  authorizeObject(ctx, 'publications.write', publicationScope(p), 'publications.read');
  if (p.status !== 'draft') throw new AppError('INVALID_STATE', 'Only draft placements can be moved to the trash; cancel or archive other placements.');
  const [w] = await ctx.tx.select({ settings: workspaces.settings }).from(workspaces).where(eq(workspaces.id, ctx.actor.workspaceId));
  const days = (w?.settings as { retention?: { trashDays?: number } } | undefined)?.retention?.trashDays ?? 30;
  const at = ctx.app.clock.now();
  const [row] = await ctx.tx
    .update(publications)
    .set({ deletedAt: at, deletedBy: ctx.actor.userId, purgeAfter: new Date(at.getTime() + days * 86_400_000), ...touch(ctx, publications) })
    .where(eq(publications.id, id))
    .returning();
  await audit(ctx, { action: 'publication.trashed', entityType: 'publication', entityId: id, projectId: row!.projectId, reason });
  await emit(ctx, { type: 'publication.trashed', entityType: 'publication', entityId: id, revision: row!.rowVersion });
  await indexPublication(ctx, row!);
};

export const untrashPublicationDraft = async (ctx: CommandContext, id: string) => {
  const [p] = await ctx.tx.select().from(publications).where(and(eq(publications.workspaceId, ctx.actor.workspaceId), eq(publications.id, id))).for('update');
  if (!p || !p.deletedAt) throw new AppError('NOT_FOUND', 'Publication was not found.');
  authorizeObject(ctx, 'publications.write', publicationScope(p), 'publications.read');
  const [row] = await ctx.tx.update(publications).set({ deletedAt: null, deletedBy: null, purgeAfter: null, ...touch(ctx, publications) }).where(eq(publications.id, id)).returning();
  await audit(ctx, { action: 'publication.untrashed', entityType: 'publication', entityId: id, projectId: row!.projectId });
  await emit(ctx, { type: 'publication.untrashed', entityType: 'publication', entityId: id, revision: row!.rowVersion });
  await indexPublication(ctx, row!);
};

