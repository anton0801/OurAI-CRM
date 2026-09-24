import { and, eq, isNull, ne } from 'drizzle-orm';
import { directions, projectMemberships, projects, searchDocuments } from '@castlane/database';
import { AppError, newId } from '@castlane/domain';
import { audit } from '../core/audit';
import { dbOf } from '../core/context';
import { emit } from '../core/events';
import { isActiveMember } from '../core/members';
import { notify } from '../core/notify';
import { defineResponsibilityProvider } from '../core/responsibility-registry';
import { stamp, touch } from '../core/rows';
import { bumpAccessRevision } from './scope';

/**
 * Responsibilities owned by the team/organisation structure: direction leadership and primary
 * project ownership. Deactivation (F12) and Transfer Work hand them over; history is kept in the
 * audit log and project team history.
 */
defineResponsibilityProvider({
  kind: 'directions.lead',
  label: 'Direction leadership',
  unassignedBehaviour: 'The direction has no lead until one is assigned. Access roles are not changed automatically.',
  async list(ctx, membershipId) {
    const rows = await dbOf(ctx)
      .select()
      .from(directions)
      .where(and(eq(directions.workspaceId, ctx.actor.workspaceId), eq(directions.leadMembershipId, membershipId), eq(directions.status, 'active')))
      .orderBy(directions.sortOrder, directions.name);
    return rows.map((d) => ({
      kind: 'directions.lead',
      entityType: 'direction',
      entityId: d.id,
      title: `Lead of ${d.name}`,
      projectId: null,
      dueAt: null,
      requiresSuccessor: false,
    }));
  },
  async transfer(ctx, fromMembershipId, resolutions) {
    for (const r of resolutions) {
      const [d] = await ctx.tx
        .select()
        .from(directions)
        .where(and(eq(directions.workspaceId, ctx.actor.workspaceId), eq(directions.id, r.entityId)))
        .for('update');
      if (!d || d.leadMembershipId !== fromMembershipId) continue;
      if (r.successorMembershipId && !(await isActiveMember(ctx.tx, ctx.actor.workspaceId, r.successorMembershipId)))
        throw new AppError('INVALID_STATE', 'The new direction lead must be an active member.');
      const [row] = await ctx.tx
        .update(directions)
        .set({ leadMembershipId: r.successorMembershipId, ...touch(ctx, directions) })
        .where(eq(directions.id, d.id))
        .returning();
      await audit(ctx, {
        action: 'direction.lead_changed',
        entityType: 'direction',
        entityId: d.id,
        diff: { leadMembershipId: { from: fromMembershipId, to: r.successorMembershipId } },
        metadata: { handover: true },
      });
      await emit(ctx, { type: 'direction.updated', entityType: 'direction', entityId: d.id, revision: row!.rowVersion });
      if (r.successorMembershipId)
        await notify(ctx.tx, {
          workspaceId: ctx.actor.workspaceId,
          recipientMembershipIds: [r.successorMembershipId],
          eventType: 'direction.lead_assigned',
          eventKey: `direction.lead_assigned:${d.id}:${r.successorMembershipId}:${row!.rowVersion}`,
          kind: 'assignment',
          title: `You now lead the ${d.name} direction`,
          entityType: 'direction',
          entityId: d.id,
          actorMembershipId: ctx.actor.membershipId,
          at: ctx.app.clock.now(),
        });
    }
  },
});

defineResponsibilityProvider({
  kind: 'projects.owner',
  label: 'Project ownership',
  unassignedBehaviour: 'Every project needs exactly one owner: choose a successor for each project.',
  async list(ctx, membershipId) {
    const rows = await dbOf(ctx)
      .select()
      .from(projects)
      .where(
        and(
          eq(projects.workspaceId, ctx.actor.workspaceId),
          eq(projects.ownerMembershipId, membershipId),
          ne(projects.status, 'archived'),
          isNull(projects.deletedAt),
        ),
      )
      .orderBy(projects.name);
    return rows.map((p) => ({
      kind: 'projects.owner',
      entityType: 'project',
      entityId: p.id,
      title: `Owner of ${p.name}`,
      projectId: p.id,
      dueAt: null,
      requiresSuccessor: true,
    }));
  },
  async transfer(ctx, fromMembershipId, resolutions) {
    for (const r of resolutions) {
      const [p] = await ctx.tx
        .select()
        .from(projects)
        .where(and(eq(projects.workspaceId, ctx.actor.workspaceId), eq(projects.id, r.entityId)))
        .for('update');
      if (!p || p.ownerMembershipId !== fromMembershipId) continue;
      if (!r.successorMembershipId) throw new AppError('INVALID_STATE', `Choose a new owner for ${p.name}.`);
      if (!(await isActiveMember(ctx.tx, ctx.actor.workspaceId, r.successorMembershipId))) throw new AppError('INVALID_STATE', 'The new project owner must be an active member.');
      const [row] = await ctx.tx
        .update(projects)
        .set({ ownerMembershipId: r.successorMembershipId, ...touch(ctx, projects) })
        .where(eq(projects.id, p.id))
        .returning();
      // The owner is always on the project team (assignment-scoped roles apply to them).
      const [onTeam] = await ctx.tx
        .select({ id: projectMemberships.id })
        .from(projectMemberships)
        .where(and(eq(projectMemberships.projectId, p.id), eq(projectMemberships.membershipId, r.successorMembershipId), isNull(projectMemberships.validTo)));
      if (!onTeam) {
        await ctx.tx
          .insert(projectMemberships)
          .values({ ...stamp(ctx), id: newId(), projectId: p.id, membershipId: r.successorMembershipId, responsibility: 'producing', validFrom: ctx.app.clock.now(), note: 'Project ownership handover' });
        await bumpAccessRevision(ctx, [r.successorMembershipId]);
      }
      await ctx.tx
        .update(searchDocuments)
        .set({ ownerMembershipId: r.successorMembershipId, updatedAt: ctx.app.clock.now() })
        .where(and(eq(searchDocuments.workspaceId, ctx.actor.workspaceId), eq(searchDocuments.entityType, 'project'), eq(searchDocuments.entityId, p.id)));
      await audit(ctx, {
        action: 'project.owner_changed',
        entityType: 'project',
        entityId: p.id,
        projectId: p.id,
        diff: { ownerMembershipId: { from: fromMembershipId, to: r.successorMembershipId } },
        metadata: { handover: true },
      });
      await emit(ctx, { type: 'project.updated', entityType: 'project', entityId: p.id, revision: row!.rowVersion });
      await notify(ctx.tx, {
        workspaceId: ctx.actor.workspaceId,
        recipientMembershipIds: [r.successorMembershipId],
        eventType: 'project.owner_assigned',
        eventKey: `project.owner_assigned:${p.id}:${r.successorMembershipId}:${row!.rowVersion}`,
        kind: 'assignment',
        title: `You are now the owner of ${p.name}`,
        entityType: 'project',
        entityId: p.id,
        projectId: p.id,
        actorMembershipId: ctx.actor.membershipId,
        at: ctx.app.clock.now(),
      });
    }
  },
});

