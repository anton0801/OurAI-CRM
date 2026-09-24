import { and, asc, count, desc, eq, ilike, inArray, isNull, max, sql } from 'drizzle-orm';
import type { TemplateConfigInput } from '@castlane/api-contracts';
import { hasAnywhere } from '@castlane/authorization';
import { templateApplications, templates, templateVersions, type TemplateConfig } from '@castlane/database';
import { AppError, isValidTimeZone, newId, notFound } from '@castlane/domain';
import { requireAnyPermission, requirePermission } from '../../core/access';
import { audit, diffFields } from '../../core/audit';
import type { CommandContext, QueryContext } from '../../core/context';
import { dbOf } from '../../core/context';
import { emit } from '../../core/events';
import { defineLookup, likePattern } from '../../core/lookup-registry';
import { isActiveMember, loadMemberRefs } from '../../core/members';
import { assertVersion, lockById, stamp, touch } from '../../core/rows';
import { planTemplate, validateTemplateConfig, type TemplateKind } from './plan';

type TemplateRow = typeof templates.$inferSelect;
type VersionRow = typeof templateVersions.$inferSelect;

/** Templates are readable by those who manage them or can create the work they generate. */
const READ_PERMISSIONS = ['templates.manage', 'tasks.create', 'content.create', 'quality.write'];
const canManage = (ctx: QueryContext) => hasAnywhere(ctx.actor.access, 'templates.manage');

const statusOf = (t: TemplateRow) => (t.disabledAt ? 'disabled' : t.publishedVersionId ? 'published' : 'draft') as 'draft' | 'published' | 'disabled';

const summaries = async (ctx: QueryContext, rows: TemplateRow[]) => {
  const ids = [...new Set(rows.flatMap((r) => [r.publishedVersionId, r.draftVersionId]).filter((x): x is string => !!x))];
  const versions = ids.length ? await dbOf(ctx).select().from(templateVersions).where(inArray(templateVersions.id, ids)) : [];
  const byId = new Map(versions.map((v) => [v.id, v]));
  return rows.map((t) => {
    const pub = t.publishedVersionId ? byId.get(t.publishedVersionId) : undefined;
    const draft = t.draftVersionId ? byId.get(t.draftVersionId) : undefined;
    return {
      id: t.id,
      kind: t.kind,
      name: t.name,
      description: t.description,
      status: statusOf(t),
      publishedVersion: pub ? { id: pub.id, versionNo: pub.versionNo, publishedAt: pub.publishedAt?.toISOString() ?? null } : null,
      draftVersion: draft ? { id: draft.id, versionNo: draft.versionNo } : null,
      disabledAt: t.disabledAt?.toISOString() ?? null,
      updatedAt: t.updatedAt.toISOString(),
      rowVersion: t.rowVersion,
    };
  });
};

export const listTemplates = async (ctx: QueryContext, input: { kind?: TemplateRow['kind']; includeDisabled?: boolean; q?: string }) => {
  requireAnyPermission(ctx, READ_PERMISSIONS);
  const rows = await ctx.app.db
    .select()
    .from(templates)
    .where(
      and(
        eq(templates.workspaceId, ctx.actor.workspaceId),
        isNull(templates.archivedAt),
        input.kind ? eq(templates.kind, input.kind) : undefined,
        input.includeDisabled || canManage(ctx) ? undefined : isNull(templates.disabledAt),
        // Members who only apply templates see usable (published) ones; managers see drafts too.
        canManage(ctx) ? undefined : sql`${templates.publishedVersionId} IS NOT NULL`,
        input.q ? ilike(templates.name, likePattern(input.q)) : undefined,
      ),
    )
    .orderBy(asc(templates.name), asc(templates.id));
  return summaries(ctx, rows);
};

const loadTemplate = async (ctx: QueryContext | CommandContext, id: string) => {
  const [t] = await dbOf(ctx).select().from(templates).where(and(eq(templates.workspaceId, ctx.actor.workspaceId), eq(templates.id, id), isNull(templates.archivedAt)));
  if (!t || (!canManage(ctx) && !t.publishedVersionId)) throw notFound('Template');
  return t;
};

export const getTemplate = async (ctx: QueryContext | CommandContext, id: string) => {
  requireAnyPermission(ctx, READ_PERMISSIONS);
  const t = await loadTemplate(ctx, id);
  const db = dbOf(ctx);
  const versions = await db.select().from(templateVersions).where(eq(templateVersions.templateId, t.id)).orderBy(desc(templateVersions.versionNo));
  const apps = versions.length
    ? await db.select({ v: templateApplications.templateVersionId, n: count() }).from(templateApplications).where(inArray(templateApplications.templateVersionId, versions.map((v) => v.id))).groupBy(templateApplications.templateVersionId)
    : [];
  const appsBy = new Map(apps.map((a) => [a.v, Number(a.n)]));
  const [summary] = await summaries(ctx, [t]);
  const manage = canManage(ctx);
  const draft = t.draftVersionId ? versions.find((v) => v.id === t.draftVersionId) : undefined;
  const pub = t.publishedVersionId ? versions.find((v) => v.id === t.publishedVersionId) : undefined;
  return {
    ...summary!,
    versions: (manage ? versions : versions.filter((v) => v.state !== 'draft')).map((v) => ({
      id: v.id,
      versionNo: v.versionNo,
      state: v.state,
      publishedAt: v.publishedAt?.toISOString() ?? null,
      createdAt: v.createdAt.toISOString(),
      createdBy: null,
      applications: appsBy.get(v.id) ?? 0,
      rowVersion: v.rowVersion,
    })),
    draft: manage && draft ? { id: draft.id, versionNo: draft.versionNo, config: draft.config as TemplateConfigInput, rowVersion: draft.rowVersion } : null,
    published: pub ? { id: pub.id, versionNo: pub.versionNo, config: pub.config as TemplateConfigInput } : null,
    permissions: { manage },
  };
};

const defaultConfig = (kind: TemplateKind): TemplateConfig =>
  kind === 'task' ? { tasks: [] } : kind === 'content' ? { tasks: [], checklist: [], deliverableSlots: [] } : kind === 'checklist' ? { checklist: [] } : { rubric: [] };

export const createTemplate = async (ctx: CommandContext, input: { kind: TemplateKind; name: string; description?: string | null; config?: TemplateConfig }) => {
  requirePermission(ctx, 'templates.manage');
  const id = newId();
  const versionId = newId();
  await ctx.tx.insert(templates).values({ ...stamp(ctx), id, kind: input.kind, name: input.name.trim(), description: input.description?.trim() || null });
  await ctx.tx.insert(templateVersions).values({ ...stamp(ctx), id: versionId, templateId: id, versionNo: 1, state: 'draft', config: input.config ?? defaultConfig(input.kind) });
  await ctx.tx.update(templates).set({ draftVersionId: versionId }).where(eq(templates.id, id));
  await audit(ctx, { action: 'template.created', entityType: 'template', entityId: id, metadata: { kind: input.kind, name: input.name } });
  await emit(ctx, { type: 'template.created', entityType: 'template', entityId: id, revision: 1 });
  return id;
};

const lockManaged = async (ctx: CommandContext, id: string) => {
  requirePermission(ctx, 'templates.manage');
  const t = await lockById(ctx, templates, id, 'Template');
  if (t.archivedAt) throw notFound('Template');
  return t;
};

export const updateTemplate = async (ctx: CommandContext, id: string, input: { name?: string; description?: string | null }) => {
  const t = await lockManaged(ctx, id);
  assertVersion(ctx, t);
  const patch: Partial<TemplateRow> = {};
  if (input.name !== undefined) patch.name = input.name.trim();
  if (input.description !== undefined) patch.description = input.description?.trim() || null;
  const [row] = await ctx.tx.update(templates).set({ ...patch, ...touch(ctx, templates) }).where(eq(templates.id, id)).returning();
  await audit(ctx, { action: 'template.updated', entityType: 'template', entityId: id, diff: diffFields(t, row!, ['name', 'description']) });
  await emit(ctx, { type: 'template.updated', entityType: 'template', entityId: id, revision: row!.rowVersion });
  return id;
};

/** Only draft versions are editable; published versions are immutable (DB trigger as well). */
export const saveTemplateDraft = async (ctx: CommandContext, id: string, versionId: string, config: TemplateConfig) => {
  const t = await lockManaged(ctx, id);
  const v = await lockById(ctx, templateVersions, versionId, 'Template version');
  if (v.templateId !== t.id) throw notFound('Template version');
  if (v.state !== 'draft') throw new AppError('INVALID_STATE', 'Published versions cannot change. Create a new version.');
  assertVersion(ctx, v);
  const [row] = await ctx.tx.update(templateVersions).set({ config, ...touch(ctx, templateVersions) }).where(eq(templateVersions.id, v.id)).returning();
  await ctx.tx.update(templates).set({ updatedAt: ctx.app.clock.now(), updatedBy: ctx.actor.userId }).where(eq(templates.id, t.id));
  await audit(ctx, { action: 'template.draft_saved', entityType: 'template', entityId: t.id, metadata: { versionNo: v.versionNo, tasks: config.tasks?.length ?? 0, checklist: config.checklist?.length ?? 0, rubric: config.rubric?.length ?? 0 } });
  await emit(ctx, { type: 'template.updated', entityType: 'template', entityId: t.id, revision: row!.rowVersion });
  return id;
};

export const newTemplateVersion = async (ctx: CommandContext, id: string, fromVersionId?: string) => {
  const t = await lockManaged(ctx, id);
  if (t.draftVersionId) throw new AppError('INVALID_STATE', 'A draft version already exists. Edit or publish it first.');
  const sourceId = fromVersionId ?? t.publishedVersionId;
  let config: TemplateConfig = defaultConfig(t.kind);
  if (sourceId) {
    const [src] = await ctx.tx.select().from(templateVersions).where(and(eq(templateVersions.id, sourceId), eq(templateVersions.templateId, t.id)));
    if (!src) throw notFound('Template version');
    config = src.config;
  }
  const [{ n } = { n: 0 }] = await ctx.tx.select({ n: max(templateVersions.versionNo) }).from(templateVersions).where(eq(templateVersions.templateId, t.id));
  const versionId = newId();
  const versionNo = Number(n ?? 0) + 1;
  await ctx.tx.insert(templateVersions).values({ ...stamp(ctx), id: versionId, templateId: t.id, versionNo, state: 'draft', config });
  const [row] = await ctx.tx.update(templates).set({ draftVersionId: versionId, ...touch(ctx, templates) }).where(eq(templates.id, t.id)).returning();
  await audit(ctx, { action: 'template.version_created', entityType: 'template', entityId: t.id, metadata: { versionNo, fromVersionId: sourceId ?? null } });
  await emit(ctx, { type: 'template.updated', entityType: 'template', entityId: t.id, revision: row!.rowVersion });
  return id;
};

/** Publish: validated, immutable, the only version new applications use; the previous one is withdrawn. */
export const publishTemplate = async (ctx: CommandContext, id: string, draftVersionId: string) => {
  const t = await lockManaged(ctx, id);
  assertVersion(ctx, t);
  if (t.draftVersionId !== draftVersionId) throw new AppError('INVALID_STATE', 'This version is not the current draft.');
  const v = await lockById(ctx, templateVersions, draftVersionId, 'Template version');
  const issues = validateTemplateConfig(t.kind, v.config);
  if (issues.length) throw new AppError('VALIDATION_FAILED', issues[0]!.message, { fieldErrors: issues });
  const at = ctx.app.clock.now();
  if (t.publishedVersionId) await ctx.tx.update(templateVersions).set({ state: 'disabled', ...touch(ctx, templateVersions) }).where(eq(templateVersions.id, t.publishedVersionId));
  await ctx.tx.update(templateVersions).set({ state: 'published', publishedAt: at, ...touch(ctx, templateVersions) }).where(eq(templateVersions.id, v.id));
  const [row] = await ctx.tx.update(templates).set({ publishedVersionId: v.id, draftVersionId: null, ...touch(ctx, templates) }).where(eq(templates.id, t.id)).returning();
  await audit(ctx, { action: 'template.published', entityType: 'template', entityId: t.id, metadata: { versionNo: v.versionNo, previousVersionId: t.publishedVersionId } });
  await emit(ctx, { type: 'template.published', entityType: 'template', entityId: t.id, revision: row!.rowVersion, payload: { versionId: v.id } });
  return id;
};

export const setTemplateDisabled = async (ctx: CommandContext, id: string, disabled: boolean, reason?: string) => {
  const t = await lockManaged(ctx, id);
  assertVersion(ctx, t);
  if (!!t.disabledAt === disabled) throw new AppError('INVALID_STATE', disabled ? 'The template is already disabled.' : 'The template is not disabled.');
  const [row] = await ctx.tx.update(templates).set({ disabledAt: disabled ? ctx.app.clock.now() : null, ...touch(ctx, templates) }).where(eq(templates.id, id)).returning();
  await audit(ctx, { action: disabled ? 'template.disabled' : 'template.enabled', entityType: 'template', entityId: id, reason: reason ?? null });
  await emit(ctx, { type: disabled ? 'template.disabled' : 'template.enabled', entityType: 'template', entityId: id, revision: row!.rowVersion });
  return id;
};

/** Preview Application: the dated task graph with proposed assignees. Zero mutations. */
export const previewTemplateApplication = async (ctx: QueryContext, id: string, input: { versionId?: string; startDate: string; assignees?: Record<string, string> }) => {
  requireAnyPermission(ctx, READ_PERMISSIONS);
  const t = await loadTemplate(ctx, id);
  const versionId = input.versionId ?? t.publishedVersionId ?? (canManage(ctx) ? t.draftVersionId : null);
  if (!versionId) throw new AppError('INVALID_STATE', 'The template has no version to preview.');
  const [v] = await dbOf(ctx).select().from(templateVersions).where(and(eq(templateVersions.id, versionId), eq(templateVersions.templateId, t.id)));
  if (!v || (v.state === 'draft' && !canManage(ctx))) throw notFound('Template version');
  const issues = validateTemplateConfig(t.kind, v.config);
  if (issues.some((i) => i.code === 'CYCLE' || i.code === 'UNKNOWN' || i.code === 'SELF')) throw new AppError('VALIDATION_FAILED', issues[0]!.message, { fieldErrors: issues });
  const plan = planTemplate(v.config, input.startDate);
  const memberIds = Object.values(input.assignees ?? {});
  for (const m of memberIds) if (!(await isActiveMember(dbOf(ctx), ctx.actor.workspaceId, m))) throw new AppError('VALIDATION_FAILED', 'Choose active members as assignees.');
  const refs = await loadMemberRefs(dbOf(ctx), ctx.actor.workspaceId, memberIds);
  const warnings = [...plan.warnings, ...issues.filter((i) => !['CYCLE', 'UNKNOWN', 'SELF'].includes(i.code)).map((i) => i.message)];
  for (const task of plan.tasks) if (task.roleKey && !input.assignees?.[task.roleKey]) warnings.push(`No member chosen for the role “${task.roleKey}” (${task.title}).`);
  return {
    versionId: v.id,
    versionNo: v.versionNo,
    startDate: input.startDate,
    endDate: plan.endDate,
    totalEstimateMinutes: plan.totalEstimateMinutes,
    tasks: plan.tasks.map((task) => ({ ...task, assignee: task.roleKey && input.assignees?.[task.roleKey] ? (refs.get(input.assignees[task.roleKey]!) ?? null) : null })),
    checklist: v.config.checklist ?? [],
    rubric: v.config.rubric ?? [],
    warnings: [...new Set(warnings)],
  };
};

// ——— Helpers for modules that apply templates (tasks, content, deals, automations) ———

/** Load a published, enabled template version for application; drafts and withdrawn versions are refused. */
export const loadTemplateVersionForApplication = async (ctx: QueryContext | CommandContext, templateVersionId: string) => {
  const [v] = await dbOf(ctx).select().from(templateVersions).where(and(eq(templateVersions.workspaceId, ctx.actor.workspaceId), eq(templateVersions.id, templateVersionId)));
  if (!v) throw notFound('Template version');
  const [t] = await dbOf(ctx).select().from(templates).where(eq(templates.id, v.templateId));
  if (!t || t.archivedAt) throw notFound('Template');
  if (v.state !== 'published' || t.publishedVersionId !== v.id) throw new AppError('INVALID_STATE', 'Only the current published version of a template can be applied.');
  if (t.disabledAt) throw new AppError('INVALID_STATE', 'This template is disabled.');
  return { template: t, version: v as VersionRow, config: v.config };
};

/**
 * Record an application exactly once per application key (e.g. `content:${id}:template:${versionId}`).
 * Returns `{ created: false, existing }` when the key was already applied, so callers never clone tasks twice.
 */
export const recordTemplateApplication = async (
  ctx: CommandContext,
  input: { templateVersionId: string; targetType: string; targetId: string; applicationKey: string; createdTaskIds: string[]; result?: Record<string, unknown> },
) => {
  const id = newId();
  const rows = await ctx.tx
    .insert(templateApplications)
    .values({ ...stamp(ctx), id, templateVersionId: input.templateVersionId, targetType: input.targetType, targetId: input.targetId, applicationKey: input.applicationKey, createdTaskIds: input.createdTaskIds, result: input.result ?? {}, appliedAt: ctx.app.clock.now() })
    .onConflictDoNothing()
    .returning();
  if (rows[0]) return { created: true as const, application: rows[0] };
  const [existing] = await ctx.tx.select().from(templateApplications).where(and(eq(templateApplications.workspaceId, ctx.actor.workspaceId), eq(templateApplications.applicationKey, input.applicationKey)));
  return { created: false as const, application: existing! };
};

/** Template picker: current published, enabled templates only. */
defineLookup({
  type: 'template',
  async search(ctx, input) {
    requireAnyPermission(ctx, READ_PERMISSIONS);
    const rows = await dbOf(ctx)
      .select({ id: templates.id, name: templates.name, kind: templates.kind, disabledAt: templates.disabledAt, versionNo: templateVersions.versionNo })
      .from(templates)
      .innerJoin(templateVersions, eq(templateVersions.id, templates.publishedVersionId))
      .where(
        and(
          eq(templates.workspaceId, ctx.actor.workspaceId),
          isNull(templates.archivedAt),
          input.ids?.length ? inArray(templates.id, input.ids) : isNull(templates.disabledAt),
          input.status?.length ? inArray(templates.kind, input.status as TemplateRow['kind'][]) : undefined,
          input.q ? ilike(templates.name, likePattern(input.q)) : undefined,
        ),
      )
      .orderBy(asc(templates.name))
      .limit(input.limit);
    return rows.map((r) => ({ id: r.id, label: r.name, sublabel: `${r.kind.replace('_', ' ')} · v${r.versionNo}`, status: r.kind, projectId: null, archived: !!r.disabledAt }));
  },
});

void isValidTimeZone;
