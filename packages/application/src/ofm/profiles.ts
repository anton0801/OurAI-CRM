import { and, asc, count, eq, gte, ilike, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { listFilter } from '@castlane/authorization';
import { ofmAssignments, ofmProfiles, projects, shifts, socialAccounts } from '@castlane/database';
import { AppError, newId, notFound, versionConflict } from '@castlane/domain';
import { allowed, requirePermission } from '../core/access';
import { audit, diffFields } from '../core/audit';
import { all, dbOf, type CommandContext, type QueryContext } from '../core/context';
import { emit } from '../core/events';
import { likePattern } from '../core/lookup-registry';
import { loadMemberRefs, refOrUnknown } from '../core/members';
import { stamp } from '../core/rows';
import { assertActiveMember, resolveSettings, toAccountRef, workspaceInfo, type Ctx } from './common';

/**
 * OFM profiles: a model stays ONE project (R02); OFM is a profile on it. Profiles are created by the
 * projects module when OFM is enabled; this module reads them and edits supervisor/settings.
 */

/** Project ids where the actor holds a permission through project/direction or account grants. */
export const projectIdsFor = (ctx: Ctx, permission: string): { all: true } | { all: false; ids: Set<string> } => {
  const f = listFilter(ctx.actor.access, permission);
  if (f.kind === 'all') return { all: true };
  if (f.kind === 'none') return { all: false, ids: new Set() };
  const ids = new Set(f.projectIds);
  for (const a of f.accountIds) {
    const p = ctx.actor.access.accountProject.get(a);
    if (p) ids.add(p);
  }
  return { all: false, ids };
};

export const listOfmProfiles = async (ctx: QueryContext, input: { q?: string; projectId?: string; limit?: number }) => {
  requirePermission(ctx, 'ofm.overview.read');
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const visible = projectIdsFor(ctx, 'ofm.overview.read');
  if (!visible.all && visible.ids.size === 0) return [];
  const rows = await db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.workspaceId, ws),
        eq(projects.ofmEnabled, true),
        sql`${projects.type} <> 'series'`,
        isNull(projects.deletedAt),
        sql`${projects.status} <> 'archived'`,
        visible.all ? undefined : inArray(projects.id, [...visible.ids]),
        input.projectId ? eq(projects.id, input.projectId) : undefined,
        input.q ? ilike(projects.name, likePattern(input.q)) : undefined,
      ),
    )
    .orderBy(asc(projects.name))
    .limit(input.limit ?? 200);
  return profileRows(ctx, rows);
};

export const profileRows = async (ctx: Ctx, rows: (typeof projects.$inferSelect)[]) => {
  if (!rows.length) return [];
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const ids = rows.map((r) => r.id);
  const now = ctx.app.clock.now();
  const week = new Date(now.getTime() + 7 * 86_400_000);
  const [profiles, accounts, assignments, active, upcoming, wsInfo] = await all(ctx, [
    () => db.select().from(ofmProfiles).where(and(eq(ofmProfiles.workspaceId, ws), inArray(ofmProfiles.projectId, ids))),
    () =>
      db
        .select()
        .from(socialAccounts)
        .where(and(eq(socialAccounts.workspaceId, ws), inArray(socialAccounts.projectId, ids), isNull(socialAccounts.archivedAt), isNull(socialAccounts.deletedAt)))
        .orderBy(asc(socialAccounts.handle)),
    () =>
      db
        .select({ projectId: ofmAssignments.projectId, membershipId: ofmAssignments.membershipId })
        .from(ofmAssignments)
        .where(
          and(
            eq(ofmAssignments.workspaceId, ws),
            inArray(ofmAssignments.projectId, ids),
            isNull(ofmAssignments.endedAt),
            sql`${ofmAssignments.validFrom} <= ${now}`,
            or(isNull(ofmAssignments.validTo), sql`${ofmAssignments.validTo} > ${now}`),
          ),
        ),
    () =>
      db
        .select({ projectId: shifts.projectId, n: count() })
        .from(shifts)
        .where(and(eq(shifts.workspaceId, ws), inArray(shifts.projectId, ids), inArray(shifts.state, ['active', 'paused'])))
        .groupBy(shifts.projectId),
    () =>
      db
        .select({ projectId: shifts.projectId, n: count() })
        .from(shifts)
        .where(and(eq(shifts.workspaceId, ws), inArray(shifts.projectId, ids), eq(shifts.state, 'scheduled'), gte(shifts.scheduledStart, now), lt(shifts.scheduledStart, week)))
        .groupBy(shifts.projectId),
    () => workspaceInfo(db, ws),
  ] as const);
  const refs = await loadMemberRefs(db, ws, [...profiles.map((p) => p.supervisorMembershipId), ...assignments.map((a) => a.membershipId)]);
  return rows.map((p) => {
    const profile = profiles.find((x) => x.projectId === p.id) ?? null;
    const settings = resolveSettings(profile?.settings, wsInfo.settings.maxShiftAccounts);
    const managers = [...new Set(assignments.filter((a) => a.projectId === p.id).map((a) => a.membershipId))].map((id) => refOrUnknown(refs, id)!);
    const scope = { projectId: p.id };
    return {
      projectId: p.id,
      profileId: profile?.id ?? null,
      project: {
        id: p.id,
        name: p.name,
        type: p.type,
        status: p.status,
        coverUrl: p.coverAssetId ? `/api/v1/workspaces/${ws}/assets/${p.coverAssetId}/thumbnail?size=64` : null,
      },
      supervisor: refOrUnknown(refs, profile?.supervisorMembershipId),
      settings,
      accounts: accounts
        .filter((a) => a.projectId === p.id)
        .filter((a) => allowed(ctx, 'ofm.overview.read', { projectId: p.id, accountId: a.id }) || allowed(ctx, 'accounts.read', { projectId: p.id, accountId: a.id }))
        .map((a) => toAccountRef({ ...a })),
      managers,
      activeShifts: Number(active.find((x) => x.projectId === p.id)?.n ?? 0),
      scheduledNext7Days: Number(upcoming.find((x) => x.projectId === p.id)?.n ?? 0),
      disabled: !!profile?.disabledAt,
      rowVersion: profile?.rowVersion ?? 0,
      permissions: {
        update: allowed(ctx, 'ofm.assignments.manage', scope),
        manageAssignments: allowed(ctx, 'ofm.assignments.manage', scope),
        schedule: allowed(ctx, 'shifts.schedule', scope),
      },
    };
  });
};

export const updateOfmProfile = async (
  ctx: CommandContext,
  projectId: string,
  input: { supervisorMembershipId?: string | null; handoverRequired?: boolean; contactStageLabels?: Partial<Record<string, string>> },
) => {
  const [p] = await ctx.tx.select().from(projects).where(and(eq(projects.workspaceId, ctx.actor.workspaceId), eq(projects.id, projectId))).for('update');
  if (!p || p.deletedAt || !allowed(ctx, 'ofm.overview.read', { projectId })) throw notFound('Model');
  if (!p.ofmEnabled || p.type === 'series') throw new AppError('INVALID_STATE', 'OFM is not enabled for this project.');
  if (!allowed(ctx, 'ofm.assignments.manage', { projectId })) throw new AppError('FORBIDDEN', 'You cannot change OFM settings for this model.');
  if (input.supervisorMembershipId) await assertActiveMember(ctx, input.supervisorMembershipId, 'supervisorMembershipId');
  const [existing] = await ctx.tx.select().from(ofmProfiles).where(eq(ofmProfiles.projectId, projectId)).for('update');
  const expected = ctx.request.expectedVersion;
  if (expected === undefined) throw new AppError('PRECONDITION_REQUIRED', 'This change requires the version of the record you edited (If-Match).');
  if ((existing?.rowVersion ?? 0) !== expected) throw versionConflict(existing?.rowVersion ?? 0);
  const settings = {
    ...(existing?.settings ?? {}),
    ...(input.handoverRequired !== undefined ? { handoverRequired: input.handoverRequired } : {}),
    ...(input.contactStageLabels ? { contactStageLabels: { ...(existing?.settings.contactStageLabels ?? {}), ...input.contactStageLabels } } : {}),
  };
  const at = ctx.app.clock.now();
  let row: typeof ofmProfiles.$inferSelect;
  if (existing) {
    [row] = (await ctx.tx
      .update(ofmProfiles)
      .set({
        settings,
        ...(input.supervisorMembershipId !== undefined ? { supervisorMembershipId: input.supervisorMembershipId } : {}),
        rowVersion: sql`${ofmProfiles.rowVersion} + 1`,
        updatedAt: at,
        updatedBy: ctx.actor.userId,
      })
      .where(eq(ofmProfiles.id, existing.id))
      .returning()) as [typeof ofmProfiles.$inferSelect];
  } else {
    [row] = (await ctx.tx
      .insert(ofmProfiles)
      .values({ ...stamp(ctx), id: newId(), projectId, supervisorMembershipId: input.supervisorMembershipId ?? null, settings })
      .returning()) as [typeof ofmProfiles.$inferSelect];
  }
  await audit(ctx, {
    action: 'ofm_profile.updated',
    entityType: 'project',
    entityId: projectId,
    projectId,
    diff: diffFields(existing ?? null, row, ['supervisorMembershipId', 'settings']),
  });
  await emit(ctx, { type: 'ofm_profile.updated', entityType: 'project', entityId: projectId, revision: p.rowVersion });
  const [out] = await profileRows(ctx, [p]);
  return out!;
};
