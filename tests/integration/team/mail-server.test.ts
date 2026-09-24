import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { settingsEndpoints } from '@castlane/api-contracts';
import { decryptSecret, effectiveMail, getAppServices } from '@castlane/application';
import { auditEvents, mailSettings } from '@castlane/database';
import { addMember } from '../../support';
import { db, expireRecentAuth, ownerSetup, signedIn } from './helpers';

// Assembled at runtime so the literal never appears in fixtures or logs verbatim.
const SECRET = ['mail', 'pass', 'W0rd', '2026'].join('-');

const secretKey = () => {
  const cfg = getAppServices().config;
  return cfg.SECRETS_ENCRYPTION_KEY ?? cfg.MFA_ENCRYPTION_KEY;
};

describe('mail server in Workspace Settings (S67)', () => {
  // One row per installation: each test starts without a saved server.
  beforeEach(async () => {
    await db().delete(mailSettings);
  });

  it('SMTP password is entered write-only: stored encrypted, never returned, audited without the value', async () => {
    const { ws, owner } = await ownerSetup();
    const params = { workspaceId: ws.workspaceId };
    const body = { host: 'smtp.example.com', port: 587, secure: false, username: 'mailer', password: SECRET, from: 'Castlane <no-reply@example.com>' };
    const saved = await owner.call(settingsEndpoints.saveMailServer, { params, body });
    expect(saved.saved).toMatchObject({ host: 'smtp.example.com', port: 587, username: 'mailer', secretSaved: true, from: 'Castlane <no-reply@example.com>' });
    expect(saved.canEdit).toBe(true);
    expect(JSON.stringify(saved)).not.toContain(SECRET);
    const view = await owner.call(settingsEndpoints.workspace, { params });
    expect(view.mail.saved?.secretSaved).toBe(true);
    expect(JSON.stringify(view)).not.toContain(SECRET);
    expect(JSON.stringify(view)).not.toMatch(/password/i);

    const [row] = await db().select().from(mailSettings);
    expect(row!.passwordEnc).not.toContain(SECRET);
    expect(decryptSecret(row!.passwordEnc!, secretKey())).toBe(SECRET);
    const audits = await db().select().from(auditEvents).where(and(eq(auditEvents.workspaceId, ws.workspaceId), eq(auditEvents.action, 'workspace.mail_server_saved')));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.metadata).toMatchObject({ passwordChanged: true });
    expect(JSON.stringify(audits)).not.toContain(SECRET);

    // Saving without a password keeps it; the explicit removal clears it.
    const { password: _omit, ...rest } = body;
    void _omit;
    await owner.call(settingsEndpoints.saveMailServer, { params, body: { ...rest, port: 2525 } });
    expect(decryptSecret((await db().select().from(mailSettings))[0]!.passwordEnc!, secretKey())).toBe(SECRET);
    const cleared = await owner.call(settingsEndpoints.saveMailServer, { params, body: { ...rest, clearPassword: true } });
    expect(cleared.saved?.secretSaved).toBe(false);
    expect((await db().select().from(mailSettings))[0]!.passwordEnc).toBeNull();
  });

  it('validates host and sender; only the Owner with recent authentication may change it', async () => {
    const { ws, owner } = await ownerSetup();
    const params = { workspaceId: ws.workspaceId };
    const bad = await owner.attempt(settingsEndpoints.saveMailServer, { params, body: { host: 'smtp example', port: 587, secure: false, from: 'nobody' } });
    expect(bad.status).toBe(422);
    expect((bad.error as { fieldErrors: { field: string }[] }).fieldErrors.map((f) => f.field).sort()).toEqual(['from', 'host']);

    const admin = await addMember(db(), ws, { roleKey: 'admin' });
    const ac = await signedIn(admin.userId);
    const denied = await ac.attempt(settingsEndpoints.saveMailServer, { params, body: { host: 'smtp.example.com', port: 587, secure: false, from: 'ops@example.com' } });
    expect(denied.status).toBe(403);
    const adminView = await ac.call(settingsEndpoints.workspace, { params });
    expect(adminView.mail.canEdit).toBe(false);

    await expireRecentAuth(ws.owner.userId);
    const stale = await owner.attempt(settingsEndpoints.saveMailServer, { params, body: { host: 'smtp.example.com', port: 587, secure: false, from: 'ops@example.com' } });
    expect(stale.code).toBe('RECENT_AUTH_REQUIRED');
    expect(await db().select().from(mailSettings)).toHaveLength(0);
  });

  it('a saved server wins over the environment; removing it falls back; with neither, nothing pretends to be configured', async () => {
    const { ws, owner } = await ownerSetup();
    const params = { workspaceId: ws.workspaceId };
    const app = getAppServices();
    const smtp = { ...app.config, MAIL_TRANSPORT: 'smtp' as const, SMTP_HOST: 'env-smtp.example.com', SMTP_FROM: 'Env <env@example.com>' };
    expect(await effectiveMail({ db: app.db, config: smtp })).toMatchObject({ source: 'environment', server: { host: 'env-smtp.example.com' } });
    await owner.call(settingsEndpoints.saveMailServer, { params, body: { host: 'smtp.example.com', port: 465, secure: true, username: 'u', password: SECRET, from: 'ops@example.com' } });
    expect(await effectiveMail({ db: app.db, config: smtp })).toMatchObject({ source: 'settings', server: { host: 'smtp.example.com', port: 465, secure: true, password: SECRET, from: 'ops@example.com' } });
    // Development sink: nothing is delivered even with a saved server.
    expect(await effectiveMail({ db: app.db, config: { ...smtp, MAIL_TRANSPORT: 'dev_sink' } })).toMatchObject({ transport: 'dev_sink', server: null });
    const removed = await owner.call(settingsEndpoints.removeMailServer, { params });
    expect(removed.saved).toBeNull();
    expect(await effectiveMail({ db: app.db, config: smtp })).toMatchObject({ source: 'environment' });
    expect(await effectiveMail({ db: app.db, config: { ...smtp, SMTP_HOST: undefined } })).toMatchObject({ source: 'none', server: null });
  });
});
