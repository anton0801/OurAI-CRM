# Monitoring and alerts

## Signals
* Logs: structured JSON (one line per event) with `requestId`, `jobId`, pseudonymous workspace
  id and `errorCode`. Passwords, MFA codes, secrets, signed URLs, session tokens and raw OFM contact
  notes are never logged (T171; redaction happens in the logger).
* Health: `GET /api/v1/health/live` (process up), `GET /api/v1/health/ready` (database and storage
  reachable) — use them for container/orchestrator probes.
* System Health screen (S71): queue depth by pool/state, oldest due job, dead letters, outbox lag,
  mail failures, pending scans, last backup / last restore drill, incidents.

## Alert thresholds (defaults, editable)
| Alert | Threshold |
|---|---|
| API 5xx | > 2 % over 5 min with ≥ 100 requests |
| Worker lag | oldest due job > 10 min |
| Backup age | last successful backup > 26 h |
| Outbox lag | oldest undispatched event > 5 min |
| Storage | > 85 % of quota |
| Scan queue | stalled > 15 min |
| Finance integrity | any failed integrity assertion |

Group alerts by fingerprint (type + service + error code) — one page, not a hundred e-mails.
