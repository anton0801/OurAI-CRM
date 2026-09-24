import { and, eq } from 'drizzle-orm';
import { contentItems, contentStageEvents, projects, references } from '@castlane/database';
import { AppError, newId } from '@castlane/domain';
import { allowed } from '../core/access';
import { audit } from '../core/audit';
import type { CommandContext } from '../core/context';
import { emit } from '../core/events';
import { stamp } from '../core/rows';
import { indexSearchDocument } from '../core/search';
import { projectScopeOf } from './common';

type ContentFormat = (typeof contentItems.$inferSelect)['format'];

/**
 * Create the content draft (stage Idea) for "Use as Idea" (S21 → S23, T035).
 *
 * Integration note: this writes the content module's `content_items` row directly because the
 * content module (built in parallel) does not expose a create helper yet. When it does, replace
 * the body of this one function with a call to that helper; callers stay unchanged.
 */
export const createIdeaDraftFromReference = async (
  ctx: CommandContext,
  reference: typeof references.$inferSelect,
  input: { projectId: string; format: ContentFormat; title?: string },
): Promise<string> => {
  const [p] = await ctx.tx.select().from(projects).where(and(eq(projects.workspaceId, ctx.actor.workspaceId), eq(projects.id, input.projectId)));
  const invalid = (message: string) => new AppError('VALIDATION_FAILED', message, { fieldErrors: [{ field: 'projectId', code: 'INVALID', message }] });
  if (!p || p.deletedAt || (!allowed(ctx, 'projects.read', projectScopeOf(p)) && !allowed(ctx, 'content.read', projectScopeOf(p)))) throw invalid('Choose a project you can access.');
  if (!allowed(ctx, 'content.create', projectScopeOf(p))) throw new AppError('FORBIDDEN', 'You cannot create content in this project.');
  if (p.status === 'archived') throw invalid('Archived projects cannot get new content.');
  const id = newId();
  const at = ctx.app.clock.now();
  const title = (input.title ?? reference.title).trim();
  const [row] = await ctx.tx
    .insert(contentItems)
    .values({
      ...stamp(ctx),
      id,
      projectId: p.id,
      title,
      format: input.format,
      stage: 'idea',
      ownerMembershipId: ctx.actor.membershipId,
      brief: {
        notes: [`Reference: ${reference.title}`, `What to reuse: ${reference.whatToReuse}`, reference.sourceUrl ? `Source: ${reference.sourceUrl}` : null].filter(Boolean).join('\n'),
      },
      language: p.language,
    })
    .returning();
  await ctx.tx.insert(contentStageEvents).values({ ...stamp(ctx), id: newId(), contentItemId: id, fromStage: null, toStage: 'idea', occurredAt: at, actorMembershipId: ctx.actor.membershipId });
  await audit(ctx, { action: 'content.created', entityType: 'content_item', entityId: id, projectId: p.id, metadata: { stage: 'idea', format: input.format, fromReferenceId: reference.id } });
  await emit(ctx, { type: 'content_item.created', entityType: 'content_item', entityId: id, revision: 1, payload: { projectId: p.id, fromReferenceId: reference.id } });
  await indexSearchDocument(ctx.tx, {
    workspaceId: ctx.actor.workspaceId,
    entityType: 'content_item',
    entityId: id,
    title,
    body: row!.brief.notes ?? '',
    projectId: p.id,
    permission: 'content.read',
    ownerMembershipId: ctx.actor.membershipId,
    assigneeMembershipIds: ctx.actor.membershipId ? [ctx.actor.membershipId] : [],
    status: 'idea',
    at,
  });
  return id;
};
