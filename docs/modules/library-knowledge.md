# Library, files & knowledge (S36–S39)

Code: `packages/application/src/{media,knowledge}/`, contracts `media.ts`, `knowledge.ts`.

Attachments for any entity: register `defineLinkAccess(type, …)`, render `<FileUploader target={{ entityType, entityId }} />`, list with
`GET /entity-files/{type}/{id}` (`mediaEndpoints.entityFiles`). Link approved content, published placements and finance evidence with
`holding: true` (`linkAsset`) so versions cannot be deleted. Helpers: `resolveLinkTarget`, `canReadAsset`, `toAssetView`, `listEntityFiles`.

Knowledge: published versions are frozen; required reading needs explicit acknowledgement; major revisions re-request it.
`createTaskFromChecklist` writes tasks directly (to be switched to the tasks module).

Limits: previews for images/video/audio only (PDF/Office show "File Preview Unavailable"), no video transcoding.
