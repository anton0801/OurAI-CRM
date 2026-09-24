# Castlane CRM — Engineering Conventions

This is the working contract for everyone (people and agents) adding code to this repository.
Read it fully before writing a module. The product specification lives in `docs/spec/` and is the
source of truth for behaviour; this document explains **how** behaviour is implemented here.

The Projects module (`organization`) and the media pipeline (`media`) are the reference
implementations. When in doubt, copy their structure.

---

## 1. Repository layout

```
apps/web                      Next.js 16 App Router (UI + REST API route handlers)
  app/api/v1/[...path]/route.ts   single catch-all → HTTP pipeline (do not add per-endpoint route files,
                                  except raw binary routes such as storage/fs/*)
  app/w/[workspaceId]/...     workspace pages (thin wrappers that render feature components)
  src/server/http/            pipeline.ts (auth, CSRF, MFA, idempotency, If-Match, envelope), router.ts
  src/server/handlers/        one file per module registering route handlers; index.ts imports them
  src/features/<module>/      client components of a module (screens, drawers, forms, tabs)
  src/components/             shared UI glue (shell, pickers, query-state, media uploader, conflict dialog)
  src/lib/                    api client, hooks, workspace context, url state, labels, live events, registries
apps/worker                   background worker: job runner, outbox dispatcher, scheduler, CLI (bootstrap)
packages/domain               pure, browser-safe domain code: enums, money/decimal, time, url, errors, state machines
packages/database             Drizzle schema (src/schema/*), migrations/, sql/pre|post (triggers), client, metric catalog
packages/authorization        permission catalog, role presets, access evaluator (can/listFilter/explain)
packages/application          use cases: core/ (context, command runner, access, audit, events, jobs, notify, search…)
                              and one folder per module (identity, organization, media, platform, …)
packages/api-contracts        zod endpoint definitions per module + registry (OpenAPI is generated from these)
packages/api-client           typed fetch client built from the contracts
packages/ui                   design tokens + accessible components (Radix primitives, Tailwind v4)
packages/analytics            semantic layer for metrics/reports (metric definitions, query engine)
packages/storage              object storage (S3 / filesystem) + malware scanner adapters
packages/notifications        mail transports + templates
packages/test-fixtures        data builders for tests and the opt-in demo fixture
tests/                        integration, security, e2e (Playwright), performance; tests/support = harness
docs/                         spec/, architecture/ (ADRs, this file), runbooks/, guides
```

## 2. Commands

```
pnpm install                       install
pnpm typecheck                     tsc over the whole monorepo (must be clean)
pnpm test:integration              vitest integration + security suites (real PostgreSQL, in-process HTTP)
pnpm test:unit                     unit tests (packages/*/src/**/*.test.ts)
pnpm db:generate                   generate a SQL migration after editing packages/database/src/schema/*
pnpm db:reset                      drop + recreate + migrate the DATABASE_URL database (dev only)
pnpm bootstrap:owner --email … --name "…"   one-time Owner creation
pnpm dev:web / pnpm dev:worker     run the app locally
```

Integration tests need PostgreSQL 16 on 127.0.0.1:5432 with role `castlane/castlane` (CREATEDB).
When several agents/people run tests at the same time on one machine, give each a unique template
and prefix: `TEST_TEMPLATE_DB=castlane_test_template_<name> TEST_DB_PREFIX=ct<name>_ pnpm test:integration`.

## 3. Layering rules

* `domain` is pure and browser-safe (no Node APIs, no DB). Put calculations here (money, formulas,
  state tables, recurrence, allocation) and unit-test them.
* `application` owns every rule and every write. HTTP handlers never touch the database directly and
  never re-implement rules. Worker jobs call application code too.
* `api-contracts` describes the wire format only (zod). Enums come from `@castlane/domain` — never
  re-type enum values.
* UI never decides authorization; it hides actions the member cannot use (`useCan`) as a courtesy.

## 4. Adding an endpoint (the full path)

1. **Contract** — `packages/api-contracts/src/<module>.ts`:
   ```ts
   export const widgetEndpoints = {
     create: endpoint({
       id: 'widgets.create',            // <module>.<action>; the id prefix is used for cache invalidation
       method: 'POST',
       path: '/workspaces/{workspaceId}/widgets',
       summary: '…', tags: ['Widgets'],
       auth: 'workspace',               // public | session | workspace
       permission: 'widgets.write',     // documented + used for idempotent replay checks
       idempotent: true,                // ALL creates, state commands, financial actions, uploads, imports
       ifMatch: false,                  // true for PATCH / commands on an existing versioned record
       params: wsId({}), body: z.object({...}), response: widgetDetail,
       successStatus: 201,
     }),
   };
   ```
   Add the group to `registry.ts` and export it from `index.ts`.
2. **Use case** — `packages/application/src/<module>/<file>.ts`. Queries take `QueryContext`,
   commands take `CommandContext` (always inside a transaction). Export from the module `index.ts`
   and add the module to `packages/application/src/index.ts`.
3. **Handler** — `apps/web/src/server/handlers/<module>.ts`:
   ```ts
   route(E.list, ({ ctx, input }) => listWidgets(ctx, input.query));
   route(E.create, ({ run, input }) => run(async (c) => getWidget(c, await createWidget(c, input.body))));
   ```
   `run()` executes the command transaction with idempotency bookkeeping. Build the response inside
   the same `run` (pass the `CommandContext` to the read function) so the stored idempotent
   response is consistent. Import the file from `handlers/index.ts`.
4. **UI** — `apps/web/src/features/<module>/…` + page wrapper under `app/w/[workspaceId]/…`.
5. **Tests** — `tests/integration/<module>/*.test.ts` through `TestClient` (see §12).

## 5. Authorization patterns (section 7 of the spec)

* Module-level list/create: `requirePermission(ctx, 'x.read')` → 403 when the member holds the
  permission nowhere.
* Object read: load the row, then `authorizeRead(ctx, 'x.read', scope)` → **404** when out of scope
  (existence is never revealed).
* Object action: `authorizeObject(ctx, 'x.update', scope, 'x.read')` → 404 if not readable, 403 if
  readable but the action is not allowed.
* Lists/counts/aggregates/search: put the scope into SQL **before** pagination and aggregation:
  `scopePredicate(ctx, 'tasks.read', { projectId: tasks.projectId, accountId: tasks.accountId,
  assigned: [tasks.assigneeMembershipId, tasks.reviewerMembershipId], ownerMembership: … })`.
* Scope object: `{ projectId, accountId, directionId?, assignedMembershipIds?, ownerMembershipId?,
  objectType, objectId }`. The evaluator resolves account → project → direction itself.
* Sensitive data (finance amounts, OFM contacts, restricted media, exports) needs its own
  permission even when the record is otherwise readable. **Omit** the field from the response (not
  `null`) when the member lacks it (see `budget` on projects).
* Never trust ids from the client: every referenced row is loaded inside the workspace
  (`findById`/`lockById` filter by `workspace_id`) and composite tenant FKs back this up.
* Critical actions (permissions, finance posting, MFA, backup/download-sensitive) call
  `requireRecentAuth(ctx)` (≤ 15 min).
* Assignments that change what a member can see (project team, account assignment, OFM assignment,
  role grants) must `UPDATE memberships SET access_revision = access_revision + 1` for that member.

## 6. Writing commands

Inside a command:

```ts
const row = await lockById(ctx, widgets, id, 'Widget');      // SELECT … FOR UPDATE in workspace, 404
authorizeObject(ctx, 'widgets.update', scopeOf(row), 'widgets.read');
assertVersion(ctx, row);                                        // If-Match → 428 missing / 412 stale
assertTransition(WIDGET_TRANSITIONS, row.status, input.target); // 409 INVALID_STATE
const [updated] = await ctx.tx.update(widgets).set({ …, ...touch(ctx, widgets) }).where(eq(widgets.id, id)).returning();
await audit(ctx, { action: 'widget.updated', entityType: 'widget', entityId: id, projectId, diff: diffFields(row, updated, [...]) });
await emit(ctx, { type: 'widget.updated', entityType: 'widget', entityId: id, revision: updated.rowVersion });
await indexSearchDocument(ctx.tx, { … });                      // if the entity is searchable
```

Rules:

* New rows: `{ ...stamp(ctx), id: newId(), … }`.
* **Never run `Promise.all` over queries on `ctx.tx`** (one connection). Use `all(ctx, [() => …])`
  which is sequential in a transaction and parallel on the pool. Use `dbOf(ctx)` in read functions
  that can be called from both queries and commands.
* Uniqueness that protects money, publications, entitlements, occurrences, sources, etc. must be a
  **database unique constraint** (partial unique index where needed), not only a pre-check. The
  command runner maps `23505` to `409 DUPLICATE`.
* Status strings are never PATCHed directly: use a transition command backed by a
  `TransitionTable`.
* History is append-only: status events, revisions, reversal documents, superseded rows. Posted
  finance lines, approved versions, audit rows are immutable (triggers in `packages/database/sql/post`).
* Reasons: required where the spec says so (`reason` schema: 3–2000 chars).
* Validation errors: throw `AppError('VALIDATION_FAILED', msg, { fieldErrors: [{ field, code, message }] })`
  so the UI maps them to fields. Domain conflicts: `INVALID_STATE` with `details` the UI can show.
* Time comes from `ctx.app.clock.now()` only (tests move it). Never `new Date()` for business time.
* Money: `bigint` minor units in the DB (`minor()` column), decimal strings on the wire
  (`{ amount: "12.50", currency: "EUR" }`), conversion with `parseAmountToMinor` / `formatMinor` /
  `convertMinor` / `allocateLargestRemainder` from `@castlane/domain`. Never floats.
* Decimals (rates, percents, metric values): `numeric` columns read as strings; math with `big.js`
  helpers in `@castlane/domain/decimal`.
* Missing data is `null` with an explicit availability — never coerce unknown to 0.

## 7. Queries and read models

* Return plain JSON: ISO strings for timestamps (`.toISOString()`), `YYYY-MM-DD` for dates, strings
  for money/decimals, numbers for counts. Include `rowVersion` on every editable detail/row (the UI
  sends it as If-Match; GET detail responses automatically get an `ETag`).
* People: `loadMemberRefs(db, workspaceId, ids)` → `{ membershipId, displayName, avatarUrl, former }`.
* Keyset pagination: `{ items, nextCursor, hasMore }` with `encodeCursor/decodeCursor`, stable
  order `(sortColumn, id)`, `clampPageSize` (default 50, max 200). See `listProjects`.
* Detail responses include a `permissions` object (booleans for the actions the UI may offer).

## 8. Events, jobs, notifications, search

* `emit(ctx, {...})` writes the transactional outbox + the SSE change feed. Payloads contain ids and
  state names only.
* Background work: `defineJob('module.action', pool, handler)` in the module (import side effects from
  the module `index.ts`, and add the module to `packages/application/src/register-all.ts`). Enqueue
  with `enqueueJob(ctx.tx, { type, workspaceId, payload, idempotencyKey })` inside the command.
  Pools: `light` (mail, notifications, reminders), `data` (imports, exports, reports), `media`.
  Job handlers must be idempotent (at-least-once) and use `memberJobContext`/`systemJobContext`.
* Outbox consumers: `defineConsumer({ name, events, handle(tx, event, app) })` — idempotent; usually
  enqueue a job keyed by `${name}:${event.id}`.
* Periodic work: `defineSchedule({ name, everySeconds, jobType })` — the scheduler enqueues once per
  time bucket.
* In-app notifications: `notify(ctx.tx, { workspaceId, recipientMembershipIds, eventType, eventKey,
  kind, title, excerpt, entityType, entityId, projectId, actorMembershipId, at })`. `eventKey` must be
  deterministic (e.g. `review.requested:${reviewId}`) so repeats never duplicate. Never put amounts,
  OFM aliases or restricted text in title/excerpt (`sensitive: true` drops the excerpt).
* Search: `indexSearchDocument(ctx.tx, {...permission: 'x.read', projectId, accountId, assigneeMembershipIds, ownerMembershipId, restricted, archived})`
  whenever a searchable entity is created/renamed/archived. Add the entity's route to
  `packages/api-contracts/src/links.ts` (`ENTITY_ROUTES`) if missing.

## 9. Registries modules plug into

| Registry | Where | Purpose |
|---|---|---|
| `defineArchiveHandler` | application/core/archive-registry | archive preview/archive/restore/trash per entity type (generic Archive screen) |
| `defineLinkAccess` | application/media/link-access | who may see files attached to your entity type |
| `registerProjectTab` | web/src/lib/project-tabs | tabs in the Project workspace (S15); import from `src/features/project-tabs.ts` |
| `NAV`, `QUICK_CREATE` | web/src/components/shell/nav.ts | sidebar + quick create (already lists all modules) |
| `ENTITY_ROUTES` | api-contracts/src/links.ts | deep links for search, inbox, audit, activity |
| `PREFIXES` | web/src/lib/live-events.ts | which cached queries refresh when an entity type changes |
| `ENDPOINT_GROUPS` | api-contracts/src/registry.ts | OpenAPI + contract tests |
| `defineJob/defineConsumer/defineSchedule` | application/core/jobs-registry | background work |
| `defineLookup` | application/core/lookup-registry | picker search for an entity type (`LOOKUP_TYPES` in api-contracts/src/lookup.ts); UI: `EntitySelect` / `MultiEntitySelect` from `components/common/entity-select` |
| `defineResponsibilityProvider` | application/core/responsibility-registry | open work a member holds; listed and transferred when a member is deactivated (F12) |
| `defineImportDataset` | application/core/import-registry | Import Center dataset (columns, row validation, apply, undo) |
| `defineExportDataset` | application/core/export-registry | Export Center dataset (columns, permission-scoped rows as of a boundary) |
| slots (`ACCOUNT_TABS`, `MY_WORK_SECTIONS`, `MEMBER_TABS`, `CHARACTER_PANELS`, `EPISODE_PANELS`, `CAMPAIGN_TABS`, `DEAL_PANELS`) | web/src/lib/slots.ts | one module's screen shows another module's records; register in `features/<module>/register-slots.ts` and add one import line to `features/slots.ts` |
| `registerLabels` | web/src/lib/labels.ts | enum label dictionaries per module (call from the module's `features/<module>/labels.ts`) |

Barrel/registry files (`packages/application/src/index.ts`, `register-all.ts`, `core/index.ts`,
`api-contracts/src/index.ts`, `registry.ts`, `server/handlers/index.ts`, `features/slots.ts`,
`features/project-tabs.ts`) use git union merge (`.gitattributes`): only **append one line per
module**, never reorder or rewrite existing lines.

## 10. UI conventions

* Use `@castlane/ui` components only (no other UI kit). Spacing tokens 4…48; radius 6/8/12/16.
  Colours through Tailwind token classes (`bg-surface`, `text-fg-2`, `border-line`, `bg-primary`,
  `text-danger`, …). Never hard-code hex colours in features.
* Page structure: `PageHeader` (breadcrumbs, title, description, ≤ 2 primary actions + `Menu` "More"),
  optional `Tabs` (state in URL `?tab=`), `Toolbar` (filters in URL via `useUrlState`), content.
* Data: `useApiQuery(endpoint, input)`, `useApiInfinite` for cursor lists ("Load More"),
  `useApiMutation(endpoint, { invalidate: ['module.'], successMessage })` — it reuses the
  Idempotency-Key for retries. Pass `{ ifMatch: row.rowVersion }` for edits. Wrap query-driven
  sections in `<QueryState query={q}>` (skeleton / 403 / 404 / error+Retry).
* Forms: react-hook-form + zod (`@hookform/resolvers/zod`), `Field` around every control (label on
  top, helper/error below; the Field wires ids/aria automatically, also through `Controller`).
  On submit: map `fieldErrors` with `applyFieldErrors`; on `VERSION_CONFLICT` open `ConflictDialog`
  and keep the user's input. Close a drawer only after the server confirmed the save.
  Drawers/dialogs get `dirty` so closing with unsaved changes asks "Discard Changes / Keep Editing".
* Pickers: `MemberSelect`, `MultiMemberSelect`, `DirectionSelect` in `components/common/pickers`;
  every other entity uses `<EntitySelect type="account" filters={{ projectId }} …/>` /
  `MultiEntitySelect` (server-searched, scope-filtered). The module that owns the entity registers
  its `defineLookup` provider (see `organization/lookups.ts`).
* Files: `FileUploader` / `useUpload` / `AssetThumb` from `components/media`. Never show a public
  object URL; use the authorised thumbnail/download endpoints.
* Tables: `DataTable` (sticky first column, right-aligned numbers, selection with "Select All
  Matching", Load More). Empty states: `EmptyState` with a concrete CTA (if permitted) or
  `NoResults` with Clear Filters.
* Every screen handles: Initial Loading, Empty, No Filter Results, Permission Denied (403), Not Found
  (404), Network Error, Saving, Validation Error, Conflict, Success (toast only after server success).
* Microcopy: use the exact English strings from spec §31.2 where they apply (e.g. "No data recorded
  for this period.", "Account links do not import statistics or publish content.", "Record Payment",
  "This records a payment already made. It does not transfer money.").
* Labels for enum values: `label(group, key)` in `src/lib/labels.ts` (extend the dictionary) or
  `humanize()`; status chips: `StatusBadge`.
* Dates: show with the member's timezone (`useWorkspace().user.timezone`), always make the zone
  visible for scheduling inputs (`DateTimeInput timezone=…`). Date-only values are calendar days.
* Accessibility: every icon-only button has a label; keyboard alternatives for drag & drop (Move to
  menus); colour is never the only signal; touch targets ≥ 44 px on mobile; no horizontal page
  scroll at 360 px (tables scroll inside their container).
* No decorative imagery, fake numbers, fake presence, lorem ipsum, TODO buttons or dead actions. If a
  control is visible it works end-to-end.
* Business data never goes to localStorage/sessionStorage (UI preferences only).

## 11. Schema changes

* Edit `packages/database/src/schema/<area>.ts`. Every tenant table spreads `tenantBase()` (id,
  workspace_id, created/updated at/by, row_version), exposes `tenantUnique('<table>', t)` and links
  other tenant tables with `tfk(name, t.workspaceId, t.refId, refTable)`.
* Enum columns: values in `packages/domain/src/enums.ts`, `enumText(...)` + `enumCheck(...)`.
* Then `pnpm db:generate` and commit the new migration file. (Before the first production release
  the integration lead squashes migrations into one initial migration.)
* Triggers/functions that must survive regeneration go to `packages/database/sql/post/*.sql`
  (idempotent `CREATE OR REPLACE` / `DROP TRIGGER IF EXISTS`).

## 12. Testing

* Integration tests run the **real** HTTP pipeline in-process:
  ```ts
  const ws = await createWorkspace(db());                                  // owner + preset roles
  const owner = await clientFor(await sessionFor(db(), ws.owner.userId));  // signed in, MFA verified
  const lead = await addMember(db(), ws, { roleKey: 'project_lead', scopeType: 'assigned_projects' });
  await assignToProject(db(), ws, projectId, lead.membershipId);
  const r = await owner.attempt(widgetEndpoints.create, { params: {...}, body: {...} });
  expect(r.status).toBe(201);
  ```
  `call()` throws `ApiError` on failure; `attempt()` returns `{ ok, status, code, data }`.
  Use explicit `idempotencyKey` / `ifMatch` to test replays and conflicts.
* Background jobs: `await runQueuedJobs(['module.job'])`. Time: `setClock('2026-10-01T10:00:00Z')`
  / `mutableClock(...)`; always `resetClock()` in `afterEach` when you move time.
* Name tests after the spec acceptance ids they cover (e.g. `(T065)`), and cover: scope isolation
  (404/403), idempotent replay, If-Match conflict, state transition guards, the domain formulas, and
  "unknown ≠ 0" behaviour.
* Pure logic gets unit tests next to the code (`*.test.ts`), property-based where it protects money
  or graphs (`fast-check`).

## 13. Things that are never done

* No calls to Instagram/TikTok/OnlyFans/Fansly/Dramora or any other external platform API; no OAuth
  of social networks; no scraping; no server-side fetch of user URLs; no autoposting.
* No automatic approval, posting/reversal of finance, role changes, deletions or external messages by
  automations.
* No bank transfers — "Record Payment" records a payment that already happened.
* No generic DELETE for finance, history, approved versions or audit.
* No demo data in production; fixtures are opt-in.
