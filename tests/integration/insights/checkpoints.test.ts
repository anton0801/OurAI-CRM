import { describe, expect, it } from 'vitest';
import { and, eq, like } from 'drizzle-orm';
import { metricsEndpoints as M } from '@castlane/api-contracts';
import { cancelPublicationCheckpoints, executeSystemCommand, getAppServices, runMetricCheckpointMaintenance, systemJobContext } from '@castlane/application';
import { notifications, publications, socialAccounts } from '@castlane/database';
import { at, createCheckpoints, cumulativeBody, db, insertPublication, insightsFixture, memberOf, query, record, result, snapshotBody } from './helpers';

const FULL = { 'publication.views': '500', 'publication.likes': '40', 'publication.comments': '5', 'publication.shares': '3', 'publication.saves': '2' };

describe('Metrics Inbox and checkpoints (S49)', () => {
  it('keeps the real observed time of a late checkpoint entry and excludes it from the standard window (T068)', async () => {
    const f = await insightsFixture();
    const pub = await insertPublication(f, { publishedAt: at(10, 12) });
    await createCheckpoints(f, { id: pub, publishedAt: at(10, 12) });
    const pm = await f.owner.call(M.publicationMetrics, { params: { ...f.p, publicationId: pub } });
    expect(pm.checkpoints.map((c) => c.checkpointKey).sort()).toEqual(['pub_24h', 'pub_7d']);
    const cp24 = pm.checkpoints.find((c) => c.checkpointKey === 'pub_24h')!;
    expect(cp24).toMatchObject({ expectedAt: at(9, 12), windowStart: at(9, 10), windowEnd: at(9, 14), status: 'overdue', label: '24 h after publication' });
    expect(cp24.requiredMetrics).toContain('publication.views');
    const overdue = await f.owner.call(M.checkpoints, { params: f.p, query: { tab: 'overdue' } });
    expect(overdue.items.map((c) => c.id)).toContain(cp24.id);

    // Add Metrics from the inbox 30 h after publication: allowed, labelled Late, observed time kept.
    const body = { ...cumulativeBody(pub, at(9, 18), FULL), checkpointId: cp24.id };
    const v = await f.owner.call(M.validate, { params: f.p, body });
    expect(v.checkpoint?.timing).toBe('late');
    expect(v.warnings.map((w) => w.code)).toContain('CHECKPOINT_LATE');
    expect(v.requiresWarningNote).toBe(false);
    const late = await record(f.owner, f, body);
    expect(late.observedAt).toBe(at(9, 18));
    expect(late.checkpoint).toMatchObject({ id: cp24.id, timing: 'late' });
    const done = await f.owner.call(M.checkpoint, { params: { ...f.p, checkpointId: cp24.id } });
    expect(done).toMatchObject({ state: 'completed', status: 'completed', timing: 'late', observedAt: at(9, 18), observationId: late.id });
    expect(done.completeness?.status).toBe('known');

    // Not part of the comparable 24 h set.
    const m14 = result(await query(f.owner, f, ['M14'], 12, 1), 'M14').total;
    expect(m14.status).toBe('no_data');
    expect(m14.value).toBeNull();
    expect(m14.excluded).toEqual([{ count: 1, reason: 'Recorded outside the target window (Early/Late)' }]);

    // An on-time entry of another publication is matched automatically and counted.
    const pub2 = await insertPublication(f, { publishedAt: at(10, 12) });
    await createCheckpoints(f, { id: pub2, publishedAt: at(10, 12) });
    const onTime = await record(f.owner, f, cumulativeBody(pub2, at(9, 13), { ...FULL, 'publication.views': '300' }));
    expect(onTime.checkpoint?.timing).toBe('on_time');
    const both = result(await query(f.owner, f, ['M14'], 12, 1), 'M14').total;
    expect(both).toMatchObject({ status: 'known', value: '300', sampleSize: 1 });
    expect(both.excluded).toEqual([{ count: 1, reason: 'Recorded outside the target window (Early/Late)' }]);
  });

  it('closes a checkpoint as Missing without creating values; Missing is expected but never usable (T114)', async () => {
    const f = await insightsFixture();
    const pub = await insertPublication(f, { publishedAt: at(12, 12) });
    await createCheckpoints(f, { id: pub, publishedAt: at(12, 12) });
    const pm = await f.owner.call(M.publicationMetrics, { params: { ...f.p, publicationId: pub } });
    const cp7 = pm.checkpoints.find((c) => c.checkpointKey === 'pub_7d')!;
    await record(f.owner, f, cumulativeBody(pub, at(11, 12), FULL));

    const missing = await f.owner.call(M.markMissing, { params: { ...f.p, checkpointId: cp7.id }, body: { reason: 'The post was removed by the platform' } }, { ifMatch: cp7.rowVersion });
    expect(missing).toMatchObject({ state: 'missing', status: 'missing', missingReason: 'The post was removed by the platform', observationId: null });
    const again = await f.owner.attempt(M.markMissing, { params: { ...f.p, checkpointId: cp7.id }, body: { reason: 'Again' } }, { ifMatch: missing.rowVersion });
    expect(again.status).toBe(409);
    const tab = await f.owner.call(M.checkpoints, { params: f.p, query: { tab: 'missing' } });
    expect(tab.items.map((c) => c.id)).toEqual([cp7.id]);
    const obs = await f.owner.call(M.observations, { params: f.p, query: { publicationId: pub } });
    expect(obs.items).toHaveLength(1);

    const m40 = result(await query(f.owner, f, ['M40'], 14, 1), 'M40').total;
    expect(m40.status).toBe('known');
    expect(Number(m40.value)).toBe(50);
    expect(m40.coverage).toEqual({ usable: 1, expected: 2 });
    expect(m40.excluded).toEqual([{ count: 1, reason: 'Closed as Missing' }]);
  });

  it('lists inbox tabs and counts within the member scope; cancellation keeps completed checkpoints', async () => {
    const f = await insightsFixture();
    const lead = await memberOf(f, 'project_lead', { projects: [f.projectId] });
    const alpha = await insertPublication(f, { publishedAt: at(3, 12) });
    const beta = await insertPublication(f, { projectId: f.otherProjectId, accountId: f.otherAccountId, publishedAt: at(3, 12) });
    await createCheckpoints(f, { id: alpha, publishedAt: at(3, 12) });
    await createCheckpoints(f, { id: beta, accountId: f.otherAccountId, projectId: f.otherProjectId, publishedAt: at(3, 12) });
    const dueNowAt = new Date(Date.now() - 24 * 3_600_000).toISOString();
    const dueNow = await insertPublication(f, { publishedAt: dueNowAt });
    await createCheckpoints(f, { id: dueNow, publishedAt: dueNowAt });

    const ownerSummary = await f.owner.call(M.inboxSummary, { params: f.p, query: {} });
    expect(ownerSummary).toMatchObject({ due: 1, overdue: 2, upcoming: 3, submitted: 0, missing: 0, needsReview: 0 });
    const leadSummary = await lead.client.call(M.inboxSummary, { params: f.p, query: {} });
    expect(leadSummary).toMatchObject({ due: 1, overdue: 1, upcoming: 2 });
    const mine = await lead.client.call(M.inboxSummary, { params: f.p, query: { mine: true } });
    expect(mine).toMatchObject({ due: 0, overdue: 0, upcoming: 0 });

    const leadOverdue = await lead.client.call(M.checkpoints, { params: f.p, query: { tab: 'overdue' } });
    expect(leadOverdue.items.map((c) => c.entity.publicationId)).toEqual([alpha]);
    expect(leadOverdue.items[0]!.permissions).toEqual({ addMetrics: true, markMissing: true });
    const due = await f.owner.call(M.checkpoints, { params: f.p, query: { tab: 'due' } });
    expect(due.items.map((c) => c.entity.publicationId)).toEqual([dueNow]);
    const betaCp = (await f.owner.call(M.checkpoints, { params: f.p, query: { tab: 'overdue', publicationId: beta } })).items[0]!;
    expect(betaCp.entity.publicationId).toBe(beta);
    expect((await lead.client.attempt(M.checkpoint, { params: { ...f.p, checkpointId: betaCp.id } })).status).toBe(404);

    // Submitting on-time metrics moves the due checkpoint to Submitted.
    await record(lead.client, f, cumulativeBody(dueNow, new Date(Date.now() - 60_000).toISOString(), FULL));
    const submitted = await lead.client.call(M.checkpoints, { params: f.p, query: { tab: 'submitted' } });
    expect(submitted.items).toHaveLength(1);
    expect(submitted.items[0]!.reporter?.membershipId).toBe(lead.membershipId);

    // The publications module cancels pending checkpoints of a failed publication; completed ones stay.
    const ctx = await systemJobContext(getAppServices(), f.ws.workspaceId, ['metrics.write']);
    await executeSystemCommand(ctx, (c) => cancelPublicationCheckpoints(c, dueNow, 'Publication failed'));
    const after = await f.owner.call(M.publicationMetrics, { params: { ...f.p, publicationId: dueNow } });
    expect(after.checkpoints.map((c) => [c.checkpointKey, c.state]).sort()).toEqual([
      ['pub_24h', 'completed'],
      ['pub_7d', 'cancelled'],
    ]);
  });

  it('creates account snapshot reminders once, notifies the assignee once and completes them on entry', async () => {
    const f = await insightsFixture();
    const t = new Date(Date.now() - 3_600_000);
    await db().update(socialAccounts).set({ metricsCadence: 'daily', metricsTime: t.toISOString().slice(11, 16) }).where(eq(socialAccounts.id, f.accountId));
    await db().update(socialAccounts).set({ status: 'paused' }).where(eq(socialAccounts.id, f.otherAccountId));
    await runMetricCheckpointMaintenance(getAppServices());
    await runMetricCheckpointMaintenance(getAppServices());
    const all = await f.owner.call(M.checkpoints, { params: f.p, query: { tab: 'all', accountId: f.accountId } });
    expect(all.items.map((c) => c.status).sort()).toEqual(['due', 'upcoming']);
    const dueCp = all.items.find((c) => c.status === 'due')!;
    expect(dueCp).toMatchObject({ checkpointKey: 'account_snapshot', label: 'Account snapshot', requiredMetrics: ['account.followers'] });
    expect(dueCp.assignee?.membershipId).toBe(f.ws.owner.membershipId);
    const sent = await db()
      .select()
      .from(notifications)
      .where(and(eq(notifications.workspaceId, f.ws.workspaceId), like(notifications.eventKey, 'metric.checkpoint_due:%')));
    expect(sent.map((n) => n.eventKey)).toEqual([`metric.checkpoint_due:${dueCp.id}`]);
    expect(sent[0]!.title).toBe('Metrics update needed');

    const my = await f.owner.call(M.myCheckpoints, { params: f.p });
    expect(my.canRead).toBe(true);
    expect(my.due.map((c) => c.id)).toContain(dueCp.id);

    const snap = await record(f.owner, f, snapshotBody(f.accountId, new Date(Date.now() - 60_000).toISOString(), { 'account.followers': '2400' }));
    expect(snap.checkpoint).toMatchObject({ id: dueCp.id, timing: 'on_time' });
    const acc = await f.owner.call(M.accountMetrics, { params: { ...f.p, accountId: f.accountId }, query: {} });
    expect(acc.followers.points.map((p) => p.value)).toEqual(['2400']);
    expect(acc.freshness.overdue).toBe(false);
    expect(acc.permissions.addMetrics).toBe(true);
  });

  it('shows the results of every placement of a content item within the member scope (Content → Results)', async () => {
    const f = await insightsFixture();
    const lead = await memberOf(f, 'project_lead', { projects: [f.projectId] });
    const pub = await insertPublication(f, { publishedAt: at(6, 12) });
    await createCheckpoints(f, { id: pub, publishedAt: at(6, 12) });
    // Idempotent with Mark Published: the same occurrence keys never create a second set.
    expect(await createCheckpoints(f, { id: pub, publishedAt: at(6, 12) })).toEqual([]);
    const [row] = await db().select({ contentItemId: publications.contentItemId }).from(publications).where(eq(publications.id, pub));
    const second = await insertPublication(f, { projectId: f.otherProjectId, accountId: f.otherAccountId, publishedAt: at(5, 12) });
    await db().update(publications).set({ contentItemId: row!.contentItemId }).where(eq(publications.id, second));
    await record(f.owner, f, cumulativeBody(pub, at(5, 12), FULL));
    const all = await f.owner.call(M.contentResults, { params: { ...f.p, contentItemId: row!.contentItemId } });
    expect(all.placements).toHaveLength(2);
    expect(all.hidden).toBe(0);
    const scoped = await lead.client.call(M.contentResults, { params: { ...f.p, contentItemId: row!.contentItemId } });
    expect(scoped.hidden).toBe(1);
    expect(scoped.placements).toHaveLength(1);
    const only = scoped.placements[0]!;
    expect(only.publication.id).toBe(pub);
    expect(only.checkpoints.map((c) => [c.checkpointKey, c.status]).sort()).toEqual([
      ['pub_24h', 'completed'],
      ['pub_7d', 'upcoming'],
    ]);
    expect(only.latest?.headline.find((h) => h.metricKey === 'publication.views')?.value).toBe('500');
  });
});
