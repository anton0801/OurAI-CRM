# Load profile harness (spec §28.3, acceptance T170)

Measures the staging load profile of spec §28.3 against a synthetic database with the spec data volumes
and writes the measurement report `docs/acceptance/performance-report.md` (raw numbers in
`docs/acceptance/performance-results.json`).

| Script | What it does |
|---|---|
| `pnpm perf:seed` | Creates the dedicated load database (default `castlane_perf`), applies all migrations and seeds one workspace with the §28.3 volumes × `--scale`. |
| `pnpm perf:stack` | Starts the production build of the web app (Next.js standalone server, as in `infra/docker/web.Dockerfile`) and the worker against the load database, with `NODE_ENV=production`. |
| `pnpm perf:run` | Drives the load profile against a running server, samples queue lag, reads job/outbox completion latencies and writes the report. |
| `pnpm perf:report` | Re-renders the Markdown report from an existing results JSON. |

## Quick start (local)

```bash
pnpm install
pnpm perf:seed --scale 1                              # ≈ 9 min on 4 vCPUs, 3.1 GiB
NEXT_DIST_DIR=.next-perf pnpm --filter @castlane/web build
pnpm perf:stack                                       # keep running; web on http://127.0.0.1:3200
pnpm perf:run --server-note "local: standalone web + worker, NODE_ENV=production, pool 10"
```

The runner expects a server that is already running. `perf:stack` writes logs and export files to `var/perf/`.
Stop it with Ctrl-C. `perf:stack --web-instances 2` starts two web processes on consecutive ports. Pass both URLs to
the runner (`--base-url http://127.0.0.1:3200,http://127.0.0.1:3201`), and each session sticks to one of them.
`--web-node-args "--cpu-prof --cpu-prof-dir=var/perf/prof"` profiles the web processes.

## Synthetic data (`seed.ts`)

- **Volumes at scale 1:** 200 members, 1 000 projects (10 directions), 5 000 accounts, 100 000 content items, 300 000
  publications, 500 000 tasks, ≈ 2 000 000 metric values and 300 000 financial lines. The seed also writes the rows
  that make these usable: role assignments, project teams, account assignments, task status events, content stage
  events, metric observations, posted financial entries with allocations, and search documents built the same way as
  the application's index functions.
- **Access patterns:** the members hold these roles: Owner, Admin, Direction Lead (direction scope), Project Lead,
  Producer and Creator (assigned projects), Publisher (assigned accounts), Analyst, Finance Manager and Viewer. Each
  project has a lead, a producer and two creators. Each account has one publisher. Scoped lists therefore return
  realistic subsets.
- **History:** two years of activity. 78 % of tasks are done, 7 % are cancelled and 15 % are open. Most historical
  content is approved and published, and open work sits in the last four months. Publications carry 24-hour checkpoint observations (six values). Some also carry 7-day
  observations, and accounts carry weekly follower snapshots, so the 90-day analytics have real data to read.
- **Generation:** every row is produced in PostgreSQL with `INSERT … SELECT generate_series(…)` in batches.
  Deterministic helper functions in a scratch schema derive UUIDs and pseudo-random values from row indexes, so
  foreign keys resolve by arithmetic. The scratch schema is dropped at the end. The seed disables no constraints or
  triggers. Financial entries are inserted as drafts, get their lines and allocations, and are then posted, because
  posted documents are immutable. The seed finishes with `VACUUM (ANALYZE)` and stores a manifest (counts, scale,
  role ranges) in `system_state` under the key `perf_seed_manifest`.
- **Safety:** the seed drops and recreates the target database. It refuses to run when the host is not local, when
  `NODE_ENV=production`, or when the database name does not contain `perf`. To override this for a dedicated
  staging load database, pass `--i-know-this-is-not-production`. Never point the seed at a production server.

Options: `--scale <0..1>` (default 1), `--database <name>` (default `castlane_perf`), `--admin-url <postgres url>`
(default `postgres://castlane:castlane@127.0.0.1:5432/postgres`, or `PERF_ADMIN_URL`).

## Load profile (`run.ts`)

- **Sessions:** 50 concurrent sessions of 10 roles (1 Owner, 2 Admins, 5 Direction Leads, 10 Project Leads,
  8 Producers, 10 Creators, 7 Publishers, 4 Analysts, 2 Finance Managers, 1 Viewer). Sessions are minted directly in
  the database, as the test fixtures do, and are MFA-verified. Each session loads its CSRF token from `/auth/me` like
  the browser does.
- **Open model:** Poisson arrivals at 30 reads/s and 5 writes/s during a warm-up that is not recorded (30 s) and the
  steady state (120 s), then 90 reads/s and 15 writes/s during the burst (30 s), then a recorded cool-down (30 s).
  Requests are dispatched on schedule whether or not earlier requests have finished, so a slow server shows up as
  latency rather than as a lower offered load. A cap on requests in flight (500) protects the load generator itself.
  Anything dropped at the cap is reported.
- **Mix:**
  - Lists (tasks, projects, accounts, content, publications) with filters and sorting. 20 % of list views continue
    to the next page.
  - Detail views of records the session saw in its lists.
  - Global search: single words, word pairs, project names and 4-letter prefixes.
  - 90-day analytics dashboards (production, content, accounts, with comparison). The usage model: each active member
    opens a dashboard about every five minutes, which is ≈ 0.17/s or 0.55 % of reads.
  - Critical writes: create task, status transition with `If-Match`, comment, time entry.
  - A heavy request: a CSV export of one project's tasks, which returns 202 with a job.
  - Writes send `Origin`, `X-CSRF-Token`, `Idempotency-Key` and `If-Match` like the browser client. Media transfer is
    excluded, as §28.3 requires.
- **Unloaded service time:** before the load, the runner sends a few sequential requests per operation
  (`--service-samples`, default 5). The report lists them as each endpoint's latency without queueing.
- **Queue lag:** every 2 s the runner samples the age of the oldest due queued job and of the oldest undispatched
  outbox event, the backlog sizes and the host CPU. After the load it waits for the queues to drain, then reads the
  completion latency of every job, outbox event and export created in the measured window.
- **Thresholds (p95, all measured phases):**
  - API list and detail ≤ 500 ms
  - Critical writes ≤ 800 ms
  - Search ≤ 700 ms
  - 90-day analytics ≤ 2 s
  - Heavy request returns its job ≤ 1 s

  A class also fails when more than 1 % of its requests return an error.

Options: `--base-url` (default `http://127.0.0.1:3200`), `--origin` (the server's `APP_ORIGIN`, default
`https://perf.castlane.invalid`), `--database-url` (the load database, used for sessions and queue sampling),
`--sessions`, `--reads`, `--writes`, `--burst-factor`, `--warmup`, `--steady`, `--burst`, `--cooldown` (seconds),
`--max-in-flight`, `--timeout-ms`, `--drain`, `--seed` (request sequence), `--service-samples`, `--server-note` (free
text for the report) and `--out` (default `docs/acceptance`). For a supplementary run, `--exclude <op,…>` leaves
operations out of the mix and `--label <name>` writes `performance-report-<name>.md` instead of the main report.

The main report ends with an Analysis section. Its numbers are computed from the run and from any supplementary
results (`performance-results-<label>.json`) in the same folder. The fixes and recommendations come from
`tests/performance/findings.ts`. Run `pnpm perf:report` to re-render the main report after a supplementary run.

## Production configuration of the local stack

`perf:stack` runs with `NODE_ENV=production`, so the production configuration validation stays on. It supplies the
values that validation demands:

- `APP_ORIGIN` is an https placeholder. The runner sends it as `Origin` and talks plain HTTP to the port, because no
  TLS proxy runs locally.
- Secrets are random for each start.
- `SCANNER_MODE=clamd` and `MAIL_TRANSPORT=smtp` point at 127.0.0.1. The profile uploads no media and sends no mail.
- Export files go to filesystem storage.
- `DATABASE_POOL_MAX` defaults to 10 and `JOB_CONCURRENCY` to 4, the same as the reference deployment in
  `infra/docker-compose.yml`. Override them through the environment.

## Staging

The staging run follows the same steps with the staging configuration:

1. Seed a dedicated load database on the staging PostgreSQL. Pass `--admin-url` and `--i-know-this-is-not-production`.
2. Run the web and worker images against it.
3. Run `pnpm perf:run` with `--base-url`, `--origin` and `--database-url` pointing at staging, and describe the
   instance sizes in `--server-note`.

Commit the regenerated report and JSON.
