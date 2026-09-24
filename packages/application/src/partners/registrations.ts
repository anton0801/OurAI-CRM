import { and, asc, eq, ilike, inArray, isNull, notInArray, or } from 'drizzle-orm';
import { dealProjects, deals, partners } from '@castlane/database';
import { requirePermission, whereAll } from '../core/access';
import { defineArchiveHandler } from '../core/archive-registry';
import { audit } from '../core/audit';
import { dbOf, type CommandContext } from '../core/context';
import { emit } from '../core/events';
import { defineLookup, likePattern } from '../core/lookup-registry';
import { notify } from '../core/notify';
import { defineResponsibilityProvider } from '../core/responsibility-registry';
import { touch } from '../core/rows';
import { defineLinkAccess } from '../media/link-access';
import { archiveDeal, dealArchivePreview, indexDeal, restoreDeal } from './deals';
import { archivePartner, indexPartner, partnerArchivePreview, restorePartner } from './partners';
import { dealProjectIds, dealVisibility, partnerDealProjectIds, partnerVisibility } from './scope';

// ——— Pickers ———

defineLookup({
  type: 'partner',
  async search(ctx, input) {
    requirePermission(ctx, 'partners.read');
    const rows = await dbOf(ctx)
      .select()
      .from(partners)
      .where(
        whereAll(
          eq(partners.workspaceId, ctx.actor.workspaceId),
          partnerVisibility(ctx, 'partners.read'),
          input.ids?.length ? inArray(partners.id, input.ids) : undefined,
          !input.ids?.length && !input.includeArchived ? isNull(partners.archivedAt) : undefined,
          input.q ? or(ilike(partners.name, likePattern(input.q)), ilike(partners.contactName, likePattern(input.q))) : undefined,
        ),
      )
      .orderBy(asc(partners.name))
      .limit(input.ids?.length ? Math.max(input.ids.length, input.limit) : input.limit);
    return rows.map((p) => ({
      id: p.id,
      label: p.name,
      sublabel: [p.kind === 'person' ? 'Person' : 'Organization', p.contactName].filter(Boolean).join(' · '),
      status: p.mergedIntoId ? 'merged' : null,
      projectId: null,
      archived: !!p.archivedAt,
    }));
  },
});

defineLookup({
  type: 'deal',
  async search(ctx, input) {
    requirePermission(ctx, 'deals.read');
    const rows = await dbOf(ctx)
      .select({ d: deals, partnerName: partners.name })
      .from(deals)
      .innerJoin(partners, and(eq(partners.workspaceId, deals.workspaceId), eq(partners.id, deals.partnerId)))
      .where(
        whereAll(
          eq(deals.workspaceId, ctx.actor.workspaceId),
          dealVisibility(ctx, 'deals.read'),
          input.ids?.length ? inArray(deals.id, input.ids) : undefined,
          !input.ids?.length && !input.includeArchived ? isNull(deals.archivedAt) : undefined,
          input.status?.length ? inArray(deals.stage, input.status as never[]) : undefined,
          input.parentId ? eq(deals.partnerId, input.parentId) : undefined,
          input.projectId ? inArray(deals.id, dbOf(ctx).select({ id: dealProjects.dealId }).from(dealProjects).where(eq(dealProjects.projectId, input.projectId))) : undefined,
          input.q ? or(ilike(deals.title, likePattern(input.q)), ilike(partners.name, likePattern(input.q))) : undefined,
        ),
      )
      .orderBy(asc(deals.title))
      .limit(input.ids?.length ? Math.max(input.ids.length, input.limit) : input.limit);
    const projectMap = await dealProjectIds(ctx, rows.map((r) => r.d.id));
    return rows.map(({ d, partnerName }) => ({
      id: d.id,
      label: d.title,
      sublabel: `${partnerName} · ${d.stage}`,
      status: d.stage,
      projectId: projectMap.get(d.id)?.[0] ?? null,
      archived: !!d.archivedAt,
    }));
  },
});

// ——— Files: partner logos and deal documents (contracts are uploaded as restricted media) ———

defineLinkAccess('partner', {
  permission: 'partners.read',
  scope: async (ctx, id) => {
    const [p] = await dbOf(ctx).select().from(partners).where(and(eq(partners.workspaceId, ctx.actor.workspaceId), eq(partners.id, id)));
    if (!p) return null;
    const via = await partnerDealProjectIds(ctx, id);
    return { objectType: 'partner', objectId: p.id, projectId: via[0] ?? null, ownerMembershipId: p.ownerMembershipId, assignedMembershipIds: [p.ownerMembershipId], label: p.name, href: `/w/${p.workspaceId}/partners?open=${p.id}` };
  },
});

defineLinkAccess('deal', {
  permission: 'deals.read',
  scope: async (ctx, id) => {
    const [d] = await dbOf(ctx).select().from(deals).where(and(eq(deals.workspaceId, ctx.actor.workspaceId), eq(deals.id, id)));
    if (!d) return null;
    const pids = (await dealProjectIds(ctx, [id])).get(id) ?? [];
    return { objectType: 'deal', objectId: d.id, projectId: pids[0] ?? null, ownerMembershipId: d.ownerMembershipId, assignedMembershipIds: [d.ownerMembershipId], label: d.title, href: `/w/${d.workspaceId}/deals/${d.id}` };
  },
});

// ——— Archive screen ———

defineArchiveHandler({
  entityType: 'partner',
  label: 'Partner',
  preview: partnerArchivePreview,
  archive: async (ctx, id, input) => {
    await archivePartner(ctx, id, { reason: input.reason }, { skipVersion: true });
  },
  restorePreview: async (ctx, id) => {
    const p = await partnerArchivePreview(ctx, id);
    return { title: p.title, items: [] };
  },
  restore: async (ctx, id) => {
    await restorePartner(ctx, id, { skipVersion: true });
  },
});

defineArchiveHandler({
  entityType: 'deal',
  label: 'Deal',
  preview: dealArchivePreview,
  archive: async (ctx, id, input) => {
    await archiveDeal(ctx, id, { reason: input.reason }, { skipVersion: true });
  },
  restorePreview: async (ctx, id) => {
    const p = await dealArchivePreview(ctx, id);
    return { title: p.title, items: [] };
  },
  restore: async (ctx, id) => {
    await restoreDeal(ctx, id, { skipVersion: true });
  },
});

// ——— Deactivation impact (F12): deal and partner ownership ———

const reassign = async (ctx: CommandContext, kind: 'deal' | 'partner', id: string, from: string, to: string, title: string) => {
  if (kind === 'deal') {
    const [row] = await ctx.tx.update(deals).set({ ownerMembershipId: to, ...touch(ctx, deals) }).where(and(eq(deals.id, id), eq(deals.ownerMembershipId, from))).returning();
    if (!row) return;
    await indexDeal(ctx, row);
  } else {
    const [row] = await ctx.tx.update(partners).set({ ownerMembershipId: to, ...touch(ctx, partners) }).where(and(eq(partners.id, id), eq(partners.ownerMembershipId, from))).returning();
    if (!row) return;
    await indexPartner(ctx, row);
  }
  await audit(ctx, { action: `${kind}.owner_transferred`, entityType: kind, entityId: id, diff: { ownerMembershipId: { from, to } } });
  await emit(ctx, { type: `${kind}.updated`, entityType: kind, entityId: id });
  await notify(ctx.tx, {
    workspaceId: ctx.actor.workspaceId,
    recipientMembershipIds: [to],
    eventType: `${kind}.owner_assigned`,
    eventKey: `${kind}.owner_transferred:${id}:${from}:${to}`,
    kind: 'assignment',
    title: `You now own the ${kind} ${title}`,
    entityType: kind,
    entityId: id,
    actorMembershipId: ctx.actor.membershipId,
    at: ctx.app.clock.now(),
  });
};

defineResponsibilityProvider({
  kind: 'deals.owner',
  label: 'Deal ownership',
  unassignedBehaviour: 'Ownership moves to the member performing the deactivation.',
  async list(ctx, membershipId) {
    const rows = await dbOf(ctx)
      .select()
      .from(deals)
      .where(and(eq(deals.workspaceId, ctx.actor.workspaceId), eq(deals.ownerMembershipId, membershipId), isNull(deals.archivedAt), notInArray(deals.stage, ['fulfilled', 'lost', 'cancelled'])));
    const projectMap = await dealProjectIds(ctx, rows.map((r) => r.id));
    return rows.map((d) => ({ kind: 'deals.owner', entityType: 'deal', entityId: d.id, title: d.title, projectId: projectMap.get(d.id)?.[0] ?? null, dueAt: d.expectedCloseDate, requiresSuccessor: true }));
  },
  async transfer(ctx, fromMembershipId, resolutions) {
    for (const r of resolutions) {
      const [d] = await ctx.tx.select().from(deals).where(and(eq(deals.workspaceId, ctx.actor.workspaceId), eq(deals.id, r.entityId)));
      const to = r.successorMembershipId ?? ctx.actor.membershipId;
      if (!d || !to || to === fromMembershipId) continue;
      await reassign(ctx, 'deal', d.id, fromMembershipId, to, d.title);
    }
  },
});

defineResponsibilityProvider({
  kind: 'partners.owner',
  label: 'Partner ownership',
  unassignedBehaviour: 'Ownership moves to the member performing the deactivation.',
  async list(ctx, membershipId) {
    const rows = await dbOf(ctx)
      .select()
      .from(partners)
      .where(and(eq(partners.workspaceId, ctx.actor.workspaceId), eq(partners.ownerMembershipId, membershipId), isNull(partners.archivedAt)));
    return rows.map((p) => ({ kind: 'partners.owner', entityType: 'partner', entityId: p.id, title: p.name, projectId: null, dueAt: null, requiresSuccessor: true }));
  },
  async transfer(ctx, fromMembershipId, resolutions) {
    for (const r of resolutions) {
      const [p] = await ctx.tx.select().from(partners).where(and(eq(partners.workspaceId, ctx.actor.workspaceId), eq(partners.id, r.entityId)));
      const to = r.successorMembershipId ?? ctx.actor.membershipId;
      if (!p || !to || to === fromMembershipId) continue;
      await reassign(ctx, 'partner', p.id, fromMembershipId, to, p.name);
    }
  },
});
