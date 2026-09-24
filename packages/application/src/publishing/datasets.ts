import { and, asc, eq, gte, inArray, isNull, lt, lte, sql } from 'drizzle-orm';
import { campaigns, contentItems, projects, publications, socialAccounts } from '@castlane/database';
import { CAMPAIGN_STATUSES, PLATFORMS, PUBLICATION_AVAILABILITY, PUBLICATION_STATUSES } from '@castlane/domain';
import { whereAll } from '../core/access';
import { defineExportDataset } from '../core/export-registry';
import { loadMemberRefs } from '../core/members';
import { accountLabel } from '../accounts/accounts';
import { asList } from '../accounts/datasets';
import { campaignProjectMap, campaignVisibility, publicationVisibility } from './scope';

/**
 * Export Center datasets "publications" and "campaigns" (§22.2). Rows are scoped exactly like the
 * module lists (permission predicate in SQL) and bounded by the export's as-of moment.
 */

const PAGE = 500;

defineExportDataset({
  key: 'publications',
  label: 'Publications',
  permission: 'publications.read',
  classification: 'normal',
  columns: [
    { key: 'id', label: 'Publication ID', type: 'id', default: true },
    { key: 'content_title', label: 'Content', type: 'text', default: true },
    { key: 'content_item_id', label: 'Content ID', type: 'id' },
    { key: 'content_version_no', label: 'Version', type: 'integer' },
    { key: 'account', label: 'Account', type: 'text', default: true },
    { key: 'platform', label: 'Platform', type: 'text', default: true },
    { key: 'project', label: 'Project', type: 'text', default: true },
    { key: 'owner', label: 'Owner', type: 'text', default: true },
    { key: 'status', label: 'Status', type: 'text', default: true },
    { key: 'availability', label: 'Availability', type: 'text', default: true },
    { key: 'scheduled_at', label: 'Scheduled At (UTC)', type: 'datetime', default: true },
    { key: 'schedule_timezone', label: 'Schedule Time Zone', type: 'text' },
    { key: 'original_scheduled_at', label: 'First Scheduled At (UTC)', type: 'datetime' },
    { key: 'actual_published_at', label: 'Actual Published At (UTC)', type: 'datetime', default: true },
    { key: 'external_post_url', label: 'Post URL', type: 'text', default: true },
    { key: 'no_url_reason', label: 'Missing URL Reason', type: 'text' },
    { key: 'primary_campaign', label: 'Primary Campaign', type: 'text' },
    { key: 'caption', label: 'Caption', type: 'text' },
    { key: 'historical_entry', label: 'Historical Entry', type: 'boolean' },
    { key: 'failure_reason', label: 'Failure Reason', type: 'text' },
    { key: 'cancel_reason', label: 'Cancel Reason', type: 'text' },
    { key: 'updated_at', label: 'Updated At', type: 'datetime' },
  ],
  filters: [
    { key: 'projectId', label: 'Project', type: 'reference', lookup: 'project' },
    { key: 'accountId', label: 'Account', type: 'reference', lookup: 'account' },
    { key: 'campaignId', label: 'Campaign', type: 'reference', lookup: 'campaign' },
    { key: 'status', label: 'Status', type: 'enum', enumValues: PUBLICATION_STATUSES },
    { key: 'availability', label: 'Availability', type: 'enum', enumValues: PUBLICATION_AVAILABILITY },
    { key: 'platform', label: 'Platform', type: 'enum', enumValues: PLATFORMS },
    { key: 'from', label: 'From', type: 'date' },
    { key: 'to', label: 'To', type: 'date' },
  ],
  async *rows(ctx, input) {
    const f = input.filters as { projectId?: string; accountId?: string; campaignId?: string; status?: unknown; availability?: unknown; platform?: unknown; from?: string; to?: string; includeArchived?: boolean };
    const status = asList(f.status);
    const availability = asList(f.availability);
    const platform = asList(f.platform);
    const when = sql`coalesce(${publications.actualPublishedAt}, ${publications.scheduledAt}, ${publications.createdAt})`;
    let cursor: { createdAt: Date; id: string } | null = null;
    for (;;) {
      const page: { p: typeof publications.$inferSelect; title: string; account: typeof socialAccounts.$inferSelect; projectName: string; campaignName: string | null; versionNo: number | null }[] = await ctx.app.db
        .select({
          p: publications,
          title: contentItems.title,
          account: socialAccounts,
          projectName: projects.name,
          campaignName: campaigns.name,
          versionNo: sql<number | null>`(SELECT cv.version_no FROM content_versions cv WHERE cv.id = ${publications.contentVersionId})`,
        })
        .from(publications)
        .innerJoin(contentItems, eq(contentItems.id, publications.contentItemId))
        .innerJoin(socialAccounts, eq(socialAccounts.id, publications.accountId))
        .innerJoin(projects, eq(projects.id, publications.projectId))
        .leftJoin(campaigns, eq(campaigns.id, publications.primaryCampaignId))
        .where(
          whereAll(
            eq(publications.workspaceId, ctx.actor.workspaceId),
            isNull(publications.deletedAt),
            publicationVisibility(ctx),
            lte(publications.createdAt, input.boundAt),
            f.includeArchived ? undefined : isNull(publications.archivedAt),
            f.projectId ? eq(publications.projectId, f.projectId) : undefined,
            f.accountId ? eq(publications.accountId, f.accountId) : undefined,
            f.campaignId ? eq(publications.primaryCampaignId, f.campaignId) : undefined,
            status.length ? inArray(publications.status, status as never[]) : undefined,
            availability.length ? inArray(publications.availability, availability as never[]) : undefined,
            platform.length ? inArray(socialAccounts.platform, platform as never[]) : undefined,
            f.from ? gte(when, new Date(`${f.from}T00:00:00Z`)) : undefined,
            f.to ? lt(when, new Date(new Date(`${f.to}T00:00:00Z`).getTime() + 86_400_000)) : undefined,
            cursor ? sql`(${publications.createdAt}, ${publications.id}) > (${cursor.createdAt}, ${cursor.id}::uuid)` : undefined,
          ),
        )
        .orderBy(asc(publications.createdAt), asc(publications.id))
        .limit(PAGE);
      if (!page.length) return;
      const refs = await loadMemberRefs(ctx.app.db, ctx.actor.workspaceId, page.map((r) => r.p.ownerMembershipId));
      for (const r of page)
        yield {
          id: r.p.id,
          content_title: r.title,
          content_item_id: r.p.contentItemId,
          content_version_no: r.versionNo === null ? null : Number(r.versionNo),
          account: accountLabel(r.account),
          platform: r.account.platform,
          project: r.projectName,
          owner: refs.get(r.p.ownerMembershipId)?.displayName ?? null,
          status: r.p.status,
          availability: r.p.availability,
          scheduled_at: r.p.scheduledAt?.toISOString() ?? null,
          schedule_timezone: r.p.scheduleTimezone,
          original_scheduled_at: r.p.originalScheduledAt?.toISOString() ?? null,
          actual_published_at: r.p.actualPublishedAt?.toISOString() ?? null,
          external_post_url: r.p.externalPostUrl,
          no_url_reason: r.p.noUrlReason,
          primary_campaign: r.campaignName,
          caption: r.p.caption,
          historical_entry: r.p.historicalEntry,
          failure_reason: r.p.failureReason,
          cancel_reason: r.p.cancelReason,
          updated_at: r.p.updatedAt.toISOString(),
        };
      const last = page[page.length - 1]!;
      cursor = { createdAt: last.p.createdAt, id: last.p.id };
      if (page.length < PAGE) return;
    }
  },
});

defineExportDataset({
  key: 'campaigns',
  label: 'Campaigns',
  permission: 'campaigns.read',
  classification: 'normal',
  columns: [
    { key: 'id', label: 'Campaign ID', type: 'id', default: true },
    { key: 'name', label: 'Name', type: 'text', default: true },
    { key: 'objective', label: 'Objective', type: 'text', default: true },
    { key: 'owner', label: 'Owner', type: 'text', default: true },
    { key: 'status', label: 'Status', type: 'text', default: true },
    { key: 'start_date', label: 'Start Date', type: 'date', default: true },
    { key: 'end_date', label: 'End Date', type: 'date', default: true },
    { key: 'projects', label: 'Projects', type: 'text', default: true },
    { key: 'tags', label: 'Tags', type: 'text' },
    { key: 'closing_summary', label: 'Closing Summary', type: 'text' },
    { key: 'closed_at', label: 'Closed At', type: 'datetime' },
    { key: 'created_at', label: 'Created At', type: 'datetime' },
  ],
  filters: [
    { key: 'status', label: 'Status', type: 'enum', enumValues: CAMPAIGN_STATUSES },
    { key: 'projectId', label: 'Project', type: 'reference', lookup: 'project' },
  ],
  async *rows(ctx, input) {
    const f = input.filters as { status?: unknown; projectId?: string; includeArchived?: boolean };
    const status = asList(f.status);
    let cursor: { createdAt: Date; id: string } | null = null;
    for (;;) {
      const page: (typeof campaigns.$inferSelect)[] = await ctx.app.db
        .select()
        .from(campaigns)
        .where(
          whereAll(
            eq(campaigns.workspaceId, ctx.actor.workspaceId),
            campaignVisibility(ctx),
            lte(campaigns.createdAt, input.boundAt),
            f.includeArchived || status.includes('archived') ? undefined : isNull(campaigns.archivedAt),
            status.length ? inArray(campaigns.status, status as never[]) : undefined,
            f.projectId ? sql`EXISTS (SELECT 1 FROM campaign_projects cp WHERE cp.campaign_id = ${campaigns.id} AND cp.project_id = ${f.projectId}::uuid)` : undefined,
            cursor ? sql`(${campaigns.createdAt}, ${campaigns.id}) > (${cursor.createdAt}, ${cursor.id}::uuid)` : undefined,
          ),
        )
        .orderBy(asc(campaigns.createdAt), asc(campaigns.id))
        .limit(PAGE);
      if (!page.length) return;
      const pm = await campaignProjectMap(ctx.app.db, ctx.actor.workspaceId, page.map((c) => c.id));
      const pids = [...new Set([...pm.values()].flat())];
      const names = new Map(
        (pids.length ? await ctx.app.db.select({ id: projects.id, name: projects.name }).from(projects).where(and(eq(projects.workspaceId, ctx.actor.workspaceId), inArray(projects.id, pids))) : []).map((p) => [p.id, p.name]),
      );
      const refs = await loadMemberRefs(ctx.app.db, ctx.actor.workspaceId, page.map((c) => c.ownerMembershipId));
      for (const c of page)
        yield {
          id: c.id,
          name: c.name,
          objective: c.objective,
          owner: refs.get(c.ownerMembershipId)?.displayName ?? null,
          status: c.status,
          start_date: c.startDate,
          end_date: c.endDate,
          projects: (pm.get(c.id) ?? []).map((p) => names.get(p) ?? p).join(', '),
          tags: c.tags.join(', '),
          closing_summary: c.closingSummary,
          closed_at: c.closedAt?.toISOString() ?? null,
          created_at: c.createdAt.toISOString(),
        };
      const last = page[page.length - 1]!;
      cursor = { createdAt: last.createdAt, id: last.id };
      if (page.length < PAGE) return;
    }
  },
});
