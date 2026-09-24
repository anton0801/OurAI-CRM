# Performance report: staging load profile (T170)

Generated 2026-09-24T17:06:57.504Z from commit `2929e92` by `pnpm perf:run` (tests/performance). Raw numbers: [`performance-results-before-list-indexes.json`](performance-results-before-list-indexes.json).

> **Other run (`before-list-indexes`), kept for comparison.** The acceptance verdict comes from `performance-report.md`.

> **Where this was measured.** This run used the development container described under Environment, not the fixed staging
> hardware that spec §28.3 names. PostgreSQL, the web server process(es), the worker and the load generator shared the same
> 4 CPUs. The numbers show how this build behaves under the §28.3 profile with §28.3 data volumes on this
> machine. They do not certify staging, so repeat the run on staging before sign-off (see “Re-running on staging”).

**Result: 0 of 6 threshold classes pass, 6 fail** (p95 over 360 s of measured load: steady state, the ×3 burst and cool-down; a class also fails when more than 1 % of its requests error).

| Class | Threshold (p95) | p50 | p95 | p99 | max | Requests | Errors | Verdict |
|---|---|---|---|---|---|---|---|---|
| API list | ≤ 500 ms | 81 ms | **10198 ms** | 13249 ms | 16160 ms | 4,410 | 0 (0.00 %) | ❌ FAIL |
| API detail | ≤ 500 ms | 88 ms | **14627 ms** | 18599 ms | 23806 ms | 4,719 | 0 (0.00 %) | ❌ FAIL |
| Search | ≤ 700 ms | 170 ms | **8751 ms** | 10283 ms | 12830 ms | 2,197 | 0 (0.00 %) | ❌ FAIL |
| Standard 90-day analytics | ≤ 2,000 ms | 32 ms | **11179 ms** | 13211 ms | 13211 ms | 55 | 0 (0.00 %) | ❌ FAIL |
| Critical writes | ≤ 800 ms | 120 ms | **9341 ms** | 10855 ms | 13209 ms | 1,874 | 1 (0.05 %) | ❌ FAIL |
| Heavy request returns a job | ≤ 1,000 ms | 76 ms | **8536 ms** | 10635 ms | 10635 ms | 88 | 0 (0.00 %) | ❌ FAIL |

Class membership: *API list* = task, project, account, content and publication lists (filters, sorting, 20 % next-page cursors);
*API detail* = the same records opened from those lists; *Search* = the global search palette; *Standard 90-day analytics* =
analytics dashboard tabs (production, content, accounts) for `last_90_days` with comparison; *Critical writes* = create task,
status transition with If-Match, comment, time entry; *Heavy request* = export request answered by a background job (time to 202).

## p95 by phase

| Class | steady (×1) | burst (×3) | cooldown (×1) |
|---|---|---|---|
| API list | 447 ms | 13846 ms | 10627 ms |
| API detail | 413 ms | 19014 ms | 13855 ms |
| Search | 548 ms | 10409 ms | 8764 ms |
| Standard 90-day analytics | 114 ms | 13211 ms | 7754 ms |
| Critical writes | 618 ms | 10921 ms | 9908 ms |
| Heavy request returns a job | 383 ms | 10635 ms | 8536 ms |

## Analytics read model warm-up

Before the measured load every session opened each of its dashboard tabs once (spec §28.3: analytics are measured "after warmed read models"): 69 dashboard views in 83.4 s, 59 of them computed live because no snapshot existed for that access scope yet (slowest 14126 ms), 0 errors. Members with the same effective access share one snapshot per tab. The worker refreshes stale snapshots in the background (`analytics.refreshSnapshots` in the job table below).

During the measured load, 55 of 55 dashboard requests were answered from the read model and 0 were computed live. The figures served were 180 s old at the median and 438 s at most; 55 were marked "refresh pending" because newer records existed. The analytics p95 above therefore measures dashboards served from the read model, as §28.3 specifies, not the cost of computing one.

## Unloaded service time

Before the load: a few sequential requests per operation, one at a time, from sessions of different roles. This is the
latency floor of each endpoint on this data volume without any queueing.

| Endpoint | Class | Samples | p50 | max | Errors |
|---|---|---|---|---|---|
| `tasks.list` | list | 5 | 29 ms | 108 ms | 0 |
| `projects.list` | list | 5 | 56 ms | 94 ms | 0 |
| `accounts.list` | list | 5 | 38 ms | 43 ms | 0 |
| `content.list` | list | 5 | 30 ms | 472 ms | 0 |
| `publications.list` | list | 5 | 26 ms | 65 ms | 0 |
| `tasks.get` | detail | 5 | 33 ms | 48 ms | 0 |
| `projects.get` | detail | 5 | 20 ms | 37 ms | 0 |
| `accounts.get` | detail | 5 | 22 ms | 36 ms | 0 |
| `content.get` | detail | 5 | 30 ms | 49 ms | 0 |
| `publications.get` | detail | 5 | 93 ms | 122 ms | 0 |
| `search.global` | search | 5 | 38 ms | 127 ms | 0 |
| `analytics.dashboard` | analytics | 5 | 22 ms | 23 ms | 0 |
| `tasks.create` | write | 5 | 80 ms | 80 ms | 0 |
| `tasks.transition` | write | 5 | 58 ms | 59 ms | 0 |
| `comments.create` | write | 5 | 46 ms | 64 ms | 0 |
| `time.create` | write | 5 | 32 ms | 38 ms | 0 |
| `exports.create` | heavy | 5 | 33 ms | 47 ms | 0 |

## Queue lag

Sampled every 2 s during the run: the age of the oldest *due* queued job (`now − max(created_at, run_at)`) and of the oldest
undispatched outbox event (`now − occurred_at`). After the load, completion latencies of everything created in the measured window
are read from the database (`finished_at − max(created_at, run_at)` for jobs, `dispatched_at − occurred_at` for outbox events).

| Phase | Oldest job max | Oldest job p95 | Queued jobs max | Oldest outbox max | Oldest outbox p95 | Pending outbox max | Host CPU avg / max |
|---|---|---|---|---|---|---|---|
| warmup | 2.1 s | 2.1 s | 2 | 0.4 s | 0.4 s | 4 | 69.1 % / 85.4 % |
| steady | 12.4 s | 3.9 s | 3 | 29.0 s | 19.0 s | 149 | 72 % / 99.1 % |
| burst | 16.2 s | 16.2 s | 4 | 29.0 s | 29.0 s | 150 | 97.5 % / 99.5 % |
| cooldown | 19.6 s | 19.6 s | 10 | 29.7 s | 29.7 s | 208 | 88.9 % / 99.6 % |

CPU by process during the run (100 % = one core; sampled every 2 s from /proc):

| Phase | Web server(s) avg / max | Load balancer avg | Worker avg | PostgreSQL (load DB backends) avg | Load generator avg | Whole host avg |
|---|---|---|---|---|---|---|
| warmup | 63.4 % / 76.7 % | 3.5 % | 2.1 % | 108.5 % | 9 % | 69.1 % of 4 cores |
| steady | 55.3 % / 93.4 % | 3.5 % | 14.5 % | 114.4 % | 7 % | 72 % of 4 cores |
| burst | 75.8 % / 103.4 % | 4.9 % | 25.6 % | 159.9 % | 9 % | 97.5 % of 4 cores |
| cooldown | 56.9 % / 86.3 % | 3.6 % | 44.3 % | 143.8 % | 6.9 % | 88.9 % of 4 cores |

Outbox events created in the measured window: 1,967; dispatch latency p50 0.4 s, p95 17.1 s, max 50.0 s; still pending after the drain: 0.
Export jobs requested in the window: 88 (88 completed, 0 failed); request → file ready p50 0.9 s, p95 19.4 s, max 26.1 s.
Queues drained 6 s after the load ended.

| Job type | Pool | Jobs | Not succeeded | Completion p50 | p95 | max |
|---|---|---|---|---|---|---|
| `exports.generate` | data | 88 | 0 | 0.9 s | 19.5 s | 26.5 s |
| `automation.tick` | light | 6 | 0 | 0.3 s | 0.8 s | 0.8 s |
| `analytics.refreshSnapshots` | data | 6 | 0 | 14.4 s | 48.3 s | 48.7 s |
| `platform.healthMonitor` | light | 1 | 0 | 0.2 s | 0.2 s | 0.2 s |
| `publishing.reminders` | light | 1 | 0 | 0.3 s | 0.3 s | 0.3 s |
| `work.reminders` | light | 1 | 0 | 50.3 s | 50.3 s | 50.3 s |
| `insights.reportSchedules` | data | 1 | 0 | 0.2 s | 0.2 s | 0.2 s |
| `ofm.shift_monitor` | light | 1 | 0 | 0.2 s | 0.2 s | 0.2 s |

## Endpoints

| Endpoint | Class | Requests | Errors | p50 | p95 | p99 | max | Error codes |
|---|---|---|---|---|---|---|---|---|
| `analytics.dashboard` | analytics | 55 | 0 | 32 ms | 11179 ms | 13211 ms | 13211 ms | — |
| `accounts.get` | detail | 632 | 0 | 43 ms | 14432 ms | 16295 ms | 17124 ms | — |
| `content.get` | detail | 979 | 0 | 53 ms | 12928 ms | 16027 ms | 18019 ms | — |
| `projects.get` | detail | 589 | 0 | 44 ms | 14115 ms | 17280 ms | 17897 ms | — |
| `publications.get` | detail | 928 | 0 | 195 ms | 10558 ms | 13029 ms | 14626 ms | — |
| `tasks.get` | detail | 1,591 | 0 | 69 ms | 17772 ms | 19951 ms | 23806 ms | — |
| `exports.create` | heavy | 88 | 0 | 76 ms | 8536 ms | 10635 ms | 10635 ms | — |
| `accounts.list` | list | 655 | 0 | 62 ms | 10033 ms | 12371 ms | 13586 ms | — |
| `content.list` | list | 942 | 0 | 81 ms | 9608 ms | 12672 ms | 13705 ms | — |
| `projects.list` | list | 604 | 0 | 121 ms | 9087 ms | 12281 ms | 14323 ms | — |
| `publications.list` | list | 970 | 0 | 79 ms | 9797 ms | 11816 ms | 13825 ms | — |
| `tasks.list` | list | 1,239 | 0 | 73 ms | 11724 ms | 14908 ms | 16160 ms | — |
| `search.global` | search | 2,197 | 0 | 170 ms | 8751 ms | 10283 ms | 12830 ms | — |
| `comments.create` | write | 511 | 0 | 94 ms | 9041 ms | 10616 ms | 13209 ms | — |
| `tasks.create` | write | 600 | 0 | 149 ms | 9860 ms | 10869 ms | 11824 ms | — |
| `tasks.transition` | write | 573 | 1 | 123 ms | 9197 ms | 11204 ms | 13129 ms | VERSION_CONFLICT × 1 |
| `time.create` | write | 190 | 0 | 71 ms | 8727 ms | 10194 ms | 10658 ms | — |

## Load profile

Open model: Poisson arrivals at the configured rates, dispatched whether or not earlier requests finished (50 concurrent
sessions of 10 roles; request sequence seeded with 170). Warm-up traffic is not recorded.

| Phase | Duration | Offered reads/s | Achieved reads/s | Offered writes/s | Achieved writes/s | Recorded |
|---|---|---|---|---|---|---|
| warmup | 30 s | 30 | 30.23 | 5 | 4.7 | no |
| steady | 300 s | 30 | 29.81 | 5 | 5.17 | 10,494 |
| burst | 30 s | 90 | 52.37 | 15 | 9.3 | 1,850 |
| cooldown | 30 s | 30 | 28.93 | 5 | 4.37 | 999 |

Dispatch lag p95 (scheduled → sent): 7 ms; highest number of requests in flight: 500; dropped at the in-flight cap: {"content.get":94,"comments.create":50,"tasks.create":60,"tasks.get":147,"accounts.list":70,"content.list":94,"search.global":198,"publications.get":114,"projects.get":65,"publications.list":95,"tasks.list":125,"accounts.get":44,"exports.create":7,"projects.list":48,"tasks.transition":57,"analytics.dashboard":3,"time.create":18}.

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
- Host load average (1 / 5 / 15 min): 1.38 / 2.61 / 3.51 when the runner started, before the warm-ups, 3.96 / 3.26 / 3.65 when the measured load started, 10.12 / 6.87 / 5.03 when the run ended (the run itself contributes to the later values)
- Node.js v22.22.2; PostgreSQL 16.13 (Ubuntu 16.13-0ubuntu0.24.04.1); settings shared_buffers=512MB, work_mem=4MB, effective_cache_size=4GB, max_connections=400, random_page_cost=4, max_parallel_workers_per_gather=2, jit=on
- Database size after the run: 3.21 GiB
- Server under test: local production build of commit 2929e92: Caddy 2.11.4 (lb_policy cookie, active health checks, config as infra/caddy/Caddyfile without TLS) in front of 3 Next.js standalone server processes (DATABASE_POOL_MAX=10 each) and the worker (JOB_CONCURRENCY=4), NODE_ENV=production, default ACCESS_CACHE_TTL_MS and ANALYTICS_SNAPSHOT_* settings
- Target http://127.0.0.1:3200 (3 web server process(es) behind the load balancer); the load generator ran on the same host

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
