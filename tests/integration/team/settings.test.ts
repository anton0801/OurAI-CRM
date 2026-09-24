import { describe, expect, it } from 'vitest';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { authEndpoints, projectEndpoints, settingsEndpoints, teamEndpoints } from '@castlane/api-contracts';
import { auditEvents, financialEntries, sessions, userPreferences, users, workspaces } from '@castlane/database';
import { newId } from '@castlane/domain';
import { addMember, clientFor, runQueuedJobs, sessionFor, TestClient } from '../../support';
import { db, expireRecentAuth, latestInviteToken, ownerSetup, signedIn } from './helpers';

describe('workspace settings (S67)', () => {
  it('returns defaults per group and what the viewer may change; members without workspace.read get 403', async () => {
    const { ws, owner } = await ownerSetup();
    const params = { workspaceId: ws.workspaceId };
    const s = await owner.call(settingsEndpoints.workspace, { params });
    expect(s.general.baseCurrency).toBe('EUR');
    expect(s.security).toEqual({ mfaRequiredForAll: false, mfaRequiredRoleKeys: [], sessionIdleHours: 12, sessionAbsoluteDays: 7 });
    expect(s.retention).toEqual({ trashDays: 30, auditMonths: 24, financialYears: 7, ofmArchivedNotesDays: 180, exportDays: 7 });
    expect(s.notifications.quietHoursStart).toBe('22:00');
    expect(s.mail.transport).toBe('dev_sink');
    expect(s.mail.configured).toBe(false);
    expect(JSON.stringify(s)).not.toMatch(/SMTP_PASSWORD|password/i);
    expect(s.permissions).toMatchObject({ update: true, manageQuota: true, changeCurrency: true });
    expect(s.roles.find((r) => r.key === 'admin')!.alwaysRequiresMfa).toBe(true);
    const admin = await addMember(db(), ws, { roleKey: 'admin' });
    const as = await (await signedIn(admin.userId)).call(settingsEndpoints.workspace, { params });
    expect(as.permissions).toMatchObject({ update: true, manageQuota: false, changeCurrency: false, manageSecurity: true });
    const viewer = await addMember(db(), ws, { roleKey: 'viewer' });
    expect((await (await signedIn(viewer.userId)).attempt(settingsEndpoints.workspace, { params })).status).toBe(403);
  });

  it('previews impact, saves with If-Match, audits the diff and never rewrites timestamps', async () => {
    const { ws, owner } = await ownerSetup();
    const params = { workspaceId: ws.workspaceId };
    const s = await owner.call(settingsEndpoints.workspace, { params });
    const patch = {
      general: { timezone: 'America/New_York', weekStartsOn: 'sunday' as const },
      retention: { ...s.retention, auditMonths: 12 },
      workingTime: { workingDays: ['monday' as const, 'tuesday' as const], workingHours: { start: '10:00', end: '19:00' } },
      modules: { hidden: ['ofm' as const] },
    };
    const preview = await owner.call(settingsEndpoints.previewWorkspace, { params, body: patch });
    expect(preview.blocked).toEqual([]);
    expect(preview.changedGroups.sort()).toEqual(['general', 'modules', 'retention', 'workingTime']);
    expect(preview.impacts.some((i) => /not rewritten/.test(i.message))).toBe(true);
    expect(preview.impacts.some((i) => i.severity === 'warning' && /Audit events older than 12 months/.test(i.message))).toBe(true);
    expect((await owner.attempt(settingsEndpoints.updateWorkspace, { params, body: patch })).status).toBe(428);
    const saved = await owner.call(settingsEndpoints.updateWorkspace, { params, body: patch }, { ifMatch: s.rowVersion });
    expect(saved.general.timezone).toBe('America/New_York');
    expect(saved.modules.hidden).toEqual(['ofm']);
    expect(saved.workingTime.workingHours).toEqual({ start: '10:00', end: '19:00' });
    expect(saved.settingsVersion).toBe(s.settingsVersion + 1);
    const stale = await owner.attempt(settingsEndpoints.updateWorkspace, { params, body: { general: { name: 'Renamed' } } }, { ifMatch: s.rowVersion });
    expect(stale.status).toBe(412);
    const [a] = await db().select().from(auditEvents).where(and(eq(auditEvents.workspaceId, ws.workspaceId), eq(auditEvents.action, 'workspace.settings_updated'))).orderBy(desc(auditEvents.occurredAt));
    expect(a!.diff!['general.timezone']).toEqual({ from: 'Europe/Berlin', to: 'America/New_York' });
    // Bounds are validated by the contract.
    const tooLoose = await owner.attempt(settingsEndpoints.updateWorkspace, { params, body: { security: { ...saved.security, sessionIdleHours: 48 } } }, { ifMatch: saved.rowVersion });
    expect(tooLoose.status).toBe(422);
    const badHours = await owner.attempt(settingsEndpoints.updateWorkspace, { params, body: { workingTime: { workingDays: ['monday'], workingHours: { start: '18:00', end: '09:00' } } } }, { ifMatch: saved.rowVersion });
    expect(badHours.status).toBe(422);
  });

  it('locks the base currency once financial records exist; quota and currency are Owner-only', async () => {
    const { ws, owner } = await ownerSetup();
    const params = { workspaceId: ws.workspaceId };
    const admin = await addMember(db(), ws, { roleKey: 'admin' });
    const ac = await signedIn(admin.userId);
    const s = await owner.call(settingsEndpoints.workspace, { params });
    const quota = await ac.attempt(settingsEndpoints.updateWorkspace, { params, body: { files: { quotaBytes: String(2 * 1024 ** 3) } } }, { ifMatch: s.rowVersion });
    expect(quota.status).toBe(403);
    const cur = await ac.attempt(settingsEndpoints.updateWorkspace, { params, body: { general: { baseCurrency: 'USD' } } }, { ifMatch: s.rowVersion });
    expect(cur.status).toBe(403);
    const below = await owner.call(settingsEndpoints.previewWorkspace, { params, body: { files: { quotaBytes: String(1024 ** 3) } } });
    expect(below.blocked).toEqual([]);
    const at = new Date();
    await db().insert(financialEntries).values({ id: newId(), workspaceId: ws.workspaceId, type: 'expense', recognitionDate: '2026-09-01', title: 'Software', createdAt: at, updatedAt: at });
    const locked = await owner.call(settingsEndpoints.workspace, { params });
    expect(locked.general.baseCurrencyLocked).toBe(true);
    expect(locked.permissions.changeCurrency).toBe(false);
    const change = await owner.attempt(settingsEndpoints.updateWorkspace, { params, body: { general: { baseCurrency: 'USD' } } }, { ifMatch: locked.rowVersion });
    expect(change.status).toBe(422);
    expect(change.error?.message).toMatch(/financial records exist/);
  });

  it('security policy: recent authentication to change; MFA for chosen roles; stricter session idle/absolute limits end sessions', async () => {
    const { ws, owner } = await ownerSetup();
    const params = { workspaceId: ws.workspaceId };
    const viewer = await addMember(db(), ws, { roleKey: 'viewer' });
    const s = await owner.call(settingsEndpoints.workspace, { params });
    const policy = { security: { mfaRequiredForAll: false, mfaRequiredRoleKeys: ['viewer'], sessionIdleHours: 2, sessionAbsoluteDays: 3 } };
    const preview = await owner.call(settingsEndpoints.previewWorkspace, { params, body: policy });
    expect(preview.requiresRecentAuth).toBe(true);
    expect(preview.impacts.find((i) => /two-factor/.test(i.message))!.count).toBe(1);
    await expireRecentAuth(ws.owner.userId);
    const noAuth = await owner.attempt(settingsEndpoints.updateWorkspace, { params, body: policy }, { ifMatch: s.rowVersion });
    expect(noAuth.code).toBe('RECENT_AUTH_REQUIRED');
    const owner2 = await signedIn(ws.owner.userId);
    await owner2.call(settingsEndpoints.updateWorkspace, { params, body: policy }, { ifMatch: s.rowVersion });

    // Viewers now need MFA (policy by role).
    const vToken = await sessionFor(db(), viewer.userId, { mfaVerified: false });
    const vc = new TestClient(vToken);
    vc.csrf = 'x';
    expect((await vc.attempt(projectEndpoints.list, { params, query: {} })).code).toBe('MFA_REQUIRED');

    // Idle: last activity 3 h ago with a 2 h policy → signed out on the next request.
    const idleToken = await sessionFor(db(), ws.owner.userId);
    const [idle] = await db().select().from(sessions).where(eq(sessions.userId, ws.owner.userId)).orderBy(desc(sessions.createdAt)).limit(1);
    await db().update(sessions).set({ lastSeenAt: new Date(Date.now() - 3 * 3_600_000) }).where(eq(sessions.id, idle!.id));
    const ic = new TestClient(idleToken);
    // Any authenticated request (here the session bootstrap) ends it.
    const r = await ic.attempt(authEndpoints.me, {});
    expect(r.status).toBe(401);
    expect((await ic.attempt(projectEndpoints.list, { params, query: {} })).status).toBe(401);
    const [revoked] = await db().select().from(sessions).where(eq(sessions.id, idle!.id));
    expect(revoked!.revokeReason).toBe('workspace_policy_idle');

    // Absolute: a 4-day-old session with a 3-day policy.
    const oldToken = await sessionFor(db(), ws.owner.userId);
    const [old] = await db().select().from(sessions).where(and(eq(sessions.userId, ws.owner.userId))).orderBy(desc(sessions.createdAt)).limit(1);
    await db().update(sessions).set({ createdAt: new Date(Date.now() - 4 * 86_400_000) }).where(eq(sessions.id, old!.id));
    const oc = new TestClient(oldToken);
    expect((await oc.attempt(projectEndpoints.list, { params, query: {} })).status).toBe(401);
    const [oldRow] = await db().select().from(sessions).where(eq(sessions.id, old!.id));
    expect(oldRow!.revokeReason).toBe('workspace_policy_absolute');
    // A fresh session keeps working.
    expect((await (await signedIn(ws.owner.userId)).attempt(projectEndpoints.list, { params, query: {} })).ok).toBe(true);
  });

  it('Test Mail to Self reports the real delivery state', async () => {
    const { ws, owner } = await ownerSetup();
    const params = { workspaceId: ws.workspaceId };
    const t = await owner.call(settingsEndpoints.testMail, { params });
    expect(t.to).toBe(ws.owner.email);
    expect((await owner.call(settingsEndpoints.mailTest, { params: { ...params, messageId: t.messageId } })).status).toBe('queued');
    const tooSoon = await owner.attempt(settingsEndpoints.testMail, { params });
    expect(tooSoon.status).toBe(429);
    await runQueuedJobs(['mail.send']);
    const st = await owner.call(settingsEndpoints.mailTest, { params: { ...params, messageId: t.messageId } });
    expect(st.status).toBe('sent');
    expect(st.transport).toBe('dev_sink');
    const s = await owner.call(settingsEndpoints.workspace, { params });
    expect(s.mail.lastTest?.status).toBe('sent');
    const admin = await addMember(db(), ws, { roleKey: 'admin' });
    expect((await (await signedIn(admin.userId)).attempt(settingsEndpoints.mailTest, { params: { ...params, messageId: t.messageId } })).status).toBe(404);
  });

  it('notification defaults apply to people who join later', async () => {
    const { ws, owner } = await ownerSetup();
    const params = { workspaceId: ws.workspaceId };
    const s = await owner.call(settingsEndpoints.workspace, { params });
    await owner.call(settingsEndpoints.updateWorkspace, { params, body: { notifications: { ...s.notifications, dailyDigest: true, mentions: false, quietHoursStart: '23:00', quietHoursEnd: '07:30' } } }, { ifMatch: s.rowVersion });
    const viewer = await ws.roleId('viewer');
    await owner.call(teamEndpoints.invite, { params, body: { email: 'joiner@test.invalid', grants: [{ roleId: viewer, scopeType: 'workspace', scopeId: null }] } });
    const token = await latestInviteToken('joiner@test.invalid');
    await (await clientFor()).call(authEndpoints.acceptInvitation, { body: { token, displayName: 'Jo Joiner', password: 'a strong password 1' } });
    const [u] = await db().select().from(users).where(eq(users.normalizedEmail, 'joiner@test.invalid'));
    const [p] = await db().select().from(userPreferences).where(eq(userPreferences.userId, u!.id));
    expect(p!.notifications).toMatchObject({ dailyDigest: true, mentions: false });
    expect(p!.quietHoursStart).toBe('23:00');
    expect(p!.quietHoursEnd).toBe('07:30');
    const [w] = await db().select().from(workspaces).where(eq(workspaces.id, ws.workspaceId));
    expect(w!.settings.notificationDefaults?.dailyDigest).toBe(true);
    void isNotNull;
  });
});
