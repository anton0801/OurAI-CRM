# Identity & setup (S01–S07)

Code: `packages/application/src/identity/`, contracts `auth.ts`, handlers `auth.ts`, pages under `apps/web/app/auth` and `apps/web/app/setup`.

* Bootstrap once (`bootstrapOwner`, CLI `pnpm bootstrap:owner`), temporary password → forced change.
* Sign-in → MFA (TOTP with replay protection, recovery codes) → workspace; recent auth (`requireRecentAuth`, 15 min) via `auth.reauthenticate`.
* Invitations: `inviteMember`, `resendInvitation`, `revokeInvitation`, `acceptInvitation`, invitation requests.
* Sessions: opaque cookie `castlane_session`, idle 12 h / absolute 7 d, session-bound CSRF token; `checkSessionPolicy` applies workspace limits.
