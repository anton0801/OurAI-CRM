import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { hasAnywhere, listFilter, type ObjectScope } from '@castlane/authorization';
import { campaignProjects, campaigns, experiments, publications, workspaces, type DbOrTx } from '@castlane/database';
import { notFound } from '@castlane/domain';
import { allowed, scopePredicate } from '../core/access';
import { dbOf, type CommandContext, type QueryContext } from '../core/context';
import { DEFAULT_GRACE_MINUTES } from './logic';

/**
 * Authorisation scopes of the publishing module.
 *
 * * Publication — its project at creation, its account (Publisher grants are account-scoped) and its
 *   owner (assigned-object / own-records grants).
 * * Campaign — visible through any linked project or to its owner; changing it needs the write
 *   permission on every linked project (or ownership).
 * * Experiment — its project and owner.
 */

export type PublicationRowDb = typeof publications.$inferSelect;
export type CampaignRowDb = typeof campaigns.$inferSelect;
export type ExperimentRowDb = typeof experiments.$inferSelect;

export const publicationScope = (p: Pick<PublicationRowDb, 'id' | 'projectId' | 'accountId' | 'ownerMembershipId'>): ObjectScope => ({
  objectType: 'publication',
  objectId: p.id,
  projectId: p.projectId,
  accountId: p.accountId,
  ownerMembershipId: p.ownerMembershipId,
  assignedMembershipIds: [p.ownerMembershipId],
});

/** SQL visibility of publications for a permission, applied before pagination and aggregation. */
export const publicationVisibility = (ctx: QueryContext, permission = 'publications.read'): SQL | undefined =>
  scopePredicate(ctx, permission, {
    projectId: publications.projectId,
    accountId: publications.accountId,
    assigned: [publications.ownerMembershipId],
    ownerMembership: publications.ownerMembershipId,
  });

export const canPublication = (ctx: QueryContext, permission: string, p: Pick<PublicationRowDb, 'id' | 'projectId' | 'accountId' | 'ownerMembershipId'>) =>
  allowed(ctx, permission, publicationScope(p));

export const loadPublicationRow = async (ctx: QueryContext | CommandContext, id: string, opts: { lock?: boolean } = {}): Promise<PublicationRowDb> => {
  const q = dbOf(ctx).select().from(publications).where(and(eq(publications.workspaceId, ctx.actor.workspaceId), eq(publications.id, id)));
  const [p] = opts.lock && 'tx' in ctx ? await q.for('update') : await q;
  if (!p || p.deletedAt) throw notFound('Publication');
  return p;
};

// ——— Campaigns ———

const uuidList = (ids: string[]) => sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);

export const campaignVisibility = (ctx: QueryContext, permission = 'campaigns.read'): SQL | undefined => {
  const f = listFilter(ctx.actor.access, permission);
  if (f.kind === 'all') return undefined;
  if (f.kind === 'none') return sql`false`;
  const parts: SQL[] = [];
  if (ctx.actor.membershipId) parts.push(sql`${campaigns.ownerMembershipId} = ${ctx.actor.membershipId}::uuid`);
  if (f.projectIds.length) parts.push(sql`EXISTS (SELECT 1 FROM campaign_projects cp WHERE cp.campaign_id = ${campaigns.id} AND cp.project_id IN (${uuidList(f.projectIds)}))`);
  if (!parts.length) return sql`false`;
  return sql`(${sql.join(parts, sql` OR `)})`;
};

const campaignObject = (c: Pick<CampaignRowDb, 'id' | 'ownerMembershipId'>, projectId?: string): ObjectScope => ({
  objectType: 'campaign',
  objectId: c.id,
  projectId: projectId ?? null,
  ownerMembershipId: c.ownerMembershipId,
  assignedMembershipIds: [c.ownerMembershipId],
});

/** Read-type check: the permission on any linked project, or ownership. */
export const canCampaign = (ctx: QueryContext, permission: string, c: Pick<CampaignRowDb, 'id' | 'ownerMembershipId'>, projectIds: string[]) =>
  (c.ownerMembershipId === ctx.actor.membershipId && hasAnywhere(ctx.actor.access, permission)) ||
  allowed(ctx, permission, campaignObject(c)) ||
  projectIds.some((p) => allowed(ctx, permission, campaignObject(c, p)));

/** Change-type check: the permission on every linked project (a campaign spanning projects is shared), or ownership. */
export const canChangeCampaign = (ctx: QueryContext, permission: string, c: Pick<CampaignRowDb, 'id' | 'ownerMembershipId'>, projectIds: string[]) =>
  (c.ownerMembershipId === ctx.actor.membershipId && hasAnywhere(ctx.actor.access, permission)) ||
  (projectIds.length > 0 && projectIds.every((p) => allowed(ctx, permission, campaignObject(c, p))));

export const campaignProjectMap = async (db: DbOrTx, workspaceId: string, campaignIds: string[]) => {
  const out = new Map<string, string[]>();
  if (!campaignIds.length) return out;
  const rows = await db
    .select({ campaignId: campaignProjects.campaignId, projectId: campaignProjects.projectId })
    .from(campaignProjects)
    .where(and(eq(campaignProjects.workspaceId, workspaceId), inArray(campaignProjects.campaignId, campaignIds)))
    .orderBy(campaignProjects.createdAt);
  for (const r of rows) out.set(r.campaignId, [...(out.get(r.campaignId) ?? []), r.projectId]);
  return out;
};

/** Load a campaign the actor can read (404 otherwise, existence never revealed). */
export const loadCampaignRow = async (ctx: QueryContext | CommandContext, id: string, opts: { lock?: boolean } = {}) => {
  const q = dbOf(ctx).select().from(campaigns).where(and(eq(campaigns.workspaceId, ctx.actor.workspaceId), eq(campaigns.id, id)));
  const [c] = opts.lock && 'tx' in ctx ? await q.for('update') : await q;
  if (!c) throw notFound('Campaign');
  const projectIds = (await campaignProjectMap(dbOf(ctx), ctx.actor.workspaceId, [id])).get(id) ?? [];
  if (!canCampaign(ctx, 'campaigns.read', c, projectIds)) throw notFound('Campaign');
  return { campaign: c, projectIds };
};

// ——— Experiments ———

export const experimentScope = (e: Pick<ExperimentRowDb, 'id' | 'projectId' | 'ownerMembershipId'>): ObjectScope => ({
  objectType: 'experiment',
  objectId: e.id,
  projectId: e.projectId,
  ownerMembershipId: e.ownerMembershipId,
  assignedMembershipIds: [e.ownerMembershipId],
});

export const experimentVisibility = (ctx: QueryContext, permission = 'experiments.read'): SQL | undefined =>
  scopePredicate(ctx, permission, { projectId: experiments.projectId, assigned: [experiments.ownerMembershipId], ownerMembership: experiments.ownerMembershipId });

// ——— Workspace settings used by the module ———

export const workspacePlanSettings = async (db: DbOrTx, workspaceId: string) => {
  const [w] = await db
    .select({ timezone: workspaces.timezone, weekStartsOn: workspaces.weekStartsOn, settings: workspaces.settings })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  const grace = (w?.settings as { publicationGraceMinutes?: number } | undefined)?.publicationGraceMinutes;
  return {
    timezone: w?.timezone ?? 'UTC',
    weekStartsOn: (w?.weekStartsOn ?? 'monday') as 'monday' | 'sunday',
    graceMinutes: typeof grace === 'number' && grace >= 0 ? grace : DEFAULT_GRACE_MINUTES,
  };
};
