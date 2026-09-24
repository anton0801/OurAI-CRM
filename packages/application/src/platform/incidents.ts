import { and, desc, eq, ilike, inArray, isNull, lt, or } from 'drizzle-orm';
import { can, type ObjectScope } from '@castlane/authorization';
import { assetLinks, assets, incidents, projects, socialAccounts } from '@castlane/database';
import { AppError, assertTransition, clampPageSize, decodeCursor, encodeCursor, newId, notFound, type TransitionTable } from '@castlane/domain';
import { allowed, authorizeObject, authorizeRead, requirePermission, scopePredicate } from '../core/access';
import { audit, diffFields } from '../core/audit';
import type { CommandContext, QueryContext } from '../core/context';
import { all, dbOf } from '../core/context';
import { emit } from '../core/events';
import { isActiveMember, loadMemberRefs, refOrUnknown } from '../core/members';
import { notify } from '../core/notify';
import { assertVersion, lockById, stamp, touch } from '../core/rows';
import { canReadAsset, linkAsset } from '../media/assets';
import { defineLinkAccess } from '../media/link-access';

type IncidentRow = typeof incidents.$inferSelect;

export const INCIDENT_TRANSITIONS: TransitionTable<IncidentRow['state']> = {
  open: ['investigating', 'resolved'],
  investigating: ['resolved', 'open'],
  resolved: ['open'],
};

/** Operational incidents follow the project/account scope; system incidents are for administrators. */
const perms = (kind: IncidentRow['kind']) => (kind === 'system' ? { read: 'system.jobs.read', write: 'system.jobs.retry' } : { read: 'incidents.read', write: 'incidents.write' });

export const incidentScope = (i: Pick<IncidentRow, 'id' | 'projectId' | 'accountId' | 'ownerMembershipId'>): ObjectScope => ({
  objectType: 'incident',
  objectId: i.id,
  projectId: i.projectId,
  accountId: i.accountId,
  ownerMembershipId: i.ownerMembershipId,
  assignedMembershipIds: [i.ownerMembershipId],
});

const toItems = async (ctx: QueryContext, rows: IncidentRow[]) => {
  const db = dbOf(ctx);
  const projectIds = [...new Set(rows.map((r) => r.projectId).filter((x): x is string => !!x))];
  const accountIds = [...new Set(rows.map((r) => r.accountId).filter((x): x is string => !!x))];
  // Sequential inside a transaction, parallel on the pool (one connection never runs overlapping queries).
  const [ps, as, links, refs] = await all(ctx, [
    () => (projectIds.length ? db.select({ id: projects.id, name: projects.name }).from(projects).where(inArray(projects.id, projectIds)) : Promise.resolve([])),
    () =>
      accountIds.length
        ? db.select({ id: socialAccounts.id, handle: socialAccounts.handle, name: socialAccounts.displayName, platform: socialAccounts.platform }).from(socialAccounts).where(inArray(socialAccounts.id, accountIds))
        : Promise.resolve([]),
    () =>
      rows.length
        ? db
            .select({ entityId: assetLinks.entityId, assetId: assetLinks.assetId })
            .from(assetLinks)
            .where(and(eq(assetLinks.workspaceId, ctx.actor.workspaceId), eq(assetLinks.entityType, 'incident'), inArray(assetLinks.entityId, rows.map((r) => r.id)), isNull(assetLinks.removedAt)))
        : Promise.resolve([]),
    () => loadMemberRefs(db, ctx.actor.workspaceId, rows.flatMap((r) => [r.ownerMembershipId])),
  ] as const);
  const evidenceIds = [...new Set([...rows.flatMap((r) => r.evidenceAssetIds), ...links.map((l) => l.assetId)])];
  const assetRows = evidenceIds.length ? await db.select().from(assets).where(and(eq(assets.workspaceId, ctx.actor.workspaceId), inArray(assets.id, evidenceIds))) : [];
  const readable = new Map<string, (typeof assetRows)[number]>();
  for (const a of assetRows) if (!a.deletedAt && (await canReadAsset(ctx, a))) readable.set(a.id, a);
  const pm = new Map(ps.map((p) => [p.id, p.name]));
  const am = new Map(as.map((a) => [a.id, a.handle ? `@${a.handle}` : (a.name ?? a.platform)]));
  return rows.map((r) => {
    const ids = [...new Set([...r.evidenceAssetIds, ...links.filter((l) => l.entityId === r.id).map((l) => l.assetId)])];
    const visible = ids.filter((id) => readable.has(id));
    const scope = incidentScope(r);
    return {
      id: r.id,
      kind: r.kind,
      severity: r.severity,
      title: r.title,
      description: r.description,
      state: r.state,
      project: r.projectId && can(ctx.actor.access, 'projects.read', { projectId: r.projectId }) ? { id: r.projectId, name: pm.get(r.projectId) ?? 'Project' } : null,
      account: r.accountId && can(ctx.actor.access, 'accounts.read', { accountId: r.accountId }) ? { id: r.accountId, label: am.get(r.accountId) ?? 'Account' } : null,
      owner: refOrUnknown(refs, r.ownerMembershipId),
      resolution: r.resolution,
      resolvedAt: r.resolvedAt?.toISOString() ?? null,
      acknowledgedAt: r.acknowledgedAt?.toISOString() ?? null,
      alertKey: r.alertKey,
      jobId: r.jobId,
      evidence: visible.map((id) => {
        const a = readable.get(id)!;
        return { assetId: id, name: a.name, thumbnailUrl: a.currentVersionId && a.sensitivity !== 'restricted' && a.kind === 'image' ? `/api/v1/workspaces/${ctx.actor.workspaceId}/assets/${id}/thumbnail?size=128` : null };
      }),
      hiddenEvidenceCount: ids.length - visible.length,
      createdAt: r.createdAt.toISOString(),
      createdBy: r.createdBy ? 'Member' : 'System monitor',
      updatedAt: r.updatedAt.toISOString(),
      rowVersion: r.rowVersion,
      permissions: { update: allowed(ctx, perms(r.kind).write, scope) },
    };
  });
};

export const listIncidents = async (
  ctx: QueryContext,
  input: { cursor?: string; pageSize?: number; kind: IncidentRow['kind']; state?: IncidentRow['state'][]; severity?: IncidentRow['severity'][]; projectId?: string; ownerMembershipId?: string; q?: string },
) => {
  const p = perms(input.kind);
  requirePermission(ctx, p.read);
  const size = clampPageSize(input.pageSize);
  const c = input.cursor ? decodeCursor(input.cursor) : null;
  const rows = await ctx.app.db
    .select()
    .from(incidents)
    .where(
      and(
        eq(incidents.workspaceId, ctx.actor.workspaceId),
        eq(incidents.kind, input.kind),
        input.kind === 'operational'
          ? scopePredicate(ctx, p.read, { projectId: incidents.projectId, accountId: incidents.accountId, assigned: [incidents.ownerMembershipId], ownerMembership: incidents.ownerMembershipId })
          : undefined,
        input.state?.length ? inArray(incidents.state, input.state) : undefined,
        input.severity?.length ? inArray(incidents.severity, input.severity) : undefined,
        input.projectId ? eq(incidents.projectId, input.projectId) : undefined,
        input.ownerMembershipId ? eq(incidents.ownerMembershipId, input.ownerMembershipId) : undefined,
        input.q ? ilike(incidents.title, `%${input.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`) : undefined,
        c ? or(lt(incidents.createdAt, new Date(String(c.v[0]))), and(eq(incidents.createdAt, new Date(String(c.v[0]))), lt(incidents.id, c.id))) : undefined,
      ),
    )
    .orderBy(desc(incidents.createdAt), desc(incidents.id))
    .limit(size + 1);
  const hasMore = rows.length > size;
  const page = hasMore ? rows.slice(0, size) : rows;
  const last = page[page.length - 1];
  return { items: await toItems(ctx, page), hasMore, nextCursor: hasMore && last ? encodeCursor({ v: [last.createdAt.toISOString()], id: last.id }) : null };
};

export const getIncident = async (ctx: QueryContext | CommandContext, id: string) => {
  const [r] = await dbOf(ctx).select().from(incidents).where(and(eq(incidents.workspaceId, ctx.actor.workspaceId), eq(incidents.id, id)));
  if (!r) throw notFound('Incident');
  authorizeRead(ctx, perms(r.kind).read, incidentScope(r));
  return (await toItems(ctx, [r]))[0]!;
};

const resolveTarget = async (ctx: CommandContext, input: { projectId?: string | null; accountId?: string | null }) => {
  let projectId = input.projectId ?? null;
  if (input.accountId) {
    const [a] = await ctx.tx.select({ projectId: socialAccounts.projectId }).from(socialAccounts).where(and(eq(socialAccounts.workspaceId, ctx.actor.workspaceId), eq(socialAccounts.id, input.accountId)));
    if (!a || !allowed(ctx, 'accounts.read', { accountId: input.accountId, projectId: a.projectId })) throw notFound('Account');
    if (projectId && projectId !== a.projectId) throw new AppError('VALIDATION_FAILED', 'The account belongs to another project.', { fieldErrors: [{ field: 'accountId', code: 'MISMATCH', message: 'The account belongs to another project.' }] });
    projectId = a.projectId;
  }
  if (projectId) {
    const [p] = await ctx.tx.select({ id: projects.id }).from(projects).where(and(eq(projects.workspaceId, ctx.actor.workspaceId), eq(projects.id, projectId)));
    if (!p || !allowed(ctx, 'projects.read', { projectId })) throw notFound('Project');
  }
  return { projectId, accountId: input.accountId ?? null };
};

const assertOwner = async (ctx: CommandContext, membershipId: string | null | undefined) => {
  if (membershipId && !(await isActiveMember(ctx.tx, ctx.actor.workspaceId, membershipId)))
    throw new AppError('VALIDATION_FAILED', 'Choose an active member as owner.', { fieldErrors: [{ field: 'ownerMembershipId', code: 'INACTIVE', message: 'Choose an active member as owner.' }] });
};

const attachEvidence = async (ctx: CommandContext, incidentId: string, assetIds: string[] | undefined) => {
  for (const assetId of [...new Set(assetIds ?? [])]) await linkAsset(ctx, assetId, { target: { entityType: 'incident', entityId: incidentId, role: 'evidence' } });
};

const notifyOwner = async (ctx: CommandContext, r: IncidentRow) => {
  if (!r.ownerMembershipId) return;
  await notify(ctx.tx, {
    workspaceId: ctx.actor.workspaceId,
    recipientMembershipIds: [r.ownerMembershipId],
    eventType: 'incident.assigned',
    eventKey: `incident.assigned:${r.id}:${r.ownerMembershipId}:${r.rowVersion}`,
    kind: 'assignment',
    title: `Incident assigned to you: ${r.title}`,
    excerpt: r.description?.slice(0, 200) ?? null,
    entityType: 'incident',
    entityId: r.id,
    projectId: r.projectId,
    actorMembershipId: ctx.actor.membershipId,
    at: ctx.app.clock.now(),
  });
};

/** Log Incident. User-created incidents never change the technical health of the server. */
export const createIncident = async (
  ctx: CommandContext,
  input: { kind: IncidentRow['kind']; title: string; description?: string | null; severity: IncidentRow['severity']; projectId?: string | null; accountId?: string | null; ownerMembershipId?: string | null; evidenceAssetIds?: string[] },
) => {
  const p = perms(input.kind);
  requirePermission(ctx, p.write);
  const target = input.kind === 'operational' ? await resolveTarget(ctx, input) : { projectId: null, accountId: null };
  const id = newId();
  if (!allowed(ctx, p.write, { ...incidentScope({ id, projectId: target.projectId, accountId: target.accountId, ownerMembershipId: null }) }))
    throw new AppError('FORBIDDEN', 'You cannot log incidents here.');
  await assertOwner(ctx, input.ownerMembershipId);
  const [row] = await ctx.tx
    .insert(incidents)
    .values({
      ...stamp(ctx),
      id,
      kind: input.kind,
      severity: input.severity,
      title: input.title.trim(),
      description: input.description?.trim() || null,
      projectId: target.projectId,
      accountId: target.accountId,
      ownerMembershipId: input.ownerMembershipId ?? null,
      state: 'open',
    })
    .returning();
  await attachEvidence(ctx, id, input.evidenceAssetIds);
  await audit(ctx, { action: 'incident.created', entityType: 'incident', entityId: id, projectId: target.projectId, diff: diffFields(null, row!, ['kind', 'severity', 'title', 'ownerMembershipId', 'projectId', 'accountId']) });
  await emit(ctx, { type: 'incident.created', entityType: 'incident', entityId: id, revision: 1, payload: { kind: input.kind, severity: input.severity } });
  await notifyOwner(ctx, row!);
  return id;
};

const lockForWrite = async (ctx: CommandContext, id: string) => {
  const r = await lockById(ctx, incidents, id, 'Incident');
  const p = perms(r.kind);
  authorizeObject(ctx, p.write, incidentScope(r), p.read);
  assertVersion(ctx, r);
  return r;
};

export const updateIncident = async (ctx: CommandContext, id: string, input: { title?: string; description?: string | null; severity?: IncidentRow['severity']; evidenceAssetIds?: string[] }) => {
  const r = await lockForWrite(ctx, id);
  if (r.state === 'resolved') throw new AppError('INVALID_STATE', 'Reopen the incident to change it.');
  const patch: Partial<IncidentRow> = {};
  if (input.title !== undefined) patch.title = input.title.trim();
  if (input.description !== undefined) patch.description = input.description?.trim() || null;
  if (input.severity !== undefined) patch.severity = input.severity;
  const [row] = await ctx.tx.update(incidents).set({ ...patch, ...touch(ctx, incidents) }).where(eq(incidents.id, id)).returning();
  await attachEvidence(ctx, id, input.evidenceAssetIds);
  await audit(ctx, { action: 'incident.updated', entityType: 'incident', entityId: id, projectId: r.projectId, diff: diffFields(r, row!, ['title', 'description', 'severity']) });
  await emit(ctx, { type: 'incident.updated', entityType: 'incident', entityId: id, revision: row!.rowVersion });
  return id;
};

const transition = async (ctx: CommandContext, id: string, to: IncidentRow['state'], patch: Partial<IncidentRow>, action: string, reason?: string) => {
  const r = await lockForWrite(ctx, id);
  assertTransition(INCIDENT_TRANSITIONS, r.state, to, 'incident');
  const [row] = await ctx.tx.update(incidents).set({ ...patch, state: to, ...touch(ctx, incidents) }).where(eq(incidents.id, id)).returning();
  await audit(ctx, { action, entityType: 'incident', entityId: id, projectId: r.projectId, reason: reason ?? null, diff: { state: { from: r.state, to } } });
  await emit(ctx, { type: action, entityType: 'incident', entityId: id, revision: row!.rowVersion, payload: { from: r.state, to } });
  return row!;
};

export const acknowledgeIncident = async (ctx: CommandContext, id: string) => {
  await transition(ctx, id, 'investigating', { acknowledgedAt: ctx.app.clock.now() }, 'incident.acknowledged');
  return id;
};

export const assignIncident = async (ctx: CommandContext, id: string, ownerMembershipId: string | null) => {
  const r = await lockForWrite(ctx, id);
  if (r.state === 'resolved') throw new AppError('INVALID_STATE', 'Reopen the incident to reassign it.');
  await assertOwner(ctx, ownerMembershipId);
  const [row] = await ctx.tx.update(incidents).set({ ownerMembershipId, ...touch(ctx, incidents) }).where(eq(incidents.id, id)).returning();
  await audit(ctx, { action: 'incident.assigned', entityType: 'incident', entityId: id, projectId: r.projectId, diff: { ownerMembershipId: { from: r.ownerMembershipId, to: ownerMembershipId } } });
  await emit(ctx, { type: 'incident.assigned', entityType: 'incident', entityId: id, revision: row!.rowVersion });
  await notifyOwner(ctx, row!);
  return id;
};

export const resolveIncident = async (ctx: CommandContext, id: string, input: { resolution: string; evidenceAssetIds?: string[] }) => {
  await transition(ctx, id, 'resolved', { resolution: input.resolution.trim(), resolvedAt: ctx.app.clock.now() }, 'incident.resolved');
  await attachEvidence(ctx, id, input.evidenceAssetIds);
  return id;
};

export const reopenIncident = async (ctx: CommandContext, id: string, reason: string) => {
  await transition(ctx, id, 'open', { resolvedAt: null }, 'incident.reopened', reason);
  return id;
};

// Evidence files attached to an incident are visible to members who can read the incident.
defineLinkAccess('incident', {
  permission: 'incidents.read',
  scope: async (ctx, id) => {
    const [r] = await dbOf(ctx).select().from(incidents).where(and(eq(incidents.workspaceId, ctx.actor.workspaceId), eq(incidents.id, id)));
    if (!r) return null;
    // System incidents: only administrators (system.jobs.read) may see their evidence.
    if (r.kind === 'system' && !can(ctx.actor.access, 'system.jobs.read')) return null;
    return { ...incidentScope(r), label: r.title, href: `/w/${r.workspaceId}/operations/health?open=${r.id}` };
  },
});
