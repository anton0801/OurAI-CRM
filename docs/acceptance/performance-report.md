# Performance report: staging load profile (T170)

Generated 2026-09-24T17:36:08.586Z from commit `e8065c1` by `pnpm perf:run` (tests/performance). Raw numbers: [`performance-results.json`](performance-results.json).

> **Where this was measured.** This run used the development container described under Environment, not the fixed staging
> hardware that spec §28.3 names. PostgreSQL, the web server process(es), the worker and the load generator shared the same
> 4 CPUs. The numbers show how this build behaves under the §28.3 profile with §28.3 data volumes on this
> machine. They do not certify staging, so repeat the run on staging before sign-off (see “Re-running on staging”).

**Result: 0 of 6 threshold classes pass, 6 fail** (p95 over 360 s of measured load: steady state, the ×3 burst and cool-down; a class also fails when more than 1 % of its requests error).

| Class | Threshold (p95) | p50 | p95 | p99 | max | Requests | Errors | Verdict |
|---|---|---|---|---|---|---|---|---|
| API list | ≤ 500 ms | 37 ms | **8257 ms** | 12338 ms | 14995 ms | 4,573 | 0 (0.00 %) | ❌ FAIL |
| API detail | ≤ 500 ms | 31 ms | **11638 ms** | 16691 ms | 20901 ms | 4,866 | 0 (0.00 %) | ❌ FAIL |
| Search | ≤ 700 ms | 119 ms | **7052 ms** | 10257 ms | 12786 ms | 2,235 | 0 (0.00 %) | ❌ FAIL |
| Standard 90-day analytics | ≤ 2,000 ms | 24 ms | **8392 ms** | 12048 ms | 12048 ms | 53 | 0 (0.00 %) | ❌ FAIL |
| Critical writes | ≤ 800 ms | 73 ms | **7302 ms** | 10597 ms | 12832 ms | 1,933 | 0 (0.00 %) | ❌ FAIL |
| Heavy request returns a job | ≤ 1,000 ms | 44 ms | **7915 ms** | 11271 ms | 11271 ms | 83 | 0 (0.00 %) | ❌ FAIL |

Class membership: *API list* = task, project, account, content and publication lists (filters, sorting, 20 % next-page cursors);
*API detail* = the same records opened from those lists; *Search* = the global search palette; *Standard 90-day analytics* =
analytics dashboard tabs (production, content, accounts) for `last_90_days` with comparison; *Critical writes* = create task,
status transition with If-Match, comment, time entry; *Heavy request* = export request answered by a background job (time to 202).

## p95 by phase

| Class | steady (×1) | burst (×3) | cooldown (×1) |
|---|---|---|---|
| API list | 186 ms | 12618 ms | 9837 ms |
| API detail | 127 ms | 17085 ms | 10372 ms |
| Search | 295 ms | 10718 ms | 8649 ms |
| Standard 90-day analytics | 79 ms | 12048 ms | 1745 ms |
| Critical writes | 280 ms | 10992 ms | 9856 ms |
| Heavy request returns a job | 161 ms | 11271 ms | 7605 ms |

## Analytics read model warm-up

Before the measured load every session opened each of its dashboard tabs once (spec §28.3: analytics are measured "after warmed read models"): 69 dashboard views in 75.9 s, 59 of them computed live because no snapshot existed for that access scope yet (slowest 12488 ms), 0 errors. Members with the same effective access share one snapshot per tab. The worker refreshes stale snapshots in the background (`analytics.refreshSnapshots` in the job table below).

During the measured load, 53 of 53 dashboard requests were answered from the read model and 0 were computed live. The figures served were 206 s old at the median and 433 s at most; 52 were marked "refresh pending" because newer records existed. The analytics p95 above therefore measures dashboards served from the read model, as §28.3 specifies, not the cost of computing one.

## Unloaded service time

Before the load: a few sequential requests per operation, one at a time, from sessions of different roles. This is the
latency floor of each endpoint on this data volume without any queueing.

| Endpoint | Class | Samples | p50 | max | Errors |
|---|---|---|---|---|---|
| `tasks.list` | list | 5 | 39 ms | 96 ms | 0 |
| `projects.list` | list | 5 | 36 ms | 41 ms | 0 |
| `accounts.list` | list | 5 | 31 ms | 35 ms | 0 |
| `content.list` | list | 5 | 38 ms | 110 ms | 0 |
| `publications.list` | list | 5 | 24 ms | 27 ms | 0 |
| `tasks.get` | detail | 5 | 30 ms | 50 ms | 0 |
| `projects.get` | detail | 5 | 22 ms | 23 ms | 0 |
| `accounts.get` | detail | 5 | 19 ms | 25 ms | 0 |
| `content.get` | detail | 5 | 26 ms | 34 ms | 0 |
| `publications.get` | detail | 5 | 21 ms | 24 ms | 0 |
| `search.global` | search | 5 | 37 ms | 176 ms | 0 |
| `analytics.dashboard` | analytics | 5 | 24 ms | 28 ms | 0 |
| `tasks.create` | write | 5 | 82 ms | 88 ms | 0 |
| `tasks.transition` | write | 5 | 55 ms | 74 ms | 0 |
| `comments.create` | write | 5 | 47 ms | 63 ms | 0 |
| `time.create` | write | 5 | 33 ms | 36 ms | 0 |
| `exports.create` | heavy | 5 | 31 ms | 34 ms | 0 |

## Queue lag

Sampled every 2 s during the run: the age of the oldest *due* queued job (`now − max(created_at, run_at)`) and of the oldest
undispatched outbox event (`now − occurred_at`). After the load, completion latencies of everything created in the measured window
are read from the database (`finished_at − max(created_at, run_at)` for jobs, `dispatched_at − occurred_at` for outbox events).

| Phase | Oldest job max | Oldest job p95 | Queued jobs max | Oldest outbox max | Oldest outbox p95 | Pending outbox max | Host CPU avg / max |
|---|---|---|---|---|---|---|---|
| warmup | 2.1 s | 2.1 s | 2 | 0.4 s | 0.4 s | 4 | 48.3 % / 57.8 % |
| steady | 2.3 s | 0.6 s | 2 | 6.5 s | 3.7 s | 44 | 53.2 % / 97.9 % |
| burst | 7.8 s | 7.8 s | 7 | 15.5 s | 15.5 s | 127 | 94.6 % / 98.2 % |
| cooldown | 24.2 s | 24.2 s | 9 | 24.6 s | 24.6 s | 189 | 89.1 % / 98.4 % |

CPU by process during the run (100 % = one core; sampled every 2 s from /proc):

| Phase | Web server(s) avg / max | Load balancer avg | Worker avg | PostgreSQL (load DB backends) avg | Load generator avg | Whole host avg |
|---|---|---|---|---|---|---|
| warmup | 63.8 % / 82.2 % | 3.7 % | 3.7 % | 67.2 % | 9 % | 48.3 % of 4 cores |
| steady | 54.9 % / 99.9 % | 3.7 % | 14.9 % | 76.9 % | 7.6 % | 53.2 % of 4 cores |
| burst | 98.6 % / 128 % | 5.8 % | 41.8 % | 135.6 % | 10.3 % | 94.6 % of 4 cores |
| cooldown | 62.9 % / 104.7 % | 4.1 % | 55.7 % | 136.8 % | 7.4 % | 89.1 % of 4 cores |

Outbox events created in the measured window: 2,025; dispatch latency p50 0.4 s, p95 14.0 s, max 18.7 s; still pending after the drain: 0.
Export jobs requested in the window: 83 (83 completed, 0 failed); request → file ready p50 0.9 s, p95 23.7 s, max 25.0 s.
Queues drained 4 s after the load ended.

| Job type | Pool | Jobs | Not succeeded | Completion p50 | p95 | max |
|---|---|---|---|---|---|---|
| `exports.generate` | data | 83 | 0 | 0.9 s | 23.8 s | 25.2 s |
| `analytics.refreshSnapshots` | data | 6 | 0 | 5.1 s | 57.4 s | 60.9 s |
| `automation.tick` | light | 6 | 0 | 0.5 s | 1.1 s | 1.2 s |
| `platform.healthMonitor` | light | 2 | 0 | 0.6 s | 1.1 s | 1.1 s |
| `insights.reportSchedules` | data | 2 | 0 | 2.4 s | 4.0 s | 4.1 s |
| `ofm.shift_monitor` | light | 2 | 0 | 0.5 s | 0.9 s | 1.0 s |
| `publishing.reminders` | light | 2 | 0 | 0.9 s | 1.3 s | 1.3 s |
| `work.reminders` | light | 2 | 0 | 3.1 s | 3.6 s | 3.7 s |
| `work.timers` | light | 1 | 0 | 0.0 s | 0.0 s | 0.0 s |
| `work.recurrence` | light | 1 | 0 | 0.0 s | 0.0 s | 0.0 s |
| `insights.checkpoints` | light | 1 | 0 | 5.6 s | 5.6 s | 5.6 s |
| `publishing.freezePlans` | light | 1 | 0 | 0.1 s | 0.1 s | 0.1 s |

## Endpoints

| Endpoint | Class | Requests | Errors | p50 | p95 | p99 | max | Error codes |
|---|---|---|---|---|---|---|---|---|
| `analytics.dashboard` | analytics | 53 | 0 | 24 ms | 8392 ms | 12048 ms | 12048 ms | — |
| `accounts.get` | detail | 648 | 0 | 25 ms | 10953 ms | 14955 ms | 16154 ms | — |
| `content.get` | detail | 1,002 | 0 | 31 ms | 10310 ms | 13969 ms | 16465 ms | — |
| `projects.get` | detail | 627 | 0 | 28 ms | 11662 ms | 15773 ms | 17692 ms | — |
| `publications.get` | detail | 964 | 0 | 26 ms | 8604 ms | 12069 ms | 13800 ms | — |
| `tasks.get` | detail | 1,625 | 0 | 37 ms | 15091 ms | 18434 ms | 20901 ms | — |
| `exports.create` | heavy | 83 | 0 | 44 ms | 7915 ms | 11271 ms | 11271 ms | — |
| `accounts.list` | list | 676 | 0 | 30 ms | 8285 ms | 12245 ms | 12699 ms | — |
| `content.list` | list | 972 | 0 | 43 ms | 7051 ms | 10906 ms | 12739 ms | — |
| `projects.list` | list | 641 | 0 | 37 ms | 8140 ms | 10400 ms | 14034 ms | — |
| `publications.list` | list | 1,016 | 0 | 35 ms | 7835 ms | 11546 ms | 12745 ms | — |
| `tasks.list` | list | 1,268 | 0 | 40 ms | 10104 ms | 14169 ms | 14995 ms | — |
| `search.global` | search | 2,235 | 0 | 119 ms | 7052 ms | 10257 ms | 12786 ms | — |
| `comments.create` | write | 517 | 0 | 62 ms | 6896 ms | 9680 ms | 11675 ms | — |
| `tasks.create` | write | 618 | 0 | 91 ms | 7391 ms | 9618 ms | 11952 ms | — |
| `tasks.transition` | write | 603 | 0 | 69 ms | 7880 ms | 11446 ms | 12122 ms | — |
| `time.create` | write | 195 | 0 | 42 ms | 6674 ms | 11460 ms | 12832 ms | — |

## Load profile

Open model: Poisson arrivals at the configured rates, dispatched whether or not earlier requests finished (50 concurrent
sessions of 10 roles; request sequence seeded with 170). Warm-up traffic is not recorded.

| Phase | Duration | Offered reads/s | Achieved reads/s | Offered writes/s | Achieved writes/s | Recorded |
|---|---|---|---|---|---|---|
| warmup | 30 s | 30 | 30.23 | 5 | 4.7 | no |
| steady | 300 s | 30 | 29.81 | 5 | 5.17 | 10,494 |
| burst | 30 s | 90 | 63.93 | 15 | 11.07 | 2,250 |
| cooldown | 30 s | 30 | 28.9 | 5 | 4.4 | 999 |

Dispatch lag p95 (scheduled → sent): 4 ms; highest number of requests in flight: 500; dropped at the in-flight cap: {"content.list":65,"content.get":51,"accounts.get":43,"tasks.list":82,"projects.get":43,"accounts.list":48,"projects.list":43,"tasks.get":94,"search.global":144,"publications.list":73,"tasks.create":46,"time.create":16,"tasks.transition":39,"publications.get":60,"comments.create":30,"analytics.dashboard":5,"exports.create":7}.

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

Synthetic database `postgres://…@127.0.0.1:5432/castlane_perf` seeded by `pnpm perf:seed --scale 1` in 478 s at 2026-09-24T16:56:40.403Z (3.19 GiB). One workspace; history spans two years.

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
- Host load average (1 / 5 / 15 min): 1.3 / 2.2 / 3.8 when the runner started, before the warm-ups, 3.64 / 2.88 / 3.92 when the measured load started, 8.59 / 5.17 / 4.43 when the run ended (the run itself contributes to the later values)
- Node.js v22.22.2; PostgreSQL 16.13 (Ubuntu 16.13-0ubuntu0.24.04.1); settings shared_buffers=512MB, work_mem=4MB, effective_cache_size=4GB, max_connections=400, random_page_cost=4, max_parallel_workers_per_gather=2, jit=on
- Database size after the run: 3.27 GiB
- Server under test: local production build of commit e8065c1: Caddy 2.11.4 (lb_policy cookie, active health checks, config as infra/caddy/Caddyfile without TLS) in front of 3 Next.js standalone server processes (DATABASE_POOL_MAX=10 each) and the worker (JOB_CONCURRENCY=4), NODE_ENV=production, default ACCESS_CACHE_TTL_MS and ANALYTICS_SNAPSHOT_* settings
- Target http://127.0.0.1:3200 (3 web server process(es) behind the load balancer); the load generator ran on the same host

## Analysis

**Verdict on this machine.** 0 of 6 classes met the p95 threshold over all measured phases of the full §28.3 profile. In the steady state (30 reads/s + 5 writes/s for 300 s) every class met its threshold: API list 186 ms, API detail 127 ms, Search 295 ms, Standard 90-day analytics 79 ms, Critical writes 280 ms, Heavy request returns a job 161 ms (p95), with the host at 53.2 % of its 4 cores. The ×3 burst (105 requests/s) was more than this host can serve: it completed 75.0 requests/s while the host ran at 94.6 % CPU. The open-model backlog reached the runner's in-flight cap of 500 and carried into the cool-down, so waiting time, not service time, sets the p95 of the burst and the cool-down, and with it the p95 over all phases. The p95 figures cover successful responses only. Timeouts count as errors, and a class with more than 1 % errors fails on its own.

**Latency without load.** The p50 of a single request with nothing else running (see "Unloaded service time") was API list 24–39 ms (max 110 ms), API detail 19–30 ms (max 50 ms), Search 37 ms (max 176 ms), Standard 90-day analytics 24 ms (max 28 ms), Critical writes 33–82 ms (max 88 ms), Heavy request returns a job 31 ms (max 34 ms).

**Other runs** on the same data and host (each with its own report next to this one), compared with this run:

| Run | Commit | Steady-state p95: list / detail / search / writes / heavy / analytics | Worst p95 in burst and cool-down | CPU in steady state (100 % = one core) |
|---|---|---|---|---|
| **This run**: 30 reads/s + 5 writes/s, 3 web processes, full mix | `e8065c1` | 186 ms / 127 ms / 295 ms / 280 ms / 161 ms / 79 ms | 17.1 s | web 54.9 %, PostgreSQL 76.9 %, host 53.2 % of 4 cores |
| [before-list-indexes](performance-report-before-list-indexes.md): 30 reads/s + 5 writes/s, 3 web processes, full mix | `2929e92` | 447 ms / 413 ms / 548 ms / 618 ms / 383 ms / 114 ms | 19.0 s | web 55.3 %, PostgreSQL 114.4 %, host 72 % of 4 cores |
| [previous](performance-report-previous.md): 30 reads/s + 5 writes/s, 1 web process, full mix | `aa61a4d` | 22.3 s / 28.2 s / 19.7 s / 20.2 s / 14.9 s / 27.6 s | 28.9 s | web 92.3 %, PostgreSQL 97.8 %, host 79.8 % of 4 cores |

**Capacity arithmetic.** The steady state was not saturated, so its CPU use is the cost of the mix. 35.0 requests/s used 54.9 % of a core in the web processes (about 16 ms of web CPU per request), 76.9 % in the PostgreSQL backends of the load database (about 22 ms per request) and 53.2 % of the host's 4 cores in total (about 61 ms per request). The total includes the worker (dashboard refreshes, exports), the load balancer, the load generator, PostgreSQL's parallel-query and background processes and the kernel.

- **Burst:** 105 requests/s at these costs needs about 6.4 cores: 1.6 for the web processes, 2.3 for PostgreSQL backends and the rest for everything else. This host has 4, shared by all of it.
- **Web:** one web process uses at most one core and serves about 63 requests/s of this mix, so 3 processes can take about 191 requests/s once they have the cores.
- **This host:** 1-minute load average 1.3 when the runner started and 3.64 when the measured load started (after the read-model warm-up); no other workload was running on it.

**Queue lag.** In the steady state the oldest due job was at most 2.3 s old and the oldest undispatched outbox event 6.5 s. While the host was saturated (burst and cool-down) they reached 24.2 s and 24.6 s. Over the run, outbox dispatch p95 was 14.0 s and exports were ready 23.7 s after the request (p95). The queues drained 4 s after the load ended.

### Defects found and fixed during this measurement

| Commit | Problem found by the load profile | Fix |
|---|---|---|
| `461843e` | The web process hung permanently under concurrent writes. Every pool connection was held by a write transaction waiting for a second connection: the assignee check on tasks and the mention/watcher checks on comments ran on the pool instead of the transaction. | These checks now run on the transaction. The access snapshot reads sequentially inside a transaction. The pool gives up after 15 s instead of waiting forever. New test `pool-safety.test.ts` runs the critical writes on a one-connection pool. |
| `a61c737` | The production dashboard returned 500 for every scoped member (project and direction leads). The stage-aging query referenced an unaliased column. | Fixed, with a regression assertion in the scoped analytics test. |
| `dd7bcba` | `next build` failed its type check (pdfkit typing). | The declaration is now referenced from the file that imports pdfkit. |
| `ac53b2a` | Default list orders and per-record counters scanned whole tables: 210 ms for the open-task order, 220 ms for the publication order, and 80–200 ms for subtask, content-item and project counters. | Migration `0002_perf_indexes`. The same queries now take under 1 ms or are index lookups. |
| `fb906e0` | The content dashboard loaded the cohort, observations and all metric values once per checkpoint key and period: 1.17 M rows and about 12 s of CPU. | One load per period, and values are read only for the chosen observations: 250 k rows and about 3 s. |
| `aa61a4d` | A dashboard blocked the event loop for up to 2.8 s at a time. During that time, health checks with no database access took 3 s. | Metrics yield to the event loop between reductions. Period grouping uses a binary-search bucket locator (property-tested against `bucketKeyOf`). The longest stall is now 0.4–1.3 s. |
| `19e6adb` | `media.purgeDeletedVersions` was scheduled into a pool that has no runner for it, so it stayed queued forever. This showed up as growing queue lag. | The schedule names the media pool, and `enqueueJob` defaults to the pool the job is defined for. A test ticks the scheduler and checks every scheduled job's pool. |
| `89d3689` | Every API request rebuilt the member's access snapshot: 8 queries, including every project and account of the workspace (about 6,000 rows per request at §28.3 volumes). In a CPU profile, about 30 % of the web process's busy time went to parsing PostgreSQL results and to garbage collection. | Per-process cache keyed by the membership's access revision and a workspace access revision. Database triggers bump the revision in the same transaction as any change to grants, denies, teams, assignments, roles or the project → direction and account → project structure (migration `0003_access_revision`, `sql/post/011_access_revision.sql`). A warm request reads one row. Tests in `access-cache.test.ts`: revoking a role, moving a project to another direction, adding a project and reassigning an account apply on the next request; a time-bounded grant expires without a write. |
| `0944782` | Dashboards were computed from raw facts on every request: 3–7 s of web CPU and 10–38 s of summed query time for one 90-day dashboard. §28.3 measures analytics "after warmed read models", and there were none. | Read model `analytics_dashboard_snapshots` (migration `0004_dashboard_snapshots`), one row per tab, filters, access scope and time zone. An outbox consumer marks snapshots stale; the worker job `analytics.refreshSnapshots` recomputes them. Responses carry the age of the figures, shown in the UI with "Recalculate now". Tests in `dashboard-snapshots.test.ts` compare served and live results on the same data. |
| `0fa31be` | The reference deployment ran one web process, which uses one core. | Three web processes behind Caddy with a sticky cookie and active health checks (`infra/docker-compose.yml`, `infra/caddy/Caddyfile`, "Scaling the web tier" in `docs/runbooks/deploy.md`, including per-process rate limits). |
| `ff92e86` | With the access cache in place, sampling the database under load (auto_explain on the load database) showed list and detail queries that read far more rows than they returned. The publication detail loaded its tasks with a parallel sequential scan of all 500,000 tasks (about 200 ms). The scheduled-publication queue walked the whole default-order index (0.7 s). Content lists of account-scoped members sorted every visible item and crossed the JIT threshold (0.4 s). Project and account lists aggregated every observation for "metrics updated" (50–200 ms). | Migration `0005_list_indexes` (tasks by publication and by account, publications by status in list order, content in list order, account placements for content visibility) and a per-row lookup of the newest usable observation, checked against the aggregate in `latest-observation.test.ts`. The same queries take 0.1–14 ms. PostgreSQL CPU in the steady state fell from 114 % to 77 % of a core (compare the before-list-indexes run). |

### What remains, and recommendations

1. **Run it on staging hardware.** On this 4-vCPU container every class meets its threshold in the steady state, with the host about half busy. The ×3 burst needs about 6.4 cores at the measured cost per request, so it saturates the container, and the backlog it leaves sets the p95 over all phases. The thresholds are therefore neither confirmed nor refuted for §28.3's staging hardware. Size staging from the capacity arithmetic above: at least three web processes (about 1.6 cores at the burst), PostgreSQL on its own cores (about 2.3 cores of backends at the burst, plus its background work) and the worker separate. Then repeat this run there.
2. **Search is the largest remaining database cost.** Under load, the global search was the most frequent active statement. Common words match tens of thousands of documents: one project-name word matched about 36,000. The permission filter and the relevance order are applied only after all matches have been read from the table, which takes 100–140 ms and 27,000 buffers for one query. Options: apply the member's scope before the text match (indexes on the scope columns of the search projection), cap the candidate set, or move search to a dedicated index.
3. **Dashboard refreshes scale with the number of access scopes.** The 69 dashboard views of the warm-up needed 59 separate snapshots, because project leads, producers and publishers each have their own scope. One computation takes up to about 12 s. While data keeps changing, the worker recomputes every snapshot in use once per `ANALYTICS_SNAPSHOT_MIN_REFRESH_SECONDS` (300 s by default). In this run the refresh overlapped the burst: `analytics.refreshSnapshots` ran for up to 61 s at a time, and the worker used 42–56 % of a core. If that is too much on staging, raise the minimum interval, refresh only snapshots viewed since their last computation, or build dashboards from shared daily aggregates per project and account instead of per-scope snapshots.
4. **Host CPU outside the attributed processes.** In the steady state about 16 of the 61 ms of host CPU per request were not in the web, PostgreSQL backend, worker, proxy or load-generator processes. Most of it is likely PostgreSQL parallel-query workers, background processes and the kernel. Parallel workers are forked per query and live too briefly to sample, but the database sampling showed them among the most frequently active processes, and `top` showed about 22 % system time during a diagnostic run. Parallel query and JIT (both on by default) cost CPU on a busy OLTP server. On staging, measure the run with `max_parallel_workers_per_gather = 0` and `jit = off` for the application role.

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
