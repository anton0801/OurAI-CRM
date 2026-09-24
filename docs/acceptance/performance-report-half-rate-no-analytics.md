# Performance report: staging load profile (T170)

Generated 2026-09-24T16:08:27.654Z from commit `480b6b6` by `pnpm perf:run` (tests/performance). Raw numbers: [`performance-results-half-rate-no-analytics.json`](performance-results-half-rate-no-analytics.json).

> **Supplementary run:** `analytics.dashboard` left out of the mix to isolate the other classes. The acceptance
> verdict comes from the full profile in `performance-report.md`.

> **Where this was measured.** This run used the development container described under Environment, not the fixed staging
> hardware that spec §28.3 names. PostgreSQL, the web server, the worker and the load generator shared the same
> 4 CPUs. The numbers show how this build behaves under the §28.3 profile with §28.3 data volumes on this
> machine. They do not certify staging, so repeat the run on staging before sign-off (see “Re-running on staging”).

**Result: 0 of 6 threshold classes pass, 5 fail** (p95 over 180 s of measured load: steady state, the ×3 burst and cool-down; a class also fails when more than 1 % of its requests error).

| Class | Threshold (p95) | p50 | p95 | p99 | max | Requests | Errors | Verdict |
|---|---|---|---|---|---|---|---|---|
| API list | ≤ 500 ms | 164 ms | **14031 ms** | 16095 ms | 18280 ms | 1,367 | 0 (0.00 %) | ❌ FAIL |
| API detail | ≤ 500 ms | 148 ms | **19661 ms** | 21589 ms | 22544 ms | 1,422 | 0 (0.00 %) | ❌ FAIL |
| Search | ≤ 700 ms | 263 ms | **11901 ms** | 13384 ms | 14413 ms | 690 | 0 (0.00 %) | ❌ FAIL |
| Standard 90-day analytics | ≤ 2,000 ms | — | **—** | — | — | 0 | 0 (0.00 %) | — no data |
| Critical writes | ≤ 800 ms | 210 ms | **12222 ms** | 12739 ms | 14528 ms | 517 | 0 (0.00 %) | ❌ FAIL |
| Heavy request returns a job | ≤ 1,000 ms | 81 ms | **10876 ms** | 12377 ms | 12377 ms | 36 | 0 (0.00 %) | ❌ FAIL |

Class membership: *API list* = task, project, account, content and publication lists (filters, sorting, 20 % next-page cursors);
*API detail* = the same records opened from those lists; *Search* = the global search palette; *Standard 90-day analytics* =
analytics dashboard tabs (production, content, accounts) for `last_90_days` with comparison; *Critical writes* = create task,
status transition with If-Match, comment, time entry; *Heavy request* = export request answered by a background job (time to 202).

## p95 by phase

| Class | steady (×1) | burst (×3) | cooldown (×1) |
|---|---|---|---|
| API list | 165 ms | 15316 ms | 13127 ms |
| API detail | 148 ms | 21464 ms | 15968 ms |
| Search | 249 ms | 12435 ms | 11880 ms |
| Standard 90-day analytics | — | — | — |
| Critical writes | 160 ms | 12634 ms | 12266 ms |
| Heavy request returns a job | 81 ms | 12377 ms | 10876 ms |

## Unloaded service time

Before the load: a few sequential requests per operation, one at a time, from sessions of different roles. This is the
latency floor of each endpoint on this data volume without any queueing.

| Endpoint | Class | Samples | p50 | max | Errors |
|---|---|---|---|---|---|
| `tasks.list` | list | 5 | 28 ms | 30 ms | 0 |
| `projects.list` | list | 5 | 58 ms | 67 ms | 0 |
| `accounts.list` | list | 5 | 28 ms | 35 ms | 0 |
| `content.list` | list | 5 | 26 ms | 315 ms | 0 |
| `publications.list` | list | 5 | 26 ms | 50 ms | 0 |
| `tasks.get` | detail | 5 | 32 ms | 38 ms | 0 |
| `projects.get` | detail | 5 | 28 ms | 50 ms | 0 |
| `accounts.get` | detail | 5 | 24 ms | 28 ms | 0 |
| `content.get` | detail | 5 | 29 ms | 37 ms | 0 |
| `publications.get` | detail | 5 | 99 ms | 103 ms | 0 |
| `search.global` | search | 5 | 43 ms | 116 ms | 0 |
| `tasks.create` | write | 5 | 66 ms | 107 ms | 0 |
| `tasks.transition` | write | 5 | 51 ms | 60 ms | 0 |
| `comments.create` | write | 5 | 51 ms | 58 ms | 0 |
| `time.create` | write | 5 | 29 ms | 33 ms | 0 |
| `exports.create` | heavy | 5 | 26 ms | 31 ms | 0 |

## Queue lag

Sampled every 2 s during the run: the age of the oldest *due* queued job (`now − max(created_at, run_at)`) and of the oldest
undispatched outbox event (`now − occurred_at`). After the load, completion latencies of everything created in the measured window
are read from the database (`finished_at − max(created_at, run_at)` for jobs, `dispatched_at − occurred_at` for outbox events).

| Phase | Oldest job max | Oldest job p95 | Queued jobs max | Oldest outbox max | Oldest outbox p95 | Pending outbox max | Host CPU avg / max |
|---|---|---|---|---|---|---|---|
| warmup | 2.0 s | 2.0 s | 1 | 0.3 s | 0.3 s | 3 | 42.2 % / 61.8 % |
| steady | 0.9 s | 0.2 s | 6 | 0.4 s | 0.4 s | 5 | 40.3 % / 59 % |
| burst | 1.3 s | 1.3 s | 1 | 0.7 s | 0.7 s | 6 | 77.7 % / 84.8 % |
| cooldown | 0.5 s | 0.5 s | 1 | 0.5 s | 0.5 s | 3 | 92.5 % / 96.4 % |

CPU by process during the run (100 % = one core; sampled every 2 s from /proc):

| Phase | Web server(s) avg / max | Worker avg | PostgreSQL (load DB backends) avg | Load generator avg | Whole host avg |
|---|---|---|---|---|---|
| warmup | 39.3 % / 54 % | 3 % | 63.9 % | 6.1 % | 42.2 % of 4 cores |
| steady | 38.5 % / 59 % | 3.2 % | 60.6 % | 4.5 % | 40.3 % of 4 cores |
| burst | 96.8 % / 122 % | 3 % | 114.2 % | 9.2 % | 77.7 % of 4 cores |
| cooldown | 72.8 % / 104 % | 2.1 % | 110.3 % | 6.3 % | 92.5 % of 4 cores |

Outbox events created in the measured window: 557; dispatch latency p50 0.3 s, p95 0.7 s, max 1.1 s; still pending after the drain: 0.
Export jobs requested in the window: 36 (36 completed, 0 failed); request → file ready p50 0.6 s, p95 1.2 s, max 1.5 s.
Queues drained 0 s after the load ended.

| Job type | Pool | Jobs | Not succeeded | Completion p50 | p95 | max |
|---|---|---|---|---|---|---|
| `exports.generate` | data | 36 | 0 | 0.7 s | 1.3 s | 1.5 s |
| `automation.tick` | light | 3 | 0 | 0.3 s | 0.8 s | 0.9 s |
| `platform.healthMonitor` | light | 1 | 0 | 0.9 s | 0.9 s | 0.9 s |
| `publishing.reminders` | light | 1 | 0 | 0.9 s | 0.9 s | 0.9 s |
| `work.reminders` | light | 1 | 0 | 1.8 s | 1.8 s | 1.8 s |
| `ofm.shift_monitor` | light | 1 | 0 | 0.8 s | 0.8 s | 0.8 s |
| `insights.reportSchedules` | data | 1 | 0 | 0.9 s | 0.9 s | 0.9 s |

## Endpoints

| Endpoint | Class | Requests | Errors | p50 | p95 | p99 | max | Error codes |
|---|---|---|---|---|---|---|---|---|
| `accounts.get` | detail | 189 | 0 | 805 ms | 18092 ms | 18642 ms | 19429 ms | — |
| `content.get` | detail | 301 | 0 | 94 ms | 16595 ms | 17944 ms | 19639 ms | — |
| `projects.get` | detail | 169 | 0 | 76 ms | 19100 ms | 20402 ms | 20430 ms | — |
| `publications.get` | detail | 297 | 0 | 187 ms | 13685 ms | 15007 ms | 15593 ms | — |
| `tasks.get` | detail | 466 | 0 | 92 ms | 21468 ms | 22096 ms | 22544 ms | — |
| `exports.create` | heavy | 36 | 0 | 81 ms | 10876 ms | 12377 ms | 12377 ms | — |
| `accounts.list` | list | 192 | 0 | 82 ms | 13499 ms | 14975 ms | 15258 ms | — |
| `content.list` | list | 292 | 0 | 249 ms | 13194 ms | 14262 ms | 15425 ms | — |
| `projects.list` | list | 200 | 0 | 617 ms | 13618 ms | 15105 ms | 15478 ms | — |
| `publications.list` | list | 289 | 0 | 107 ms | 13502 ms | 15097 ms | 15460 ms | — |
| `tasks.list` | list | 394 | 0 | 154 ms | 15611 ms | 16824 ms | 18280 ms | — |
| `search.global` | search | 690 | 0 | 263 ms | 11901 ms | 13384 ms | 14413 ms | — |
| `comments.create` | write | 137 | 0 | 160 ms | 11961 ms | 12372 ms | 12726 ms | — |
| `tasks.create` | write | 164 | 0 | 241 ms | 12321 ms | 13996 ms | 14528 ms | — |
| `tasks.transition` | write | 158 | 0 | 750 ms | 12442 ms | 12739 ms | 12772 ms | — |
| `time.create` | write | 58 | 0 | 61 ms | 12120 ms | 12278 ms | 12278 ms | — |

## Load profile

Open model: Poisson arrivals at the configured rates, dispatched whether or not earlier requests finished (50 concurrent
sessions of 10 roles; request sequence seeded with 170). Warm-up traffic is not recorded.

| Phase | Duration | Offered reads/s | Achieved reads/s | Offered writes/s | Achieved writes/s | Recorded |
|---|---|---|---|---|---|---|
| warmup | 30 s | 15 | 14.13 | 2.5 | 2.67 | no |
| steady | 120 s | 15 | 14.89 | 2.5 | 2.31 | 2,064 |
| burst | 30 s | 45 | 41.27 | 7.5 | 7 | 1,448 |
| cooldown | 30 s | 15 | 15.13 | 2.5 | 2.2 | 520 |

Dispatch lag p95 (scheduled → sent): 3 ms; highest number of requests in flight: 500; dropped at the in-flight cap: {"publications.get":8,"projects.list":7,"accounts.get":4,"search.global":16,"publications.list":7,"tasks.get":14,"tasks.list":7,"tasks.create":5,"comments.create":2,"content.get":10,"projects.get":3,"accounts.list":4,"content.list":3,"tasks.transition":4,"time.create":1,"exports.create":1}.

| Role | Sessions | Operations offered |
|---|---|---|
| project_lead | 10 | `tasks.list`, `projects.list`, `accounts.list`, `content.list`, `publications.list`, `tasks.get`, `projects.get`, `accounts.get`, `content.get`, `publications.get`, `search.global`, `tasks.create`, `tasks.transition`, `comments.create`, `time.create`, `exports.create` |
| creator | 10 | `tasks.list`, `projects.list`, `content.list`, `tasks.get`, `projects.get`, `content.get`, `search.global`, `tasks.transition`, `comments.create`, `time.create` |
| producer | 8 | `tasks.list`, `projects.list`, `accounts.list`, `content.list`, `publications.list`, `tasks.get`, `projects.get`, `accounts.get`, `content.get`, `publications.get`, `search.global`, `tasks.create`, `tasks.transition`, `comments.create`, `time.create` |
| publisher | 7 | `tasks.list`, `accounts.list`, `content.list`, `publications.list`, `tasks.get`, `accounts.get`, `content.get`, `publications.get`, `search.global`, `comments.create` |
| direction_lead | 5 | `tasks.list`, `projects.list`, `accounts.list`, `content.list`, `publications.list`, `tasks.get`, `projects.get`, `accounts.get`, `content.get`, `publications.get`, `search.global`, `tasks.create`, `tasks.transition`, `comments.create`, `time.create`, `exports.create` |
| analyst | 4 | `projects.list`, `accounts.list`, `content.list`, `publications.list`, `projects.get`, `accounts.get`, `content.get`, `publications.get`, `search.global` |
| admin | 2 | `tasks.list`, `projects.list`, `accounts.list`, `content.list`, `publications.list`, `tasks.get`, `projects.get`, `accounts.get`, `content.get`, `publications.get`, `search.global`, `tasks.create`, `tasks.transition`, `comments.create`, `time.create`, `exports.create` |
| finance_manager | 2 | `projects.list`, `accounts.list`, `projects.get`, `accounts.get`, `search.global` |
| owner | 1 | `tasks.list`, `projects.list`, `accounts.list`, `content.list`, `publications.list`, `tasks.get`, `projects.get`, `accounts.get`, `content.get`, `publications.get`, `search.global`, `tasks.create`, `tasks.transition`, `comments.create`, `time.create`, `exports.create` |
| viewer | 1 | `tasks.list`, `projects.list`, `accounts.list`, `content.list`, `publications.list`, `tasks.get`, `projects.get`, `accounts.get`, `content.get`, `publications.get`, `search.global` |

Mix weights (reads, then writes). Reads: tasks.list 8, projects.list 4, accounts.list 4, content.list 6, publications.list 6, tasks.get 10, projects.get 4, accounts.get 4, content.get 6, publications.get 6, search.global 14.
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
- Host load average (1 / 5 / 15 min): 2.45 / 3.73 / 4.51 when the load started, 5.87 / 4.12 / 4.47 when the run ended (the run itself contributes to it)
- Node.js v22.22.2; PostgreSQL 16.13 (Ubuntu 16.13-0ubuntu0.24.04.1); settings shared_buffers=512MB, work_mem=4MB, effective_cache_size=4GB, max_connections=400, random_page_cost=4, max_parallel_workers_per_gather=2, jit=on
- Database size after the run: 3.21 GiB
- Server under test: supplementary: half the §28.3 rates (15 reads/s, 2.5 writes/s, ×3 burst) without dashboards, one web process of the production build (commit 480b6b6), DATABASE_POOL_MAX=10; worker JOB_CONCURRENCY=4; NODE_ENV=production
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
