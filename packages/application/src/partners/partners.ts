import { and, asc, count, desc, eq, inArray, isNull, max, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { hasAnywhere } from '@castlane/authorization';
import { deals, partnerInteractions, partners } from '@castlane/database';
import { AppError, clampPageSize, decodeCursor, encodeCursor, isEmail, isUuid, newId, parseSafeUrl } from '@castlane/domain';
import { requirePermission, whereAll } from '../core/access';
import { audit, diffFields } from '../core/audit';
import { dbOf, type CommandContext, type QueryContext } from '../core/context';
import { emit } from '../core/events';
import { isActiveMember, loadMemberRefs, refOrUnknown } from '../core/members';
import { notify } from '../core/notify';
import { assertVersion, stamp, touch } from '../core/rows';
import { indexSearchDocument } from '../core/search';
import { resolveTags } from '../core/tags';
import { linkAsset } from '../media/assets';
import { assertAssetUsable, finishPage, keysetWhere, likeOf, pageSizeOf, signPreviewToken, thumbUrl, verifyPreviewToken, type SortKind } from '../accounts/helpers';
import { dealSummaries, indexDeal } from './deals';
import { canPartner, dealVisibility, loadPartnerRow, partnerVisibility, type PartnerRow } from './scope';

export const CLOSED_DEAL_STAGES = ['fulfilled', 'lost', 'cancelled'] as const;

// ——— Read models ———

const partnerRows = async (ctx: QueryContext | CommandContext, rows: PartnerRow[]) => {
  if (!rows.length) return [];
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const ids = rows.map((r) => r.id);
  // Deal counts respect the actor's deal scope: counts never include deals they cannot see.
  const active = await db
    .select({ partnerId: deals.partnerId, n: count() })
    .from(deals)
    .where(whereAll(eq(deals.workspaceId, ws), inArray(deals.partnerId, ids), isNull(deals.archivedAt), notInArray(deals.stage, [...CLOSED_DEAL_STAGES]), dealVisibility(ctx, 'deals.read')))
    .groupBy(deals.partnerId);
  const last = await db
    .select({ partnerId: partnerInteractions.partnerId, at: max(partnerInteractions.occurredAt) })
    .from(partnerInteractions)
    .where(and(eq(partnerInteractions.workspaceId, ws), inArray(partnerInteractions.partnerId, ids)))
    .groupBy(partnerInteractions.partnerId);
  const mergedIds = rows.map((r) => r.mergedIntoId).filter((x): x is string => !!x);
  const merged = mergedIds.length ? await db.select({ id: partners.id, name: partners.name }).from(partners).where(inArray(partners.id, mergedIds)) : [];
  const refs = await loadMemberRefs(db, ws, rows.map((r) => r.ownerMembershipId));
  return rows.map((p) => {
    const l = last.find((x) => x.partnerId === p.id)?.at ?? null;
    return {
      id: p.id,
      kind: p.kind,
      name: p.name,
      contactName: p.contactName,
      businessEmail: p.businessEmail,
      website: p.website,
      owner: refOrUnknown(refs, p.ownerMembershipId)!,
      tags: p.tags,
      logoUrl: thumbUrl(p.workspaceId, p.logoAssetId, 64),
      logoAssetId: p.logoAssetId,
      activeDeals: Number(active.find((a) => a.partnerId === p.id)?.n ?? 0),
      lastInteractionAt: l ? l.toISOString() : null,
      mergedInto: merged.find((m) => m.id === p.mergedIntoId) ?? null,
      archivedAt: p.archivedAt?.toISOString() ?? null,
      updatedAt: p.updatedAt.toISOString(),
      rowVersion: p.rowVersion,
    };
  });
};

export interface ListPartnersInput {
  cursor?: string;
  pageSize?: number;
  q?: string;
  kind?: PartnerRow['kind'][];
  ownerMembershipId?: string;
  tag?: string;
  includeArchived?: boolean;
  sort: 'name' | 'updatedAt';
  direction: 'asc' | 'desc';
}

const SORTS: Record<ListPartnersInput['sort'], { expr: SQL; kind: SortKind; value: (p: PartnerRow) => string }> = {
  name: { expr: sql`lower(${partners.name})`, kind: 'text', value: (p) => p.name.toLowerCase() },
  updatedAt: { expr: sql`${partners.updatedAt}`, kind: 'timestamp', value: (p) => p.updatedAt.toISOString() },
};

export const listPartners = async (ctx: QueryContext, input: ListPartnersInput) => {
  requirePermission(ctx, 'partners.read');
  const size = pageSizeOf(input.pageSize);
  const s = SORTS[input.sort];
  const rows = await ctx.app.db
    .select()
    .from(partners)
    .where(
      whereAll(
        eq(partners.workspaceId, ctx.actor.workspaceId),
        partnerVisibility(ctx, 'partners.read'),
        input.includeArchived ? undefined : isNull(partners.archivedAt),
        input.kind?.length ? inArray(partners.kind, input.kind) : undefined,
        input.ownerMembershipId ? eq(partners.ownerMembershipId, input.ownerMembershipId) : undefined,
        input.tag ? sql`lower(${input.tag}) = ANY(SELECT lower(t) FROM unnest(${partners.tags}) t)` : undefined,
        input.q ? or(sql`${partners.name} ILIKE ${likeOf(input.q)}`, sql`${partners.contactName} ILIKE ${likeOf(input.q)}`, sql`${partners.businessEmail} ILIKE ${likeOf(input.q)}`) : undefined,
        keysetWhere(s.expr, partners.id, input.direction, input.cursor, s.kind),
      ),
    )
    .orderBy(input.direction === 'asc' ? asc(s.expr) : desc(s.expr), input.direction === 'asc' ? asc(partners.id) : desc(partners.id))
    .limit(size + 1);
  return finishPage(rows, size, s.value, (page) => partnerRows(ctx, page));
};

export const getPartner = async (ctx: QueryContext | CommandContext, id: string) => {
  const { partner: p, via } = await loadPartnerRow(ctx, id);
  const [row] = await partnerRows(ctx, [p]);
  const db = dbOf(ctx);
  const [total] = await db.select({ n: count() }).from(deals).where(and(eq(deals.workspaceId, ctx.actor.workspaceId), eq(deals.partnerId, id)));
  const visible = await db
    .select()
    .from(deals)
    .where(whereAll(eq(deals.workspaceId, ctx.actor.workspaceId), eq(deals.partnerId, id), dealVisibility(ctx, 'deals.read')))
    .orderBy(desc(deals.updatedAt))
    .limit(100);
  const canWrite = canPartner(ctx, 'partners.write', p, via);
  const archived = !!p.archivedAt;
  return {
    ...row!,
    notes: p.notes,
    deals: await dealSummaries(ctx, visible),
    hiddenDealCount: Math.max(0, Number(total?.n ?? 0) - visible.length),
    permissions: {
      update: canWrite && !archived,
      archive: canWrite,
      logInteraction: canWrite && !archived,
      createDeal: hasAnywhere(ctx.actor.access, 'deals.write') && !archived,
      merge: canWrite && !archived,
    },
  };
};

// ——— Commands ———

export const indexPartner = (ctx: CommandContext, p: PartnerRow) =>
  indexSearchDocument(ctx.tx, {
    workspaceId: ctx.actor.workspaceId,
    entityType: 'partner',
    entityId: p.id,
    title: p.name,
    body: [p.contactName, p.businessEmail, p.website, p.tags.join(' ')].filter(Boolean).join('\n'),
    permission: 'partners.read',
    ownerMembershipId: p.ownerMembershipId,
    assigneeMembershipIds: [p.ownerMembershipId],
    archived: !!p.archivedAt,
    thumbnailAssetId: p.logoAssetId,
    at: ctx.app.clock.now(),
  });

export interface PartnerInput {
  kind?: PartnerRow['kind'];
  name?: string;
  contactName?: string | null;
  businessEmail?: string | null;
  website?: string | null;
  ownerMembershipId?: string;
  tags?: string[];
  logoAssetId?: string | null;
  notes?: string | null;
}

const clean = (v: string | null | undefined) => (v === undefined ? undefined : v?.trim() || null);

const validatePartnerFields = (input: PartnerInput) => {
  const email = clean(input.businessEmail);
  if (email && !isEmail(email))
    throw new AppError('VALIDATION_FAILED', 'Enter a valid e-mail address.', { fieldErrors: [{ field: 'businessEmail', code: 'INVALID', message: 'Enter a valid e-mail address.' }] });
  const website = clean(input.website);
  if (website && !parseSafeUrl(website))
    throw new AppError('VALIDATION_FAILED', 'Enter a valid http(s) link.', { fieldErrors: [{ field: 'website', code: 'INVALID_URL', message: 'Enter a valid http(s) link.' }] });
};

const assertOwner = async (ctx: CommandContext, membershipId: string) => {
  if (!(await isActiveMember(ctx.tx, ctx.actor.workspaceId, membershipId)))
    throw new AppError('VALIDATION_FAILED', 'The owner must be an active member.', { fieldErrors: [{ field: 'ownerMembershipId', code: 'INACTIVE', message: 'The owner must be an active member.' }] });
};

export const createPartner = async (ctx: CommandContext, input: PartnerInput & { kind: PartnerRow['kind']; name: string; ownerMembershipId: string }) => {
  requirePermission(ctx, 'partners.write');
  validatePartnerFields(input);
  await assertOwner(ctx, input.ownerMembershipId);
  const id = newId();
  // Scoped members may create partners they own; assigning someone else needs a workspace-level grant.
  if (!canPartner(ctx, 'partners.write', { id, ownerMembershipId: input.ownerMembershipId }, []))
    throw new AppError('FORBIDDEN', 'You can add partners that you own. Ask a workspace lead to add a partner for someone else.');
  if (input.logoAssetId) await assertAssetUsable(ctx, input.logoAssetId, 'logoAssetId', { imageOnly: true });
  const [row] = await ctx.tx
    .insert(partners)
    .values({
      ...stamp(ctx),
      id,
      kind: input.kind,
      name: input.name.trim(),
      contactName: clean(input.contactName) ?? null,
      businessEmail: clean(input.businessEmail) ?? null,
      website: clean(input.website) ?? null,
      ownerMembershipId: input.ownerMembershipId,
      tags: await resolveTags(ctx, input.tags),
      logoAssetId: input.logoAssetId ?? null,
      notes: input.notes ?? null,
    })
    .returning();
  if (input.logoAssetId) await linkAsset(ctx, input.logoAssetId, { target: { entityType: 'partner', entityId: id, role: 'logo' } });
  await audit(ctx, { action: 'partner.created', entityType: 'partner', entityId: id, diff: diffFields(null, row!, ['kind', 'name', 'ownerMembershipId']) });
  await emit(ctx, { type: 'partner.created', entityType: 'partner', entityId: id, revision: 1 });
  await indexPartner(ctx, row!);
  return id;
};

export const updatePartner = async (ctx: CommandContext, id: string, input: PartnerInput) => {
  const { partner: p, via } = await loadPartnerRow(ctx, id, { lock: true });
  if (!canPartner(ctx, 'partners.write', p, via)) throw new AppError('FORBIDDEN', 'You cannot change this partner.');
  assertVersion(ctx, p);
  if (p.archivedAt) throw new AppError('INVALID_STATE', 'Restore the partner before editing it.');
  validatePartnerFields(input);
  const patch: Partial<PartnerRow> = {};
  if (input.kind !== undefined) patch.kind = input.kind;
  if (input.name !== undefined) patch.name = input.name.trim();
  if (input.contactName !== undefined) patch.contactName = clean(input.contactName) ?? null;
  if (input.businessEmail !== undefined) patch.businessEmail = clean(input.businessEmail) ?? null;
  if (input.website !== undefined) patch.website = clean(input.website) ?? null;
  if (input.notes !== undefined) patch.notes = input.notes;
  if (input.tags !== undefined) patch.tags = await resolveTags(ctx, input.tags);
  if (input.ownerMembershipId && input.ownerMembershipId !== p.ownerMembershipId) {
    await assertOwner(ctx, input.ownerMembershipId);
    patch.ownerMembershipId = input.ownerMembershipId;
  }
  if (input.logoAssetId !== undefined) {
    if (input.logoAssetId) await assertAssetUsable(ctx, input.logoAssetId, 'logoAssetId', { imageOnly: true });
    patch.logoAssetId = input.logoAssetId;
  }
  const [row] = await ctx.tx.update(partners).set({ ...patch, ...touch(ctx, partners) }).where(eq(partners.id, id)).returning();
  if (patch.logoAssetId) await linkAsset(ctx, patch.logoAssetId, { target: { entityType: 'partner', entityId: id, role: 'logo' } });
  await audit(ctx, { action: 'partner.updated', entityType: 'partner', entityId: id, diff: diffFields(p, row!, ['kind', 'name', 'contactName', 'businessEmail', 'website', 'ownerMembershipId', 'tags', 'logoAssetId']) });
  await emit(ctx, { type: 'partner.updated', entityType: 'partner', entityId: id, revision: row!.rowVersion });
  await indexPartner(ctx, row!);
  if (patch.ownerMembershipId)
    await notify(ctx.tx, {
      workspaceId: ctx.actor.workspaceId,
      recipientMembershipIds: [patch.ownerMembershipId],
      eventType: 'partner.owner_assigned',
      eventKey: `partner.owner_assigned:${id}:${patch.ownerMembershipId}:${row!.rowVersion}`,
      kind: 'assignment',
      title: `You own the partner ${row!.name}`,
      entityType: 'partner',
      entityId: id,
      actorMembershipId: ctx.actor.membershipId,
      at: ctx.app.clock.now(),
    });
  return id;
};

export const partnerArchivePreview = async (ctx: QueryContext | CommandContext, id: string) => {
  const { partner: p, via } = await loadPartnerRow(ctx, id);
  if (!canPartner(ctx, 'partners.write', p, via)) throw new AppError('FORBIDDEN', 'You cannot archive this partner.');
  const [open] = await dbOf(ctx)
    .select({ n: count() })
    .from(deals)
    .where(and(eq(deals.workspaceId, ctx.actor.workspaceId), eq(deals.partnerId, id), isNull(deals.archivedAt), notInArray(deals.stage, [...CLOSED_DEAL_STAGES])));
  const n = Number(open?.n ?? 0);
  return {
    title: p.name,
    rowVersion: p.rowVersion,
    items: n ? [{ kind: 'open_deals', label: 'Open deals', count: n, blocking: true, resolution: 'Close the deals (Fulfilled, Lost or Cancelled) first.' }] : [],
  };
};

export const archivePartner = async (ctx: CommandContext, id: string, input: { reason?: string }, opts: { skipVersion?: boolean } = {}) => {
  const { partner: p } = await loadPartnerRow(ctx, id, { lock: true });
  const preview = await partnerArchivePreview(ctx, id);
  if (!opts.skipVersion) assertVersion(ctx, p);
  if (p.archivedAt) throw new AppError('INVALID_STATE', 'This partner is already archived.');
  if (preview.items.some((i) => i.blocking)) throw new AppError('INVALID_STATE', 'Close the partner’s open deals before archiving.', { details: { items: preview.items } });
  const [row] = await ctx.tx
    .update(partners)
    .set({ archivedAt: ctx.app.clock.now(), archivedBy: ctx.actor.userId, archiveReason: input.reason ?? null, ...touch(ctx, partners) })
    .where(eq(partners.id, id))
    .returning();
  await audit(ctx, { action: 'partner.archived', entityType: 'partner', entityId: id, reason: input.reason ?? null });
  await emit(ctx, { type: 'partner.archived', entityType: 'partner', entityId: id, revision: row!.rowVersion });
  await indexPartner(ctx, row!);
  return id;
};

export const restorePartner = async (ctx: CommandContext, id: string, opts: { skipVersion?: boolean } = {}) => {
  const { partner: p, via } = await loadPartnerRow(ctx, id, { lock: true });
  if (!canPartner(ctx, 'partners.write', p, via)) throw new AppError('FORBIDDEN', 'You cannot restore this partner.');
  if (!opts.skipVersion) assertVersion(ctx, p);
  if (!p.archivedAt) throw new AppError('INVALID_STATE', 'This partner is not archived.');
  if (p.mergedIntoId) throw new AppError('INVALID_STATE', 'Merged partners cannot be restored. Work with the partner they were merged into.');
  const [row] = await ctx.tx.update(partners).set({ archivedAt: null, archivedBy: null, archiveReason: null, ...touch(ctx, partners) }).where(eq(partners.id, id)).returning();
  await audit(ctx, { action: 'partner.restored', entityType: 'partner', entityId: id });
  await emit(ctx, { type: 'partner.restored', entityType: 'partner', entityId: id, revision: row!.rowVersion });
  await indexPartner(ctx, row!);
  return id;
};

// ——— Interactions ———

const interactionViews = async (ctx: QueryContext | CommandContext, rows: (typeof partnerInteractions.$inferSelect)[]) => {
  if (!rows.length) return [];
  const db = dbOf(ctx);
  const dealIds = rows.map((r) => r.dealId).filter((x): x is string => !!x);
  const dealRows = dealIds.length
    ? await db.select({ id: deals.id, title: deals.title }).from(deals).where(whereAll(eq(deals.workspaceId, ctx.actor.workspaceId), inArray(deals.id, dealIds), dealVisibility(ctx, 'deals.read')))
    : [];
  const refs = await loadMemberRefs(db, ctx.actor.workspaceId, rows.map((r) => r.membershipId));
  return rows.map((r) => ({
    id: r.id,
    partnerId: r.partnerId,
    deal: dealRows.find((d) => d.id === r.dealId) ?? null,
    occurredAt: r.occurredAt.toISOString(),
    kind: r.kind,
    summary: r.summary,
    author: refOrUnknown(refs, r.membershipId),
    createdAt: r.createdAt.toISOString(),
  }));
};

export const listPartnerInteractions = async (ctx: QueryContext, partnerId: string, input: { cursor?: string; pageSize?: number; dealId?: string }) => {
  await loadPartnerRow(ctx, partnerId);
  const size = clampPageSize(input.pageSize ?? 30);
  const c = input.cursor ? decodeCursor(input.cursor) : null;
  const rows = await ctx.app.db
    .select()
    .from(partnerInteractions)
    .where(
      and(
        eq(partnerInteractions.workspaceId, ctx.actor.workspaceId),
        eq(partnerInteractions.partnerId, partnerId),
        input.dealId ? eq(partnerInteractions.dealId, input.dealId) : undefined,
        c ? sql`(${partnerInteractions.occurredAt}, ${partnerInteractions.id}) < (${String(c.v[0])}::timestamptz, ${c.id}::uuid)` : undefined,
      ),
    )
    .orderBy(desc(partnerInteractions.occurredAt), desc(partnerInteractions.id))
    .limit(size + 1);
  const hasMore = rows.length > size;
  const page = hasMore ? rows.slice(0, size) : rows;
  const last = page[page.length - 1];
  return { items: await interactionViews(ctx, page), hasMore, nextCursor: hasMore && last ? encodeCursor({ v: [last.occurredAt.toISOString()], id: last.id }) : null };
};

export const interactionsForDeal = async (ctx: QueryContext | CommandContext, dealId: string) => {
  const rows = await dbOf(ctx)
    .select()
    .from(partnerInteractions)
    .where(and(eq(partnerInteractions.workspaceId, ctx.actor.workspaceId), eq(partnerInteractions.dealId, dealId)))
    .orderBy(desc(partnerInteractions.occurredAt))
    .limit(50);
  return interactionViews(ctx, rows);
};

export const logPartnerInteraction = async (
  ctx: CommandContext,
  partnerId: string,
  input: { occurredAt: string; kind: (typeof partnerInteractions.$inferSelect)['kind']; summary: string; dealId?: string | null },
) => {
  const { partner: p, via } = await loadPartnerRow(ctx, partnerId, { lock: true });
  if (!canPartner(ctx, 'partners.write', p, via)) throw new AppError('FORBIDDEN', 'You cannot log interactions for this partner.');
  if (p.archivedAt) throw new AppError('INVALID_STATE', 'Restore the partner before logging interactions.');
  const occurredAt = new Date(input.occurredAt);
  if (occurredAt.getTime() > ctx.app.clock.now().getTime() + 5 * 60_000)
    throw new AppError('VALIDATION_FAILED', 'Interactions are logged after they happened.', { fieldErrors: [{ field: 'occurredAt', code: 'MUST_BE_PAST', message: 'Choose a time in the past.' }] });
  if (input.dealId) {
    const [d] = await ctx.tx.select({ id: deals.id, partnerId: deals.partnerId }).from(deals).where(and(eq(deals.workspaceId, ctx.actor.workspaceId), eq(deals.id, input.dealId)));
    if (!d || d.partnerId !== partnerId)
      throw new AppError('VALIDATION_FAILED', 'Choose a deal of this partner.', { fieldErrors: [{ field: 'dealId', code: 'INVALID', message: 'Choose a deal of this partner.' }] });
  }
  const id = newId();
  const [row] = await ctx.tx
    .insert(partnerInteractions)
    .values({ ...stamp(ctx), id, partnerId, dealId: input.dealId ?? null, occurredAt, kind: input.kind, summary: input.summary.trim(), membershipId: ctx.actor.membershipId! })
    .returning();
  await ctx.tx.update(partners).set({ updatedAt: ctx.app.clock.now() }).where(eq(partners.id, partnerId));
  await audit(ctx, { action: 'partner.interaction_logged', entityType: 'partner', entityId: partnerId, metadata: { kind: input.kind, dealId: input.dealId ?? null } });
  await emit(ctx, { type: 'partner.interaction_logged', entityType: 'partner', entityId: partnerId });
  if (input.dealId) await emit(ctx, { type: 'deal.updated', entityType: 'deal', entityId: input.dealId });
  return (await interactionViews(ctx, [row!]))[0]!;
};

// ——— Merge ———

export const partnerMergePreview = async (ctx: QueryContext, sourceId: string, targetId: string) => {
  if (!isUuid(targetId) || sourceId === targetId)
    throw new AppError('VALIDATION_FAILED', 'Choose another partner to merge into.', { fieldErrors: [{ field: 'targetId', code: 'INVALID', message: 'Choose another partner to merge into.' }] });
  const { partner: source, via: sv } = await loadPartnerRow(ctx, sourceId);
  const { partner: target, via: tv } = await loadPartnerRow(ctx, targetId);
  if (!canPartner(ctx, 'partners.write', source, sv) || !canPartner(ctx, 'partners.write', target, tv)) throw new AppError('FORBIDDEN', 'You cannot merge these partners.');
  if (source.archivedAt || target.archivedAt) throw new AppError('INVALID_STATE', 'Archived or merged partners cannot be merged.');
  const db = ctx.app.db;
  const [d] = await db.select({ n: count() }).from(deals).where(and(eq(deals.workspaceId, ctx.actor.workspaceId), eq(deals.partnerId, sourceId)));
  const [i] = await db.select({ n: count() }).from(partnerInteractions).where(and(eq(partnerInteractions.workspaceId, ctx.actor.workspaceId), eq(partnerInteractions.partnerId, sourceId)));
  const refs = await loadMemberRefs(db, ctx.actor.workspaceId, [source.ownerMembershipId, target.ownerMembershipId]);
  const fields: [string, string | null, string | null][] = [
    ['Kind', source.kind, target.kind],
    ['Contact Name', source.contactName, target.contactName],
    ['Business Email', source.businessEmail, target.businessEmail],
    ['Website', source.website, target.website],
    ['Owner', refs.get(source.ownerMembershipId)?.displayName ?? null, refs.get(target.ownerMembershipId)?.displayName ?? null],
    ['Tags', source.tags.join(', ') || null, target.tags.join(', ') || null],
  ];
  const [s, t] = await partnerRows(ctx, [source, target]);
  const token = signPreviewToken(ctx, 'partner.merge', [sourceId, targetId, source.rowVersion, target.rowVersion]);
  return {
    source: s!,
    target: t!,
    moves: { deals: Number(d?.n ?? 0), interactions: Number(i?.n ?? 0) },
    differences: fields.filter(([, a, b]) => a !== b).map(([field, a, b]) => ({ field, source: a, target: b })),
    previewToken: token.token,
    expiresAt: token.expiresAt.toISOString(),
  };
};

/** Merge: deals and interactions move to the target; the source is archived as merged (kept for history). */
export const mergePartner = async (ctx: CommandContext, sourceId: string, input: { targetId: string; previewToken: string }) => {
  const { partner: source, via: sv } = await loadPartnerRow(ctx, sourceId, { lock: true });
  const { partner: target, via: tv } = await loadPartnerRow(ctx, input.targetId, { lock: true });
  if (!canPartner(ctx, 'partners.write', source, sv) || !canPartner(ctx, 'partners.write', target, tv)) throw new AppError('FORBIDDEN', 'You cannot merge these partners.');
  assertVersion(ctx, source);
  if (source.archivedAt || target.archivedAt) throw new AppError('INVALID_STATE', 'Archived or merged partners cannot be merged.');
  verifyPreviewToken(ctx, 'partner.merge', [sourceId, input.targetId, source.rowVersion, target.rowVersion], input.previewToken);
  const movedDeals = await ctx.tx.update(deals).set({ partnerId: target.id, ...touch(ctx, deals) }).where(and(eq(deals.workspaceId, ctx.actor.workspaceId), eq(deals.partnerId, sourceId))).returning({ id: deals.id });
  const movedInteractions = await ctx.tx.update(partnerInteractions).set({ partnerId: target.id, ...touch(ctx, partnerInteractions) }).where(eq(partnerInteractions.partnerId, sourceId)).returning({ id: partnerInteractions.id });
  const tags = [...new Map([...target.tags, ...source.tags].map((t) => [t.toLowerCase(), t])).values()].slice(0, 30);
  const [t] = await ctx.tx
    .update(partners)
    .set({
      tags,
      contactName: target.contactName ?? source.contactName,
      businessEmail: target.businessEmail ?? source.businessEmail,
      website: target.website ?? source.website,
      ...touch(ctx, partners),
    })
    .where(eq(partners.id, target.id))
    .returning();
  const at = ctx.app.clock.now();
  const [s] = await ctx.tx
    .update(partners)
    .set({ mergedIntoId: target.id, archivedAt: at, archivedBy: ctx.actor.userId, archiveReason: `Merged into ${target.name}`, ...touch(ctx, partners) })
    .where(eq(partners.id, sourceId))
    .returning();
  await audit(ctx, { action: 'partner.merged', entityType: 'partner', entityId: sourceId, metadata: { targetId: target.id, deals: movedDeals.length, interactions: movedInteractions.length } });
  await audit(ctx, { action: 'partner.merge_received', entityType: 'partner', entityId: target.id, metadata: { sourceId, deals: movedDeals.length, interactions: movedInteractions.length } });
  await emit(ctx, { type: 'partner.merged', entityType: 'partner', entityId: sourceId, payload: { targetId: target.id } });
  await emit(ctx, { type: 'partner.updated', entityType: 'partner', entityId: target.id, revision: t!.rowVersion });
  for (const d of movedDeals) {
    await emit(ctx, { type: 'deal.updated', entityType: 'deal', entityId: d.id });
    const [row] = await ctx.tx.select().from(deals).where(eq(deals.id, d.id));
    if (row) await indexDeal(ctx, row);
  }
  await indexPartner(ctx, s!);
  await indexPartner(ctx, t!);
  return target.id;
};
