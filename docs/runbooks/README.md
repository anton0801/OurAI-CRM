# Operations runbooks

| Runbook | Use when |
|---|---|
| [deploy.md](deploy.md) | First installation, upgrades, rollback, migrations |
| [backup-restore.md](backup-restore.md) | Backups, point-in-time recovery, monthly restore drill, disaster recovery |
| [queue-recovery.md](queue-recovery.md) | Jobs stuck, dead letters, outbox lag, worker crash loops |
| [mail-outage.md](mail-outage.md) | Invitation/reset/notification e-mails not delivered |
| [storage-failure.md](storage-failure.md) | Uploads failing, scanner down, objects missing, quota |
| [access-revocation.md](access-revocation.md) | Remove a person's access immediately, compromised account, leaked secret |
| [monitoring.md](monitoring.md) | Signals, alert thresholds, log hygiene |

General rules: production deploys, sending invitations to real people and migrating real data
require explicit approval of the environment owner. Never paste secrets, session tokens, signed
URLs or OFM contact notes into tickets or chat. Record every production intervention as an
operational incident in **Operations → System Health** (S71).
