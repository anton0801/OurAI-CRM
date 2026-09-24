# Deploy, upgrade and rollback

## Artifacts
* `castlane-web` — Next.js standalone server (UI + `/api/v1`), `infra/docker/web.Dockerfile`.
* `castlane-worker` — background worker and one-shot CLIs (`dist/cli/migrate.js`,
  `dist/cli/bootstrap-owner.js`), `infra/docker/worker.Dockerfile`.
Both images are built from the same commit and tagged with the same version (`CASTLANE_VERSION`).
Images run as a non-root user, have health checks and stop gracefully on SIGTERM (the worker stops
claiming jobs and lets running ones finish or return to the queue by lease expiry).

## First installation (reference: `infra/docker-compose.yml`)
1. Provision: PostgreSQL 16 (WAL archiving / PITR enabled), a private S3 bucket **with versioning**
   (or the bundled store: `--profile local-s3`), SMTP relay, a host name with DNS → this host.
2. `cp infra/.env.compose.example infra/.env.compose` and fill every value. Generate secrets with
   `openssl rand -base64 48` (different values for SESSION_SECRET and MFA_ENCRYPTION_KEY, and for
   every environment). Keep a sealed copy of MFA_ENCRYPTION_KEY: without it TOTP secrets cannot be
   decrypted after a restore.
3. Build and start: `docker compose -f infra/docker-compose.yml --env-file infra/.env.compose up -d --build`
   (the application refuses to start in production with development secrets, http origin, the
   development scanner or the development mail sink).
4. Migrate: `docker compose … run --rm migrate` (idempotent; takes an advisory lock, applies SQL
   migrations, triggers and the system metric catalogue).
5. Bootstrap the first Owner **once**:
   `docker compose … run --rm worker node dist/cli/bootstrap-owner.js --email owner@company.example --name "Owner Name"`.
   The command prints a temporary password once; the Owner must change it and set up MFA at first
   sign-in (F01). A second run is refused.
6. Open `https://<host>/`, complete Workspace Setup (name, timezone, base currency, directions,
   invitations). No demo data exists; `pnpm fixtures:load` is for local demos only and refuses
   production.
7. Schedule `infra/backup/backup-db.sh` daily and `infra/backup/restore-drill.sh` monthly
   (see backup-restore.md) and connect alerts (monitoring.md).

Local production-like stack: `infra/docker-compose.local.yml` (HTTPS on https://localhost:8443,
Mailpit on http://localhost:8025).

## Upgrade
1. Read the release notes for migrations. Migrations follow expand → migrate → contract: a release
   only adds compatible schema; destructive steps ship in a later release after data is migrated.
2. Take an on-demand backup (`infra/backup/backup-db.sh`) and note the time (recovery point).
3. Build/pull the new images. Run `migrate` with the new worker image **before** starting new web
   and worker containers. If the migration fails the transaction rolls back and the old version
   keeps running — do not start the new containers.
4. `docker compose … up -d web-1 web-2 web-3 worker`. To keep serving during the upgrade, restart the
   web services one at a time (`up -d --no-deps web-1`, wait until it is healthy, then `web-2`,
   `web-3`); Caddy's health checks keep traffic away from a restarting process. On orchestrators:
   web pods behind a readiness probe on `/api/v1/health/ready`.
5. Smoke test: sign in, open Overview/My Work, upload a small image, check System Health (queue,
   outbox lag, last backup).

## Scaling the web tier
The web server (UI and `/api/v1`) is one Node.js process that uses one CPU core. The reference
deployment runs **three** web processes (`web-1`, `web-2` and `web-3` in `infra/docker-compose.yml`)
behind Caddy (`infra/caddy/Caddyfile`):

* Caddy balances across them. A sticky cookie (`castlane_upstream`) keeps a browser on one process.
* Active health checks on `/api/v1/health/ready` take a process out of rotation while it is down or
  cannot reach the database, and a request is retried on another process for up to 5 s.
* To add a process, copy the `web-3: *web` line to `web-4: *web` and add `web-4:3000` to the
  `reverse_proxy` line.
* Size PostgreSQL connections for all processes: each web process and the worker open up to
  `DATABASE_POOL_MAX` (default 10) connections.

Measured capacity is in `docs/acceptance/performance-report.md`. It was measured on a 4-vCPU
development container, not on staging, so repeat the run on staging to size production. There,
one request of the §28.3 mix cost about 16 ms of web CPU and 22 ms of PostgreSQL backend CPU. The
steady load of the §28.3 profile (30 reads/s and 5 writes/s) used about half of the container.
The ×3 burst (105 requests/s) needs about 1.6 cores of web processes and 2.3 cores of PostgreSQL
backends, plus the worker and PostgreSQL's own background work. Plan at least three web processes,
give PostgreSQL its own cores (four or more) and run the worker separately.

State held inside a web process:

* **API rate limits** (`RATE_LIMIT_*_PER_MIN`) are token buckets per process. With N processes a
  member can in theory use N× the budget. The sticky cookie keeps each member on one process, so in
  practice the limits apply per member as with one process; a member who fails over starts with a
  full bucket. Sign-in, MFA and password-reset limits are stored in PostgreSQL and shared by all
  processes.
* **Access snapshot cache** (`ACCESS_CACHE_TTL_MS`, default 30 s). Each process caches members'
  grants and the workspace structure, keyed by a revision that database triggers bump in the same
  transaction as every change to grants, teams, assignments, roles and projects/accounts. A change
  made through any process therefore applies to the next request on every process.
* Nothing else: sessions, idempotency records, jobs, the event stream, uploads (S3) and the analytics
  read model all live in PostgreSQL or object storage.

**Analytics read model.** Dashboards are served from `analytics_dashboard_snapshots`:

* A dashboard is computed once per tab, filter set, access scope and time zone.
* Any change in the workspace marks its dashboards stale. The worker recomputes a stale dashboard
  that is still in use after `ANALYTICS_SNAPSHOT_MIN_REFRESH_SECONDS` (default 300), and every
  dashboard at least every `ANALYTICS_SNAPSHOT_MAX_AGE_SECONDS` (default 21600) or when its period
  rolls over.
* Members see the age of the figures and can press "Recalculate now". Each recomputation costs a
  few seconds of worker CPU at the §28.3 volumes. In a very large workspace with many distinct
  scopes, raise the minimum interval if the worker cannot keep up; the Queue lag view in System
  Health shows it.

## Rollback
* Application-only rollback (no migration in the release, or an expand-only migration): redeploy the
  previous image tag for web and worker. Old code runs against the expanded schema.
* A release whose migration is not backward compatible cannot be rolled back by image: fix forward,
  or restore the database to the recovery point taken in step 2 (backup-restore.md → Disaster
  recovery). Data written after the recovery point is lost; tell users before doing this.
* Never edit `packages/database/migrations` in place after it ran anywhere; add a new migration.

## Configuration reference
`.env.example` documents every variable. Required in production: APP_ORIGIN (https), DATABASE_URL
(least-privilege role, see `infra/postgres/init/001-app-role.sh`), SESSION_SECRET,
MFA_ENCRYPTION_KEY, STORAGE_* (S3), SCANNER_MODE=clamd + CLAMD_HOST/PORT, MAIL_TRANSPORT=smtp,
TRUST_PROXY=true only behind the proxy that sets X-Forwarded-For. The SMTP server comes from SMTP_*
or is entered by the Owner in Settings → Workspace → Mail (encrypted with SECRETS_ENCRYPTION_KEY,
falling back to MFA_ENCRYPTION_KEY; set a separate random value).
