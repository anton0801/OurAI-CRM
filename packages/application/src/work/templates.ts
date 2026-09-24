import { and, asc, eq, ilike, inArray, isNull } from 'drizzle-orm';
import { projects, taskDependencies, templateApplications, templates, templateVersions, workspaces, type TemplateTaskNode } from '@castlane/database';
import type { TaskCreateBody } from '@castlane/api-contracts';
import { AppError, isoDateAddDays, newId, zonedDateTimeToUtc } from '@castlane/domain';
import { allowed, requirePermission } from '../core/access';
import { audit } from '../core/audit';
import { dbOf, type CommandContext, type QueryContext } from '../core/context';
import { emit } from '../core/events';
import { loadMemberRefs, refOrUnknown } from '../core/members';
import { stamp } from '../core/rows';
import { isAcyclic } from './rules/graph';
import { createTask } from './tasks';
import { fieldFail, memberCan } from './shared';

/** Where the created tasks are linked, by the target type of the application. */
const TARGET_LINK: Record<string, keyof TaskCreateBody | null> = {
  project: null,
  content_item: 'contentItemId',
  deal: 'dealId',
  deliverable: 'deliverableId',
  publication: 'publicationId',
  account: 'accountId',
  shift: 'shiftId',
  operation: 'operationId',
  article: 'articleId',
};

export interface ApplyTaskTemplateInput {
  templateVersionId: string;
  targetType: string;
  targetId: string;
  projectId: string;
  accountId?: string | null;
  /** Calendar date the relative offsets count from. */
  startDate: string;
  /** Unique key of this application; a repeat with the same key creates nothing new (T036). */
  applicationKey: string;
  /** Membership per template task key, responsibility or role key; `reviewer` for reviewers. */
  assignees?: Record<string, string>;
  timezone?: string;
}

interface PlannedNode {
  node: TemplateTaskNode;
  assignee: string | null;
  reviewer: string | null;
  startDate: string;
  dueDate: string;
}

const loadVersion = async (ctx: QueryContext | CommandContext, templateVersionId: string) => {
  const [v] = await dbOf(ctx)
    .select({ v: templateVersions, t: templates })
    .from(templateVersions)
    .innerJoin(templates, eq(templates.id, templateVersions.templateId))
    .where(and(eq(templateVersions.workspaceId, ctx.actor.workspaceId), eq(templateVersions.id, templateVersionId)));
  if (!v) throw fieldFail('templateVersionId', 'NOT_FOUND', 'Choose a published template.');
  if (v.v.state !== 'published' || v.t.disabledAt || v.t.archivedAt) throw new AppError('INVALID_STATE', 'Only published, enabled template versions can be applied.');
  const nodes = v.v.config.tasks ?? [];
  if (nodes.length === 0) throw new AppError('INVALID_STATE', 'This template version contains no tasks.');
  const keys = new Set(nodes.map((n) => n.key));
  if (keys.size !== nodes.length) throw new AppError('INVALID_STATE', 'The template has duplicate task keys.');
  const edges = nodes.flatMap((n) => (n.dependsOn ?? []).filter((d) => keys.has(d)).map((d) => ({ predecessorId: d, successorId: n.key })));
  if (!isAcyclic(edges) || nodes.some((n) => (n.dependsOn ?? []).includes(n.key))) throw new AppError('INVALID_STATE', 'The template’s task graph contains a cycle.');
  return v;
};

const plan = (nodes: TemplateTaskNode[], input: ApplyTaskTemplateInput, reviewerRoleKey?: string): PlannedNode[] =>
  nodes.map((n) => {
    const a = input.assignees ?? {};
    const assignee = a[n.key] ?? (n.responsibility ? a[n.responsibility] : undefined) ?? (n.defaultRoleKey ? a[n.defaultRoleKey] : undefined) ?? null;
    const reviewer = n.requiresReview ? (a[`${n.key}.reviewer`] ?? a.reviewer ?? (reviewerRoleKey ? a[reviewerRoleKey] : undefined) ?? null) : null;
    const startDate = isoDateAddDays(input.startDate, Math.max(0, n.offsetDaysFromStart ?? 0));
    const dueDate = isoDateAddDays(startDate, Math.max(0, (n.durationDays ?? 1) - 1));
    return { node: n, assignee, reviewer: reviewer && reviewer !== assignee ? reviewer : null, startDate, dueDate };
  });

const targetProject = async (ctx: QueryContext | CommandContext, projectId: string) => {
  const [p] = await dbOf(ctx).select().from(projects).where(and(eq(projects.workspaceId, ctx.actor.workspaceId), eq(projects.id, projectId)));
  if (!p) throw fieldFail('projectId', 'NOT_FOUND', 'Choose a project you can access.');
  if (!allowed(ctx, 'tasks.create', { projectId: p.id })) throw new AppError('FORBIDDEN', 'You cannot create tasks in this project.');
  if (p.status === 'archived') throw new AppError('INVALID_STATE', 'Archived projects accept no new tasks.');
  return p;
};

const zoneOf = async (ctx: QueryContext | CommandContext, tz?: string) => {
  if (tz) return tz;
  const [w] = await dbOf(ctx).select({ tz: workspaces.timezone }).from(workspaces).where(eq(workspaces.id, ctx.actor.workspaceId));
  return w?.tz ?? ctx.actor.timezone;
};

export const defaultApplicationKey = (input: Pick<ApplyTaskTemplateInput, 'targetType' | 'targetId' | 'templateVersionId' | 'startDate'>) =>
  `${input.targetType}:${input.targetId}:${input.templateVersionId}:${input.startDate}`;

/** Preview names, assignments and dates before anything is created. */
export const previewTaskTemplate = async (ctx: QueryContext, input: Omit<ApplyTaskTemplateInput, 'applicationKey'>) => {
  requirePermission(ctx, 'tasks.create');
  await targetProject(ctx, input.projectId);
  const { v, t } = await loadVersion(ctx, input.templateVersionId);
  const key = defaultApplicationKey(input);
  const planned = plan(v.config.tasks ?? [], { ...input, applicationKey: key }, v.config.reviewerRoleKey);
  const refs = await loadMemberRefs(dbOf(ctx), ctx.actor.workspaceId, planned.flatMap((p) => [p.assignee, p.reviewer]));
  const [existing] = await dbOf(ctx)
    .select()
    .from(templateApplications)
    .where(and(eq(templateApplications.workspaceId, ctx.actor.workspaceId), eq(templateApplications.applicationKey, key)));
  return {
    template: { name: t.name, versionNo: v.versionNo },
    tasks: planned.map((p) => ({
      key: p.node.key,
      title: p.node.title,
      assignee: refOrUnknown(refs, p.assignee),
      reviewer: refOrUnknown(refs, p.reviewer),
      startDate: p.startDate,
      dueDate: p.dueDate,
      estimateMinutes: p.node.estimateMinutes ?? null,
      dependsOn: p.node.dependsOn ?? [],
      checklistCount: (p.node.checklist ?? []).length,
      responsibility: p.node.responsibility ?? null,
    })),
    unassignedCount: planned.filter((p) => !p.assignee).length,
    existingApplication: existing ? { id: existing.id, appliedAt: existing.appliedAt.toISOString(), taskCount: existing.createdTaskIds.length } : null,
    applicationKey: key,
  };
};

/**
 * Create a template's task graph (tasks, checklists, Finish-to-Start dependencies) exactly once per
 * application key: the key is a unique constraint and a repeat returns the first application
 * without creating anything (T036). Unknown assignees stay Unassigned — nobody is substituted —
 * and one coordination task asks the applying member (or the project owner) to assign them.
 * Other modules (content, deals) call this inside their own commands.
 */
export const applyTaskTemplate = async (ctx: CommandContext, input: ApplyTaskTemplateInput) => {
  requirePermission(ctx, 'tasks.create');
  const p = await targetProject(ctx, input.projectId);
  const [existing] = await ctx.tx
    .select()
    .from(templateApplications)
    .where(and(eq(templateApplications.workspaceId, ctx.actor.workspaceId), eq(templateApplications.applicationKey, input.applicationKey)));
  if (existing) {
    const r = existing.result as { coordinationTaskId?: string | null };
    return { applicationId: existing.id, created: false, taskIds: existing.createdTaskIds, coordinationTaskId: r.coordinationTaskId ?? null };
  }
  if (!(input.targetType in TARGET_LINK)) throw fieldFail('targetType', 'UNSUPPORTED', 'Templates cannot be applied to this record type.');
  const { v, t } = await loadVersion(ctx, input.templateVersionId);
  const tz = await zoneOf(ctx, input.timezone);
  const planned = plan(v.config.tasks ?? [], input, v.config.reviewerRoleKey);
  // Every named assignee must be an active member who can access the project (no silent substitution).
  for (const n of planned)
    for (const m of [n.assignee, n.reviewer].filter((x): x is string => !!x)) {
      const r = await memberCan(ctx.app.db, ctx.actor.workspaceId, m, 'tasks.read', { projectId: p.id, assignedMembershipIds: [m] }, ctx.app.clock.now());
      if (!r.ok) throw fieldFail('assignees', 'NO_ACCESS', `${r.name ?? 'A chosen member'} cannot work on tasks in this project.`);
    }
  const applicationId = newId();
  const inserted = await ctx.tx
    .insert(templateApplications)
    .values({ ...stamp(ctx), id: applicationId, templateVersionId: v.id, targetType: input.targetType, targetId: input.targetId, applicationKey: input.applicationKey, appliedAt: ctx.app.clock.now() })
    .onConflictDoNothing()
    .returning({ id: templateApplications.id });
  if (inserted.length === 0) {
    const [again] = await ctx.tx.select().from(templateApplications).where(and(eq(templateApplications.workspaceId, ctx.actor.workspaceId), eq(templateApplications.applicationKey, input.applicationKey)));
    return { applicationId: again!.id, created: false, taskIds: again!.createdTaskIds, coordinationTaskId: (again!.result as { coordinationTaskId?: string }).coordinationTaskId ?? null };
  }
  const link = TARGET_LINK[input.targetType];
  const idByKey = new Map<string, string>();
  for (const n of planned) {
    const body: TaskCreateBody = {
      title: n.node.title.slice(0, 200),
      projectId: p.id,
      description: n.node.description ?? null,
      status: 'backlog',
      priority: 'normal',
      assigneeMembershipId: n.assignee,
      reviewerMembershipId: n.reviewer,
      due: { kind: 'date', date: n.dueDate, timezone: tz },
      estimateMinutes: n.node.estimateMinutes ?? null,
      checklist: (n.node.checklist ?? []).map((c) => ({ label: c.label, mandatory: !!c.mandatory })),
      ...(input.accountId ? { accountId: input.accountId } : {}),
      ...(link ? { [link]: input.targetId } : {}),
    } as TaskCreateBody;
    body.startAt = zonedDateTimeToUtc(n.startDate, '00:00', tz).utc.toISOString();
    idByKey.set(n.node.key, await createTask(ctx, body, { source: 'template', templateApplicationId: applicationId }));
  }
  for (const n of planned)
    for (const dep of n.node.dependsOn ?? []) {
      const pred = idByKey.get(dep);
      if (!pred) continue;
      await ctx.tx.insert(taskDependencies).values({ ...stamp(ctx), id: newId(), predecessorId: pred, successorId: idByKey.get(n.node.key)! });
    }
  const unassigned = planned.filter((n) => !n.assignee);
  let coordinationTaskId: string | null = null;
  if (unassigned.length) {
    coordinationTaskId = await createTask(
      ctx,
      {
        title: `Assign owners for ${unassigned.length} task${unassigned.length === 1 ? '' : 's'} from “${t.name}”`.slice(0, 200),
        projectId: p.id,
        description: unassigned.map((u) => `• ${u.node.title}`).join('\n'),
        status: 'ready',
        priority: 'normal',
        assigneeMembershipId: ctx.actor.kind === 'user' && ctx.actor.membershipId ? ctx.actor.membershipId : p.ownerMembershipId,
        due: { kind: 'date', date: input.startDate, timezone: tz },
      } as TaskCreateBody,
      { source: 'template', templateApplicationId: applicationId },
    );
  }
  const taskIds = [...idByKey.values()];
  await ctx.tx
    .update(templateApplications)
    .set({ createdTaskIds: taskIds, result: { taskCount: taskIds.length, unassigned: unassigned.length, coordinationTaskId } })
    .where(eq(templateApplications.id, applicationId));
  await audit(ctx, {
    action: 'template.applied',
    entityType: input.targetType,
    entityId: input.targetId,
    projectId: p.id,
    metadata: { templateVersionId: v.id, applicationId, applicationKey: input.applicationKey, tasks: taskIds.length },
  });
  await emit(ctx, { type: 'template.applied', entityType: 'project', entityId: p.id, payload: { applicationId, templateVersionId: v.id, targetType: input.targetType, targetId: input.targetId } });
  return { applicationId, created: true, taskIds, coordinationTaskId };
};

/** Published task/content template versions the actor may apply (read-only view of the platform's templates). */
export const listTemplateOptions = async (ctx: QueryContext, input: { q?: string }) => {
  requirePermission(ctx, 'tasks.create');
  const rows = await dbOf(ctx)
    .select({ t: templates, v: templateVersions })
    .from(templates)
    .innerJoin(templateVersions, eq(templateVersions.id, templates.publishedVersionId))
    .where(
      and(
        eq(templates.workspaceId, ctx.actor.workspaceId),
        inArray(templates.kind, ['task', 'content']),
        isNull(templates.archivedAt),
        isNull(templates.disabledAt),
        eq(templateVersions.state, 'published'),
        input.q ? ilike(templates.name, `%${input.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`) : undefined,
      ),
    )
    .orderBy(asc(templates.name))
    .limit(200);
  return rows
    .filter((r) => (r.v.config.tasks ?? []).length > 0)
    .map((r) => ({ templateId: r.t.id, templateVersionId: r.v.id, name: r.t.name, kind: r.t.kind, versionNo: r.v.versionNo, taskCount: (r.v.config.tasks ?? []).length, description: r.t.description }));
};
