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
  {
    commit: '89d3689',
    problem:
      "Every API request rebuilt the member's access snapshot: 8 queries, including every project and account of the workspace (about 6,000 rows per request at §28.3 volumes). In a CPU profile, about 30 % of the web process's busy time went to parsing PostgreSQL results and to garbage collection.",
    fix: 'Per-process cache keyed by the membership\'s access revision and a workspace access revision. Database triggers bump the revision in the same transaction as any change to grants, denies, teams, assignments, roles or the project → direction and account → project structure (migration `0003_access_revision`, `sql/post/011_access_revision.sql`). A warm request reads one row. Tests in `access-cache.test.ts`: revoking a role, moving a project to another direction, adding a project and reassigning an account apply on the next request; a time-bounded grant expires without a write.',
  },
  {
    commit: '0944782',
    problem:
      'Dashboards were computed from raw facts on every request: 3–7 s of web CPU and 10–38 s of summed query time for one 90-day dashboard. §28.3 measures analytics "after warmed read models", and there were none.',
    fix: 'Read model `analytics_dashboard_snapshots` (migration `0004_dashboard_snapshots`), one row per tab, filters, access scope and time zone. An outbox consumer marks snapshots stale; the worker job `analytics.refreshSnapshots` recomputes them. Responses carry the age of the figures, shown in the UI with "Recalculate now". Tests in `dashboard-snapshots.test.ts` compare served and live results on the same data.',
  },
  {
    commit: '0fa31be',
    problem: 'The reference deployment ran one web process, which uses one core.',
    fix: 'Three web processes behind Caddy with a sticky cookie and active health checks (`infra/docker-compose.yml`, `infra/caddy/Caddyfile`, "Scaling the web tier" in `docs/runbooks/deploy.md`, including per-process rate limits).',
  },
  {
    commit: 'ff92e86',
    problem:
      'With the access cache in place, sampling the database under load (auto_explain on the load database) showed list and detail queries that read far more rows than they returned. The publication detail loaded its tasks with a parallel sequential scan of all 500,000 tasks (about 200 ms). The scheduled-publication queue walked the whole default-order index (0.7 s). Content lists of account-scoped members sorted every visible item and crossed the JIT threshold (0.4 s). Project and account lists aggregated every observation for "metrics updated" (50–200 ms).',
    fix: 'Migration `0005_list_indexes` (tasks by publication and by account, publications by status in list order, content in list order, account placements for content visibility) and a per-row lookup of the newest usable observation, checked against the aggregate in `latest-observation.test.ts`. The same queries take 0.1–14 ms. PostgreSQL CPU in the steady state fell from 114 % to 77 % of a core (compare the before-list-indexes run).',
  },
];

export const RECOMMENDATIONS: string[] = [
  "**Run it on staging hardware.** On this 4-vCPU container every class meets its threshold in the steady state, with the host about half busy. The ×3 burst needs about 6.4 cores at the measured cost per request, so it saturates the container, and the backlog it leaves sets the p95 over all phases. The thresholds are therefore neither confirmed nor refuted for §28.3's staging hardware. Size staging from the capacity arithmetic above: at least three web processes (about 1.6 cores at the burst), PostgreSQL on its own cores (about 2.3 cores of backends at the burst, plus its background work) and the worker separate. Then repeat this run there.",
  '**Search is the largest remaining database cost.** Under load, the global search was the most frequent active statement. Common words match tens of thousands of documents: one project-name word matched about 36,000. The permission filter and the relevance order are applied only after all matches have been read from the table, which takes 100–140 ms and 27,000 buffers for one query. Options: apply the member\'s scope before the text match (indexes on the scope columns of the search projection), cap the candidate set, or move search to a dedicated index.',
  "**Dashboard refreshes scale with the number of access scopes.** The 69 dashboard views of the warm-up needed 59 separate snapshots, because project leads, producers and publishers each have their own scope. One computation takes up to about 12 s. While data keeps changing, the worker recomputes every snapshot in use once per `ANALYTICS_SNAPSHOT_MIN_REFRESH_SECONDS` (300 s by default). In this run the refresh overlapped the burst: `analytics.refreshSnapshots` ran for up to 61 s at a time, and the worker used 42–56 % of a core. If that is too much on staging, raise the minimum interval, refresh only snapshots viewed since their last computation, or build dashboards from shared daily aggregates per project and account instead of per-scope snapshots.",
  '**Host CPU outside the attributed processes.** In the steady state about 16 of the 61 ms of host CPU per request were not in the web, PostgreSQL backend, worker, proxy or load-generator processes. Most of it is likely PostgreSQL parallel-query workers, background processes and the kernel. Parallel workers are forked per query and live too briefly to sample, but the database sampling showed them among the most frequently active processes, and `top` showed about 22 % system time during a diagnostic run. Parallel query and JIT (both on by default) cost CPU on a busy OLTP server. On staging, measure the run with `max_parallel_workers_per_gather = 0` and `jit = off` for the application role.',
];
