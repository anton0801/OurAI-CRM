import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { newIdempotencyKey } from '@castlane/api-client';
import { healthEndpoints, inboxEndpoints, incidentEndpoints } from '@castlane/api-contracts';
import { getAppServices, recordBackupRun, runHealthMonitor } from '@castlane/application';
import { backupRuns, incidents, jobs, sessions } from '@castlane/database';
import { newId } from '@castlane/domain';
import { addMember, assignToProject, clientFor, createProject, createWorkspace, sessionFor, TestClient } from '../../support';
import { db } from './helpers';

const setup = async () => {
  const ws = await createWorkspace(db());
  const owner = await clientFor(await sessionFor(db(), ws.owner.userId));
  const admin = await addMember(db(), ws, { roleKey: 'admin' });
  const ac = await clientFor(await sessionFor(db(), admin.userId));
  return { ws, owner, admin, ac, params: { workspaceId: ws.workspaceId } };
};

describe('System health (S71)', () => {
  it('exposes public liveness/readiness without metadata or a session', async () => {
    const anon = await new TestClient().init();
    expect(await anon.call(healthEndpoints.live, {})).toEqual({ status: 'ok' });
    const ready = await anon.call(healthEndpoints.ready, {});
    expect(ready).toEqual({ status: 'ready', checks: { database: 'ok', storage: 'ok' } });
  });

  it('is for administrators; lists dead-lettered jobs and retries them idempotently', async () => {
    const { ws, ac, params } = await setup();
    const creator = await addMember(db(), ws, { roleKey: 'creator', scopeType: 'assigned_projects' });
    const cc = await clientFor(await sessionFor(db(), creator.userId));
    expect((await cc.attempt(healthEndpoints.system, { params })).status).toBe(403);
    const jobId = newId();
    await db().insert(jobs).values({ id: jobId, workspaceId: ws.workspaceId, type: 'mail.send', state: 'dead', attempts: 6, lastErrorCode: 'ECONNREFUSED', lastErrorMessage: 'SMTP unreachable', finishedAt: new Date(), idempotencyKey: `test:${jobId}` });
    const health = await ac.call(healthEndpoints.system, { params });
    expect(health.deadLettered).toBeGreaterThanOrEqual(1);
    const listed = await ac.call(healthEndpoints.jobs, { params, query: {} });
    expect(listed.items.find((j) => j.id === jobId)).toMatchObject({ state: 'dead', canRetry: true, lastErrorCode: 'ECONNREFUSED' });
    const key = newIdempotencyKey();
    await ac.call(healthEndpoints.retryJob, { params: { ...params, jobId }, body: { reason: 'SMTP fixed' } }, { idempotencyKey: key });
    await ac.call(healthEndpoints.retryJob, { params: { ...params, jobId }, body: { reason: 'SMTP fixed' } }, { idempotencyKey: key });
    const [j] = await db().select().from(jobs).where(eq(jobs.id, jobId));
    expect(j).toMatchObject({ state: 'queued', attempts: 0, idempotencyKey: `test:${jobId}` });
    expect((await ac.attempt(healthEndpoints.retryJob, { params: { ...params, jobId }, body: {} })).status).toBe(409);
  });

  it('reports Backup Healthy only for a confirmed fresh backup; restore tests are separate', async () => {
    const { ws, ac, params } = await setup();
    await db().delete(backupRuns);
    const now = getAppServices().clock.now();
    expect((await ac.call(healthEndpoints.system, { params })).backup.healthy).toBe(false);
    await runHealthMonitor(getAppServices());
    const alerts = await db().select().from(incidents).where(and(eq(incidents.workspaceId, ws.workspaceId), eq(incidents.alertKey, 'backup.stale')));
    expect(alerts).toHaveLength(1);
    await runHealthMonitor(getAppServices());
    expect(await db().select().from(incidents).where(and(eq(incidents.workspaceId, ws.workspaceId), eq(incidents.alertKey, 'backup.stale')))).toHaveLength(1);
    await recordBackupRun(db(), { kind: 'backup', status: 'running', startedAt: new Date(now.getTime() - 3_600_000), reportedBy: 'backup-cron' });
    expect((await ac.call(healthEndpoints.system, { params })).backup.healthy).toBe(false);
    await recordBackupRun(db(), { kind: 'backup', status: 'succeeded', startedAt: new Date(now.getTime() - 30 * 3_600_000), finishedAt: new Date(now.getTime() - 29 * 3_600_000), reportedBy: 'backup-cron' });
    expect((await ac.call(healthEndpoints.system, { params })).backup.healthy).toBe(false);
    await recordBackupRun(db(), { kind: 'backup', status: 'succeeded', startedAt: new Date(now.getTime() - 2 * 3_600_000), finishedAt: new Date(now.getTime() - 3_600_000), reportedBy: 'backup-cron' });
    const h = await ac.call(healthEndpoints.system, { params });
    expect(h.backup.healthy).toBe(true);
    expect(h.backup.lastRestoreTestAt).toBeNull();
    await runHealthMonitor(getAppServices());
    const [cleared] = await db().select().from(incidents).where(and(eq(incidents.workspaceId, ws.workspaceId), eq(incidents.alertKey, 'backup.stale')));
    expect(cleared!.state).toBe('resolved');
    await db().update(sessions).set({ recentAuthAt: new Date() });
    await ac.call(healthEndpoints.recordRestoreDrill, { params, body: { status: 'succeeded', startedAt: new Date(now.getTime() - 7200_000).toISOString(), finishedAt: new Date(now.getTime() - 3600_000).toISOString(), recoveredTimestamp: new Date(now.getTime() - 9000_000).toISOString(), missingObjects: 0, verifiedCounts: 'projects 12, assets 40' } });
    const h2 = await ac.call(healthEndpoints.system, { params });
    expect(h2.backup.lastRestoreResult).toBe('succeeded');
    const runs = await ac.call(healthEndpoints.backups, { params, query: { kind: 'restore_drill' } });
    expect(runs[0]!.details).toMatchObject({ missingObjects: 0 });
  });
});

describe('Incidents (S71)', () => {
  it('logs operational incidents in scope, notifies the owner and follows the lifecycle', async () => {
    const { ws, owner, params } = await setup();
    const { id: projectId } = await createProject(db(), ws, { name: 'Model X', type: 'model' });
    const { id: otherProject } = await createProject(db(), ws, { name: 'Model Y', type: 'model' });
    const lead = await addMember(db(), ws, { roleKey: 'project_lead', scopeType: 'assigned_projects' });
    await assignToProject(db(), ws, projectId, lead.membershipId);
    const c = await clientFor(await sessionFor(db(), lead.userId));
    const inc = await c.call(incidentEndpoints.create, { params, body: { title: 'Account restricted by platform', severity: 'high', projectId, ownerMembershipId: ws.owner.membershipId, description: 'Posting blocked since 09:00' } });
    expect(inc).toMatchObject({ kind: 'operational', state: 'open', project: { id: projectId } });
    expect((await c.attempt(incidentEndpoints.create, { params, body: { title: 'Elsewhere', severity: 'low', projectId: otherProject } })).status).toBe(404);
    const inbox = await owner.call(inboxEndpoints.list, { params, query: {} });
    expect(inbox.items.map((i) => i.eventType)).toContain('incident.assigned');
    const ack = await owner.call(incidentEndpoints.acknowledge, { params: { ...params, incidentId: inc.id } }, { ifMatch: inc.rowVersion });
    expect(ack.state).toBe('investigating');
    const stale = await owner.attempt(incidentEndpoints.resolve, { params: { ...params, incidentId: inc.id }, body: { resolution: 'Appeal accepted' } }, { ifMatch: inc.rowVersion });
    expect(stale.code).toBe('VERSION_CONFLICT');
    const resolved = await owner.call(incidentEndpoints.resolve, { params: { ...params, incidentId: inc.id }, body: { resolution: 'Appeal accepted by the platform' } }, { ifMatch: ack.rowVersion });
    expect(resolved).toMatchObject({ state: 'resolved', resolution: 'Appeal accepted by the platform' });
    const again = await owner.attempt(incidentEndpoints.acknowledge, { params: { ...params, incidentId: inc.id } }, { ifMatch: resolved.rowVersion });
    expect(again.status).toBe(409);
    const reopened = await owner.call(incidentEndpoints.reopen, { params: { ...params, incidentId: inc.id }, body: { reason: 'Restricted again' } }, { ifMatch: resolved.rowVersion });
    expect(reopened.state).toBe('open');
    // Operational incidents never change technical health.
    const creator = await addMember(db(), ws, { roleKey: 'creator', scopeType: 'assigned_projects' });
    const cc = await clientFor(await sessionFor(db(), creator.userId));
    expect((await cc.attempt(incidentEndpoints.get, { params: { ...params, incidentId: inc.id } })).status).toBe(404);
    expect((await cc.attempt(incidentEndpoints.list, { params, query: { kind: 'system' } })).status).toBe(403);
  });
});
