# Performance report: staging load profile (T170)

Generated 2026-09-24T15:51:57.613Z from commit `aa61a4d` by `pnpm perf:run` (tests/performance). Raw numbers: [`performance-results.json`](performance-results.json).

> **Where this was measured.** This run used the development container described under Environment, not the fixed staging
> hardware that spec §28.3 names. PostgreSQL, the web server, the worker and the load generator shared the same
> 4 CPUs. The numbers show how this build behaves under the §28.3 profile with §28.3 data volumes on this
> machine. They do not certify staging, so repeat the run on staging before sign-off (see “Re-running on staging”).

**Result: 0 of 6 threshold classes pass, 6 fail** (p95 over 180 s of measured load: steady state, the ×3 burst and cool-down; a class also fails when more than 1 % of its requests error).

| Class | Threshold (p95) | p50 | p95 | p99 | max | Requests | Errors | Verdict |
|---|---|---|---|---|---|---|---|---|
| API list | ≤ 500 ms | 15537 ms | **22312 ms** | 25684 ms | 26398 ms | 1,647 | 0 (0.00 %) | ❌ FAIL |
| API detail | ≤ 500 ms | 20904 ms | **28434 ms** | 29762 ms | 29982 ms | 1,873 | 122 (6.51 %) | ❌ FAIL |
| Search | ≤ 700 ms | 12844 ms | **18653 ms** | 20341 ms | 20882 ms | 841 | 0 (0.00 %) | ❌ FAIL |
| Standard 90-day analytics | ≤ 2,000 ms | 21504 ms | **27589 ms** | 27589 ms | 27589 ms | 16 | 2 (12.50 %) | ❌ FAIL |
| Critical writes | ≤ 800 ms | 13309 ms | **19835 ms** | 21039 ms | 21214 ms | 681 | 4 (0.59 %) | ❌ FAIL |
| Heavy request returns a job | ≤ 1,000 ms | 12734 ms | **17328 ms** | 18333 ms | 18333 ms | 37 | 0 (0.00 %) | ❌ FAIL |

Class membership: *API list* = task, project, account, content and publication lists (filters, sorting, 20 % next-page cursors);
*API detail* = the same records opened from those lists; *Search* = the global search palette; *Standard 90-day analytics* =
analytics dashboard tabs (production, content, accounts) for `last_90_days` with comparison; *Critical writes* = create task,
status transition with If-Match, comment, time entry; *Heavy request* = export request answered by a background job (time to 202).

## p95 by phase

| Class | steady (×1) | burst (×3) | cooldown (×1) |
|---|---|---|---|
| API list | 22342 ms | 21170 ms | 22381 ms |
| API detail | 28222 ms | 28890 ms | 28938 ms |
| Search | 19737 ms | 14914 ms | 18248 ms |
| Standard 90-day analytics | 27589 ms | 22332 ms | 15059 ms |
| Critical writes | 20216 ms | 15290 ms | 18474 ms |
| Heavy request returns a job | 14936 ms | 14934 ms | 18333 ms |

## Unloaded service time

Before the load: a few sequential requests per operation, one at a time, from sessions of different roles. This is the
latency floor of each endpoint on this data volume without any queueing.

| Endpoint | Class | Samples | p50 | max | Errors |
|---|---|---|---|---|---|
| `tasks.list` | list | 5 | 24 ms | 31 ms | 0 |
| `projects.list` | list | 5 | 49 ms | 57 ms | 0 |
| `accounts.list` | list | 5 | 30 ms | 33 ms | 0 |
| `content.list` | list | 5 | 28 ms | 253 ms | 0 |
| `publications.list` | list | 5 | 26 ms | 51 ms | 0 |
| `tasks.get` | detail | 5 | 32 ms | 40 ms | 0 |
| `projects.get` | detail | 5 | 25 ms | 32 ms | 0 |
| `accounts.get` | detail | 5 | 22 ms | 23 ms | 0 |
| `content.get` | detail | 5 | 26 ms | 28 ms | 0 |
| `publications.get` | detail | 5 | 96 ms | 101 ms | 0 |
| `search.global` | search | 5 | 38 ms | 143 ms | 0 |
| `analytics.dashboard` | analytics | 5 | 440 ms | 2900 ms | 0 |
| `tasks.create` | write | 5 | 71 ms | 90 ms | 0 |
| `tasks.transition` | write | 5 | 59 ms | 68 ms | 0 |
| `comments.create` | write | 5 | 46 ms | 64 ms | 0 |
| `time.create` | write | 5 | 34 ms | 39 ms | 0 |
| `exports.create` | heavy | 5 | 35 ms | 40 ms | 0 |

## Queue lag

Sampled every 2 s during the run: the age of the oldest *due* queued job (`now − max(created_at, run_at)`) and of the oldest
undispatched outbox event (`now − occurred_at`). After the load, completion latencies of everything created in the measured window
are read from the database (`finished_at − max(created_at, run_at)` for jobs, `dispatched_at − occurred_at` for outbox events).

| Phase | Oldest job max | Oldest job p95 | Queued jobs max | Oldest outbox max | Oldest outbox p95 | Pending outbox max | Host CPU avg / max |
|---|---|---|---|---|---|---|---|
| warmup | 2.0 s | 2.0 s | 1 | 2.6 s | 2.6 s | 3 | 74.5 % / 86.9 % |
| steady | 1.1 s | 0.6 s | 1 | 1.9 s | 0.8 s | 5 | 79.8 % / 97 % |
| burst | 0.9 s | 0.9 s | 1 | 0.8 s | 0.8 s | 2 | 75.4 % / 84.5 % |
| cooldown | 0.0 s | 0.0 s | 0 | 1.1 s | 0.9 s | 3 | 83.6 % / 95 % |

CPU by process during the run (100 % = one core; sampled every 2 s from /proc):

| Phase | Web server(s) avg / max | Worker avg | PostgreSQL (load DB backends) avg | Load generator avg | Whole host avg |
|---|---|---|---|---|---|
| warmup | 93.9 % / 145.4 % | 3.5 % | 111.4 % | 8.8 % | 74.5 % of 4 cores |
| steady | 92.3 % / 140.3 % | 3.2 % | 97.8 % | 7.6 % | 79.8 % of 4 cores |
| burst | 99.4 % / 148.9 % | 1.7 % | 107.1 % | 6.9 % | 75.4 % of 4 cores |
| cooldown | 89.4 % / 139.4 % | 1.8 % | 94.6 % | 5.7 % | 83.6 % of 4 cores |

Outbox events created in the measured window: 740; dispatch latency p50 0.5 s, p95 0.8 s, max 2.4 s; still pending after the drain: 0.
Export jobs requested in the window: 40 (40 completed, 0 failed); request → file ready p50 0.7 s, p95 1.2 s, max 1.2 s.
Queues drained 0 s after the load ended.

| Job type | Pool | Jobs | Not succeeded | Completion p50 | p95 | max |
|---|---|---|---|---|---|---|
| `exports.generate` | data | 40 | 0 | 0.8 s | 1.3 s | 1.3 s |
| `automation.tick` | light | 3 | 0 | 0.4 s | 1.8 s | 2.0 s |
| `platform.healthMonitor` | light | 1 | 0 | 1.0 s | 1.0 s | 1.0 s |
| `publishing.reminders` | light | 1 | 0 | 1.2 s | 1.2 s | 1.2 s |
| `work.reminders` | light | 1 | 0 | 2.7 s | 2.7 s | 2.7 s |
| `ofm.shift_monitor` | light | 1 | 0 | 1.0 s | 1.0 s | 1.0 s |
| `insights.reportSchedules` | data | 1 | 0 | 0.3 s | 0.3 s | 0.3 s |

## Endpoints

| Endpoint | Class | Requests | Errors | p50 | p95 | p99 | max | Error codes |
|---|---|---|---|---|---|---|---|---|
| `analytics.dashboard` | analytics | 16 | 2 | 21504 ms | 27589 ms | 27589 ms | 27589 ms | CLIENT_TIMEOUT × 2 |
| `accounts.get` | detail | 256 | 0 | 20866 ms | 26899 ms | 27662 ms | 28196 ms | — |
| `content.get` | detail | 395 | 1 | 19324 ms | 26449 ms | 28210 ms | 29577 ms | CLIENT_TIMEOUT × 1 |
| `projects.get` | detail | 243 | 1 | 22647 ms | 29184 ms | 29760 ms | 29921 ms | CLIENT_TIMEOUT × 1 |
| `publications.get` | detail | 361 | 0 | 15382 ms | 21878 ms | 23595 ms | 23939 ms | — |
| `tasks.get` | detail | 618 | 120 | 24689 ms | 29612 ms | 29938 ms | 29982 ms | CLIENT_TIMEOUT × 120 |
| `exports.create` | heavy | 37 | 0 | 12734 ms | 17328 ms | 18333 ms | 18333 ms | — |
| `accounts.list` | list | 244 | 0 | 15145 ms | 20771 ms | 21970 ms | 22342 ms | — |
| `content.list` | list | 341 | 0 | 14507 ms | 21112 ms | 22009 ms | 22301 ms | — |
| `projects.list` | list | 234 | 0 | 14724 ms | 21219 ms | 22020 ms | 22372 ms | — |
| `publications.list` | list | 340 | 0 | 14628 ms | 20889 ms | 21973 ms | 22030 ms | — |
| `tasks.list` | list | 488 | 0 | 17835 ms | 25396 ms | 26023 ms | 26398 ms | — |
| `search.global` | search | 841 | 0 | 12844 ms | 18653 ms | 20341 ms | 20882 ms | — |
| `comments.create` | write | 183 | 0 | 13250 ms | 19283 ms | 20613 ms | 21039 ms | — |
| `tasks.create` | write | 217 | 0 | 13131 ms | 20050 ms | 21104 ms | 21214 ms | — |
| `tasks.transition` | write | 205 | 4 | 13320 ms | 18744 ms | 21036 ms | 21109 ms | VERSION_CONFLICT × 4 |
| `time.create` | write | 76 | 0 | 13503 ms | 20216 ms | 20977 ms | 20977 ms | — |

## Load profile

Open model: Poisson arrivals at the configured rates, dispatched whether or not earlier requests finished (50 concurrent
sessions of 10 roles; request sequence seeded with 170). Warm-up traffic is not recorded.

| Phase | Duration | Offered reads/s | Achieved reads/s | Offered writes/s | Achieved writes/s | Recorded |
|---|---|---|---|---|---|---|
| warmup | 30 s | 30 | 30.23 | 5 | 4.7 | no |
| steady | 120 s | 30 | 24.97 | 5 | 3.98 | 3,474 |
| burst | 30 s | 90 | 24.5 | 15 | 4.27 | 863 |
| cooldown | 30 s | 30 | 21.53 | 5 | 3.73 | 758 |

Dispatch lag p95 (scheduled → sent): 4 ms; highest number of requests in flight: 500; dropped at the in-flight cap: {"search.global":559,"content.get":217,"tasks.list":310,"content.list":237,"comments.create":105,"tasks.get":370,"accounts.get":150,"publications.list":232,"accounts.list":156,"projects.get":151,"projects.list":128,"tasks.transition":144,"time.create":40,"publications.get":271,"exports.create":29,"tasks.create":135,"analytics.dashboard":11}.

| Role | Sessions | Operations offered |
|---|---|---|
| project_lead | 10 | `tasks.list`, `projects.list`, `accounts.list`, `content.list`, `publications.list`, `tasks.get`, `projects.get`, `accounts.get`, `content.get`, `publications.get`, `search.global`, `analytics.dashboard`, `tasks.create`, `tasks.transition`, `comments.create`, `time.create`, `exports.create` |
| creator | 10 | `tasks.list`, `projects.list`, `content.list`, `tasks.get`, `projects.get`, `content.get`, `search.global`, `tasks.transition`, `comments.create`, `time.create` |
| producer | 8 | `tasks.list`, `projects.list`, `accounts.list`, `content.list`, `publications.list`, `tasks.get`, `projects.get`, `accounts.get`, `content.get`, `publications.get`, `search.global`, `tasks.create`, `tasks.transition`, `comments.create`, `time.create` |
| publisher | 7 | `tasks.list`, `accounts.list`, `content.list`, `publications.list`, `tasks.get`, `accounts.get`, `content.get`, `publications.get`, `search.global`, `comments.create` |
| direction_lead | 5 | `tasks.list`, `projects.list`, `accounts.list`, `content.list`, `publications.list`, `tasks.get`, `projects.get`, `accounts.get`, `content.get`, `publications.get`, `search.global`, `analytics.dashboard`, `tasks.create`, `tasks.transition`, `comments.create`, `time.create`, `exports.create` |
| analyst | 4 | `projects.list`, `accounts.list`, `content.list`, `publications.list`, `projects.get`, `accounts.get`, `content.get`, `publications.get`, `search.global`, `analytics.dashboard` |
| admin | 2 | `tasks.list`, `projects.list`, `accounts.list`, `content.list`, `publications.list`, `tasks.get`, `projects.get`, `accounts.get`, `content.get`, `publications.get`, `search.global`, `analytics.dashboard`, `tasks.create`, `tasks.transition`, `comments.create`, `time.create`, `exports.create` |
| finance_manager | 2 | `projects.list`, `accounts.list`, `projects.get`, `accounts.get`, `search.global` |
| owner | 1 | `tasks.list`, `projects.list`, `accounts.list`, `content.list`, `publications.list`, `tasks.get`, `projects.get`, `accounts.get`, `content.get`, `publications.get`, `search.global`, `analytics.dashboard`, `tasks.create`, `tasks.transition`, `comments.create`, `time.create`, `exports.create` |
| viewer | 1 | `tasks.list`, `projects.list`, `accounts.list`, `content.list`, `publications.list`, `tasks.get`, `projects.get`, `accounts.get`, `content.get`, `publications.get`, `search.global`, `analytics.dashboard` |

Mix weights (reads, then writes). Reads: tasks.list 8, projects.list 4, accounts.list 4, content.list 6, publications.list 6, tasks.get 10, projects.get 4, accounts.get 4, content.get 6, publications.get 6, search.global 14, analytics.dashboard 0.4.
Writes: tasks.create 30, tasks.transition 30, comments.create 25, time.create 10, exports.create 5. Media transfer is excluded as the spec requires.

## Data volumes

Synthetic database `postgres://…@127.0.0.1:5432/castlane_perf` seeded by `pnpm perf:seed --scale 1` in 559 s at 2026-09-24T15:06:00.657Z (3.19 GiB). One workspace; history spans two years.

| Entity | Spec §28.3 | Seeded | Ratio |
|---|---|---|---|
| memberships | 200 | 200 | 1 |
| projects | 1,000 | 1,000 | 1 |
| social_accounts | 5,000 | 5,000 | 1 |
| content_items | 100,000 | 100,000 | 1 |
| publications | 300,000 | 300,000 | 1 |
| tasks | 500,000 | 500,000 | 1 |
| metric_values | 2,000,000 | 2,001,438 | 1.001 |
| financial_entry_lines | 300,000 | 300,000 | 1 |

Also seeded: directions 10, project_memberships 4,000, account_assignments 5,000, task_status_events 389,996, metric_observations 787,325, financial_entries 150,000, financial_allocations 300,000, search_documents 906,210.

## Environment

- Host: Intel(R) Xeon(R) Processor @ 2.10GHz, 4 CPUs, 15.7 GiB RAM, Linux 6.18.44-fc-v37 (x64)
- Host load average (1 / 5 / 15 min): 2.1 / 2.51 / 4.7 when the load started, 6.6 / 4.6 / 5.06 when the run ended (the run itself contributes to it)
- Node.js v22.22.2; PostgreSQL 16.13 (Ubuntu 16.13-0ubuntu0.24.04.1); settings shared_buffers=512MB, work_mem=4MB, effective_cache_size=4GB, max_connections=400, random_page_cost=4, max_parallel_workers_per_gather=2, jit=on
- Database size after the run: 3.20 GiB
- Server under test: local production build of commit aa61a4d: Next.js standalone server (one process, DATABASE_POOL_MAX=10) and worker (JOB_CONCURRENCY=4), NODE_ENV=production
- Target http://127.0.0.1:3200 (1 web server process(es), sessions spread over them); the load generator ran on the same host

## Analysis

**Verdict on this machine.** 0 of 6 classes met the p95 threshold under the full §28.3 profile. The cause is saturation, not slow queries. The server completed 61 % of the offered requests (28.3 of 46.7 per second over the measured phases). The open-model backlog reached the in-flight cap of 500, so waiting time, not service time, sets the latency. The p95 figures cover successful responses only. Timeouts count as errors, and a class with more than 1 % errors fails on its own.

**Latency without load.** The p50 of a single request with nothing else running (see "Unloaded service time") was API list 24–49 ms (max 253 ms), API detail 22–96 ms (max 101 ms), Search 38 ms (max 143 ms), Standard 90-day analytics 440 ms (max 2900 ms), Critical writes 34–71 ms (max 90 ms), Heavy request returns a job 35 ms (max 40 ms).

**Supplementary runs** (same build and data, each with its own report next to this one):

| Run | Steady-state p95: list / detail / search / writes / heavy / analytics | Worst p95 in burst and cool-down | CPU in steady state (100 % = one core) |
|---|---|---|---|
| [half-rate](performance-report-half-rate.md): 15 reads/s + 2.5 writes/s, 1 web process, full mix | 5.1 s / 6.6 s / 4.7 s / 5.3 s / 5.8 s / 9.3 s | 21.2 s | web 60.4 %, PostgreSQL 68.1 %, host 48.7 % of 4 cores |
| [half-rate-no-analytics](performance-report-half-rate-no-analytics.md): 15 reads/s + 2.5 writes/s, 1 web process, without analytics.dashboard | 165 ms / 148 ms / 249 ms / 160 ms / 81 ms / — | 21.5 s | web 38.5 %, PostgreSQL 60.6 %, host 40.3 % of 4 cores |
| [two-web](performance-report-two-web.md): 30 reads/s + 5 writes/s, 2 web processes, full mix | 8.4 s / 11.4 s / 7.0 s / 7.4 s / 6.7 s / 10.9 s | 28.3 s | web 102.4 %, PostgreSQL 121 %, host 91.7 % of 4 cores |

**Capacity arithmetic.** In the "half-rate-no-analytics" run, 17.2 requests/s used 38.5 % of one core in the web process, which is about 22 ms of web CPU per request. The same load used 60.6 % of a core across the PostgreSQL backends, about 35 ms of database CPU per request.

- **Web:** the web server is one Node.js process and uses one core. It tops out at about 44 requests/s of this mix.
- **Burst:** the §28.3 burst of 105 requests/s needs at least 3 web processes and about 3.7 PostgreSQL cores, before dashboards are added.
- **This host:** 4 cores in total, shared with other workloads during the measurement (1-minute load average 2.1 when the load started).

**Queue lag.** The oldest due job was at most 2.0 s old during the run. Outbox dispatch p95 was 0.8 s. Exports were ready 1.2 s after the request (p95). The queues drained without a backlog after the load, so background processing is not the bottleneck.

### Defects found and fixed during this measurement

| Commit | Problem found by the load profile | Fix |
|---|---|---|
| `461843e` | The web process hung permanently under concurrent writes. Every pool connection was held by a write transaction waiting for a second connection: the assignee check on tasks and the mention/watcher checks on comments ran on the pool instead of the transaction. | These checks now run on the transaction. The access snapshot reads sequentially inside a transaction. The pool gives up after 15 s instead of waiting forever. New test `pool-safety.test.ts` runs the critical writes on a one-connection pool. |
| `a61c737` | The production dashboard returned 500 for every scoped member (project and direction leads). The stage-aging query referenced an unaliased column. | Fixed, with a regression assertion in the scoped analytics test. |
| `dd7bcba` | `next build` failed its type check (pdfkit typing). | The declaration is now referenced from the file that imports pdfkit. |
| `ac53b2a` | Default list orders and per-record counters scanned whole tables: 210 ms for the open-task order, 220 ms for the publication order, and 80–200 ms for subtask, content-item and project counters. | Migration `0001_perf_indexes`. The same queries now take under 1 ms or are index lookups. |
| `fb906e0` | The content dashboard loaded the cohort, observations and all metric values once per checkpoint key and period: 1.17 M rows and about 12 s of CPU. | One load per period, and values are read only for the chosen observations: 250 k rows and about 3 s. |
| `aa61a4d` | A dashboard blocked the event loop for up to 2.8 s at a time. During that time, health checks with no database access took 3 s. | Metrics yield to the event loop between reductions. Period grouping uses a binary-search bucket locator (property-tested against `bucketKeyOf`). The longest stall is now 0.4–1.3 s. |
| `19e6adb` | `media.purgeDeletedVersions` was scheduled into a pool that has no runner for it, so it stayed queued forever. This showed up as growing queue lag. | The schedule names the media pool, and `enqueueJob` defaults to the pool the job is defined for. A test ticks the scheduler and checks every scheduled job's pool. |

### What remains, and recommendations

1. **Analytics, the largest gap.** Dashboards compute everything from raw facts on each request. On the §28.3 data, one 90-day dashboard costs 3–7 s of web CPU and 10–38 s of summed query time. The spec's figure of 2 s "after warmed read models" assumes pre-aggregated read models, and this build has none. Recommendation: maintain daily aggregates (per project, account, format and member) in the worker from outbox events and serve dashboards from them. Until then, run analytics on a separate, bounded database pool or process, so a dashboard cannot occupy the connections and the event loop that interactive requests need.
2. **Fixed cost per request.** Every API call rebuilds the member's access snapshot. That includes all projects and accounts of the workspace (about 6,000 rows per request at §28.3 volumes) and 15–30 queries. In a CPU profile of the web process at 17.5 requests/s, about 30 % of busy time went to parsing PostgreSQL results and to garbage collection. Another 6 % went to building queries. Recommendation: cache the workspace structure (project → direction, account → project) with explicit invalidation, and batch the per-request access reads.
3. **Horizontal scale.** The web server is one Node.js process and uses one core. The reference deployment (`infra/docker-compose.yml`) runs one `web` container. For the §28.3 profile, staging needs at least 3 web processes behind the proxy and about 4 cores for PostgreSQL, until the costs above come down.
4. **Staging run.** Repeat this run on the fixed staging hardware with the commands below. The thresholds are not confirmed until then.

Notes on method:
- Writes from the runs (tasks, comments, time entries, exports) accumulate in the load database between runs. That is a few thousand rows against millions.
- The dashboard share follows a stated usage model: each active member opens a 90-day dashboard about every five minutes.
- The CPU of the load generator is included in the host figures.

## Re-running on staging

```bash
# 1. Synthetic data into a dedicated database on the staging PostgreSQL. Never point this at production;
#    the seed refuses non-local hosts unless explicitly overridden.
PERF_ADMIN_URL=postgres://<role>:<pw>@<staging-db-host>:5432/postgres \
  pnpm perf:seed --scale 1 --database castlane_perf --i-know-this-is-not-production
# 2. Web (production build) and worker against castlane_perf with the staging configuration
NEXT_DIST_DIR=.next-perf pnpm --filter @castlane/web build
DATABASE_URL=…/castlane_perf NODE_ENV=production … pnpm --filter @castlane/web exec next start --port 3200
DATABASE_URL=…/castlane_perf NODE_ENV=production … pnpm --filter @castlane/worker start
# 3. Load (the runner mints sessions directly in castlane_perf and needs the APP_ORIGIN of the web server)
pnpm perf:run --base-url https://<staging-host> --origin https://<staging-host> \
  --database-url postgres://…/castlane_perf --server-note "staging: <instance sizes>"
```

Details and options: `tests/performance/README.md`.
