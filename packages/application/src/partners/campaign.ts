import { eq } from 'drizzle-orm';
import { campaignProjects, campaigns, deals } from '@castlane/database';
import { AppError, newId } from '@castlane/domain';
import { allowed } from '../core/access';
import { audit } from '../core/audit';
import type { CommandContext } from '../core/context';
import { emit } from '../core/events';
import { isActiveMember } from '../core/members';
import { assertVersion, stamp, touch } from '../core/rows';
import { indexSearchDocument } from '../core/search';
import { indexDeal } from './deals';
import { canDeal, loadDealRow } from './scope';

/**
 * "Create Campaign" on a deal (S74, `/deals/{id}/create-campaign`): a Planned campaign for the
 * deal's partner and projects, explicitly linked to the deal. No results, budgets or statistics
 * are created.
 *
 * Integration note: writes the campaigns module's `campaigns` / `campaign_projects` rows directly
 * because that module (built in parallel) exposes no create helper yet; replace the insert with its
 * helper when available.
 */
export const createCampaignForDeal = async (
  ctx: CommandContext,
  dealId: string,
  input: { name: string; objective: string; startDate: string; endDate: string; ownerMembershipId?: string },
) => {
  const { deal, projectIds } = await loadDealRow(ctx, dealId, { lock: true });
  if (!canDeal(ctx, 'deals.write', deal, projectIds)) throw new AppError('FORBIDDEN', 'You cannot change this deal.');
  assertVersion(ctx, deal);
  if (deal.archivedAt) throw new AppError('INVALID_STATE', 'Archived deals are read-only.');
  if (deal.campaignId) throw new AppError('INVALID_STATE', 'This deal already has a campaign.');
  if (!projectIds.every((p) => allowed(ctx, 'campaigns.write', { projectId: p }))) throw new AppError('FORBIDDEN', 'You cannot create campaigns for all of this deal’s projects.');
  if (input.endDate < input.startDate)
    throw new AppError('VALIDATION_FAILED', 'The end date is before the start date.', { fieldErrors: [{ field: 'endDate', code: 'BEFORE_START', message: 'The end date is before the start date.' }] });
  const owner = input.ownerMembershipId ?? deal.ownerMembershipId;
  if (!(await isActiveMember(ctx.tx, ctx.actor.workspaceId, owner)))
    throw new AppError('VALIDATION_FAILED', 'The owner must be an active member.', { fieldErrors: [{ field: 'ownerMembershipId', code: 'INACTIVE', message: 'The owner must be an active member.' }] });
  const id = newId();
  await ctx.tx.insert(campaigns).values({
    ...stamp(ctx),
    id,
    name: input.name.trim(),
    objective: input.objective.trim(),
    ownerMembershipId: owner,
    startDate: input.startDate,
    endDate: input.endDate,
    status: 'planned',
    partnerId: deal.partnerId,
  });
  for (const projectId of projectIds) await ctx.tx.insert(campaignProjects).values({ ...stamp(ctx), id: newId(), campaignId: id, projectId });
  const [row] = await ctx.tx.update(deals).set({ campaignId: id, ...touch(ctx, deals) }).where(eq(deals.id, dealId)).returning();
  await audit(ctx, { action: 'campaign.created', entityType: 'campaign', entityId: id, projectId: projectIds[0] ?? null, metadata: { fromDealId: dealId, projectIds } });
  await audit(ctx, { action: 'deal.campaign_linked', entityType: 'deal', entityId: dealId, projectId: projectIds[0] ?? null, diff: { campaignId: { from: null, to: id } } });
  await emit(ctx, { type: 'campaign.created', entityType: 'campaign', entityId: id, revision: 1, payload: { dealId } });
  await emit(ctx, { type: 'deal.updated', entityType: 'deal', entityId: dealId, revision: row!.rowVersion });
  await indexSearchDocument(ctx.tx, {
    workspaceId: ctx.actor.workspaceId,
    entityType: 'campaign',
    entityId: id,
    title: input.name.trim(),
    body: input.objective.trim(),
    projectId: projectIds[0] ?? null,
    permission: 'campaigns.read',
    ownerMembershipId: owner,
    status: 'planned',
    at: ctx.app.clock.now(),
  });
  await indexDeal(ctx, row!);
  return dealId;
};
