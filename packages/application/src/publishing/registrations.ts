import { and, asc, desc, eq, gt, ilike, inArray, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { campaigns, contentItems, experiments, projects, publications, socialAccounts, trackingLinks, workspaces } from '@castlane/database';
import { AppError, DateTime } from '@castlane/domain';
import { allowed, requirePermission, whereAll } from '../core/access';
import { defineArchiveHandler, tableArchiveList } from '../core/archive-registry';
import { audit } from '../core/audit';
import { dbOf, type AppServices, type CommandContext } from '../core/context';
import { emit } from '../core/events';
import { defineJob, defineSchedule } from '../core/jobs-registry';
import { defineLookup, likePattern } from '../core/lookup-registry';
import { notify } from '../core/notify';
import { defineResponsibilityProvider } from '../core/responsibility-registry';
import { touch } from '../core/rows';
import { accountLabel } from '../accounts/accounts';
import { defineLinkAccess } from '../media/link-access';
import { memberCan } from '../work/shared';
import { runPlanFreeze } from './baselines';
import { archiveCampaign, campaignArchivePreview, indexCampaign, memberCanOwnCampaign, restoreCampaign } from './campaigns';
import { archiveExperiment } from './experiments';
import { archivePublication, publicationObligations, restorePublication, trashPublicationDraft, untrashPublicationDraft } from './publication-commands';
import { archiveTrackingLink } from './tracking-links';
import { campaignProjectMap, campaignVisibility, canCampaign, canChangeCampaign, experimentScope, experimentVisibility, loadCampaignRow, loadPublicationRow, publicationScope, publicationVisibility } from './scope';
import { indexPublication } from './support';

// ——— Pickers (EntitySelect) ———

defineLookup({
  type: 'publication',
  async search(ctx, input) {
    requirePermission(ctx, 'publications.read');
    const rows = await dbOf(ctx)
      .select({ p: publications, title: contentItems.title, account: socialAccounts })
      .from(publications)
      .innerJoin(contentItems, eq(contentItems.id, publications.contentItemId))
      .innerJoin(socialAccounts, eq(socialAccounts.id, publications.accountId))
      .where(
        whereAll(
          eq(publications.workspaceId, ctx.actor.workspaceId),
          isNull(publications.deletedAt),
          publicationVisibility(ctx),
          input.ids?.length ? inArray(publications.id, input.ids) : undefined,
          !input.ids?.length && !input.includeArchived ? isNull(publications.archivedAt) : undefined,
          input.projectId ? eq(publications.projectId, input.projectId) : undefined,
          input.accountId ? eq(publications.accountId, input.accountId) : undefined,
          input.status?.length ? inArray(publications.status, input.status as never[]) : undefined,
          input.q ? or(ilike(contentItems.title, likePattern(input.q)), ilike(publications.externalPostUrl, likePattern(input.q)), ilike(publications.caption, likePattern(input.q))) : undefined,
        ),
      )
      .orderBy(desc(sql`coalesce(${publications.actualPublishedAt}, ${publications.scheduledAt}, ${publications.createdAt})`), asc(publications.id))
      .limit(input.ids?.length ? Math.max(input.ids.length, input.limit) : input.limit);
    return rows.map(({ p, title, account }) => {
      const at = p.actualPublishedAt ?? p.scheduledAt;
      return {
        id: p.id,
        label: `${title} · ${accountLabel(account)}`,
        sublabel: [p.status.charAt(0).toUpperCase() + p.status.slice(1), at ? DateTime.fromJSDate(at, { zone: ctx.actor.timezone }).toFormat('d LLL yyyy, HH:mm') : null].filter(Boolean).join(' · '),
        status: p.status,
        projectId: p.projectId,
        archived: !!p.archivedAt,
      };
    });
  },
});

defineLookup({
  type: 'campaign',
  async search(ctx, input) {
    requirePermission(ctx, 'campaigns.read');
    const rows = await dbOf(ctx)
      .select()
      .from(campaigns)
      .where(
        whereAll(
          eq(campaigns.workspaceId, ctx.actor.workspaceId),
          campaignVisibility(ctx),
          input.ids?.length ? inArray(campaigns.id, input.ids) : undefined,
          !input.ids?.length && !input.includeArchived ? isNull(campaigns.archivedAt) : undefined,
          input.status?.length ? inArray(campaigns.status, input.status as never[]) : undefined,
          input.projectId ? sql`EXISTS (SELECT 1 FROM campaign_projects cp WHERE cp.campaign_id = ${campaigns.id} AND cp.project_id = ${input.projectId}::uuid)` : undefined,
          input.q ? ilike(campaigns.name, likePattern(input.q)) : undefined,
        ),
      )
      .orderBy(asc(sql`(${campaigns.status} IN ('closed','archived'))`), desc(campaigns.startDate), asc(campaigns.id))
      .limit(input.ids?.length ? Math.max(input.ids.length, input.limit) : input.limit);
    const pm = await campaignProjectMap(dbOf(ctx), ctx.actor.workspaceId, rows.map((r) => r.id));
    return rows.map((c) => ({
      id: c.id,
      label: c.name,
      sublabel: `${c.startDate} – ${c.endDate}`,
      status: c.status,
      projectId: pm.get(c.id)?.[0] ?? null,
      archived: !!c.archivedAt,
    }));
  },
});

defineLookup({
  type: 'experiment',
  async search(ctx, input) {
    requirePermission(ctx, 'experiments.read');
    const rows = await dbOf(ctx)
      .select({ e: experiments, projectName: projects.name })
      .from(experiments)
      .innerJoin(projects, eq(projects.id, experiments.projectId))
      .where(
        whereAll(
          eq(experiments.workspaceId, ctx.actor.workspaceId),
          experimentVisibility(ctx),
          input.ids?.length ? inArray(experiments.id, input.ids) : undefined,
          !input.ids?.length && !input.includeArchived ? isNull(experiments.archivedAt) : undefined,
          input.status?.length ? inArray(experiments.status, input.status as never[]) : undefined,
          input.projectId ? eq(experiments.projectId, input.projectId) : undefined,
          input.q ? ilike(experiments.hypothesis, likePattern(input.q)) : undefined,
        ),
      )
      .orderBy(desc(experiments.updatedAt), asc(experiments.id))
      .limit(input.ids?.length ? Math.max(input.ids.length, input.limit) : input.limit);
    return rows.map(({ e, projectName }) => ({
      id: e.id,
      label: e.hypothesis.length > 90 ? `${e.hypothesis.slice(0, 89)}…` : e.hypothesis,
      sublabel: projectName,
      status: e.status,
      projectId: e.projectId,
      archived: !!e.archivedAt,
    }));
  },
});

defineLookup({
  type: 'tracking_link',
  async search(ctx, input) {
    requirePermission(ctx, 'campaigns.read');
    const rows = await dbOf(ctx)
      .select({ l: trackingLinks, campaignName: campaigns.name })
      .from(trackingLinks)
      .innerJoin(campaigns, and(eq(campaigns.workspaceId, trackingLinks.workspaceId), eq(campaigns.id, trackingLinks.campaignId)))
      .where(
        whereAll(
          eq(trackingLinks.workspaceId, ctx.actor.workspaceId),
          campaignVisibility(ctx),
          input.ids?.length ? inArray(trackingLinks.id, input.ids) : undefined,
          !input.ids?.length && !input.includeArchived ? isNull(trackingLinks.archivedAt) : undefined,
          input.parentId ? eq(trackingLinks.campaignId, input.parentId) : undefined,
          input.q ? or(ilike(trackingLinks.label, likePattern(input.q)), ilike(trackingLinks.builtUrl, likePattern(input.q))) : undefined,
        ),
      )
      .orderBy(asc(trackingLinks.label), asc(trackingLinks.id))
      .limit(input.ids?.length ? Math.max(input.ids.length, input.limit) : input.limit);
    return rows.map(({ l, campaignName }) => ({ id: l.id, label: l.label, sublabel: `${campaignName} · ${l.builtUrl}`, status: l.archivedAt ? 'archived' : 'active', projectId: null, archived: !!l.archivedAt }));
  },
});

// ——— Files linked to placements, campaigns and experiments authorise through them ———

defineLinkAccess('publication', {
  permission: 'publications.read',
  scope: async (ctx, id) => {
    const [p] = await dbOf(ctx).select().from(publications).where(and(eq(publications.workspaceId, ctx.actor.workspaceId), eq(publications.id, id)));
    if (!p || p.deletedAt) return null;
    return { ...publicationScope(p), label: 'Publication', href: `/w/${p.workspaceId}/publications/${p.id}` };
  },
});

defineLinkAccess('campaign', {
  permission: 'campaigns.read',
  scope: async (ctx, id) => {
    const [c] = await dbOf(ctx).select().from(campaigns).where(and(eq(campaigns.workspaceId, ctx.actor.workspaceId), eq(campaigns.id, id)));
    if (!c) return null;
    const pids = (await campaignProjectMap(dbOf(ctx), ctx.actor.workspaceId, [c.id])).get(c.id) ?? [];
    return { objectType: 'campaign', objectId: c.id, projectId: pids[0] ?? null, ownerMembershipId: c.ownerMembershipId, assignedMembershipIds: [c.ownerMembershipId], label: c.name, href: `/w/${c.workspaceId}/campaigns/${c.id}` };
  },
  readable: async (ctx, id) => {
    const [c] = await dbOf(ctx).select().from(campaigns).where(and(eq(campaigns.workspaceId, ctx.actor.workspaceId), eq(campaigns.id, id)));
    if (!c) return false;
    return canCampaign(ctx, 'campaigns.read', c, (await campaignProjectMap(dbOf(ctx), ctx.actor.workspaceId, [c.id])).get(c.id) ?? []);
  },
});

defineLinkAccess('experiment', {
  permission: 'experiments.read',
  scope: async (ctx, id) => {
    const [e] = await dbOf(ctx).select().from(experiments).where(and(eq(experiments.workspaceId, ctx.actor.workspaceId), eq(experiments.id, id)));
    return e ? { ...experimentScope(e), label: 'Experiment', href: `/w/${e.workspaceId}/experiments/${e.id}` } : null;
  },
});

// ——— Archive / Trash screen ———

defineArchiveHandler({
  entityType: 'publication',
  label: 'Publication',
  preview: async (ctx, id) => {
    const p = await loadPublicationRow(ctx, id);
    if (!allowed(ctx, 'publications.read', publicationScope(p))) throw new AppError('NOT_FOUND', 'Publication was not found.');
    const [c] = await dbOf(ctx).select({ title: contentItems.title }).from(contentItems).where(eq(contentItems.id, p.contentItemId));
    return { title: c?.title ?? 'Publication', rowVersion: p.rowVersion, items: publicationObligations(p) };
  },
  archive: async (ctx, id, input) => {
    await archivePublication(ctx, id, { reason: input.reason }, { skipVersion: true });
  },
  restorePreview: async (ctx, id) => {
    const p = await loadPublicationRow(ctx, id);
    return { title: 'Publication', items: allowed(ctx, 'publications.write', publicationScope(p)) ? [] : [{ kind: 'forbidden', label: 'You cannot restore this publication', count: 1, blocking: true }] };
  },
  restore: async (ctx, id) => {
    await restorePublication(ctx, id);
  },
  trash: async (ctx, id, reason) => trashPublicationDraft(ctx, id, reason),
  untrashPreview: async (ctx, id) => {
    const [p] = await dbOf(ctx).select().from(publications).where(and(eq(publications.workspaceId, ctx.actor.workspaceId), eq(publications.id, id)));
    if (!p || !allowed(ctx, 'publications.read', publicationScope(p))) throw new AppError('NOT_FOUND', 'Publication was not found.');
    return { title: 'Publication draft', items: [] };
  },
  untrash: async (ctx, id) => untrashPublicationDraft(ctx, id),
  list: async (ctx, input) => {
    const trash = input.state === 'trash';
    const atCol = trash ? publications.deletedAt : publications.archivedAt;
    const rows = await dbOf(ctx)
      .select({ p: publications, title: contentItems.title })
      .from(publications)
      .innerJoin(contentItems, eq(contentItems.id, publications.contentItemId))
      .where(
        whereAll(
          eq(publications.workspaceId, ctx.actor.workspaceId),
          publicationVisibility(ctx),
          trash ? isNotNull(publications.deletedAt) : and(isNotNull(publications.archivedAt), isNull(publications.deletedAt)),
          input.q ? ilike(contentItems.title, likePattern(input.q)) : undefined,
          input.projectId ? eq(publications.projectId, input.projectId) : undefined,
          input.purgeDueBefore ? lt(publications.purgeAfter, input.purgeDueBefore) : undefined,
          input.before ? or(lt(atCol, input.before.at), and(eq(atCol, input.before.at), lt(publications.id, input.before.id))) : undefined,
        ),
      )
      .orderBy(desc(atCol), desc(publications.id))
      .limit(input.limit);
    return rows.map(({ p, title }) => ({
      id: p.id,
      title,
      at: (trash ? p.deletedAt : p.archivedAt)!,
      byUserId: trash ? p.deletedBy : p.archivedBy,
      reason: trash ? null : p.archiveReason,
      projectId: p.projectId,
      purgeAfter: trash ? p.purgeAfter : null,
    }));
  },
});

defineArchiveHandler({
  entityType: 'campaign',
  label: 'Campaign',
  preview: campaignArchivePreview,
  archive: async (ctx, id, input) => {
    await archiveCampaign(ctx, id, { reason: input.reason }, { skipVersion: true });
  },
  restorePreview: async (ctx, id) => {
    const { campaign: c, projectIds } = await loadCampaignRow(ctx, id);
    return { title: c.name, items: canChangeCampaign(ctx, 'campaigns.write', c, projectIds) ? [] : [{ kind: 'forbidden', label: 'You cannot restore this campaign', count: 1, blocking: true }] };
  },
  restore: async (ctx, id) => {
    await restoreCampaign(ctx, id, { skipVersion: true });
  },
  list: (ctx, input) =>
    tableArchiveList(ctx, input, { table: campaigns, title: campaigns.name, scope: campaignVisibility(ctx), archivedWhere: eq(campaigns.status, 'archived'), thumbnail: campaigns.coverAssetId }),
});

defineArchiveHandler({
  entityType: 'experiment',
  label: 'Experiment',
  preview: async (ctx, id) => {
    const [e] = await dbOf(ctx).select().from(experiments).where(and(eq(experiments.workspaceId, ctx.actor.workspaceId), eq(experiments.id, id)));
    if (!e || !allowed(ctx, 'experiments.read', experimentScope(e))) throw new AppError('NOT_FOUND', 'Experiment was not found.');
    return {
      title: e.hypothesis.slice(0, 120),
      rowVersion: e.rowVersion,
      items: e.status === 'running' ? [{ kind: 'running', label: 'The experiment is running', count: 1, blocking: true, resolution: 'Conclude it with findings and limitations first.' }] : [],
    };
  },
  archive: async (ctx, id, input) => {
    await archiveExperiment(ctx, id, { reason: input.reason }, { skipVersion: true });
  },
  restorePreview: async (ctx, id) => {
    const [e] = await dbOf(ctx).select().from(experiments).where(and(eq(experiments.workspaceId, ctx.actor.workspaceId), eq(experiments.id, id)));
    if (!e || !allowed(ctx, 'experiments.read', experimentScope(e))) throw new AppError('NOT_FOUND', 'Experiment was not found.');
    return { title: e.hypothesis.slice(0, 120), items: [] };
  },
  restore: async (ctx, id) => {
    const [e] = await ctx.tx.select().from(experiments).where(and(eq(experiments.workspaceId, ctx.actor.workspaceId), eq(experiments.id, id))).for('update');
    if (!e || !allowed(ctx, 'experiments.write', experimentScope(e))) throw new AppError('NOT_FOUND', 'Experiment was not found.');
    if (e.status !== 'archived') return;
    const status = e.conclusion ? 'concluded' : 'draft';
    const [row] = await ctx.tx.update(experiments).set({ status, archivedAt: null, archivedBy: null, archiveReason: null, ...touch(ctx, experiments) }).where(eq(experiments.id, id)).returning();
    await audit(ctx, { action: 'experiment.restored', entityType: 'experiment', entityId: id, projectId: e.projectId, diff: { status: { from: 'archived', to: status } } });
    await emit(ctx, { type: 'experiment.restored', entityType: 'experiment', entityId: id, revision: row!.rowVersion });
  },
  list: (ctx, input) => tableArchiveList(ctx, input, { table: experiments, title: experiments.hypothesis, projectId: experiments.projectId, scope: experimentVisibility(ctx), archivedWhere: eq(experiments.status, 'archived') }),
});

defineArchiveHandler({
  entityType: 'tracking_link',
  label: 'Tracking link',
  preview: async (ctx, id) => {
    const [l] = await dbOf(ctx).select().from(trackingLinks).where(and(eq(trackingLinks.workspaceId, ctx.actor.workspaceId), eq(trackingLinks.id, id)));
    if (!l) throw new AppError('NOT_FOUND', 'Tracking link was not found.');
    await loadCampaignRow(ctx, l.campaignId);
    return { title: l.label, rowVersion: l.rowVersion, items: [{ kind: 'reports', label: 'Source reports keep referring to the link', count: 1, blocking: false }] };
  },
  archive: async (ctx, id, input) => {
    await archiveTrackingLink(ctx, id, { reason: input.reason }, { skipVersion: true });
  },
  restore: async (ctx, id) => {
    await archiveTrackingLink(ctx, id, { restore: true }, { skipVersion: true });
  },
  list: async (ctx, input) => {
    if (input.state === 'trash') return [];
    const rows = await dbOf(ctx)
      .select({ l: trackingLinks })
      .from(trackingLinks)
      .innerJoin(campaigns, and(eq(campaigns.workspaceId, trackingLinks.workspaceId), eq(campaigns.id, trackingLinks.campaignId)))
      .where(
        whereAll(
          eq(trackingLinks.workspaceId, ctx.actor.workspaceId),
          campaignVisibility(ctx),
          isNotNull(trackingLinks.archivedAt),
          input.q ? ilike(trackingLinks.label, likePattern(input.q)) : undefined,
          input.before ? or(lt(trackingLinks.archivedAt, input.before.at), and(eq(trackingLinks.archivedAt, input.before.at), lt(trackingLinks.id, input.before.id))) : undefined,
        ),
      )
      .orderBy(desc(trackingLinks.archivedAt), desc(trackingLinks.id))
      .limit(input.limit);
    return rows.map(({ l }) => ({ id: l.id, title: l.label, at: l.archivedAt!, byUserId: l.archivedBy, reason: l.archiveReason, projectId: null, purgeAfter: null }));
  },
});

// ——— Deactivation impact (F12): placements, campaigns and experiments a member owns ———

const OPEN_PUBLICATIONS = ['draft', 'scheduled', 'failed'] as const;

const successorError = (message: string) => new AppError('VALIDATION_FAILED', message, { fieldErrors: [{ field: 'resolutions', code: 'SUCCESSOR_NO_ACCESS', message }] });

defineResponsibilityProvider({
  kind: 'publications.owner',
  label: 'Planned publications',
  unassignedBehaviour: 'The account owner takes over; placements they cannot reach stay with the project lead to reassign.',
  async list(ctx, membershipId) {
    const rows = await dbOf(ctx)
      .select({ p: publications, title: contentItems.title })
      .from(publications)
      .innerJoin(contentItems, eq(contentItems.id, publications.contentItemId))
      .where(and(eq(publications.workspaceId, ctx.actor.workspaceId), eq(publications.ownerMembershipId, membershipId), inArray(publications.status, [...OPEN_PUBLICATIONS]), isNull(publications.deletedAt), isNull(publications.archivedAt)))
      .orderBy(asc(publications.scheduledAt));
    return rows.map(({ p, title }) => ({
      kind: 'publications.owner',
      entityType: 'publication',
      entityId: p.id,
      title,
      projectId: p.projectId,
      dueAt: p.scheduledAt?.toISOString() ?? null,
      requiresSuccessor: p.status === 'scheduled',
    }));
  },
  async transfer(ctx, from, resolutions) {
    for (const r of resolutions) {
      const p = await loadPublicationRow(ctx, r.entityId, { lock: true });
      if (p.ownerMembershipId !== from || !(OPEN_PUBLICATIONS as readonly string[]).includes(p.status)) continue;
      const scope = publicationScope({ ...p, ownerMembershipId: r.successorMembershipId ?? p.ownerMembershipId });
      let successor = r.successorMembershipId;
      if (successor) {
        const ok = await memberCan(ctx.app.db, ctx.actor.workspaceId, successor, 'publications.read', { ...scope, ownerMembershipId: successor, assignedMembershipIds: [successor] }, ctx.app.clock.now());
        if (!ok.ok) throw successorError(`${ok.name ?? 'The successor'} cannot access the account of a planned publication.`);
      } else {
        const [a] = await ctx.tx.select({ owner: socialAccounts.ownerMembershipId }).from(socialAccounts).where(eq(socialAccounts.id, p.accountId));
        const candidate = a && a.owner !== from ? a.owner : null;
        const ok = candidate ? await memberCan(ctx.app.db, ctx.actor.workspaceId, candidate, 'publications.read', { ...scope, ownerMembershipId: candidate, assignedMembershipIds: [candidate] }, ctx.app.clock.now()) : null;
        successor = ok?.ok ? candidate : null;
        if (!successor) {
          if (p.status === 'scheduled') throw successorError('Choose a successor who can publish on the account of a scheduled placement.');
          continue;
        }
      }
      const [row] = await ctx.tx.update(publications).set({ ownerMembershipId: successor, ...touch(ctx, publications) }).where(eq(publications.id, p.id)).returning();
      await audit(ctx, { action: 'publication.owner_transferred', entityType: 'publication', entityId: p.id, projectId: p.projectId, diff: { ownerMembershipId: { from, to: successor } } });
      await emit(ctx, { type: 'publication.updated', entityType: 'publication', entityId: p.id, revision: row!.rowVersion });
      const t = await indexPublication(ctx, row!);
      await notify(ctx.tx, {
        workspaceId: ctx.actor.workspaceId,
        recipientMembershipIds: [successor],
        eventType: 'publication.assigned',
        eventKey: `publication.assigned:${p.id}:${successor}:${row!.rowVersion}`,
        kind: 'assignment',
        title: `You publish: ${t.title}`,
        excerpt: t.accountLabel,
        entityType: 'publication',
        entityId: p.id,
        projectId: p.projectId,
        actorMembershipId: ctx.actor.membershipId,
        at: ctx.app.clock.now(),
      });
    }
  },
});

const reassignCampaign = async (ctx: CommandContext, id: string, from: string, to: string) => {
  const [row] = await ctx.tx.update(campaigns).set({ ownerMembershipId: to, ...touch(ctx, campaigns) }).where(eq(campaigns.id, id)).returning();
  const pids = (await campaignProjectMap(ctx.tx, ctx.actor.workspaceId, [id])).get(id) ?? [];
  await audit(ctx, { action: 'campaign.owner_transferred', entityType: 'campaign', entityId: id, projectId: pids[0] ?? null, diff: { ownerMembershipId: { from, to } } });
  await emit(ctx, { type: 'campaign.updated', entityType: 'campaign', entityId: id, revision: row!.rowVersion });
  await indexCampaign(ctx, row!, pids);
  await notify(ctx.tx, {
    workspaceId: ctx.actor.workspaceId,
    recipientMembershipIds: [to],
    eventType: 'campaign.owner_assigned',
    eventKey: `campaign.owner_assigned:${id}:${to}:${row!.rowVersion}`,
    kind: 'assignment',
    title: `You own the campaign ${row!.name}`,
    entityType: 'campaign',
    entityId: id,
    projectId: pids[0] ?? null,
    actorMembershipId: ctx.actor.membershipId,
    at: ctx.app.clock.now(),
  });
};

defineResponsibilityProvider({
  kind: 'campaigns.owner',
  label: 'Campaign ownership',
  unassignedBehaviour: 'Ownership moves to the owner of the campaign’s first project.',
  async list(ctx, membershipId) {
    const rows = await dbOf(ctx)
      .select()
      .from(campaigns)
      .where(and(eq(campaigns.workspaceId, ctx.actor.workspaceId), eq(campaigns.ownerMembershipId, membershipId), inArray(campaigns.status, ['planned', 'active'])));
    const pm = await campaignProjectMap(dbOf(ctx), ctx.actor.workspaceId, rows.map((r) => r.id));
    return rows.map((c) => ({ kind: 'campaigns.owner', entityType: 'campaign', entityId: c.id, title: c.name, projectId: pm.get(c.id)?.[0] ?? null, dueAt: null, requiresSuccessor: true }));
  },
  async transfer(ctx, from, resolutions) {
    for (const r of resolutions) {
      const [c] = await ctx.tx.select().from(campaigns).where(and(eq(campaigns.workspaceId, ctx.actor.workspaceId), eq(campaigns.id, r.entityId))).for('update');
      if (!c || c.ownerMembershipId !== from) continue;
      const pids = (await campaignProjectMap(ctx.tx, ctx.actor.workspaceId, [c.id])).get(c.id) ?? [];
      let successor = r.successorMembershipId;
      if (successor) {
        if (!(await memberCanOwnCampaign(ctx, successor, pids)).ok) throw successorError('The successor cannot access this campaign’s projects.');
      } else {
        const [p] = pids.length ? await ctx.tx.select({ owner: projects.ownerMembershipId }).from(projects).where(eq(projects.id, pids[0]!)) : [];
        successor = p && p.owner !== from && (await memberCanOwnCampaign(ctx, p.owner, pids)).ok ? p.owner : null;
        if (!successor) continue;
      }
      await reassignCampaign(ctx, c.id, from, successor);
    }
  },
});

defineResponsibilityProvider({
  kind: 'experiments.owner',
  label: 'Experiments',
  unassignedBehaviour: 'Ownership moves to the project owner.',
  async list(ctx, membershipId) {
    const rows = await dbOf(ctx)
      .select()
      .from(experiments)
      .where(and(eq(experiments.workspaceId, ctx.actor.workspaceId), eq(experiments.ownerMembershipId, membershipId), inArray(experiments.status, ['draft', 'running'])));
    return rows.map((e) => ({ kind: 'experiments.owner', entityType: 'experiment', entityId: e.id, title: e.hypothesis.slice(0, 120), projectId: e.projectId, dueAt: e.endAt?.toISOString() ?? null, requiresSuccessor: e.status === 'running' }));
  },
  async transfer(ctx, from, resolutions) {
    for (const r of resolutions) {
      const [e] = await ctx.tx.select().from(experiments).where(and(eq(experiments.workspaceId, ctx.actor.workspaceId), eq(experiments.id, r.entityId))).for('update');
      if (!e || e.ownerMembershipId !== from) continue;
      const canOwn = async (m: string) => (await memberCan(ctx.app.db, ctx.actor.workspaceId, m, 'experiments.read', { ...experimentScope(e), ownerMembershipId: m, assignedMembershipIds: [m] }, ctx.app.clock.now())).ok;
      let successor = r.successorMembershipId;
      if (successor) {
        if (!(await canOwn(successor))) throw successorError('The successor cannot access this experiment’s project.');
      } else {
        const [p] = await ctx.tx.select({ owner: projects.ownerMembershipId }).from(projects).where(eq(projects.id, e.projectId));
        successor = p && p.owner !== from && (await canOwn(p.owner)) ? p.owner : null;
        if (!successor) {
          if (e.status === 'running') throw successorError('Choose a successor for the running experiment.');
          continue;
        }
      }
      const [row] = await ctx.tx.update(experiments).set({ ownerMembershipId: successor, ...touch(ctx, experiments) }).where(eq(experiments.id, e.id)).returning();
      await audit(ctx, { action: 'experiment.owner_transferred', entityType: 'experiment', entityId: e.id, projectId: e.projectId, diff: { ownerMembershipId: { from, to: successor } } });
      await emit(ctx, { type: 'experiment.updated', entityType: 'experiment', entityId: e.id, revision: row!.rowVersion });
    }
  },
});

// ——— Background work ———

/**
 * Publication reminders (§20): 1 h and 15 min before the scheduled time (only the nearest threshold,
 * never missed ones), and one "Confirm publication" reminder once the time has passed without
 * confirmation. The scheduled time is part of the key, so a rescheduled placement gets fresh
 * reminders and stale ones never fire. Nothing here changes a publication's status (T063).
 */
export const runPublicationReminders = async (app: AppServices) => {
  const now = app.clock.now();
  const rows = await app.db
    .select({ p: publications, title: contentItems.title, account: socialAccounts })
    .from(publications)
    .innerJoin(contentItems, eq(contentItems.id, publications.contentItemId))
    .innerJoin(socialAccounts, eq(socialAccounts.id, publications.accountId))
    .innerJoin(workspaces, eq(workspaces.id, publications.workspaceId))
    .where(
      and(
        eq(publications.status, 'scheduled'),
        isNull(publications.deletedAt),
        isNull(publications.archivedAt),
        gt(publications.scheduledAt, new Date(now.getTime() - 24 * 3_600_000)),
        lte(publications.scheduledAt, new Date(now.getTime() + 60 * 60_000)),
      ),
    )
    .limit(5000);
  let sent = 0;
  for (const { p, title, account } of rows) {
    const at = p.scheduledAt!;
    const minutes = (at.getTime() - now.getTime()) / 60_000;
    const zone = p.scheduleTimezone ?? 'UTC';
    const when = `${DateTime.fromJSDate(at, { zone }).toFormat('d LLL, HH:mm')} (${zone})`;
    const base = { workspaceId: p.workspaceId, recipientMembershipIds: [p.ownerMembershipId], entityType: 'publication', entityId: p.id, projectId: p.projectId, at: now, excludeActor: false };
    if (minutes > 0) {
      const threshold = minutes <= 15 ? '15m' : '1h';
      sent += await notify(app.db, {
        ...base,
        eventType: 'publication.due',
        eventKey: `publication.due:${p.id}:${at.toISOString()}:${threshold}`,
        kind: 'due_reminder',
        title: `Publication due: ${title}`,
        excerpt: `${accountLabel(account)} · ${when}. Planned in Castlane. Publish on the platform, then confirm it here.`,
      });
    } else {
      sent += await notify(app.db, {
        ...base,
        eventType: 'publication.awaiting_confirmation',
        eventKey: `publication.awaiting_confirmation:${p.id}:${at.toISOString()}`,
        kind: 'due_reminder',
        title: `Confirm publication: ${title}`,
        excerpt: `${accountLabel(account)} was planned for ${when}. Mark it Published with the post URL, or record that it failed.`,
      });
    }
  }
  return { checked: rows.length, sent };
};

defineJob('publishing.reminders', 'light', async ({ app }) => runPublicationReminders(app));
defineSchedule({ name: 'publishing.reminders', everySeconds: 300, jobType: 'publishing.reminders' });
defineJob('publishing.freezePlans', 'light', async ({ app }) => runPlanFreeze(app));
defineSchedule({ name: 'publishing.freezePlans', everySeconds: 900, jobType: 'publishing.freezePlans' });

