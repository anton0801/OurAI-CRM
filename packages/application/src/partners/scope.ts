import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { hasAnywhere, listFilter } from '@castlane/authorization';
import { dealProjects, deals, partners } from '@castlane/database';
import { notFound } from '@castlane/domain';
import { allowed } from '../core/access';
import { dbOf, type CommandContext, type QueryContext } from '../core/context';

/**
 * Partners are business identities (not users, not project records). A member sees a partner when a
 * grant covers it (workspace scope), when they own it, or through a deal in one of their projects.
 * Deals are visible through any of their projects, or to their owner.
 */

export type PartnerRow = typeof partners.$inferSelect;
export type DealRow = typeof deals.$inferSelect;

const uuidList = (ids: string[]) => sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);

export const partnerVisibility = (ctx: QueryContext, permission: string): SQL | undefined => {
  const f = listFilter(ctx.actor.access, permission);
  if (f.kind === 'all') return undefined;
  if (f.kind === 'none') return sql`false`;
  const parts: SQL[] = [sql`${partners.ownerMembershipId} = ${ctx.actor.membershipId}::uuid`];
  if (f.projectIds.length)
    parts.push(
      sql`EXISTS (SELECT 1 FROM deals d JOIN deal_projects dp ON dp.deal_id = d.id WHERE d.partner_id = ${partners.id} AND dp.project_id IN (${uuidList(f.projectIds)}))`,
    );
  return sql`(${sql.join(parts, sql` OR `)})`;
};

export const dealVisibility = (ctx: QueryContext, permission: string): SQL | undefined => {
  const f = listFilter(ctx.actor.access, permission);
  if (f.kind === 'all') return undefined;
  if (f.kind === 'none') return sql`false`;
  const parts: SQL[] = [sql`${deals.ownerMembershipId} = ${ctx.actor.membershipId}::uuid`];
  if (f.projectIds.length) parts.push(sql`EXISTS (SELECT 1 FROM deal_projects dp WHERE dp.deal_id = ${deals.id} AND dp.project_id IN (${uuidList(f.projectIds)}))`);
  return sql`(${sql.join(parts, sql` OR `)})`;
};

export const partnerDealProjectIds = async (ctx: QueryContext | CommandContext, partnerId: string) => {
  const rows = await dbOf(ctx)
    .selectDistinct({ projectId: dealProjects.projectId })
    .from(dealProjects)
    .innerJoin(deals, and(eq(deals.workspaceId, dealProjects.workspaceId), eq(deals.id, dealProjects.dealId)))
    .where(and(eq(deals.workspaceId, ctx.actor.workspaceId), eq(deals.partnerId, partnerId)));
  return rows.map((r) => r.projectId);
};

export const dealProjectIds = async (ctx: QueryContext | CommandContext, dealIds: string[]) => {
  if (!dealIds.length) return new Map<string, string[]>();
  const rows = await dbOf(ctx)
    .select({ dealId: dealProjects.dealId, projectId: dealProjects.projectId })
    .from(dealProjects)
    .where(and(eq(dealProjects.workspaceId, ctx.actor.workspaceId), inArray(dealProjects.dealId, dealIds)))
    .orderBy(dealProjects.createdAt);
  const out = new Map<string, string[]>();
  for (const r of rows) out.set(r.dealId, [...(out.get(r.dealId) ?? []), r.projectId]);
  return out;
};

const ownerScope = (type: string, id: string, owner: string) => ({ objectType: type, objectId: id, ownerMembershipId: owner, assignedMembershipIds: [owner] });

export const canPartner = (ctx: QueryContext, permission: string, p: Pick<PartnerRow, 'id' | 'ownerMembershipId'>, viaProjects: string[]) =>
  allowed(ctx, permission, ownerScope('partner', p.id, p.ownerMembershipId)) ||
  (p.ownerMembershipId === ctx.actor.membershipId && hasAnywhere(ctx.actor.access, permission)) ||
  viaProjects.some((projectId) => allowed(ctx, permission, { objectType: 'partner', objectId: p.id, projectId }));

export const canDeal = (ctx: QueryContext, permission: string, d: Pick<DealRow, 'id' | 'ownerMembershipId'>, projectIds: string[]) =>
  allowed(ctx, permission, ownerScope('deal', d.id, d.ownerMembershipId)) ||
  (d.ownerMembershipId === ctx.actor.membershipId && hasAnywhere(ctx.actor.access, permission)) ||
  projectIds.some((projectId) => allowed(ctx, permission, { ...ownerScope('deal', d.id, d.ownerMembershipId), projectId }));

/** Finance amounts on deals (plans) need finance.read on one of the deal's projects. */
export const canSeeDealAmounts = (ctx: QueryContext, projectIds: string[]) =>
  ctx.actor.access.isOwner || projectIds.some((projectId) => allowed(ctx, 'finance.read', { projectId }));

export const loadPartnerRow = async (ctx: QueryContext | CommandContext, id: string, opts: { lock?: boolean } = {}) => {
  const q = dbOf(ctx).select().from(partners).where(and(eq(partners.workspaceId, ctx.actor.workspaceId), eq(partners.id, id)));
  const [p] = opts.lock && 'tx' in ctx ? await q.for('update') : await q;
  if (!p) throw notFound('Partner');
  const via = await partnerDealProjectIds(ctx, id);
  if (!canPartner(ctx, 'partners.read', p, via)) throw notFound('Partner');
  return { partner: p, via };
};

export const loadDealRow = async (ctx: QueryContext | CommandContext, id: string, opts: { lock?: boolean } = {}) => {
  const q = dbOf(ctx).select().from(deals).where(and(eq(deals.workspaceId, ctx.actor.workspaceId), eq(deals.id, id)));
  const [d] = opts.lock && 'tx' in ctx ? await q.for('update') : await q;
  if (!d) throw notFound('Deal');
  const projectIds = (await dealProjectIds(ctx, [id])).get(id) ?? [];
  if (!canDeal(ctx, 'deals.read', d, projectIds)) throw notFound('Deal');
  return { deal: d, projectIds };
};
