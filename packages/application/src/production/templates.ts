import { and, asc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { contentItems, tasks, templateApplications, templates, templateVersions } from '@castlane/database';
import { AppError } from '@castlane/domain';
import { allowed, requirePermission } from '../core/access';
import { audit } from '../core/audit';
import { dbOf, type CommandContext, type QueryContext } from '../core/context';
import { hmac, stableStringify } from '../core/crypto';
import { emit } from '../core/events';
import { assertVersion, touch } from '../core/rows';
import { loadTemplateVersionForApplication, recordTemplateApplication } from '../platform/templates/templates';
import { applyTaskTemplate, previewTaskTemplate } from '../work/templates';
import { transitionTask } from '../work/task-transitions';
import { indexContent } from './content';
import { checklistFor, deliverableSlotsFor } from './rules';
import { assertContentWritable, authorizeContentAction, lockContent, readableContent, type ContentRow } from './scope';

const NOT_STARTED = ['draft', 'backlog', 'ready'] as const;
const STARTED = ['in_progress', 'in_review', 'done'] as const;

/** One set of tasks per content item and template version (T036), whatever the start date. */
export const contentApplicationKey = (contentId: string, templateVersionId: string) => `content:${contentId}:template:${templateVersionId}`;

const loadUsableTemplate = async (ctx: QueryContext | CommandContext, templateVersionId: string) => {
  const t = await loadTemplateVersionForApplication(ctx, templateVersionId).catch((e) => {
    if ((e as { code?: string }).code === 'NOT_FOUND') throw new AppError('VALIDATION_FAILED', 'Choose a published template.', { fieldErrors: [{ field: 'templateVersionId', code: 'NOT_FOUND', message: 'Choose a published template.' }] });
    throw e;
  });
  if (t.template.kind !== 'content' && t.template.kind !== 'task')
    throw new AppError('VALIDATION_FAILED', 'Choose a content or task template.', { fieldErrors: [{ field: 'templateVersionId', code: 'WRONG_KIND', message: 'Choose a content or task template.' }] });
  return t;
};

/** Tasks created by earlier template applications on this content (the diff baseline). */
const templateTasksOf = async (ctx: QueryContext | CommandContext, contentId: string) =>
  dbOf(ctx)
    .select({ id: tasks.id, title: tasks.title, status: tasks.status, rowVersion: tasks.rowVersion, templateName: templates.name })
    .from(tasks)
    .innerJoin(templateApplications, eq(templateApplications.id, tasks.templateApplicationId))
    .innerJoin(templateVersions, eq(templateVersions.id, templateApplications.templateVersionId))
    .innerJoin(templates, eq(templates.id, templateVersions.templateId))
    .where(and(eq(tasks.workspaceId, ctx.actor.workspaceId), eq(tasks.contentItemId, contentId), isNotNull(tasks.templateApplicationId), isNull(tasks.deletedAt)))
    .orderBy(asc(tasks.createdAt));

/** The preview token binds the choice to the exact task state it was made on (Needs Revalidation otherwise). */
const previewTokenFor = (ctx: QueryContext | CommandContext, c: ContentRow, input: { templateVersionId: string; startDate: string; assignees?: Record<string, string> }, existing: { id: string; status: string; rowVersion: number }[]) =>
  hmac(
    ctx.app.config.SESSION_SECRET,
    stableStringify({ c: c.id, v: input.templateVersionId, d: input.startDate, a: input.assignees ?? {}, t: existing.map((t) => [t.id, t.status, t.rowVersion]).sort() }),
  ).slice(0, 48);

const authorizeTemplate = async (ctx: QueryContext | CommandContext, c: ContentRow) => {
  requirePermission(ctx, 'tasks.create');
  await authorizeContentAction(ctx, c, 'content.edit');
  if (!allowed(ctx, 'tasks.create', { projectId: c.projectId })) throw new AppError('FORBIDDEN', 'You cannot create tasks in this project.');
};

/**
 * Preview Generated Tasks (S23): the dated task graph with assignees and the diff against tasks of
 * earlier applications — started/completed tasks are always kept, not-started ones may be cancelled
 * (T037). Nothing is created.
 */
export const previewContentTemplate = async (ctx: QueryContext, contentId: string, input: { templateVersionId: string; startDate: string; assignees?: Record<string, string> }) => {
  const c = await readableContent(ctx, contentId);
  await authorizeTemplate(ctx, c);
  const t = await loadUsableTemplate(ctx, input.templateVersionId);
  const key = contentApplicationKey(c.id, input.templateVersionId);
  const [applied] = await dbOf(ctx).select({ id: templateApplications.id }).from(templateApplications).where(and(eq(templateApplications.workspaceId, ctx.actor.workspaceId), eq(templateApplications.applicationKey, key)));
  const plan = (t.config.tasks ?? []).length
    ? await previewTaskTemplate(ctx, { templateVersionId: input.templateVersionId, targetType: 'content_item', targetId: c.id, projectId: c.projectId, accountId: c.accountId, startDate: input.startDate, assignees: input.assignees })
    : null;
  const existing = await templateTasksOf(ctx, c.id);
  return {
    template: { templateId: t.template.id, name: t.template.name, versionNo: t.version.versionNo, templateVersionId: t.version.id },
    alreadyApplied: !!applied,
    add: applied || !plan ? [] : plan.tasks.map((x) => ({ key: x.key, title: x.title, assignee: x.assignee, reviewer: x.reviewer, startDate: x.startDate, dueDate: x.dueDate, dependsOn: x.dependsOn })),
    keep: existing.filter((x) => (STARTED as readonly string[]).includes(x.status)).map((x) => ({ taskId: x.id, title: x.title, status: x.status, templateName: x.templateName })),
    cancelable: existing.filter((x) => (NOT_STARTED as readonly string[]).includes(x.status)).map((x) => ({ taskId: x.id, title: x.title, status: x.status, templateName: x.templateName })),
    unassignedCount: applied || !plan ? 0 : plan.unassignedCount,
    deliverableSlots: deliverableSlotsFor(c.format, t.config.deliverableSlots),
    checklist: checklistFor(c.format, t.config.checklist).map((i) => ({ label: i.label, mandatory: i.mandatory })),
    previewToken: previewTokenFor(ctx, c, input, existing),
  };
};

/**
 * Apply a content template: its task graph is created exactly once per content + template version
 * (application key, T036). Applying a new template to started content keeps every started or
 * completed task and cancels only the not-started tasks the member chose in the preview (T037).
 * The template's deliverable slots and checklist apply to versions created from now on.
 */
export const applyContentTemplate = async (
  ctx: CommandContext,
  contentId: string,
  input: { templateVersionId: string; previewToken?: string; startDate: string; assignees?: Record<string, string>; cancelTaskIds?: string[] },
  opts: { skipVersion?: boolean; skipToken?: boolean } = {},
) => {
  const c = await lockContent(ctx, contentId);
  await authorizeTemplate(ctx, c);
  if (!opts.skipVersion) assertVersion(ctx, c);
  assertContentWritable(c);
  const t = await loadUsableTemplate(ctx, input.templateVersionId);
  const key = contentApplicationKey(c.id, input.templateVersionId);
  const existing = await templateTasksOf(ctx, c.id);
  const [applied] = await ctx.tx.select().from(templateApplications).where(and(eq(templateApplications.workspaceId, ctx.actor.workspaceId), eq(templateApplications.applicationKey, key)));
  if (applied) {
    // Repeat application: nothing new is created (T036).
    return { applicationId: applied.id, created: false, taskIds: applied.createdTaskIds, cancelledTaskIds: [] as string[], coordinationTaskId: ((applied.result as { coordinationTaskId?: string | null }).coordinationTaskId ?? null) as string | null };
  }
  if (!opts.skipToken && input.previewToken !== previewTokenFor(ctx, c, input, existing))
    throw new AppError('INVALID_STATE', 'Tasks changed after the preview. Preview the template again before applying it.', { details: { reason: 'PREVIEW_STALE' } });
  const cancelable = new Set(existing.filter((x) => (NOT_STARTED as readonly string[]).includes(x.status)).map((x) => x.id));
  const cancelIds = [...new Set(input.cancelTaskIds ?? [])];
  for (const id of cancelIds)
    if (!cancelable.has(id))
      throw new AppError('VALIDATION_FAILED', 'Only not-started tasks of earlier templates can be cancelled. Started and completed tasks are kept.', {
        fieldErrors: [{ field: 'cancelTaskIds', code: 'NOT_CANCELABLE', message: 'Only not-started tasks of earlier templates can be cancelled.' }],
      });
  for (const id of cancelIds)
    await transitionTask(ctx, id, { targetState: 'cancelled', reason: `Replaced by the template “${t.template.name}” v${t.version.versionNo}.` }, { skipVersion: true });
  let result = { applicationId: '', created: false, taskIds: [] as string[], coordinationTaskId: null as string | null };
  if ((t.config.tasks ?? []).length)
    result = await applyTaskTemplate(ctx, {
      templateVersionId: input.templateVersionId,
      targetType: 'content_item',
      targetId: c.id,
      projectId: c.projectId,
      accountId: c.accountId,
      startDate: input.startDate,
      applicationKey: key,
      assignees: input.assignees,
    });
  else {
    const r = await recordTemplateApplication(ctx, { templateVersionId: input.templateVersionId, targetType: 'content_item', targetId: c.id, applicationKey: key, createdTaskIds: [] });
    result = { applicationId: r.application.id, created: r.created, taskIds: [], coordinationTaskId: null };
  }
  const [row] = await ctx.tx.update(contentItems).set({ templateVersionId: input.templateVersionId, ...touch(ctx, contentItems) }).where(eq(contentItems.id, c.id)).returning();
  await audit(ctx, {
    action: 'content.template_applied',
    entityType: 'content_item',
    entityId: c.id,
    projectId: c.projectId,
    metadata: { templateVersionId: input.templateVersionId, template: t.template.name, versionNo: t.version.versionNo, created: result.taskIds.length, cancelled: cancelIds.length, previousTemplateVersionId: c.templateVersionId },
  });
  await emit(ctx, { type: 'content_item.updated', entityType: 'content_item', entityId: c.id, revision: row!.rowVersion, payload: { templateApplied: input.templateVersionId } });
  await indexContent(ctx, row!);
  return { ...result, cancelledTaskIds: cancelIds };
};

/** Tasks linked to a content item that are still open (for archive previews). */
export const openContentTaskIds = async (ctx: QueryContext | CommandContext, contentId: string) =>
  (
    await dbOf(ctx)
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.workspaceId, ctx.actor.workspaceId), eq(tasks.contentItemId, contentId), inArray(tasks.status, ['draft', 'backlog', 'ready', 'in_progress', 'in_review']), isNull(tasks.deletedAt)))
  ).map((r) => r.id);
