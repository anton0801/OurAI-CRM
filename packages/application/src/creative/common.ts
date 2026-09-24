import { and, eq } from 'drizzle-orm';
import { can } from '@castlane/authorization';
import { memberships, projects } from '@castlane/database';
import { AppError, notFound } from '@castlane/domain';
import { allowed, authorizeObject, authorizeRead, loadAccessSnapshot } from '../core/access';
import { dbOf, type CommandContext, type QueryContext } from '../core/context';

export type ProjectRow = typeof projects.$inferSelect;

export const projectScopeOf = (p: Pick<ProjectRow, 'id' | 'directionId' | 'ownerMembershipId'>) => ({
  objectType: 'project',
  objectId: p.id,
  projectId: p.id,
  directionId: p.directionId,
  ownerMembershipId: p.ownerMembershipId,
});

export const loadProjectRow = async (ctx: QueryContext | CommandContext, projectId: string): Promise<ProjectRow> => {
  const [p] = await dbOf(ctx).select().from(projects).where(and(eq(projects.workspaceId, ctx.actor.workspaceId), eq(projects.id, projectId)));
  if (!p || p.deletedAt) throw notFound('Project');
  return p;
};

/**
 * Load a project for a module read (permission in the project's scope, else 404) or action
 * (403 when the project is readable but the action is not allowed).
 */
export const projectFor = async (ctx: QueryContext | CommandContext, projectId: string, read: string, action?: string) => {
  const p = await loadProjectRow(ctx, projectId);
  const scope = projectScopeOf(p);
  if (action) authorizeObject(ctx, action, scope, [read, 'projects.read']);
  else authorizeRead(ctx, read, scope);
  return p;
};

export const assertProjectOpen = (p: ProjectRow, what = 'records') => {
  if (p.status === 'archived') throw new AppError('INVALID_STATE', `Archived projects cannot get new ${what}. Restore the project first.`);
};

/** Would this member hold `permission` on the given scope right now? (eligible reviewers, owners) */
export const memberCan = async (ctx: QueryContext | CommandContext, membershipId: string, permission: string, scope: Parameters<typeof can>[2]) => {
  const [m] = await dbOf(ctx).select({ userId: memberships.userId, status: memberships.status }).from(memberships).where(and(eq(memberships.workspaceId, ctx.actor.workspaceId), eq(memberships.id, membershipId)));
  if (!m || m.status !== 'active') return false;
  // Read on the pool (committed grants); the snapshot loader runs its queries concurrently.
  const snap = await loadAccessSnapshot(ctx.app.db, ctx.actor.workspaceId, m.userId, ctx.app.clock.now());
  return !!snap && can(snap, permission, scope);
};

export { allowed };
