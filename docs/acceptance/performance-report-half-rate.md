# Performance report: staging load profile (T170)

Generated 2026-09-24T16:04:14.780Z from commit `480b6b6` by `pnpm perf:run` (tests/performance). Raw numbers: [`performance-results-half-rate.json`](performance-results-half-rate.json).

> **Where this was measured.** This run used the development container described under Environment, not the fixed staging
> hardware that spec §28.3 names. PostgreSQL, the web server, the worker and the load generator shared the same
> 4 CPUs. The numbers show how this build behaves under the §28.3 profile with §28.3 data volumes on this
> machine. They do not certify staging, so repeat the run on staging before sign-off (see “Re-running on staging”).

**Result: 0 of 6 threshold classes pass, 6 fail** (p95 over 180 s of measured load: steady state, the ×3 burst and cool-down; a class also fails when more than 1 % of its requests error).

| Class | Threshold (p95) | p50 | p95 | p99 | max | Requests | Errors | Verdict |
|---|---|---|---|---|---|---|---|---|
| API list | ≤ 500 ms | 2827 ms | **14215 ms** | 15989 ms | 17162 ms | 1,358 | 0 (0.00 %) | ❌ FAIL |
| API detail | ≤ 500 ms | 3937 ms | **20105 ms** | 21576 ms | 23247 ms | 1,390 | 0 (0.00 %) | ❌ FAIL |
| Search | ≤ 700 ms | 2531 ms | **11595 ms** | 12691 ms | 13358 ms | 645 | 0 (0.00 %) | ❌ FAIL |
| Standard 90-day analytics | ≤ 2,000 ms | 4631 ms | **18012 ms** | 18012 ms | 18012 ms | 16 | 0 (0.00 %) | ❌ FAIL |
| Critical writes | ≤ 800 ms | 2659 ms | **11853 ms** | 13190 ms | 13395 ms | 517 | 0 (0.00 %) | ❌ FAIL |
| Heavy request returns a job | ≤ 1,000 ms | 2535 ms | **10731 ms** | 11924 ms | 11924 ms | 29 | 0 (0.00 %) | ❌ FAIL |

Class membership: *API list* = task, project, account, content and publication lists (filters, sorting, 20 % next-page cursors);
*API detail* = the same records opened from those lists; *Search* = the global search palette; *Standard 90-day analytics* =
analytics dashboard tabs (production, content, accounts) for `last_90_days` with comparison; *Critical writes* = create task,
status transition with If-Match, comment, time entry; *Heavy request* = export request answered by a background job (time to 202).

## p95 by phase

| Class | steady (×1) | burst (×3) | cooldown (×1) |
|---|---|---|---|
| API list | 5137 ms | 15595 ms | 14476 ms |
| API detail | 6553 ms | 21229 ms | 18438 ms |
| Search | 4654 ms | 12394 ms | 11557 ms |
| Standard 90-day analytics | 9287 ms | 18012 ms | 16764 ms |
| Critical writes | 5300 ms | 13014 ms | 11861 ms |
| Heavy request returns a job | 5800 ms | 11924 ms | 10304 ms |

## Unloaded service time

Before the load: a few sequential requests per operation, one at a time, from sessions of different roles. This is the
latency floor of each endpoint on this data volume without any queueing.

| Endpoint | Class | Samples | p50 | max | Errors |
|---|---|---|---|---|---|
| `tasks.list` | list | 5 | 35 ms | 38 ms | 0 |
| `projects.list` | list | 5 | 54 ms | 69 ms | 0 |
| `accounts.list` | list | 5 | 32 ms | 43 ms | 0 |
| `content.list` | list | 5 | 32 ms | 266 ms | 0 |
| `publications.list` | list | 5 | 32 ms | 52 ms | 0 |
| `tasks.get` | detail | 5 | 33 ms | 38 ms | 0 |
| `projects.get` | detail | 5 | 31 ms | 35 ms | 0 |
| `accounts.get` | detail | 5 | 26 ms | 31 ms | 0 |
| `content.get` | detail | 5 | 26 ms | 30 ms | 0 |
| `publications.get` | detail | 5 | 102 ms | 110 ms | 0 |
| `search.global` | search | 5 | 43 ms | 123 ms | 0 |
| `analytics.dashboard` | analytics | 5 | 439 ms | 2736 ms | 0 |
| `tasks.create` | write | 5 | 101 ms | 106 ms | 0 |
| `tasks.transition` | write | 5 | 68 ms | 74 ms | 0 |
| `comments.create` | write | 5 | 55 ms | 102 ms | 0 |
| `time.create` | write | 5 | 40 ms | 47 ms | 0 |
| `exports.create` | heavy | 5 | 38 ms | 39 ms | 0 |

## Queue lag

Sampled every 2 s during the run: the age of the oldest *due* queued job (`now − max(created_at, run_at)`) and of the oldest
undispatched outbox event (`now − occurred_at`). After the load, completion latencies of everything created in the measured window
are read from the database (`finished_at − max(created_at, run_at)` for jobs, `dispatched_at − occurred_at` for outbox events).

| Phase | Oldest job max | Oldest job p95 | Queued jobs max | Oldest outbox max | Oldest outbox p95 | Pending outbox max | Host CPU avg / max |
|---|---|---|---|---|---|---|---|
| warmup | 2.0 s | 2.0 s | 1 | 0.6 s | 0.6 s | 2 | 53.1 % / 84.5 % |
| steady | 0.7 s | 0.5 s | 1 | 0.5 s | 0.4 s | 3 | 48.7 % / 88.2 % |
| burst | 0.5 s | 0.5 s | 1 | 0.6 s | 0.6 s | 7 | 74.5 % / 86.8 % |
| cooldown | 1.0 s | 1.0 s | 1 | 1.0 s | 1.0 s | 5 | 76.3 % / 90.6 % |

CPU by process during the run (100 % = one core; sampled every 2 s from /proc):

| Phase | Web server(s) avg / max | Worker avg | PostgreSQL (load DB backends) avg | Load generator avg | Whole host avg |
|---|---|---|---|---|---|
| warmup | 56.2 % / 119 % | 3 % | 61.9 % | 5.5 % | 53.1 % of 4 cores |
| steady | 60.4 % / 138.8 % | 2.5 % | 68.1 % | 5 % | 48.7 % of 4 cores |
| burst | 99 % / 121.1 % | 3.3 % | 104.4 % | 8.3 % | 74.5 % of 4 cores |
| cooldown | 93.5 % / 129 % | 1.5 % | 112.3 % | 7.6 % | 76.3 % of 4 cores |

Outbox events created in the measured window: 546; dispatch latency p50 0.4 s, p95 0.7 s, max 4.0 s; still pending after the drain: 0.
Export jobs requested in the window: 29 (29 completed, 0 failed); request → file ready p50 0.6 s, p95 1.2 s, max 1.4 s.
Queues drained 0 s after the load ended.

| Job type | Pool | Jobs | Not succeeded | Completion p50 | p95 | max |
|---|---|---|---|---|---|---|
| `exports.generate` | data | 29 | 0 | 0.6 s | 1.3 s | 1.5 s |
| `automation.tick` | light | 3 | 0 | 0.7 s | 1.0 s | 1.0 s |

## Endpoints

| Endpoint | Class | Requests | Errors | p50 | p95 | p99 | max | Error codes |
|---|---|---|---|---|---|---|---|---|
| `analytics.dashboard` | analytics | 16 | 0 | 4631 ms | 18012 ms | 18012 ms | 18012 ms | — |
| `accounts.get` | detail | 195 | 0 | 3482 ms | 17152 ms | 18447 ms | 18504 ms | — |
| `content.get` | detail | 297 | 0 | 3598 ms | 16214 ms | 17969 ms | 18942 ms | — |
| `projects.get` | detail | 166 | 0 | 3614 ms | 18557 ms | 19923 ms | 20835 ms | — |
| `publications.get` | detail | 281 | 0 | 3889 ms | 13279 ms | 14372 ms | 15801 ms | — |
| `tasks.get` | detail | 451 | 0 | 4712 ms | 21257 ms | 22416 ms | 23247 ms | — |
| `exports.create` | heavy | 29 | 0 | 2535 ms | 10731 ms | 11924 ms | 11924 ms | — |
| `accounts.list` | list | 175 | 0 | 3141 ms | 12938 ms | 14340 ms | 14347 ms | — |
| `content.list` | list | 289 | 0 | 2259 ms | 13013 ms | 14317 ms | 14512 ms | — |
| `projects.list` | list | 190 | 0 | 3429 ms | 13049 ms | 14408 ms | 14562 ms | — |
| `publications.list` | list | 291 | 0 | 2827 ms | 13022 ms | 14080 ms | 14425 ms | — |
| `tasks.list` | list | 413 | 0 | 2820 ms | 15648 ms | 16950 ms | 17162 ms | — |
| `search.global` | search | 645 | 0 | 2531 ms | 11595 ms | 12691 ms | 13358 ms | — |
| `comments.create` | write | 135 | 0 | 2591 ms | 11719 ms | 11818 ms | 11942 ms | — |
| `tasks.create` | write | 164 | 0 | 2830 ms | 12141 ms | 13294 ms | 13395 ms | — |
| `tasks.transition` | write | 162 | 0 | 2591 ms | 11861 ms | 13190 ms | 13346 ms | — |
| `time.create` | write | 56 | 0 | 1908 ms | 10704 ms | 13207 ms | 13207 ms | — |

## Load profile

Open model: Poisson arrivals at the configured rates, dispatched whether or not earlier requests finished (50 concurrent
sessions of 10 roles; request sequence seeded with 170). Warm-up traffic is not recorded.

| Phase | Duration | Offered reads/s | Achieved reads/s | Offered writes/s | Achieved writes/s | Recorded |
|---|---|---|---|---|---|---|
| warmup | 30 s | 15 | 14.17 | 2.5 | 2.73 | no |
| steady | 120 s | 15 | 14.88 | 2.5 | 2.32 | 2,063 |
| burst | 30 s | 45 | 38.93 | 7.5 | 6.63 | 1,367 |
| cooldown | 30 s | 15 | 15.2 | 2.5 | 2.3 | 525 |

Dispatch lag p95 (scheduled → sent): 4 ms; highest number of requests in flight: 500; dropped at the in-flight cap: {"tasks.transition":5,"publications.list":11,"publications.get":17,"tasks.get":30,"tasks.list":17,"comments.create":5,"accounts.get":5,"search.global":25,"content.list":11,"content.get":17,"projects.get":4,"projects.list":8,"tasks.create":9,"time.create":2,"accounts.list":10,"analytics.dashboard":2,"exports.create":1}.

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
- Host load average (1 / 5 / 15 min): 3.16 / 5.05 / 5.07 when the load started, 4.16 / 4.21 / 4.7 when the run ended (the run itself contributes to it)
- Node.js v22.22.2; PostgreSQL 16.13 (Ubuntu 16.13-0ubuntu0.24.04.1); settings shared_buffers=512MB, work_mem=4MB, effective_cache_size=4GB, max_connections=400, random_page_cost=4, max_parallel_workers_per_gather=2, jit=on
- Database size after the run: 3.21 GiB
- Server under test: supplementary: half the §28.3 rates (15 reads/s, 2.5 writes/s, ×3 burst), same mix, one web process of the production build (commit 480b6b6), DATABASE_POOL_MAX=10; worker JOB_CONCURRENCY=4; NODE_ENV=production
- Target http://127.0.0.1:3200 (1 web server process(es), sessions spread over them); the load generator ran on the same host

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
