import { analyticsEndpoints as A, metricsEndpoints as M, type ObservationInput } from '@castlane/api-contracts';
import { ensurePublicationMetricCheckpoints, executeSystemCommand, getAppServices, systemJobContext } from '@castlane/application';
import { comments, contentItems, publications, socialAccounts, tasks, timeEntries } from '@castlane/database';
import { newId } from '@castlane/domain';
import { inArray } from 'drizzle-orm';
import { addMember, assignToProject, clientFor, createAccount, createDirection, createProject, createWorkspace, sessionFor, type TestClient } from '../../support';

export const db = () => getAppServices().db;

const DAY = 86_400_000;
/** UTC midnight `daysAgo` days before today: tests anchor on whole past days, never on the time of day. */
export const dayStart = (daysAgo: number) => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return new Date(d.getTime() - daysAgo * DAY);
};
/** ISO instant `daysAgo` days back at hh:mm UTC (use daysAgo ≥ 1 for instants that must be in the past). */
export const at = (daysAgo: number, hour = 12, minute = 0) => new Date(dayStart(daysAgo).getTime() + hour * 3_600_000 + minute * 60_000).toISOString();
/** Local (UTC) calendar date `daysAgo` days back. */
export const isoDay = (daysAgo: number) => dayStart(daysAgo).toISOString().slice(0, 10);
/** Records created by fixtures are dated long before any tested period. */
export const LONG_AGO = new Date('2024-01-01T00:00:00Z');

export interface InsightsFixture {
  ws: Awaited<ReturnType<typeof createWorkspace>>;
  owner: TestClient;
  p: { workspaceId: string };
  directionId: string;
  projectId: string;
  otherProjectId: string;
  accountId: string;
  otherAccountId: string;
}

/** Workspace (UTC) with two model projects, one Instagram account on each. */
export const insightsFixture = async (opts: { ofm?: boolean; timezone?: string } = {}): Promise<InsightsFixture> => {
  const ws = await createWorkspace(db(), { timezone: opts.timezone ?? 'UTC' });
  const owner = await clientFor(await sessionFor(db(), ws.owner.userId));
  const directionId = await createDirection(db(), ws, 'AI Models');
  const project = await createProject(db(), ws, { directionId, name: 'Model Alpha', type: 'model', ofmEnabled: opts.ofm ?? false });
  const other = await createProject(db(), ws, { directionId, name: 'Model Beta', type: 'model', ofmEnabled: opts.ofm ?? false });
  const accountId = await createAccount(db(), ws, { projectId: project.id, status: 'active' });
  const otherAccountId = await createAccount(db(), ws, { projectId: other.id, platform: 'tiktok', url: `https://www.tiktok.com/@beta_${newId().slice(0, 6)}`, status: 'active' });
  await db().update(socialAccounts).set({ createdAt: LONG_AGO }).where(inArray(socialAccounts.id, [accountId, otherAccountId]));
  return { ws, owner, p: { workspaceId: ws.workspaceId }, directionId, projectId: project.id, otherProjectId: other.id, accountId, otherAccountId };
};

/** Member with a role; project-scoped roles are placed on the given projects. */
export const memberOf = async (f: InsightsFixture, roleKey: string, opts: { projects?: string[]; scopeType?: 'workspace' | 'assigned_projects' | 'assigned_accounts'; name?: string } = {}) => {
  const scopeType = opts.scopeType ?? (opts.projects ? 'assigned_projects' : 'workspace');
  const m = await addMember(db(), f.ws, { roleKey, scopeType, name: opts.name });
  for (const pid of opts.projects ?? []) await assignToProject(db(), f.ws, pid, m.membershipId);
  return { ...m, client: await clientFor(await sessionFor(db(), m.userId)) };
};

export const insertContent = async (f: InsightsFixture, projectId: string, extra: Partial<typeof contentItems.$inferInsert> = {}) => {
  const id = newId();
  await db()
    .insert(contentItems)
    .values({ id, workspaceId: f.ws.workspaceId, createdAt: LONG_AGO, updatedAt: LONG_AGO, projectId, title: `Reel ${id.slice(0, 4)}`, format: 'short_video', stage: 'approved', ownerMembershipId: f.ws.owner.membershipId, ...extra });
  return id;
};

/** A published placement (written directly: the publications module owns the commands). */
export const insertPublication = async (f: InsightsFixture, input: { projectId?: string; accountId?: string; publishedAt: string; status?: 'published' | 'scheduled'; scheduledAt?: string; contentExtra?: Partial<typeof contentItems.$inferInsert> }) => {
  const projectId = input.projectId ?? f.projectId;
  const contentItemId = await insertContent(f, projectId, input.contentExtra);
  const id = newId();
  await db()
    .insert(publications)
    .values({
      id,
      workspaceId: f.ws.workspaceId,
      createdAt: LONG_AGO,
      updatedAt: LONG_AGO,
      contentItemId,
      accountId: input.accountId ?? f.accountId,
      projectId,
      ownerMembershipId: f.ws.owner.membershipId,
      status: input.status ?? 'published',
      scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
      actualPublishedAt: input.status === 'scheduled' ? null : new Date(input.publishedAt),
      format: 'short_video',
    });
  return id;
};

/** Checkpoints exactly as Mark Published creates them (24 h and 7 d from the active policy, assignee = owner). */
export const createCheckpoints = async (f: InsightsFixture, pub: { id: string; accountId?: string; projectId?: string; publishedAt: string; assignee?: string }) => {
  const ctx = await systemJobContext(getAppServices(), f.ws.workspaceId, ['metrics.write']);
  return executeSystemCommand(ctx, (c) =>
    ensurePublicationMetricCheckpoints(c, { id: pub.id, accountId: pub.accountId ?? f.accountId, projectId: pub.projectId ?? f.projectId, actualPublishedAt: new Date(pub.publishedAt), assigneeMembershipId: pub.assignee ?? f.ws.owner.membershipId }),
  );
};

type Values = Record<string, string | null | 'unknown' | 'not_provided' | 'not_applicable'>;

type Availability = 'known' | 'unknown' | 'not_provided' | 'not_applicable';
const toValues = (values: Values): { metricKey: string; availability: Availability; value: string | null }[] =>
  Object.entries(values).map(([k, v]) =>
    v === null || v === 'unknown' ? { metricKey: k, availability: 'unknown', value: null } : v === 'not_provided' || v === 'not_applicable' ? { metricKey: k, availability: v, value: null } : { metricKey: k, availability: 'known', value: v },
  );

export const snapshotBody = (accountId: string, observedAt: string, values: Values, extra: Partial<ObservationInput> = {}): ObservationInput => ({
  entityType: 'account',
  entityId: accountId,
  kind: 'snapshot',
  observedAt,
  sourceType: 'manual',
  sourceNote: 'Profile page screenshot',
  values: toValues(values),
  ...extra,
});

export const periodBody = (accountId: string, start: string, end: string, values: Values, extra: Partial<ObservationInput> = {}): ObservationInput => ({
  entityType: 'account',
  entityId: accountId,
  kind: 'period',
  observedAt: end,
  periodStart: start,
  periodEnd: end,
  sourceType: 'external_report',
  sourceNamespace: 'instagram_insights',
  sourceNote: 'Weekly insights export',
  values: toValues(values),
  ...extra,
});

export const cumulativeBody = (publicationId: string, observedAt: string, values: Values, extra: Partial<ObservationInput> = {}): ObservationInput => ({
  entityType: 'publication',
  entityId: publicationId,
  kind: 'cumulative',
  observedAt,
  sourceType: 'manual',
  sourceNote: 'Post insights',
  values: toValues(values),
  ...extra,
});

export const record = (c: TestClient, f: InsightsFixture, body: ObservationInput, opts: { idempotencyKey?: string } = {}) => c.call(M.create, { params: f.p, body }, opts);
export const tryRecord = (c: TestClient, f: InsightsFixture, body: ObservationInput) => c.attempt(M.create, { params: f.p, body });

export const insertTask = async (f: InsightsFixture, extra: Partial<typeof tasks.$inferInsert> = {}) => {
  const id = newId();
  await db().insert(tasks).values({ id, workspaceId: f.ws.workspaceId, createdAt: LONG_AGO, updatedAt: LONG_AGO, projectId: f.projectId, title: `Task ${id.slice(0, 4)}`, status: 'in_progress', ...extra });
  return id;
};

export const insertApprovedTime = async (f: InsightsFixture, taskId: string, input: { membershipId: string; workDate: string; seconds: number; projectId?: string }) => {
  const id = newId();
  await db()
    .insert(timeEntries)
    .values({ id, workspaceId: f.ws.workspaceId, createdAt: LONG_AGO, updatedAt: LONG_AGO, membershipId: input.membershipId, taskId, projectId: input.projectId ?? f.projectId, source: 'manual', state: 'approved', durationSeconds: input.seconds, workDate: input.workDate, approvedAt: LONG_AGO });
  return id;
};

export const insertTaskComment = async (f: InsightsFixture, taskId: string, createdAt: string, projectId?: string) => {
  const when = new Date(createdAt);
  await db()
    .insert(comments)
    .values({ id: newId(), workspaceId: f.ws.workspaceId, createdAt: when, updatedAt: when, parentType: 'task', parentId: taskId, projectId: projectId ?? f.projectId, authorMembershipId: f.ws.owner.membershipId, body: 'Looks good' });
};

export const kpi = (d: { kpis: { metricId: string }[] }, id: string) => {
  const k = d.kpis.find((x) => x.metricId === id);
  if (!k) throw new Error(`KPI ${id} missing`);
  return k as { metricId: string; value: { status: string; value: string | null; note?: string; excluded?: { count: number; reason: string }[]; missing?: string[]; sampleSize?: number; coverage?: { usable: number; expected: number } }; previous: { status: string; value: string | null } | null; delta: { status: string; abs: string | null; pct: string | null; unitLabel: string } | null };
};

/** Semantic-layer query over a custom period (days back, inclusive), optionally compared and grouped. */
export const query = (c: TestClient, f: InsightsFixture, metrics: string[], fromDaysAgo: number, toDaysAgo: number, extra: { compare?: boolean; groupBy?: 'project' | 'account' | 'platform' | 'period' | 'publication' | 'member'; projectIds?: string[]; grain?: 'day' | 'week' } = {}) =>
  c.call(A.query, {
    params: f.p,
    body: { metrics, period: { preset: 'custom', from: isoDay(fromDaysAgo), to: isoDay(toDaysAgo) }, compare: extra.compare ?? false, filters: extra.projectIds ? { projectIds: extra.projectIds } : {}, groupBy: extra.groupBy, grain: extra.grain },
  });

export const result = (r: { results: { metricId: string }[] }, id: string) => {
  const x = r.results.find((y) => y.metricId === id);
  if (!x) throw new Error(`Result ${id} missing`);
  return x as (typeof r.results)[number] & {
    label: string;
    total: { status: string; value: string | null; note?: string; excluded?: { count: number; reason: string }[]; missing?: string[]; sampleSize?: number; coverage?: { usable: number; expected: number } };
    previous: { status: string; value: string | null } | null;
    delta: { status: string; abs: string | null; pct: string | null; unitLabel: string } | null;
    groups: { key: string | null; label: string; value: { status: string; value: string | null } }[] | null;
    series: { bucket: string; value: { status: string; value: string | null } }[] | null;
  };
};
