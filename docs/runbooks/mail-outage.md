# Mail outage

Symptoms: invitations/password resets not arriving; System Health shows mail failures; jobs of
type `mail.*` retrying or dead-lettered.

1. Check the SMTP relay status and credentials (SMTP_HOST/PORT/USERNAME/PASSWORD/SECURE). The worker
   logs `mail_send_failed` with the provider error code (never the message body).
2. In-app notifications keep working (Inbox) — tell users to check the Inbox; security alerts are
   also stored in-app.
3. After the relay is back, retry dead-lettered mail jobs from System Health. Mail jobs are
   idempotent per message id: a retry never sends the same message twice after a confirmed send.
4. Expired invitation/reset links during the outage: resend invitations (Team → Invitations →
   Resend: the old token is invalidated) and ask users to request a new reset link.
5. Never switch production to `MAIL_TRANSPORT=dev_sink` — the application refuses to start with it.
