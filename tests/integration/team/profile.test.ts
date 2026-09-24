import { describe, expect, it } from 'vitest';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import sharp from 'sharp';
import { mediaEndpoints, settingsEndpoints, teamEndpoints } from '@castlane/api-contracts';
import { jobs, memberships, recoveryCodes, users } from '@castlane/database';
import { newId } from '@castlane/domain';
import { addMember, clientFor, createWorkspace, runQueuedJobs } from '../../support';
import { db, enableMfaFlag, expireRecentAuth, ownerSetup, signedIn, type TestClient } from './helpers';

const putParts = async (parts: { url: string }[], body: Buffer, partSize: number) => {
  const { PUT } = await import('@/../app/api/v1/storage/fs/part/route');
  const etags: { partNumber: number; etag: string }[] = [];
  for (let i = 0; i < parts.length; i++) {
    const res = await PUT(new Request(parts[i]!.url, { method: 'PUT', body: body.subarray(i * partSize, (i + 1) * partSize), duplex: 'half' } as RequestInit));
    etags.push({ partNumber: i + 1, etag: res.headers.get('etag')! });
  }
  return etags;
};

const uploadAvatar = async (c: TestClient, workspaceId: string) => {
  const body = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#315E87' } }).png().toBuffer();
  const init = await c.call(settingsEndpoints.avatarUpload, { params: { workspaceId }, body: { filename: 'me.png', mimeType: 'image/png', byteSize: body.length } });
  const etags = await putParts(init.parts, body, init.partSize);
  await c.call(mediaEndpoints.completeUpload, { params: { workspaceId, uploadId: init.uploadId }, body: { parts: etags } });
  return init;
};

describe('personal settings (S68)', () => {
  it('updates display name, theme, density, time zone and notification preferences with If-Match', async () => {
    const { ws, owner } = await ownerSetup();
    const params = { workspaceId: ws.workspaceId };
    const me = await owner.call(settingsEndpoints.me, { params });
    expect(me.preferences).toMatchObject({ theme: 'system', density: 'comfortable', quietHoursStart: '22:00', quietHoursEnd: '08:00' });
    expect(me.user.mfaRequired).toBe(true);
    expect((await owner.attempt(settingsEndpoints.updateMe, { params, body: { theme: 'dark' } })).status).toBe(428);
    const upd = await owner.call(
      settingsEndpoints.updateMe,
      { params, body: { displayName: 'Olga Owner', theme: 'dark', density: 'compact', timezone: 'Asia/Tokyo', quietHoursStart: '21:30', notifications: { ...me.preferences.notifications, dailyDigest: true } } },
      { ifMatch: me.rowVersion },
    );
    expect(upd.user.displayName).toBe('Olga Owner');
    expect(upd.preferences).toMatchObject({ theme: 'dark', density: 'compact', timezone: 'Asia/Tokyo', effectiveTimezone: 'Asia/Tokyo', quietHoursStart: '21:30' });
    expect(upd.preferences.notifications.dailyDigest).toBe(true);
    const [m] = await db().select().from(memberships).where(eq(memberships.id, ws.owner.membershipId));
    expect(m!.displayNameSnapshot).toBe('Olga Owner');
    const stale = await owner.attempt(settingsEndpoints.updateMe, { params, body: { theme: 'light' } }, { ifMatch: me.rowVersion });
    expect(stale.status).toBe(412);
    const badHours = await owner.attempt(settingsEndpoints.updateMe, { params, body: { quietHoursEnd: '25:00' } }, { ifMatch: upd.rowVersion });
    expect(badHours.status).toBe(422);
    const badZone = await owner.attempt(settingsEndpoints.updateMe, { params, body: { timezone: 'Mars/Olympus' } }, { ifMatch: upd.rowVersion });
    expect(badZone.status).toBe(422);
  });

  it('anyone can upload their own avatar through the checked media pipeline; colleagues see it, strangers do not', async () => {
    const { ws, owner } = await ownerSetup();
    const params = { workspaceId: ws.workspaceId };
    // Viewers cannot upload to the Library, but may set their own avatar.
    const fin = await addMember(db(), ws, { roleKey: 'viewer', name: 'Fay' });
    const fc = await signedIn(fin.userId);
    const lib = await fc.attempt(mediaEndpoints.initiateUpload, { params, body: { filename: 'x.png', mimeType: 'image/png', byteSize: 10, purpose: 'general' } });
    expect(lib.status).toBe(403);
    const badType = await fc.attempt(settingsEndpoints.avatarUpload, { params, body: { filename: 'x.gif', mimeType: 'image/gif' as never, byteSize: 10 } });
    expect(badType.status).toBe(422);
    const init = await uploadAvatar(fc, ws.workspaceId);
    expect((await fc.call(settingsEndpoints.avatarStatus, { params: { ...params, assetId: init.assetId } })).status).toBe('checking');
    const me0 = await fc.call(settingsEndpoints.me, { params });
    const early = await fc.attempt(settingsEndpoints.updateMe, { params, body: { avatarAssetId: init.assetId } }, { ifMatch: me0.rowVersion });
    expect(early.status).toBe(409);
    await runQueuedJobs(['media.process']);
    expect((await fc.call(settingsEndpoints.avatarStatus, { params: { ...params, assetId: init.assetId } })).status).toBe('available');
    const me = await fc.call(settingsEndpoints.updateMe, { params, body: { avatarAssetId: init.assetId } }, { ifMatch: me0.rowVersion });
    expect(me.user.avatarUrl).toBe(`/api/v1/avatars/${fin.userId}`);

    const img = await owner.raw('GET', `/avatars/${fin.userId}?size=64`);
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/webp');
    expect(img.headers.get('cache-control')).toContain('private');
    // Stable URL, so browsers revalidate: an unchanged derivative answers 304 without a body.
    const etag = img.headers.get('etag')!;
    expect(etag).toBeTruthy();
    const again = await owner.raw('GET', `/avatars/${fin.userId}?size=64`, { headers: { 'if-none-match': etag } });
    expect(again.status).toBe(304);
    const roster = await owner.call(teamEndpoints.get, { params: { ...params, membershipId: fin.membershipId } });
    expect(roster.avatarUrl).toBe(`/api/v1/avatars/${fin.userId}`);

    const other = await createWorkspace(db());
    const stranger = await signedIn(other.owner.userId);
    expect((await stranger.raw('GET', `/avatars/${fin.userId}`)).status).toBe(404);
    // Someone else's upload cannot become your avatar.
    const own = await owner.call(settingsEndpoints.me, { params });
    const steal = await owner.attempt(settingsEndpoints.updateMe, { params, body: { avatarAssetId: init.assetId } }, { ifMatch: own.rowVersion });
    expect(steal.status).toBe(422);
    // Removing the avatar.
    const cleared = await fc.call(settingsEndpoints.updateMe, { params, body: { avatarAssetId: null } }, { ifMatch: me.rowVersion });
    expect(cleared.user.avatarUrl).toBeNull();
  });

  it('e-mail change needs recent authentication and confirmation from the new address', async () => {
    const { ws } = await ownerSetup();
    const params = { workspaceId: ws.workspaceId };
    const m = await addMember(db(), ws, { roleKey: 'viewer', email: 'old.address@test.invalid' });
    await addMember(db(), ws, { roleKey: 'viewer', email: 'taken@test.invalid' });
    const mc = await signedIn(m.userId);
    const taken = await mc.attempt(settingsEndpoints.emailChange, { params, body: { newEmail: 'taken@test.invalid' } });
    expect(taken.status).toBe(422);
    await expireRecentAuth(m.userId);
    expect((await mc.attempt(settingsEndpoints.emailChange, { params, body: { newEmail: 'new.address@test.invalid' } })).code).toBe('RECENT_AUTH_REQUIRED');
    const mc2 = await signedIn(m.userId);
    const r = await mc2.call(settingsEndpoints.emailChange, { params, body: { newEmail: 'new.address@test.invalid' } });
    expect(r.newEmail).toBe('new.address@test.invalid');
    expect((await mc2.call(settingsEndpoints.me, { params })).pendingEmailChange?.newEmail).toBe('new.address@test.invalid');
    const [job] = await db()
      .select({ payload: jobs.payload })
      .from(jobs)
      .where(sql`${jobs.payload}->>'template' = 'emailChange'`)
      .orderBy(desc(jobs.createdAt))
      .limit(1);
    const payload = job!.payload as { to: string; vars: { confirmUrl: string } };
    expect(payload.to).toBe('new.address@test.invalid');
    const token = payload.vars.confirmUrl.split('/').pop()!;
    const anon = await clientFor();
    const ok = await anon.call(settingsEndpoints.confirmEmailChange, { body: { token } });
    expect(ok.email).toBe('new.address@test.invalid');
    const [u] = await db().select().from(users).where(eq(users.id, m.userId));
    expect(u!.normalizedEmail).toBe('new.address@test.invalid');
    const alerts = await db().select({ payload: jobs.payload }).from(jobs).where(sql`${jobs.payload}->>'template' = 'securityAlert' AND ${jobs.payload}->>'to' = 'old.address@test.invalid'`);
    expect(alerts.length).toBeGreaterThanOrEqual(2);
    const replay = await anon.attempt(settingsEndpoints.confirmEmailChange, { body: { token } });
    expect(replay.status).toBe(409);
  });

  it('MFA cannot be turned off when a role requires it; otherwise it can (recent auth), revoking recovery codes', async () => {
    const { ws, owner } = await ownerSetup();
    await enableMfaFlag(ws.owner.userId);
    const required = await owner.attempt(settingsEndpoints.disableMfa, {});
    expect(required.status).toBe(409);
    const creator = await addMember(db(), ws, { roleKey: 'creator', scopeType: 'assigned_projects' });
    await enableMfaFlag(creator.userId);
    await db().insert(recoveryCodes).values({ id: newId(), userId: creator.userId, batchId: newId(), codeHash: 'x' });
    const cc = await signedIn(creator.userId);
    const me = await cc.call(settingsEndpoints.me, { params: { workspaceId: ws.workspaceId } });
    expect(me.user).toMatchObject({ mfaEnabled: true, mfaRequired: false, recoveryCodesRemaining: 1 });
    const off = await cc.call(settingsEndpoints.disableMfa, {});
    expect(off.ok).toBe(true);
    const [u] = await db().select().from(users).where(eq(users.id, creator.userId));
    expect(u!.mfaEnabledAt).toBeNull();
    const codes = await db().select().from(recoveryCodes).where(and(eq(recoveryCodes.userId, creator.userId), isNull(recoveryCodes.revokedAt)));
    expect(codes).toHaveLength(0);
  });

  it('shows the personal data stored about the member', async () => {
    const { ws, owner } = await ownerSetup();
    const data = await owner.call(settingsEndpoints.personalData, { params: { workspaceId: ws.workspaceId } });
    expect(data.account.email).toBe(ws.owner.email);
    expect(data.memberships[0]).toMatchObject({ workspaceName: 'Test Workspace', status: 'active', roles: ['Owner'] });
    expect(data.sessions.active).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(data)).not.toMatch(/passwordHash|mfaSecret|tokenHash/);
  });
});
