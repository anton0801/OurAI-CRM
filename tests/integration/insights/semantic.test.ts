import { describe, expect, it } from 'vitest';
import { resolvePeriod } from '@castlane/analytics';
import { analyticsEndpoints as A, financeEndpoints as F, metricsEndpoints as M } from '@castlane/api-contracts';
import { METRIC_DEFINITIONS, evaluateMetric, getAppServices, memberJobContext } from '@castlane/application';
import { expenseBody, financeSetup, postedEntry, statementBody } from '../finance/helpers';
import { shifts } from '@castlane/database';
import { newId } from '@castlane/domain';
import { at, cumulativeBody, db, insertPublication, insertTask, insightsFixture, isoDay, kpi, memberOf, periodBody, query, record, result, snapshotBody, tryRecord } from './helpers';

const interactions = (views: string, likes: string, rest: Partial<Record<'comments' | 'shares' | 'saves', string>> = {}) => ({
  'publication.views': views,
  'publication.likes': likes,
  'publication.comments': rest.comments ?? '0',
  'publication.shares': rest.shares ?? '0',
  'publication.saves': rest.saves ?? '0',
});

describe('semantic layer: publications and cumulative observations', () => {
  it('turns cumulative snapshots 100 → 160 into a delta of 60, never a total of 260 (T104)', async () => {
    const f = await insightsFixture();
    const pub = await insertPublication(f, { publishedAt: at(9, 12) });
    await record(f.owner, f, cumulativeBody(pub, at(8, 12), { 'publication.views': '100' }));
    await record(f.owner, f, cumulativeBody(pub, at(5, 12), { 'publication.views': '160' }));
    const r = await query(f.owner, f, ['M15', 'M14'], 10, 1);
    expect(result(r, 'M15').total).toMatchObject({ status: 'known', value: '60' });
    expect(result(r, 'M15').total.note).toContain(at(8, 12).slice(0, 16).replace('T', ' '));
    // The 24 h checkpoint value is the one observation in its window, not a sum of observations.
    expect(result(r, 'M14').total).toMatchObject({ status: 'known', value: '100', sampleSize: 1 });
  });

  it('flags a lower cumulative total as a source correction instead of negative views (T107)', async () => {
    const f = await insightsFixture();
    const up = await insertPublication(f, { publishedAt: at(9, 12) });
    const down = await insertPublication(f, { publishedAt: at(9, 12) });
    await record(f.owner, f, cumulativeBody(up, at(8, 12), { 'publication.views': '100' }));
    await record(f.owner, f, cumulativeBody(up, at(4, 12), { 'publication.views': '130' }));
    await record(f.owner, f, cumulativeBody(down, at(8, 12), { 'publication.views': '200' }));
    const lower = cumulativeBody(down, at(4, 12), { 'publication.views': '180' });
    const warned = await tryRecord(f.owner, f, lower);
    expect(warned.status).toBe(422);
    expect(((warned.error as { fieldErrors: { code: string }[] }).fieldErrors ?? []).map((e) => e.code)).toEqual(['NOTE_REQUIRED']);
    const v = await f.owner.call(M.validate, { params: f.p, body: lower });
    expect(v.warnings.map((w) => w.code)).toEqual(['CUMULATIVE_DECREASE']);
    const saved = await record(f.owner, f, { ...lower, warningNote: 'The platform removed bot views.' });
    expect(saved.warnings).toEqual(['CUMULATIVE_DECREASE']);

    const all = result(await query(f.owner, f, ['M15'], 10, 1), 'M15').total;
    expect(all).toMatchObject({ status: 'known', value: '30', sampleSize: 1 });
    expect(all.excluded).toEqual([{ count: 1, reason: 'Source Correction (lower cumulative total)' }]);
    const byPub = result(await query(f.owner, f, ['M15'], 10, 1, { groupBy: 'publication' }), 'M15').groups!;
    const neg = byPub.find((g) => g.key === down)!.value as { value: string | null; note?: string };
    expect(neg.value).toBe('-20');
    expect(neg.note).toMatch(/^Source Correction/);
  });

  it('computes ER per publication with Not Defined at zero views, lists missing fields and weights the aggregate (T108, T109, T110)', async () => {
    const f = await insightsFixture();
    const zero = await insertPublication(f, { publishedAt: at(9, 12) });
    const partial = await insertPublication(f, { publishedAt: at(9, 12) });
    const ten = await insertPublication(f, { publishedAt: at(9, 12) });
    const two = await insertPublication(f, { publishedAt: at(9, 12) });
    await record(f.owner, f, cumulativeBody(zero, at(8, 12), interactions('0', '0')));
    await record(f.owner, f, cumulativeBody(partial, at(8, 12), { 'publication.views': '1000', 'publication.likes': '50', 'publication.comments': 'not_provided', 'publication.shares': '1', 'publication.saves': '1' }));
    await record(f.owner, f, cumulativeBody(ten, at(8, 12), interactions('100', '10')));
    await record(f.owner, f, cumulativeBody(two, at(8, 12), interactions('1000', '20')));

    const per = await query(f.owner, f, ['M17', 'M16'], 10, 1, { groupBy: 'publication' });
    const er = (id: string) => result(per, 'M17').groups!.find((g) => g.key === id)!.value as { status: string; value: string | null; missing?: string[] };
    expect(er(zero)).toMatchObject({ status: 'not_defined', value: null });
    expect(er(partial)).toMatchObject({ status: 'not_measured', value: null });
    expect(er(partial).missing).toEqual(['comments']);
    expect(er(ten)).toMatchObject({ status: 'known', value: '10.00' });
    expect(er(two)).toMatchObject({ status: 'known', value: '2.00' });
    const inter = result(per, 'M16').groups!.find((g) => g.key === partial)!.value as { status: string; missing?: string[]; note?: string };
    expect(inter).toMatchObject({ status: 'partial', missing: ['comments'], note: 'Partial Interactions' });

    // Several publications: M17 is per publication only; M19 is Σ interactions ÷ Σ views (30 ÷ 1100), not the mean of 10 % and 2 %.
    const agg = await query(f.owner, f, ['M17', 'M19'], 10, 1);
    expect(result(agg, 'M17').total.status).toBe('not_applicable');
    const m19 = result(agg, 'M19').total;
    expect(m19).toMatchObject({ status: 'known', value: '2.73', sampleSize: 2 });
    expect(m19.excluded).toEqual(
      expect.arrayContaining([
        { count: 1, reason: 'Missing or zero denominator' },
        { count: 1, reason: 'Partial Interactions' },
      ]),
    );
  });
});

describe('semantic layer: accounts, periods and OFM', () => {
  it('never sums overlapping periods until one of them is excluded from reports (T105)', async () => {
    const f = await insightsFixture();
    const week = await record(f.owner, f, periodBody(f.accountId, dayStartIso(10), dayStartIso(3), { 'account.views': '700' }));
    const overlapBody = periodBody(f.accountId, dayStartIso(7), dayStartIso(6), { 'account.views': '100' }, { sourceNamespace: 'manual_count', sourceType: 'manual' });
    const noNote = await tryRecord(f.owner, f, overlapBody);
    expect(((noNote.error as { fieldErrors: { code: string }[] }).fieldErrors ?? []).map((e) => e.code)).toEqual(['NOTE_REQUIRED']);
    const day = await record(f.owner, f, { ...overlapBody, warningNote: 'Daily figure from the story insights.' });
    expect(day.warnings).toContain('PERIOD_OVERLAP');
    await record(f.owner, f, periodBody(f.accountId, dayStartIso(3), dayStartIso(2), { 'account.views': '50' }));

    const before = result(await query(f.owner, f, ['M13'], 12, 1), 'M13').total;
    expect(before).toMatchObject({ status: 'partial', value: '50', sampleSize: 1 });
    expect(before.excluded).toEqual([{ count: 2, reason: 'Overlapping periods — choose a consistent set' }]);
    const detail = await f.owner.call(M.get, { params: { ...f.p, observationId: week.id } });
    expect(detail.conflicts.map((c) => c.id)).toEqual([day.id]);
    expect((await f.owner.call(M.inboxSummary, { params: f.p, query: {} })).needsReview).toBe(2);

    await f.owner.call(M.setCanonical, { params: { ...f.p, observationId: day.id }, body: { canonical: false, reason: 'Covered by the weekly export' } }, { ifMatch: day.rowVersion });
    const after = result(await query(f.owner, f, ['M13'], 12, 1), 'M13').total;
    expect(after).toMatchObject({ status: 'known', value: '750', sampleSize: 2 });
    expect((await f.owner.call(M.inboxSummary, { params: f.p, query: {} })).needsReview).toBe(0);
  });

  it('shows the absolute follower change when the first snapshot is 0 and no relative growth (T111)', async () => {
    const f = await insightsFixture();
    await record(f.owner, f, snapshotBody(f.accountId, at(8), { 'account.followers': '0' }));
    await record(f.owner, f, snapshotBody(f.accountId, at(3), { 'account.followers': '150' }));
    const r = await query(f.owner, f, ['M11', 'M12'], 10, 1, { projectIds: [f.projectId] });
    expect(result(r, 'M11').total).toMatchObject({ status: 'known', value: '150' });
    expect(result(r, 'M12').total).toMatchObject({ status: 'not_defined', value: null });
  });

  it('labels followers across platforms as a Sum of Account Followers, not unique audience (T113)', async () => {
    const f = await insightsFixture();
    await record(f.owner, f, snapshotBody(f.accountId, at(6), { 'account.followers': '900' }));
    await record(f.owner, f, snapshotBody(f.accountId, at(2), { 'account.followers': '1000' }));
    await record(f.owner, f, snapshotBody(f.otherAccountId, at(2), { 'account.followers': '500' }));
    const r = await query(f.owner, f, ['X01'], 10, 1);
    const x01 = result(r, 'X01');
    expect(x01.label).toBe('Sum of Account Followers');
    expect(x01.total).toMatchObject({ status: 'known', value: '1500', coverage: { usable: 2, expected: 2 } });
    expect(x01.total.note).toBe('Sum of Account Followers — not unique audience · Definitions Differ');
    const d = await f.owner.call(A.dashboard, { params: { ...f.p, tab: 'accounts' }, query: { preset: 'custom', from: isoDay(10), to: isoDay(1) } });
    expect(kpi(d, 'X01')).toMatchObject({ value: { value: '1500' } });
    expect(kpi(d, 'X01')).toMatchObject({ label: 'Sum of Account Followers' });
  });

  it('reads OFM shifts: net hours exclude running shifts (Pending, never zero) and approved shifts are counted', async () => {
    const f = await insightsFixture({ ofm: true });
    const shift = (start: string, end: string | null, extra: Partial<typeof shifts.$inferInsert> = {}) =>
      db()
        .insert(shifts)
        .values({ id: newId(), workspaceId: f.ws.workspaceId, projectId: f.projectId, primaryAccountId: f.accountId, membershipId: f.ws.owner.membershipId, scheduledStart: new Date(start), scheduledEnd: new Date(new Date(start).getTime() + 4 * 3_600_000), actualStart: new Date(start), actualEnd: end ? new Date(end) : null, timezone: 'UTC', ...extra });
    await shift(at(3, 10), at(3, 14), { state: 'ended', reportState: 'approved' });
    await shift(at(2, 10), at(2, 11, 30), { state: 'ended', reportState: 'submitted' });
    await shift(at(1, 10), null, { state: 'active' });
    const r = await query(f.owner, f, ['M28', 'X07', 'X06'], 5, 1);
    expect(result(r, 'M28').total).toMatchObject({ status: 'known', value: '5.50', sampleSize: 2, note: 'Pending: 1 shift(s) without an actual end' });
    expect(result(r, 'X07').total.value).toBe('1');
    expect(result(r, 'X06').total.value).toBe('1');
    const d = await f.owner.call(A.dashboard, { params: { ...f.p, tab: 'ofm' }, query: { preset: 'custom', from: isoDay(5), to: isoDay(1) } });
    expect(kpi(d, 'M28').value.value).toBe('5.50');
    expect(d.empty).toBe(false);
  });

  it('reports churn as Not Measured without a starting cohort and never substitutes current subscribers (T112)', async () => {
    const f = await insightsFixture({ ofm: true });
    const ofmPeriod = (start: string, end: string, values: Record<string, string>) => ({ ...periodBody(f.accountId, start, end, values), entityType: 'ofm_account' as const, sourceNamespace: 'onlyfans_statement' });
    await record(f.owner, f, ofmPeriod(dayStartIso(10), dayStartIso(6), { 'ofm.new_paid_subscribers': '30', 'ofm.cancellations': '12' }));
    const noCohort = result(await query(f.owner, f, ['M26', 'M24'], 12, 1), 'M26').total;
    expect(noCohort).toMatchObject({ status: 'not_measured', value: null });
    await record(f.owner, f, ofmPeriod(dayStartIso(6), dayStartIso(2), { 'ofm.starting_active_subscribers': '200', 'ofm.lost_from_starting_cohort': '20' }));
    const withCohort = result(await query(f.owner, f, ['M26'], 12, 1), 'M26').total;
    expect(withCohort).toMatchObject({ status: 'known', value: '10.00' });
  });
});

describe('semantic layer: comparison, scope and finance', () => {
  it('serves the catalogue ids M01–M42 through the core metric registry (goals and Overview)', async () => {
    const f = await insightsFixture();
    await insertPublication(f, { publishedAt: at(4, 12) });
    await insertTask(f, { dueAt: new Date(at(3, 12)) });
    const ids = [...METRIC_DEFINITIONS.keys()].filter((id) => /^M\d{2}$/.test(id)).sort();
    expect(ids).toEqual(Array.from({ length: 42 }, (_, i) => `M${String(i + 1).padStart(2, '0')}`));
    const ctx = (await memberJobContext(getAppServices(), f.ws.workspaceId, f.ws.owner.membershipId))!;
    const period = resolvePeriod('custom', new Date(), 'UTC', { fromDate: isoDay(10), toDate: isoDay(1) });
    const q = { period, asOf: new Date(), filters: {} };
    expect((await evaluateMetric(ctx, 'M01', q)).total).toMatchObject({ status: 'known', value: '1' });
    expect((await evaluateMetric(ctx, 'M02', q)).total.value).toBe('0');
    expect((await evaluateMetric(ctx, 'M08', q)).total).toMatchObject({ status: 'known', value: '1' });
    expect((await evaluateMetric(ctx, 'M07', q)).total.value).toBeNull();
    expect((await evaluateMetric(ctx, 'M40', q)).total.status).toBe('not_applicable');
    const series = await evaluateMetric(ctx, 'M01', { ...q, grain: 'day' });
    expect(series.series?.find((b) => b.bucket === isoDay(4))?.value.value).toBe('1');
  });

  it('compares an unfinished period with the same elapsed window and rates in percentage points (T117)', async () => {
    const f = await insightsFixture();
    const c1 = await insertPublication(f, { publishedAt: at(2, 12) });
    await insertPublication(f, { publishedAt: at(1, 12) });
    const p1 = await insertPublication(f, { publishedAt: at(9, 12) });
    await insertPublication(f, { publishedAt: at(5, 12) }); // in the previous period, after its elapsed part
    await record(f.owner, f, cumulativeBody(c1, at(1, 12), interactions('100', '10')));
    await record(f.owner, f, cumulativeBody(p1, at(8, 12), interactions('200', '10')));
    const r = await query(f.owner, f, ['M01', 'M19'], 3, -3, { compare: true });
    expect(r.period.elapsedOnly).toBe(true);
    const m01 = result(r, 'M01');
    expect(m01.total.value).toBe('2');
    expect(m01.previous?.value).toBe('1');
    expect(m01.delta).toMatchObject({ status: 'known', abs: '1', pct: '100.00', unitLabel: 'unit' });
    const m19 = result(r, 'M19');
    expect(m19.total.value).toBe('10.00');
    expect(m19.previous?.value).toBe('5.00');
    expect(m19.delta).toMatchObject({ status: 'known', abs: '5', pct: null, unitLabel: 'pp' });
    const d = await f.owner.call(A.dashboard, { params: { ...f.p, tab: 'production' }, query: { preset: 'custom', from: isoDay(3), to: isoDay(-3), compare: true } });
    expect(d.comparison).toMatchObject({ fromDate: isoDay(10), elapsedOnly: true });
    expect(d.notes.join(' ')).toContain('same elapsed part of the previous period');
  });

  it('applies the member scope inside the query before aggregation (production metrics)', async () => {
    const f = await insightsFixture();
    const lead = await memberOf(f, 'project_lead', { projects: [f.projectId] });
    await insertPublication(f, { publishedAt: at(4, 12) });
    await insertPublication(f, { projectId: f.otherProjectId, accountId: f.otherAccountId, publishedAt: at(4, 12) });
    await insertPublication(f, { projectId: f.otherProjectId, accountId: f.otherAccountId, publishedAt: at(3, 12) });
    await insertTask(f, { dueAt: new Date(at(3, 12)) });
    await insertTask(f, { projectId: f.otherProjectId, dueAt: new Date(at(3, 12)) });
    await insertTask(f, { projectId: f.otherProjectId, dueAt: new Date(at(3, 12)), status: 'done', completedAt: new Date(at(4, 12)) });

    const owner = await query(f.owner, f, ['M01', 'M08'], 10, 1, { groupBy: 'project' });
    expect(result(owner, 'M01').total.value).toBe('3');
    expect(result(owner, 'M08').total.value).toBe('2');
    expect(result(owner, 'M01').groups!.map((g) => [g.label, g.value.value]).sort()).toEqual([
      ['Model Alpha', '1'],
      ['Model Beta', '2'],
    ]);
    const scoped = await query(lead.client, f, ['M01', 'M08'], 10, 1, { groupBy: 'project' });
    expect(result(scoped, 'M01').total.value).toBe('1');
    expect(result(scoped, 'M08').total.value).toBe('1');
    expect(result(scoped, 'M01').groups!.map((g) => g.label)).toEqual(['Model Alpha']);
    // Asking for a project outside the scope returns nothing from it.
    const outside = await query(lead.client, f, ['M01'], 10, 1, { projectIds: [f.otherProjectId] });
    expect(result(outside, 'M01').total.value).toBe('0');

    const drill = await lead.client.call(A.drillDown, { params: f.p, query: { metric: 'M01', preset: 'custom', from: isoDay(10), to: isoDay(1) } });
    expect(drill).toMatchObject({ total: 1, hidden: 0, truncated: false });
    expect(drill.items[0]!.entityType).toBe('publication');
    // The production dashboard opens for a scoped member: the stage-aging table applies the scope to
    // its aliased content table (found by the T170 load profile, where it failed for every project lead).
    const production = await lead.client.call(A.dashboard, { params: { ...f.p, tab: 'production' }, query: { preset: 'last_30_days' } });
    expect(production.tables.map((t) => t.key)).toContain('stage_aging');
    // Finance and OFM dashboards are not available to a project lead.
    expect((await lead.client.attempt(A.dashboard, { params: { ...f.p, tab: 'finance' }, query: {} })).status).toBe(403);
    expect((await lead.client.attempt(A.query, { params: f.p, body: { metrics: ['M33'], period: { preset: 'last_30_days' }, compare: false, filters: {} } })).status).toBe(403);
  });

  it('reads finance metrics M33–M36 from posted ledger records only', async () => {
    const { owner, fmc, p, cat, project } = await financeSetup();
    await postedEntry(fmc, owner, p, statementBody(cat, project.id));
    await postedEntry(fmc, owner, p, expenseBody(cat, project.id, '200.00'));
    await fmc.call(F.entriesCreate, { params: p, body: expenseBody(cat, project.id, '999.00') }); // a draft never counts
    const r = await owner.call(A.query, { params: p, body: { metrics: ['M33', 'M34', 'M35', 'M36'], period: { preset: 'custom', from: '2024-03-01', to: '2024-03-31' }, compare: false, filters: {} } });
    const v = (id: string) => r.results.find((x) => x.metricId === id)!.total;
    expect(Number(v('M33').value)).toBe(1000);
    expect(Number(v('M34').value)).toBe(720);
    expect(Number(v('M35').value)).toBe(520);
    expect(v('M35').currency).toBe('EUR');
    expect(v('M36')).toMatchObject({ status: 'known', value: '52.00' });
  });

  it('shows an empty workspace without fake numbers or charts (T169)', async () => {
    const f = await insightsFixture();
    for (const tab of ['production', 'accounts', 'content', 'ofm', 'team', 'finance'] as const) {
      const d = await f.owner.call(A.dashboard, { params: { ...f.p, tab }, query: { preset: 'last_30_days' } });
      expect(d.empty, tab).toBe(true);
      for (const k of d.kpis) {
        const v = k.value;
        expect(v.value === null || (Number(v.value) === 0 && (v.sampleSize ?? 0) === 0)).toBe(true);
      }
      for (const c of d.charts) for (const p of c.points) for (const v of Object.values(p.values)) expect(v.value === null || Number(v.value) === 0).toBe(true);
    }
    await insertPublication(f, { publishedAt: at(2, 12) });
    // Dashboards are served from the read model; "Recalculate now" computes from the source records.
    const d = await f.owner.call(A.dashboard, { params: { ...f.p, tab: 'production' }, query: { preset: 'last_30_days', refresh: true } });
    expect(d.empty).toBe(false);
    expect(d.snapshot?.live).toBe(true);
    expect(kpi(d, 'M01').value.value).toBe('1');
    // The read model now holds the recalculated figures.
    const served = await f.owner.call(A.dashboard, { params: { ...f.p, tab: 'production' }, query: { preset: 'last_30_days' } });
    expect(served.snapshot?.live).toBe(false);
    expect(kpi(served, 'M01').value.value).toBe('1');
  });
});

function dayStartIso(daysAgo: number) {
  return `${isoDay(daysAgo)}T00:00:00.000Z`;
}
