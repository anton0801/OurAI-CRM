import { and, eq, inArray, sql } from 'drizzle-orm';
import { bulkPreviews, contentItems, projects } from '@castlane/database';
import { AppError, CONTENT_STAGES, isAppError, isUuid, LIMITS, newId, normalizeKey } from '@castlane/domain';
import { allowed, requirePermission } from '../core/access';
import type { CommandContext } from '../core/context';
import { stamp } from '../core/rows';
import { memberCan } from '../work/shared';
import { canMoveContent, transitionContent, updateContent } from './content';
import { isManualTransition, manualMoveExplanation, transitionRequirements, type ContentStage } from './rules';
import { canReadContent, contentScope, type ContentRow } from './scope';

export type ContentBulkAction = 'assign_owner' | 'assign_reviewer' | 'add_tag' | 'remove_tag' | 'move_stage';

const PREVIEW_TTL_MS = 10 * 60_000;

type Outcome = { outcome: 'apply' | 'skip' | 'denied' | 'conflict'; reason: string | null };

const validateValue = (action: ContentBulkAction, value: string) => {
  const bad = (message: string) => new AppError('VALIDATION_FAILED', message, { fieldErrors: [{ field: 'value', code: 'INVALID', message }] });
  if ((action === 'assign_owner' || action === 'assign_reviewer') && !isUuid(value)) throw bad('Choose a member.');
  if ((action === 'add_tag' || action === 'remove_tag') && (value.trim().length < LIMITS.tagMin || value.trim().length > LIMITS.tagMax)) throw bad(`Tags are ${LIMITS.tagMin}–${LIMITS.tagMax} characters.`);
  if (action === 'move_stage' && !(CONTENT_STAGES as readonly string[]).includes(value)) throw bad('Choose a stage.');
};

const evaluate = async (ctx: CommandContext, c: ContentRow, action: ContentBulkAction, value: string, projectStatus: Map<string, { status: string; allowSelf: boolean }>): Promise<Outcome> => {
  const scope = contentScope(c);
  if (c.archivedAt) return { outcome: 'skip', reason: 'Archived content is read-only.' };
  const edit = allowed(ctx, 'content.edit', scope);
  switch (action) {
    case 'assign_owner': {
      if (!edit) return { outcome: 'denied', reason: 'You cannot change the owner of this content.' };
      if (c.ownerMembershipId === value) return { outcome: 'skip', reason: 'Already the owner.' };
      const m = await memberCan(ctx.app.db, ctx.actor.workspaceId, value, 'content.read', { ...scope, assignedMembershipIds: [value], ownerMembershipId: value }, ctx.app.clock.now());
      return m.ok ? { outcome: 'apply', reason: null } : { outcome: 'conflict', reason: `${m.name ?? 'This member'} cannot access this content.` };
    }
    case 'assign_reviewer': {
      if (!edit) return { outcome: 'denied', reason: 'You cannot change the reviewer of this content.' };
      if (c.reviewerMembershipId === value) return { outcome: 'skip', reason: 'Already the reviewer.' };
      if (c.ownerMembershipId === value && !projectStatus.get(c.projectId)?.allowSelf) return { outcome: 'conflict', reason: 'The owner cannot review their own content.' };
      const m = await memberCan(ctx.app.db, ctx.actor.workspaceId, value, 'content.approve', { ...scope, assignedMembershipIds: [value] }, ctx.app.clock.now());
      return m.ok ? { outcome: 'apply', reason: null } : { outcome: 'conflict', reason: `${m.name ?? 'This member'} cannot approve content in this project.` };
    }
    case 'add_tag':
    case 'remove_tag': {
      if (!edit) return { outcome: 'denied', reason: 'You cannot edit this content.' };
      const has = c.tags.some((t) => normalizeKey(t) === normalizeKey(value));
      if (action === 'add_tag' && has) return { outcome: 'skip', reason: 'Already tagged.' };
      if (action === 'remove_tag' && !has) return { outcome: 'skip', reason: 'Not tagged.' };
      if (action === 'add_tag' && c.tags.length >= LIMITS.tagsPerObject) return { outcome: 'conflict', reason: `Content can have at most ${LIMITS.tagsPerObject} tags.` };
      return { outcome: 'apply', reason: null };
    }
    case 'move_stage': {
      const to = value as ContentStage;
      if (c.stage === to) return { outcome: 'skip', reason: 'Already in this stage.' };
      if (!isManualTransition(c.stage, to)) return { outcome: 'conflict', reason: manualMoveExplanation(c.stage, to) };
      if (!canMoveContent(ctx, c, to)) return { outcome: 'denied', reason: 'You cannot move this content.' };
      if (c.stage === 'approved') return { outcome: 'conflict', reason: 'A New Revision needs a reason; start it from the content page.' };
      const missing = transitionRequirements(to, {
        stage: c.stage,
        projectStatus: projectStatus.get(c.projectId)?.status ?? 'active',
        ownerMembershipId: c.ownerMembershipId,
        reviewerMembershipId: c.reviewerMembershipId,
        brief: c.brief,
        dueAt: c.dueAt,
        noDeadline: c.noDeadline,
        blocked: !!c.blockedAt,
        paused: !!c.pausedAt,
        blockedTasks: 0,
      });
      return missing.length ? { outcome: 'conflict', reason: missing.map((m) => m.message).join(' ') } : { outcome: 'apply', reason: null };
    }
  }
};

/**
 * Bulk Assign / Tag / Move with Preview (S22, §24.3): per-item outcome stored as a 10-minute token
 * with target versions and the actor's access revision. Nothing is changed.
 */
export const bulkContentPreview = async (ctx: CommandContext, input: { action: ContentBulkAction; ids: string[]; value: string }) => {
  requirePermission(ctx, 'content.read');
  validateValue(input.action, input.value);
  const ids = [...new Set(input.ids)];
  const found = await ctx.tx.select().from(contentItems).where(and(eq(contentItems.workspaceId, ctx.actor.workspaceId), inArray(contentItems.id, ids)));
  const readable: ContentRow[] = [];
  for (const c of found) if (!c.deletedAt && (await canReadContent(ctx, c))) readable.push(c);
  const pRows = readable.length ? await ctx.tx.select({ id: projects.id, status: projects.status, policy: projects.reviewPolicy }).from(projects).where(inArray(projects.id, [...new Set(readable.map((c) => c.projectId))])) : [];
  const pmap = new Map(pRows.map((p) => [p.id, { status: p.status, allowSelf: !!p.policy?.allowSelfReview }]));
  const items: { id: string; title: string; outcome: Outcome['outcome']; reason: string | null; rowVersion: number }[] = [];
  for (const c of readable) items.push({ id: c.id, title: c.title, rowVersion: c.rowVersion, ...(await evaluate(ctx, c, input.action, input.value, pmap)) });
  const expiresAt = new Date(ctx.app.clock.now().getTime() + PREVIEW_TTL_MS);
  const token = newId();
  await ctx.tx.insert(bulkPreviews).values({
    ...stamp(ctx),
    id: token,
    actorMembershipId: ctx.actor.membershipId!,
    action: `content.bulk.${input.action}`,
    params: { value: input.value },
    targets: items.map((i) => ({ type: 'content_item', id: i.id, rowVersion: i.rowVersion, status: i.outcome === 'apply' ? ('ok' as const) : i.outcome === 'denied' ? ('forbidden' as const) : ('conflict' as const) })),
    accessRevision: ctx.actor.access.accessRevision,
    summary: { apply: items.filter((i) => i.outcome === 'apply').length, total: items.length },
    expiresAt,
  });
  return {
    token,
    expiresAt: expiresAt.toISOString(),
    items: items.map(({ rowVersion: _rv, ...i }) => i),
    applyCount: items.filter((i) => i.outcome === 'apply').length,
    missingCount: ids.length - readable.length,
  };
};

/** Apply a previewed bulk action per item; items changed since the preview are reported, not changed. */
export const bulkContentApply = async (ctx: CommandContext, input: { token: string }) => {
  const [p] = await ctx.tx.select().from(bulkPreviews).where(and(eq(bulkPreviews.workspaceId, ctx.actor.workspaceId), eq(bulkPreviews.id, input.token))).for('update');
  if (!p || !p.action.startsWith('content.bulk.') || p.actorMembershipId !== ctx.actor.membershipId || p.consumedAt || p.expiresAt <= ctx.app.clock.now())
    throw new AppError('INVALID_STATE', 'The preview expired or was already used. Preview again.');
  if (p.accessRevision !== ctx.actor.access.accessRevision) throw new AppError('INVALID_STATE', 'Your access changed after the preview. Preview again.');
  await ctx.tx.update(bulkPreviews).set({ consumedAt: ctx.app.clock.now() }).where(eq(bulkPreviews.id, p.id));
  const action = p.action.slice('content.bulk.'.length) as ContentBulkAction;
  const value = String((p.params as { value?: string }).value ?? '');
  const done: string[] = [];
  const failed: { id: string; message: string }[] = [];
  const warnings: string[] = [];
  for (const t of p.targets) {
    if (t.status !== 'ok') continue;
    await ctx.tx.execute(sql`SAVEPOINT content_bulk_item`);
    try {
      const [c] = await ctx.tx.select().from(contentItems).where(eq(contentItems.id, t.id));
      if (!c || c.rowVersion !== t.rowVersion) throw new AppError('INVALID_STATE', 'The content changed after the preview. Preview again.');
      const itemCtx: CommandContext = { ...ctx, request: { ...ctx.request, expectedVersion: c.rowVersion } };
      if (action === 'assign_owner') await updateContent(itemCtx, c.id, { ownerMembershipId: value });
      else if (action === 'assign_reviewer') await updateContent(itemCtx, c.id, { reviewerMembershipId: value });
      else if (action === 'add_tag') await updateContent(itemCtx, c.id, { tags: [...c.tags, value.trim()] });
      else if (action === 'remove_tag') await updateContent(itemCtx, c.id, { tags: c.tags.filter((x) => normalizeKey(x) !== normalizeKey(value)) });
      else {
        const r = await transitionContent(itemCtx, c.id, { targetStage: value as ContentStage });
        warnings.push(...r.warnings);
      }
      await ctx.tx.execute(sql`RELEASE SAVEPOINT content_bulk_item`);
      done.push(t.id);
    } catch (e) {
      await ctx.tx.execute(sql`ROLLBACK TO SAVEPOINT content_bulk_item`);
      if (!isAppError(e)) throw e;
      failed.push({ id: t.id, message: e.fieldErrors[0]?.message ?? e.message });
    }
  }
  return { done, failed, warnings: [...new Set(warnings)] };
};
