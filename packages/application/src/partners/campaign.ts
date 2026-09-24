import { eq } from 'drizzle-orm';
import { deals } from '@castlane/database';
import { AppError } from '@castlane/domain';
import { allowed } from '../core/access';
import { audit } from '../core/audit';
import type { CommandContext } from '../core/context';
import { emit } from '../core/events';
import { isActiveMember } from '../core/members';
import { assertVersion, touch } from '../core/rows';
import { createCampaign } from '../publishing/campaigns';
import { indexDeal } from './deals';
import { canDeal, loadDealRow } from './scope';

/**
 * "Create Campaign" on a deal (S74, `/deals/{id}/create-campaign`): a Planned campaign for the
 * deal's partner and projects, explicitly linked to the deal. No results, budgets or statistics
 * are created. The campaign itself is created by the campaigns module (`createCampaign`).
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
  const id = await createCampaign(
    ctx,
    { name: input.name, objective: input.objective, ownerMembershipId: owner, startDate: input.startDate, endDate: input.endDate, projectIds, partnerId: deal.partnerId },
    { source: { dealId }, partnerFromDeal: true },
  );
  const [row] = await ctx.tx.update(deals).set({ campaignId: id, ...touch(ctx, deals) }).where(eq(deals.id, dealId)).returning();
  await audit(ctx, { action: 'deal.campaign_linked', entityType: 'deal', entityId: dealId, projectId: projectIds[0] ?? null, diff: { campaignId: { from: null, to: id } } });
  await emit(ctx, { type: 'deal.updated', entityType: 'deal', entityId: dealId, revision: row!.rowVersion });
  await indexDeal(ctx, row!);
  return dealId;
};
