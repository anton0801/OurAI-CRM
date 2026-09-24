import { describe, expect, it } from 'vitest';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { TOTP, Secret } from 'otpauth';
import { authEndpoints, overviewEndpoints, projectEndpoints, setupEndpoints } from '@castlane/api-contracts';
import { bootstrapOwner, getAppServices, decryptSecret, SESSION_COOKIE } from '@castlane/application';
import { auditEvents, invitations, memberships, projects, sessions, users } from '@castlane/database';
import { addMember, assignToProject, clientFor, createProject, createWorkspace, DEFAULT_TEST_PASSWORD, sessionFor, TestClient } from '../../support';

const db = () => getAppServices().db;

describe('bootstrap', () => {
  // One bootstrap per database: both tests share it, whichever runs first performs it.
  let boot: ReturnType<typeof bootstrapOwner> | undefined;
  const bootstrapped = () => (boot ??= bootstrapOwner(db(), { email: 'boot@test.invalid', displayName: 'Boot Owner', at: new Date() }));

  it('creates exactly one Owner with a one-time password and refuses a second bootstrap (T002)', async () => {
    const r = await bootstrapped();
    expect(r.temporaryPassword).toBeTruthy();
    await expect(bootstrapOwner(db(), { email: 'second@test.invalid', displayName: 'Second', at: new Date() })).rejects.toThrow(/already completed/);
    expect(await db().select().from(memberships).where(eq(memberships.workspaceId, r.workspaceId))).toHaveLength(1);
    expect(await db().select().from(users).where(eq(users.normalizedEmail, 'second@test.invalid'))).toEqual([]);
    const [u] = await db().select().from(users).where(eq(users.id, r.userId));
    expect(u?.mustChangePassword).toBe(true);
  });

  it('a new production workspace has no demo data, no fake KPIs and no default password (T001)', async () => {
    const r = await bootstrapped();
    for (const table of ['projects', 'directions', 'social_accounts', 'content_items', 'publications', 'tasks', 'financial_entries', 'budgets', 'metric_observations', 'metric_values', 'goals', 'campaigns', 'deals', 'shifts', 'assets', 'articles']) {
      const res = await db().execute(sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE workspace_id = ${r.workspaceId}`);
      expect((res.rows[0] as { n: number }).n, table).toBe(0);
    }
    // The only password is the random one-time password; well-known defaults never sign in.
    const anon = await clientFor(undefined, { ip: '10.0.1.1' });
    for (const password of ['admin', 'password', 'castlane', 'changeme']) {
      const a = await anon.attempt(authEndpoints.signIn, { body: { email: 'boot@test.invalid', password } });
      expect(a.status, password).toBe(401);
    }

    // The Owner must replace the one-time password before any workspace data is reachable.
    const owner = await clientFor(await sessionFor(db(), r.userId), { ip: '10.0.1.2' });
    const blocked = await owner.attempt(overviewEndpoints.get, { params: { workspaceId: r.workspaceId }, query: {} });
    expect(blocked.status).toBe(403);
    await owner.call(authEndpoints.changePassword, { body: { currentPassword: r.temporaryPassword!, newPassword: 'the owner chose this passphrase' } });

    // Overview of the empty workspace: a setup checklist, no KPI numbers, trend or finance figures.
    const overview = await owner.call(overviewEndpoints.get, { params: { workspaceId: r.workspaceId }, query: {} });
    expect(overview.setup.empty).toBe(true);
    expect(overview.setup.steps.map((s) => [s.key, s.done])).toEqual([
      ['project', false],
      ['account', false],
      ['task', false],
    ]);
    expect(overview.kpis).toEqual([]);
    expect(overview.trend.series).toEqual([]);
    expect(overview.trend.unavailableReason).toMatch(/No projects yet/);
    expect(overview.needsAttention).toEqual({ counts: [], total: 0, items: [] });
    expect(overview.projects).toEqual({ items: [], total: 0 });
    expect(overview.finance).toBeUndefined();
    expect(overview.freshness).toBeUndefined();
  });
});

describe('sign-in', () => {
  it('does not reveal whether an account exists and never sets a session on failure', async () => {
    const c = await clientFor();
    const a = await c.attempt(authEndpoints.signIn, { body: { email: 'nobody@test.invalid', password: 'whatever password' } });
    expect(a.status).toBe(401);
    expect(a.error?.message).toBe('The e-mail or password is incorrect.');
    expect(c.cookies.has('castlane_session')).toBe(false);
  });

  it('rate-limits repeated failures for an account', async () => {
    const ws = await createWorkspace(db());
    const c = await clientFor();
    let last = 0;
    for (let i = 0; i < 6; i++) {
      const a = await c.attempt(authEndpoints.signIn, { body: { email: ws.owner.email, password: 'wrong password!!' } });
      last = a.status;
    }
    expect(last).toBe(429);
  }, 60_000);

  it('recovery response is identical for unknown and known e-mails (T007)', async () => {
    const ws = await createWorkspace(db());
    const c = await clientFor();
    const a = await c.call(authEndpoints.recovery, { body: { email: 'unknown@test.invalid' } });
    const b = await c.call(authEndpoints.recovery, { body: { email: ws.owner.email } });
    expect(a).toEqual(b);
  });

  it('owner must set up MFA; TOTP codes cannot be replayed; a recovery code works once (T009, T010)', async () => {
    const ws = await createWorkspace(db());
    const c = await clientFor();
    const r = await c.call(authEndpoints.signIn, { body: { email: ws.owner.email, password: DEFAULT_TEST_PASSWORD } });
    expect(r.status).toBe('mfa_setup_required');
    if (r.status !== 'mfa_setup_required') return;
    const setup = await c.call(authEndpoints.mfaSetupStart, { body: { challengeId: r.challengeId } });
    const totp = new TOTP({ secret: Secret.fromBase32(setup.secret), digits: 6, period: 30 });
    const code = totp.generate();
    const confirmed = await c.call(authEndpoints.mfaSetupConfirm, { body: { challengeId: setup.challengeId, code } });
    expect(confirmed.recoveryCodes).toHaveLength(10);

    // Next sign-in requires verification; the already-used step is rejected (replay protection).
    const c2 = await clientFor();
    const again = await c2.call(authEndpoints.signIn, { body: { email: ws.owner.email, password: DEFAULT_TEST_PASSWORD } });
    expect(again.status).toBe('mfa_required');
    if (again.status !== 'mfa_required') return;
    const replay = await c2.attempt(authEndpoints.mfaVerify, { body: { challengeId: again.challengeId, code, kind: 'totp' } });
    expect(replay.status).toBe(401);
    // Recovery code works exactly once.
    const rc = confirmed.recoveryCodes[0]!;
    const ok = await c2.attempt(authEndpoints.mfaVerify, { body: { challengeId: again.challengeId, code: rc, kind: 'recovery' } });
    expect(ok.ok).toBe(true);
    const c3 = await clientFor();
    const third = await c3.call(authEndpoints.signIn, { body: { email: ws.owner.email, password: DEFAULT_TEST_PASSWORD } });
    if (third.status !== 'mfa_required') throw new Error('expected mfa');
    const reuse = await c3.attempt(authEndpoints.mfaVerify, { body: { challengeId: third.challengeId, code: rc, kind: 'recovery' } });
    expect(reuse.status).toBe(401);
    const [u] = await db().select().from(users).where(eq(users.id, ws.owner.userId));
    expect(decryptSecret(u!.mfaSecretEnc!, getAppServices().config.MFA_ENCRYPTION_KEY)).toBe(setup.secret);
  });

  it('a session without MFA cannot reach workspace data when the role requires MFA', async () => {
    const ws = await createWorkspace(db());
    const token = await sessionFor(db(), ws.owner.userId, { mfaVerified: false });
    const c = new TestClient(token);
    c.csrf = 'x';
    const r = await c.attempt(setupEndpoints.progress, { params: { workspaceId: ws.workspaceId } });
    expect(r.code).toBe('MFA_REQUIRED');
  });
});

describe('password reset and MFA failures (T008, T009)', () => {
  let n = 0;
  const IP = () => `10.0.9.${++n}`;
  const enrol = async (email: string) => {
    const c = await clientFor(undefined, { ip: IP() });
    const r = await c.call(authEndpoints.signIn, { body: { email, password: DEFAULT_TEST_PASSWORD } });
    if (r.status !== 'mfa_setup_required') throw new Error('expected MFA setup');
    const setup = await c.call(authEndpoints.mfaSetupStart, { body: { challengeId: r.challengeId } });
    const totp = new TOTP({ secret: Secret.fromBase32(setup.secret), digits: 6, period: 30 });
    const code = totp.generate();
    await c.call(authEndpoints.mfaSetupConfirm, { body: { challengeId: setup.challengeId, code } });
    return { client: c, usedCode: code };
  };

  it('a reset token works once; the second use is rejected and the old sessions are revoked (T008)', async () => {
    const ws = await createWorkspace(db());
    const existing = await sessionFor(db(), ws.owner.userId);
    const anon = await clientFor(undefined, { ip: IP() });
    await anon.call(authEndpoints.recovery, { body: { email: ws.owner.email } });
    const mail = await db().execute(`SELECT payload FROM jobs WHERE type = 'mail.send' AND payload->>'template' = 'passwordReset' ORDER BY created_at DESC LIMIT 1`);
    const token = (mail.rows[0] as { payload: { vars: { resetUrl: string } } }).payload.vars.resetUrl.split('/').pop()!;
    await anon.call(authEndpoints.reset, { body: { token, newPassword: 'a brand new passphrase 2026' } });
    const replay = await anon.attempt(authEndpoints.reset, { body: { token, newPassword: 'another new passphrase 2026' } });
    expect(replay.status).toBe(409);
    expect(replay.error?.message).toMatch(/already been used/);
    // Every earlier session is revoked; the old one no longer reaches workspace data.
    const open = await db().select().from(sessions).where(and(eq(sessions.userId, ws.owner.userId), isNull(sessions.revokedAt)));
    expect(open).toEqual([]);
    const stale = new TestClient(existing);
    stale.csrf = 'x';
    expect((await stale.attempt(setupEndpoints.progress, { params: { workspaceId: ws.workspaceId } })).status).toBe(401);
    // The first new password stays in force (the replay changed nothing).
    const c = await clientFor(undefined, { ip: IP() });
    const ok = await c.call(authEndpoints.signIn, { body: { email: ws.owner.email, password: 'a brand new passphrase 2026' } });
    expect(['mfa_required', 'mfa_setup_required']).toContain(ok.status);
    const wrong = await c.attempt(authEndpoints.signIn, { body: { email: ws.owner.email, password: 'another new passphrase 2026' } });
    expect(wrong.status).toBe(401);
  });

  it('wrong or repeated TOTP codes create no session, are rate-limited and audited without the code (T009)', async () => {
    const ws = await createWorkspace(db());
    const { usedCode } = await enrol(ws.owner.email);
    const c = await clientFor(undefined, { ip: IP() });
    const again = await c.call(authEndpoints.signIn, { body: { email: ws.owner.email, password: DEFAULT_TEST_PASSWORD } });
    if (again.status !== 'mfa_required') throw new Error('expected mfa');
    const valid = usedCode;
    const wrongCode = valid === '000000' ? '111111' : '000000';
    const statuses: number[] = [];
    // The code used for setup is a replay; then wrong codes until the challenge is locked.
    statuses.push((await c.attempt(authEndpoints.mfaVerify, { body: { challengeId: again.challengeId, code: valid, kind: 'totp' } })).status);
    for (let i = 0; i < 5; i++) statuses.push((await c.attempt(authEndpoints.mfaVerify, { body: { challengeId: again.challengeId, code: wrongCode, kind: 'totp' } })).status);
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses[5]).toBe(429);
    expect(c.cookies.has('castlane_session')).toBe(false);
    const open = await db().select().from(sessions).where(and(eq(sessions.userId, ws.owner.userId), isNull(sessions.revokedAt)));
    // Only the session created by the setup step exists; the failed challenge created none.
    expect(open).toHaveLength(1);
    const failures = await db().select().from(auditEvents).where(and(eq(auditEvents.actorUserId, ws.owner.userId), eq(auditEvents.action, 'auth.mfa_failed')));
    expect(failures).toHaveLength(5);
    const serialized = JSON.stringify(failures);
    expect(serialized).not.toContain(valid);
    expect(serialized).not.toContain(wrongCode);
  });
});

describe('CSRF and session', () => {
  it('rejects mutations without a valid CSRF token or from another origin, revoking nothing (T161)', async () => {
    const ws = await createWorkspace(db());
    // A second open session of the same user: revoke-others would end it if any request got through.
    await sessionFor(db(), ws.owner.userId);
    const c = await clientFor(await sessionFor(db(), ws.owner.userId));
    const noToken = await c.raw('POST', '/auth/sessions/revoke-others', { headers: { 'x-csrf-token': 'bad' } });
    expect(noToken.status).toBe(403);
    expect((await noToken.json()).error.code).toBe('CSRF_REJECTED');
    // Valid session token, forged Origin (the client sends the Origin header it is given).
    const cross = await c.raw('POST', '/auth/sessions/revoke-others', { headers: { origin: 'https://evil.example' } });
    expect(cross.status).toBe(403);
    expect((await cross.json()).error.code).toBe('CSRF_REJECTED');
    const open = await db().select().from(sessions).where(and(eq(sessions.userId, ws.owner.userId), isNull(sessions.revokedAt)));
    expect(open).toHaveLength(2);
    // The same request from the application origin does go through (the checks above were the cause).
    const same = await c.raw('POST', '/auth/sessions/revoke-others');
    expect(same.status).toBe(200);
    expect(await db().select().from(sessions).where(and(eq(sessions.userId, ws.owner.userId), isNull(sessions.revokedAt)))).toHaveLength(1);
  });

  it('an edit with an expired session is refused without a fake save; sign-in returns to a permitted route (T011)', async () => {
    const ws = await createWorkspace(db());
    const other = await createWorkspace(db());
    const p = await createProject(db(), ws, { name: 'Night Shift' });
    const lead = await addMember(db(), ws, { roleKey: 'project_lead', scopeType: 'assigned_projects' });
    await assignToProject(db(), ws, p.id, lead.membershipId);
    const signIn = async (c: TestClient, returnTo: string) => {
      await c.init(); // pre-session CSRF token, as the sign-in page loads it
      const r = await c.call(authEndpoints.signIn, { body: { email: lead.email, password: DEFAULT_TEST_PASSWORD, returnTo } });
      if (r.status !== 'signed_in') throw new Error(`expected a session, got ${r.status}`);
      await c.init();
      return r.redirectTo;
    };

    const c = await clientFor(undefined, { ip: '10.0.2.1' });
    const projectPath = `/w/${ws.workspaceId}/projects/${p.id}`;
    expect(await signIn(c, projectPath)).toBe(projectPath);
    const before = await c.call(projectEndpoints.get, { params: { workspaceId: ws.workspaceId, projectId: p.id } });

    // The session expires while the edit form is open; Save is refused and nothing is written.
    await db().update(sessions).set({ idleExpiresAt: new Date(Date.now() - 1000) }).where(eq(sessions.userId, lead.userId));
    const save = await c.attempt(projectEndpoints.update, { params: { workspaceId: ws.workspaceId, projectId: p.id }, body: { name: 'Edited while expired' } }, { ifMatch: before.rowVersion });
    expect(save.status).toBe(401);
    expect(save.code).toBe('UNAUTHENTICATED');
    expect(c.lastHeaders?.getSetCookie().find((h) => h.startsWith(`${SESSION_COOKIE}=`))).toMatch(/Max-Age=0/);
    expect(c.cookies.has(SESSION_COOKIE)).toBe(false);
    const [row] = await db().select().from(projects).where(eq(projects.id, p.id));
    expect(row?.name).toBe('Night Shift');
    expect(row?.rowVersion).toBe(before.rowVersion);

    // Signing in again returns to the page that was open; the record is as it was, and the edit
    // can now be saved for real.
    expect(await signIn(c, projectPath)).toBe(projectPath);
    const again = await c.call(projectEndpoints.get, { params: { workspaceId: ws.workspaceId, projectId: p.id } });
    expect(again.name).toBe('Night Shift');
    expect((await c.call(projectEndpoints.update, { params: { workspaceId: ws.workspaceId, projectId: p.id }, body: { name: 'Edited after sign-in' } }, { ifMatch: again.rowVersion })).name).toBe('Edited after sign-in');

    // A return route the user may not open (another workspace, another site, auth pages) falls back
    // to the user's own landing page.
    const landing = `/w/${ws.workspaceId}/overview`;
    for (const returnTo of [`/w/${other.workspaceId}/projects`, 'https://evil.example/w', '//evil.example', '/auth/sign-out']) {
      const fresh = await clientFor(undefined, { ip: '10.0.2.2' });
      expect(await signIn(fresh, returnTo), returnTo).toBe(landing);
    }
  });
});

describe('invitations', () => {
  it('accepting twice creates one user and one membership (T004)', async () => {
    const ws = await createWorkspace(db());
    const owner = await clientFor(await sessionFor(db(), ws.owner.userId));
    const creator = await ws.roleId('creator');
    const res = await owner.call(setupEndpoints.inviteTeam, {
      params: { workspaceId: ws.workspaceId },
      body: { invitations: [{ email: 'new.person@test.invalid', roleId: creator, scopeType: 'assigned_projects', scopeId: null }], finish: false },
    });
    expect(res.results[0]?.outcome).toBe('queued');
    // Obtain the raw token by re-issuing through the use case is not possible (only hashes are stored),
    // so drive acceptance through a resend with a known token from the job payload.
    const job = await db().execute(`SELECT payload FROM jobs WHERE type = 'mail.send' ORDER BY created_at DESC LIMIT 1`);
    const url = (job.rows[0] as { payload: { vars: { inviteUrl: string } } }).payload.vars.inviteUrl;
    const token = url.split('/').pop()!;
    const anon = await clientFor();
    const info = await anon.call(authEndpoints.invitationInfo, { params: { token } });
    expect(info.status).toBe('valid');
    const a1 = await anon.call(authEndpoints.acceptInvitation, { body: { token, displayName: 'New Person', password: 'a strong password 1' } });
    expect(a1.status).toBe('signed_in');
    const anon2 = await clientFor();
    const a2 = await anon2.attempt(authEndpoints.acceptInvitation, { body: { token, password: 'a strong password 1' } });
    expect(a2.ok).toBe(true);
    const members = await db().select().from(memberships).where(eq(memberships.workspaceId, ws.workspaceId));
    expect(members).toHaveLength(2);
    const people = await db().select().from(users).where(eq(users.normalizedEmail, 'new.person@test.invalid'));
    expect(people).toHaveLength(1);
  });

  it('resend revokes the previous token; expired invitations grant nothing (T005, T006)', async () => {
    const ws = await createWorkspace(db());
    const owner = await clientFor(await sessionFor(db(), ws.owner.userId));
    const viewer = await ws.roleId('viewer');
    const invite = () =>
      owner.call(setupEndpoints.inviteTeam, {
        params: { workspaceId: ws.workspaceId },
        body: { invitations: [{ email: 'again@test.invalid', roleId: viewer, scopeType: 'workspace', scopeId: null }], finish: false },
      });
    await invite();
    const first = await db().execute(`SELECT payload FROM jobs WHERE type = 'mail.send' ORDER BY created_at DESC LIMIT 1`);
    const t1 = (first.rows[0] as { payload: { vars: { inviteUrl: string } } }).payload.vars.inviteUrl.split('/').pop()!;
    const second = await invite();
    expect(second.results[0]?.outcome).toBe('resent');
    const anon = await clientFor();
    expect((await anon.call(authEndpoints.invitationInfo, { params: { token: t1 } })).status).toBe('revoked');
    await db().update(invitations).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invitations.workspaceId, ws.workspaceId));
    const newest = await db().execute(`SELECT payload FROM jobs WHERE type = 'mail.send' ORDER BY created_at DESC LIMIT 1`);
    const t2 = (newest.rows[0] as { payload: { vars: { inviteUrl: string } } }).payload.vars.inviteUrl.split('/').pop()!;
    const r = await anon.attempt(authEndpoints.acceptInvitation, { body: { token: t2, displayName: 'Late', password: 'a strong password 1' } });
    expect(r.status).toBe(409);
  });

  it('the setup wizard (and its invitations) is Owner-only: an Admin is refused', async () => {
    const ws = await createWorkspace(db());
    const admin = await addMember(db(), ws, { roleKey: 'admin' });
    const c = await clientFor(await sessionFor(db(), admin.userId));
    // Admin self-escalation through the Team module is covered in tests/integration/team/access.test.ts.
    const r = await c.attempt(setupEndpoints.progress, { params: { workspaceId: ws.workspaceId } });
    expect(r.status).toBe(403);
  });
});
