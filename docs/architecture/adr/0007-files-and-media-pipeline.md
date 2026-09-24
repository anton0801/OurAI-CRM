# ADR 0007 — Private files and the media pipeline

Status: accepted (2026-09-24)

## Context
R15 and §6/§14 require private storage, versioned assets, restricted media, malware scanning, size
and type limits, and authorised previews. Object URLs must never be public.

## Decision
* Storage adapter: S3-compatible (production) or local filesystem (development/tests). Buckets are
  private; the filesystem adapter signs short-lived upload/download URLs with HMAC.
* Upload: resumable multipart into a quarantine key → `media.process` job verifies SHA-256, sniffs
  magic bytes (declared type must match), enforces size/pixel limits, scans with ClamAV (`clamd`),
  copies to a server-generated final key, builds derivatives with `sharp`, and converts the quota
  reservation into usage. Failed scans keep the object in quarantine and mark the version rejected.
* Delivery: thumbnails/content are served by the application after an access check (or with a
  short-lived HMAC token for `<img>`), with `Content-Disposition` and `nosniff`.
* Visibility of a file follows the entity it is linked to (`defineLinkAccess` registry) plus the
  `media.restricted` permission for restricted assets.
* Approved versions are immutable; a new upload creates a new version.

## Consequences
Uploads are asynchronous: the UI shows Processing until the job completes. ClamAV is a deployment
dependency (a development bypass scanner exists and is refused in production).
