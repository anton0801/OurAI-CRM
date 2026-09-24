# Castlane CRM

Internal CRM for a studio that produces AI series, develops AI models and AI influencers, runs
their accounts and content, and coordinates OFM operations. One shared data model covers projects,
people and access, production and reviews, tasks and time, publications and campaigns, metrics and
reports, OFM shifts, and management finance (income, expenses, budgets, compensation, recorded
payments).

The product specification is in [`docs/spec/`](docs/spec/00-overview.md). How the system is built
is in [`docs/architecture/`](docs/architecture/conventions.md). Operating it is covered in
[`docs/runbooks/`](docs/runbooks/README.md), and using it in [`docs/guides/`](docs/guides/).

What the system deliberately does **not** do: log in to Instagram/TikTok/OnlyFans or any other
platform, scrape, autopost or read platform messages; call Dramora; move money (payments are
recorded, not sent); generate content. Account links are stored as links only.

## Version matrix

| Component | Version |
|---|---|
| Node.js | 22.x LTS (`.nvmrc`) |
| pnpm | 10.33.0 |
| TypeScript | 5.9.3 (strict) |
| Next.js / React | 16.3.6 / 19.3.0 (App Router) |
| PostgreSQL | 16 |
| Drizzle ORM | 0.45.3 |
| zod | 4.6.5 |
| Tailwind CSS | 4.3.3 |
| TanStack Query | 5.103.2 |
| Vitest / Playwright | 5.0.1 / 1.63.0 |

Exact versions are pinned in `package.json` files and `pnpm-lock.yaml`.

## Repository layout

```
apps/web                 Next.js app: UI (App Router) + REST API (/api/v1, one contract-driven router)
apps/worker              background worker: job pools, transactional outbox, scheduler, CLIs
packages/domain          pure rules: money/decimal, time, URLs, enums, state machines, errors
packages/database        Drizzle schema, SQL migrations, triggers (append-only audit, immutable finance)
packages/authorization   permission catalogue, role presets, scoped access evaluator
packages/application     use cases per module (the only place that writes data)
packages/api-contracts   zod endpoint contracts → server validation, typed client, OpenAPI
packages/api-client      typed fetch client
packages/analytics       metric values with explicit availability, formulas, periods
packages/ui              design tokens and accessible components
packages/storage         S3 / filesystem storage, ClamAV scanner adapters
packages/notifications   SMTP / development mail transports, templates
packages/test-fixtures   builders for tests and the opt-in demo data set
tests/                   integration, security, e2e, performance suites
infra/                   Dockerfiles, compose stacks, Caddy, backup scripts
docs/                    spec, architecture (ADRs), runbooks, guides, API (OpenAPI), acceptance report
```

## Local development

Prerequisites: Node 22, pnpm 10, PostgreSQL 16 with a role that can create databases; for the
backup/restore-drill test also `pg_dump`/`psql` 16 and [`age`](https://age-encryption.org).

```bash
pnpm install
createuser -s castlane && psql -c "ALTER ROLE castlane PASSWORD 'castlane'"   # once, or use your own role
createdb -O castlane castlane_dev
cp .env.example .env               # development defaults: filesystem storage, mail sink, no scanner
pnpm db:migrate                    # schema, triggers, metric catalogue
pnpm bootstrap:owner --email you@example.com --name "Your Name"   # prints a one-time temporary password
pnpm dev                           # web on http://localhost:3000 + worker
```

Sign in with the temporary password: you will change it, set up two-factor authentication, save
recovery codes and complete the three setup steps (workspace, directions, invitations). The
workspace starts empty — no demo projects, fake numbers or default passwords.

Optional demo data for a local walkthrough (refuses to run against production):
`pnpm fixtures:load --workspace <workspaceId>`.

A production-like local stack (HTTPS via Caddy, S3-compatible storage, ClamAV, Mailpit) is in
`infra/docker-compose.local.yml`.

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | web + worker in watch mode |
| `pnpm typecheck` | TypeScript over the whole monorepo |
| `pnpm test:unit` | unit and property-based tests |
| `pnpm test:integration` | integration + security tests against real PostgreSQL (in-process HTTP pipeline) |
| `pnpm test:e2e` | Playwright end-to-end tests (starts its own web + worker on an isolated database) |
| `pnpm build` | production build of web (standalone) and worker (bundle) |
| `pnpm db:generate` | new SQL migration after a schema change |
| `pnpm db:migrate` / `pnpm db:reset` | apply migrations / recreate the development database |
| `pnpm bootstrap:owner` | one-time creation of the first Owner (refused afterwards) |
| `pnpm openapi:generate` | regenerate `docs/api/openapi.json` from the contracts (`--check` in CI) |
| `pnpm fixtures:load` | opt-in demo data (never in production) |
| `pnpm tombstones:replay` | disaster restore: re-apply purges/erasures from the storage journal (`--since`, `--dry-run`) |

Integration tests need PostgreSQL on 127.0.0.1:5432 with role `castlane/castlane` (CREATEDB);
override with `TEST_DATABASE_ADMIN_URL`.

## Deployment

See [`docs/runbooks/deploy.md`](docs/runbooks/deploy.md): two images (web, worker), one-shot
migrations, first-Owner bootstrap, TLS proxy, S3 bucket with versioning, ClamAV, SMTP, backups
and monthly restore drills ([`backup-restore.md`](docs/runbooks/backup-restore.md)). Production
configuration is validated at startup (HTTPS origin, real secrets, scanner and SMTP required).

## Security model (short)

Own identity (Argon2id, TOTP MFA with recovery codes, opaque server sessions, CSRF protection),
invitation-only membership, permission catalogue with scoped grants evaluated on the server
(out-of-scope objects are indistinguishable from missing ones), sensitive data (finance, OFM
contacts, restricted media, exports) behind separate permissions, idempotency keys and row
versions on every write, append-only audit. Details: ADRs 0002, 0003, 0010.
