import { and, eq, isNull, sql } from 'drizzle-orm';
import { directions, memberships, roles, workspaces } from '@castlane/database';
import { AppError, isSupportedCurrency, isValidTimeZone, newId, normalizeKey } from '@castlane/domain';
import { requirePermission } from '../core/access';
import { audit } from '../core/audit';
import type { CommandContext, QueryContext } from '../core/context';
import { emit } from '../core/events';
import { stamp } from '../core/rows';
import { inviteMember, type InviteOutcome } from './invitations';

const requireOwner = (ctx: QueryContext) => {
  if (!ctx.actor.access.isOwner) throw new AppError('FORBIDDEN', 'Only the workspace Owner can run the workspace setup.');
};

export const getSetupProgress = async (ctx: QueryContext) => {
  requireOwner(ctx);
  const db = ctx.app.db;
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, ctx.actor.workspaceId));
  if (!ws) throw new AppError('NOT_FOUND', 'Workspace was not found.');
  const dirs = await db
    .select()
    .from(directions)
    .where(and(eq(directions.workspaceId, ws.id), eq(directions.status, 'active')))
    .orderBy(directions.sortOrder, directions.createdAt);
  const roleRows = await db.select().from(roles).where(and(eq(roles.workspaceId, ws.id), isNull(roles.archivedAt))).orderBy(roles.createdAt);
  const members = await db
    .select({ id: memberships.id, displayName: memberships.displayNameSnapshot })
    .from(memberships)
    .where(and(eq(memberships.workspaceId, ws.id), eq(memberships.status, 'active')));
  return {
    step: ws.setupStep,
    workspace: {
      name: ws.name,
      timezone: ws.timezone,
      baseCurrency: ws.baseCurrency,
      weekStartsOn: ws.weekStartsOn,
      baseCurrencyLocked: !!ws.baseCurrencyLockedAt,
      rowVersion: ws.rowVersion,
    },
    directions: dirs.map((d) => ({ id: d.id, name: d.name, leadMembershipId: d.leadMembershipId, presetKind: d.presetKind })),
    roles: roleRows
      .filter((r) => !r.isProtected)
      .map((r) => ({ id: r.id, key: r.key, name: r.name, defaultScopeType: r.defaultScopeType, permissions: r.permissions })),
    members,
  };
};

const nextStep = (current: string, done: 'workspace' | 'directions' | 'team') => {
  const order = ['workspace', 'directions', 'team', 'completed'];
  const target = order[order.indexOf(done) + 1]!;
  return order.indexOf(current) > order.indexOf(target) ? current : target;
};

export const saveSetupWorkspace = async (
  ctx: CommandContext,
  input: { name: string; timezone: string; baseCurrency: string; weekStartsOn: 'monday' | 'sunday' },
) => {
  requireOwner(ctx);
  if (!isValidTimeZone(input.timezone)) throw new AppError('VALIDATION_FAILED', 'Choose a valid time zone.');
  if (!isSupportedCurrency(input.baseCurrency)) throw new AppError('VALIDATION_FAILED', 'Choose a supported currency.');
  const [ws] = await ctx.tx.select().from(workspaces).where(eq(workspaces.id, ctx.actor.workspaceId)).for('update');
  if (!ws) throw new AppError('NOT_FOUND', 'Workspace was not found.');
  if (ws.baseCurrencyLockedAt && ws.baseCurrency !== input.baseCurrency)
    throw new AppError('INVALID_STATE', 'The base currency is locked after the first posted financial entry.');
  const step = nextStep(ws.setupStep, 'workspace') as typeof ws.setupStep;
  await ctx.tx
    .update(workspaces)
    .set({
      name: input.name.trim(),
      timezone: input.timezone,
      baseCurrency: input.baseCurrency,
      weekStartsOn: input.weekStartsOn,
      setupStep: step,
      updatedAt: ctx.app.clock.now(),
      updatedBy: ctx.actor.userId,
      rowVersion: sql`${workspaces.rowVersion} + 1`,
    })
    .where(eq(workspaces.id, ws.id));
  await audit(ctx, {
    action: 'workspace.setup_saved',
    entityType: 'workspace',
    entityId: ws.id,
    diff: {
      name: { from: ws.name, to: input.name.trim() },
      timezone: { from: ws.timezone, to: input.timezone },
      baseCurrency: { from: ws.baseCurrency, to: input.baseCurrency },
    },
  });
  return { step };
};

export const saveSetupDirections = async (
  ctx: CommandContext,
  input: { directions: { id?: string; name: string; leadMembershipId?: string | null; presetKind?: 'series' | 'model' | 'influencer' | null }[] },
) => {
  requireOwner(ctx);
  requirePermission(ctx, 'directions.manage');
  if (input.directions.length === 0) throw new AppError('VALIDATION_FAILED', 'Keep at least one direction.');
  const keys = input.directions.map((d) => normalizeKey(d.name));
  if (new Set(keys).size !== keys.length) throw new AppError('VALIDATION_FAILED', 'Direction names must be unique.');
  const existing = await ctx.tx.select().from(directions).where(eq(directions.workspaceId, ctx.actor.workspaceId)).for('update');
  const at = ctx.app.clock.now();
  let order = 0;
  const keptIds = new Set<string>();
  for (const d of input.directions) {
    const match = d.id ? existing.find((e) => e.id === d.id) : undefined;
    if (match) {
      keptIds.add(match.id);
      await ctx.tx
        .update(directions)
        .set({
          name: d.name.trim(),
          nameKey: normalizeKey(d.name),
          leadMembershipId: d.leadMembershipId ?? null,
          sortOrder: order++,
          updatedAt: at,
          updatedBy: ctx.actor.userId,
          rowVersion: sql`${directions.rowVersion} + 1`,
        })
        .where(eq(directions.id, match.id));
    } else {
      const id = newId();
      keptIds.add(id);
      await ctx.tx.insert(directions).values({
        ...stamp(ctx),
        id,
        name: d.name.trim(),
        nameKey: normalizeKey(d.name),
        leadMembershipId: d.leadMembershipId ?? null,
        sortOrder: order++,
        presetKind: d.presetKind ?? null,
      });
      await emit(ctx, { type: 'direction.created', entityType: 'direction', entityId: id });
    }
  }
  // Directions dropped during setup are archived (never deleted); setup has no projects yet.
  for (const e of existing) {
    if (!keptIds.has(e.id) && e.status === 'active') {
      await ctx.tx
        .update(directions)
        .set({ status: 'archived', archivedAt: at, archivedBy: ctx.actor.userId, archiveReason: 'Removed during setup', updatedAt: at })
        .where(eq(directions.id, e.id));
    }
  }
  const [ws] = await ctx.tx.select().from(workspaces).where(eq(workspaces.id, ctx.actor.workspaceId)).for('update');
  const step = nextStep(ws!.setupStep, 'directions') as 'workspace' | 'directions' | 'team' | 'completed';
  await ctx.tx.update(workspaces).set({ setupStep: step, updatedAt: at }).where(eq(workspaces.id, ctx.actor.workspaceId));
  await audit(ctx, { action: 'workspace.setup_directions', entityType: 'workspace', entityId: ctx.actor.workspaceId, metadata: { count: input.directions.length } });
  return { step };
};

export const inviteSetupTeam = async (
  ctx: CommandContext,
  input: { invitations: { email: string; roleId: string; scopeType: any; scopeId: string | null }[]; finish: boolean },
) => {
  requireOwner(ctx);
  const results: { email: string; outcome: InviteOutcome; invitationId: string | null }[] = [];
  for (const inv of input.invitations) {
    const r = await inviteMember(ctx, { email: inv.email, grants: [{ roleId: inv.roleId, scopeType: inv.scopeType, scopeId: inv.scopeId }] });
    results.push({ email: inv.email, ...r });
  }
  const [ws] = await ctx.tx.select().from(workspaces).where(eq(workspaces.id, ctx.actor.workspaceId)).for('update');
  let step = ws!.setupStep;
  if (input.finish) {
    step = 'completed';
    await ctx.tx
      .update(workspaces)
      .set({ setupStep: 'completed', setupCompletedAt: ctx.app.clock.now(), updatedAt: ctx.app.clock.now() })
      .where(eq(workspaces.id, ctx.actor.workspaceId));
    await audit(ctx, { action: 'workspace.setup_completed', entityType: 'workspace', entityId: ctx.actor.workspaceId });
  }
  return { step, results };
};
