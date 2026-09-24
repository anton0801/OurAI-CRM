# ADR 0003 — Access control model

Status: accepted (2026-09-24)

## Context
§7 defines roles as presets of permissions with scopes (workspace, direction, project, account,
assigned projects/accounts, assigned object, own records), explicit denials, sensitive permissions
(finance, OFM contacts, restricted media, exports) and the rule that out-of-scope objects are
indistinguishable from non-existent ones.

## Decision
* A fixed permission catalog (`packages/authorization/src/permissions.ts`) — the code never checks
  role names, only permissions.
* Role presets are copied into each workspace at creation and can be customised; a membership has
  role grants with a scope plus optional direct permission grants/denials. Deny wins.
* On each request an `AccessSnapshot` is loaded (grants + project/account/assignment sets) and
  evaluated in memory: `can(permission, scope)`, `hasAnywhere`, `listFilter(permission)`,
  `explain` (used by the "Explain Access" UI).
* Lists, counts, aggregates, search and exports translate `listFilter` into SQL predicates **before**
  pagination/aggregation, so totals never leak hidden rows.
* Object requests out of scope return 404; module access without the permission returns 403.
* Every change that alters visibility bumps `memberships.access_revision`; sessions and cached
  snapshots are invalidated, and SSE streams re-check membership.
* Sensitive fields are omitted from responses (not nulled) when the permission is missing.

## Consequences
Authorization logic is centralised and unit-testable; module code only declares the scope of an
object. Adding a permission requires updating the catalog, presets and the Settings UI grouping.
