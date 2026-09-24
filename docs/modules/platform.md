# Platform (S10, S11, S54, S66, S69–S72)

Code: `packages/application/src/platform/`, contracts `platform.ts`, `platform-data.ts`, `platform-config.ts`.

For other modules:
* Custom fields: `defineCustomFieldTarget(type)`; call `assertCustomFieldsComplete(ctx, type, id, targetStage, projectId)` in transitions; embed `components/custom-fields/custom-fields-panel.tsx`.
* Archive screen: implement `ArchiveHandler.list` (helper `tableArchiveList`) and `untrash`; `extendArchiveHandler` adds them to existing handlers.
* Templates: `loadTemplateVersionForApplication`, `recordTemplateApplication`.
* Saved views: `defineSavedViewModule` + `components/saved-views/saved-views-menu.tsx`.
* Import/Export: `defineImportDataset` / `defineExportDataset`; deep links `/imports?new=1&dataset=…`, `/exports?dataset=…`.
* Health: `/api/v1/health/live`, `/api/v1/health/ready`; incidents with link access `incident`.

Jobs: notifications.digest, imports.parse/validate/commit, exports.generate, archive.purge; schedules platform.healthMonitor (5 min),
platform.retention (daily). SQL: `packages/database/sql/post/010_platform.sql` (immutable published template versions).
