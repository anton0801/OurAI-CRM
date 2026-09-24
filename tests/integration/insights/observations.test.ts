import { describe, expect, it } from 'vitest';
import { metricsEndpoints as M } from '@castlane/api-contracts';
import { EXPORT_DATASETS_REGISTRY, getAppServices, memberJobContext } from '@castlane/application';
import { newId } from '@castlane/domain';
import { at, createCheckpoints, cumulativeBody, insertPublication, insightsFixture, memberOf, periodBody, query, record, result, snapshotBody, tryRecord } from './helpers';

const fieldCodes = (r: { error: unknown }) => ((r.error as { fieldErrors?: { code: string }[] } | null)?.fieldErrors ?? []).map((e) => e.code);

const exportRows = async (workspaceId: string, membershipId: string, filters: Record<string, unknown>) => {
  const ds = EXPORT_DATASETS_REGISTRY.get('metric_observations')!;
  const ctx = (await memberJobContext(getAppServices(), workspaceId, membershipId))!;
  const out: Record<string, unknown>[] = [];
  for await (const row of ds.rows(ctx, { filters, boundAt: new Date(Date.now() + 60_000), fields: [] })) out.push(row);
  return out;
};

describe('metric observations (S50)', () => {
  it('keeps an unknown value distinct from a reported zero in the store, analytics and export (T103)', async () => {
    const f = await insightsFixture();
    const o = await record(f.owner, f, snapshotBody(f.accountId, at(3), { 'account.followers': '0', 'account.following': 'unknown', 'account.total_posts': 'not_provided' }));
    const vals = Object.fromEntries(o.values.map((v) => [v.metricKey, v]));
    expect(vals['account.followers']).toMatchObject({ availability: 'known', value: '0' });
    expect(vals['account.following']).toMatchObject({ availability: 'unknown', value: null });
    expect(vals['account.total_posts']).toMatchObject({ availability: 'not_provided', value: null });
    expect(o.knownCount).toBe(1);
    expect(o.qualityState).toBe('unverified');
    expect(o.enteredBy?.membershipId).toBe(f.ws.owner.membershipId);

    // The other account reports followers as Unknown: it is missing coverage, never a zero.
    await record(f.owner, f, snapshotBody(f.otherAccountId, at(3), { 'account.followers': 'unknown', 'account.following': '12' }));
    const x01 = result(await query(f.owner, f, ['X01'], 5, 1), 'X01').total;
    expect(x01.status).toBe('partial');
    expect(x01.value).toBe('0');
    expect(x01.coverage).toEqual({ usable: 1, expected: 2 });

    const rows = await exportRows(f.ws.workspaceId, f.ws.owner.membershipId, { accountId: f.accountId });
    const byKey = Object.fromEntries(rows.map((r) => [r.metric_key, r]));
    expect(byKey['account.followers']).toMatchObject({ availability: 'known', value: '0' });
    expect(byKey['account.following']).toMatchObject({ availability: 'unknown', value: null });
    expect(byKey['account.total_posts']).toMatchObject({ availability: 'not_provided', value: null });
  });

  it('validates values, definitions and times before saving; the validate endpoint changes nothing', async () => {
    const f = await insightsFixture();
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const inFuture = await tryRecord(f.owner, f, snapshotBody(f.accountId, future, { 'account.followers': '10' }));
    expect(inFuture.status).toBe(422);
    expect(fieldCodes(inFuture)).toContain('IN_FUTURE');

    const bad = await tryRecord(f.owner, f, {
      ...snapshotBody(f.accountId, at(2), {}),
      values: [
        { metricKey: 'account.followers', availability: 'known', value: null },
        { metricKey: 'account.following', availability: 'unknown', value: '5' },
        { metricKey: 'account.total_posts', availability: 'known', value: '1.5' },
        { metricKey: 'publication.views', availability: 'known', value: '10' },
      ],
    });
    expect(bad.status).toBe(422);
    expect(fieldCodes(bad)).toEqual(expect.arrayContaining(['REQUIRED', 'VALUE_WITHOUT_KNOWN', 'INVALID_COUNTER', 'INCOMPATIBLE_DEFINITION']));

    const onlyUnknown = await tryRecord(f.owner, f, snapshotBody(f.accountId, at(2), { 'account.followers': 'unknown' }));
    expect(fieldCodes(onlyUnknown)).toContain('NO_KNOWN_VALUE');

    const openPeriod = await tryRecord(f.owner, f, periodBody(f.accountId, at(1), new Date(Date.now() + 86_400_000).toISOString(), { 'account.views': '100' }));
    expect(fieldCodes(openPeriod)).toContain('PERIOD_NOT_OVER');

    const pub = await insertPublication(f, { publishedAt: at(5) });
    const early = await tryRecord(f.owner, f, cumulativeBody(pub, at(6), { 'publication.views': '10' }));
    expect(fieldCodes(early)).toContain('BEFORE_PUBLICATION');
    const scheduled = await insertPublication(f, { publishedAt: at(5), status: 'scheduled', scheduledAt: at(5) });
    const notLive = await tryRecord(f.owner, f, cumulativeBody(scheduled, at(4), { 'publication.views': '10' }));
    expect(fieldCodes(notLive)).toContain('NOT_PUBLISHED');

    const v = await f.owner.call(M.validate, { params: f.p, body: snapshotBody(f.accountId, at(2), { 'account.followers': '1200' }) });
    expect(v).toMatchObject({ ok: true, errors: [], duplicate: null, requiresWarningNote: false });
    const list = await f.owner.call(M.observations, { params: f.p, query: { accountId: f.accountId } });
    expect(list.items).toHaveLength(0);
  });

  it('refuses a duplicate key (409 with the existing record) and replays the same idempotency key', async () => {
    const f = await insightsFixture();
    const body = snapshotBody(f.accountId, at(2, 9), { 'account.followers': '1500' });
    const key = newId();
    const first = await record(f.owner, f, body, { idempotencyKey: key });
    const replay = await record(f.owner, f, body, { idempotencyKey: key });
    expect(replay.id).toBe(first.id);
    const dup = await tryRecord(f.owner, f, body);
    expect(dup.status).toBe(409);
    expect(dup.code).toBe('DUPLICATE');
    expect((dup.error as { details?: { observationId?: string } }).details?.observationId).toBe(first.id);
    const v = await f.owner.call(M.validate, { params: f.p, body });
    expect(v.duplicate?.observationId).toBe(first.id);
    const list = await f.owner.call(M.observations, { params: f.p, query: { accountId: f.accountId } });
    expect(list.items).toHaveLength(1);
    expect(list.items[0]!.headline.find((h) => h.metricKey === 'account.followers')?.value).toBe('1500');
  });

  it('requires a note for implausible values and keeps an alternate source out of reports until chosen', async () => {
    const f = await insightsFixture();
    const pub = await insertPublication(f, { publishedAt: at(6) });
    const implausible = cumulativeBody(pub, at(5, 12), { 'publication.views': '100', 'publication.completions': '140' });
    const noNote = await tryRecord(f.owner, f, implausible);
    expect(fieldCodes(noNote)).toEqual(['NOTE_REQUIRED']);
    const saved = await record(f.owner, f, { ...implausible, warningNote: 'Source counts replays as completions.' });
    expect(saved.warnings).toContain('COMPLETIONS_ABOVE_VIEWS');
    expect(saved.warningNote).toBe('Source counts replays as completions.');
    expect(saved.canonical).toBe(true);

    // A second source for the same moment: saved, flagged, not used in reports.
    const alt = await record(f.owner, f, { ...cumulativeBody(pub, at(5, 12), { 'publication.views': '90' }), sourceType: 'external_report', sourceNamespace: 'agency_sheet' });
    expect(alt.canonical).toBe(false);
    expect(alt.warnings).toContain('ALTERNATE_SOURCE');
    expect(alt.alternates.map((a) => a.id)).toContain(saved.id);
    const switched = await f.owner.call(M.setCanonical, { params: { ...f.p, observationId: alt.id }, body: { canonical: true, reason: 'Agency sheet is the audited source' } }, { ifMatch: alt.rowVersion });
    expect(switched.canonical).toBe(true);
    const before = await f.owner.call(M.get, { params: { ...f.p, observationId: saved.id } });
    expect(before.canonical).toBe(false);
  });

  it('scopes reads and writes: another project is 404, reads are filtered before pagination', async () => {
    const f = await insightsFixture();
    const lead = await memberOf(f, 'project_lead', { projects: [f.projectId] });
    const viewer = await memberOf(f, 'viewer', { projects: [f.projectId] });
    const mine = await record(lead.client, f, snapshotBody(f.accountId, at(2), { 'account.followers': '300' }));
    const theirs = await record(f.owner, f, snapshotBody(f.otherAccountId, at(2), { 'account.followers': '900' }));
    const hidden = await lead.client.attempt(M.get, { params: { ...f.p, observationId: theirs.id } });
    expect(hidden.status).toBe(404);
    const write = await tryRecord(lead.client, f, snapshotBody(f.otherAccountId, at(1), { 'account.followers': '901' }));
    expect(write.status).toBe(404);
    const list = await lead.client.call(M.observations, { params: f.p, query: {} });
    expect(list.items.map((o) => o.id)).toEqual([mine.id]);
    // Read-only access: visible, but writing is forbidden (403, the record exists for them).
    const ro = await tryRecord(viewer.client, f, snapshotBody(f.accountId, at(1), { 'account.followers': '301' }));
    expect(ro.status).toBe(403);
    const seen = await viewer.client.call(M.get, { params: { ...f.p, observationId: mine.id } });
    expect(seen.permissions).toEqual({ revise: false, approve: false, markReviewed: false, setCanonical: false });
  });

  it('applies an approved correction as a new revision and recomputes metrics from it (T106)', async () => {
    const f = await insightsFixture();
    const lead = await memberOf(f, 'project_lead', { projects: [f.projectId] });
    const analyst = await memberOf(f, 'analyst');
    const pub = await insertPublication(f, { publishedAt: at(6, 10) });
    await createCheckpoints(f, { id: pub, publishedAt: at(6, 10) });
    const o = await record(f.owner, f, cumulativeBody(pub, at(5, 10), { 'publication.views': '100', 'publication.likes': '10' }));
    expect(o.checkpoint?.timing).toBe('on_time');
    expect(result(await query(f.owner, f, ['M14'], 7, 1), 'M14').total.value).toBe('100');

    const correction = { values: [{ metricKey: 'publication.views', availability: 'known' as const, value: '120' }, { metricKey: 'publication.likes', availability: 'known' as const, value: '10' }], reason: 'Views were read from the wrong post' };
    const noVersion = await lead.client.attempt(M.revise, { params: { ...f.p, observationId: o.id }, body: correction });
    expect(noVersion.status).toBe(428);
    const stale = await lead.client.attempt(M.revise, { params: { ...f.p, observationId: o.id }, body: correction }, { ifMatch: o.rowVersion + 5 });
    expect(stale.status).toBe(412);
    const unchanged = await lead.client.attempt(M.revise, { params: { ...f.p, observationId: o.id }, body: { ...correction, values: [{ metricKey: 'publication.views', availability: 'known', value: '100' }, { metricKey: 'publication.likes', availability: 'known', value: '10' }] } }, { ifMatch: o.rowVersion });
    expect(fieldCodes(unchanged)).toContain('NO_CHANGE');
    const pending = await lead.client.call(M.revise, { params: { ...f.p, observationId: o.id }, body: correction }, { ifMatch: o.rowVersion });
    expect(pending.id).toBe(o.id);
    expect(pending.hasPendingCorrection).toBe(true);
    expect(pending.pendingCorrection?.diff.find((d) => d.metricKey === 'publication.views')).toMatchObject({ from: { value: '100' }, to: { value: '120' } });
    // Still the old value until approval; a second correction must wait.
    expect(result(await query(f.owner, f, ['M14'], 7, 1), 'M14').total.value).toBe('100');
    const second = await lead.client.attempt(M.revise, { params: { ...f.p, observationId: o.id }, body: { ...correction, reason: 'Another fix' } }, { ifMatch: pending.rowVersion });
    expect(second.status).toBe(409);
    const summary = await analyst.client.call(M.inboxSummary, { params: f.p, query: {} });
    expect(summary.needsReview).toBe(1);
    const queue = await analyst.client.call(M.reviewQueue, { params: f.p, query: {} });
    expect(queue.find((q) => q.kind === 'correction')?.pendingRevisionId).toBe(pending.pendingCorrection!.id);

    // Only an approver (not the lead) decides.
    const leadApprove = await lead.client.attempt(M.approveRevision, { params: { ...f.p, revisionId: pending.pendingCorrection!.id }, body: {} }, { ifMatch: pending.pendingCorrection!.rowVersion });
    expect(leadApprove.status).toBe(403);
    const approved = await analyst.client.call(M.approveRevision, { params: { ...f.p, revisionId: pending.pendingCorrection!.id }, body: { decisionNote: 'Checked against the post' } }, { ifMatch: pending.pendingCorrection!.rowVersion });
    expect(approved.id).toBe(pending.pendingCorrection!.id);
    expect(approved).toMatchObject({ revisionNo: 2, qualityState: 'reviewed', supersedesId: o.id, rootObservationId: o.id });
    expect(approved.revisions.map((r) => [r.revisionNo, r.qualityState])).toEqual([
      [1, 'superseded'],
      [2, 'reviewed'],
    ]);
    const old = await f.owner.call(M.get, { params: { ...f.p, observationId: o.id } });
    expect(old.qualityState).toBe('superseded');
    expect(result(await query(f.owner, f, ['M14'], 7, 1), 'M14').total.value).toBe('120');
    const cps = await f.owner.call(M.publicationMetrics, { params: { ...f.p, publicationId: pub } });
    expect(cps.checkpoints.find((c) => c.checkpointKey === 'pub_24h')?.observationId).toBe(approved.id);
    const exported = await exportRows(f.ws.workspaceId, f.ws.owner.membershipId, { accountId: f.accountId });
    expect(exported.filter((r) => r.metric_key === 'publication.views').map((r) => r.value)).toEqual(['120']);
  });

  it('rejects a correction with a reason and never lets the submitter approve their own correction', async () => {
    const f = await insightsFixture();
    const analyst = await memberOf(f, 'analyst');
    const analyst2 = await memberOf(f, 'analyst');
    const o = await record(f.owner, f, snapshotBody(f.accountId, at(3), { 'account.followers': '500' }));
    const pending = await analyst.client.call(M.revise, { params: { ...f.p, observationId: o.id }, body: { values: [{ metricKey: 'account.followers', availability: 'known', value: '550' }], reason: 'Screenshot shows 550' } }, { ifMatch: o.rowVersion });
    const rev = pending.pendingCorrection!;
    const self = await analyst.client.attempt(M.approveRevision, { params: { ...f.p, revisionId: rev.id }, body: {} }, { ifMatch: rev.rowVersion });
    expect(self.status).toBe(403);
    const rejected = await analyst2.client.call(M.rejectRevision, { params: { ...f.p, revisionId: rev.id }, body: { reason: 'The screenshot is from another account' } }, { ifMatch: rev.rowVersion });
    expect(rejected.id).toBe(o.id);
    expect(rejected.hasPendingCorrection).toBe(false);
    expect(rejected.values.find((v) => v.metricKey === 'account.followers')?.value).toBe('500');
    expect(rejected.revisions.find((r) => r.id === rev.id)?.qualityState).toBe('rejected');

    // Mark Reviewed: not by the member who entered the values (unless workspace owner).
    const own = await record(analyst.client, f, snapshotBody(f.accountId, at(2), { 'account.followers': '510' }));
    const selfReview = await analyst.client.attempt(M.markReviewed, { params: { ...f.p, observationId: own.id }, body: {} }, { ifMatch: own.rowVersion });
    expect(selfReview.status).toBe(403);
    const reviewed = await analyst2.client.call(M.markReviewed, { params: { ...f.p, observationId: own.id }, body: { note: 'Matches the screenshot' } }, { ifMatch: own.rowVersion });
    expect(reviewed.qualityState).toBe('reviewed');
    expect(reviewed.reviewedBy?.membershipId).toBe(analyst2.membershipId);
  });

  it('bulk entry saves valid rows and reports each invalid row without saving it', async () => {
    const f = await insightsFixture();
    const res = await f.owner.call(M.bulk, {
      params: f.p,
      body: {
        rows: [
          snapshotBody(f.accountId, at(4), { 'account.followers': '100' }),
          snapshotBody(f.otherAccountId, at(4), { 'account.followers': 'unknown' }),
          snapshotBody(f.otherAccountId, at(4, 13), { 'account.followers': '250' }),
          snapshotBody(f.accountId, at(4), { 'account.followers': '100' }),
        ],
      },
    });
    expect(res.results.map((r) => r.ok)).toEqual([true, false, true, false]);
    expect(res.results[1]!.errors.map((e) => e.code)).toContain('NO_KNOWN_VALUE');
    expect(res.results[3]!.duplicateOf).toBe(res.results[0]!.observationId);
    const list = await f.owner.call(M.observations, { params: f.p, query: {} });
    expect(list.items).toHaveLength(2);
  });
});
