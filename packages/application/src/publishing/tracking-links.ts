import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { campaignSourceReports, campaigns, contentItems, publications, trackingLinks } from '@castlane/database';
import { AppError, buildTaggedUrl, newId, parseSafeUrl } from '@castlane/domain';
import { requirePermission, whereAll } from '../core/access';
import { audit, diffFields } from '../core/audit';
import { dbOf, type CommandContext, type QueryContext } from '../core/context';
import { emit } from '../core/events';
import { assertVersion, stamp, touch } from '../core/rows';
import { assertAssetUsable } from '../accounts/helpers';
import { loadUserMemberRefs } from '../media/assets';
import { campaignVisibility, canChangeCampaign, canPublication, loadCampaignRow } from './scope';

/**
 * Tracking links (Build Tagged URL) and campaign source reports (§12, S34). A tagged URL is an
 * ordinary link with URL-encoded UTM parameters — no redirect service, no server-side fetch, and no
 * click counter: clicks and conversions exist only as source reports someone entered (T070).
 */

export type TrackingLinkRowDb = typeof trackingLinks.$inferSelect;
type Utm = { utmSource?: string | null; utmMedium?: string | null; utmCampaign?: string | null; utmContent?: string | null; utmTerm?: string | null };

const UTM_MAP = [
  ['utmSource', 'utm_source'],
  ['utmMedium', 'utm_medium'],
  ['utmCampaign', 'utm_campaign'],
  ['utmContent', 'utm_content'],
  ['utmTerm', 'utm_term'],
] as const;

const utmParams = (u: Utm) => Object.fromEntries(UTM_MAP.map(([k, p]) => [p, u[k]?.trim() || undefined]).filter(([, v]) => v)) as Record<string, string>;

/** Preview: the built URL plus parameters that already exist on the destination with other values. */
export const previewTrackingLink = (destinationUrl: string, utm: Utm) => {
  const url = parseSafeUrl(destinationUrl, { httpsOnly: true });
  if (!url) return { valid: false, url: null, conflicts: [], message: 'Enter an https destination URL.' };
  const params = utmParams(utm);
  const built = buildTaggedUrl(destinationUrl, params);
  if (!built) return { valid: false, url: null, conflicts: [], message: 'Enter an https destination URL.' };
  const conflicts = built.conflicts.map((k) => ({ key: k, existing: url.searchParams.get(k) ?? '', proposed: params[k] ?? '' }));
  return { valid: true, url: built.url, conflicts, message: conflicts.length ? 'The destination already has different values for some parameters. They are kept unless you choose to replace them.' : null };
};

const buildOrFail = (destinationUrl: string, utm: Utm, overwrite: boolean) => {
  const p = previewTrackingLink(destinationUrl, utm);
  if (!p.valid || !p.url) throw new AppError('VALIDATION_FAILED', p.message ?? 'Enter an https destination URL.', { fieldErrors: [{ field: 'destinationUrl', code: 'INVALID', message: 'Enter an https destination URL.' }] });
  if (p.conflicts.length && !overwrite) {
    const fields = p.conflicts.map((c) => UTM_MAP.find(([, q]) => q === c.key)?.[0] ?? 'destinationUrl');
    throw new AppError('VALIDATION_FAILED', p.message!, {
      fieldErrors: fields.map((f) => ({ field: f, code: 'PARAMETER_EXISTS', message: 'The destination already has a different value for this parameter.' })),
      details: { conflicts: p.conflicts },
    });
  }
  return overwrite ? buildTaggedUrl(destinationUrl, utmParams(utm), { overwrite: true })!.url : p.url;
};

const toLinkRows = async (ctx: QueryContext | CommandContext, rows: TrackingLinkRowDb[]) => {
  if (!rows.length) return [];
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const campaignIds = [...new Set(rows.map((r) => r.campaignId))];
  const pubIds = [...new Set(rows.map((r) => r.publicationId).filter((x): x is string => !!x))];
  const camps = await db.select({ id: campaigns.id, name: campaigns.name }).from(campaigns).where(and(eq(campaigns.workspaceId, ws), inArray(campaigns.id, campaignIds)));
  const pubs = pubIds.length
    ? await db.select({ p: publications, title: contentItems.title }).from(publications).leftJoin(contentItems, eq(contentItems.id, publications.contentItemId)).where(and(eq(publications.workspaceId, ws), inArray(publications.id, pubIds)))
    : [];
  const clicks = await db
    .select({ linkId: campaignSourceReports.trackingLinkId, total: sql<string | null>`sum(${campaignSourceReports.clicks})::text`, known: sql<number>`count(${campaignSourceReports.clicks})` })
    .from(campaignSourceReports)
    .where(and(eq(campaignSourceReports.workspaceId, ws), inArray(campaignSourceReports.trackingLinkId, rows.map((r) => r.id))))
    .groupBy(campaignSourceReports.trackingLinkId);
  const names = new Map(camps.map((c) => [c.id, c.name]));
  const pubBy = new Map(pubs.filter((x) => canPublication(ctx, 'publications.read', x.p)).map((x) => [x.p.id, x.title ?? 'Content']));
  const clickBy = new Map(clicks.map((c) => [c.linkId, Number(c.known) > 0 ? c.total : null]));
  return rows.map((l) => ({
    id: l.id,
    campaign: { id: l.campaignId, name: names.get(l.campaignId) ?? 'Campaign' },
    label: l.label,
    destinationUrl: l.destinationUrl,
    utmSource: l.utmSource,
    utmMedium: l.utmMedium,
    utmCampaign: l.utmCampaign,
    utmContent: l.utmContent,
    utmTerm: l.utmTerm,
    builtUrl: l.builtUrl,
    publication: l.publicationId && pubBy.has(l.publicationId) ? { id: l.publicationId, title: pubBy.get(l.publicationId)! } : null,
    reportedClicks: clickBy.get(l.id) ?? null,
    archivedAt: l.archivedAt?.toISOString() ?? null,
    createdAt: l.createdAt.toISOString(),
    updatedAt: l.updatedAt.toISOString(),
    rowVersion: l.rowVersion,
  }));
};

export const listTrackingLinks = async (ctx: QueryContext, input: { campaignId?: string; publicationId?: string; q?: string; includeArchived?: boolean }) => {
  requirePermission(ctx, 'campaigns.read');
  if (input.campaignId) await loadCampaignRow(ctx, input.campaignId);
  const rows = await dbOf(ctx)
    .select({ l: trackingLinks })
    .from(trackingLinks)
    .innerJoin(campaigns, and(eq(campaigns.workspaceId, trackingLinks.workspaceId), eq(campaigns.id, trackingLinks.campaignId)))
    .where(
      whereAll(
        eq(trackingLinks.workspaceId, ctx.actor.workspaceId),
        campaignVisibility(ctx),
        input.includeArchived ? undefined : isNull(trackingLinks.archivedAt),
        input.campaignId ? eq(trackingLinks.campaignId, input.campaignId) : undefined,
        input.publicationId ? eq(trackingLinks.publicationId, input.publicationId) : undefined,
        input.q ? or(ilike(trackingLinks.label, `%${input.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`), ilike(trackingLinks.builtUrl, `%${input.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`)) : undefined,
      ),
    )
    .orderBy(asc(sql`${trackingLinks.archivedAt} IS NOT NULL`), desc(trackingLinks.createdAt), asc(trackingLinks.id))
    .limit(500);
  return toLinkRows(ctx, rows.map((r) => r.l));
};

const loadLink = async (ctx: QueryContext | CommandContext, id: string, opts: { lock?: boolean } = {}) => {
  const q = dbOf(ctx).select().from(trackingLinks).where(and(eq(trackingLinks.workspaceId, ctx.actor.workspaceId), eq(trackingLinks.id, id)));
  const [l] = opts.lock && 'tx' in ctx ? await q.for('update') : await q;
  if (!l) throw new AppError('NOT_FOUND', 'Tracking link was not found.');
  const c = await loadCampaignRow(ctx, l.campaignId);
  return { link: l, ...c };
};

export const getTrackingLink = async (ctx: QueryContext | CommandContext, id: string) => {
  const { link } = await loadLink(ctx, id);
  return (await toLinkRows(ctx, [link]))[0]!;
};

const assertPublicationForLink = async (ctx: CommandContext, publicationId: string, projectIds: string[]) => {
  const [p] = await ctx.tx.select().from(publications).where(and(eq(publications.workspaceId, ctx.actor.workspaceId), eq(publications.id, publicationId)));
  if (!p || p.deletedAt || !canPublication(ctx, 'publications.read', p)) throw new AppError('VALIDATION_FAILED', 'Choose a publication you can access.', { fieldErrors: [{ field: 'publicationId', code: 'NOT_FOUND', message: 'Choose a publication you can access.' }] });
  if (!projectIds.includes(p.projectId))
    throw new AppError('VALIDATION_FAILED', 'The publication belongs to a project outside this campaign.', { fieldErrors: [{ field: 'publicationId', code: 'OTHER_PROJECT', message: 'The publication belongs to a project outside this campaign.' }] });
};

export interface TrackingLinkInput extends Utm {
  label?: string;
  destinationUrl?: string;
  publicationId?: string | null;
  overwriteConflicts?: boolean;
}

export const createTrackingLink = async (ctx: CommandContext, campaignId: string, input: TrackingLinkInput & { label: string; destinationUrl: string }) => {
  const { campaign: c, projectIds } = await loadCampaignRow(ctx, campaignId);
  if (!canChangeCampaign(ctx, 'campaigns.write', c, projectIds)) throw new AppError('FORBIDDEN', 'You cannot change this campaign.');
  if (c.status === 'archived') throw new AppError('INVALID_STATE', 'Restore the campaign before adding links.');
  const builtUrl = buildOrFail(input.destinationUrl, input, !!input.overwriteConflicts);
  if (input.publicationId) await assertPublicationForLink(ctx, input.publicationId, projectIds);
  const id = newId();
  const [row] = await ctx.tx
    .insert(trackingLinks)
    .values({
      ...stamp(ctx),
      id,
      campaignId,
      label: input.label.trim(),
      destinationUrl: input.destinationUrl.trim(),
      utmSource: input.utmSource?.trim() || null,
      utmMedium: input.utmMedium?.trim() || null,
      utmCampaign: input.utmCampaign?.trim() || null,
      utmContent: input.utmContent?.trim() || null,
      utmTerm: input.utmTerm?.trim() || null,
      builtUrl,
      publicationId: input.publicationId ?? null,
    })
    .returning();
  await audit(ctx, { action: 'campaign.tracking_link_created', entityType: 'campaign', entityId: campaignId, projectId: projectIds[0] ?? null, metadata: { trackingLinkId: id, label: row!.label } });
  await emit(ctx, { type: 'tracking_link.created', entityType: 'tracking_link', entityId: id, revision: 1, payload: { campaignId } });
  return id;
};

export const updateTrackingLink = async (ctx: CommandContext, id: string, input: TrackingLinkInput) => {
  const { link: l, campaign: c, projectIds } = await loadLink(ctx, id, { lock: true });
  if (!canChangeCampaign(ctx, 'campaigns.write', c, projectIds)) throw new AppError('FORBIDDEN', 'You cannot change this campaign.');
  assertVersion(ctx, l);
  if (l.archivedAt) throw new AppError('INVALID_STATE', 'Restore the link before editing it.');
  const next = {
    label: input.label?.trim() ?? l.label,
    destinationUrl: input.destinationUrl?.trim() ?? l.destinationUrl,
    utmSource: input.utmSource !== undefined ? input.utmSource?.trim() || null : l.utmSource,
    utmMedium: input.utmMedium !== undefined ? input.utmMedium?.trim() || null : l.utmMedium,
    utmCampaign: input.utmCampaign !== undefined ? input.utmCampaign?.trim() || null : l.utmCampaign,
    utmContent: input.utmContent !== undefined ? input.utmContent?.trim() || null : l.utmContent,
    utmTerm: input.utmTerm !== undefined ? input.utmTerm?.trim() || null : l.utmTerm,
    publicationId: input.publicationId !== undefined ? input.publicationId : l.publicationId,
  };
  if (next.publicationId && next.publicationId !== l.publicationId) await assertPublicationForLink(ctx, next.publicationId, projectIds);
  const builtUrl = buildOrFail(next.destinationUrl, next, !!input.overwriteConflicts);
  const [row] = await ctx.tx.update(trackingLinks).set({ ...next, builtUrl, ...touch(ctx, trackingLinks) }).where(eq(trackingLinks.id, id)).returning();
  await audit(ctx, {
    action: 'campaign.tracking_link_updated',
    entityType: 'campaign',
    entityId: l.campaignId,
    projectId: projectIds[0] ?? null,
    diff: diffFields(l, row!, ['label', 'destinationUrl', 'utmSource', 'utmMedium', 'utmCampaign', 'utmContent', 'utmTerm', 'publicationId', 'builtUrl']),
    metadata: { trackingLinkId: id },
  });
  await emit(ctx, { type: 'tracking_link.updated', entityType: 'tracking_link', entityId: id, revision: row!.rowVersion, payload: { campaignId: l.campaignId } });
  return id;
};

export const archiveTrackingLink = async (ctx: CommandContext, id: string, input: { restore?: boolean; reason?: string }, opts: { skipVersion?: boolean } = {}) => {
  const { link: l, campaign: c, projectIds } = await loadLink(ctx, id, { lock: true });
  if (!canChangeCampaign(ctx, 'campaigns.write', c, projectIds)) throw new AppError('FORBIDDEN', 'You cannot change this campaign.');
  if (!opts.skipVersion) assertVersion(ctx, l);
  if (!!l.archivedAt === !input.restore) throw new AppError('INVALID_STATE', input.restore ? 'The link is not archived.' : 'The link is already archived.');
  const at = ctx.app.clock.now();
  const [row] = await ctx.tx
    .update(trackingLinks)
    .set(input.restore ? { archivedAt: null, archivedBy: null, archiveReason: null, ...touch(ctx, trackingLinks) } : { archivedAt: at, archivedBy: ctx.actor.userId, archiveReason: input.reason ?? null, ...touch(ctx, trackingLinks) })
    .where(eq(trackingLinks.id, id))
    .returning();
  await audit(ctx, { action: input.restore ? 'campaign.tracking_link_restored' : 'campaign.tracking_link_archived', entityType: 'campaign', entityId: l.campaignId, projectId: projectIds[0] ?? null, reason: input.reason, metadata: { trackingLinkId: id } });
  await emit(ctx, { type: 'tracking_link.archived', entityType: 'tracking_link', entityId: id, revision: row!.rowVersion, payload: { campaignId: l.campaignId } });
  return id;
};

// ——— Source reports ———

type ReportRow = typeof campaignSourceReports.$inferSelect;

const toReportRows = async (ctx: QueryContext | CommandContext, rows: ReportRow[]) => {
  if (!rows.length) return [];
  const db = dbOf(ctx);
  const linkIds = [...new Set(rows.map((r) => r.trackingLinkId).filter((x): x is string => !!x))];
  const links = linkIds.length ? await db.select({ id: trackingLinks.id, label: trackingLinks.label }).from(trackingLinks).where(and(eq(trackingLinks.workspaceId, ctx.actor.workspaceId), inArray(trackingLinks.id, linkIds))) : [];
  const authors = await loadUserMemberRefs(db, ctx.actor.workspaceId, rows.map((r) => r.createdBy));
  const labels = new Map(links.map((l) => [l.id, l.label]));
  return rows.map((r) => ({
    id: r.id,
    campaignId: r.campaignId,
    sourceName: r.sourceName,
    periodStart: r.periodStart.toISOString(),
    periodEnd: r.periodEnd.toISOString(),
    clicks: r.clicks,
    conversions: r.conversions,
    attributionLabel: r.attributionLabel as 'source_reported' | 'manual_assignment' | 'unattributed',
    trackingLink: r.trackingLinkId ? { id: r.trackingLinkId, label: labels.get(r.trackingLinkId) ?? 'Link' } : null,
    evidenceAssetId: r.evidenceAssetId,
    note: r.note,
    enteredBy: r.createdBy ? (authors.get(r.createdBy) ?? null) : null,
    createdAt: r.createdAt.toISOString(),
    rowVersion: r.rowVersion,
  }));
};

export const listSourceReports = async (ctx: QueryContext, campaignId: string) => {
  await loadCampaignRow(ctx, campaignId);
  const rows = await dbOf(ctx)
    .select()
    .from(campaignSourceReports)
    .where(and(eq(campaignSourceReports.workspaceId, ctx.actor.workspaceId), eq(campaignSourceReports.campaignId, campaignId)))
    .orderBy(desc(campaignSourceReports.periodStart), asc(campaignSourceReports.id));
  return toReportRows(ctx, rows);
};

export interface SourceReportInput {
  sourceName?: string;
  periodStart?: string;
  periodEnd?: string;
  clicks?: number | null;
  conversions?: number | null;
  attributionLabel?: 'source_reported' | 'manual_assignment' | 'unattributed';
  trackingLinkId?: string | null;
  evidenceAssetId?: string | null;
  note?: string | null;
}

const validateReport = async (ctx: CommandContext, campaignId: string, v: Required<Pick<SourceReportInput, 'periodStart' | 'periodEnd' | 'attributionLabel'>> & SourceReportInput) => {
  const errors: { field: string; code: string; message: string }[] = [];
  const start = new Date(v.periodStart);
  const end = new Date(v.periodEnd);
  if (end.getTime() <= start.getTime()) errors.push({ field: 'periodEnd', code: 'BEFORE_START', message: 'The period must end after it starts.' });
  if (end.getTime() > ctx.app.clock.now().getTime() + 5 * 60_000) errors.push({ field: 'periodEnd', code: 'IN_FUTURE', message: 'Reported results cannot cover a future period.' });
  if (v.attributionLabel === 'manual_assignment' && !v.note?.trim()) errors.push({ field: 'note', code: 'REQUIRED', message: 'Explain the manual assignment (who assigned it and why).' });
  if (v.clicks == null && v.conversions == null) errors.push({ field: 'clicks', code: 'NO_VALUES', message: 'Enter at least one reported value. Leave a value empty when the source does not report it.' });
  if (v.trackingLinkId) {
    const [l] = await ctx.tx.select({ campaignId: trackingLinks.campaignId }).from(trackingLinks).where(and(eq(trackingLinks.workspaceId, ctx.actor.workspaceId), eq(trackingLinks.id, v.trackingLinkId)));
    if (!l || l.campaignId !== campaignId) errors.push({ field: 'trackingLinkId', code: 'NOT_FOUND', message: 'Choose a tracking link of this campaign.' });
  }
  if (errors.length) throw new AppError('VALIDATION_FAILED', errors[0]!.message, { fieldErrors: errors });
  if (v.evidenceAssetId) await assertAssetUsable(ctx, v.evidenceAssetId, 'evidenceAssetId');
};

export const createSourceReport = async (ctx: CommandContext, campaignId: string, input: SourceReportInput & { sourceName: string; periodStart: string; periodEnd: string; attributionLabel: 'source_reported' | 'manual_assignment' | 'unattributed' }) => {
  const { campaign: c, projectIds } = await loadCampaignRow(ctx, campaignId);
  if (!canChangeCampaign(ctx, 'campaigns.write', c, projectIds)) throw new AppError('FORBIDDEN', 'You cannot change this campaign.');
  if (c.status === 'archived') throw new AppError('INVALID_STATE', 'Restore the campaign before adding reports.');
  await validateReport(ctx, campaignId, input);
  const id = newId();
  const [row] = await ctx.tx
    .insert(campaignSourceReports)
    .values({
      ...stamp(ctx),
      id,
      campaignId,
      sourceName: input.sourceName.trim(),
      periodStart: new Date(input.periodStart),
      periodEnd: new Date(input.periodEnd),
      clicks: input.clicks ?? null,
      conversions: input.conversions ?? null,
      attributionLabel: input.attributionLabel,
      trackingLinkId: input.trackingLinkId ?? null,
      evidenceAssetId: input.evidenceAssetId ?? null,
      note: input.note?.trim() || null,
    })
    .returning();
  await audit(ctx, { action: 'campaign.source_report_added', entityType: 'campaign', entityId: campaignId, projectId: projectIds[0] ?? null, metadata: { reportId: id, source: row!.sourceName, attribution: row!.attributionLabel } });
  await emit(ctx, { type: 'campaign.source_report_added', entityType: 'campaign', entityId: campaignId, payload: { reportId: id } });
  return (await toReportRows(ctx, [row!]))[0]!;
};

export const updateSourceReport = async (ctx: CommandContext, reportId: string, input: SourceReportInput & { reason: string }) => {
  const [r] = await ctx.tx.select().from(campaignSourceReports).where(and(eq(campaignSourceReports.workspaceId, ctx.actor.workspaceId), eq(campaignSourceReports.id, reportId))).for('update');
  if (!r) throw new AppError('NOT_FOUND', 'Report was not found.');
  const { campaign: c, projectIds } = await loadCampaignRow(ctx, r.campaignId);
  if (!canChangeCampaign(ctx, 'campaigns.write', c, projectIds)) throw new AppError('FORBIDDEN', 'You cannot change this campaign.');
  assertVersion(ctx, r);
  const next = {
    sourceName: input.sourceName?.trim() ?? r.sourceName,
    periodStart: input.periodStart ?? r.periodStart.toISOString(),
    periodEnd: input.periodEnd ?? r.periodEnd.toISOString(),
    clicks: input.clicks !== undefined ? input.clicks : r.clicks,
    conversions: input.conversions !== undefined ? input.conversions : r.conversions,
    attributionLabel: input.attributionLabel ?? (r.attributionLabel as 'source_reported' | 'manual_assignment' | 'unattributed'),
    trackingLinkId: input.trackingLinkId !== undefined ? input.trackingLinkId : r.trackingLinkId,
    evidenceAssetId: input.evidenceAssetId !== undefined ? input.evidenceAssetId : r.evidenceAssetId,
    note: input.note !== undefined ? input.note?.trim() || null : r.note,
  };
  await validateReport(ctx, r.campaignId, next);
  const [row] = await ctx.tx
    .update(campaignSourceReports)
    .set({ ...next, periodStart: new Date(next.periodStart), periodEnd: new Date(next.periodEnd), ...touch(ctx, campaignSourceReports) })
    .where(eq(campaignSourceReports.id, reportId))
    .returning();
  await audit(ctx, {
    action: 'campaign.source_report_corrected',
    entityType: 'campaign',
    entityId: r.campaignId,
    projectId: projectIds[0] ?? null,
    reason: input.reason,
    diff: diffFields(r, row!, ['sourceName', 'periodStart', 'periodEnd', 'clicks', 'conversions', 'attributionLabel', 'trackingLinkId', 'evidenceAssetId', 'note']),
    metadata: { reportId },
  });
  await emit(ctx, { type: 'campaign.source_report_corrected', entityType: 'campaign', entityId: r.campaignId, payload: { reportId } });
  return (await toReportRows(ctx, [row!]))[0]!;
};

