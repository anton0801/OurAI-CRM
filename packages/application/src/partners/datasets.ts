import { and, asc, eq, inArray, lte, sql, isNull } from 'drizzle-orm';
import { dealProjects, deals, partners, projects } from '@castlane/database';
import { DEAL_STAGES, formatMinor } from '@castlane/domain';
import { defineExportDataset } from '../core/export-registry';
import { loadMemberRefs } from '../core/members';
import { asList } from '../accounts/datasets';
import { canSeeDealAmounts, dealVisibility, partnerVisibility } from './scope';

/** Export Center datasets "partners" and "deals" (permission-scoped rows as of the job boundary). */

defineExportDataset({
  key: 'partners',
  label: 'Partners',
  permission: 'partners.read',
  classification: 'normal',
  columns: [
    { key: 'id', label: 'Partner ID', type: 'id', default: true },
    { key: 'kind', label: 'Kind', type: 'text', default: true },
    { key: 'name', label: 'Name', type: 'text', default: true },
    { key: 'contact_name', label: 'Contact Name', type: 'text', default: true },
    { key: 'business_email', label: 'Business Email', type: 'text', default: true },
    { key: 'website', label: 'Website', type: 'text' },
    { key: 'owner', label: 'Owner', type: 'text', default: true },
    { key: 'tags', label: 'Tags', type: 'text' },
    { key: 'created_at', label: 'Created At', type: 'datetime' },
    { key: 'archived_at', label: 'Archived At', type: 'datetime' },
  ],
  filters: [{ key: 'kind', label: 'Kind', type: 'enum', enumValues: ['organization', 'person'] }],
  async *rows(ctx, input) {
    const f = input.filters as { kind?: string | string[]; includeArchived?: boolean };
    const kinds = asList(f.kind);
    let cursor: { createdAt: Date; id: string } | null = null;
    for (;;) {
      const page: (typeof partners.$inferSelect)[] = await ctx.app.db
        .select()
        .from(partners)
        .where(
          and(
            eq(partners.workspaceId, ctx.actor.workspaceId),
            partnerVisibility(ctx, 'partners.read'),
            lte(partners.createdAt, input.boundAt),
            kinds.length ? inArray(partners.kind, kinds as never[]) : undefined,
            f.includeArchived ? undefined : isNull(partners.archivedAt),
            cursor ? sql`(${partners.createdAt}, ${partners.id}) > (${cursor.createdAt}, ${cursor.id}::uuid)` : undefined,
          ),
        )
        .orderBy(asc(partners.createdAt), asc(partners.id))
        .limit(500);
      if (!page.length) return;
      const refs = await loadMemberRefs(ctx.app.db, ctx.actor.workspaceId, page.map((p) => p.ownerMembershipId));
      for (const p of page)
        yield {
          id: p.id,
          kind: p.kind,
          name: p.name,
          contact_name: p.contactName,
          business_email: p.businessEmail,
          website: p.website,
          owner: refs.get(p.ownerMembershipId)?.displayName ?? null,
          tags: p.tags.join(', '),
          created_at: p.createdAt.toISOString(),
          archived_at: p.archivedAt?.toISOString() ?? null,
        };
      const last = page[page.length - 1]!;
      cursor = { createdAt: last.createdAt, id: last.id };
      if (page.length < 500) return;
    }
  },
});

defineExportDataset({
  key: 'deals',
  label: 'Partnership Deals',
  permission: 'deals.read',
  classification: 'normal',
  columns: [
    { key: 'id', label: 'Deal ID', type: 'id', default: true },
    { key: 'title', label: 'Title', type: 'text', default: true },
    { key: 'partner', label: 'Partner', type: 'text', default: true },
    { key: 'stage', label: 'Stage', type: 'text', default: true },
    { key: 'projects', label: 'Projects', type: 'text', default: true },
    { key: 'owner', label: 'Owner', type: 'text', default: true },
    { key: 'expected_close_date', label: 'Expected Close', type: 'date' },
    // Planned amount, not revenue; only for members with finance access (omitted otherwise).
    { key: 'amount', label: 'Planned Amount', type: 'amount', permission: 'finance.read' },
    { key: 'currency', label: 'Currency', type: 'currency', permission: 'finance.read' },
    { key: 'closed_at', label: 'Closed At', type: 'datetime' },
    { key: 'created_at', label: 'Created At', type: 'datetime' },
  ],
  filters: [
    { key: 'stage', label: 'Stage', type: 'enum', enumValues: DEAL_STAGES },
    { key: 'partnerId', label: 'Partner', type: 'reference', lookup: 'partner' },
    { key: 'projectId', label: 'Project', type: 'reference', lookup: 'project' },
  ],
  async *rows(ctx, input) {
    const f = input.filters as { stage?: string | string[]; partnerId?: string; projectId?: string; includeArchived?: boolean };
    const stages = asList(f.stage);
    let cursor: { createdAt: Date; id: string } | null = null;
    for (;;) {
      const page: (typeof deals.$inferSelect)[] = await ctx.app.db
        .select()
        .from(deals)
        .where(
          and(
            eq(deals.workspaceId, ctx.actor.workspaceId),
            dealVisibility(ctx, 'deals.read'),
            lte(deals.createdAt, input.boundAt),
            stages.length ? inArray(deals.stage, stages as never[]) : undefined,
            f.partnerId ? eq(deals.partnerId, f.partnerId) : undefined,
            f.projectId ? sql`EXISTS (SELECT 1 FROM deal_projects dp WHERE dp.deal_id = ${deals.id} AND dp.project_id = ${f.projectId}::uuid)` : undefined,
            f.includeArchived ? undefined : isNull(deals.archivedAt),
            cursor ? sql`(${deals.createdAt}, ${deals.id}) > (${cursor.createdAt}, ${cursor.id}::uuid)` : undefined,
          ),
        )
        .orderBy(asc(deals.createdAt), asc(deals.id))
        .limit(500);
      if (!page.length) return;
      const ids = page.map((d) => d.id);
      const links = await ctx.app.db
        .select({ dealId: dealProjects.dealId, projectId: projects.id, name: projects.name })
        .from(dealProjects)
        .innerJoin(projects, eq(projects.id, dealProjects.projectId))
        .where(inArray(dealProjects.dealId, ids));
      const partnerRows = await ctx.app.db.select({ id: partners.id, name: partners.name }).from(partners).where(inArray(partners.id, [...new Set(page.map((d) => d.partnerId))]));
      const refs = await loadMemberRefs(ctx.app.db, ctx.actor.workspaceId, page.map((d) => d.ownerMembershipId));
      for (const d of page) {
        const pl = links.filter((l) => l.dealId === d.id);
        const amounts = canSeeDealAmounts(ctx, pl.map((l) => l.projectId));
        yield {
          id: d.id,
          title: d.title,
          partner: partnerRows.find((p) => p.id === d.partnerId)?.name ?? null,
          stage: d.stage,
          projects: pl.map((l) => l.name).join(', '),
          owner: refs.get(d.ownerMembershipId)?.displayName ?? null,
          expected_close_date: d.expectedCloseDate,
          amount: amounts && d.amountMinor !== null && d.currency ? formatMinor(d.amountMinor, d.currency) : null,
          currency: amounts ? d.currency : null,
          closed_at: d.closedAt?.toISOString() ?? null,
          created_at: d.createdAt.toISOString(),
        };
      }
      const last = page[page.length - 1]!;
      cursor = { createdAt: last.createdAt, id: last.id };
      if (page.length < 500) return;
    }
  },
});
