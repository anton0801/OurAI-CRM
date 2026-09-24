/**
 * Load runner for the staging load profile (spec §28.3, acceptance T170).
 *
 *   pnpm perf:run [--base-url http://127.0.0.1:3200] [--origin https://perf.castlane.invalid]
 *                 [--database-url postgres://…/castlane_perf] [--sessions 50] [--reads 30] [--writes 5]
 *                 [--burst-factor 3] [--warmup 30] [--steady 120] [--burst 30] [--cooldown 30]
 *                 [--server-note "…"] [--out docs/acceptance]
 *
 * Open-model load (arrival rate, not a closed loop): Poisson arrivals at the configured read and
 * write rates are dispatched regardless of how fast earlier requests finish, so server slowness shows
 * up as latency instead of silently lowering the offered load. Phases: warm-up (not recorded),
 * steady state, burst (× burst factor) and cool-down. Every request goes through the real HTTP API
 * of a running server with real sessions: 50 members of different roles get server sessions minted
 * directly in the database (like the test fixtures do; MFA is exercised by its own tests), then
 * load their CSRF token from /auth/me. Writes carry Origin, X-CSRF-Token, Idempotency-Key and
 * If-Match exactly like the browser client.
 *
 * During the run a sampler records queue lag (oldest due queued job and oldest undispatched outbox
 * event), backlog sizes and host CPU; afterwards job, outbox and export completion latencies of
 * everything created in the measured window are read from the database. Results are written to
 * docs/acceptance/performance-results.json and rendered to docs/acceptance/performance-report.md.
 */
import { readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { createSession } from '@castlane/application';
import { ROLE_PRESETS } from '@castlane/authorization';
import { createDatabase } from '@castlane/database';
import {
  ADJECTIVES,
  NOUNS,
  SEED_MANIFEST_KEY,
  TASK_OBJECTS,
  TASK_VERBS,
  arg,
  type SeedManifest,
} from './shared';
import {
  environmentInfo,
  summarize,
  writeReport,
  type Phase,
  type RunResults,
  type Sample,
  type ServiceTime,
} from './report';

// ——— Configuration ———

const num = (name: string, def: number) => {
  const v = arg(name);
  const n = v === undefined ? def : Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`--${name} must be a non-negative number`);
  return n;
};

const cfg = {
  /** One or more web servers (comma-separated); each session sticks to one, like a sticky load balancer. */
  baseUrls: (arg('base-url') ?? process.env.PERF_BASE_URL ?? 'http://127.0.0.1:3200')
    .split(',')
    .map((u) => u.trim().replace(/\/$/, '')),
  origin:
    arg('origin') ?? process.env.PERF_APP_ORIGIN ?? process.env.APP_ORIGIN ?? 'https://perf.castlane.invalid',
  databaseUrl:
    arg('database-url') ??
    process.env.PERF_DATABASE_URL ??
    'postgres://castlane:castlane@127.0.0.1:5432/castlane_perf',
  sessions: num('sessions', 50),
  reads: num('reads', 30),
  writes: num('writes', 5),
  burstFactor: num('burst-factor', 3),
  warmup: num('warmup', 30),
  steady: num('steady', 120),
  burst: num('burst', 30),
  cooldown: num('cooldown', 30),
  maxInFlight: num('max-in-flight', 500),
  timeoutMs: num('timeout-ms', 30_000),
  drainSeconds: num('drain', 180),
  seed: num('seed', 170),
  serverNote: arg('server-note') ?? process.env.PERF_SERVER_NOTE ?? 'not specified',
  out: arg('out') ?? 'docs/acceptance',
  /** Suffix of the output files (performance-report-<label>.md) for supplementary runs. */
  label: arg('label') ?? '',
  /** Operations left out of the mix (comma-separated names), e.g. for an isolating supplementary run. */
  exclude: (arg('exclude') ?? '').split(',').filter(Boolean),
  /** Sequential requests per operation before the load (unloaded service time); 0 skips. */
  serviceSamples: num('service-samples', 5),
  /** Process ids written by perf:stack, to attribute CPU time to web and worker. */
  stackFile: arg('stack-file') ?? 'var/perf/stack.json',
};

/** Sessions per role for 50 concurrent sessions (scaled proportionally for other counts). */
const SESSION_PLAN: Record<string, number> = {
  owner: 1,
  admin: 2,
  direction_lead: 5,
  project_lead: 10,
  producer: 8,
  creator: 10,
  publisher: 7,
  analyst: 4,
  finance_manager: 2,
  viewer: 1,
};

// Deterministic PRNG so two runs offer the same request sequence.
let rngState = cfg.seed >>> 0 || 1;
const rand = () => {
  rngState ^= rngState << 13;
  rngState >>>= 0;
  rngState ^= rngState >>> 17;
  rngState ^= rngState << 5;
  rngState >>>= 0;
  return rngState / 4294967296;
};
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
const chance = (p: number) => rand() < p;

// ——— Sessions ———

interface TaskRef {
  id: string;
  rowVersion: number;
  status: string;
}

interface Session {
  idx: number;
  role: string;
  userId: string;
  membershipId: string;
  token: string;
  csrf: string;
  perms: Set<string>;
  pools: {
    tasks: string[];
    projects: { id: string; name: string }[];
    accounts: string[];
    content: string[];
    publications: string[];
  };
  myTasks: TaskRef[];
  cursors: Map<string, string>;
  /** Ops that answered 403/404 for this member during discovery (not offered again). */
  denied: Set<string>;
  tabs: string[];
}

const PERMS = new Map(ROLE_PRESETS.map((r) => [r.key, new Set<string>(r.permissions)]));
const WS = () => manifest.workspaceId;
let manifest: SeedManifest;

const remember = <T>(xs: T[], x: T, max = 300) => {
  xs.push(x);
  if (xs.length > max) xs.splice(0, xs.length - max);
};

// ——— HTTP ———

interface Spec {
  method: 'GET' | 'POST' | 'PATCH';
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  ifMatch?: number;
  idempotent?: boolean;
}

interface Outcome {
  status: number;
  ms: number;
  json: unknown;
  code: string | null;
}

const newKey = () => globalThis.crypto.randomUUID();

const send = async (s: Session, spec: Spec): Promise<Outcome> => {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(spec.query ?? {}))
    if (v !== undefined && v !== '') qs.set(k, String(v));
  const url = `${cfg.baseUrls[s.idx % cfg.baseUrls.length]}/api/v1${spec.path}${qs.size ? `?${qs}` : ''}`;
  const headers: Record<string, string> = {
    accept: 'application/json',
    cookie: `castlane_session=${encodeURIComponent(s.token)}`,
    'user-agent': 'castlane-perf-runner',
  };
  if (spec.method !== 'GET') {
    headers['content-type'] = 'application/json';
    headers.origin = cfg.origin;
    headers['x-csrf-token'] = s.csrf;
    if (spec.idempotent) headers['idempotency-key'] = newKey();
  }
  if (spec.ifMatch !== undefined) headers['if-match'] = `"${spec.ifMatch}"`;
  const t0 = performance.now();
  try {
    const res = await fetch(url, {
      method: spec.method,
      headers,
      body: spec.method === 'GET' ? undefined : JSON.stringify(spec.body ?? {}),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    const text = await res.text();
    const ms = performance.now() - t0;
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    const code = res.ok
      ? null
      : ((json as { error?: { code?: string } } | null)?.error?.code ?? `HTTP_${res.status}`);
    return { status: res.status, ms, json, code };
  } catch (e) {
    const ms = performance.now() - t0;
    return {
      status: 0,
      ms,
      json: null,
      code: (e as Error).name === 'TimeoutError' ? 'CLIENT_TIMEOUT' : `NETWORK:${(e as Error).message}`,
    };
  }
};

const dataOf = <T>(o: Outcome) => (o.json as { data?: T } | null)?.data;

// ——— Operations (request mix) ———

type Cls = 'list' | 'detail' | 'search' | 'analytics' | 'write' | 'heavy';

interface Op {
  name: string;
  cls: Cls;
  stream: 'read' | 'write';
  weight: number;
  eligible(s: Session): boolean;
  build(s: Session): Spec | null;
  after?(s: Session, o: Outcome, spec: Spec): void;
}

const ws = () => `/workspaces/${WS()}`;
const today = () => new Date().toISOString().slice(0, 10);

const listVariant = (
  s: Session,
  key: string,
  variants: Record<string, string | number | boolean | undefined>[],
): Record<string, string | number | boolean | undefined> => {
  // 20% of list views continue to the next page of an earlier view (cursor pagination).
  const cursor = s.cursors.get(key);
  if (cursor && chance(0.2)) {
    s.cursors.delete(key);
    return JSON.parse(cursor) as Record<string, string | number | boolean | undefined>;
  }
  return { pageSize: 50, ...pick(variants) };
};

const rememberCursor = (s: Session, key: string, o: Outcome, spec: Spec) => {
  const d = dataOf<{ nextCursor?: string | null; hasMore?: boolean }>(o);
  if (d?.hasMore && d.nextCursor) s.cursors.set(key, JSON.stringify({ ...spec.query, cursor: d.nextCursor }));
};

const projectOf = (s: Session) => (s.pools.projects.length ? pick(s.pools.projects).id : undefined);

const OPS: Op[] = [
  // Lists (with filters and pagination)
  {
    name: 'tasks.list',
    cls: 'list',
    stream: 'read',
    weight: 8,
    eligible: (s) => s.perms.has('tasks.read'),
    build: (s) => ({
      method: 'GET',
      path: `${ws()}/tasks`,
      query: listVariant(s, 'tasks', [
        {},
        { assignee: 'me' },
        { assignee: 'me', status: 'ready,in_progress' },
        { projectId: projectOf(s) },
        { overdue: true },
        { sort: 'updatedAt', direction: 'desc' },
        { priority: 'high,urgent' },
      ]),
    }),
    after: (s, o, spec) => {
      rememberCursor(s, 'tasks', o, spec);
      for (const t of dataOf<{ items: { id: string }[] }>(o)?.items ?? []) remember(s.pools.tasks, t.id);
    },
  },
  {
    name: 'projects.list',
    cls: 'list',
    stream: 'read',
    weight: 4,
    eligible: (s) => s.perms.has('projects.read'),
    build: (s) => ({
      method: 'GET',
      path: `${ws()}/projects`,
      query: listVariant(s, 'projects', [
        {},
        { status: 'active' },
        { q: pick(NOUNS) },
        { sort: 'name', direction: 'asc' },
      ]),
    }),
    after: (s, o, spec) => {
      rememberCursor(s, 'projects', o, spec);
      for (const p of dataOf<{ items: { id: string; name: string }[] }>(o)?.items ?? [])
        if (!s.pools.projects.some((x) => x.id === p.id))
          remember(s.pools.projects, { id: p.id, name: p.name });
    },
  },
  {
    name: 'accounts.list',
    cls: 'list',
    stream: 'read',
    weight: 4,
    eligible: (s) => s.perms.has('accounts.read'),
    build: (s) => ({
      method: 'GET',
      path: `${ws()}/accounts`,
      query: listVariant(s, 'accounts', [
        {},
        { platform: 'instagram' },
        { projectId: projectOf(s) },
        { status: 'active' },
      ]),
    }),
    after: (s, o, spec) => {
      rememberCursor(s, 'accounts', o, spec);
      for (const a of dataOf<{ items: { id: string }[] }>(o)?.items ?? []) remember(s.pools.accounts, a.id);
    },
  },
  {
    name: 'content.list',
    cls: 'list',
    stream: 'read',
    weight: 6,
    eligible: (s) => s.perms.has('content.read'),
    build: (s) => ({
      method: 'GET',
      path: `${ws()}/content`,
      query: listVariant(s, 'content', [
        {},
        { stage: 'production,review' },
        { projectId: projectOf(s) },
        { mine: true },
        { format: 'short_video' },
      ]),
    }),
    after: (s, o, spec) => {
      rememberCursor(s, 'content', o, spec);
      for (const c of dataOf<{ items: { id: string }[] }>(o)?.items ?? []) remember(s.pools.content, c.id);
    },
  },
  {
    name: 'publications.list',
    cls: 'list',
    stream: 'read',
    weight: 6,
    eligible: (s) => s.perms.has('publications.read'),
    build: (s) => ({
      method: 'GET',
      path: `${ws()}/publications`,
      query: listVariant(s, 'publications', [
        {},
        { status: 'scheduled', direction: 'asc' },
        { projectId: projectOf(s) },
        { status: 'published' },
        { platform: 'tiktok' },
      ]),
    }),
    after: (s, o, spec) => {
      rememberCursor(s, 'publications', o, spec);
      for (const p of dataOf<{ items: { id: string }[] }>(o)?.items ?? [])
        remember(s.pools.publications, p.id);
    },
  },
  // Details (records the member saw in a list)
  {
    name: 'tasks.get',
    cls: 'detail',
    stream: 'read',
    weight: 10,
    eligible: (s) => s.perms.has('tasks.read'),
    build: (s) =>
      s.pools.tasks.length ? { method: 'GET', path: `${ws()}/tasks/${pick(s.pools.tasks)}` } : null,
  },
  {
    name: 'projects.get',
    cls: 'detail',
    stream: 'read',
    weight: 4,
    eligible: (s) => s.perms.has('projects.read'),
    build: (s) =>
      s.pools.projects.length
        ? { method: 'GET', path: `${ws()}/projects/${pick(s.pools.projects).id}` }
        : null,
  },
  {
    name: 'accounts.get',
    cls: 'detail',
    stream: 'read',
    weight: 4,
    eligible: (s) => s.perms.has('accounts.read'),
    build: (s) =>
      s.pools.accounts.length ? { method: 'GET', path: `${ws()}/accounts/${pick(s.pools.accounts)}` } : null,
  },
  {
    name: 'content.get',
    cls: 'detail',
    stream: 'read',
    weight: 6,
    eligible: (s) => s.perms.has('content.read'),
    build: (s) =>
      s.pools.content.length ? { method: 'GET', path: `${ws()}/content/${pick(s.pools.content)}` } : null,
  },
  {
    name: 'publications.get',
    cls: 'detail',
    stream: 'read',
    weight: 6,
    eligible: (s) => s.perms.has('publications.read'),
    build: (s) =>
      s.pools.publications.length
        ? { method: 'GET', path: `${ws()}/publications/${pick(s.pools.publications)}` }
        : null,
  },
  // Global search (command palette)
  {
    name: 'search.global',
    cls: 'search',
    stream: 'read',
    weight: 14,
    eligible: () => true,
    build: (s) => {
      const r = rand();
      const q =
        r < 0.3
          ? pick(NOUNS)
          : r < 0.55
            ? `${pick(ADJECTIVES)} ${pick(NOUNS)}`
            : r < 0.75
              ? `${pick(TASK_VERBS)} ${pick(TASK_OBJECTS).toLowerCase()}`
              : r < 0.9 && s.pools.projects.length
                ? pick(s.pools.projects).name
                : pick(NOUNS).slice(0, 4).toLowerCase();
      return { method: 'GET', path: `${ws()}/search`, query: { q, limit: 8 } };
    },
  },
  // Standard 90-day analytics (dashboard tabs the member may open). Usage model: an active member
  // opens a 90-day dashboard about every five minutes (50 members → ≈ 0.17/s ≈ 0.55 % of 30 reads/s).
  {
    name: 'analytics.dashboard',
    cls: 'analytics',
    stream: 'read',
    weight: 0.4,
    eligible: (s) => s.tabs.length > 0,
    build: (s) => ({
      method: 'GET',
      path: `${ws()}/analytics/dashboards/${pick(s.tabs)}`,
      query: { preset: 'last_90_days', compare: true },
    }),
  },
  // Critical writes
  {
    name: 'tasks.create',
    cls: 'write',
    stream: 'write',
    weight: 30,
    eligible: (s) => s.perms.has('tasks.create') && s.pools.projects.length > 0,
    build: (s) => ({
      method: 'POST',
      path: `${ws()}/tasks`,
      idempotent: true,
      body: {
        title: `${pick(TASK_VERBS)} ${pick(TASK_OBJECTS).toLowerCase()} — load ${Math.floor(rand() * 1e6)}`,
        projectId: pick(s.pools.projects).id,
        status: 'backlog',
        priority: pick(['normal', 'normal', 'high', 'low']),
        assigneeMembershipId: s.membershipId,
        estimateMinutes: 60,
      },
    }),
    after: (s, o) => {
      const t = dataOf<{ id: string; rowVersion: number; status: string }>(o);
      if (o.status === 201 && t) {
        remember(s.pools.tasks, t.id);
        remember(s.myTasks, { id: t.id, rowVersion: t.rowVersion, status: t.status }, 100);
      }
    },
  },
  {
    name: 'tasks.transition',
    cls: 'write',
    stream: 'write',
    weight: 30,
    eligible: (s) => s.perms.has('tasks.edit') && s.myTasks.length > 0,
    build: (s) => {
      const t = pick(s.myTasks);
      return {
        method: 'POST',
        path: `${ws()}/tasks/${t.id}/transition`,
        idempotent: true,
        ifMatch: t.rowVersion,
        body: { targetState: t.status === 'in_progress' ? 'ready' : 'in_progress' },
      };
    },
    after: (s, o, spec) => {
      const id = spec.path.split('/').at(-2);
      const ref = s.myTasks.find((x) => x.id === id);
      if (!ref) return;
      const d = dataOf<{ rowVersion: number; status: string }>(o);
      if (o.status === 200 && d) {
        ref.rowVersion = d.rowVersion;
        ref.status = d.status;
      } else {
        const cur = (o.json as { error?: { currentVersion?: number } } | null)?.error?.currentVersion;
        if (typeof cur === 'number') ref.rowVersion = cur;
        else s.myTasks.splice(s.myTasks.indexOf(ref), 1);
      }
    },
  },
  {
    name: 'comments.create',
    cls: 'write',
    stream: 'write',
    weight: 25,
    eligible: (s) => s.perms.has('tasks.edit') && (s.myTasks.length > 0 || s.pools.tasks.length > 0),
    build: (s) => ({
      method: 'POST',
      path: `${ws()}/comments`,
      idempotent: true,
      body: {
        parentType: 'task',
        parentId: s.myTasks.length && chance(0.7) ? pick(s.myTasks).id : pick(s.pools.tasks),
        body: `Progress note ${Math.floor(rand() * 1e6)}: ${pick(TASK_OBJECTS).toLowerCase()} is on track.`,
      },
    }),
  },
  {
    name: 'time.create',
    cls: 'write',
    stream: 'write',
    weight: 10,
    eligible: (s) => s.perms.has('time.write.own') && s.myTasks.length > 0,
    build: (s) => ({
      method: 'POST',
      path: `${ws()}/time-entries`,
      idempotent: true,
      body: {
        taskId: pick(s.myTasks).id,
        durationMinutes: 15 + Math.floor(rand() * 6) * 15,
        workDate: today(),
        note: 'Load profile entry',
      },
    }),
  },
  // Heavy request answered with a job (export of one project's tasks)
  {
    name: 'exports.create',
    cls: 'heavy',
    stream: 'write',
    weight: 5,
    eligible: (s) =>
      s.perms.has('exports.create') && s.perms.has('tasks.read') && s.pools.projects.length > 0,
    build: (s) => ({
      method: 'POST',
      path: `${ws()}/exports`,
      idempotent: true,
      body: {
        dataset: 'tasks',
        format: 'csv',
        fields: ['id', 'title', 'project', 'status', 'priority', 'assignee', 'due_at'],
        filters: { projectId: pick(s.pools.projects).id },
      },
    }),
  },
];

// ——— Setup: sessions and discovery ———

const planSessions = (total: number) => {
  const sum = Object.values(SESSION_PLAN).reduce((a, b) => a + b, 0);
  const plan = Object.entries(SESSION_PLAN).map(([role, n]) => ({
    role,
    n: Math.max(role === 'owner' ? 1 : 0, Math.round((n * total) / sum)),
  }));
  let diff = total - plan.reduce((a, b) => a + b.n, 0);
  for (const p of plan.sort((a, b) => b.n - a.n)) {
    if (diff === 0) break;
    if (diff > 0) {
      p.n++;
      diff--;
    } else if (p.n > 1) {
      p.n--;
      diff++;
    }
  }
  return plan.filter((p) => p.n > 0);
};

const mintSessions = async (pool: pg.Pool): Promise<Session[]> => {
  const members = (
    await pool.query(
      `SELECT r.key AS role, m.id AS membership_id, m.user_id
       FROM role_assignments ra JOIN roles r ON r.id = ra.role_id JOIN memberships m ON m.id = ra.membership_id
       WHERE ra.workspace_id = $1 AND ra.revoked_at IS NULL AND m.status = 'active'
       ORDER BY r.key, m.id`,
      [WS()],
    )
  ).rows as { role: string; membership_id: string; user_id: string }[];
  const byRole = new Map<string, typeof members>();
  for (const m of members) byRole.set(m.role, [...(byRole.get(m.role) ?? []), m]);
  const handle = createDatabase(cfg.databaseUrl, { max: 4 });
  const sessions: Session[] = [];
  for (const { role, n } of planSessions(cfg.sessions)) {
    const candidates = byRole.get(role) ?? [];
    if (!candidates.length) continue;
    for (let i = 0; i < n; i++) {
      const m = candidates[i % candidates.length]!;
      const { token } = await createSession(
        handle.db,
        m.user_id,
        new Date(),
        { userAgent: 'castlane-perf-runner', workspaceId: WS() },
        { mfaVerified: true },
      );
      sessions.push({
        idx: sessions.length,
        role,
        userId: m.user_id,
        membershipId: m.membership_id,
        token,
        csrf: '',
        perms: PERMS.get(role) ?? new Set(),
        pools: { tasks: [], projects: [], accounts: [], content: [], publications: [] },
        myTasks: [],
        cursors: new Map(),
        denied: new Set(),
        tabs: [],
      });
    }
  }
  await handle.close();
  return sessions;
};

const TAB_PERMISSION: Record<string, string> = {
  production: 'analytics.production.read',
  content: 'analytics.content.read',
  accounts: 'analytics.accounts.read',
};

const discover = async (s: Session) => {
  const me = await send(s, { method: 'GET', path: '/auth/me' });
  const csrf = dataOf<{ csrfToken?: string }>(me)?.csrfToken;
  if (me.status !== 200 || !csrf)
    throw new Error(`Session ${s.idx} (${s.role}) could not load /auth/me: ${me.status} ${me.code}`);
  s.csrf = csrf;
  // First page of each list the member may open (fills the id pools for detail views and writes).
  for (const name of ['projects.list', 'tasks.list', 'accounts.list', 'content.list', 'publications.list']) {
    const op = OPS.find((o) => o.name === name)!;
    if (!op.eligible(s)) continue;
    const spec: Spec = { method: 'GET', path: op.build(s)!.path, query: { pageSize: 50 } };
    const o = await send(s, spec);
    if (o.status === 403 || o.status === 404) s.denied.add(name);
    else op.after?.(s, o, spec);
  }
  if (s.perms.has('tasks.read')) {
    const o = await send(s, {
      method: 'GET',
      path: `${ws()}/tasks`,
      query: { assignee: 'me', status: 'ready,in_progress', pageSize: 50 },
    });
    for (const t of dataOf<{ items: TaskRef[] }>(o)?.items ?? [])
      remember(s.myTasks, { id: t.id, rowVersion: t.rowVersion, status: t.status }, 100);
  }
  for (const [tab, perm] of Object.entries(TAB_PERMISSION)) if (s.perms.has(perm)) s.tabs.push(tab);
};

// ——— Recording ———

export interface RequestRecord {
  op: string;
  cls: Cls;
  phase: string;
  ms: number;
  status: number;
  code: string | null;
  lagMs: number;
  role: string;
}

const records: RequestRecord[] = [];
const dropped: Record<string, number> = {};
const skipped: Record<string, number> = {};
let inFlight = 0;
let maxInFlightSeen = 0;

const fire = async (op: Op, s: Session, phase: Phase, scheduledAt: number) => {
  const spec = op.build(s);
  if (!spec) {
    skipped[op.name] = (skipped[op.name] ?? 0) + 1;
    return;
  }
  inFlight++;
  maxInFlightSeen = Math.max(maxInFlightSeen, inFlight);
  const lagMs = performance.now() - scheduledAt;
  try {
    const o = await send(s, spec);
    op.after?.(s, o, spec);
    if (phase.record)
      records.push({
        op: op.name,
        cls: op.cls,
        phase: phase.name,
        ms: o.ms,
        status: o.status,
        code: o.code,
        lagMs,
        role: s.role,
      });
  } finally {
    inFlight--;
  }
};

const activeOps = () => OPS.filter((o) => !cfg.exclude.includes(o.name));

const chooseOp = (stream: 'read' | 'write', sessions: Session[]): { op: Op; s: Session } | null => {
  const ops = activeOps().filter((o) => o.stream === stream);
  for (let attempt = 0; attempt < 20; attempt++) {
    const total = ops.reduce((a, o) => a + o.weight, 0);
    let r = rand() * total;
    const op = ops.find((o) => (r -= o.weight) < 0) ?? ops[ops.length - 1]!;
    const eligible = sessions.filter((s) => op.eligible(s) && !s.denied.has(op.name));
    if (eligible.length) return { op, s: pick(eligible) };
  }
  return null;
};

// ——— Sampler (queue lag, backlog, CPU) ———

const cpuTimes = () => {
  try {
    const line = readFileSync('/proc/stat', 'utf8').split('\n')[0]!.trim().split(/\s+/).slice(1).map(Number);
    const idle = (line[3] ?? 0) + (line[4] ?? 0);
    return { idle, total: line.reduce((a, b) => a + b, 0) };
  } catch {
    return null;
  }
};

/** CPU ticks (utime + stime, 1/100 s) of a process and all its descendants. */
const treeTicks = (rootPid: number): number | null => {
  try {
    const stats = new Map<number, { ppid: number; ticks: number }>();
    for (const d of readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue;
      try {
        const raw = readFileSync(`/proc/${d}/stat`, 'utf8');
        const f = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
        stats.set(Number(d), { ppid: Number(f[1]), ticks: Number(f[11]) + Number(f[12]) });
      } catch {
        // process exited while scanning
      }
    }
    if (!stats.has(rootPid)) return null;
    let sum = 0;
    for (const [pid, s] of stats) {
      let cur: number | undefined = pid;
      for (let depth = 0; cur && depth < 20; depth++) {
        if (cur === rootPid) {
          sum += s.ticks;
          break;
        }
        cur = stats.get(cur)?.ppid;
      }
    }
    return sum;
  } catch {
    return null;
  }
};

/** CPU ticks per process id (PostgreSQL backends of the load database). */
const sumOrNull = (xs: (number | null)[]) =>
  xs.some((x) => x === null) ? null : xs.reduce<number>((a, b) => a + (b ?? 0), 0);

const pidTicks = (pids: number[]) => {
  const out = new Map<number, number>();
  for (const pid of pids) {
    try {
      const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const f = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
      out.set(pid, Number(f[11]) + Number(f[12]));
    } catch {
      // backend gone
    }
  }
  return out;
};

const readStack = (): { webPids?: number[]; workerPid?: number } => {
  try {
    return JSON.parse(readFileSync(cfg.stackFile, 'utf8')) as { webPids?: number[]; workerPid?: number };
  } catch {
    return {};
  }
};

const startSampler = async (pool: pg.Pool, phaseOf: () => Phase, t0: number) => {
  const samples: Sample[] = [];
  let lastCpu = cpuTimes();
  const stack = readStack();
  const procTicks = async () => {
    const backends = (
      await pool.query(
        `SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`,
      )
    ).rows.map((r: { pid: number }) => r.pid);
    const self = process.cpuUsage();
    return {
      at: performance.now(),
      web: stack.webPids?.length ? sumOrNull(stack.webPids.map((pid) => treeTicks(pid))) : null,
      worker: stack.workerPid ? treeTicks(stack.workerPid) : null,
      pg: pidTicks(backends),
      runner: (self.user + self.system) / 10_000,
    };
  };
  let lastProc = await procTicks();
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const r = (
        await pool.query(`
          SELECT
            (SELECT extract(epoch FROM now() - min(greatest(created_at, run_at))) FROM jobs WHERE state = 'queued' AND run_at <= now()) AS oldest_job_s,
            (SELECT count(*) FROM jobs WHERE state = 'queued' AND run_at <= now()) AS queued_jobs,
            (SELECT count(*) FROM jobs WHERE state = 'running') AS running_jobs,
            (SELECT extract(epoch FROM now() - min(occurred_at)) FROM outbox_events WHERE dispatched_at IS NULL) AS oldest_outbox_s,
            (SELECT count(*) FROM outbox_events WHERE dispatched_at IS NULL) AS pending_outbox,
            (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND state = 'active') AS active_db_backends`)
      ).rows[0] as Record<string, string | null>;
      const proc = await procTicks();
      const secs = (proc.at - lastProc.at) / 1000;
      const pctOf = (a: number | null, b: number | null) =>
        a === null || b === null || secs <= 0 ? null : Math.round(((a - b) / secs) * 10) / 10;
      // Backends present in both samples (a new connection's earlier ticks are not in this interval).
      let pgDelta = 0;
      for (const [pid, ticks] of proc.pg) {
        const before = lastProc.pg.get(pid);
        if (before !== undefined) pgDelta += ticks - before;
      }
      const procCpu = {
        webPct: pctOf(proc.web, lastProc.web),
        workerPct: pctOf(proc.worker, lastProc.worker),
        pgPct: pctOf(pgDelta, 0),
        runnerPct: pctOf(proc.runner, lastProc.runner),
      };
      lastProc = proc;
      const cpu = cpuTimes();
      const cpuBusyPct =
        cpu && lastCpu && cpu.total > lastCpu.total
          ? Math.round((1 - (cpu.idle - lastCpu.idle) / (cpu.total - lastCpu.total)) * 1000) / 10
          : null;
      lastCpu = cpu;
      samples.push({
        t: Math.round((performance.now() - t0) / 100) / 10,
        phase: phaseOf().name,
        oldestJobS: r.oldest_job_s === null ? 0 : Number(r.oldest_job_s),
        queuedJobs: Number(r.queued_jobs),
        runningJobs: Number(r.running_jobs),
        oldestOutboxS: r.oldest_outbox_s === null ? 0 : Number(r.oldest_outbox_s),
        pendingOutbox: Number(r.pending_outbox),
        activeDbBackends: Number(r.active_db_backends),
        cpuBusyPct,
        ...procCpu,
        inFlight,
      });
    } catch {
      // sampling must never disturb the run
    } finally {
      busy = false;
    }
  }, 2000);
  return { samples, stop: () => clearInterval(timer) };
};

// ——— Arrival schedule (Poisson process per stream) ———

interface Arrival {
  at: number;
  stream: 'read' | 'write';
  phase: Phase;
}

const schedule = (phases: Phase[]): Arrival[] => {
  const out: Arrival[] = [];
  let offset = 0;
  for (const ph of phases) {
    for (const [stream, rate] of [
      ['read', cfg.reads * ph.factor],
      ['write', cfg.writes * ph.factor],
    ] as const) {
      if (rate <= 0) continue;
      let t = 0;
      for (;;) {
        t += -Math.log(1 - rand()) / rate;
        if (t >= ph.seconds) break;
        out.push({ at: offset + t, stream, phase: ph });
      }
    }
    ph.startS = offset;
    offset += ph.seconds;
  }
  return out.sort((a, b) => a.at - b.at);
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ——— Main ———

const main = async () => {
  const pool = new pg.Pool({
    connectionString: cfg.databaseUrl,
    max: 3,
    application_name: 'castlane-perf-runner',
  });
  const m = (await pool.query(`SELECT value FROM system_state WHERE key = $1`, [SEED_MANIFEST_KEY]))
    .rows[0] as { value: SeedManifest } | undefined;
  if (!m) throw new Error(`No seed manifest in ${cfg.databaseUrl}; run pnpm perf:seed first.`);
  manifest = m.value;
  console.log(
    `Workspace ${manifest.workspaceId} (seed scale ${manifest.scale}); target ${cfg.baseUrls.join(', ')}`,
  );

  for (const base of cfg.baseUrls) {
    const health = await fetch(`${base}/api/v1/auth/csrf`).catch(() => null);
    if (!health) throw new Error(`Server ${base} is not reachable.`);
  }

  const sessions = await mintSessions(pool);
  console.log(
    `Minted ${sessions.length} sessions: ${Object.entries(
      sessions.reduce<Record<string, number>>((a, s) => ({ ...a, [s.role]: (a[s.role] ?? 0) + 1 }), {}),
    )
      .map(([k, v]) => `${k} ${v}`)
      .join(', ')}`,
  );
  const tDisc = performance.now();
  for (let i = 0; i < sessions.length; i += 10) await Promise.all(sessions.slice(i, i + 10).map(discover));
  console.log(
    `Discovery done in ${((performance.now() - tDisc) / 1000).toFixed(1)}s (id pools filled from first list pages).`,
  );

  // Unloaded service time: a few sequential requests per operation before any load.
  const serviceTimes: ServiceTime[] = [];
  if (cfg.serviceSamples > 0) {
    const tSvc = performance.now();
    for (const op of activeOps()) {
      const eligible = sessions.filter((s) => op.eligible(s) && !s.denied.has(op.name));
      const ms: number[] = [];
      let errors = 0;
      for (let i = 0; i < cfg.serviceSamples && eligible.length; i++) {
        const s = eligible[(i * 7) % eligible.length]!;
        const spec = op.build(s);
        if (!spec) continue;
        const o = await send(s, spec);
        op.after?.(s, o, spec);
        if (o.status >= 200 && o.status < 300) ms.push(o.ms);
        else errors++;
      }
      ms.sort((a, b) => a - b);
      serviceTimes.push({
        op: op.name,
        cls: op.cls,
        samples: ms.length,
        errors,
        p50: ms.length ? Math.round(ms[Math.ceil(ms.length / 2) - 1]!) : null,
        max: ms.length ? Math.round(ms[ms.length - 1]!) : null,
      });
    }
    console.log(`Unloaded service times measured in ${((performance.now() - tSvc) / 1000).toFixed(1)}s.`);
  }
  const loadBefore = os.loadavg();

  const phases: Phase[] = [
    { name: 'warmup', seconds: cfg.warmup, factor: 1, record: false, startS: 0 },
    { name: 'steady', seconds: cfg.steady, factor: 1, record: true, startS: 0 },
    { name: 'burst', seconds: cfg.burst, factor: cfg.burstFactor, record: true, startS: 0 },
    { name: 'cooldown', seconds: cfg.cooldown, factor: 1, record: true, startS: 0 },
  ].filter((p) => p.seconds > 0);
  const arrivals = schedule(phases);
  console.log(
    `Offered load: ${arrivals.length} requests over ${phases.reduce((a, p) => a + p.seconds, 0)} s (${phases.map((p) => `${p.name} ${p.seconds}s ×${p.factor}`).join(', ')})`,
  );

  const dbNow = async () => new Date(((await pool.query(`SELECT now() AS t`)).rows[0] as { t: Date }).t);
  const measuredFrom = { wall: 0, db: new Date(0) };
  let current: Phase = phases[0]!;
  const start = performance.now();
  const sampler = await startSampler(pool, () => current, start);
  const sentByPhase: Record<string, { read: number; write: number }> = {};
  for (const a of arrivals) {
    const due = start + a.at * 1000;
    const wait = due - performance.now();
    if (wait > 1) await sleep(wait);
    if (a.phase !== current) {
      current = a.phase;
      console.log(`→ ${current.name} (${current.seconds}s, ×${current.factor})`);
      if (current.record && !measuredFrom.wall) {
        measuredFrom.wall = performance.now();
        measuredFrom.db = await dbNow();
      }
    }
    const picked = chooseOp(a.stream, sessions);
    if (!picked) continue;
    if (inFlight >= cfg.maxInFlight) {
      if (a.phase.record) dropped[picked.op.name] = (dropped[picked.op.name] ?? 0) + 1;
      continue;
    }
    const counter = (sentByPhase[a.phase.name] ??= { read: 0, write: 0 });
    counter[a.stream]++;
    void fire(picked.op, picked.s, a.phase, due);
  }
  const endOffered = performance.now();
  while (inFlight > 0 && performance.now() - endOffered < cfg.timeoutMs + 5000) await sleep(100);
  const measuredTo = await dbNow();
  console.log(`Load finished; ${records.length} measured requests. Waiting for queues to drain…`);

  // Drain: wait until jobs and outbox events created in the measured window are processed.
  const drainStart = performance.now();
  let drained = false;
  while ((performance.now() - drainStart) / 1000 < cfg.drainSeconds) {
    const r = (
      await pool.query(
        `SELECT (SELECT count(*) FROM jobs WHERE created_at >= $1 AND state IN ('queued','running') AND run_at <= now()) AS jobs,
                (SELECT count(*) FROM outbox_events WHERE occurred_at >= $1 AND dispatched_at IS NULL) AS outbox`,
        [measuredFrom.db],
      )
    ).rows[0] as { jobs: string; outbox: string };
    if (Number(r.jobs) === 0 && Number(r.outbox) === 0) {
      drained = true;
      break;
    }
    await sleep(2000);
  }
  sampler.stop();
  const drainSeconds = Math.round((performance.now() - drainStart) / 100) / 10;

  const jobs = (
    await pool.query(
      `SELECT type, pool, count(*)::int AS n, count(*) FILTER (WHERE state <> 'succeeded')::int AS not_succeeded,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM finished_at - greatest(created_at, run_at))) AS p50,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM finished_at - greatest(created_at, run_at))) AS p95,
              max(extract(epoch FROM finished_at - greatest(created_at, run_at))) AS max
       FROM jobs WHERE created_at >= $1 AND created_at <= $2 GROUP BY type, pool ORDER BY n DESC`,
      [measuredFrom.db, measuredTo],
    )
  ).rows as {
    type: string;
    pool: string;
    n: number;
    not_succeeded: number;
    p50: number | null;
    p95: number | null;
    max: number | null;
  }[];
  const outbox = (
    await pool.query(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE dispatched_at IS NULL)::int AS pending,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM dispatched_at - occurred_at)) AS p50,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM dispatched_at - occurred_at)) AS p95,
              max(extract(epoch FROM dispatched_at - occurred_at)) AS max
       FROM outbox_events WHERE occurred_at >= $1 AND occurred_at <= $2`,
      [measuredFrom.db, measuredTo],
    )
  ).rows[0] as { n: number; pending: number; p50: number | null; p95: number | null; max: number | null };
  const exportsDone = (
    await pool.query(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE state = 'completed')::int AS completed, count(*) FILTER (WHERE state = 'failed')::int AS failed,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM completed_at - created_at)) AS p50,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM completed_at - created_at)) AS p95,
              max(extract(epoch FROM completed_at - created_at)) AS max
       FROM export_jobs WHERE workspace_id = $1 AND created_at >= $2 AND created_at <= $3`,
      [WS(), measuredFrom.db, measuredTo],
    )
  ).rows[0] as {
    n: number;
    completed: number;
    failed: number;
    p50: number | null;
    p95: number | null;
    max: number | null;
  };

  const env = await environmentInfo(pool, cfg.databaseUrl);
  env.host.loadAverageBefore = loadBefore.map((x) => Math.round(x * 100) / 100);
  await pool.end();

  const measuredSeconds = phases.filter((p) => p.record).reduce((a, p) => a + p.seconds, 0);
  const results: RunResults = summarize({
    cfg: { ...cfg, sessionsMinted: sessions.length, sessionPlan: planSessions(cfg.sessions) },
    manifest,
    env,
    phases,
    records,
    dropped,
    skipped,
    sentByPhase,
    samples: sampler.samples,
    measuredSeconds,
    maxInFlightSeen,
    queue: {
      drained,
      drainSeconds,
      jobs: jobs.map((j) => ({
        ...j,
        p50: j.p50 === null ? null : Number(j.p50),
        p95: j.p95 === null ? null : Number(j.p95),
        max: j.max === null ? null : Number(j.max),
      })),
      outbox: {
        ...outbox,
        p50: outbox.p50 === null ? null : Number(outbox.p50),
        p95: outbox.p95 === null ? null : Number(outbox.p95),
        max: outbox.max === null ? null : Number(outbox.max),
      },
      exports: {
        ...exportsDone,
        p50: exportsDone.p50 === null ? null : Number(exportsDone.p50),
        p95: exportsDone.p95 === null ? null : Number(exportsDone.p95),
        max: exportsDone.max === null ? null : Number(exportsDone.max),
      },
    },
    sessionsByRole: sessions.reduce<Record<string, { sessions: number; ops: string[] }>>((a, s) => {
      const e = (a[s.role] ??= {
        sessions: 0,
        ops: activeOps()
          .filter((o) => o.eligible(s) && !s.denied.has(o.name))
          .map((o) => o.name),
      });
      e.sessions++;
      return a;
    }, {}),
    mix: activeOps().map((o) => ({ name: o.name, cls: o.cls, stream: o.stream, weight: o.weight })),
    excluded: cfg.exclude,
    serviceTimes,
  });
  const files = writeReport(results, cfg.out, cfg.label);
  console.log(
    `\n${results.classes.map((c) => `${c.label.padEnd(34)} n=${String(c.count).padStart(5)}  p95=${c.p95 === null ? '—' : c.p95.toFixed(0).padStart(6)} ms  ≤ ${c.threshold} ms  ${c.verdict}`).join('\n')}`,
  );
  console.log(`\nWrote ${files.join(', ')}`);
};

main().catch((e) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : e);
  process.exit(1);
});
