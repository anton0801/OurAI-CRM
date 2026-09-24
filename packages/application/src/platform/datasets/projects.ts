import { and, asc, count, eq, gt, ilike, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { can } from '@castlane/authorization';
import {
  assets,
  budgetLines,
  budgets,
  budgetVersions,
  characters,
  contentItems,
  customFieldValues,
  directions,
  memberships,
  ofmAssignments,
  ofmProfiles,
  projectDecisions,
  projectDirectionHistory,
  projectMemberships,
  projectMilestones,
  projects,
  publications,
  seasons,
  shifts,
  socialAccounts,
  tasks,
  users,
  workspaces,
} from '@castlane/database';
import { AppError, PROJECT_STATUSES, PROJECT_TYPES, formatMinor, isEmail, isUuid, newId, normalizeEmail, normalizeKey } from '@castlane/domain';
import { allowed, authorizeObject, requirePermission, scopePredicate } from '../../core/access';
import { extendArchiveHandler, tableArchiveList } from '../../core/archive-registry';
import { audit } from '../../core/audit';
import type { CommandContext, QueryContext } from '../../core/context';
import { dbOf } from '../../core/context';
import { emit } from '../../core/events';
import { defineExportDataset } from '../../core/export-registry';
import { defineImportDataset, type ImportIssue } from '../../core/import-registry';
import { loadMemberRefs } from '../../core/members';
import { lockById, touch } from '../../core/rows';
import { indexSearchDocument, removeSearchDocument } from '../../core/search';
import { defineTombstoneReplay, recordTombstone } from '../tombstones';
import { createProject, projectScope, updateProject } from '../../organization/projects';

type ProjectRow = typeof projects.$inferSelect;

const issue = (field: string, code: string, message: string): ImportIssue => ({ field, code, message });

// ——— Reference resolution (stable ids or unambiguous names; never auto-created) ———

const resolveDirection = async (ctx: QueryContext, value: string) => {
  const db = dbOf(ctx);
  const rows = isUuid(value)
    ? await db.select().from(directions).where(and(eq(directions.workspaceId, ctx.actor.workspaceId), eq(directions.id, value)))
    : await db.select().from(directions).where(and(eq(directions.workspaceId, ctx.actor.workspaceId), eq(directions.nameKey, normalizeKey(value)), eq(directions.status, 'active')));
  const d = rows[0];
  if (!d || d.status !== 'active') return null;
  return d;
};

const resolveMember = async (ctx: QueryContext, value: string): Promise<{ id: string } | 'ambiguous' | null> => {
  const db = dbOf(ctx);
  const base = and(eq(memberships.workspaceId, ctx.actor.workspaceId), eq(memberships.status, 'active'));
  if (isUuid(value)) {
    const [m] = await db.select({ id: memberships.id }).from(memberships).where(and(base, eq(memberships.id, value)));
    return m ?? null;
  }
  if (isEmail(value)) {
    const [m] = await db
      .select({ id: memberships.id })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(base, eq(users.normalizedEmail, normalizeEmail(value))));
    return m ?? null;
  }
  const rows = await db
    .select({ id: memberships.id })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(base, sql`lower(${users.displayName}) = lower(${String(value).trim()})`))
    .limit(2);
  return rows.length === 1 ? rows[0]! : rows.length > 1 ? 'ambiguous' : null;
};

const typeLocked = async (ctx: QueryContext, p: ProjectRow) => {
  const db = dbOf(ctx);
  const [s] = await db.select({ n: count() }).from(seasons).where(and(eq(seasons.workspaceId, p.workspaceId), eq(seasons.projectId, p.id)));
  const [o] = await db.select({ n: count() }).from(ofmAssignments).where(and(eq(ofmAssignments.workspaceId, p.workspaceId), eq(ofmAssignments.projectId, p.id)));
  const [sh] = await db.select({ n: count() }).from(shifts).where(and(eq(shifts.workspaceId, p.workspaceId), eq(shifts.projectId, p.id)));
  return Number(s?.n ?? 0) + Number(o?.n ?? 0) + Number(sh?.n ?? 0) > 0;
};

interface ProjectImportRow {
  name: string;
  type?: ProjectRow['type'];
  directionId?: string;
  ownerMembershipId?: string;
  briefSummary?: string | null;
  description?: string | null;
  language?: string | null;
  targetMarkets?: string[];
  audience?: string | null;
  tags?: string[];
  startDate?: string | null;
  ofmEnabled?: boolean;
}

const OPTIONAL_FIELDS = ['briefSummary', 'description', 'language', 'targetMarkets', 'audience', 'tags', 'startDate', 'ofmEnabled'] as const;

/**
 * Projects dataset (section 22.1). New rows create Draft projects (never activated, no accounts or
 * statistics); "Revise Existing" updates only the provided mutable fields; directions and owners
 * must already exist.
 */
defineImportDataset<ProjectImportRow>({
  key: 'projects',
  label: 'Projects',
  permission: 'projects.create',
  duplicatePolicies: ['error', 'skip', 'revise_existing'],
  columns: [
    { key: 'id', label: 'Project ID', type: 'reference', aliases: ['project id', 'uuid'], description: 'Existing project to update. Leave empty to create a new project.' },
    { key: 'name', label: 'Name', type: 'text', required: true, aliases: ['project', 'project name', 'title'], description: '2–120 characters.' },
    { key: 'type', label: 'Type', type: 'enum', enumValues: PROJECT_TYPES, aliases: ['project type'], description: 'series, model or influencer. Required for new projects.' },
    { key: 'direction', label: 'Direction', type: 'reference', aliases: ['direction name', 'direction id'], description: 'Direction name or ID. Required for new projects; directions are never created by import.' },
    { key: 'owner', label: 'Owner', type: 'reference', aliases: ['owner email', 'owner id', 'project owner'], description: 'E-mail, member ID or unique name of an active member. Required for new projects.' },
    { key: 'briefSummary', label: 'Brief Summary', type: 'long_text', aliases: ['brief', 'summary'] },
    { key: 'description', label: 'Description', type: 'long_text' },
    { key: 'language', label: 'Language', type: 'text', aliases: ['lang'] },
    { key: 'targetMarkets', label: 'Target Markets', type: 'tags', aliases: ['markets'], description: 'Separate several values with commas.' },
    { key: 'audience', label: 'Audience', type: 'long_text' },
    { key: 'tags', label: 'Tags', type: 'tags', description: 'Separate several tags with commas.' },
    { key: 'startDate', label: 'Start Date', type: 'date' },
    { key: 'ofmEnabled', label: 'OFM Enabled', type: 'boolean', aliases: ['ofm'], description: 'Model and influencer projects only.' },
  ],
  async validate(ctx, row, opts) {
    const errors: ImportIssue[] = [];
    const warnings: ImportIssue[] = [];
    const name = String(row.name ?? '').trim();
    if (name.length < 2 || name.length > 120) errors.push(issue('name', 'LENGTH', 'Name must be 2–120 characters.'));
    const db = dbOf(ctx);
    let target: ProjectRow | null = null;
    if (row.id) {
      const id = String(row.id);
      if (!isUuid(id)) errors.push(issue('id', 'INVALID_ID', 'Project ID must be a project’s UUID.'));
      else {
        const [p] = await db.select().from(projects).where(and(eq(projects.workspaceId, ctx.actor.workspaceId), eq(projects.id, id), isNull(projects.deletedAt)));
        if (!p || !allowed(ctx, 'projects.read', projectScope(p))) errors.push(issue('id', 'NOT_FOUND', 'No project with this ID is available to you.'));
        else target = p;
      }
    } else if (name) {
      // Only projects the importer can read are considered, so matching never reveals hidden ones.
      const matches = await db
        .select()
        .from(projects)
        .where(
          and(
            eq(projects.workspaceId, ctx.actor.workspaceId),
            isNull(projects.deletedAt),
            sql`lower(${projects.name}) = lower(${name})`,
            scopePredicate(ctx, 'projects.read', { projectId: projects.id, ownerMembership: projects.ownerMembershipId }),
          ),
        )
        .limit(2);
      if (matches.length > 1) errors.push(issue('name', 'AMBIGUOUS', `More than one project is named “${name}”. Add the Project ID column to choose one.`));
      else target = matches[0] ?? null;
    }
    const dedupeKey = target ? `id:${target.id}` : `name:${normalizeKey(name)}`;
    const direction = row.direction ? await resolveDirection(ctx, String(row.direction)) : null;
    if (row.direction && !direction) errors.push(issue('direction', 'UNKNOWN_REFERENCE', `Unknown or archived direction “${String(row.direction)}”. Directions are never created by import.`));
    let ownerId: string | undefined;
    if (row.owner) {
      const m = await resolveMember(ctx, String(row.owner));
      if (m === 'ambiguous') errors.push(issue('owner', 'AMBIGUOUS', `Several members are named “${String(row.owner)}”. Use their e-mail address.`));
      else if (!m) errors.push(issue('owner', 'UNKNOWN_REFERENCE', `No active member matches “${String(row.owner)}”.`));
      else ownerId = m.id;
    }
    const fields: Partial<ProjectImportRow> = {};
    for (const k of OPTIONAL_FIELDS) if (row[k] !== null && row[k] !== undefined) (fields as Record<string, unknown>)[k] = row[k];
    if (typeof fields.language === 'string' && fields.language.length > 20) errors.push(issue('language', 'LENGTH', 'Language must be at most 20 characters.'));
    if ((fields.tags?.length ?? 0) > 30) errors.push(issue('tags', 'TOO_MANY', 'Use at most 30 tags.'));
    for (const t of fields.tags ?? []) if (t.length < 2 || t.length > 40) errors.push(issue('tags', 'LENGTH', `Tag “${t}” must be 2–40 characters.`));

    if (target) {
      const base = { targetId: target.id, targetRowVersion: target.rowVersion, dedupeKey };
      if (opts.duplicatePolicy === 'error' && !errors.length)
        errors.push(issue(row.id ? 'id' : 'name', 'DUPLICATE', `The project “${target.name}” already exists. Choose Skip or Revise Existing to handle existing projects.`));
      if (opts.duplicatePolicy === 'skip' || errors.length)
        return { action: 'skip', normalized: { name }, errors, warnings: errors.length ? warnings : [issue('name', 'EXISTS_SKIPPED', `“${target.name}” already exists and is skipped.`)], ...base };
      if (!allowed(ctx, 'projects.update', projectScope(target))) errors.push(issue('_row', 'NOT_PERMITTED', 'You do not have permission to change this project.'));
      if (target.status === 'archived') errors.push(issue('_row', 'ARCHIVED', 'Archived projects are read-only. Restore the project first.'));
      if (direction && direction.id !== target.directionId) errors.push(issue('direction', 'NOT_CHANGEABLE', 'Moving a project to another direction is not done by import; use Transfer Direction.'));
      const type = (row.type as ProjectRow['type'] | null) ?? target.type;
      if (type !== target.type) {
        if (await typeLocked(ctx, target)) errors.push(issue('type', 'LOCKED', 'The project type can no longer change: seasons or OFM operations exist.'));
        else warnings.push(issue('type', 'TYPE_CHANGE', `The type changes from ${target.type} to ${type}.`));
      }
      const ofm = fields.ofmEnabled ?? target.ofmEnabled;
      if (ofm && type === 'series') errors.push(issue('ofmEnabled', 'NOT_ALLOWED', 'OFM is available for Model and Influencer projects only.'));
      const patch: ProjectImportRow = { name, ...fields, ...(row.type ? { type } : {}), ...(ownerId ? { ownerMembershipId: ownerId } : {}) };
      return { action: 'update', normalized: patch, errors, warnings, ...base };
    }

    if (!row.type) errors.push(issue('type', 'REQUIRED', 'Type is required for new projects.'));
    if (!row.direction) errors.push(issue('direction', 'REQUIRED', 'Direction is required for new projects.'));
    if (!row.owner) errors.push(issue('owner', 'REQUIRED', 'Owner is required for new projects.'));
    if (direction && !allowed(ctx, 'projects.create', { directionId: direction.id })) errors.push(issue('direction', 'NOT_PERMITTED', 'You cannot create projects in this direction.'));
    if (fields.ofmEnabled && row.type === 'series') errors.push(issue('ofmEnabled', 'NOT_ALLOWED', 'OFM is available for Model and Influencer projects only.'));
    return {
      action: 'create',
      normalized: { name, type: row.type as ProjectRow['type'], directionId: direction?.id, ownerMembershipId: ownerId, ...fields },
      errors,
      warnings,
      dedupeKey,
    };
  },
  async apply(ctx, row, v) {
    if (v.action === 'create')
      return createProject(ctx, { ...row, name: row.name, type: row.type!, directionId: row.directionId!, ownerMembershipId: row.ownerMembershipId!, activate: false });
    const { name, ...rest } = row;
    return updateProject(ctx, v.targetId!, { name, ...rest });
  },
  async undo(ctx, entityId) {
    const p = await lockById(ctx, projects, entityId, 'Project');
    authorizeObject(ctx, 'projects.update', projectScope(p), 'projects.read');
    if (p.deletedAt) return;
    if (p.status !== 'draft') throw new AppError('INVALID_STATE', 'The project is no longer a draft.');
    if (p.rowVersion !== 1) throw new AppError('INVALID_STATE', 'The project was changed after the import.');
    const deps = await projectDependents(ctx, p);
    if (deps.length) throw new AppError('INVALID_STATE', `Records now depend on the project: ${deps.map((d) => `${d.count} ${d.label}`).join(', ')}.`);
    await trashProject(ctx, p, 'Import undone');
  },
});

// ——— Trash for draft projects (Archive / Trash screen) ———

/** Dependent records that make a draft project ineligible for trash/purge (history is never deleted). */
export const projectDependents = async (ctx: QueryContext | CommandContext, p: ProjectRow) => {
  const db = dbOf(ctx);
  const ws = p.workspaceId;
  const counts = async (label: string, q: Promise<{ n: number }[]>) => ({ label, count: Number((await q)[0]?.n ?? 0) });
  const list = [
    await counts('tasks', db.select({ n: count() }).from(tasks).where(and(eq(tasks.workspaceId, ws), eq(tasks.projectId, p.id)))),
    await counts('content items', db.select({ n: count() }).from(contentItems).where(and(eq(contentItems.workspaceId, ws), eq(contentItems.projectId, p.id)))),
    await counts('accounts', db.select({ n: count() }).from(socialAccounts).where(and(eq(socialAccounts.workspaceId, ws), eq(socialAccounts.projectId, p.id)))),
    await counts('characters', db.select({ n: count() }).from(characters).where(and(eq(characters.workspaceId, ws), eq(characters.projectId, p.id)))),
    await counts('seasons', db.select({ n: count() }).from(seasons).where(and(eq(seasons.workspaceId, ws), eq(seasons.projectId, p.id)))),
    await counts('publications', db.select({ n: count() }).from(publications).where(and(eq(publications.workspaceId, ws), eq(publications.projectId, p.id)))),
    await counts('shifts', db.select({ n: count() }).from(shifts).where(and(eq(shifts.workspaceId, ws), eq(shifts.projectId, p.id)))),
    await counts('OFM assignments', db.select({ n: count() }).from(ofmAssignments).where(and(eq(ofmAssignments.workspaceId, ws), eq(ofmAssignments.projectId, p.id)))),
    await counts('files', db.select({ n: count() }).from(assets).where(and(eq(assets.workspaceId, ws), eq(assets.projectId, p.id)))),
    await counts('milestones', db.select({ n: count() }).from(projectMilestones).where(and(eq(projectMilestones.workspaceId, ws), eq(projectMilestones.projectId, p.id)))),
    await counts('decisions', db.select({ n: count() }).from(projectDecisions).where(and(eq(projectDecisions.workspaceId, ws), eq(projectDecisions.projectId, p.id)))),
  ];
  return list.filter((d) => d.count > 0);
};

const trashDays = async (ctx: CommandContext) => {
  const [w] = await ctx.tx.select({ settings: workspaces.settings }).from(workspaces).where(eq(workspaces.id, ctx.actor.workspaceId));
  return w?.settings?.retention?.trashDays ?? 30;
};

const reindex = (ctx: CommandContext, p: ProjectRow, hidden: boolean) =>
  indexSearchDocument(ctx.tx, {
    workspaceId: ctx.actor.workspaceId,
    entityType: 'project',
    entityId: p.id,
    title: p.name,
    body: [p.briefSummary, p.description, p.audience, p.tags.join(' ')].filter(Boolean).join('\n'),
    projectId: p.id,
    directionId: p.directionId,
    permission: 'projects.read',
    ownerMembershipId: p.ownerMembershipId,
    archived: hidden || p.status === 'archived',
    status: p.status,
    thumbnailAssetId: p.coverAssetId,
    at: ctx.app.clock.now(),
  });

export const trashProject = async (ctx: CommandContext, p: ProjectRow, reason: string) => {
  const at = ctx.app.clock.now();
  const purgeAfter = new Date(at.getTime() + (await trashDays(ctx)) * 86_400_000);
  const [row] = await ctx.tx.update(projects).set({ deletedAt: at, deletedBy: ctx.actor.userId, purgeAfter, ...touch(ctx, projects) }).where(eq(projects.id, p.id)).returning();
  await audit(ctx, { action: 'project.trashed', entityType: 'project', entityId: p.id, projectId: p.id, reason, metadata: { purgeAfter: purgeAfter.toISOString() } });
  await emit(ctx, { type: 'project.trashed', entityType: 'project', entityId: p.id, revision: row!.rowVersion });
  await reindex(ctx, row!, true);
};

const draftEligibility = async (ctx: CommandContext | QueryContext, p: ProjectRow) => {
  if (p.status !== 'draft') return 'Only draft projects can be moved to the trash; archive other projects instead.';
  const deps = await projectDependents(ctx, p);
  return deps.length ? `Records depend on the project: ${deps.map((d) => `${d.count} ${d.label}`).join(', ')}.` : null;
};

extendArchiveHandler('project', {
  list: (ctx, input) =>
    tableArchiveList(ctx, input, {
      table: projects,
      title: projects.name,
      projectId: projects.id,
      scope: scopePredicate(ctx, 'projects.read', { projectId: projects.id, ownerMembership: projects.ownerMembershipId }),
      archivedWhere: eq(projects.status, 'archived'),
      thumbnail: projects.coverAssetId,
    }),
  trash: async (ctx, id, reason) => {
    const p = await lockById(ctx, projects, id, 'Project');
    authorizeObject(ctx, 'projects.archive', projectScope(p), 'projects.read');
    if (p.deletedAt) throw new AppError('INVALID_STATE', 'The project is already in the trash.');
    const why = await draftEligibility(ctx, p);
    if (why) throw new AppError('INVALID_STATE', why);
    await trashProject(ctx, p, reason);
  },
  untrashPreview: async (ctx, id) => {
    const [p] = await dbOf(ctx).select().from(projects).where(and(eq(projects.workspaceId, ctx.actor.workspaceId), eq(projects.id, id)));
    if (!p || !p.deletedAt) throw new AppError('NOT_FOUND', 'Project was not found in the trash.');
    authorizeObject(ctx, 'projects.archive', projectScope(p), 'projects.read');
    const [d] = await dbOf(ctx).select({ status: directions.status }).from(directions).where(eq(directions.id, p.directionId));
    const [o] = await dbOf(ctx).select({ status: memberships.status }).from(memberships).where(eq(memberships.id, p.ownerMembershipId));
    return {
      title: p.name,
      items: [
        ...(d?.status !== 'active' ? [{ kind: 'direction_archived', label: 'The project’s direction is archived', count: 1, blocking: true, resolution: 'Restore the direction or move the project after restoring.' }] : []),
        ...(o?.status !== 'active' ? [{ kind: 'owner_inactive', label: 'The project owner is no longer active', count: 1, blocking: false, resolution: 'Assign a new owner after restoring.' }] : []),
      ],
    };
  },
  untrash: async (ctx, id) => {
    const p = await lockById(ctx, projects, id, 'Project');
    authorizeObject(ctx, 'projects.archive', projectScope(p), 'projects.read');
    if (!p.deletedAt) throw new AppError('INVALID_STATE', 'The project is not in the trash.');
    const [d] = await ctx.tx.select({ status: directions.status }).from(directions).where(eq(directions.id, p.directionId));
    if (d?.status !== 'active') throw new AppError('INVALID_STATE', 'Restore the project’s direction first.');
    const [row] = await ctx.tx.update(projects).set({ deletedAt: null, deletedBy: null, purgeAfter: null, ...touch(ctx, projects) }).where(eq(projects.id, id)).returning();
    await audit(ctx, { action: 'project.restored_from_trash', entityType: 'project', entityId: id, projectId: id });
    await emit(ctx, { type: 'project.restored', entityType: 'project', entityId: id, revision: row!.rowVersion });
    await reindex(ctx, row!, false);
  },
  /** Permanent deletion of a trashed draft: owned ephemeral rows only; anything else blocks. */
  purge: async (ctx, id) => {
    const p = await lockById(ctx, projects, id, 'Project');
    if (!p.deletedAt || p.status !== 'draft') throw new AppError('INVALID_STATE', 'Only trashed draft projects can be permanently deleted.');
    await purgeProjectRows(ctx, p);
    await recordTombstone(ctx, { workspaceId: p.workspaceId, entityType: 'project', entityId: id, action: 'purge', details: { name: '[purged]' } });
  },
});

/** Delete a trashed draft project and its owned ephemeral rows; held references block. */
const purgeProjectRows = async (ctx: CommandContext, p: typeof projects.$inferSelect) => {
  const deps = await projectDependents(ctx, p);
  if (deps.length) throw new AppError('INVALID_STATE', `Held references prevent deletion: ${deps.map((d) => `${d.count} ${d.label}`).join(', ')}.`);
  await ctx.tx.delete(customFieldValues).where(and(eq(customFieldValues.workspaceId, p.workspaceId), eq(customFieldValues.entityType, 'project'), eq(customFieldValues.entityId, p.id)));
  await ctx.tx.delete(ofmProfiles).where(and(eq(ofmProfiles.workspaceId, p.workspaceId), eq(ofmProfiles.projectId, p.id)));
  await ctx.tx.delete(projectMemberships).where(and(eq(projectMemberships.workspaceId, p.workspaceId), eq(projectMemberships.projectId, p.id)));
  await ctx.tx.delete(projectDirectionHistory).where(and(eq(projectDirectionHistory.workspaceId, p.workspaceId), eq(projectDirectionHistory.projectId, p.id)));
  await ctx.tx.delete(projects).where(eq(projects.id, p.id));
  await removeSearchDocument(ctx.tx, p.workspaceId, 'project', p.id);
};

// Disaster restore to a point before the purge: delete the project again before access reopens.
defineTombstoneReplay('project', 'purge', async (ctx, t) => {
  const [p] = await ctx.tx.select().from(projects).where(eq(projects.id, t.entityId)).for('update');
  if (!p) return 'not_present';
  await purgeProjectRows(ctx, p);
  return 'applied';
});

// ——— Export dataset: projects ———

const currentBudgets = async (ctx: QueryContext, ids: string[]) => {
  if (!ids.length) return new Map<string, { amount: string; currency: string }>();
  const today = ctx.app.clock.now().toISOString().slice(0, 10);
  const rows = await ctx.app.db
    .select({ projectId: budgets.scopeId, currency: budgets.currency, planned: sql<string>`coalesce(sum(${budgetLines.plannedMinor}), 0)::text` })
    .from(budgets)
    .innerJoin(budgetVersions, eq(budgetVersions.id, budgets.approvedVersionId))
    .leftJoin(budgetLines, eq(budgetLines.budgetVersionId, budgetVersions.id))
    .where(and(eq(budgets.workspaceId, ctx.actor.workspaceId), eq(budgets.scopeType, 'project'), inArray(budgets.scopeId, ids), sql`${budgets.periodStart} <= ${today} AND ${budgets.periodEnd} >= ${today}`))
    .groupBy(budgets.scopeId, budgets.currency);
  return new Map(rows.filter((r) => r.projectId).map((r) => [r.projectId!, { amount: formatMinor(BigInt(r.planned), r.currency), currency: r.currency }]));
};

defineExportDataset({
  key: 'projects',
  label: 'Projects',
  permission: 'projects.read',
  classification: 'normal',
  columns: [
    { key: 'id', label: 'Project ID', type: 'id', default: true },
    { key: 'name', label: 'Name', type: 'text', default: true },
    { key: 'type', label: 'Type', type: 'text', default: true },
    { key: 'status', label: 'Status', type: 'text', default: true },
    { key: 'direction', label: 'Direction', type: 'text', default: true },
    { key: 'owner', label: 'Owner', type: 'text', default: true },
    { key: 'briefSummary', label: 'Brief Summary', type: 'text' },
    { key: 'language', label: 'Language', type: 'text' },
    { key: 'targetMarkets', label: 'Target Markets', type: 'text' },
    { key: 'tags', label: 'Tags', type: 'text', default: true },
    { key: 'ofmEnabled', label: 'OFM Enabled', type: 'boolean' },
    { key: 'startDate', label: 'Start Date', type: 'date' },
    { key: 'openTasks', label: 'Open Tasks', type: 'integer', default: true },
    { key: 'createdAt', label: 'Created At (UTC)', type: 'datetime' },
    { key: 'updatedAt', label: 'Updated At (UTC)', type: 'datetime', default: true },
    { key: 'archivedAt', label: 'Archived At (UTC)', type: 'datetime' },
    { key: 'budgetPlanned', label: 'Current Budget (Planned)', type: 'amount', permission: 'budgets.read' },
    { key: 'budgetCurrency', label: 'Budget Currency', type: 'currency', permission: 'budgets.read' },
  ],
  filters: [
    { key: 'status', label: 'Status', type: 'enum', enumValues: PROJECT_STATUSES },
    { key: 'type', label: 'Type', type: 'enum', enumValues: PROJECT_TYPES },
    { key: 'directionId', label: 'Direction', type: 'reference', lookup: 'direction' },
    { key: 'q', label: 'Name contains', type: 'text' },
  ],
  async *rows(ctx, input) {
    requirePermission(ctx, 'projects.read');
    const f = input.filters as { status?: string | string[]; type?: string | string[]; directionId?: string; q?: string };
    const list = (v?: string | string[]) => (Array.isArray(v) ? v : v ? v.split(',') : []).filter(Boolean);
    const statuses = list(f.status).filter((s) => (PROJECT_STATUSES as readonly string[]).includes(s)) as ProjectRow['status'][];
    const types = list(f.type).filter((s) => (PROJECT_TYPES as readonly string[]).includes(s)) as ProjectRow['type'][];
    const dirs = new Map((await ctx.app.db.select({ id: directions.id, name: directions.name }).from(directions).where(eq(directions.workspaceId, ctx.actor.workspaceId))).map((d) => [d.id, d.name]));
    let after: { at: Date; id: string } | null = null;
    for (;;) {
      const rows: ProjectRow[] = await ctx.app.db
        .select()
        .from(projects)
        .where(
          and(
            eq(projects.workspaceId, ctx.actor.workspaceId),
            isNull(projects.deletedAt),
            scopePredicate(ctx, 'projects.read', { projectId: projects.id, ownerMembership: projects.ownerMembershipId }),
            lte(projects.createdAt, input.boundAt),
            statuses.length ? inArray(projects.status, statuses) : undefined,
            types.length ? inArray(projects.type, types) : undefined,
            f.directionId && isUuid(f.directionId) ? eq(projects.directionId, f.directionId) : undefined,
            f.q ? ilike(projects.name, `%${f.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`) : undefined,
            after ? or(gt(projects.createdAt, after.at), and(eq(projects.createdAt, after.at), gt(projects.id, after.id))) : undefined,
          ),
        )
        .orderBy(asc(projects.createdAt), asc(projects.id))
        .limit(500);
      if (rows.length === 0) return;
      const ids = rows.map((r) => r.id);
      const refs = await loadMemberRefs(ctx.app.db, ctx.actor.workspaceId, rows.map((r) => r.ownerMembershipId));
      const open = new Map(
        (
          await ctx.app.db
            .select({ projectId: tasks.projectId, n: count() })
            .from(tasks)
            .where(and(eq(tasks.workspaceId, ctx.actor.workspaceId), inArray(tasks.projectId, ids), inArray(tasks.status, ['draft', 'backlog', 'ready', 'in_progress', 'in_review']), isNull(tasks.deletedAt)))
            .groupBy(tasks.projectId)
        ).map((t) => [t.projectId, Number(t.n)]),
      );
      const withBudget = input.fields.includes('budgetPlanned') || input.fields.includes('budgetCurrency');
      const budgetMap = withBudget ? await currentBudgets(ctx, ids.filter((id, i) => can(ctx.actor.access, 'budgets.read', projectScope(rows[i]!)))) : new Map();
      for (const p of rows) {
        // Budget values only where the requester holds budgets.read on this project.
        const b = can(ctx.actor.access, 'budgets.read', projectScope(p)) ? budgetMap.get(p.id) : undefined;
        yield {
          id: p.id,
          name: p.name,
          type: p.type,
          status: p.status,
          direction: dirs.get(p.directionId) ?? null,
          owner: refs.get(p.ownerMembershipId)?.displayName ?? null,
          briefSummary: p.briefSummary,
          language: p.language,
          targetMarkets: p.targetMarkets.join(', ') || null,
          tags: p.tags.join(', ') || null,
          ofmEnabled: p.ofmEnabled,
          startDate: p.startDate,
          openTasks: open.get(p.id) ?? 0,
          createdAt: p.createdAt.toISOString(),
          updatedAt: p.updatedAt.toISOString(),
          archivedAt: p.archivedAt?.toISOString() ?? null,
          budgetPlanned: b?.amount ?? null,
          budgetCurrency: b?.currency ?? null,
        };
      }
      const last = rows[rows.length - 1]!;
      after = { at: last.createdAt, id: last.id };
      if (rows.length < 500) return;
    }
  },
});
