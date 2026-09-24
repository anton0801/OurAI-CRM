# Performance report: staging load profile (T170)

Generated 2026-09-24T15:59:17.615Z from commit `480b6b6` by `pnpm perf:run` (tests/performance). Raw numbers: [`performance-results-two-web.json`](performance-results-two-web.json).

> **Where this was measured.** This run used the development container described under Environment, not the fixed staging
> hardware that spec §28.3 names. PostgreSQL, the web server, the worker and the load generator shared the same
> 4 CPUs. The numbers show how this build behaves under the §28.3 profile with §28.3 data volumes on this
> machine. They do not certify staging, so repeat the run on staging before sign-off (see “Re-running on staging”).

**Result: 0 of 6 threshold classes pass, 6 fail** (p95 over 180 s of measured load: steady state, the ×3 burst and cool-down; a class also fails when more than 1 % of its requests error).

| Class | Threshold (p95) | p50 | p95 | p99 | max | Requests | Errors | Verdict |
|---|---|---|---|---|---|---|---|---|
| API list | ≤ 500 ms | 4756 ms | **23591 ms** | 27867 ms | 29840 ms | 1,978 | 23 (1.16 %) | ❌ FAIL |
| API detail | ≤ 500 ms | 5554 ms | **23476 ms** | 27772 ms | 29919 ms | 2,189 | 98 (4.48 %) | ❌ FAIL |
| Search | ≤ 700 ms | 3847 ms | **20417 ms** | 24876 ms | 29357 ms | 1,097 | 0 (0.00 %) | ❌ FAIL |
| Standard 90-day analytics | ≤ 2,000 ms | 7212 ms | **20638 ms** | 20638 ms | 20638 ms | 22 | 4 (18.18 %) | ❌ FAIL |
| Critical writes | ≤ 800 ms | 4869 ms | **21505 ms** | 24685 ms | 27457 ms | 809 | 3 (0.37 %) | ❌ FAIL |
| Heavy request returns a job | ≤ 1,000 ms | 6138 ms | **18566 ms** | 22449 ms | 22449 ms | 43 | 0 (0.00 %) | ❌ FAIL |

Class membership: *API list* = task, project, account, content and publication lists (filters, sorting, 20 % next-page cursors);
*API detail* = the same records opened from those lists; *Search* = the global search palette; *Standard 90-day analytics* =
analytics dashboard tabs (production, content, accounts) for `last_90_days` with comparison; *Critical writes* = create task,
status transition with If-Match, comment, time entry; *Heavy request* = export request answered by a background job (time to 202).

## p95 by phase

| Class | steady (×1) | burst (×3) | cooldown (×1) |
|---|---|---|---|
| API list | 8378 ms | 24294 ms | 28271 ms |
| API detail | 11414 ms | 25625 ms | 28142 ms |
| Search | 7037 ms | 16708 ms | 26029 ms |
| Standard 90-day analytics | 10863 ms | 20638 ms | 15733 ms |
| Critical writes | 7395 ms | 20152 ms | 25530 ms |
| Heavy request returns a job | 6691 ms | 18566 ms | 22449 ms |

## Unloaded service time

Before the load: a few sequential requests per operation, one at a time, from sessions of different roles. This is the
latency floor of each endpoint on this data volume without any queueing.

| Endpoint | Class | Samples | p50 | max | Errors |
|---|---|---|---|---|---|
| `tasks.list` | list | 5 | 34 ms | 53 ms | 0 |
| `projects.list` | list | 5 | 58 ms | 90 ms | 0 |
| `accounts.list` | list | 5 | 33 ms | 47 ms | 0 |
| `content.list` | list | 5 | 34 ms | 319 ms | 0 |
| `publications.list` | list | 5 | 29 ms | 59 ms | 0 |
| `tasks.get` | detail | 5 | 39 ms | 46 ms | 0 |
| `projects.get` | detail | 5 | 28 ms | 32 ms | 0 |
| `accounts.get` | detail | 5 | 36 ms | 37 ms | 0 |
| `content.get` | detail | 5 | 42 ms | 70 ms | 0 |
| `publications.get` | detail | 5 | 108 ms | 113 ms | 0 |
| `search.global` | search | 5 | 42 ms | 143 ms | 0 |
| `analytics.dashboard` | analytics | 5 | 493 ms | 3714 ms | 0 |
| `tasks.create` | write | 5 | 106 ms | 108 ms | 0 |
| `tasks.transition` | write | 5 | 62 ms | 97 ms | 0 |
| `comments.create` | write | 5 | 61 ms | 79 ms | 0 |
| `time.create` | write | 5 | 52 ms | 69 ms | 0 |
| `exports.create` | heavy | 5 | 42 ms | 63 ms | 0 |

## Queue lag

Sampled every 2 s during the run: the age of the oldest *due* queued job (`now − max(created_at, run_at)`) and of the oldest
undispatched outbox event (`now − occurred_at`). After the load, completion latencies of everything created in the measured window
are read from the database (`finished_at − max(created_at, run_at)` for jobs, `dispatched_at − occurred_at` for outbox events).

| Phase | Oldest job max | Oldest job p95 | Queued jobs max | Oldest outbox max | Oldest outbox p95 | Pending outbox max | Host CPU avg / max |
|---|---|---|---|---|---|---|---|
| warmup | 2.0 s | 2.0 s | 1 | 1.1 s | 1.1 s | 3 | 85.4 % / 97.2 % |
| steady | 1.5 s | 0.2 s | 2 | 4.9 s | 0.9 s | 6 | 91.7 % / 98.6 % |
| burst | 0.9 s | 0.9 s | 1 | 1.0 s | 1.0 s | 4 | 96.3 % / 98.7 % |
| cooldown | 2.2 s | 0.7 s | 1 | 2.1 s | 1.1 s | 5 | 91 % / 99.1 % |

CPU by process during the run (100 % = one core; sampled every 2 s from /proc):

| Phase | Web server(s) avg / max | Worker avg | PostgreSQL (load DB backends) avg | Load generator avg | Whole host avg |
|---|---|---|---|---|---|
| warmup | 109.3 % / 165 % | 4.1 % | 120.4 % | 7.3 % | 85.4 % of 4 cores |
| steady | 102.4 % / 168.3 % | 2.5 % | 121 % | 7 % | 91.7 % of 4 cores |
| burst | 110 % / 138.7 % | 3.1 % | 118.3 % | 7 % | 96.3 % of 4 cores |
| cooldown | 119.8 % / 201.6 % | 1.5 % | 110.2 % | 5.2 % | 91 % of 4 cores |

Outbox events created in the measured window: 865; dispatch latency p50 0.6 s, p95 1.1 s, max 6.8 s; still pending after the drain: 0.
Export jobs requested in the window: 46 (46 completed, 0 failed); request → file ready p50 0.9 s, p95 1.4 s, max 2.2 s.
Queues drained 2 s after the load ended.

| Job type | Pool | Jobs | Not succeeded | Completion p50 | p95 | max |
|---|---|---|---|---|---|---|
| `exports.generate` | data | 46 | 0 | 1.0 s | 1.7 s | 2.3 s |
| `automation.tick` | light | 4 | 0 | 0.5 s | 0.9 s | 1.0 s |

## Endpoints

| Endpoint | Class | Requests | Errors | p50 | p95 | p99 | max | Error codes |
|---|---|---|---|---|---|---|---|---|
| `analytics.dashboard` | analytics | 22 | 4 | 7212 ms | 20638 ms | 20638 ms | 20638 ms | CLIENT_TIMEOUT × 4 |
| `accounts.get` | detail | 282 | 13 | 5216 ms | 20480 ms | 25812 ms | 29919 ms | CLIENT_TIMEOUT × 13 |
| `content.get` | detail | 460 | 19 | 7154 ms | 22187 ms | 28623 ms | 29490 ms | CLIENT_TIMEOUT × 19 |
| `projects.get` | detail | 275 | 14 | 5783 ms | 21953 ms | 26311 ms | 29678 ms | CLIENT_TIMEOUT × 14 |
| `publications.get` | detail | 440 | 4 | 4819 ms | 19042 ms | 25106 ms | 27980 ms | CLIENT_TIMEOUT × 4 |
| `tasks.get` | detail | 732 | 48 | 5505 ms | 24226 ms | 27664 ms | 29911 ms | CLIENT_TIMEOUT × 48 |
| `exports.create` | heavy | 43 | 0 | 6138 ms | 18566 ms | 22449 ms | 22449 ms | — |
| `accounts.list` | list | 277 | 1 | 5238 ms | 24168 ms | 27682 ms | 29483 ms | CLIENT_TIMEOUT × 1 |
| `content.list` | list | 407 | 1 | 4756 ms | 23085 ms | 26106 ms | 27738 ms | CLIENT_TIMEOUT × 1 |
| `projects.list` | list | 274 | 1 | 4371 ms | 18031 ms | 27557 ms | 28007 ms | CLIENT_TIMEOUT × 1 |
| `publications.list` | list | 450 | 3 | 3759 ms | 23067 ms | 27760 ms | 29751 ms | CLIENT_TIMEOUT × 3 |
| `tasks.list` | list | 570 | 17 | 6005 ms | 24694 ms | 29469 ms | 29840 ms | CLIENT_TIMEOUT × 17 |
| `search.global` | search | 1,097 | 0 | 3847 ms | 20417 ms | 24876 ms | 29357 ms | — |
| `comments.create` | write | 228 | 0 | 4130 ms | 19662 ms | 23412 ms | 27262 ms | — |
| `tasks.create` | write | 248 | 0 | 4851 ms | 22877 ms | 26292 ms | 27457 ms | — |
| `tasks.transition` | write | 245 | 3 | 5611 ms | 22593 ms | 24685 ms | 25156 ms | VERSION_CONFLICT × 3 |
| `time.create` | write | 88 | 0 | 5541 ms | 20849 ms | 24656 ms | 24656 ms | — |

## Load profile

Open model: Poisson arrivals at the configured rates, dispatched whether or not earlier requests finished (50 concurrent
sessions of 10 roles; request sequence seeded with 170). Warm-up traffic is not recorded.

| Phase | Duration | Offered reads/s | Achieved reads/s | Offered writes/s | Achieved writes/s | Recorded |
|---|---|---|---|---|---|---|
| warmup | 30 s | 30 | 30.23 | 5 | 4.7 | no |
| steady | 120 s | 30 | 29.34 | 5 | 4.63 | 4,077 |
| burst | 30 s | 90 | 38.27 | 15 | 6.53 | 1,344 |
| cooldown | 30 s | 30 | 20.57 | 5 | 3.33 | 717 |

Dispatch lag p95 (scheduled → sent): 5 ms; highest number of requests in flight: 500; dropped at the in-flight cap: {"accounts.get":98,"time.create":31,"search.global":372,"publications.list":153,"publications.get":147,"projects.get":99,"tasks.list":233,"accounts.list":101,"content.list":151,"tasks.get":260,"comments.create":76,"tasks.create":106,"projects.list":90,"exports.create":15,"content.get":166,"tasks.transition":91,"analytics.dashboard":13}.

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
- Host load average (1 / 5 / 15 min): 3.37 / 3.54 / 4.51 when the load started, 7.33 / 6.19 / 5.41 when the run ended (the run itself contributes to it)
- Node.js v22.22.2; PostgreSQL 16.13 (Ubuntu 16.13-0ubuntu0.24.04.1); settings shared_buffers=512MB, work_mem=4MB, effective_cache_size=4GB, max_connections=400, random_page_cost=4, max_parallel_workers_per_gather=2, jit=on
- Database size after the run: 3.21 GiB
- Server under test: supplementary: two web processes of the same production build (commit 480b6b6), sessions spread over them, DATABASE_POOL_MAX=10 each; worker JOB_CONCURRENCY=4; NODE_ENV=production
- Target http://127.0.0.1:3200, http://127.0.0.1:3201 (2 web server process(es), sessions spread over them); the load generator ran on the same host

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
