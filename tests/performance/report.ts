/**
 * Measurement report of the load runner (spec §28.3, acceptance T170).
 *
 *   pnpm perf:report [--in docs/acceptance/performance-results.json] [--out docs/acceptance]
 *
 * `run.ts` calls `summarize` + `writeReport` at the end of a run; this CLI re-renders the Markdown
 * from an existing results JSON (for example after editing tests/performance/analysis.md, whose
 * content is included verbatim as the analysis section).
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { SPEC_VOLUMES, THRESHOLDS, arg, type SeedManifest } from './shared';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const ANALYSIS_FILE = join(here, 'analysis.md');

export interface Phase {
  name: string;
  seconds: number;
  factor: number;
  record: boolean;
  startS: number;
}

export interface ServiceTime {
  op: string;
  cls: string;
  samples: number;
  errors: number;
  p50: number | null;
  max: number | null;
}

export interface Sample {
  t: number;
  phase: string;
  oldestJobS: number;
  queuedJobs: number;
  runningJobs: number;
  oldestOutboxS: number;
  pendingOutbox: number;
  activeDbBackends: number;
  cpuBusyPct: number | null;
  /** CPU of the web process tree, the worker process tree, the load database's PostgreSQL backends and the runner (100 % = one core). */
  webPct?: number | null;
  workerPct?: number | null;
  pgPct?: number | null;
  runnerPct?: number | null;
  inFlight: number;
}

interface Rec {
  op: string;
  cls: string;
  phase: string;
  ms: number;
  status: number;
  code: string | null;
  lagMs: number;
  role: string;
}

interface Stats {
  count: number;
  ok: number;
  errors: number;
  errorRate: number;
  rateLimited: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
  mean: number | null;
}

export interface Environment {
  generatedAt: string;
  commit: string;
  host: {
    cpuModel: string;
    cpus: number;
    memoryGiB: number;
    os: string;
    /** 1/5/15-minute load average when the load started and when the run ended. */
    loadAverageBefore?: number[];
    loadAverage: number[];
  };
  node: string;
  postgres: { version: string; settings: Record<string, string>; databaseBytes: number };
}

export interface RunResults {
  generatedAt: string;
  environment: Environment;
  config: Record<string, unknown>;
  seed: SeedManifest;
  volumes: { key: string; spec: number; seeded: number; ratio: number }[];
  profile: {
    phases: (Phase & {
      offeredReadPerS: number;
      offeredWritePerS: number;
      achievedReadPerS: number;
      achievedWritePerS: number;
      completed: number;
    })[];
    measuredSeconds: number;
    maxInFlight: number;
    dispatchLagP95Ms: number | null;
    dropped: Record<string, number>;
    skipped: Record<string, number>;
    sessionsByRole: Record<string, { sessions: number; ops: string[] }>;
    mix: { name: string; cls: string; stream: string; weight: number }[];
    /** Operations left out of this run's mix. */
    excluded?: string[];
  };
  /** Sequential requests per operation before the load (no concurrency). */
  serviceTimes?: ServiceTime[];
  classes: (Stats & {
    cls: string;
    label: string;
    threshold: number;
    verdict: 'PASS' | 'FAIL' | 'NO DATA';
    byPhase: Record<string, number | null>;
  })[];
  ops: (Stats & { op: string; cls: string; codes: Record<string, number> })[];
  queue: {
    samples: number;
    byPhase: Record<
      string,
      {
        oldestJobMaxS: number;
        oldestJobP95S: number;
        queuedJobsMax: number;
        oldestOutboxMaxS: number;
        oldestOutboxP95S: number;
        pendingOutboxMax: number;
        cpuAvgPct: number | null;
        cpuMaxPct: number | null;
        webCpuAvgPct?: number | null;
        webCpuMaxPct?: number | null;
        workerCpuAvgPct?: number | null;
        pgCpuAvgPct?: number | null;
        runnerCpuAvgPct?: number | null;
      }
    >;
    drained: boolean;
    drainSeconds: number;
    jobs: {
      type: string;
      pool: string;
      n: number;
      not_succeeded: number;
      p50: number | null;
      p95: number | null;
      max: number | null;
    }[];
    outbox: { n: number; pending: number; p50: number | null; p95: number | null; max: number | null };
    exports: {
      n: number;
      completed: number;
      failed: number;
      p50: number | null;
      p95: number | null;
      max: number | null;
    };
  };
  timeline: Sample[];
}

// ——— Statistics ———

const pct = (sorted: number[], p: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]! : null;
const round = (v: number | null, d = 1) => (v === null ? null : Math.round(v * 10 ** d) / 10 ** d);

const stats = (rs: Rec[]): Stats => {
  const ok = rs.filter((r) => r.status >= 200 && r.status < 300);
  const lat = ok.map((r) => r.ms).sort((a, b) => a - b);
  const rateLimited = rs.filter((r) => r.status === 429).length;
  const errors = rs.length - ok.length;
  return {
    count: rs.length,
    ok: ok.length,
    errors,
    errorRate: rs.length ? round(errors / rs.length, 4)! : 0,
    rateLimited,
    p50: round(pct(lat, 0.5)),
    p95: round(pct(lat, 0.95)),
    p99: round(pct(lat, 0.99)),
    max: round(lat.length ? lat[lat.length - 1]! : null),
    mean: round(lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length : null),
  };
};

const ERROR_BUDGET = 0.01;

const numbers = (xs: (number | null | undefined)[]) => xs.filter((x): x is number => typeof x === 'number');
const avgOf = (xs: (number | null | undefined)[]) => {
  const v = numbers(xs);
  return v.length ? round(v.reduce((a, b) => a + b, 0) / v.length) : null;
};
const maxOf = (xs: (number | null | undefined)[]) => {
  const v = numbers(xs);
  return v.length ? Math.max(...v) : null;
};

export const summarize = (input: {
  cfg: Record<string, unknown>;
  manifest: SeedManifest;
  env: Environment;
  phases: Phase[];
  records: Rec[];
  dropped: Record<string, number>;
  skipped: Record<string, number>;
  sentByPhase: Record<string, { read: number; write: number }>;
  samples: Sample[];
  measuredSeconds: number;
  maxInFlightSeen: number;
  queue: Omit<RunResults['queue'], 'samples' | 'byPhase'>;
  sessionsByRole: RunResults['profile']['sessionsByRole'];
  mix: RunResults['profile']['mix'];
  excluded: string[];
  serviceTimes: ServiceTime[];
}): RunResults => {
  const { records, phases } = input;
  const measured = phases.filter((p) => p.record);
  const classes = Object.entries(THRESHOLDS).map(([cls, t]) => {
    const rs = records.filter((r) => r.cls === cls);
    const s = stats(rs);
    const verdict: 'PASS' | 'FAIL' | 'NO DATA' =
      s.p95 === null ? 'NO DATA' : s.p95 <= t.p95 && s.errorRate <= ERROR_BUDGET ? 'PASS' : 'FAIL';
    return {
      cls,
      label: t.label,
      threshold: t.p95,
      ...s,
      verdict,
      byPhase: Object.fromEntries(
        measured.map((p) => [p.name, stats(rs.filter((r) => r.phase === p.name)).p95]),
      ),
    };
  });
  const ops = [...new Set(records.map((r) => r.op))].map((op) => {
    const rs = records.filter((r) => r.op === op);
    const codes: Record<string, number> = {};
    for (const r of rs) if (r.code) codes[r.code] = (codes[r.code] ?? 0) + 1;
    return { op, cls: rs[0]!.cls, ...stats(rs), codes };
  });
  const lags = records.map((r) => r.lagMs).sort((a, b) => a - b);
  const byPhase: RunResults['queue']['byPhase'] = {};
  for (const p of phases) {
    const ss = input.samples.filter((s) => s.phase === p.name);
    if (!ss.length) continue;
    const jobs = ss.map((s) => s.oldestJobS).sort((a, b) => a - b);
    const outbox = ss.map((s) => s.oldestOutboxS).sort((a, b) => a - b);
    const cpu = ss.map((s) => s.cpuBusyPct).filter((x): x is number => x !== null);
    byPhase[p.name] = {
      oldestJobMaxS: round(Math.max(...jobs))!,
      oldestJobP95S: round(pct(jobs, 0.95))!,
      queuedJobsMax: Math.max(...ss.map((s) => s.queuedJobs)),
      oldestOutboxMaxS: round(Math.max(...outbox))!,
      oldestOutboxP95S: round(pct(outbox, 0.95))!,
      pendingOutboxMax: Math.max(...ss.map((s) => s.pendingOutbox)),
      cpuAvgPct: cpu.length ? round(cpu.reduce((a, b) => a + b, 0) / cpu.length) : null,
      cpuMaxPct: cpu.length ? Math.max(...cpu) : null,
      webCpuAvgPct: avgOf(ss.map((x) => x.webPct)),
      webCpuMaxPct: maxOf(ss.map((x) => x.webPct)),
      workerCpuAvgPct: avgOf(ss.map((x) => x.workerPct)),
      pgCpuAvgPct: avgOf(ss.map((x) => x.pgPct)),
      runnerCpuAvgPct: avgOf(ss.map((x) => x.runnerPct)),
    };
  }
  const volumes = Object.entries(SPEC_VOLUMES).map(([key, spec]) => ({
    key,
    spec,
    seeded: input.manifest.counts[key] ?? 0,
    ratio: round((input.manifest.counts[key] ?? 0) / spec, 3)!,
  }));
  return {
    generatedAt: new Date().toISOString(),
    environment: input.env,
    config: input.cfg,
    seed: input.manifest,
    volumes,
    profile: {
      phases: phases.map((p) => {
        const sent = input.sentByPhase[p.name] ?? { read: 0, write: 0 };
        return {
          ...p,
          offeredReadPerS: Number(input.cfg.reads) * p.factor,
          offeredWritePerS: Number(input.cfg.writes) * p.factor,
          achievedReadPerS: round(sent.read / p.seconds, 2)!,
          achievedWritePerS: round(sent.write / p.seconds, 2)!,
          completed: records.filter((r) => r.phase === p.name).length,
        };
      }),
      measuredSeconds: input.measuredSeconds,
      maxInFlight: input.maxInFlightSeen,
      dispatchLagP95Ms: round(pct(lags, 0.95)),
      dropped: input.dropped,
      skipped: input.skipped,
      sessionsByRole: input.sessionsByRole,
      mix: input.mix,
      excluded: input.excluded,
    },
    serviceTimes: input.serviceTimes,
    classes,
    ops: ops.sort((a, b) => a.cls.localeCompare(b.cls) || a.op.localeCompare(b.op)),
    queue: { samples: input.samples.length, byPhase, ...input.queue },
    timeline: input.samples,
  };
};

// ——— Environment ———

export const environmentInfo = async (pool: pg.Pool, databaseUrl: string): Promise<Environment> => {
  const version = ((await pool.query(`SELECT version() AS v`)).rows[0] as { v: string }).v;
  const settings: Record<string, string> = {};
  for (const name of [
    'shared_buffers',
    'work_mem',
    'effective_cache_size',
    'max_connections',
    'random_page_cost',
    'max_parallel_workers_per_gather',
    'jit',
  ]) {
    const r = await pool.query(`SELECT current_setting($1) AS v`, [name]).catch(() => null);
    if (r) settings[name] = (r.rows[0] as { v: string }).v;
  }
  const size = Number(
    ((await pool.query(`SELECT pg_database_size(current_database())::bigint AS b`)).rows[0] as { b: string })
      .b,
  );
  void databaseUrl;
  let commit = 'unknown';
  try {
    commit = execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim();
  } catch {
    /* not a git checkout */
  }
  const cpus = os.cpus();
  return {
    generatedAt: new Date().toISOString(),
    commit,
    host: {
      cpuModel: cpus[0]?.model ?? 'unknown',
      cpus: cpus.length,
      memoryGiB: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
      os: `${os.type()} ${os.release()} (${os.arch()})`,
      loadAverage: os.loadavg().map((x) => Math.round(x * 100) / 100),
    },
    node: process.version,
    postgres: { version, settings, databaseBytes: size },
  };
};

// ——— Markdown ———

const ms = (v: number | null) => (v === null ? '—' : `${v.toFixed(0)} ms`);
const s1 = (v: number | null) => (v === null ? '—' : `${v.toFixed(1)} s`);
const n = (v: number) => v.toLocaleString('en');
const pctOf = (v: number) => `${(v * 100).toFixed(2)} %`;

export const renderReport = (r: RunResults, label = ''): string => {
  const e = r.environment;
  const c = r.config as Record<string, string | number>;
  const measured = r.profile.phases.filter((p) => p.record);
  const lines: string[] = [];
  const push = (...xs: string[]) => lines.push(...xs);
  const pass = r.classes.filter((x) => x.verdict === 'PASS').length;
  const fail = r.classes.filter((x) => x.verdict === 'FAIL').length;

  push(
    '# Performance report: staging load profile (T170)',
    '',
    `Generated ${r.generatedAt} from commit \`${e.commit}\` by \`pnpm perf:run\` (tests/performance). Raw numbers: ` +
      `[\`${fileBase('performance-results', label)}.json\`](${fileBase('performance-results', label)}.json).`,
    '',
    ...(r.profile.excluded?.length
      ? [
          `> **Supplementary run:** \`${r.profile.excluded.join('`, `')}\` left out of the mix to isolate the other classes. The acceptance`,
          '> verdict comes from the full profile in `performance-report.md`.',
          '',
        ]
      : []),
    '> **Where this was measured.** This run used the development container described under Environment, not the fixed staging',
    '> hardware that spec §28.3 names. PostgreSQL, the web server, the worker and the load generator shared the same',
    `> ${e.host.cpus} CPUs. The numbers show how this build behaves under the §28.3 profile with §28.3 data volumes on this`,
    '> machine. They do not certify staging, so repeat the run on staging before sign-off (see “Re-running on staging”).',
    '',
    `**Result: ${pass} of ${r.classes.length} threshold classes pass${fail ? `, ${fail} fail` : ''}** (p95 over ${r.profile.measuredSeconds} s of measured load: steady state, the ×${measured.find((p) => p.name === 'burst')?.factor ?? '—'} burst and cool-down; a class also fails when more than 1 % of its requests error).`,
    '',
    '| Class | Threshold (p95) | p50 | p95 | p99 | max | Requests | Errors | Verdict |',
    '|---|---|---|---|---|---|---|---|---|',
    ...r.classes.map(
      (x) =>
        `| ${x.label} | ≤ ${n(x.threshold)} ms | ${ms(x.p50)} | **${ms(x.p95)}** | ${ms(x.p99)} | ${ms(x.max)} | ${n(x.count)} | ${x.errors} (${pctOf(x.errorRate)}) | ${x.verdict === 'PASS' ? '✅ PASS' : x.verdict === 'FAIL' ? '❌ FAIL' : '— no data'} |`,
    ),
    '',
    'Class membership: *API list* = task, project, account, content and publication lists (filters, sorting, 20 % next-page cursors);',
    '*API detail* = the same records opened from those lists; *Search* = the global search palette; *Standard 90-day analytics* =',
    'analytics dashboard tabs (production, content, accounts) for `last_90_days` with comparison; *Critical writes* = create task,',
    'status transition with If-Match, comment, time entry; *Heavy request* = export request answered by a background job (time to 202).',
    '',
  );

  push(
    '## p95 by phase',
    '',
    `| Class | ${measured.map((p) => `${p.name} (×${p.factor})`).join(' | ')} |`,
    `|---|${measured.map(() => '---').join('|')}|`,
  );
  for (const x of r.classes)
    push(`| ${x.label} | ${measured.map((p) => ms(x.byPhase[p.name] ?? null)).join(' | ')} |`);
  push('');

  if (r.serviceTimes?.length) {
    push(
      '## Unloaded service time',
      '',
      'Before the load: a few sequential requests per operation, one at a time, from sessions of different roles. This is the',
      'latency floor of each endpoint on this data volume without any queueing.',
      '',
      '| Endpoint | Class | Samples | p50 | max | Errors |',
      '|---|---|---|---|---|---|',
      ...r.serviceTimes.map(
        (t) => `| \`${t.op}\` | ${t.cls} | ${t.samples} | ${ms(t.p50)} | ${ms(t.max)} | ${t.errors} |`,
      ),
      '',
    );
  }

  push(
    '## Queue lag',
    '',
    'Sampled every 2 s during the run: the age of the oldest *due* queued job (`now − max(created_at, run_at)`) and of the oldest',
    'undispatched outbox event (`now − occurred_at`). After the load, completion latencies of everything created in the measured window',
    'are read from the database (`finished_at − max(created_at, run_at)` for jobs, `dispatched_at − occurred_at` for outbox events).',
    '',
    '| Phase | Oldest job max | Oldest job p95 | Queued jobs max | Oldest outbox max | Oldest outbox p95 | Pending outbox max | Host CPU avg / max |',
    '|---|---|---|---|---|---|---|---|',
  );
  for (const [ph, q] of Object.entries(r.queue.byPhase))
    push(
      `| ${ph} | ${s1(q.oldestJobMaxS)} | ${s1(q.oldestJobP95S)} | ${q.queuedJobsMax} | ${s1(q.oldestOutboxMaxS)} | ${s1(q.oldestOutboxP95S)} | ${q.pendingOutboxMax} | ${q.cpuAvgPct ?? '—'} % / ${q.cpuMaxPct ?? '—'} % |`,
    );
  if (Object.values(r.queue.byPhase).some((q) => q.webCpuAvgPct !== undefined && q.webCpuAvgPct !== null)) {
    push(
      '',
      'CPU by process during the run (100 % = one core; sampled every 2 s from /proc):',
      '',
      '| Phase | Web server avg / max | Worker avg | PostgreSQL (load DB backends) avg | Load generator avg | Whole host avg |',
      '|---|---|---|---|---|---|',
      ...Object.entries(r.queue.byPhase).map(
        ([ph, q]) =>
          `| ${ph} | ${q.webCpuAvgPct ?? '—'} % / ${q.webCpuMaxPct ?? '—'} % | ${q.workerCpuAvgPct ?? '—'} % | ${q.pgCpuAvgPct ?? '—'} % | ${q.runnerCpuAvgPct ?? '—'} % | ${q.cpuAvgPct ?? '—'} % of ${r.environment.host.cpus} cores |`,
      ),
    );
  }
  const o = r.queue.outbox;
  const x = r.queue.exports;
  push(
    '',
    `Outbox events created in the measured window: ${n(o.n)}; dispatch latency p50 ${s1(o.p50)}, p95 ${s1(o.p95)}, max ${s1(o.max)}; still pending after the drain: ${o.pending}.`,
    `Export jobs requested in the window: ${n(x.n)} (${x.completed} completed, ${x.failed} failed); request → file ready p50 ${s1(x.p50)}, p95 ${s1(x.p95)}, max ${s1(x.max)}.`,
    `Queues ${r.queue.drained ? `drained ${r.queue.drainSeconds} s after the load ended` : `had NOT drained ${r.queue.drainSeconds} s after the load ended`}.`,
    '',
    '| Job type | Pool | Jobs | Not succeeded | Completion p50 | p95 | max |',
    '|---|---|---|---|---|---|---|',
    ...r.queue.jobs.map(
      (j) =>
        `| \`${j.type}\` | ${j.pool} | ${j.n} | ${j.not_succeeded} | ${s1(j.p50)} | ${s1(j.p95)} | ${s1(j.max)} |`,
    ),
    '',
  );

  push(
    '## Endpoints',
    '',
    '| Endpoint | Class | Requests | Errors | p50 | p95 | p99 | max | Error codes |',
    '|---|---|---|---|---|---|---|---|---|',
  );
  for (const op of r.ops)
    push(
      `| \`${op.op}\` | ${op.cls} | ${n(op.count)} | ${op.errors} | ${ms(op.p50)} | ${ms(op.p95)} | ${ms(op.p99)} | ${ms(op.max)} | ${
        Object.entries(op.codes)
          .map(([k, v]) => `${k} × ${v}`)
          .join(', ') || '—'
      } |`,
    );
  push('');

  push(
    '## Load profile',
    '',
    `Open model: Poisson arrivals at the configured rates, dispatched whether or not earlier requests finished (${c.sessionsMinted} concurrent`,
    `sessions of ${Object.keys(r.profile.sessionsByRole).length} roles; request sequence seeded with ${c.seed}). Warm-up traffic is not recorded.`,
    '',
    '| Phase | Duration | Offered reads/s | Achieved reads/s | Offered writes/s | Achieved writes/s | Recorded |',
    '|---|---|---|---|---|---|---|',
    ...r.profile.phases.map(
      (p) =>
        `| ${p.name} | ${p.seconds} s | ${p.offeredReadPerS} | ${p.achievedReadPerS} | ${p.offeredWritePerS} | ${p.achievedWritePerS} | ${p.record ? n(p.completed) : 'no'} |`,
    ),
    '',
    `Dispatch lag p95 (scheduled → sent): ${ms(r.profile.dispatchLagP95Ms)}; highest number of requests in flight: ${r.profile.maxInFlight}` +
      `${Object.keys(r.profile.dropped).length ? `; dropped at the in-flight cap: ${JSON.stringify(r.profile.dropped)}` : '; nothing dropped'}.`,
    '',
    '| Role | Sessions | Operations offered |',
    '|---|---|---|',
    ...Object.entries(r.profile.sessionsByRole).map(
      ([role, v]) => `| ${role} | ${v.sessions} | ${v.ops.map((op) => `\`${op}\``).join(', ')} |`,
    ),
    '',
    `Mix weights (reads, then writes). Reads: ${r.profile.mix
      .filter((m) => m.stream === 'read')
      .map((m) => `${m.name} ${m.weight}`)
      .join(', ')}.`,
    `Writes: ${r.profile.mix
      .filter((m) => m.stream === 'write')
      .map((m) => `${m.name} ${m.weight}`)
      .join(', ')}. Media transfer is excluded as the spec requires.`,
    '',
  );

  push(
    '## Data volumes',
    '',
    `Synthetic database \`${String(c.databaseUrl).replace(/\/\/[^@]*@/, '//…@')}\` seeded by \`pnpm perf:seed --scale ${r.seed.scale}\` in ${r.seed.seedSeconds} s at ${r.seed.seededAt}` +
      ` (${(r.seed.databaseBytes / 1024 ** 3).toFixed(2)} GiB). One workspace; history spans two years.`,
    '',
    '| Entity | Spec §28.3 | Seeded | Ratio |',
    '|---|---|---|---|',
    ...r.volumes.map((v) => `| ${v.key} | ${n(v.spec)} | ${n(v.seeded)} | ${v.ratio} |`),
    '',
    `Also seeded: ${[
      'directions',
      'project_memberships',
      'account_assignments',
      'task_status_events',
      'metric_observations',
      'financial_entries',
      'financial_allocations',
      'search_documents',
    ]
      .filter((k) => r.seed.counts[k] !== undefined)
      .map((k) => `${k} ${n(r.seed.counts[k]!)}`)
      .join(', ')}.`,
    '',
  );

  push(
    '## Environment',
    '',
    `- Host: ${e.host.cpuModel}, ${e.host.cpus} CPUs, ${e.host.memoryGiB} GiB RAM, ${e.host.os}`,
    `- Host load average (1 / 5 / 15 min): ${e.host.loadAverageBefore ? `${e.host.loadAverageBefore.join(' / ')} when the load started, ` : ''}${e.host.loadAverage.join(' / ')} when the run ended (the run itself contributes to it)`,
    `- Node.js ${e.node}; ${e.postgres.version.split(' on ')[0]}; settings ${Object.entries(
      e.postgres.settings,
    )
      .map(([k, v]) => `${k}=${v}`)
      .join(', ')}`,
    `- Database size after the run: ${(e.postgres.databaseBytes / 1024 ** 3).toFixed(2)} GiB`,
    `- Server under test: ${c.serverNote}`,
    `- Target ${c.baseUrl}; the load generator ran on the same host`,
    '',
  );

  if (!label && existsSync(ANALYSIS_FILE)) push(readFileSync(ANALYSIS_FILE, 'utf8').trim(), '');

  push(
    '## Re-running on staging',
    '',
    '```bash',
    '# 1. Synthetic data into a dedicated database on the staging PostgreSQL. Never point this at production;',
    '#    the seed refuses non-local hosts unless explicitly overridden.',
    'PERF_ADMIN_URL=postgres://<role>:<pw>@<staging-db-host>:5432/postgres \\',
    '  pnpm perf:seed --scale 1 --database castlane_perf --i-know-this-is-not-production',
    '# 2. Web (production build) and worker against castlane_perf with the staging configuration',
    'NEXT_DIST_DIR=.next-perf pnpm --filter @castlane/web build',
    'DATABASE_URL=…/castlane_perf NODE_ENV=production … pnpm --filter @castlane/web exec next start --port 3200',
    'DATABASE_URL=…/castlane_perf NODE_ENV=production … pnpm --filter @castlane/worker start',
    '# 3. Load (the runner mints sessions directly in castlane_perf and needs the APP_ORIGIN of the web server)',
    'pnpm perf:run --base-url https://<staging-host> --origin https://<staging-host> \\',
    '  --database-url postgres://…/castlane_perf --server-note "staging: <instance sizes>"',
    '```',
    '',
    'Details and options: `tests/performance/README.md`.',
    '',
  );
  return lines.join('\n');
};

const fileBase = (base: string, label: string) => (label ? `${base}-${label}` : base);

export const writeReport = (r: RunResults, outDir: string, label = ''): string[] => {
  const dir = resolve(root, outDir);
  mkdirSync(dir, { recursive: true });
  const json = join(dir, `${fileBase('performance-results', label)}.json`);
  const md = join(dir, `${fileBase('performance-report', label)}.md`);
  writeFileSync(json, `${JSON.stringify(r, null, 2)}\n`);
  writeFileSync(md, renderReport(r, label));
  return [json, md].map((f) => f.replace(`${root}/`, ''));
};

// CLI: re-render the Markdown from an existing results file.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const input = resolve(root, arg('in') ?? 'docs/acceptance/performance-results.json');
  const r = JSON.parse(readFileSync(input, 'utf8')) as RunResults;
  const files = writeReport(r, arg('out') ?? 'docs/acceptance', arg('label') ?? '');
  console.log(`Wrote ${files.join(', ')}`);
}
