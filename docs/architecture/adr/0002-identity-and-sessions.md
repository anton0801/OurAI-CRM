# ADR 0002 — Own identity, sessions and MFA

Status: accepted (2026-09-24)

## Context
R03 forbids shared authentication with Dramora or any external identity provider. §23 requires
password + MFA (TOTP) with recovery codes, invitation-only membership, a one-time Owner bootstrap,
immediate session revocation on deactivation and step-up authentication for critical actions.

## Decision
* Passwords: Argon2id (`@node-rs/argon2`), parameters configurable via environment; breached/weak
  password checks by length and a local deny list; no password hints.
* Sessions: opaque random tokens in an HttpOnly, Secure (in production), SameSite=Lax cookie; only the
  SHA-256 hash is stored. Idle timeout 12 h, absolute lifetime 7 days. Every request re-checks membership status and `access_revision`.
* CSRF: state-changing requests need a same-origin `Origin` header and an `X-CSRF-Token` derived
  from the session (HMAC); pre-session forms use a double-submit cookie.
* MFA: TOTP (RFC 6238, 30 s, ±1 step) with replay protection (`mfa_last_step`), secrets encrypted
  with AES-256-GCM using `MFA_ENCRYPTION_KEY`; 10 single-use recovery codes stored hashed.
  Roles/permissions marked sensitive require MFA before workspace access.
* Step-up: `requireRecentAuth` (password or TOTP within 15 minutes) for permission changes,
  finance posting/approval, MFA changes, exports of sensitive data and backup-related actions.
* Bootstrap: `pnpm bootstrap:owner` creates the first Owner inside a serializable transaction and
  marks `system_state('bootstrap')`; later runs fail. A temporary password forces a password change.
* Invitations: 72 h hashed tokens, bound to an email, grants validated against the inviter's own
  rights (no escalation, Owner-only grants for admin/finance presets).

## Consequences
No external IdP/SSO in this version; adding OIDC later is an additional sign-in method that maps to
the same `users`/`memberships` tables.
