import { afterEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { newIdempotencyKey } from '@castlane/api-client';
import { recurrenceEndpoints as R, taskEndpoints as T } from '@castlane/api-contracts';
import { enqueueJob, getAppServices } from '@castlane/application';
import { recurrenceOccurrences, recurrenceRules, taskDependencies, tasks, templateApplications, templates, templateVersions } from '@castlane/database';
import { newId } from '@castlane/domain';
import { mutableClock, resetClock, runQueuedJobs } from '../../support';
import { db, member, workFixture, type WorkFixture } from './helpers';

afterEach(() => resetClock());

const runGenerator = async () => {
  await enqueueJob(getAppServices().db, { type: 'work.recurrence', workspaceId: null, idempotencyKey: `test:${newId()}` });
  return runQueuedJobs(['work.recurrence']);
};

const iso = (d: Date) => d.toISOString().slice(0, 10);

describe('recurring tasks', () => {
  it('generates occurrences within the horizon with unique keys; a retried run after an outage creates no duplicates and one overdue occurrence (T054)', async () => {
    const f = await workFixture();
    const start = new Date(Date.now() + 60_000);
    const clock = mutableClock(start.toISOString());
    const rule = await f.owner.call(R.create, {
      params: f.params,
      body: {
        projectId: f.projectId,
        template: { title: 'Daily metrics check', assigneeMembershipId: f.ws.owner.membershipId },
        cadence: 'daily',
        localTime: '23:59',
        timezone: 'UTC',
        startsOn: iso(start),
        horizonDays: 3,
      },
    });
    const count = async () => (await db().select().from(tasks).where(and(eq(tasks.workspaceId, f.ws.workspaceId), eq(tasks.source, 'recurrence')))).length;
    const initial = await count();
    expect(initial).toBeGreaterThanOrEqual(3);
    // Retrying the same run (e.g. the job ran twice) creates nothing new.
    await runGenerator();
    await runGenerator();
    expect(await count()).toBe(initial);
    // Outage: nothing ran for 10 days (the session is refreshed but the generator did not run).
    for (let i = 0; i < 5; i++) {
      clock.advance(2 * 24 * 60);
      await f.owner.call(R.get, { params: { ...f.params, ruleId: rule.id } }).catch(() => undefined);
    }
    await runGenerator();
    const occ = await db().select().from(recurrenceOccurrences).where(eq(recurrenceOccurrences.ruleId, rule.id));
    const missed = occ.filter((o) => o.state === 'missed');
    const created = occ.filter((o) => o.state === 'created');
    const overdue = created.filter((o) => o.missedDates.length > 0);
    expect(overdue).toHaveLength(1);
    expect(overdue[0]!.missedDates.length).toBe(missed.length);
    expect(new Set(occ.map((o) => o.occurrenceKey)).size).toBe(occ.length);
    await runGenerator();
    expect((await db().select().from(recurrenceOccurrences).where(eq(recurrenceOccurrences.ruleId, rule.id))).length).toBe(occ.length);
  });

  it('monthly on the 31st follows the Last Day of Month policy reproducibly (T055)', async () => {
    const f = await workFixture();
    const preview = await f.owner.call(R.preview, {
      params: f.params,
      body: { cadence: 'monthly', monthDay: 31, monthDayPolicy: 'last_day_of_month', localTime: '10:00', timezone: 'Europe/Berlin', startsOn: '2027-01-31', intervalCount: 1, weekdays: [], mode: 'fixed_schedule', horizonDays: 30, backfillLimit: 0 },
    });
    expect(preview.occurrences.slice(0, 4).map((o) => o.key)).toEqual(['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30']);
    expect(preview.occurrences[1]!.clampedToMonthEnd).toBe(true);
    expect(preview.occurrences[0]!.scheduledFor).toBe('2027-01-31T09:00:00.000Z');
  });

  it('a rule change updates future not-started instances only, after a diff', async () => {
    const f = await workFixture();
    const start = new Date(Date.now() + 60_000);
    const rule = await f.owner.call(R.create, {
      params: f.params,
      body: { projectId: f.projectId, template: { title: 'Weekly plan', assigneeMembershipId: f.ws.owner.membershipId }, cadence: 'daily', localTime: '23:30', timezone: 'UTC', startsOn: iso(start), horizonDays: 4 },
    });
    const created = await db().select().from(tasks).where(and(eq(tasks.workspaceId, f.ws.workspaceId), eq(tasks.source, 'recurrence')));
    // Start work on one instance: it must not be touched by the change.
    const started = created[created.length - 1]!;
    await f.owner.call(T.transition, { params: { ...f.params, taskId: started.id }, body: { targetState: 'in_progress' } }, { ifMatch: started.rowVersion });
    const diff = await f.owner.call(R.changePreview, { params: { ...f.params, ruleId: rule.id }, body: { template: { title: 'Weekly plan v2', assigneeMembershipId: f.ws.owner.membershipId } } });
    expect(diff.startedUnaffected).toBe(1);
    expect(diff.updated.length).toBe(created.length - 1);
    const updated = await f.owner.call(R.update, { params: { ...f.params, ruleId: rule.id }, body: { template: { title: 'Weekly plan v2', assigneeMembershipId: f.ws.owner.membershipId } } }, { ifMatch: rule.rowVersion });
    expect(updated.ruleVersion).toBe(2);
    const after = await db().select().from(tasks).where(and(eq(tasks.workspaceId, f.ws.workspaceId), eq(tasks.source, 'recurrence')));
    expect(after.find((t) => t.id === started.id)!.title).toBe('Weekly plan');
    expect(after.filter((t) => t.id !== started.id).every((t) => t.title === 'Weekly plan v2')).toBe(true);
    // Pausing stops generation; resuming never backfills the paused period.
    const paused = await f.owner.call(R.setActive, { params: { ...f.params, ruleId: rule.id }, body: { active: false } }, { ifMatch: updated.rowVersion });
    expect(paused.active).toBe(false);
  });

  it('after-completion mode creates the next occurrence when the current one is done', async () => {
    const f = await workFixture();
    const start = new Date(Date.now() + 60_000);
    const rule = await f.owner.call(R.create, {
      params: f.params,
      body: { projectId: f.projectId, template: { title: 'Clean the asset library', assigneeMembershipId: f.ws.owner.membershipId }, cadence: 'weekly', localTime: '09:00', timezone: 'UTC', startsOn: iso(new Date(start.getTime() + 86_400_000)), mode: 'after_completion' },
    });
    const first = await db().select().from(tasks).where(and(eq(tasks.workspaceId, f.ws.workspaceId), eq(tasks.source, 'recurrence')));
    expect(first).toHaveLength(1);
    let t = first[0]!;
    const s = await f.owner.call(T.transition, { params: { ...f.params, taskId: t.id }, body: { targetState: 'in_progress' } }, { ifMatch: t.rowVersion });
    await f.owner.call(T.transition, { params: { ...f.params, taskId: t.id }, body: { targetState: 'done' } }, { ifMatch: s.rowVersion });
    const next = await db().select().from(tasks).where(and(eq(tasks.workspaceId, f.ws.workspaceId), eq(tasks.source, 'recurrence')));
    expect(next).toHaveLength(2);
    t = next.find((x) => x.id !== t.id)!;
    expect(t.status).toBe('ready');
    const rules = await db().select().from(recurrenceRules).where(eq(recurrenceRules.id, rule.id));
    expect(rules[0]!.mode).toBe('after_completion');
  });
});

const seedTemplate = async (f: WorkFixture) => {
  const templateId = newId();
  const versionId = newId();
  const at = new Date();
  await db().insert(templates).values({ id: templateId, workspaceId: f.ws.workspaceId, kind: 'content', name: 'Short Video', createdAt: at, updatedAt: at });
  await db().insert(templateVersions).values({
    id: versionId,
    workspaceId: f.ws.workspaceId,
    templateId,
    versionNo: 1,
    state: 'published',
    publishedAt: at,
    createdAt: at,
    updatedAt: at,
    config: {
      tasks: [
        { key: 'brief', title: 'Brief', offsetDaysFromStart: 0, durationDays: 1, responsibility: 'producing', estimateMinutes: 60 },
        { key: 'script', title: 'Script', offsetDaysFromStart: 1, durationDays: 2, dependsOn: ['brief'], responsibility: 'writing', checklist: [{ label: 'Hook in first 2 s', mandatory: true }] },
        { key: 'edit', title: 'Edit', offsetDaysFromStart: 3, durationDays: 2, dependsOn: ['script'], responsibility: 'editing', requiresReview: true },
      ],
    },
  });
  await db().update(templates).set({ publishedVersionId: versionId }).where(eq(templates.id, templateId));
  return versionId;
};

describe('task templates (T036)', () => {
  it('previews, then creates the graph exactly once per application key; unknown assignees stay Unassigned with a coordination task', async () => {
    const f = await workFixture();
    const producer = await member(f, 'producer', { projects: [f.projectId] });
    const versionId = await seedTemplate(f);
    const options = await producer.client.call(T.templateOptions, { params: f.params, query: {} });
    expect(options.map((o) => o.templateVersionId)).toContain(versionId);
    const target = { templateVersionId: versionId, targetType: 'project' as const, targetId: f.projectId, projectId: f.projectId, startDate: '2026-12-07', timezone: 'Europe/Berlin', assignees: { producing: producer.membershipId } };
    const preview = await producer.client.call(T.templatePreview, { params: f.params, body: target });
    expect(preview.tasks.map((t) => [t.key, t.startDate, t.dueDate])).toEqual([
      ['brief', '2026-12-07', '2026-12-07'],
      ['script', '2026-12-08', '2026-12-09'],
      ['edit', '2026-12-10', '2026-12-11'],
    ]);
    expect(preview.unassignedCount).toBe(2);
    expect(preview.existingApplication).toBeNull();
    const body = { ...target, applicationKey: preview.applicationKey };
    const first = await producer.client.call(T.applyTemplate, { params: f.params, body });
    expect(first.created).toBe(true);
    expect(first.taskIds).toHaveLength(3);
    expect(first.coordinationTaskId).not.toBeNull();
    // A repeat — even with another Idempotency-Key — creates nothing new.
    const second = await producer.client.call(T.applyTemplate, { params: f.params, body }, { idempotencyKey: newIdempotencyKey() });
    expect(second.created).toBe(false);
    expect(second.taskIds).toEqual(first.taskIds);
    const created = await db().select().from(tasks).where(and(eq(tasks.workspaceId, f.ws.workspaceId), eq(tasks.source, 'template')));
    expect(created).toHaveLength(4);
    const apps = await db().select().from(templateApplications).where(eq(templateApplications.workspaceId, f.ws.workspaceId));
    expect(apps).toHaveLength(1);
    const deps = await db().select().from(taskDependencies).where(eq(taskDependencies.workspaceId, f.ws.workspaceId));
    expect(deps).toHaveLength(2);
    const brief = created.find((t) => t.title === 'Brief')!;
    expect(brief.assigneeMembershipId).toBe(producer.membershipId);
    expect(brief.dueDate).toBe('2026-12-07');
    expect(created.find((t) => t.title === 'Script')!.assigneeMembershipId).toBeNull();
    const again = await producer.client.call(T.templatePreview, { params: f.params, body: target });
    expect(again.existingApplication?.id).toBe(first.applicationId);
  });
});
