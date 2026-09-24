# Team, access & settings (S12, S61–S63, S67, S68)

Code: `packages/application/src/team/`, contracts `team.ts`, handlers `team.ts`, UI `features/team`, `features/settings`, `features/directions`.

Helpers for other modules (`@castlane/application`):
* `bumpAccessRevision(ctx, membershipIds)` — call after any change that alters what a member may see (sends `access_changed`).
* `memberVisibility` / `memberVisibilitySql` — member scope in SQL; `loadReadableMember`, `isWorkspaceOwner`, `collectOpenWork`, `checkSessionPolicy`, `insertGrant`.
* Deactivation (F12) lists and transfers every `defineResponsibilityProvider`; providers run inside the deactivation transaction and must validate successors (e.g. project access).

Registries: responsibility `directions.lead`, `projects.owner`; archive `direction`; export `team_roster`; renders `MEMBER_TABS`.

Mail server (S67): the Owner saves host/port/TLS/username/password/sender (`saveMailServer`, recent auth);
the password is encrypted (`SECRETS_ENCRYPTION_KEY`, fallback `MFA_ENCRYPTION_KEY`), write-only and never
returned; `effectiveMail` (platform/mail.ts) prefers it over SMTP_* and the worker resolves the mailer per
message. Limits: The Owner cannot be denied, suspended or deactivated; members cannot change their own access.
