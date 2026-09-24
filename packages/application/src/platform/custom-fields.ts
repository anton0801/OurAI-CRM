import { and, asc, count, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { can, hasAnywhere, type ObjectScope } from '@castlane/authorization';
import { contentItems, customFieldDefinitions, customFieldValues, projects, socialAccounts, tasks, type CustomFieldOption } from '@castlane/database';
import { ACCOUNT_STATUSES, AppError, CONTENT_STAGES, PROJECT_STATUSES, TASK_STATUSES, newId, notFound, versionConflict } from '@castlane/domain';
import { allowed, authorizeObject, authorizeRead, requirePermission } from '../core/access';
import { audit } from '../core/audit';
import type { CommandContext, QueryContext } from '../core/context';
import { dbOf } from '../core/context';
import { emit } from '../core/events';
import { isActiveMember, loadMemberRefs } from '../core/members';
import { assertVersion, lockById, stamp, touch } from '../core/rows';
import { convertCustomFieldValue, displayCustomFieldValue, isEmptyValue, validateCustomFieldValue, type CustomFieldType, type FieldDef } from './custom-field-values';

type DefRow = typeof customFieldDefinitions.$inferSelect;
type OptionInput = { key: string; label: string; archivedAt?: string | null };

export const MAX_ACTIVE_FIELDS = 30;
/** Keys of canonical fields: custom fields never shadow statuses, amounts or permissions. */
const RESERVED_KEYS = new Set(['id', 'status', 'stage', 'name', 'title', 'amount', 'currency', 'budget', 'owner', 'permissions', 'permission', 'role', 'project', 'workspace', 'total', 'type']);

export interface CustomFieldTarget {
  entityType: string;
  label: string;
  readPermission: string;
  writePermission: string;
  /** Ordered lifecycle stages (Required At Stage applies from that stage on). */
  stages: readonly string[];
  /** Stages after which values are no longer required (terminal/cancelled). */
  exemptStages?: readonly string[];
  resolve(ctx: QueryContext, id: string): Promise<{ scope: ObjectScope; projectId: string | null; stage: string | null } | null>;
}

/** Entity types that support custom fields; modules may register theirs (`defineCustomFieldTarget`). */
export const CUSTOM_FIELD_TARGETS = new Map<string, CustomFieldTarget>();
export const defineCustomFieldTarget = (t: CustomFieldTarget) => {
  CUSTOM_FIELD_TARGETS.set(t.entityType, t);
};

defineCustomFieldTarget({
  entityType: 'project',
  label: 'Projects',
  readPermission: 'projects.read',
  writePermission: 'projects.update',
  stages: PROJECT_STATUSES,
  exemptStages: ['archived'],
  async resolve(ctx, id) {
    const [p] = await dbOf(ctx).select().from(projects).where(and(eq(projects.workspaceId, ctx.actor.workspaceId), eq(projects.id, id), isNull(projects.deletedAt)));
    return p ? { scope: { objectType: 'project', objectId: p.id, projectId: p.id, directionId: p.directionId, ownerMembershipId: p.ownerMembershipId }, projectId: p.id, stage: p.status } : null;
  },
});
defineCustomFieldTarget({
  entityType: 'task',
  label: 'Tasks',
  readPermission: 'tasks.read',
  writePermission: 'tasks.edit',
  stages: TASK_STATUSES,
  exemptStages: ['cancelled'],
  async resolve(ctx, id) {
    const [t] = await dbOf(ctx).select().from(tasks).where(and(eq(tasks.workspaceId, ctx.actor.workspaceId), eq(tasks.id, id), isNull(tasks.deletedAt)));
    return t
      ? { scope: { objectType: 'task', objectId: t.id, projectId: t.projectId, accountId: t.accountId, assignedMembershipIds: [t.assigneeMembershipId, t.reviewerMembershipId] }, projectId: t.projectId, stage: t.status }
      : null;
  },
});
defineCustomFieldTarget({
  entityType: 'content_item',
  label: 'Content',
  readPermission: 'content.read',
  writePermission: 'content.edit',
  stages: CONTENT_STAGES,
  exemptStages: ['archived'],
  async resolve(ctx, id) {
    const [c] = await dbOf(ctx).select().from(contentItems).where(and(eq(contentItems.workspaceId, ctx.actor.workspaceId), eq(contentItems.id, id), isNull(contentItems.deletedAt)));
    return c
      ? {
          scope: { objectType: 'content_item', objectId: c.id, projectId: c.projectId, ownerMembershipId: c.ownerMembershipId, assignedMembershipIds: [c.ownerMembershipId, c.reviewerMembershipId] },
          projectId: c.projectId,
          stage: c.stage,
        }
      : null;
  },
});
defineCustomFieldTarget({
  entityType: 'account',
  label: 'Accounts',
  readPermission: 'accounts.read',
  writePermission: 'accounts.write',
  stages: ACCOUNT_STATUSES,
  exemptStages: ['archived'],
  async resolve(ctx, id) {
    const [a] = await dbOf(ctx).select().from(socialAccounts).where(and(eq(socialAccounts.workspaceId, ctx.actor.workspaceId), eq(socialAccounts.id, id), isNull(socialAccounts.deletedAt)));
    return a ? { scope: { objectType: 'account', objectId: a.id, accountId: a.id, projectId: a.projectId, ownerMembershipId: a.ownerMembershipId }, projectId: a.projectId, stage: a.status } : null;
  },
});

const targetOf = (entityType: string) => {
  const t = CUSTOM_FIELD_TARGETS.get(entityType);
  if (!t) throw new AppError('VALIDATION_FAILED', 'This record type does not support custom fields.', { fieldErrors: [{ field: 'entityType', code: 'UNSUPPORTED', message: 'Choose a supported record type.' }] });
  return t;
};

const fieldDef = (d: Pick<DefRow, 'type' | 'options' | 'precision' | 'unit'>): FieldDef => ({ type: d.type as CustomFieldType, options: d.options, precision: d.precision, unit: d.unit });

const canReadDefinitions = (ctx: QueryContext, entityType?: string) =>
  hasAnywhere(ctx.actor.access, 'custom-fields.manage') ||
  (entityType ? hasAnywhere(ctx.actor.access, targetOf(entityType).readPermission) : [...CUSTOM_FIELD_TARGETS.values()].some((t) => hasAnywhere(ctx.actor.access, t.readPermission)));

export const listCustomFieldTargets = async (ctx: QueryContext) => {
  if (!canReadDefinitions(ctx)) throw new AppError('FORBIDDEN', 'You do not have access to custom fields.');
  const active = await dbOf(ctx)
    .select({ entityType: customFieldDefinitions.entityType, n: count() })
    .from(customFieldDefinitions)
    .where(and(eq(customFieldDefinitions.workspaceId, ctx.actor.workspaceId), isNull(customFieldDefinitions.archivedAt)))
    .groupBy(customFieldDefinitions.entityType);
  const by = new Map(active.map((a) => [a.entityType, Number(a.n)]));
  return [...CUSTOM_FIELD_TARGETS.values()].map((t) => ({ entityType: t.entityType, label: t.label, stages: [...t.stages], activeFields: by.get(t.entityType) ?? 0, maxActiveFields: MAX_ACTIVE_FIELDS }));
};

const toDefinitions = async (ctx: QueryContext, rows: DefRow[]) => {
  const ids = rows.map((r) => r.id);
  const counts = ids.length
    ? await dbOf(ctx).select({ id: customFieldValues.definitionId, n: count() }).from(customFieldValues).where(and(inArray(customFieldValues.definitionId, ids), sql`${customFieldValues.value} IS NOT NULL AND ${customFieldValues.value} <> 'null'::jsonb`)).groupBy(customFieldValues.definitionId)
    : [];
  const byId = new Map(counts.map((c) => [c.id, Number(c.n)]));
  const projectIds = [...new Set(rows.map((r) => r.scopeProjectId).filter((x): x is string => !!x))];
  const ps = projectIds.length ? await dbOf(ctx).select({ id: projects.id, name: projects.name }).from(projects).where(inArray(projects.id, projectIds)) : [];
  const pn = new Map(ps.map((p) => [p.id, p.name]));
  return rows.map((d) => ({
    id: d.id,
    entityType: d.entityType,
    key: d.key,
    name: d.name,
    type: d.type,
    scopeProject: d.scopeProjectId ? { id: d.scopeProjectId, name: allowed(ctx, 'projects.read', { projectId: d.scopeProjectId }) ? (pn.get(d.scopeProjectId) ?? 'Project') : 'Restricted project' } : null,
    options: d.options.map((o) => ({ key: o.key, label: o.label, archivedAt: o.archivedAt ?? null })),
    requiredAtStage: d.requiredAtStage,
    unit: d.unit,
    precision: d.precision,
    replacedById: d.replacedById,
    usedAt: d.usedAt?.toISOString() ?? null,
    archivedAt: d.archivedAt?.toISOString() ?? null,
    archiveReason: d.archiveReason,
    valueCount: byId.get(d.id) ?? 0,
    updatedAt: d.updatedAt.toISOString(),
    rowVersion: d.rowVersion,
  }));
};

export const listCustomFields = async (ctx: QueryContext, input: { entityType?: string; includeArchived?: boolean }) => {
  if (input.entityType) targetOf(input.entityType);
  if (!canReadDefinitions(ctx, input.entityType)) throw new AppError('FORBIDDEN', 'You do not have access to custom fields.');
  const rows = await dbOf(ctx)
    .select()
    .from(customFieldDefinitions)
    .where(
      and(
        eq(customFieldDefinitions.workspaceId, ctx.actor.workspaceId),
        input.entityType ? eq(customFieldDefinitions.entityType, input.entityType) : undefined,
        input.includeArchived ? undefined : isNull(customFieldDefinitions.archivedAt),
      ),
    )
    .orderBy(asc(customFieldDefinitions.entityType), asc(customFieldDefinitions.name), asc(customFieldDefinitions.id));
  return toDefinitions(ctx, rows);
};

export const getCustomField = async (ctx: QueryContext | CommandContext, id: string) => {
  const [d] = await dbOf(ctx).select().from(customFieldDefinitions).where(and(eq(customFieldDefinitions.workspaceId, ctx.actor.workspaceId), eq(customFieldDefinitions.id, id)));
  if (!d || !canReadDefinitions(ctx, d.entityType)) throw notFound('Custom field');
  return (await toDefinitions(ctx, [d]))[0]!;
};

const validateDefinition = (input: { type: CustomFieldType; options?: OptionInput[]; requiredAtStage?: string | null; precision?: number | null }, target: CustomFieldTarget) => {
  const errors: { field: string; code: string; message: string }[] = [];
  const selects = input.type === 'single_select' || input.type === 'multi_select';
  const opts = input.options ?? [];
  if (selects && opts.filter((o) => !o.archivedAt).length === 0) errors.push({ field: 'options', code: 'REQUIRED', message: 'Add at least one option.' });
  if (!selects && opts.length) errors.push({ field: 'options', code: 'NOT_ALLOWED', message: 'Options apply to select fields only.' });
  const keys = new Set<string>();
  for (const o of opts) {
    if (keys.has(o.key)) errors.push({ field: 'options', code: 'DUPLICATE', message: `The option key “${o.key}” is used twice.` });
    keys.add(o.key);
  }
  if (input.requiredAtStage && !target.stages.includes(input.requiredAtStage)) errors.push({ field: 'requiredAtStage', code: 'INVALID', message: 'Choose one of the record’s stages.' });
  if (input.type !== 'number' && input.precision !== undefined && input.precision !== null) errors.push({ field: 'precision', code: 'NOT_ALLOWED', message: 'Precision applies to number fields only.' });
  if (errors.length) throw new AppError('VALIDATION_FAILED', errors[0]!.message, { fieldErrors: errors });
};

const assertScopeProject = async (ctx: CommandContext, projectId: string | null | undefined) => {
  if (!projectId) return;
  const [p] = await ctx.tx.select({ id: projects.id }).from(projects).where(and(eq(projects.workspaceId, ctx.actor.workspaceId), eq(projects.id, projectId)));
  if (!p || !allowed(ctx, 'projects.read', { projectId })) throw new AppError('VALIDATION_FAILED', 'Choose a project you can access.', { fieldErrors: [{ field: 'scopeProjectId', code: 'INVALID', message: 'Choose a project you can access.' }] });
};

/** At most 30 active fields per entity type; the check is serialised per workspace + type. */
const assertCapacity = async (ctx: CommandContext, entityType: string) => {
  await ctx.tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`custom-fields:${ctx.actor.workspaceId}:${entityType}`}))`);
  const [r] = await ctx.tx
    .select({ n: count() })
    .from(customFieldDefinitions)
    .where(and(eq(customFieldDefinitions.workspaceId, ctx.actor.workspaceId), eq(customFieldDefinitions.entityType, entityType), isNull(customFieldDefinitions.archivedAt)));
  if (Number(r?.n ?? 0) >= MAX_ACTIVE_FIELDS)
    throw new AppError('INVALID_STATE', `This record type already has ${MAX_ACTIVE_FIELDS} active custom fields. Archive one before adding another.`);
};

export const createCustomField = async (
  ctx: CommandContext,
  input: { entityType: string; key: string; name: string; type: CustomFieldType; scopeProjectId?: string | null; options?: OptionInput[]; requiredAtStage?: string | null; unit?: string | null; precision?: number | null },
) => {
  requirePermission(ctx, 'custom-fields.manage');
  const target = targetOf(input.entityType);
  if (RESERVED_KEYS.has(input.key))
    throw new AppError('VALIDATION_FAILED', 'This key is reserved for a built-in field.', { fieldErrors: [{ field: 'key', code: 'RESERVED', message: 'Choose another key; built-in fields cannot be shadowed.' }] });
  validateDefinition(input, target);
  await assertScopeProject(ctx, input.scopeProjectId);
  await assertCapacity(ctx, input.entityType);
  const id = newId();
  await ctx.tx.insert(customFieldDefinitions).values({
    ...stamp(ctx),
    id,
    entityType: input.entityType,
    key: input.key,
    name: input.name.trim(),
    type: input.type,
    scopeProjectId: input.scopeProjectId ?? null,
    options: (input.options ?? []).map((o) => ({ key: o.key, label: o.label.trim() })),
    requiredAtStage: input.requiredAtStage ?? null,
    unit: input.type === 'number' ? (input.unit?.trim() || null) : null,
    precision: input.type === 'number' ? (input.precision ?? 0) : null,
  });
  await audit(ctx, { action: 'custom_field.created', entityType: 'custom_field_definition', entityId: id, metadata: { entityType: input.entityType, key: input.key, type: input.type, requiredAtStage: input.requiredAtStage ?? null } });
  await emit(ctx, { type: 'custom_field.created', entityType: 'custom_field_definition', entityId: id, revision: 1 });
  return id;
};

const lockDef = async (ctx: CommandContext, id: string) => {
  requirePermission(ctx, 'custom-fields.manage');
  const d = await lockById(ctx, customFieldDefinitions, id, 'Custom field');
  assertVersion(ctx, d);
  return d;
};

/** Removed options are archived (historical labels stay readable); keys and type never change here. */
export const updateCustomField = async (
  ctx: CommandContext,
  id: string,
  input: { name?: string; options?: OptionInput[]; requiredAtStage?: string | null; unit?: string | null; precision?: number | null; scopeProjectId?: string | null },
) => {
  const d = await lockDef(ctx, id);
  if (d.archivedAt) throw new AppError('INVALID_STATE', 'Archived fields cannot change.');
  const target = targetOf(d.entityType);
  const patch: Partial<DefRow> = {};
  if (input.name !== undefined) patch.name = input.name.trim();
  if (input.options !== undefined) {
    const now = ctx.app.clock.now().toISOString();
    const next = new Map(input.options.map((o) => [o.key, o]));
    const merged: CustomFieldOption[] = d.options.map((o) => {
      const n = next.get(o.key);
      if (!n) return { ...o, archivedAt: o.archivedAt ?? now };
      next.delete(o.key);
      return { key: o.key, label: n.label.trim(), ...(n.archivedAt ? { archivedAt: o.archivedAt ?? now } : {}) };
    });
    for (const n of next.values()) merged.push({ key: n.key, label: n.label.trim() });
    patch.options = merged;
  }
  if (input.requiredAtStage !== undefined) patch.requiredAtStage = input.requiredAtStage;
  if (input.unit !== undefined) patch.unit = d.type === 'number' ? input.unit?.trim() || null : null;
  if (input.precision !== undefined) {
    if (d.usedAt && input.precision !== null && d.precision !== null && input.precision < d.precision)
      throw new AppError('VALIDATION_FAILED', 'Precision cannot be reduced after values were stored; replace the field instead.', { fieldErrors: [{ field: 'precision', code: 'USED', message: 'Precision cannot be reduced after use.' }] });
    patch.precision = input.precision;
  }
  if (input.scopeProjectId !== undefined && input.scopeProjectId !== d.scopeProjectId) {
    if (d.usedAt) throw new AppError('VALIDATION_FAILED', 'The project scope cannot change after values were stored.', { fieldErrors: [{ field: 'scopeProjectId', code: 'USED', message: 'The scope cannot change after use.' }] });
    await assertScopeProject(ctx, input.scopeProjectId);
    patch.scopeProjectId = input.scopeProjectId;
  }
  validateDefinition({ type: d.type as CustomFieldType, options: patch.options ?? d.options, requiredAtStage: patch.requiredAtStage ?? d.requiredAtStage, precision: patch.precision ?? d.precision }, target);
  const [row] = await ctx.tx.update(customFieldDefinitions).set({ ...patch, ...touch(ctx, customFieldDefinitions) }).where(eq(customFieldDefinitions.id, id)).returning();
  const diff: Record<string, { from?: unknown; to?: unknown }> = {};
  for (const k of ['name', 'requiredAtStage', 'unit', 'precision', 'scopeProjectId'] as const) if (JSON.stringify(d[k]) !== JSON.stringify(row![k])) diff[k] = { from: d[k], to: row![k] };
  if (patch.options) diff.options = { from: d.options.map((o) => o.label), to: row!.options.filter((o) => !o.archivedAt).map((o) => o.label) };
  await audit(ctx, { action: 'custom_field.updated', entityType: 'custom_field_definition', entityId: id, diff });
  await emit(ctx, { type: 'custom_field.updated', entityType: 'custom_field_definition', entityId: id, revision: row!.rowVersion });
  return id;
};

export const archiveCustomField = async (ctx: CommandContext, id: string, reason: string) => {
  const d = await lockDef(ctx, id);
  if (d.archivedAt) throw new AppError('INVALID_STATE', 'The field is already archived.');
  const [row] = await ctx.tx.update(customFieldDefinitions).set({ archivedAt: ctx.app.clock.now(), archivedBy: ctx.actor.userId, archiveReason: reason, ...touch(ctx, customFieldDefinitions) }).where(eq(customFieldDefinitions.id, id)).returning();
  await audit(ctx, { action: 'custom_field.archived', entityType: 'custom_field_definition', entityId: id, reason, metadata: { entityType: d.entityType, key: d.key } });
  await emit(ctx, { type: 'custom_field.archived', entityType: 'custom_field_definition', entityId: id, revision: row!.rowVersion });
  return id;
};

const replacementDef = (d: DefRow, input: { type: CustomFieldType; options?: OptionInput[]; precision?: number | null; unit?: string | null }): FieldDef => ({
  type: input.type,
  options: (input.options ?? []).map((o) => ({ key: o.key, label: o.label })),
  precision: input.type === 'number' ? (input.precision ?? 0) : null,
  unit: input.type === 'number' ? (input.unit ?? null) : null,
});

/** Migration preview for a type change: counts and samples; nothing changes. */
export const replaceCustomFieldPreview = async (ctx: QueryContext, id: string, input: { type: CustomFieldType; options?: OptionInput[]; precision?: number | null }) => {
  requirePermission(ctx, 'custom-fields.manage');
  const [d] = await dbOf(ctx).select().from(customFieldDefinitions).where(and(eq(customFieldDefinitions.workspaceId, ctx.actor.workspaceId), eq(customFieldDefinitions.id, id)));
  if (!d) throw notFound('Custom field');
  const to = replacementDef(d, input);
  const values = await dbOf(ctx).select({ value: customFieldValues.value }).from(customFieldValues).where(eq(customFieldValues.definitionId, d.id));
  const nonEmpty = values.filter((v) => !isEmptyValue(v.value));
  const samples: { from: string; to: string | null }[] = [];
  let convertible = 0;
  for (const v of nonEmpty) {
    const c = convertCustomFieldValue(fieldDef(d), to, v.value);
    if (c !== undefined) convertible++;
    if (samples.length < 10) samples.push({ from: displayCustomFieldValue(fieldDef(d), v.value) ?? '', to: c === undefined ? null : displayCustomFieldValue(to, c) });
  }
  return { total: nonEmpty.length, convertible, notConvertible: nonEmpty.length - convertible, samples };
};

/** Replace instead of a destructive type change: new definition; the old one is archived with its values. */
export const replaceCustomField = async (
  ctx: CommandContext,
  id: string,
  input: { type: CustomFieldType; name?: string; options?: OptionInput[]; unit?: string | null; precision?: number | null; migrateValues: boolean },
) => {
  const d = await lockDef(ctx, id);
  if (d.archivedAt) throw new AppError('INVALID_STATE', 'Archived fields cannot be replaced.');
  const target = targetOf(d.entityType);
  validateDefinition({ type: input.type, options: input.options, requiredAtStage: d.requiredAtStage, precision: input.precision }, target);
  const now = ctx.app.clock.now();
  await ctx.tx.update(customFieldDefinitions).set({ archivedAt: now, archivedBy: ctx.actor.userId, archiveReason: `Replaced by a ${input.type.replace('_', ' ')} field`, ...touch(ctx, customFieldDefinitions) }).where(eq(customFieldDefinitions.id, d.id));
  const newIdValue = newId();
  const to = replacementDef(d, input);
  await ctx.tx.insert(customFieldDefinitions).values({
    ...stamp(ctx),
    id: newIdValue,
    entityType: d.entityType,
    key: d.key,
    name: (input.name ?? d.name).trim(),
    type: input.type,
    scopeProjectId: d.scopeProjectId,
    options: (input.options ?? []).map((o) => ({ key: o.key, label: o.label.trim() })),
    requiredAtStage: d.requiredAtStage,
    unit: to.unit ?? null,
    precision: to.precision,
  });
  await ctx.tx.update(customFieldDefinitions).set({ replacedById: newIdValue }).where(eq(customFieldDefinitions.id, d.id));
  let migrated = 0;
  if (input.migrateValues) {
    const values = await ctx.tx.select().from(customFieldValues).where(eq(customFieldValues.definitionId, d.id));
    for (const v of values) {
      const c = convertCustomFieldValue(fieldDef(d), to, v.value);
      if (c === undefined || c === null) continue;
      await ctx.tx.insert(customFieldValues).values({ ...stamp(ctx), id: newId(), definitionId: newIdValue, entityType: v.entityType, entityId: v.entityId, value: c });
      migrated++;
    }
    if (migrated) await ctx.tx.update(customFieldDefinitions).set({ usedAt: now }).where(eq(customFieldDefinitions.id, newIdValue));
  }
  await audit(ctx, { action: 'custom_field.replaced', entityType: 'custom_field_definition', entityId: d.id, metadata: { newDefinitionId: newIdValue, fromType: d.type, toType: input.type, migrated } });
  await emit(ctx, { type: 'custom_field.replaced', entityType: 'custom_field_definition', entityId: d.id });
  return newIdValue;
};

// ——— Values ———

const stageIndex = (t: CustomFieldTarget, s: string | null) => (s ? t.stages.indexOf(s) : -1);

/** A field is required once the record reached its Required At Stage (never for exempt stages). */
const requiredNow = (t: CustomFieldTarget, d: Pick<DefRow, 'requiredAtStage'>, stage: string | null) =>
  !!d.requiredAtStage && !!stage && !(t.exemptStages ?? []).includes(stage) && stageIndex(t, stage) >= stageIndex(t, d.requiredAtStage) && stageIndex(t, d.requiredAtStage) >= 0;

const applicableDefs = async (ctx: QueryContext | CommandContext, entityType: string, projectId: string | null, includeArchived: boolean) =>
  dbOf(ctx)
    .select()
    .from(customFieldDefinitions)
    .where(
      and(
        eq(customFieldDefinitions.workspaceId, ctx.actor.workspaceId),
        eq(customFieldDefinitions.entityType, entityType),
        projectId ? or(isNull(customFieldDefinitions.scopeProjectId), eq(customFieldDefinitions.scopeProjectId, projectId)) : isNull(customFieldDefinitions.scopeProjectId),
        includeArchived ? undefined : isNull(customFieldDefinitions.archivedAt),
      ),
    )
    .orderBy(asc(customFieldDefinitions.name), asc(customFieldDefinitions.id));

export const getCustomFieldValues = async (ctx: QueryContext | CommandContext, entityType: string, entityId: string) => {
  const t = targetOf(entityType);
  const r = await t.resolve(ctx, entityId);
  if (!r) throw notFound('Record');
  authorizeRead(ctx, t.readPermission, r.scope);
  const defs = await applicableDefs(ctx, entityType, r.projectId, true);
  const values = defs.length
    ? await dbOf(ctx)
        .select()
        .from(customFieldValues)
        .where(and(eq(customFieldValues.workspaceId, ctx.actor.workspaceId), eq(customFieldValues.entityType, entityType), eq(customFieldValues.entityId, entityId), inArray(customFieldValues.definitionId, defs.map((d) => d.id))))
    : [];
  const byDef = new Map(values.map((v) => [v.definitionId, v]));
  // Archived definitions appear only where this record kept a value (history, read-only).
  const shown = defs.filter((d) => !d.archivedAt || !isEmptyValue(byDef.get(d.id)?.value));
  const memberIds = shown.filter((d) => d.type === 'member_reference').map((d) => byDef.get(d.id)?.value as string | undefined);
  const refs = await loadMemberRefs(dbOf(ctx), ctx.actor.workspaceId, memberIds);
  return {
    entityType,
    entityId,
    stage: r.stage,
    canEdit: can(ctx.actor.access, t.writePermission, r.scope),
    fields: shown.map((d) => {
      const v = byDef.get(d.id);
      const value = v?.value ?? null;
      const required = !d.archivedAt && requiredNow(t, d, r.stage);
      return {
        definition: { id: d.id, key: d.key, name: d.name, type: d.type, options: d.options.map((o) => ({ key: o.key, label: o.label, archivedAt: o.archivedAt ?? null })), requiredAtStage: d.requiredAtStage, unit: d.unit, precision: d.precision, archivedAt: d.archivedAt?.toISOString() ?? null },
        value,
        displayValue: displayCustomFieldValue(fieldDef(d), value, (id) => refs.get(id)?.displayName ?? null),
        required,
        needsCompletion: required && isEmptyValue(value),
        rowVersion: v?.rowVersion ?? null,
      };
    }),
  };
};

/** Save values of one record. Each value carries the row version it was edited from (412 on conflict). */
export const setCustomFieldValues = async (ctx: CommandContext, input: { entityType: string; entityId: string; values: { definitionId: string; value: unknown; rowVersion?: number | null }[] }) => {
  const t = targetOf(input.entityType);
  const r = await t.resolve(ctx, input.entityId);
  if (!r) throw notFound('Record');
  authorizeObject(ctx, t.writePermission, r.scope, t.readPermission);
  const defs = await applicableDefs(ctx, input.entityType, r.projectId, false);
  const byId = new Map(defs.map((d) => [d.id, d]));
  const fieldErrors: { field: string; code: string; message: string }[] = [];
  const normalized: { def: DefRow; value: unknown; rowVersion?: number | null }[] = [];
  for (const v of input.values) {
    const d = byId.get(v.definitionId);
    if (!d) {
      fieldErrors.push({ field: `values.${v.definitionId}`, code: 'UNKNOWN_FIELD', message: 'This field is not available for the record.' });
      continue;
    }
    const check = validateCustomFieldValue(fieldDef(d), v.value);
    if (!check.ok) {
      fieldErrors.push({ field: `values.${d.id}`, code: 'INVALID', message: check.message });
      continue;
    }
    if (d.type === 'member_reference' && check.value && !(await isActiveMember(ctx.tx, ctx.actor.workspaceId, check.value as string)))
      fieldErrors.push({ field: `values.${d.id}`, code: 'INACTIVE', message: 'Choose an active member.' });
    else normalized.push({ def: d, value: check.value, rowVersion: v.rowVersion });
  }
  if (fieldErrors.length) throw new AppError('VALIDATION_FAILED', fieldErrors[0]!.message, { fieldErrors });
  const diff: Record<string, { from?: unknown; to?: unknown }> = {};
  const now = ctx.app.clock.now();
  for (const n of normalized) {
    const [existing] = await ctx.tx.select().from(customFieldValues).where(and(eq(customFieldValues.definitionId, n.def.id), eq(customFieldValues.entityId, input.entityId))).for('update');
    if (existing && n.rowVersion !== undefined && n.rowVersion !== null && existing.rowVersion !== n.rowVersion) throw versionConflict(existing.rowVersion);
    if (!existing && n.rowVersion) throw versionConflict(0);
    const needsCompletion = requiredNow(t, n.def, r.stage) && isEmptyValue(n.value);
    if (existing) {
      if (JSON.stringify(existing.value ?? null) === JSON.stringify(n.value ?? null)) continue;
      await ctx.tx.update(customFieldValues).set({ value: n.value, needsCompletion, ...touch(ctx, customFieldValues) }).where(eq(customFieldValues.id, existing.id));
    } else {
      if (n.value === null) continue;
      await ctx.tx.insert(customFieldValues).values({ ...stamp(ctx), id: newId(), definitionId: n.def.id, entityType: input.entityType, entityId: input.entityId, value: n.value, needsCompletion });
    }
    if (!n.def.usedAt && n.value !== null) await ctx.tx.update(customFieldDefinitions).set({ usedAt: now }).where(eq(customFieldDefinitions.id, n.def.id));
    diff[n.def.key] = { from: existing?.value ?? null, to: n.value };
  }
  if (Object.keys(diff).length) {
    await audit(ctx, { action: 'custom_fields.updated', entityType: input.entityType, entityId: input.entityId, projectId: r.projectId, diff });
    await emit(ctx, { type: 'custom_fields.updated', entityType: 'custom_field_values', entityId: input.entityId, payload: { entityType: input.entityType } });
  }
  return getCustomFieldValues(ctx, input.entityType, input.entityId);
};

/**
 * Required At Stage: call from a module's transition command before moving a record into
 * `targetStage`; throws VALIDATION_FAILED listing the empty required fields.
 */
export const assertCustomFieldsComplete = async (ctx: CommandContext | QueryContext, entityType: string, entityId: string, targetStage: string, projectId: string | null) => {
  const t = CUSTOM_FIELD_TARGETS.get(entityType);
  if (!t) return;
  const defs = (await applicableDefs(ctx, entityType, projectId, false)).filter((d) => d.requiredAtStage && requiredNow(t, d, targetStage));
  if (!defs.length) return;
  const values = await dbOf(ctx)
    .select()
    .from(customFieldValues)
    .where(and(eq(customFieldValues.entityId, entityId), inArray(customFieldValues.definitionId, defs.map((d) => d.id))));
  const byDef = new Map(values.map((v) => [v.definitionId, v.value]));
  const missing = defs.filter((d) => isEmptyValue(byDef.get(d.id)));
  if (missing.length)
    throw new AppError('VALIDATION_FAILED', `Complete the required custom fields first: ${missing.map((d) => d.name).join(', ')}.`, {
      fieldErrors: missing.map((d) => ({ field: `customFields.${d.key}`, code: 'REQUIRED_AT_STAGE', message: `${d.name} is required from the ${targetStage.replace('_', ' ')} stage.` })),
    });
};
