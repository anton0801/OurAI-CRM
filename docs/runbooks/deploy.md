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
4. `docker compose … up -d web worker` (rolling on orchestrators: web pods behind a readiness probe
   on `/api/v1/health/ready`).
5. Smoke test: sign in, open Overview/My Work, upload a small image, check System Health (queue,
   outbox lag, last backup).

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
