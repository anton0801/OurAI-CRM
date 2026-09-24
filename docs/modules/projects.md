# Projects (S12–S15)

Code: `packages/application/src/organization/`, contracts `organization.ts`, UI `apps/web/src/features/projects/`.

* States draft → active ↔ paused → completed → archived (`PROJECT_TRANSITIONS`), obligations in `projectObligations`, `projectArchivePreview`.
* Project team (`addProjectMember`/`endProjectMember`) bumps access revisions. Milestones, decisions, activity, direction transfer with history.
* Workspace tabs: `registerProjectTab` (see `apps/web/src/lib/project-tabs.ts`); tabs from other modules are imported in `apps/web/src/features/project-tabs.ts`.
* Lookups `project`, `direction` (`organization/lookups.ts`) — the reference pattern for `defineLookup`.
