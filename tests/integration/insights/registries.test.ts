import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { lookupEndpoints, metricsEndpoints as M, reportEndpoints as R } from '@castlane/api-contracts';
import { ARCHIVE_HANDLERS, IMPORT_DATASETS_REGISTRY, executeCommand, getAppServices, memberJobContext } from '@castlane/application';
import { metricObservations, socialAccounts } from '@castlane/database';
import { at, db, insightsFixture, isoDay, memberOf } from './helpers';

const handleOf = async (accountId: string) => (await db().select({ handle: socialAccounts.handle }).from(socialAccounts).where(eq(socialAccounts.id, accountId)))[0]!.handle;

describe('metric observations import (F09)', () => {
  it('imports rows, resolves entities, and offers Skip or Create Revision per conflicting row — never a silent replacement', async () => {
    const f = await insightsFixture();
    const ctx = (await memberJobContext(getAppServices(), f.ws.workspaceId, f.ws.owner.membershipId, { source: 'import' }))!;
    const ds = IMPORT_DATASETS_REGISTRY.get('metric_observations')!;
    expect(ds.duplicatePolicies).toEqual(['skip', 'revise_existing', 'error']);
    const row = { entity_type: 'account', entity: `@${await handleOf(f.accountId)}`, kind: 'snapshot', observed_at: at(3, 9), source_note: 'Weekly CSV export', 'account.followers': '1200', 'account.following': 'n/p', 'account.total_posts': '' };
    const v = await ds.validate(ctx, row, { duplicatePolicy: 'error', rowNo: 1 });
    expect(v.errors).toEqual([]);
    expect(v.action).toBe('create');
    const id = (await executeCommand(ctx, (c) => ds.apply(c, v.normalized, { action: 'create' }))).body as string;
    const saved = await f.owner.call(M.get, { params: { ...f.p, observationId: id } });
    expect(saved.sourceType).toBe('csv');
    expect(saved.values.map((x) => [x.metricKey, x.availability, x.value]).sort()).toEqual([
      ['account.followers', 'known', '1200'],
      ['account.following', 'not_provided', null],
    ]);

    // The same key again: an error unless the row (or the import) chooses Skip or Create Revision.
    const dup = await ds.validate(ctx, row, { duplicatePolicy: 'error', rowNo: 2 });
    expect(dup.errors.map((e) => e.code)).toEqual(['DUPLICATE']);
    const skip = await ds.validate(ctx, { ...row, conflict_action: 'skip', 'account.followers': '1300' }, { duplicatePolicy: 'error', rowNo: 2 });
    expect(skip.action).toBe('skip');
    const unchanged = await ds.validate(ctx, { ...row, conflict_action: 'create_revision' }, { duplicatePolicy: 'error', rowNo: 2 });
    expect(unchanged.action).toBe('skip');
    const revise = await ds.validate(ctx, { ...row, 'account.followers': '1300' }, { duplicatePolicy: 'revise_existing', rowNo: 2 });
    expect(revise).toMatchObject({ action: 'update', targetId: id, errors: [] });
    const revId = (await executeCommand(ctx, (c) => ds.apply(c, revise.normalized, { action: 'update', targetId: revise.targetId, targetRowVersion: revise.targetRowVersion }))).body as string;
    const pending = await f.owner.call(M.get, { params: { ...f.p, observationId: id } });
    expect(pending.values.find((x) => x.metricKey === 'account.followers')?.value).toBe('1200');
    expect(pending.pendingCorrection).toMatchObject({ id: revId });
    expect(pending.pendingCorrection!.diff.find((d) => d.metricKey === 'account.followers')).toMatchObject({ from: { value: '1200' }, to: { value: '1300' } });
    const waiting = await ds.validate(ctx, { ...row, 'account.followers': '1400' }, { duplicatePolicy: 'revise_existing', rowNo: 3 });
    expect(waiting.errors.map((e) => e.code)).toContain('CORRECTION_PENDING');

    // Unknown references and invalid values are row errors.
    const unknown = await ds.validate(ctx, { ...row, entity: '@nobody_here' }, { duplicatePolicy: 'error', rowNo: 4 });
    expect(unknown.errors.map((e) => e.code)).toEqual(['UNKNOWN_ENTITY']);
    const badValue = await ds.validate(ctx, { ...row, observed_at: at(2, 9), 'account.followers': '12.5' }, { duplicatePolicy: 'error', rowNo: 5 });
    expect(badValue.errors.map((e) => e.code)).toContain('INVALID_COUNTER');

    // Undo withdraws an unreviewed imported correction and removes an untouched imported record.
    await executeCommand(ctx, (c) => ds.undo!(c, revId));
    expect((await f.owner.call(M.get, { params: { ...f.p, observationId: id } })).pendingCorrection).toBeNull();
    const other = await ds.validate(ctx, { ...row, entity: f.otherAccountId, observed_at: at(2, 9) }, { duplicatePolicy: 'error', rowNo: 6 });
    const otherId = (await executeCommand(ctx, (c) => ds.apply(c, other.normalized, { action: 'create' }))).body as string;
    await executeCommand(ctx, (c) => ds.undo!(c, otherId));
    expect(await db().select().from(metricObservations).where(eq(metricObservations.id, otherId))).toHaveLength(0);
  });

  it('refuses rows for entities outside the importer scope', async () => {
    const f = await insightsFixture();
    const lead = await memberOf(f, 'project_lead', { projects: [f.projectId] });
    const ctx = (await memberJobContext(getAppServices(), f.ws.workspaceId, lead.membershipId, { source: 'import' }))!;
    const ds = IMPORT_DATASETS_REGISTRY.get('metric_observations')!;
    const v = await ds.validate(ctx, { entity_type: 'account', entity: f.otherAccountId, kind: 'snapshot', observed_at: at(2), source_note: 'CSV', 'account.followers': '5' }, { duplicatePolicy: 'error', rowNo: 1 });
    expect(v.errors.map((e) => e.code)).toEqual(['NOT_ACCESSIBLE']);
  });
});

describe('lookups and archive', () => {
  it('offers metric definitions and only readable saved reports in pickers; archiving pauses schedules', async () => {
    const f = await insightsFixture();
    const analyst = await memberOf(f, 'analyst');
    const defs = await f.owner.call(lookupEndpoints.search, { params: { ...f.p, type: 'metric_definition' }, query: { q: 'followers' } });
    expect(defs.items.map((i) => i.label)).toContain('Followers (account.followers)');
    const config = { dataset: 'publications' as const, dimensions: [], metrics: ['M01'], datePolicy: { kind: 'fixed' as const, from: isoDay(10), to: isoDay(1) } };
    const mine = await f.owner.call(R.create, { params: f.p, body: { name: 'Owner private report', config } });
    const theirs = await analyst.client.call(R.create, { params: f.p, body: { name: 'Analyst private report', config } });
    const seen = await f.owner.call(lookupEndpoints.search, { params: { ...f.p, type: 'saved_report' }, query: { q: 'private' } });
    expect(seen.items.map((i) => i.id)).toEqual([mine.id]);
    void theirs;

    await f.owner.call(R.scheduleCreate, { params: f.p, body: { reportId: mine.id, cadence: 'daily', recipientMembershipIds: [f.ws.owner.membershipId], localTime: '07:30', timezone: 'UTC', emailNotify: false } });
    const handler = ARCHIVE_HANDLERS.get('saved_report')!;
    const ctx = (await memberJobContext(getAppServices(), f.ws.workspaceId, f.ws.owner.membershipId))!;
    const preview = await handler.preview(ctx, mine.id);
    expect(preview.items).toEqual([{ kind: 'active_schedules', label: 'Active schedules (they will be paused)', count: 1, blocking: false }]);
    await executeCommand(ctx, (c) => handler.archive(c, mine.id, { reason: 'Replaced' } as never));
    const archived = await f.owner.call(R.get, { params: { ...f.p, reportId: mine.id } });
    expect(archived.archivedAt).not.toBeNull();
    expect(archived.schedules.map((s) => s.status)).toEqual(['paused']);
    await executeCommand(ctx, (c) => handler.restore!(c, mine.id, {} as never));
    expect((await f.owner.call(R.get, { params: { ...f.p, reportId: mine.id } })).archivedAt).toBeNull();
  });
});
