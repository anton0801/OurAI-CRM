import { and, asc, count, desc, eq, gt, inArray, isNotNull, isNull, lt, max, min, ne, or, sql, type SQL } from 'drizzle-orm';
import { can, hasAnywhere } from '@castlane/authorization';
import { compareValues, comparisonPeriod, known, percentValue, resolvePeriod, unavailable, type MetricValue, type Period } from '@castlane/analytics';
import {
  characters,
  contentItems,
  contentVersions,
  directions,
  metricCheckpoints,
  metricObservations,
  projectMilestones,
  projects,
  publications,
  reviews,
  shifts,
  socialAccounts,
  tasks,
  workspaces,
} from '@castlane/database';
import { AppError, DateTime, SHIFT_LIMITS, localDate, type FieldError } from '@castlane/domain';
import type { NeedsAttentionItem, OverviewKpi, OverviewResponse } from '@castlane/api-contracts';
import { requireAnyPermission, scopePredicate, whereAll } from '../core/access';
import { all, dbOf, type QueryContext } from '../core/context';
import { loadMemberRefs, refOrUnknown } from '../core/members';
import { METRIC_DEFINITIONS, evaluateMetric, type MetricFilters } from '../core/metric-registry';
import { listBudgets } from '../finance/budgets';
import { financeOverview } from '../finance/overview';
import { accountLabelOf } from '../automation/records';

/**
 * Overview S08 (§17, §25.4, F03). Every number is computed inside the member's scope before
 * aggregation (`scopePredicate` / the semantic layer). KPIs come from the metric registry
 * (M01 Published, M07 On-Time Rate, M08 Overdue Tasks); Pending Reviews and Needs Attention are
 * operational lists read directly from the module tables. Missing data is never shown as zero;
 * an empty workspace shows the setup checklist instead of KPIs (T169). Finance is present only
 * with finance access (T016).
 */

const REVIEW_WAIT_HOURS = 48;
const FRESHNESS_CADENCE_DAYS = 7;
const ITEMS_PER_KIND = 5;
const PROJECT_ROWS = 50;
const THUMBNAILS = 8;
const OPEN_TASK_STATUSES = ['draft', 'backlog', 'ready', 'in_progress', 'in_review'] as const;

export const NEEDS_ATTENTION_LABELS: Record<NeedsAttentionItem['kind'], string> = {
  overdue_task: 'Overdue tasks',
  blocked_task: 'Blocked tasks',
  review_waiting: 'Reviews waiting too long',
  publication_unapproved: 'Scheduled without approved content',
  checkpoint_missing: 'Missing metric checkpoints',
  shift_end_forgotten: 'Shifts not ended',
  budget_overspent: 'Budgets over plan',
};

export interface OverviewInput {
  period: OverviewResponse['period']['preset'];
  from?: string;
  to?: string;
  directionId?: string;
  projectId?: string;
}

const hoursAgo = (from: Date, now: Date) => Math.max(0, Math.floor((now.getTime() - from.getTime()) / 3_600_000));
const ago = (h: number) => (h >= 48 ? `${Math.floor(h / 24)} days` : `${h} h`);

const qs = (params: Record<string, string | undefined | null>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) s.set(k, v);
  const out = s.toString();
  return out ? `?${out}` : '';
};

/** Project filter in SQL for the Overview filters (direction / project). */
const projectFilter = (col: SQL, f: { directionId?: string; projectId?: string }): SQL | undefined =>
  whereAll(f.projectId ? sql`${col} = ${f.projectId}` : undefined, f.directionId ? sql`${col} IN (SELECT p.id FROM projects p WHERE p.direction_id = ${f.directionId})` : undefined);

const metricFilters = (f: { directionId?: string; projectId?: string }): MetricFilters => ({
  ...(f.directionId ? { directionIds: [f.directionId] } : {}),
  ...(f.projectId ? { projectIds: [f.projectId] } : {}),
});

const grainFor = (p: Period): 'day' | 'week' | 'month' => {
  const days = (p.end.getTime() - p.start.getTime()) / 86_400_000;
  return days <= 31 ? 'day' : days <= 190 ? 'week' : 'month';
};

const permittedMetric = (ctx: QueryContext, id: string) => {
  const d = METRIC_DEFINITIONS.get(id);
  if (!d) return { def: null, permitted: true };
  return { def: d, permitted: hasAnywhere(ctx.actor.access, d.permission) };
};

const safeEvaluate = async (ctx: QueryContext, id: string, q: Parameters<typeof evaluateMetric>[2]) => {
  try {
    return await evaluateMetric(ctx, id, q);
  } catch (e) {
    if (e instanceof AppError) return null;
    throw e;
  }
};

const metricKpi = async (
  ctx: QueryContext,
  key: OverviewKpi['key'],
  metricId: string,
  fallbackLabel: string,
  fallbackDescription: string,
  period: Period,
  filters: MetricFilters,
  fallbackHref: string,
): Promise<OverviewKpi | null> => {
  const { def, permitted } = permittedMetric(ctx, metricId);
  if (!permitted) return null;
  if (!def)
    return {
      key,
      label: fallbackLabel,
      metricId,
      description: fallbackDescription,
      value: unavailable('not_measured', 'count', { note: 'The metric definition is not available.' }),
      comparison: null,
      href: fallbackHref,
    };
  const now = ctx.app.clock.now();
  const current = await safeEvaluate(ctx, def.id, { period, asOf: now, filters });
  const cmp = comparisonPeriod(period, now);
  const previous = await safeEvaluate(ctx, def.id, { period: cmp.previous, asOf: cmp.previous.end, filters });
  const value = current?.total ?? unavailable('not_measured', def.unit);
  const comparison = previous ? compareValues(value, previous.total, { rate: def.rate }) : null;
  return {
    key,
    label: def.label,
    metricId: def.id,
    description: def.description,
    value,
    comparison: comparison ? { ...comparison, previousLabel: cmp.elapsedOnly ? 'vs same elapsed time of the previous period' : 'vs previous period' } : null,
    href: current?.drillDown?.href ?? fallbackHref,
  };
};

export const getOverview = async (ctx: QueryContext, input: OverviewInput): Promise<OverviewResponse> => {
  requireAnyPermission(ctx, ['projects.read', 'analytics.production.read']);
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const now = ctx.app.clock.now();
  const wsPath = (p: string) => `/w/${ws}${p}`;
  const [workspace] = await db.select({ tz: workspaces.timezone, weekStartsOn: workspaces.weekStartsOn }).from(workspaces).where(eq(workspaces.id, ws));
  const zone = ctx.actor.timezone || workspace?.tz || 'UTC';

  // Period (member timezone) and filters.
  const errors: FieldError[] = [];
  if (input.period === 'custom' && (!input.from || !input.to)) errors.push({ field: 'from', code: 'REQUIRED', message: 'Choose the start and end dates.' });
  if (input.period === 'custom' && input.from && input.to && input.to < input.from) errors.push({ field: 'to', code: 'BEFORE_START', message: 'Choose an end on or after the start.' });
  if (errors.length) throw new AppError('VALIDATION_FAILED', 'Check the period.', { fieldErrors: errors });
  const period = resolvePeriod(input.period, now, zone, input.period === 'custom' ? { fromDate: input.from!, toDate: input.to! } : undefined, workspace?.weekStartsOn ?? 'monday');
  let directionRef: OverviewResponse['filters']['direction'] = null;
  let projectRef: OverviewResponse['filters']['project'] = null;
  if (input.directionId) {
    const [d] = await db.select({ id: directions.id, name: directions.name }).from(directions).where(and(eq(directions.workspaceId, ws), eq(directions.id, input.directionId)));
    if (!d) throw new AppError('NOT_FOUND', 'Direction was not found.');
    directionRef = d;
  }
  if (input.projectId) {
    const [p] = await db.select({ id: projects.id, name: projects.name, directionId: projects.directionId, ownerMembershipId: projects.ownerMembershipId }).from(projects).where(and(eq(projects.workspaceId, ws), eq(projects.id, input.projectId)));
    // A project the member cannot read does not exist for them (no existence leak).
    if (!p || !can(ctx.actor.access, 'projects.read', { projectId: p.id, directionId: p.directionId, ownerMembershipId: p.ownerMembershipId })) throw new AppError('NOT_FOUND', 'Project was not found.');
    projectRef = { id: p.id, name: p.name };
  }
  const f = { directionId: input.directionId, projectId: input.projectId };
  const filters = metricFilters(f);

  const canRead = (p: string) => hasAnywhere(ctx.actor.access, p);
  const projectScope = scopePredicate(ctx, 'projects.read', { projectId: projects.id, ownerMembership: projects.ownerMembershipId });
  const taskScope = scopePredicate(ctx, 'tasks.read', { projectId: tasks.projectId, accountId: tasks.accountId, assigned: [tasks.assigneeMembershipId, tasks.reviewerMembershipId] });
  const accountScope = scopePredicate(ctx, 'accounts.read', { projectId: socialAccounts.projectId, accountId: socialAccounts.id });

  // Setup checklist (T169): counts in the member's scope, ignoring filters.
  const [[pc], [ac], [tc]] = await all(ctx, [
    () => (canRead('projects.read') ? db.select({ n: count() }).from(projects).where(and(eq(projects.workspaceId, ws), isNull(projects.deletedAt), projectScope)) : Promise.resolve([{ n: 0 }])),
    () => (canRead('accounts.read') ? db.select({ n: count() }).from(socialAccounts).where(and(eq(socialAccounts.workspaceId, ws), isNull(socialAccounts.deletedAt), accountScope)) : Promise.resolve([{ n: 0 }])),
    () => (canRead('tasks.read') ? db.select({ n: count() }).from(tasks).where(and(eq(tasks.workspaceId, ws), isNull(tasks.deletedAt), taskScope)) : Promise.resolve([{ n: 0 }])),
  ] as const);
  const counts = { projects: Number(pc?.n ?? 0), accounts: Number(ac?.n ?? 0), tasks: Number(tc?.n ?? 0) };
  const steps: OverviewResponse['setup']['steps'] = [
    { key: 'project', label: 'Start a Project', done: counts.projects > 0, permitted: canRead('projects.create'), href: wsPath('/projects/new') },
    { key: 'account', label: 'Add an Account', done: counts.accounts > 0, permitted: canRead('accounts.write'), href: wsPath('/accounts/new') },
    { key: 'task', label: 'Create a Task', done: counts.tasks > 0, permitted: canRead('tasks.create'), href: wsPath('/tasks?create=1') },
  ];
  const empty = counts.projects === 0;
  const base = {
    period: { preset: input.period, fromDate: period.fromDate, toDate: period.toDate, zone, start: period.start.toISOString(), end: period.end.toISOString() },
    asOf: now.toISOString(),
    filters: { direction: directionRef, project: projectRef },
    setup: { empty, steps },
    permissions: { createProject: canRead('projects.create'), exportView: canRead('exports.create'), reviewQueue: canRead('content.read') },
  };
  if (empty)
    return {
      ...base,
      kpis: [],
      trend: { grain: grainFor(period), series: [], unavailableReason: 'No projects yet. Start a project to see production data here.' },
      needsAttention: { counts: [], total: 0, items: [] },
      projects: { items: [], total: 0 },
    };

  // ——— KPI strip ———
  const periodQs = { from: period.fromDate, to: period.toDate, projectId: input.projectId, directionId: input.directionId };
  const kpis: OverviewKpi[] = [];
  const published = await metricKpi(ctx, 'published', 'M01', 'Published', 'Publications confirmed as published in the period.', period, filters, wsPath(`/publications${qs({ status: 'published', ...periodQs })}`));
  if (published) kpis.push(published);
  const onTime = await metricKpi(ctx, 'on_time_rate', 'M07', 'On-Time Rate', 'Done tasks completed by their baseline deadline, of all tasks with a baseline in the period.', period, filters, wsPath(`/tasks${qs({ includeClosed: '1', projectId: input.projectId })}`));
  if (onTime) kpis.push(onTime);
  if (canRead('content.read')) {
    const reviewScope = scopePredicate(ctx, 'content.read', { projectId: reviews.projectId, assigned: [reviews.reviewerMembershipId, reviews.authorMembershipId] });
    const [r] = await db
      .select({ n: count() })
      .from(reviews)
      .where(and(eq(reviews.workspaceId, ws), eq(reviews.status, 'pending'), reviewScope, projectFilter(sql`${reviews.projectId}`, f)));
    kpis.push({
      key: 'pending_reviews',
      label: 'Pending Reviews',
      metricId: null,
      description: 'Review steps waiting for a decision now (as of the time shown).',
      value: known(String(Number(r?.n ?? 0)), 'count'),
      comparison: null,
      href: wsPath(`/reviews${qs({ status: 'pending', projectId: input.projectId })}`),
    });
  }
  const overdue = await metricKpi(ctx, 'overdue_tasks', 'M08', 'Overdue Tasks', 'Open tasks whose deadline has passed.', period, filters, wsPath(`/tasks${qs({ overdue: '1', projectId: input.projectId })}`));
  if (overdue) kpis.push(overdue);

  // ——— Production trend ———
  const grain = grainFor(period);
  const series: OverviewResponse['trend']['series'] = [];
  for (const [id, label] of [
    ['M01', 'Published'],
    ['M02', 'Produced Content'],
  ] as const) {
    const { def, permitted } = permittedMetric(ctx, id);
    if (!def || !permitted || !def.grains.includes(grain)) continue;
    const r = await safeEvaluate(ctx, def.id, { period, asOf: now, filters, grain });
    if (!r?.series) continue;
    series.push({ key: def.key, label: def.label ?? label, metricId: def.id, unit: def.unit, points: r.series.map((s) => ({ bucket: s.bucket.slice(0, 10), value: s.value })) });
  }
  const trend = { grain, series, unavailableReason: series.length ? null : 'Production metrics are not available for your role or are not configured yet.' };

  // ——— Needs Attention (scoped, each item actionable) ———
  const items: NeedsAttentionItem[] = [];
  const kindCounts: OverviewResponse['needsAttention']['counts'] = [];
  const pushKind = (kind: NeedsAttentionItem['kind'], n: number, list: NeedsAttentionItem[]) => {
    kindCounts.push({ kind, label: NEEDS_ATTENTION_LABELS[kind], count: n });
    items.push(...list);
  };
  const projectNames = new Map<string, string>();
  const nameOf = async (ids: string[]) => {
    const missing = [...new Set(ids)].filter((i) => !projectNames.has(i));
    if (missing.length) for (const p of await db.select({ id: projects.id, name: projects.name }).from(projects).where(and(eq(projects.workspaceId, ws), inArray(projects.id, missing)))) projectNames.set(p.id, p.name);
  };
  const projRef = (id: string | null | undefined) => (id ? { id, name: projectNames.get(id) ?? 'Project' } : null);

  if (canRead('tasks.read')) {
    const openTask = and(eq(tasks.workspaceId, ws), inArray(tasks.status, [...OPEN_TASK_STATUSES]), isNull(tasks.archivedAt), isNull(tasks.deletedAt), taskScope, projectFilter(sql`${tasks.projectId}`, f));
    const overdueWhere = and(openTask, lt(tasks.dueAt, now));
    const blockedWhere = and(openTask, isNotNull(tasks.blockedAt));
    const [[on], overdueRows, [bn], blockedRows] = await all(ctx, [
      () => db.select({ n: count() }).from(tasks).where(overdueWhere),
      () => db.select().from(tasks).where(overdueWhere).orderBy(asc(tasks.dueAt), asc(tasks.id)).limit(ITEMS_PER_KIND),
      () => db.select({ n: count() }).from(tasks).where(blockedWhere),
      () => db.select().from(tasks).where(blockedWhere).orderBy(asc(tasks.blockedAt), asc(tasks.id)).limit(ITEMS_PER_KIND),
    ] as const);
    const refs = await loadMemberRefs(db, ws, [...overdueRows, ...blockedRows].map((t) => t.assigneeMembershipId));
    await nameOf([...overdueRows, ...blockedRows].map((t) => t.projectId));
    pushKind(
      'overdue_task',
      Number(on?.n ?? 0),
      overdueRows.map((t) => ({
        kind: 'overdue_task',
        id: t.id,
        title: t.title,
        detail: `Overdue by ${ago(hoursAgo(t.dueAt!, now))} · ${t.assigneeMembershipId ? refOrUnknown(refs, t.assigneeMembershipId)!.displayName : 'Unassigned'}`,
        severity: hoursAgo(t.dueAt!, now) >= 72 ? 'danger' : 'warning',
        at: t.dueAt!.toISOString(),
        href: wsPath(`/tasks/${t.id}`),
        actionLabel: 'Open Task',
        project: projRef(t.projectId),
      })),
    );
    pushKind(
      'blocked_task',
      Number(bn?.n ?? 0),
      blockedRows.map((t) => ({
        kind: 'blocked_task',
        id: t.id,
        title: t.title,
        detail: `Blocked ${ago(hoursAgo(t.blockedAt!, now))}${t.blockedReason ? `: ${t.blockedReason.slice(0, 120)}` : ''}`,
        severity: 'warning',
        at: t.blockedAt!.toISOString(),
        href: wsPath(`/tasks/${t.id}`),
        actionLabel: 'Resolve Blocker',
        project: projRef(t.projectId),
      })),
    );
  }

  if (canRead('content.read')) {
    const waitBefore = new Date(now.getTime() - REVIEW_WAIT_HOURS * 3_600_000);
    const where = and(
      eq(reviews.workspaceId, ws),
      eq(reviews.status, 'pending'),
      or(lt(reviews.submittedAt, waitBefore), lt(reviews.dueAt, now)),
      scopePredicate(ctx, 'content.read', { projectId: reviews.projectId, assigned: [reviews.reviewerMembershipId, reviews.authorMembershipId] }),
      projectFilter(sql`${reviews.projectId}`, f),
    );
    const [[n], rows] = await all(ctx, [() => db.select({ n: count() }).from(reviews).where(where), () => db.select().from(reviews).where(where).orderBy(asc(reviews.submittedAt)).limit(ITEMS_PER_KIND)] as const);
    const contentIds = rows.filter((r) => r.targetType === 'content_version').map((r) => r.subjectId);
    const characterIds = rows.filter((r) => r.targetType === 'character_version').map((r) => r.subjectId);
    const titles = new Map<string, string>();
    if (contentIds.length) for (const c of await db.select({ id: contentItems.id, title: contentItems.title }).from(contentItems).where(inArray(contentItems.id, contentIds))) titles.set(c.id, c.title);
    if (characterIds.length) for (const c of await db.select({ id: characters.id, name: characters.name }).from(characters).where(inArray(characters.id, characterIds))) titles.set(c.id, `Character: ${c.name}`);
    const refs = await loadMemberRefs(db, ws, rows.map((r) => r.reviewerMembershipId));
    await nameOf(rows.map((r) => r.projectId));
    pushKind(
      'review_waiting',
      Number(n?.n ?? 0),
      rows.map((r) => ({
        kind: 'review_waiting',
        id: r.id,
        title: titles.get(r.subjectId) ?? 'Review',
        detail: `Waiting ${ago(hoursAgo(r.submittedAt, now))} · ${r.reviewerMembershipId ? refOrUnknown(refs, r.reviewerMembershipId)!.displayName : 'No reviewer'}`,
        severity: r.dueAt && r.dueAt < now ? 'danger' : 'warning',
        at: r.submittedAt.toISOString(),
        href: wsPath(`/reviews/${r.id}`),
        actionLabel: 'Review',
        project: projRef(r.projectId),
      })),
    );
  }

  if (canRead('publications.read')) {
    const where = and(
      eq(publications.workspaceId, ws),
      eq(publications.status, 'scheduled'),
      isNull(publications.deletedAt),
      sql`(${contentVersions.id} IS NULL OR ${contentVersions.approvedAt} IS NULL OR ${contentVersions.approvalRevokedAt} IS NOT NULL)`,
      scopePredicate(ctx, 'publications.read', { projectId: publications.projectId, accountId: publications.accountId, assigned: [publications.ownerMembershipId] }),
      projectFilter(sql`${publications.projectId}`, f),
    );
    const q = () => db.select({ p: publications, title: contentItems.title }).from(publications).leftJoin(contentVersions, eq(contentVersions.id, publications.contentVersionId)).innerJoin(contentItems, eq(contentItems.id, publications.contentItemId));
    const [[n], rows] = await all(ctx, [
      () => db.select({ n: count() }).from(publications).leftJoin(contentVersions, eq(contentVersions.id, publications.contentVersionId)).where(where),
      () => q().where(where).orderBy(asc(publications.scheduledAt)).limit(ITEMS_PER_KIND),
    ] as const);
    const accounts = rows.length ? await db.select({ id: socialAccounts.id, handle: socialAccounts.handle, displayName: socialAccounts.displayName, platform: socialAccounts.platform }).from(socialAccounts).where(inArray(socialAccounts.id, rows.map((r) => r.p.accountId))) : [];
    await nameOf(rows.map((r) => r.p.projectId));
    pushKind(
      'publication_unapproved',
      Number(n?.n ?? 0),
      rows.map((r) => {
        const a = accounts.find((x) => x.id === r.p.accountId);
        const soon = r.p.scheduledAt && r.p.scheduledAt.getTime() - now.getTime() < 24 * 3_600_000;
        return {
          kind: 'publication_unapproved' as const,
          id: r.p.id,
          title: `${r.title}${a ? ` · ${accountLabelOf(a)}` : ''}`,
          detail: `Scheduled ${r.p.scheduledAt ? DateTime.fromJSDate(r.p.scheduledAt, { zone }).toFormat('d LLL HH:mm') : 'without a time'} · no approved version`,
          severity: soon ? ('danger' as const) : ('warning' as const),
          at: r.p.scheduledAt?.toISOString() ?? null,
          href: wsPath(`/publications/${r.p.id}`),
          actionLabel: 'Check Approval',
          project: projRef(r.p.projectId),
        };
      }),
    );
  }

  if (canRead('metrics.read')) {
    const where = and(
      eq(metricCheckpoints.workspaceId, ws),
      eq(metricCheckpoints.state, 'pending'),
      lt(metricCheckpoints.windowEnd, now),
      scopePredicate(ctx, 'metrics.read', { projectId: metricCheckpoints.projectId, accountId: metricCheckpoints.accountId, assigned: [metricCheckpoints.assigneeMembershipId] }),
      projectFilter(sql`${metricCheckpoints.projectId}`, f),
    );
    const [[n], rows] = await all(ctx, [() => db.select({ n: count() }).from(metricCheckpoints).where(where), () => db.select().from(metricCheckpoints).where(where).orderBy(asc(metricCheckpoints.windowEnd)).limit(ITEMS_PER_KIND)] as const);
    const accounts = rows.length ? await db.select({ id: socialAccounts.id, handle: socialAccounts.handle, displayName: socialAccounts.displayName, platform: socialAccounts.platform }).from(socialAccounts).where(inArray(socialAccounts.id, rows.map((r) => r.accountId))) : [];
    await nameOf(rows.map((r) => r.projectId));
    pushKind(
      'checkpoint_missing',
      Number(n?.n ?? 0),
      rows.map((r) => {
        const a = accounts.find((x) => x.id === r.accountId);
        return {
          kind: 'checkpoint_missing' as const,
          id: r.id,
          title: `${r.checkpointKey} checkpoint${a ? ` · ${accountLabelOf(a)}` : ''}`,
          detail: `Window closed ${ago(hoursAgo(r.windowEnd, now))} ago without usable data`,
          severity: 'warning' as const,
          at: r.windowEnd.toISOString(),
          href: wsPath(`/metrics?open=${r.id}`),
          actionLabel: 'Add Metrics',
          project: projRef(r.projectId),
        };
      }),
    );
  }

  if (canRead('shifts.read.scope') || canRead('shifts.read.own')) {
    const grace = new Date(now.getTime() - SHIFT_LIMITS.forgottenEndGraceMinutes * 60_000);
    const scoped = scopePredicate(ctx, 'shifts.read.scope', { projectId: shifts.projectId, accountId: shifts.primaryAccountId, assigned: [shifts.supervisorMembershipId] });
    const own = canRead('shifts.read.own') ? eq(shifts.membershipId, ctx.actor.membershipId ?? '00000000-0000-4000-8000-000000000000') : undefined;
    const visible = scoped === undefined ? undefined : own ? or(scoped, own) : scoped;
    const where = and(eq(shifts.workspaceId, ws), inArray(shifts.state, ['active', 'paused']), lt(shifts.scheduledEnd, grace), visible, projectFilter(sql`${shifts.projectId}`, f));
    const [[n], rows] = await all(ctx, [() => db.select({ n: count() }).from(shifts).where(where), () => db.select().from(shifts).where(where).orderBy(asc(shifts.scheduledEnd)).limit(ITEMS_PER_KIND)] as const);
    const refs = await loadMemberRefs(db, ws, rows.map((r) => r.membershipId));
    await nameOf(rows.map((r) => r.projectId));
    pushKind(
      'shift_end_forgotten',
      Number(n?.n ?? 0),
      rows.map((s) => ({
        kind: 'shift_end_forgotten',
        id: s.id,
        title: `Shift of ${refOrUnknown(refs, s.membershipId)!.displayName} still running`,
        detail: `Scheduled end passed ${ago(hoursAgo(s.scheduledEnd, now))} ago — end it or correct the time`,
        severity: 'danger',
        at: s.scheduledEnd.toISOString(),
        href: wsPath(`/ofm/shifts/${s.id}`),
        actionLabel: 'Review Shift',
        project: projRef(s.projectId),
      })),
    );
  }

  if (canRead('budgets.read')) {
    const today = localDate(now, zone);
    const list = await listBudgets(ctx, { activeOn: today, pageSize: 200, projectId: input.projectId });
    const inFilter = (b: (typeof list.items)[number]) => {
      if (!input.directionId || input.projectId) return true;
      if (b.scopeType === 'direction') return b.scope?.id === input.directionId;
      return false;
    };
    let over = list.items.filter((b) => b.figures && Number(b.figures.remaining.amount) < 0 && inFilter(b));
    if (input.directionId && !input.projectId) {
      const projectBudgets = list.items.filter((b) => b.scopeType === 'project' && b.figures && Number(b.figures.remaining.amount) < 0);
      if (projectBudgets.length) {
        const inDir = await db.select({ id: projects.id }).from(projects).where(and(eq(projects.workspaceId, ws), eq(projects.directionId, input.directionId), inArray(projects.id, projectBudgets.map((b) => b.scope!.id))));
        over = [...over, ...projectBudgets.filter((b) => inDir.some((p) => p.id === b.scope!.id))];
      }
    }
    pushKind(
      'budget_overspent',
      over.length,
      over.slice(0, ITEMS_PER_KIND).map((b) => ({
        kind: 'budget_overspent',
        id: b.id,
        title: b.name,
        detail: `${b.figures!.consumedPercent ? `${b.figures!.consumedPercent}% of plan used` : 'Over plan'} · ${b.scope?.name ?? 'Workspace'}`,
        severity: 'danger',
        at: null,
        href: wsPath(`/finance/budgets?open=${b.id}`),
        actionLabel: 'Review Budget',
        project: b.scopeType === 'project' && b.scope ? { id: b.scope.id, name: b.scope.name } : null,
      })),
    );
  }
  const severityRank = (i: NeedsAttentionItem) => (i.severity === 'danger' ? 0 : 1);
  items.sort((a, b) => severityRank(a) - severityRank(b) || (a.at ?? '').localeCompare(b.at ?? ''));

  // ——— Projects table ———
  const projectWhere = and(eq(projects.workspaceId, ws), isNull(projects.deletedAt), ne(projects.status, 'archived'), projectScope, projectFilter(sql`${projects.id}`, f));
  const [[ptotal], prows] = await all(ctx, [
    () => db.select({ n: count() }).from(projects).where(projectWhere),
    () =>
      db
        .select({ p: projects, directionName: directions.name })
        .from(projects)
        .innerJoin(directions, eq(directions.id, projects.directionId))
        .where(projectWhere)
        .orderBy(sql`CASE ${projects.status} WHEN 'active' THEN 0 WHEN 'paused' THEN 1 WHEN 'draft' THEN 2 ELSE 3 END`, asc(projects.name))
        .limit(PROJECT_ROWS),
  ] as const);
  const pids = prows.map((r) => r.p.id);
  const [openRows, overdueRows, milestoneRows, lastPubRows, ownerRefs] = await all(ctx, [
    () => (pids.length ? db.select({ id: tasks.projectId, n: count() }).from(tasks).where(and(eq(tasks.workspaceId, ws), inArray(tasks.projectId, pids), inArray(tasks.status, [...OPEN_TASK_STATUSES]), isNull(tasks.deletedAt), isNull(tasks.archivedAt))).groupBy(tasks.projectId) : Promise.resolve([])),
    () =>
      pids.length
        ? db.select({ id: tasks.projectId, n: count() }).from(tasks).where(and(eq(tasks.workspaceId, ws), inArray(tasks.projectId, pids), inArray(tasks.status, [...OPEN_TASK_STATUSES]), isNull(tasks.deletedAt), isNull(tasks.archivedAt), lt(tasks.dueAt, now))).groupBy(tasks.projectId)
        : Promise.resolve([]),
    () =>
      pids.length
        ? db
            .selectDistinctOn([projectMilestones.projectId], { projectId: projectMilestones.projectId, title: projectMilestones.title, dueDate: projectMilestones.dueDate })
            .from(projectMilestones)
            .where(and(eq(projectMilestones.workspaceId, ws), inArray(projectMilestones.projectId, pids), isNull(projectMilestones.completedAt), isNull(projectMilestones.archivedAt)))
            .orderBy(projectMilestones.projectId, sql`${projectMilestones.dueDate} ASC NULLS LAST`)
        : Promise.resolve([]),
    () =>
      pids.length
        ? db.select({ id: publications.projectId, last: max(publications.actualPublishedAt) }).from(publications).where(and(eq(publications.workspaceId, ws), inArray(publications.projectId, pids), eq(publications.status, 'published'))).groupBy(publications.projectId)
        : Promise.resolve([]),
    () => loadMemberRefs(db, ws, prows.map((r) => r.p.ownerMembershipId)),
  ] as const);
  let thumbs = 0;
  const projectItems: OverviewResponse['projects']['items'] = prows.map(({ p, directionName }) => {
    const withThumb = !!p.coverAssetId && thumbs < THUMBNAILS;
    if (withThumb) thumbs++;
    const m = milestoneRows.find((x) => x.projectId === p.id);
    const last = lastPubRows.find((x) => x.id === p.id)?.last ?? null;
    return {
      id: p.id,
      name: p.name,
      type: p.type,
      status: p.status,
      direction: { id: p.directionId, name: directionName },
      owner: refOrUnknown(ownerRefs, p.ownerMembershipId)!,
      thumbnailUrl: withThumb ? `/api/v1/workspaces/${ws}/assets/${p.coverAssetId}/thumbnail?size=64` : null,
      openTasks: Number(openRows.find((x) => x.id === p.id)?.n ?? 0),
      overdueTasks: Number(overdueRows.find((x) => x.id === p.id)?.n ?? 0),
      nextMilestone: m ? { title: m.title, dueDate: m.dueDate } : null,
      lastPublicationAt: last ? new Date(last).toISOString() : null,
    };
  });

  const out: OverviewResponse = {
    ...base,
    kpis,
    trend,
    needsAttention: { counts: kindCounts, total: kindCounts.reduce((a, k) => a + k.count, 0), items: items.slice(0, 25) },
    projects: { items: projectItems, total: Number(ptotal?.n ?? 0) },
  };

  // ——— Data freshness (latest observations per account, checkpoint coverage) ———
  if (canRead('metrics.read') && canRead('accounts.read')) {
    const accWhere = and(eq(socialAccounts.workspaceId, ws), isNull(socialAccounts.deletedAt), isNull(socialAccounts.archivedAt), eq(socialAccounts.status, 'active'), accountScope, projectFilter(sql`${socialAccounts.projectId}`, f));
    const lastObserved = sql<string | null>`(SELECT max(o.observed_at)::text FROM metric_observations o WHERE o.workspace_id = ${socialAccounts.workspaceId} AND o.account_id = ${socialAccounts.id} AND o.quality_state NOT IN ('superseded', 'rejected', 'pending_correction'))`;
    const lastEntered = sql<string | null>`(SELECT max(o.entered_at)::text FROM metric_observations o WHERE o.workspace_id = ${socialAccounts.workspaceId} AND o.account_id = ${socialAccounts.id} AND o.quality_state NOT IN ('superseded', 'rejected', 'pending_correction'))`;
    const staleBefore = new Date(now.getTime() - FRESHNESS_CADENCE_DAYS * 86_400_000);
    const [accRows, [accTotal], [staleTotal]] = await all(ctx, [
      () =>
        db
          .select({ a: socialAccounts, projectName: projects.name, lastObserved, lastEntered })
          .from(socialAccounts)
          .innerJoin(projects, eq(projects.id, socialAccounts.projectId))
          .where(accWhere)
          .orderBy(sql`${lastObserved} ASC NULLS FIRST`, asc(socialAccounts.id))
          .limit(50),
      () => db.select({ n: count() }).from(socialAccounts).where(accWhere),
      () => db.select({ n: count() }).from(socialAccounts).where(and(accWhere, sql`(${lastObserved} IS NULL OR ${lastObserved}::timestamptz < ${staleBefore})`)),
    ] as const);
    const coverageMetric = permittedMetric(ctx, 'M40');
    let coverage: MetricValue;
    const m40 = coverageMetric.def && coverageMetric.permitted ? await safeEvaluate(ctx, 'M40', { period, asOf: now, filters }) : null;
    if (m40) coverage = m40.total;
    else {
      // §15.4: usable completed checkpoints / expected checkpoints in scope and period; Missing is not usable.
      const [c] = await db
        .select({
          expected: sql<number>`count(*) FILTER (WHERE ${metricCheckpoints.state} <> 'cancelled')::int`,
          usable: sql<number>`count(*) FILTER (WHERE ${metricCheckpoints.state} = 'completed')::int`,
        })
        .from(metricCheckpoints)
        .where(
          and(
            eq(metricCheckpoints.workspaceId, ws),
            sql`${metricCheckpoints.expectedAt} >= ${period.start} AND ${metricCheckpoints.expectedAt} < ${period.end} AND ${metricCheckpoints.expectedAt} <= ${now}`,
            scopePredicate(ctx, 'metrics.read', { projectId: metricCheckpoints.projectId, accountId: metricCheckpoints.accountId, assigned: [metricCheckpoints.assigneeMembershipId] }),
            projectFilter(sql`${metricCheckpoints.projectId}`, f),
          ),
        );
      const expected = Number(c?.expected ?? 0);
      const usable = Number(c?.usable ?? 0);
      coverage = expected === 0 ? unavailable('not_applicable', 'percent', { coverage: { usable, expected } }) : percentValue(usable, expected, 2, { coverage: { usable, expected } });
    }
    out.freshness = {
      accounts: accRows.map((r) => ({
        id: r.a.id,
        label: accountLabelOf(r.a),
        platform: r.a.platform,
        project: { id: r.a.projectId, name: r.projectName },
        lastObservedAt: r.lastObserved ? new Date(r.lastObserved).toISOString() : null,
        lastEnteredAt: r.lastEntered ? new Date(r.lastEntered).toISOString() : null,
        overdue: !r.lastObserved || new Date(r.lastObserved).getTime() < staleBefore.getTime(),
      })),
      totalAccounts: Number(accTotal?.n ?? 0),
      staleAccounts: Number(staleTotal?.n ?? 0),
      coverage,
    };
  }

  // ——— Finance row (only with finance access; omitted otherwise, never null-filled) ———
  if (canRead('finance.read') && !(input.directionId && !input.projectId)) {
    try {
      const fo = await financeOverview(ctx, { periodStart: period.fromDate, periodEnd: period.toDate, projectId: input.projectId });
      out.finance = {
        baseCurrency: fo.baseCurrency,
        netRevenue: fo.accrual.netRevenue,
        operatingExpenses: fo.accrual.operatingExpenses,
        operatingResult: fo.accrual.operatingResult,
        grossIncomplete: fo.accrual.grossIncomplete,
        cash: fo.cash.map((c) => ({ currency: c.currency, movement: c.movement })),
        draftCount: fo.drafts.count,
      };
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
    }
  }
  return out;
};

void gt;
void min;
void desc;
void metricObservations;
