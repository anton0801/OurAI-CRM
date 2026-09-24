# Access revocation and compromised credentials

## Remove a person immediately
Team → member → **Deactivate** (F12): the impact preview lists open responsibilities; choose
successors (or the lead's Unassigned queue) and confirm. Effects in one transaction: membership
deactivated, **all sessions revoked**, future shift assignments cancelled, invitations revoked;
open SSE streams disconnect within 30 s. History keeps the person as author. Restoring later does
not silently return sensitive grants.

## Reduce access
Settings → Roles and Access: change role grants/scope or add an explicit deny. Every change bumps
the member's access revision: new reads/writes use the new rights immediately and open tabs reload.
Downloaded files cannot be recalled; restricted assets can no longer be read through the proxy.

## Compromised account
1. Deactivate or suspend the member (above); if the member stays, revoke their sessions
   (Personal Settings → Sessions by the member, or deactivate/restore) and force a password reset.
2. Review the Audit Log (Settings → Audit) filtered by actor and period; export it.
3. Regenerate MFA recovery codes for the member after re-enrolment.

## Leaked secret
| Secret | Action |
|---|---|
| SESSION_SECRET | Rotate → all sessions and CSRF tokens become invalid; everybody signs in again. |
| MFA_ENCRYPTION_KEY | Do **not** simply rotate (TOTP secrets become undecryptable). Re-encrypt with a migration script, or require all members to re-enrol MFA. |
| Database/S3/SMTP credentials | Rotate at the provider, update the environment, restart web + worker. |
| Backup age identity | Create a new key, re-encrypt retained dumps or keep the old key sealed until they expire. |
Record the incident in System Health with the timeline.
