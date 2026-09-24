import { eq, sql } from 'drizzle-orm';
import { invitations, mailMessages, mailSettings, memberships, notifications, users, workspaces } from '@castlane/database';
import { newId } from '@castlane/domain';
import { DevSinkMailer, MAIL_TEMPLATES, SmtpMailer, type Mailer, type MailTemplateKey } from '@castlane/notifications';
import { entityHref } from '@castlane/api-contracts';
import { secretsKey, type AppConfig } from '../core/config';
import type { AppServices } from '../core/context';
import { decryptSecret } from '../core/crypto';
import { defineJob } from '../core/jobs-registry';

/** An explicitly configured mailer (tests) wins over the resolved configuration. */
let override: Mailer | null = null;
let cached: { key: string; mailer: Mailer } | null = null;

export interface MailServer {
  host: string;
  port: number;
  secure: boolean;
  username: string | null;
  password: string | null;
  from: string;
}

export interface EffectiveMail {
  transport: 'smtp' | 'dev_sink';
  /** Where the SMTP server comes from: saved in Workspace Settings (wins), the environment, or nowhere. */
  source: 'settings' | 'environment' | 'none';
  server: MailServer | null;
  key: string;
}

/**
 * Effective outgoing mail configuration. With MAIL_TRANSPORT=dev_sink nothing is delivered (saved
 * servers are kept but not used). With smtp, a server saved in Settings → Workspace → Mail wins over
 * SMTP_* variables; with neither, sending fails honestly ("no SMTP server configured").
 */
export const effectiveMail = async (app: Pick<AppServices, 'db' | 'config'>): Promise<EffectiveMail> => {
  const cfg = app.config;
  if (cfg.MAIL_TRANSPORT !== 'smtp') return { transport: 'dev_sink', source: 'none', server: null, key: 'dev_sink' };
  const [row] = await app.db.select().from(mailSettings).where(eq(mailSettings.id, MAIL_SETTINGS_ID));
  if (row)
    return {
      transport: 'smtp',
      source: 'settings',
      server: { host: row.host, port: row.port, secure: row.secure, username: row.username, password: row.passwordEnc ? decryptSecret(row.passwordEnc, secretsKey(cfg)) : null, from: row.fromAddress },
      key: `settings:${row.rowVersion}:${row.updatedAt.getTime()}`,
    };
  if (cfg.SMTP_HOST)
    return {
      transport: 'smtp',
      source: 'environment',
      server: { host: cfg.SMTP_HOST, port: cfg.SMTP_PORT, secure: cfg.SMTP_SECURE, username: cfg.SMTP_USERNAME ?? null, password: cfg.SMTP_PASSWORD ?? null, from: cfg.SMTP_FROM },
      key: 'environment',
    };
  return { transport: 'smtp', source: 'none', server: null, key: 'none' };
};

const NOT_CONFIGURED = 'No SMTP server is configured. Enter it in Settings → Workspace → Mail.';

class UnconfiguredMailer implements Mailer {
  readonly transport = 'smtp' as const;
  async send(): Promise<{ messageId: string | null }> {
    throw new Error(NOT_CONFIGURED);
  }
  async verify() {
    return { ok: false, detail: NOT_CONFIGURED };
  }
}

const mailerFor = (m: EffectiveMail): Mailer =>
  m.transport === 'dev_sink'
    ? new DevSinkMailer()
    : m.server
      ? new SmtpMailer({ host: m.server.host, port: m.server.port, secure: m.server.secure, username: m.server.username ?? undefined, password: m.server.password ?? undefined, from: m.server.from })
      : new UnconfiguredMailer();

/** Mailer from the environment only (kept for callers that have no database handle). */
export const createMailer = (cfg: AppConfig): Mailer =>
  cfg.MAIL_TRANSPORT === 'smtp' && cfg.SMTP_HOST
    ? new SmtpMailer({ host: cfg.SMTP_HOST, port: cfg.SMTP_PORT, secure: cfg.SMTP_SECURE, username: cfg.SMTP_USERNAME, password: cfg.SMTP_PASSWORD, from: cfg.SMTP_FROM })
    : new DevSinkMailer();

export const configureMailer = (m: Mailer | null) => {
  override = m;
};

/** Current mailer; rebuilt when the saved mail settings change (row version). */
const getMailer = async (app: Pick<AppServices, 'db' | 'config'>): Promise<Mailer> => {
  if (override) return override;
  const m = await effectiveMail(app);
  if (cached?.key !== m.key) cached = { key: m.key, mailer: mailerFor(m) };
  return cached.mailer;
};

export const MAIL_SETTINGS_ID = 'default';

class PermanentMailError extends Error {}

/**
 * Deliver one templated message. The mail_messages row records the real outcome; an invitation's
 * delivery status is only "sent" after the transport accepted the message.
 */
defineJob('mail.send', 'light', async ({ app, job }) => {
  const p = job.payload as {
    template: MailTemplateKey;
    to: string;
    vars: Record<string, unknown>;
    related?: { entityType: string; entityId: string };
    messageId?: string;
  };
  const render = MAIL_TEMPLATES[p.template] as ((i: Record<string, unknown>) => { subject: string; text: string }) | undefined;
  if (!render) throw new PermanentMailError(`Unknown template ${p.template}`);
  const rendered = render({ appOrigin: app.config.APP_ORIGIN, ...p.vars });
  const m = await getMailer(app);
  const messageId = p.messageId ?? newId();
  await app.db
    .insert(mailMessages)
    .values({
      id: messageId,
      workspaceId: job.workspaceId,
      toAddress: p.to,
      subject: rendered.subject,
      textBody: rendered.text,
      template: p.template,
      status: 'queued',
      transport: m.transport,
      relatedEntityType: p.related?.entityType ?? null,
      relatedEntityId: p.related?.entityId ?? null,
    })
    .onConflictDoNothing();
  try {
    const r = await m.send({ to: p.to, subject: rendered.subject, text: rendered.text });
    await app.db
      .update(mailMessages)
      .set({ status: 'sent', sentAt: app.clock.now(), providerMessageId: r.messageId, attempts: sql`${mailMessages.attempts} + 1` })
      .where(eq(mailMessages.id, messageId));
    if (p.related?.entityType === 'invitation')
      await app.db
        .update(invitations)
        .set({ deliveryStatus: 'sent', lastSentAt: app.clock.now(), deliveryError: null })
        .where(eq(invitations.id, p.related.entityId));
    return { messageId, transport: m.transport };
  } catch (e) {
    const msg = (e as Error).message.slice(0, 300);
    await app.db
      .update(mailMessages)
      .set({ status: 'failed', error: msg, attempts: sql`${mailMessages.attempts} + 1` })
      .where(eq(mailMessages.id, messageId));
    if (p.related?.entityType === 'invitation')
      await app.db.update(invitations).set({ deliveryStatus: 'failed', deliveryError: msg }).where(eq(invitations.id, p.related.entityId));
    throw e;
  }
});

/** E-mail copy of an in-app notification: title + link only (no amounts, aliases or restricted text). */
defineJob('mail.notification', 'light', async ({ app, job }) => {
  const { notificationId } = job.payload as { notificationId: string };
  const [n] = await app.db
    .select({
      title: notifications.title,
      workspaceId: notifications.workspaceId,
      entityType: notifications.entityType,
      entityId: notifications.entityId,
      readAt: notifications.readAt,
      email: users.displayEmail,
      status: memberships.status,
      workspaceName: workspaces.name,
    })
    .from(notifications)
    .innerJoin(memberships, eq(memberships.id, notifications.recipientMembershipId))
    .innerJoin(users, eq(users.id, memberships.userId))
    .innerJoin(workspaces, eq(workspaces.id, notifications.workspaceId))
    .where(eq(notifications.id, notificationId));
  if (!n || n.status !== 'active') return { skipped: 'recipient inactive' };
  const url = `${app.config.APP_ORIGIN}${n.entityType && n.entityId ? entityHref(n.workspaceId, n.entityType, n.entityId) : `/w/${n.workspaceId}/inbox`}`;
  const rendered = MAIL_TEMPLATES.notification({ appOrigin: app.config.APP_ORIGIN, title: n.title, url, workspaceName: n.workspaceName });
  const m = await getMailer(app);
  const id = newId();
  await app.db.insert(mailMessages).values({ id, workspaceId: n.workspaceId, toAddress: n.email, subject: rendered.subject, textBody: rendered.text, template: 'notification', status: 'queued', transport: m.transport, relatedEntityType: 'notification', relatedEntityId: notificationId });
  const r = await m.send({ to: n.email, subject: rendered.subject, text: rendered.text });
  await app.db.update(mailMessages).set({ status: 'sent', sentAt: app.clock.now(), providerMessageId: r.messageId, attempts: 1 }).where(eq(mailMessages.id, id));
  return { sent: true };
});

export { PermanentMailError };
