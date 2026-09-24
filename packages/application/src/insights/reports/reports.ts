import { and, desc, eq, ilike, inArray, isNotNull, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { hasAnywhere } from '@castlane/authorization';
import { memberships, reportSchedules, reportSnapshots, savedReportVersions, savedReports, type SavedReportConfig } from '@castlane/database';
import { reportConfig as reportConfigSchema, type ReportConfig, type ReportDetail, type ReportResult, type ReportSnapshotDetail, type ReportSnapshotSummary, type ReportSummary } from '@castlane/api-contracts';
import { AppError, clampPageSize, decodeCursor, encodeCursor, newId, notFound } from '@castlane/domain';
import { requirePermission } from '../../core/access';
import { defineArchiveHandler, tableArchiveList } from '../../core/archive-registry';
import { audit, diffFields } from '../../core/audit';
import { all, dbOf, type CommandContext, type QueryContext } from '../../core/context';
import { emit } from '../../core/events';
import { isActiveMember, loadMemberRefs, refOrUnknown } from '../../core/members';
import { notify } from '../../core/notify';
import { assertVersion, lockById, stamp, touch } from '../../core/rows';
import { type Ctx } from '../common';
import { REPORT_DATASET_SPECS, listReportDatasets, reportSourceChangedSince, runReport, validateReportConfig, type RunOptions } from './engine';
import { toScheduleRows } from './schedules';

type ReportRow = typeof savedReports.$inferSelect;
type SnapshotRow = typeof reportSnapshots.$inferSelect;

const me = (ctx: Ctx) => ctx.actor.membershipId ?? '00000000-0000-4000-8000-000000000000';

/** Parse a stored configuration with today's defaults (older versions may omit optional keys). */
export const parseReportConfig = (c: SavedReportConfig): ReportConfig => {
  const r = reportConfigSchema.safeParse(c);
  if (r.success) return r.data;
  return reportConfigSchema.parse({ dataset: c.dataset, dimensions: [], metrics: c.metrics?.length ? c.metrics : ['M01'], filters: {} });
};

/** Owner, or a member the report is shared with — anyone else gets 404 (existence is not revealed). */
export const canReadReport = (ctx: Ctx, r: Pick<ReportRow, 'ownerMembershipId' | 'sharing' | 'sharedWithMembershipIds'>) =>
  r.ownerMembershipId === me(ctx) || (r.sharing === 'shared' && r.sharedWithMembershipIds.includes(me(ctx)));

const canEdit = (ctx: Ctx, r: ReportRow) => r.ownerMembershipId === me(ctx) || ctx.actor.access.isOwner;

export const loadReadableReport = async (ctx: Ctx, id: string) => {
  requirePermission(ctx, 'reports.read');
  const [r] = await dbOf(ctx).select().from(savedReports).where(and(eq(savedReports.workspaceId, ctx.actor.workspaceId), eq(savedReports.id, id)));
  if (!r || !canReadReport(ctx, r)) throw notFound('Report');
  return r;
};

const lockEditable = async (ctx: CommandContext, id: string) => {
  requirePermission(ctx, 'reports.read');
  const r = await lockById(ctx, savedReports, id, 'Report');
  if (!canReadReport(ctx, r)) throw notFound('Report');
  if (!canEdit(ctx, r)) throw new AppError('FORBIDDEN', 'Only the report owner can change it. Duplicate it to make your own version.');
  return r;
};

const toSummaries = async (ctx: Ctx, rows: ReportRow[]): Promise<ReportSummary[]> => {
  if (!rows.length) return [];
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const ids = rows.map((r) => r.id);
  const [refs, sched, snaps] = await all(ctx, [
    () => loadMemberRefs(db, ws, rows.map((r) => r.ownerMembershipId)),
    () => db.select({ reportId: reportSchedules.reportId }).from(reportSchedules).where(and(eq(reportSchedules.workspaceId, ws), inArray(reportSchedules.reportId, ids), eq(reportSchedules.active, true))),
    () =>
      db
        .select({ reportId: reportSnapshots.reportId, last: sql<Date>`max(${reportSnapshots.asOf})` })
        .from(reportSnapshots)
        .where(and(eq(reportSnapshots.workspaceId, ws), inArray(reportSnapshots.reportId, ids), eq(reportSnapshots.generatedForMembershipId, me(ctx))))
        .groupBy(reportSnapshots.reportId),
  ] as const);
  return rows.map((r) => {
    const last = snaps.find((s) => s.reportId === r.id)?.last;
    return {
      id: r.id,
      name: r.name,
      dataset: r.dataset as ReportSummary['dataset'],
      owner: refOrUnknown(refs, r.ownerMembershipId)!,
      own: r.ownerMembershipId === me(ctx),
      sharing: r.sharing,
      configVersion: r.configVersion,
      scheduled: sched.some((s) => s.reportId === r.id),
      lastSnapshotAt: last ? new Date(last).toISOString() : null,
      archivedAt: r.archivedAt?.toISOString() ?? null,
      updatedAt: r.updatedAt.toISOString(),
      rowVersion: r.rowVersion,
    };
  });
};

export const listReports = async (ctx: QueryContext, input: { cursor?: string; pageSize?: number; q?: string; scope: 'all' | 'mine' | 'shared'; includeArchived?: boolean }) => {
  requirePermission(ctx, 'reports.read');
  const size = clampPageSize(input.pageSize);
  const c = input.cursor ? decodeCursor(input.cursor) : null;
  const r = savedReports;
  const mine = eq(r.ownerMembershipId, me(ctx));
  const shared = and(eq(r.sharing, 'shared'), sql`${me(ctx)}::uuid = ANY(${r.sharedWithMembershipIds})`);
  const rows = await ctx.app.db
    .select()
    .from(r)
    .where(
      and(
        eq(r.workspaceId, ctx.actor.workspaceId),
        input.scope === 'mine' ? mine : input.scope === 'shared' ? and(shared, sql`${r.ownerMembershipId} <> ${me(ctx)}`) : or(mine, shared),
        input.includeArchived ? undefined : isNull(r.archivedAt),
        input.q ? ilike(r.name, `%${input.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`) : undefined,
        c ? or(lt(r.updatedAt, new Date(String(c.v[0]))), and(eq(r.updatedAt, new Date(String(c.v[0]))), lt(r.id, c.id))) : undefined,
      ),
    )
    .orderBy(desc(r.updatedAt), desc(r.id))
    .limit(size + 1);
  const hasMore = rows.length > size;
  const pageRows = hasMore ? rows.slice(0, size) : rows;
  const last = pageRows[pageRows.length - 1];
  return { items: await toSummaries(ctx, pageRows), hasMore, nextCursor: hasMore && last ? encodeCursor({ v: [last.updatedAt.toISOString()], id: last.id }) : null };
};

export const getReport = async (ctx: Ctx, id: string): Promise<ReportDetail> => {
  const r = await loadReadableReport(ctx, id);
  const db = dbOf(ctx);
  const [summary] = await toSummaries(ctx, [r]);
  const refs = await loadMemberRefs(db, ctx.actor.workspaceId, r.sharedWithMembershipIds);
  const owner = r.ownerMembershipId === me(ctx);
  const schedules = await db
    .select()
    .from(reportSchedules)
    .where(and(eq(reportSchedules.workspaceId, ctx.actor.workspaceId), eq(reportSchedules.reportId, r.id), owner ? undefined : eq(reportSchedules.ownerMembershipId, me(ctx))))
    .orderBy(desc(reportSchedules.createdAt));
  const datasetAvailable = listReportDatasets(ctx).some((d) => d.key === r.dataset);
  const archived = !!r.archivedAt;
  const edit = canEdit(ctx, r) && hasAnywhere(ctx.actor.access, 'reports.create');
  return {
    ...summary!,
    config: parseReportConfig(r.config),
    sharedWith: r.sharedWithMembershipIds.map((m) => refOrUnknown(refs, m)!),
    duplicatedFromId: r.duplicatedFromId,
    schedules: await toScheduleRows(ctx, schedules),
    datasetAvailable,
    permissions: {
      edit: edit && !archived,
      share: canEdit(ctx, r) && hasAnywhere(ctx.actor.access, 'reports.share') && !archived,
      schedule: hasAnywhere(ctx.actor.access, 'reports.schedule') && !archived && datasetAvailable,
      archive: edit,
      duplicate: hasAnywhere(ctx.actor.access, 'reports.create') && datasetAvailable,
      snapshot: datasetAvailable && !archived,
      export: datasetAvailable && hasAnywhere(ctx.actor.access, 'exports.create'),
    },
  };
};

const insertVersion = async (ctx: CommandContext, reportId: string, versionNo: number, name: string, config: SavedReportConfig, changeNote?: string | null) => {
  await ctx.tx.insert(savedReportVersions).values({ ...stamp(ctx), id: newId(), reportId, versionNo, name, config, changeNote: changeNote ?? null });
};

export const createReport = async (ctx: CommandContext, input: { name: string; config: ReportConfig }) => {
  requirePermission(ctx, 'reports.create');
  if (!ctx.actor.membershipId) throw new AppError('FORBIDDEN', 'Only members can save reports.');
  validateReportConfig(ctx, input.config);
  const id = newId();
  const config = input.config as SavedReportConfig;
  await ctx.tx.insert(savedReports).values({ ...stamp(ctx), id, name: input.name.trim(), dataset: input.config.dataset, config, configVersion: 1, ownerMembershipId: ctx.actor.membershipId, sharing: 'private' });
  await insertVersion(ctx, id, 1, input.name.trim(), config, 'Created');
  await audit(ctx, { action: 'saved_report.created', entityType: 'saved_report', entityId: id, metadata: { name: input.name, dataset: input.config.dataset, metrics: input.config.metrics } });
  await emit(ctx, { type: 'saved_report.created', entityType: 'saved_report', entityId: id, revision: 1 });
  return id;
};

export const updateReport = async (ctx: CommandContext, id: string, input: { name?: string; config?: ReportConfig; changeNote?: string }) => {
  requirePermission(ctx, 'reports.create');
  const r = await lockEditable(ctx, id);
  assertVersion(ctx, r);
  if (r.archivedAt) throw new AppError('INVALID_STATE', 'Restore the report before changing it.');
  const config = input.config ?? parseReportConfig(r.config);
  if (input.config) validateReportConfig(ctx, input.config, { shared: r.sharing === 'shared' });
  const name = input.name?.trim() ?? r.name;
  const changed = name !== r.name || (input.config && JSON.stringify(input.config) !== JSON.stringify(parseReportConfig(r.config)));
  if (!changed) return id;
  const versionNo = r.configVersion + 1;
  await ctx.tx
    .update(savedReports)
    .set({ name, dataset: config.dataset, config: config as SavedReportConfig, configVersion: versionNo, ...touch(ctx, savedReports) })
    .where(eq(savedReports.id, id));
  await insertVersion(ctx, id, versionNo, name, config as SavedReportConfig, input.changeNote);
  await audit(ctx, { action: 'saved_report.updated', entityType: 'saved_report', entityId: id, diff: diffFields({ name: r.name, configVersion: r.configVersion }, { name, configVersion: versionNo }, ['name', 'configVersion']), reason: input.changeNote ?? null });
  await emit(ctx, { type: 'saved_report.updated', entityType: 'saved_report', entityId: id, revision: r.rowVersion + 1 });
  return id;
};

export const listReportVersions = async (ctx: QueryContext, id: string) => {
  await loadReadableReport(ctx, id);
  const rows = await ctx.app.db.select().from(savedReportVersions).where(and(eq(savedReportVersions.workspaceId, ctx.actor.workspaceId), eq(savedReportVersions.reportId, id))).orderBy(desc(savedReportVersions.versionNo));
  const userIds = [...new Set(rows.map((r) => r.createdBy).filter((x): x is string => !!x))];
  const ms = userIds.length
    ? await ctx.app.db.select({ id: memberships.id, userId: memberships.userId }).from(memberships).where(and(eq(memberships.workspaceId, ctx.actor.workspaceId), inArray(memberships.userId, userIds)))
    : [];
  const memberOf = new Map(ms.map((m) => [m.userId, m.id]));
  const people = await loadMemberRefs(ctx.app.db, ctx.actor.workspaceId, ms.map((m) => m.id));
  return rows.map((v) => ({
    versionNo: v.versionNo,
    name: v.name,
    config: parseReportConfig(v.config),
    changeNote: v.changeNote,
    createdAt: v.createdAt.toISOString(),
    createdBy: v.createdBy && memberOf.get(v.createdBy) ? refOrUnknown(people, memberOf.get(v.createdBy)) : null,
  }));
};

export const duplicateReport = async (ctx: CommandContext, id: string, input: { name?: string }) => {
  requirePermission(ctx, 'reports.create');
  const r = await loadReadableReport(ctx, id);
  const config = parseReportConfig(r.config);
  const name = (input.name?.trim() || `Copy of ${r.name}`).slice(0, 120);
  const newReportId = await createReport(ctx, { name, config });
  await ctx.tx.update(savedReports).set({ duplicatedFromId: r.id }).where(eq(savedReports.id, newReportId));
  await audit(ctx, { action: 'saved_report.duplicated', entityType: 'saved_report', entityId: newReportId, metadata: { from: r.id } });
  return newReportId;
};

/** Share Internally: members see the report and run it in their own scope; no access to source data is granted. */
export const shareReport = async (ctx: CommandContext, id: string, input: { sharing: 'private' | 'shared'; memberIds: string[] }) => {
  requirePermission(ctx, 'reports.share');
  const r = await lockEditable(ctx, id);
  assertVersion(ctx, r);
  if (r.archivedAt) throw new AppError('INVALID_STATE', 'Restore the report before sharing it.');
  const members = input.sharing === 'shared' ? [...new Set(input.memberIds.filter((m) => m !== r.ownerMembershipId))] : [];
  if (input.sharing === 'shared' && !members.length) throw new AppError('VALIDATION_FAILED', 'Choose at least one member.', { fieldErrors: [{ field: 'memberIds', code: 'REQUIRED', message: 'Choose at least one member.' }] });
  for (const m of members)
    if (!(await isActiveMember(ctx.tx, ctx.actor.workspaceId, m))) throw new AppError('VALIDATION_FAILED', 'Only active members can receive a report.', { fieldErrors: [{ field: 'memberIds', code: 'INACTIVE', message: 'Only active members can receive a report.' }] });
  if (input.sharing === 'shared') validateReportConfig(ctx, parseReportConfig(r.config), { shared: true });
  await ctx.tx.update(savedReports).set({ sharing: input.sharing, sharedWithMembershipIds: members, ...touch(ctx, savedReports) }).where(eq(savedReports.id, id));
  const added = members.filter((m) => !r.sharedWithMembershipIds.includes(m));
  await audit(ctx, { action: 'saved_report.shared', entityType: 'saved_report', entityId: id, diff: { sharing: { from: r.sharing, to: input.sharing }, sharedWith: { from: r.sharedWithMembershipIds, to: members } } });
  await emit(ctx, { type: 'saved_report.shared', entityType: 'saved_report', entityId: id, revision: r.rowVersion + 1 });
  if (added.length)
    await notify(ctx.tx, {
      workspaceId: ctx.actor.workspaceId,
      recipientMembershipIds: added,
      eventType: 'report.shared',
      eventKey: `report.shared:${id}:${r.rowVersion + 1}`,
      kind: 'general',
      title: `Report shared with you: ${r.name}`,
      excerpt: 'You see the results of the data you already have access to.',
      entityType: 'saved_report',
      entityId: id,
      actorMembershipId: ctx.actor.membershipId,
      at: ctx.app.clock.now(),
    });
  return id;
};

const pauseSchedulesOf = async (ctx: CommandContext, reportId: string, reason: string) => {
  await ctx.tx
    .update(reportSchedules)
    .set({ active: false, pausedReason: reason, ...touch(ctx, reportSchedules) })
    .where(and(eq(reportSchedules.workspaceId, ctx.actor.workspaceId), eq(reportSchedules.reportId, reportId), eq(reportSchedules.active, true)));
};

export const archiveReport = async (ctx: CommandContext, id: string, input: { reason?: string }, opts: { skipVersion?: boolean } = {}) => {
  const r = await lockEditable(ctx, id);
  if (!opts.skipVersion) assertVersion(ctx, r);
  if (r.archivedAt) throw new AppError('INVALID_STATE', 'This report is already archived.');
  await ctx.tx.update(savedReports).set({ archivedAt: ctx.app.clock.now(), archivedBy: ctx.actor.userId, archiveReason: input.reason ?? null, ...touch(ctx, savedReports) }).where(eq(savedReports.id, id));
  await pauseSchedulesOf(ctx, id, 'report_archived');
  await audit(ctx, { action: 'saved_report.archived', entityType: 'saved_report', entityId: id, reason: input.reason ?? null });
  await emit(ctx, { type: 'saved_report.archived', entityType: 'saved_report', entityId: id });
  return id;
};

export const restoreReport = async (ctx: CommandContext, id: string, opts: { skipVersion?: boolean } = {}) => {
  const r = await lockEditable(ctx, id);
  if (!opts.skipVersion) assertVersion(ctx, r);
  if (!r.archivedAt) throw new AppError('INVALID_STATE', 'This report is not archived.');
  await ctx.tx.update(savedReports).set({ archivedAt: null, archivedBy: null, archiveReason: null, ...touch(ctx, savedReports) }).where(eq(savedReports.id, id));
  await audit(ctx, { action: 'saved_report.restored', entityType: 'saved_report', entityId: id });
  await emit(ctx, { type: 'saved_report.restored', entityType: 'saved_report', entityId: id });
  return id;
};

const stripPeriod = (r: Awaited<ReturnType<typeof runReport>>): ReportResult => {
  const { period$: _p, ...rest } = r;
  return rest;
};

/** Run a saved report in the member's own scope (shared reports never widen access). */
export const runSavedReport = async (ctx: QueryContext, id: string, input: RunOptions) => {
  const r = await loadReadableReport(ctx, id);
  return stripPeriod(await runReport(ctx, parseReportConfig(r.config), input));
};

export const previewReport = async (ctx: QueryContext, config: ReportConfig) => {
  requirePermission(ctx, 'reports.create');
  return stripPeriod(await runReport(ctx, config, { limit: 50 }));
};

// ——— Snapshots ———

export const snapshotSummary = (s: SnapshotRow, reportName: string): ReportSnapshotSummary => {
  const result = s.result as unknown as ReportResult;
  const params = s.params as { configVersion?: number; scheduleId?: string | null };
  return {
    id: s.id,
    reportId: s.reportId,
    reportName,
    configVersion: params.configVersion ?? 1,
    asOf: s.asOf.toISOString(),
    fromDate: result.period?.fromDate ?? s.asOf.toISOString().slice(0, 10),
    toDate: result.period?.toDate ?? s.asOf.toISOString().slice(0, 10),
    rowCount: result.rowCount ?? result.rows?.length ?? 0,
    scheduled: !!params.scheduleId,
    sourceRevised: s.sourceRevised,
    createdAt: s.createdAt.toISOString(),
  };
};

/** Immutable snapshot of the member's result with as-of time and source bounds. */
export const createReportSnapshot = async (ctx: CommandContext, reportId: string, input: RunOptions, opts: { scheduleId?: string; runKey?: string; forMembershipId?: string; report?: ReportRow } = {}) => {
  const r = opts.report ?? (await loadReadableReport(ctx, reportId));
  if (r.archivedAt && !opts.scheduleId) throw new AppError('INVALID_STATE', 'Restore the report before saving a snapshot.');
  const config = parseReportConfig(r.config);
  const result = await runReport(ctx, config, input);
  const id = newId();
  const forMember = opts.forMembershipId ?? me(ctx);
  await ctx.tx.insert(reportSnapshots).values({
    ...stamp(ctx),
    id,
    reportId: r.id,
    configSnapshot: { ...(config as SavedReportConfig), datePolicy: input.datePolicy ?? config.datePolicy, filters: input.filters ?? config.filters },
    generatedForMembershipId: forMember,
    asOf: new Date(result.asOf),
    sourceBounds: { start: result.period.start, end: result.period.end, asOf: result.asOf, dataset: config.dataset, datasetTables: REPORT_DATASET_SPECS[config.dataset].sources.length },
    params: { configVersion: r.configVersion, scheduleId: opts.scheduleId ?? null, runKey: opts.runKey ?? null, overrides: { datePolicy: input.datePolicy ?? null, filters: input.filters ?? null } },
    result: stripPeriod(result) as unknown as Record<string, unknown>,
  });
  await audit(ctx, { action: 'report_snapshot.created', entityType: 'report_snapshot', entityId: id, metadata: { reportId: r.id, configVersion: r.configVersion, scheduleId: opts.scheduleId ?? null, generatedFor: forMember } });
  await emit(ctx, { type: 'report_snapshot.created', entityType: 'report_snapshot', entityId: id, revision: 1 });
  return id;
};

export const listReportSnapshots = async (ctx: QueryContext, reportId: string) => {
  const r = await loadReadableReport(ctx, reportId);
  const rows = await ctx.app.db
    .select()
    .from(reportSnapshots)
    .where(and(eq(reportSnapshots.workspaceId, ctx.actor.workspaceId), eq(reportSnapshots.reportId, reportId), eq(reportSnapshots.generatedForMembershipId, me(ctx))))
    .orderBy(desc(reportSnapshots.asOf))
    .limit(100);
  return rows.map((s) => snapshotSummary(s, r.name));
};

export const listMySnapshots = async (ctx: QueryContext, input: { cursor?: string; pageSize?: number }) => {
  requirePermission(ctx, 'reports.read');
  const size = clampPageSize(input.pageSize);
  const c = input.cursor ? decodeCursor(input.cursor) : null;
  const s = reportSnapshots;
  const rows = await ctx.app.db
    .select({ snap: s, name: savedReports.name })
    .from(s)
    .innerJoin(savedReports, and(eq(savedReports.id, s.reportId), eq(savedReports.workspaceId, s.workspaceId)))
    .where(and(eq(s.workspaceId, ctx.actor.workspaceId), eq(s.generatedForMembershipId, me(ctx)), c ? or(lt(s.asOf, new Date(String(c.v[0]))), and(eq(s.asOf, new Date(String(c.v[0]))), lt(s.id, c.id))) : undefined))
    .orderBy(desc(s.asOf), desc(s.id))
    .limit(size + 1);
  const hasMore = rows.length > size;
  const page = hasMore ? rows.slice(0, size) : rows;
  const last = page[page.length - 1];
  return { items: page.map((r) => snapshotSummary(r.snap, r.name)), hasMore, nextCursor: hasMore && last ? encodeCursor({ v: [last.snap.asOf.toISOString()], id: last.snap.id }) : null };
};

/** A snapshot is readable only by the member it was generated for (it holds their permitted data). */
export const loadOwnSnapshot = async (ctx: Ctx, id: string) => {
  requirePermission(ctx, 'reports.read');
  const [row] = await dbOf(ctx)
    .select({ snap: reportSnapshots, name: savedReports.name })
    .from(reportSnapshots)
    .innerJoin(savedReports, and(eq(savedReports.id, reportSnapshots.reportId), eq(savedReports.workspaceId, reportSnapshots.workspaceId)))
    .where(and(eq(reportSnapshots.workspaceId, ctx.actor.workspaceId), eq(reportSnapshots.id, id)));
  if (!row || row.snap.generatedForMembershipId !== me(ctx)) throw notFound('Snapshot');
  return row;
};

export const getReportSnapshot = async (ctx: Ctx, id: string): Promise<ReportSnapshotDetail> => {
  const { snap, name } = await loadOwnSnapshot(ctx, id);
  const refs = await loadMemberRefs(dbOf(ctx), ctx.actor.workspaceId, [snap.generatedForMembershipId]);
  const config = parseReportConfig(snap.configSnapshot);
  return {
    ...snapshotSummary(snap, name),
    config,
    generatedFor: refOrUnknown(refs, snap.generatedForMembershipId)!,
    result: snap.result as unknown as ReportResult,
    stale: snap.sourceRevised || (await reportSourceChangedSince(ctx, config.dataset, snap.asOf)),
  };
};

// ——— Registrations ———

defineArchiveHandler({
  entityType: 'saved_report',
  label: 'Saved report',
  preview: async (ctx, id) => {
    const r = await loadReadableReport(ctx, id);
    if (!canEdit(ctx, r)) throw new AppError('FORBIDDEN', 'Only the report owner can archive it.');
    const [n] = await ctx.app.db.select({ n: sql<number>`count(*)::int` }).from(reportSchedules).where(and(eq(reportSchedules.reportId, id), eq(reportSchedules.active, true)));
    return {
      title: r.name,
      rowVersion: r.rowVersion,
      items: n?.n ? [{ kind: 'active_schedules', label: 'Active schedules (they will be paused)', count: n.n, blocking: false }] : [],
    };
  },
  archive: async (ctx, id, input) => {
    await archiveReport(ctx, id, { reason: input.reason }, { skipVersion: true });
  },
  restorePreview: async (ctx, id) => {
    const r = await loadReadableReport(ctx, id);
    return { title: r.name, items: [] };
  },
  restore: async (ctx, id) => {
    await restoreReport(ctx, id, { skipVersion: true });
  },
  list: (ctx, input) =>
    input.state === 'trash'
      ? Promise.resolve([])
      : tableArchiveList(ctx, input, { table: savedReports, title: savedReports.name, scope: eq(savedReports.ownerMembershipId, me(ctx)) as SQL, archivedWhere: isNotNull(savedReports.archivedAt) }),
});

