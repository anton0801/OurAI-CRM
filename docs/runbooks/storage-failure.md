# Storage, scanner and upload failures

## Uploads fail or stay "Checking"
* Scanner: `SCANNER_MODE=clamd` needs the `clamav` service healthy (first start downloads
  signatures, ~5 min). While clamd is unavailable files stay in *Checking/Failed* and are never
  offered as Available (T077) — this is intended. Fix clamd, then retry `media.process` jobs.
* Storage credentials/endpoint: the worker logs `storage_error` with the operation name. Verify the
  bucket exists, is private (no public ACL/policy) and has versioning enabled.
* Quota: workspace quota reservations are released when uploads expire (hourly
  `media.expireUploads`). Storage > 85 % of the provider quota raises an alert.

## Objects missing (404 from storage for an available version)
1. Identify affected keys: `SELECT id, storage_key FROM asset_versions WHERE status = 'available'`
   and `head-object` them (the restore-drill script does this).
2. Restore the object from bucket versioning / provider backup to the same key.
3. If unrecoverable: mark the version failed with an audited note and inform the owner; approved
   content that depended on it keeps its history (the file shows as unavailable, never silently
   replaced).

## Storage outage
Reads of previews/downloads fail with a clear error; the rest of the CRM keeps working. Uploads
cannot complete and are resumable within their TTL (24 h) once storage is back.
