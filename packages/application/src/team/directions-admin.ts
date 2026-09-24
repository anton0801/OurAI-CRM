import { and, asc, count, eq, gt, inArray, isNull, ne, or } from 'drizzle-orm';
import { can, hasAnywhere } from '@castlane/authorization';
import { directions, memberships, projects, roleAssignments, roles } from '@castlane/database';
import { AppError, LIMITS, normalizeKey, notFound } from '@castlane/domain';
import { allowed, loadAccessSnapshot, requirePermission, requireRecentAuth, scopePredicate, whereAll } from '../core/access';
import { defineArchiveHandler } from '../core/archive-registry';
import { audit } from '../core/audit';
import { dbOf, type CommandContext, type QueryContext } from '../core/context';
import { emit } from '../core/events';
import { isActiveMember, loadMemberRefs, refOrUnknown } from '../core/members';
import { notify } from '../core/notify';
import { lockById, touch } from '../core/rows';
import { indexSearchDocument } from '../core/search';
import { archiveDirection, listDirections } from '../organization/directions';
import { insertGrant } from './access';
import { canManageRole } from './grant-rules';
import { assertNotSelf, bumpAccessRevision } from './scope';

type DirectionDb = typeof directions.$inferSelect;

const ACTIVE_PROJECT_STATUSES = ['draft', 'active', 'paused'] as const;

const leadRole = async (ctx: QueryContext | CommandContext) => {
  const [r] = await dbOf(ctx)
    .select()
    .from(roles)
    .where(and(eq(roles.workspaceId, ctx.actor.workspaceId), eq(roles.key, 'direction_lead'), isNull(roles.archivedAt)));
  return r ?? null;
};

/** Active Direction Lead grants of a member for this direction. */
const leadGrants = async (ctx: QueryContext | CommandContext, membershipId: string, directionId: string) => {
  const at = ctx.app.clock.now();
  return dbOf(ctx)
    .select({ ra: roleAssignments, role: roles })
    .from(roleAssignments)
    .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
    .where(
      and(
        eq(roleAssignments.workspaceId, ctx.actor.workspaceId),
        eq(roleAssignments.membershipId, membershipId),
        eq(roles.key, 'direction_lead'),
        eq(roleAssignments.scopeType, 'direction'),
        eq(roleAssignments.scopeId, directionId),
        isNull(roleAssignments.revokedAt),
        or(isNull(roleAssignments.validTo), gt(roleAssignments.validTo, at)),
      ),
    );
};

const loadDirection = async (ctx: QueryContext | CommandContext, id: string): Promise<DirectionDb> => {
  const [d] = await dbOf(ctx)
    .select()
    .from(directions)
    .where(and(eq(directions.workspaceId, ctx.actor.workspaceId), eq(directions.id, id)));
  if (!d || !allowed(ctx, 'directions.read', { directionId: d.id })) throw notFound('Direction');
  return d;
};

export const getDirectionDetail = async (ctx: QueryContext | CommandContext, id: string) => {
  requirePermission(ctx, 'directions.read');
  const d = await loadDirection(ctx, id);
  const row = (await listDirections(ctx, { includeArchived: true })).find((x) => x.id === d.id);
  if (!row) throw notFound('Direction');
  const db = dbOf(ctx);
  const projectRows = await db
    .select()
    .from(projects)
    .where(
      whereAll(
        eq(projects.workspaceId, ctx.actor.workspaceId),
        eq(projects.directionId, d.id),
        isNull(projects.deletedAt),
        scopePredicate(ctx, 'projects.read', { projectId: projects.id, ownerMembership: projects.ownerMembershipId }),
      ),
    )
    .orderBy(asc(projects.name))
    .limit(200);
  const refs = await loadMemberRefs(db, ctx.actor.workspaceId, projectRows.map((p) => p.ownerMembershipId));
  const leadHasRole = d.leadMembershipId ? (await leadGrants(ctx, d.leadMembershipId, d.id)).length > 0 : false;
  return {
    ...row,
    presetKind: d.presetKind,
    sortOrder: d.sortOrder,
    archivedAt: d.archivedAt?.toISOString() ?? null,
    archiveReason: d.archiveReason,
    projects: projectRows.map((p) => ({ id: p.id, name: p.name, status: p.status, type: p.type, owner: refOrUnknown(refs, p.ownerMembershipId)! })),
    leadHasDirectionRole: leadHasRole,
    permissions: { manage: hasAnywhere(ctx.actor.access, 'directions.manage'), manageAccess: hasAnywhere(ctx.actor.access, 'access.manage') },
  };
};

/** S12: the access consequences of a lead change, shown before it is applied. */
export const directionLeadImpact = async (ctx: QueryContext, id: string, input: { leadMembershipId: string | null }) => {
  requirePermission(ctx, 'directions.manage');
  const d = await loadDirection(ctx, id);
  const db = ctx.app.db;
  const at = ctx.app.clock.now();
  const refs = await loadMemberRefs(db, ctx.actor.workspaceId, [d.leadMembershipId, input.leadMembershipId]);
  const role = await leadRole(ctx);
  const canManageAccess = hasAnywhere(ctx.actor.access, 'access.manage') && !!role && canManageRole(ctx.actor.access, role);
  const dirProjects = await db
    .select({ id: projects.id, status: projects.status, owner: projects.ownerMembershipId })
    .from(projects)
    .where(and(eq(projects.workspaceId, ctx.actor.workspaceId), eq(projects.directionId, d.id), isNull(projects.deletedAt), ne(projects.status, 'archived')));
  const notes: string[] = ['Changing the lead does not change permissions by itself.'];
  let proposedAccess = null;
  if (input.leadMembershipId) {
    const [m] = await db
      .select()
      .from(memberships)
      .where(and(eq(memberships.workspaceId, ctx.actor.workspaceId), eq(memberships.id, input.leadMembershipId)));
    if (!m || m.status !== 'active')
      throw new AppError('VALIDATION_FAILED', 'The lead must be an active member.', { fieldErrors: [{ field: 'leadMembershipId', code: 'INACTIVE', message: 'The lead must be an active member.' }] });
    const snap = await loadAccessSnapshot(db, ctx.actor.workspaceId, m.userId, at);
    const readable = snap
      ? dirProjects.filter((p) => can(snap, 'projects.read', { objectType: 'project', objectId: p.id, projectId: p.id, directionId: d.id, ownerMembershipId: p.owner })).length
      : 0;
    const hasRole = (await leadGrants(ctx, m.id, d.id)).length > 0;
    proposedAccess = {
      hasDirectionLeadRole: hasRole,
      readableProjects: readable,
      roleWouldBeGranted: !hasRole && role ? { roleId: role.id, roleName: role.name, permissions: role.permissions.length } : null,
      canGrant: canManageAccess && m.id !== ctx.actor.membershipId,
    };
    if (!hasRole)
      notes.push(`${refs.get(m.id)?.displayName ?? 'The new lead'} can currently read ${readable} of ${dirProjects.length} projects in this direction. Grant the Direction Lead role for this direction to give them access to its projects, team assignments and reviews.`);
  }
  let previousAccess = null;
  if (d.leadMembershipId && d.leadMembershipId !== input.leadMembershipId) {
    const g = await leadGrants(ctx, d.leadMembershipId, d.id);
    previousAccess = { grantId: g[0]?.ra.id ?? null, roleName: g[0]?.role.name ?? null, canRevoke: !!g[0] && canManageAccess && d.leadMembershipId !== ctx.actor.membershipId };
    if (g[0]) notes.push(`${refs.get(d.leadMembershipId)?.displayName ?? 'The previous lead'} keeps the Direction Lead role for this direction unless you revoke it.`);
  }
  return {
    direction: { id: d.id, name: d.name, status: d.status },
    current: refOrUnknown(refs, d.leadMembershipId),
    proposed: refOrUnknown(refs, input.leadMembershipId),
    projects: { total: dirProjects.length, active: dirProjects.filter((p) => (ACTIVE_PROJECT_STATUSES as readonly string[]).includes(p.status)).length },
    proposedAccess,
    previousAccess,
    notes,
  };
};

const indexDirection = (ctx: CommandContext, d: DirectionDb) =>
  indexSearchDocument(ctx.tx, {
    workspaceId: ctx.actor.workspaceId,
    entityType: 'direction',
    entityId: d.id,
    title: d.name,
    body: d.description ?? '',
    permission: 'directions.read',
    directionId: d.id,
    archived: d.status === 'archived',
    at: ctx.app.clock.now(),
  });

export const assignDirectionLead = async (
  ctx: CommandContext,
  id: string,
  input: { leadMembershipId: string | null; grantLeadRole: boolean; revokePreviousLeadRole: boolean },
) => {
  requirePermission(ctx, 'directions.manage');
  const d = await lockById(ctx, directions, id, 'Direction');
  if (!allowed(ctx, 'directions.read', { directionId: d.id })) throw notFound('Direction');
  if (ctx.request.expectedVersion === undefined) throw new AppError('PRECONDITION_REQUIRED', 'This change requires the version of the record you edited (If-Match).');
  if (ctx.request.expectedVersion !== d.rowVersion) throw new AppError('VERSION_CONFLICT', 'This record changed while you were editing it.', { currentVersion: d.rowVersion });
  if (d.status !== 'active') throw new AppError('INVALID_STATE', 'Restore the direction before assigning a lead.');
  if (input.leadMembershipId && !(await isActiveMember(ctx.tx, ctx.actor.workspaceId, input.leadMembershipId)))
    throw new AppError('VALIDATION_FAILED', 'The lead must be an active member.', { fieldErrors: [{ field: 'leadMembershipId', code: 'INACTIVE', message: 'The lead must be an active member.' }] });
  const previous = d.leadMembershipId;
  const accessChange = (input.grantLeadRole && !!input.leadMembershipId) || (input.revokePreviousLeadRole && !!previous && previous !== input.leadMembershipId);
  const role = accessChange ? await leadRole(ctx) : null;
  if (accessChange) {
    requirePermission(ctx, 'access.manage');
    requireRecentAuth(ctx);
    if (!role || !canManageRole(ctx.actor.access, role)) throw new AppError('FORBIDDEN', 'You cannot grant or revoke the Direction Lead role.');
  }
  const [row] = await ctx.tx.update(directions).set({ leadMembershipId: input.leadMembershipId, ...touch(ctx, directions) }).where(eq(directions.id, d.id)).returning();
  await audit(ctx, { action: 'direction.lead_changed', entityType: 'direction', entityId: d.id, diff: { leadMembershipId: { from: previous, to: input.leadMembershipId } } });
  const changed: string[] = [];
  if (input.grantLeadRole && input.leadMembershipId && role) {
    assertNotSelf(ctx, input.leadMembershipId);
    if ((await leadGrants(ctx, input.leadMembershipId, d.id)).length === 0) {
      const g = await insertGrant(ctx, { membershipId: input.leadMembershipId, role, scopeType: 'direction', scopeId: d.id, reason: `Lead of ${d.name}` });
      await audit(ctx, {
        action: 'member.role_granted',
        entityType: 'membership',
        entityId: input.leadMembershipId,
        sensitivity: 'security',
        diff: { roleGrant: { from: null, to: { role: role.key, scopeType: 'direction', scopeId: d.id } } },
        metadata: { roleAssignmentId: g.id, via: 'direction.assign_lead' },
      });
      changed.push(input.leadMembershipId);
    }
  }
  if (input.revokePreviousLeadRole && previous && previous !== input.leadMembershipId && role) {
    assertNotSelf(ctx, previous);
    const at = ctx.app.clock.now();
    for (const g of await leadGrants(ctx, previous, d.id)) {
      await ctx.tx.update(roleAssignments).set({ revokedAt: at, revokedBy: ctx.actor.userId, ...touch(ctx, roleAssignments) }).where(eq(roleAssignments.id, g.ra.id));
      await audit(ctx, {
        action: 'member.role_revoked',
        entityType: 'membership',
        entityId: previous,
        sensitivity: 'security',
        diff: { roleGrant: { from: { role: role.key, scopeType: 'direction', scopeId: d.id }, to: null } },
        metadata: { roleAssignmentId: g.ra.id, via: 'direction.assign_lead' },
      });
      changed.push(previous);
    }
  }
  await bumpAccessRevision(ctx, changed);
  for (const id2 of changed) await emit(ctx, { type: 'member.access_changed', entityType: 'membership', entityId: id2 });
  await emit(ctx, { type: 'direction.updated', entityType: 'direction', entityId: d.id, revision: row!.rowVersion });
  if (input.leadMembershipId && input.leadMembershipId !== previous)
    await notify(ctx.tx, {
      workspaceId: ctx.actor.workspaceId,
      recipientMembershipIds: [input.leadMembershipId],
      eventType: 'direction.lead_assigned',
      eventKey: `direction.lead_assigned:${d.id}:${input.leadMembershipId}:${row!.rowVersion}`,
      kind: 'assignment',
      title: `You now lead the ${d.name} direction`,
      entityType: 'direction',
      entityId: d.id,
      actorMembershipId: ctx.actor.membershipId,
      at: ctx.app.clock.now(),
    });
  return d.id;
};

/** Another active direction already uses this name (the unique index covers active directions only). */
const activeNameTaken = async (ctx: QueryContext | CommandContext, nameKey: string, exceptId: string) => {
  const [dup] = await dbOf(ctx)
    .select({ id: directions.id })
    .from(directions)
    .where(and(eq(directions.workspaceId, ctx.actor.workspaceId), eq(directions.nameKey, nameKey), eq(directions.status, 'active'), ne(directions.id, exceptId)));
  return !!dup;
};

/** First free “<name> (restored)”, “<name> (restored 2)”, … offered when a restore collides (T155). */
const restoredNameSuggestion = async (ctx: QueryContext | CommandContext, d: DirectionDb) => {
  for (let n = 1; n <= 50; n++) {
    const suffix = n === 1 ? ' (restored)' : ` (restored ${n})`;
    const candidate = `${d.name.slice(0, LIMITS.shortNameMax - suffix.length)}${suffix}`;
    if (!(await activeNameTaken(ctx, normalizeKey(candidate), d.id))) return candidate;
  }
  return null;
};

/**
 * Restore an archived direction. When an active direction now uses its name, the restore needs an
 * explicit new name (T155) — it is refused otherwise, never skipped or merged.
 */
const restoreCore = async (ctx: CommandContext, d: DirectionDb, opts: { name?: string } = {}) => {
  if (d.status !== 'archived') throw new AppError('INVALID_STATE', 'This direction is not archived.');
  const name = opts.name === undefined ? d.name : opts.name.trim();
  if (name.length < LIMITS.shortNameMin || name.length > LIMITS.shortNameMax)
    throw new AppError('VALIDATION_FAILED', 'Enter a name for the restored direction.', { fieldErrors: [{ field: 'name', code: 'LENGTH', message: `Use ${LIMITS.shortNameMin}–${LIMITS.shortNameMax} characters.` }] });
  if (await activeNameTaken(ctx, normalizeKey(name), d.id)) {
    const message =
      opts.name === undefined
        ? 'An active direction with the same name exists. Restore it with a new name from Archive / Trash, or rename the active direction first.'
        : 'An active direction already uses this name. Choose another name.';
    throw new AppError('DUPLICATE', message, { fieldErrors: [{ field: 'name', code: 'DUPLICATE', message }] });
  }
  const [row] = await ctx.tx
    .update(directions)
    .set({ status: 'active', name, nameKey: normalizeKey(name), archivedAt: null, archivedBy: null, archiveReason: null, ...touch(ctx, directions) })
    .where(eq(directions.id, d.id))
    .returning();
  await audit(ctx, { action: 'direction.restored', entityType: 'direction', entityId: d.id, diff: name !== d.name ? { name: { from: d.name, to: name } } : undefined });
  await emit(ctx, { type: 'direction.restored', entityType: 'direction', entityId: d.id, revision: row!.rowVersion });
  await indexDirection(ctx, row!);
};

export const restoreDirection = async (ctx: CommandContext, id: string) => {
  requirePermission(ctx, 'directions.manage');
  const d = await lockById(ctx, directions, id, 'Direction');
  if (ctx.request.expectedVersion === undefined) throw new AppError('PRECONDITION_REQUIRED', 'This change requires the version of the record you edited (If-Match).');
  if (ctx.request.expectedVersion !== d.rowVersion) throw new AppError('VERSION_CONFLICT', 'This record changed while you were editing it.', { currentVersion: d.rowVersion });
  await restoreCore(ctx, d);
  return d.id;
};

export const reorderDirections = async (ctx: CommandContext, input: { orderedIds: string[] }) => {
  requirePermission(ctx, 'directions.manage');
  const ids = [...new Set(input.orderedIds)];
  const rows = await ctx.tx
    .select()
    .from(directions)
    .where(and(eq(directions.workspaceId, ctx.actor.workspaceId), inArray(directions.id, ids)))
    .for('update');
  if (rows.length !== ids.length) throw new AppError('VALIDATION_FAILED', 'Some directions do not exist.');
  const [activeCount] = await ctx.tx.select({ n: count() }).from(directions).where(and(eq(directions.workspaceId, ctx.actor.workspaceId), eq(directions.status, 'active')));
  if (rows.some((r) => r.status !== 'active') || Number(activeCount?.n ?? 0) !== ids.length)
    throw new AppError('VALIDATION_FAILED', 'Send every active direction exactly once.');
  for (const [i, id] of ids.entries()) {
    const r = rows.find((x) => x.id === id)!;
    if (r.sortOrder === i) continue;
    await ctx.tx.update(directions).set({ sortOrder: i, ...touch(ctx, directions) }).where(eq(directions.id, id));
    await emit(ctx, { type: 'direction.updated', entityType: 'direction', entityId: id });
  }
  await audit(ctx, { action: 'direction.reordered', entityType: 'direction', metadata: { order: ids } });
  return { ok: true as const };
};

defineArchiveHandler({
  entityType: 'direction',
  label: 'Direction',
  async preview(ctx, id) {
    requirePermission(ctx, 'directions.manage');
    const d = await loadDirection(ctx, id);
    const [n] = await dbOf(ctx)
      .select({ n: count() })
      .from(projects)
      .where(and(eq(projects.workspaceId, ctx.actor.workspaceId), eq(projects.directionId, d.id), inArray(projects.status, ['draft', 'active', 'paused', 'completed'])));
    const active = Number(n?.n ?? 0);
    return {
      title: d.name,
      rowVersion: d.rowVersion,
      items: active ? [{ kind: 'projects', label: 'Projects that are not archived', count: active, blocking: true, resolution: 'Move the projects to another direction or archive them first.' }] : [],
    };
  },
  async archive(ctx, id, input) {
    const d = await lockById(ctx, directions, id, 'Direction');
    await archiveDirection({ ...ctx, request: { ...ctx.request, expectedVersion: ctx.request.expectedVersion ?? d.rowVersion } }, id, input.reason);
  },
  // A name taken by an active direction is a collision the restore must resolve explicitly (T155).
  async restorePreview(ctx, id) {
    requirePermission(ctx, 'directions.manage');
    const d = await loadDirection(ctx, id);
    if (d.status !== 'archived') throw new AppError('INVALID_STATE', 'This direction is not archived.');
    if (!(await activeNameTaken(ctx, d.nameKey, d.id))) return { title: d.name, items: [], collisions: [] };
    const suggestion = await restoredNameSuggestion(ctx, d);
    return {
      title: d.name,
      items: [],
      collisions: [
        {
          field: 'name',
          value: d.name,
          message: 'Another active direction uses this name. Choose a new name for the restored direction.',
          options: suggestion ? [{ value: suggestion, label: `Rename to “${suggestion}”` }] : [],
        },
      ],
    };
  },
  async restore(ctx, id, input) {
    requirePermission(ctx, 'directions.manage');
    const d = await lockById(ctx, directions, id, 'Direction');
    await restoreCore(ctx, d, { name: input.resolutions?.name });
  },
});
