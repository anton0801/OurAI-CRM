/**
 * Findings of the T170 measurement that are not numbers of a single run: defects the load profile
 * exposed (with the commits that fixed them) and what remains to be done. report.ts renders them
 * into the Analysis section of docs/acceptance/performance-report.md; the numbers next to them are
 * computed from the results files.
 */
export interface Fix {
  commit: string;
  problem: string;
  fix: string;
}

export const FIXES: Fix[] = [
  {
    commit: '461843e',
    problem:
      'The web process hung permanently under concurrent writes. Every pool connection was held by a write transaction waiting for a second connection: the assignee check on tasks and the mention/watcher checks on comments ran on the pool instead of the transaction.',
    fix: 'These checks now run on the transaction. The access snapshot reads sequentially inside a transaction. The pool gives up after 15 s instead of waiting forever. New test `pool-safety.test.ts` runs the critical writes on a one-connection pool.',
  },
  {
    commit: 'a61c737',
    problem:
      'The production dashboard returned 500 for every scoped member (project and direction leads). The stage-aging query referenced an unaliased column.',
    fix: 'Fixed, with a regression assertion in the scoped analytics test.',
  },
  {
    commit: 'dd7bcba',
    problem: '`next build` failed its type check (pdfkit typing).',
    fix: 'The declaration is now referenced from the file that imports pdfkit.',
  },
  {
    commit: 'ac53b2a',
    problem:
      'Default list orders and per-record counters scanned whole tables: 210 ms for the open-task order, 220 ms for the publication order, and 80–200 ms for subtask, content-item and project counters.',
    fix: 'Migration `0002_perf_indexes`. The same queries now take under 1 ms or are index lookups.',
  },
  {
    commit: 'fb906e0',
    problem:
      'The content dashboard loaded the cohort, observations and all metric values once per checkpoint key and period: 1.17 M rows and about 12 s of CPU.',
    fix: 'One load per period, and values are read only for the chosen observations: 250 k rows and about 3 s.',
  },
  {
    commit: 'aa61a4d',
    problem:
      'A dashboard blocked the event loop for up to 2.8 s at a time. During that time, health checks with no database access took 3 s.',
    fix: 'Metrics yield to the event loop between reductions. Period grouping uses a binary-search bucket locator (property-tested against `bucketKeyOf`). The longest stall is now 0.4–1.3 s.',
  },
  {
    commit: '19e6adb',
    problem:
      '`media.purgeDeletedVersions` was scheduled into a pool that has no runner for it, so it stayed queued forever. This showed up as growing queue lag.',
    fix: "The schedule names the media pool, and `enqueueJob` defaults to the pool the job is defined for. A test ticks the scheduler and checks every scheduled job's pool.",
  },
];

export const RECOMMENDATIONS: string[] = [
  '**Analytics, the largest gap.** Dashboards compute everything from raw facts on each request. On the §28.3 data, one 90-day dashboard costs 3–7 s of web CPU and 10–38 s of summed query time. The spec\'s figure of 2 s "after warmed read models" assumes pre-aggregated read models, and this build has none. Recommendation: maintain daily aggregates (per project, account, format and member) in the worker from outbox events and serve dashboards from them. Until then, run analytics on a separate, bounded database pool or process, so a dashboard cannot occupy the connections and the event loop that interactive requests need.',
  "**Fixed cost per request.** Every API call rebuilds the member's access snapshot. That includes all projects and accounts of the workspace (about 6,000 rows per request at §28.3 volumes) and 15–30 queries. In a CPU profile of the web process at 17.5 requests/s, about 30 % of busy time went to parsing PostgreSQL results and to garbage collection. Another 6 % went to building queries. Recommendation: cache the workspace structure (project → direction, account → project) with explicit invalidation, and batch the per-request access reads.",
  '**Horizontal scale.** The web server is one Node.js process and uses one core. The reference deployment (`infra/docker-compose.yml`) runs one `web` container. For the §28.3 profile, staging needs at least 3 web processes behind the proxy and about 4 cores for PostgreSQL, until the costs above come down.',
  '**Staging run.** Repeat this run on the fixed staging hardware with the commands below. The thresholds are not confirmed until then.',
];
