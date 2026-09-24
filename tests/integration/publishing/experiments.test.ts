import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { experimentEndpoints as X, publicationEndpoints as P } from '@castlane/api-contracts';
import { checkpointTiming } from '@castlane/application';
import { experimentRevisions, metricCheckpoints, metricObservations, metricValues } from '@castlane/database';
import { newId } from '@castlane/domain';
import { resetClock, type TestClient } from '../../support';
import { at, db, insertContent, memberClient, setup, type Fixture } from './support';

afterEach(() => resetClock());

/** A historical placement published `hoursAgo` hours before T0. */
const placed = async (c: TestClient, f: Fixture, hoursAgo: number, title: string) => {
  const content = await insertContent(f.ws, f.project.id, { title });
  return c.call(P.createHistorical, {
    params: f.W,
    body: {
      contentItemId: content.id,
      contentVersionId: content.approvedVersionId!,
      accountId: f.accountId,
      ownerMembershipId: f.ws.owner.membershipId,
      actualPublishedAt: at(-hoursAgo),
      externalUrl: `https://www.instagram.com/p/${newId().slice(0, 10)}/`,
      sourceNote: 'Entered for the experiment',
    },
  });
};

/** A cumulative views observation (the insights module's rows, inserted directly). */
const observe = async (f: Fixture, publicationId: string, observedAt: string, value: string | null, availability: 'known' | 'not_provided' = 'known') => {
  const id = newId();
  const now = new Date();
  await db().insert(metricObservations).values({
    id,
    workspaceId: f.ws.workspaceId,
    entityType: 'publication',
    entityId: publicationId,
    accountId: f.accountId,
    projectId: f.project.id,
    publicationId,
    kind: 'cumulative',
    observedAt: new Date(observedAt),
    sourceType: 'manual',
    sourceNote: 'Screenshot of insights',
    enteredAt: now,
    rootObservationId: id,
    dedupeKey: `test:${id}`,
    createdAt: now,
    updatedAt: now,
  });
  await db()
    .insert(metricValues)
    .values({ id: newId(), workspaceId: f.ws.workspaceId, observationId: id, metricKey: 'publication.views', value: availability === 'known' ? value : null, availability, unit: 'count', createdAt: now, updatedAt: now });
};

const newExperiment = (c: TestClient, f: Fixture, extra: Record<string, unknown> = {}) =>
  c.call(X.create, {
    params: f.W,
    body: {
      hypothesis: 'Hooks with a question in the first second get more views after 24 hours',
      projectId: f.project.id,
      ownerMembershipId: f.ws.owner.membershipId,
      primaryMetricKey: 'publication.views',
      observationWindowHours: 24,
      minimumSample: 1,
      limitations: 'Organic reach varies by weekday.',
      variants: [{ name: 'Question hook' }, { name: 'Statement hook' }],
      ...extra,
    },
  });

describe('experiments', () => {
  it('marks unequal post ages Not Comparable and never names a winner or significance (T072)', async () => {
    const f = await setup();
    const e = await newExperiment(f.owner, f);
    const [qa, st] = e.variants;
    const old = await placed(f.owner, f, 24 * 8, 'Question A'); // 8 days old, observed at 24 h
    const young = await placed(f.owner, f, 2, 'Statement A'); // 2 h old
    const wrongAge = await placed(f.owner, f, 24 * 5, 'Statement B'); // observed only at 72 h
    await observe(f, old.id, at(-24 * 7), '1000');
    await observe(f, wrongAge.id, at(-24 * 2), '4000');
    let exp = await f.owner.call(X.linkPublications, { params: { ...f.W, experimentId: e.id }, body: { variantId: qa!.id, publicationIds: [old.id], segment: 'organic' } }, { ifMatch: e.rowVersion });
    exp = await f.owner.call(X.linkPublications, { params: { ...f.W, experimentId: e.id }, body: { variantId: st!.id, publicationIds: [young.id, wrongAge.id], segment: 'organic' } }, { ifMatch: exp.rowVersion });
    const r = await f.owner.call(X.results, { params: { ...f.W, experimentId: e.id } });
    expect(r.status).toBe('not_comparable');
    const states = new Map(r.items.map((i) => [i.publicationId, i.state]));
    expect(states.get(old.id)).toBe('comparable');
    expect(states.get(young.id)).toBe('too_young');
    expect(states.get(wrongAge.id)).toBe('no_observation_in_window');
    const statement = r.segments[0]!.variants.find((v) => v.variantId === st!.id)!;
    expect(statement.sampleSize).toBe(0);
    expect(statement.median).toBeNull();
    expect(statement.excluded).toMatchObject({ too_young: 1, no_observation_in_window: 1 });
    expect(r.caveat).toContain('not a randomized A/B test');
    const text = JSON.stringify(r).toLowerCase();
    expect(text).not.toContain('winner');
    expect(text).not.toContain('p-value');
    expect(text).not.toContain('"significan');
    // Once the other variant has a value at the same age, the comparison is shown with the method named.
    await observe(f, wrongAge.id, at(-24 * 4), '3000');
    const ok = await f.owner.call(X.results, { params: { ...f.W, experimentId: e.id } });
    expect(ok.status).toBe('comparable');
    expect(ok.segments[0]!.variants.map((v) => v.median)).toEqual(['1000', '3000']);
    expect(ok.method).toContain('Median and mean');
  });

  it('stores the actual published and observed times so a late checkpoint is labelled Late and left out of the comparable set (T068)', async () => {
    const f = await setup();
    const e = await newExperiment(f.owner, f);
    const p = await placed(f.owner, f, 60, 'Late measured');
    const published = new Date(at(-60)).getTime();
    expect(new Date(p.actualPublishedAt!).getTime()).toBe(published);
    // Checkpoint windows are anchored on the actual publication time, not on the plan.
    const cps = await db().select().from(metricCheckpoints).where(eq(metricCheckpoints.publicationId, p.id));
    const d24 = cps.find((c) => c.checkpointKey === 'pub_24h')!;
    expect(d24.windowStart.getTime()).toBe(published + 22 * 3_600_000);
    expect(d24.windowEnd.getTime()).toBe(published + 26 * 3_600_000);
    // The 24 h value was only recorded at 36 h: the observation keeps its real observed_at.
    await observe(f, p.id, at(-24), '900');
    const [obs] = await db().select().from(metricObservations).where(eq(metricObservations.publicationId, p.id));
    expect(obs!.observedAt.getTime()).toBe(published + 36 * 3_600_000);
    expect(checkpointTiming(obs!.observedAt, d24.windowStart, d24.windowEnd)).toBe('late');
    // What the insights module stores when it completes the checkpoint; the publication shows it as Late.
    await db().update(metricCheckpoints).set({ state: 'completed', completedObservationId: obs!.id, timing: checkpointTiming(obs!.observedAt, d24.windowStart, d24.windowEnd) }).where(eq(metricCheckpoints.id, d24.id));
    const detail = await f.owner.call(P.get, { params: { ...f.W, publicationId: p.id } });
    expect(detail.checkpoints.find((c) => c.key === 'pub_24h')).toMatchObject({ state: 'completed', timing: 'late', completedObservationId: obs!.id });
    // The late value is not part of the standard comparable set at 24 h.
    const exp = await f.owner.call(X.linkPublications, { params: { ...f.W, experimentId: e.id }, body: { variantId: e.variants[0]!.id, publicationIds: [p.id], segment: 'organic' } }, { ifMatch: e.rowVersion });
    expect(exp.publicationCount).toBe(1);
    const r = await f.owner.call(X.results, { params: { ...f.W, experimentId: e.id } });
    expect(r.items[0]).toMatchObject({ state: 'no_observation_in_window', value: null, observedAgeHours: 36 });
    expect(r.segments[0]!.variants[0]!).toMatchObject({ sampleSize: 0, median: null });
  });

  it('keeps unknown values unknown and paid separate from organic', async () => {
    const f = await setup();
    const e = await newExperiment(f.owner, f);
    const a = await placed(f.owner, f, 48, 'A organic');
    const b = await placed(f.owner, f, 48, 'B paid');
    await observe(f, a.id, at(-24), null, 'not_provided');
    await observe(f, b.id, at(-24), '500');
    let exp = await f.owner.call(X.linkPublications, { params: { ...f.W, experimentId: e.id }, body: { variantId: e.variants[0]!.id, publicationIds: [a.id], segment: 'organic' } }, { ifMatch: e.rowVersion });
    exp = await f.owner.call(X.linkPublications, { params: { ...f.W, experimentId: e.id }, body: { variantId: e.variants[1]!.id, publicationIds: [b.id], segment: 'paid' } }, { ifMatch: exp.rowVersion });
    const r = await f.owner.call(X.results, { params: { ...f.W, experimentId: e.id } });
    expect(r.items.find((i) => i.publicationId === a.id)).toMatchObject({ state: 'unknown_value', value: null });
    expect(r.segments.map((s) => s.segment)).toEqual(['organic', 'paid']);
    expect(r.status).toBe('not_comparable');
    // Linking the same placement twice or one from another project is refused.
    expect((await f.owner.attempt(X.linkPublications, { params: { ...f.W, experimentId: e.id }, body: { variantId: e.variants[0]!.id, publicationIds: [a.id] } }, { ifMatch: exp.rowVersion })).status).toBe(409);
  });

  it('freezes the plan at start, revises with a reason, concludes with evidence and an owner-chosen variant', async () => {
    const f = await setup();
    expect((await f.owner.attempt(X.create, { params: f.W, body: { hypothesis: 'One variant only is not an experiment', projectId: f.project.id, ownerMembershipId: f.ws.owner.membershipId, primaryMetricKey: 'publication.views', observationWindowHours: 24, minimumSample: 1, variants: [{ name: 'Only' }] } })).status).toBe(422);
    expect((await f.owner.attempt(X.create, { params: f.W, body: { hypothesis: 'Followers are not a per-post metric here', projectId: f.project.id, ownerMembershipId: f.ws.owner.membershipId, primaryMetricKey: 'account.followers', observationWindowHours: 24, minimumSample: 1, variants: [{ name: 'A' }, { name: 'B' }] } })).status).toBe(422);
    const e = await newExperiment(f.owner, f);
    const edited = await f.owner.call(X.update, { params: { ...f.W, experimentId: e.id }, body: { minimumSample: 2 } }, { ifMatch: e.rowVersion });
    expect(edited.planVersion).toBe(1);
    const started = await f.owner.call(X.start, { params: { ...f.W, experimentId: e.id }, body: {} }, { ifMatch: edited.rowVersion });
    expect(started).toMatchObject({ status: 'running', planVersion: 1 });
    expect(started.planFrozenAt).not.toBeNull();
    expect((await f.owner.attempt(X.update, { params: { ...f.W, experimentId: e.id }, body: { observationWindowHours: 168 } }, { ifMatch: started.rowVersion })).status).toBe(422);
    const revised = await f.owner.call(X.update, { params: { ...f.W, experimentId: e.id }, body: { observationWindowHours: 168, reason: '24 h is too early for this format' } }, { ifMatch: started.rowVersion });
    expect(revised.planVersion).toBe(2);
    expect(revised.revisions.map((r) => r.planVersion)).toEqual([2, 1]);
    expect((await db().select().from(experimentRevisions).where(eq(experimentRevisions.experimentId, e.id)))[0]).toBeTruthy();
    // A lead of the project may run it but only the owner selects a variant, always with a rationale.
    const lead = await memberClient(f.ws, 'project_lead', { projects: [f.project.id] });
    const noRationale = await f.owner.attempt(X.conclude, { params: { ...f.W, experimentId: e.id }, body: { findings: 'Question hooks looked stronger in this sample.', limitations: 'Small sample, organic only.', selectedVariantId: e.variants[0]!.id } }, { ifMatch: revised.rowVersion });
    expect(noRationale.status).toBe(422);
    const byLead = await lead.client.attempt(X.conclude, { params: { ...f.W, experimentId: e.id }, body: { findings: 'Question hooks looked stronger in this sample.', limitations: 'Small sample.', selectedVariantId: e.variants[0]!.id, selectionRationale: 'We keep question hooks for the next month.' } }, { ifMatch: revised.rowVersion });
    expect(byLead.status).toBe(403);
    const done = await f.owner.call(
      X.conclude,
      { params: { ...f.W, experimentId: e.id }, body: { findings: 'Question hooks looked stronger in this sample.', limitations: 'Small sample, organic only.', selectedVariantId: e.variants[0]!.id, selectionRationale: 'We keep question hooks for the next month.' } },
      { ifMatch: revised.rowVersion },
    );
    expect(done.status).toBe('concluded');
    expect(done.selectedVariant?.name).toBe('Question hook');
    expect(done.conclusion?.evidence).toMatchObject({ status: 'no_data' });
    expect((await f.owner.attempt(X.update, { params: { ...f.W, experimentId: e.id }, body: { minimumSample: 3, reason: 'Too late' } }, { ifMatch: done.rowVersion })).status).toBe(409);
    const copy = await f.owner.call(X.duplicate, { params: { ...f.W, experimentId: e.id }, body: {} });
    expect(copy).toMatchObject({ status: 'draft', publicationCount: 0, observationWindowHours: 168 });
    expect(copy.duplicatedFrom?.id).toBe(e.id);
    const archived = await f.owner.call(X.archive, { params: { ...f.W, experimentId: e.id }, body: {} }, { ifMatch: done.rowVersion });
    expect(archived.status).toBe('archived');
  });

  it('scopes experiments to the project and refuses placements of other projects', async () => {
    const f = await setup();
    const e = await newExperiment(f.owner, f);
    const lead = await memberClient(f.ws, 'project_lead', { projects: [f.other.id] });
    expect((await lead.client.attempt(X.get, { params: { ...f.W, experimentId: e.id } })).status).toBe(404);
    expect((await lead.client.call(X.list, { params: f.W, query: {} })).items).toHaveLength(0);
    const otherContent = await insertContent(f.ws, f.other.id, { title: 'Nova' });
    const foreign = await f.owner.call(P.create, { params: f.W, body: { contentItemId: otherContent.id, accountId: f.otherAccountId, ownerMembershipId: f.ws.owner.membershipId } });
    expect((await f.owner.attempt(X.linkPublications, { params: { ...f.W, experimentId: e.id }, body: { variantId: e.variants[0]!.id, publicationIds: [foreign.id] } }, { ifMatch: e.rowVersion })).status).toBe(422);
    const producer = await memberClient(f.ws, 'producer', { projects: [f.project.id] });
    expect((await producer.client.call(X.get, { params: { ...f.W, experimentId: e.id } })).permissions.update).toBe(false);
    expect((await producer.client.attempt(X.start, { params: { ...f.W, experimentId: e.id }, body: {} }, { ifMatch: e.rowVersion })).status).toBe(403);
    const metrics = await f.owner.call(X.metrics, { params: f.W });
    expect(metrics.map((m) => m.key)).toContain('publication.views');
    expect(metrics.map((m) => m.key)).not.toContain('account.followers');
  });
});
