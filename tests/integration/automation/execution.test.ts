import { afterEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { newIdempotencyKey } from '@castlane/api-client';
import { automationEndpoints as A, projectEndpoints, taskEndpoints } from '@castlane/api-contracts';
import { getAppServices, RESPONSIBILITY_PROVIDERS, executeCommand, memberJobContext, quietHoursEnd } from '@castlane/application';
import { automationActionEffects, automationRules, automationRuns, incidents, jobs, notifications, outboxEvents, projectMemberships, tasks, userPreferences } from '@castlane/database';
import { DateTime, newId } from '@castlane/domain';
import { assignToProject, mutableClock, resetClock, runQueuedJobs } from '../../support';
import {
  autoSetup,
  automationTasks,
  createRule,
  db,
  dealConfig,
  dispatchOutbox,
  enableRule,
  memberClient,
  moveDeal,
  newDeal,
  requeueRunJobs,
  runsOf,
  settle,
  tableCount,
  tick,
} from './helpers';

afterEach(() => resetClock());

describe('automation execution (§19)', () => {
  it('runs a rule from a domain event as its owner and records the run timeline with the event id', async () => {
    const f = await autoSetup();
    const rule = await enableRule(f.owner, f, await createRule(f.owner, f, { scopeType: 'workspace' }));
    const deal = await newDeal(f.owner, f);
    const d1 = await moveDeal(f.owner, f, deal, ['discussing']);
    await settle();
    // Conditions not met → skipped run, nothing created.
    let runs = await runsOf(rule.id);
    expect(runs.map((r) => [r.state, r.errorCode])).toEqual([['skipped', 'CONDITIONS_NOT_MET']]);
    expect(runs[0]!.errorMessage).toMatch(/New stage is won/);
    await moveDeal(f.owner, f, d1, ['negotiation', 'won']);
    await settle();
    runs = await runsOf(rule.id);
    const done = runs.find((r) => r.state === 'succeeded')!;
    expect(done).toBeTruthy();
    const created = await automationTasks(f.ws.workspaceId);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ title: 'Kick off: Spring launch', dealId: deal.id, projectId: f.projectId, priority: 'high', assigneeMembershipId: f.ws.owner.membershipId });
    const [event] = await db().select().from(outboxEvents).where(eq(outboxEvents.id, done.eventId));
    expect(event?.eventType).toBe('deal.stage_changed');
    const timeline = await f.owner.call(A.runs, { params: { ...f.W, ruleId: rule.id }, query: {} });
    const row = timeline.items.find((r) => r.id === done.id)!;
    expect(row).toMatchObject({ state: 'succeeded', eventId: done.eventId, depth: 0, record: { entityType: 'deal', label: 'Spring launch' } });
    expect(row.actionResults[0]).toMatchObject({ ok: true, entityType: 'task', entityId: created[0]!.id });
    expect(row.actionResults[0]!.href).toContain(`/tasks/${created[0]!.id}`);
    // The created task's audit and event carry the automation causation (depth 1 under the deal event).
    const [taskEvent] = await db().select().from(outboxEvents).where(and(eq(outboxEvents.entityId, created[0]!.id), eq(outboxEvents.eventType, 'task.created')));
    expect(taskEvent).toMatchObject({ rootEventId: event!.rootEventId, parentEventId: event!.id, depth: 1 });
  });

  it('dry run evaluates and previews with zero domain mutations and zero mail (T139)', async () => {
    const f = await autoSetup();
    const rule = await createRule(f.owner, f, {
      config: dealConfig({
        conditions: [{ field: 'deal.stage', operator: 'equals', value: 'lead' }],
        actions: [
          { type: 'create_task', params: { title: 'Prepare proposal for {{entity.title}}', assignee: { kind: 'rule_owner' }, dueInHours: 24 } },
          { type: 'notify', params: { recipients: [{ kind: 'rule_owner' }], title: 'New lead: {{entity.title}}' } },
        ],
      }),
    });
    const deal = await newDeal(f.owner, f);
    await db().update(userPreferences).set({ notifications: { mentions: true, assignments: true, reviewRequests: true, dueReminders: true, emailImmediate: true } as never }).where(eq(userPreferences.userId, f.ws.owner.userId));
    const tables = ['tasks', 'notifications', 'jobs', 'outbox_events', 'audit_events', 'automation_runs', 'automation_action_effects', 'event_stream'];
    const before = await Promise.all(tables.map((t) => (t === 'jobs' || t === 'automation_action_effects' ? tableCountAll(t) : tableCount(t, f.ws.workspaceId))));
    const samples = await f.owner.call(A.dryRunSamples, { params: { ...f.W, ruleId: rule.id }, query: {} });
    expect(samples.map((s) => s.entityId)).toContain(deal.id);
    const result = await f.owner.call(A.dryRun, { params: { ...f.W, ruleId: rule.id }, body: { sample: { entityType: 'deal', entityId: deal.id } } });
    expect(result).toMatchObject({ matched: true, blockedReason: null, rolledBack: true, record: { label: 'Spring launch' } });
    expect(result.conditions[0]).toMatchObject({ field: 'deal.stage', passed: true, actual: 'lead' });
    expect(result.actions.map((a) => a.ok)).toEqual([true, true]);
    expect(result.actions[0]!.preview).toMatch(/Create task “Prepare proposal for Spring launch” in Emma Model/);
    expect(result.actions[1]!.preview).toMatch(/Notify/);
    const after = await Promise.all(tables.map((t) => (t === 'jobs' || t === 'automation_action_effects' ? tableCountAll(t) : tableCount(t, f.ws.workspaceId))));
    expect(after).toEqual(before);
    const mail = await db().select().from(jobs).where(eq(jobs.type, 'mail.notification'));
    expect(mail).toHaveLength(0);
    // A sample outside the requester's reach is not found.
    expect((await f.owner.attempt(A.dryRun, { params: { ...f.W, ruleId: rule.id }, body: { sample: { entityType: 'deal', entityId: newId() } } })).status).toBe(404);
  });

  it('a lost result or a duplicate delivery produces one observable effect; Retry keeps the operation key (T140)', async () => {
    const f = await autoSetup();
    const outsider = await memberClient(f.ws, 'creator', { name: 'Olga Outsider' });
    const rule = await enableRule(
      f.owner,
      f,
      await createRule(f.owner, f, {
        config: dealConfig({
          actions: [
            { type: 'create_task', params: { title: 'Kick off: {{entity.title}}', assignee: { kind: 'rule_owner' } } },
            // The member is not on the project team yet: this action fails until they are added.
            { type: 'create_task', params: { title: 'Brief the team on {{entity.title}}', assignee: { kind: 'member', membershipId: outsider.membershipId } } },
          ],
        }),
      }),
    );
    const deal = await newDeal(f.owner, f);
    await moveDeal(f.owner, f, deal, ['negotiation', 'won']);
    await settle();
    const [run] = await runsOf(rule.id).then((r) => r.filter((x) => x.state !== 'skipped'));
    expect(run).toMatchObject({ state: 'failed', errorCode: 'ACTION_FAILED' });
    expect(run!.actionResults.map((a) => a.ok)).toEqual([true, false]);
    expect(await automationTasks(f.ws.workspaceId)).toHaveLength(1);
    // The worker loses the job result after commit and runs the job again: nothing new happens.
    await requeueRunJobs(run!.id);
    await runQueuedJobs(['automation.run']);
    expect(await automationTasks(f.ws.workspaceId)).toHaveLength(1);
    // The outbox delivers the same event twice: the run's operation key is unique.
    await db().update(outboxEvents).set({ dispatchedAt: null }).where(eq(outboxEvents.id, run!.eventId));
    await settle();
    expect((await runsOf(rule.id)).filter((r) => r.eventId === run!.eventId)).toHaveLength(1);
    // Fix the cause, then Retry Failed Run: the first effect is not repeated, the second happens once.
    await assignToProject(db(), f.ws, f.projectId, outsider.membershipId);
    const detail = await f.owner.call(A.run, { params: { ...f.W, runId: run!.id } });
    expect(detail.canRetry).toBe(true);
    expect((await f.owner.attempt(A.retryRun, { params: { ...f.W, runId: run!.id }, body: { reason: 'Olga joined' } })).status).toBe(428);
    const key = newIdempotencyKey();
    const retried = await f.owner.call(A.retryRun, { params: { ...f.W, runId: run!.id }, body: { reason: 'Olga joined the project team' } }, { ifMatch: detail.rowVersion, idempotencyKey: key });
    expect(retried.state).toBe('pending');
    const replay = await f.owner.call(A.retryRun, { params: { ...f.W, runId: run!.id }, body: { reason: 'Olga joined the project team' } }, { ifMatch: detail.rowVersion, idempotencyKey: key });
    expect(replay.id).toBe(run!.id);
    await runQueuedJobs(['automation.run']);
    const [final] = await db().select().from(automationRuns).where(eq(automationRuns.id, run!.id));
    expect(final).toMatchObject({ state: 'succeeded', operationKey: run!.operationKey });
    expect(final!.actionResults.map((a) => [a.ok, !!a.skipped])).toEqual([
      [true, true],
      [true, false],
    ]);
    const all = await automationTasks(f.ws.workspaceId);
    expect(all.map((t) => t.title).sort()).toEqual(['Brief the team on Spring launch', 'Kick off: Spring launch']);
    const effects = await db().select().from(automationActionEffects).where(eq(automationActionEffects.runId, run!.id));
    expect(effects).toHaveLength(2);
    // Succeeded runs cannot be retried.
    const again = await f.owner.call(A.run, { params: { ...f.W, runId: run!.id } });
    expect((await f.owner.attempt(A.retryRun, { params: { ...f.W, runId: run!.id }, body: { reason: 'Once more' } }, { ifMatch: again.rowVersion })).status).toBe(409);
  });

  it('stops recursive chains by rule repetition, depth and budget with an alert (T141)', async () => {
    const f = await autoSetup();
    const clock = mutableClock(new Date(Date.now() + 60_000).toISOString());
    // A rule whose action makes a new overdue task would trigger itself forever without the chain guard.
    const rule = await enableRule(
      f.owner,
      f,
      await createRule(f.owner, f, {
        name: 'Overdue chaser',
        config: { trigger: { event: 'task.overdue', thresholdHours: 0 }, conditions: [], actions: [{ type: 'create_task', params: { title: 'Chase: {{entity.title}}', assignee: { kind: 'rule_owner' }, dueInHours: 0 } }], quietHoursPolicy: 'respect' },
      }),
    );
    const t0 = await f.owner.call(taskEndpoints.create, { params: f.W, body: { title: 'Deliver cut', projectId: f.projectId, due: { kind: 'datetime', at: new Date(clock.now().getTime() - 3_600_000).toISOString(), timezone: 'UTC' } } });
    await tick(f.ws.workspaceId);
    clock.advance(5);
    await tick(f.ws.workspaceId);
    clock.advance(5);
    await tick(f.ws.workspaceId);
    const created = await automationTasks(f.ws.workspaceId);
    expect(created.map((t) => t.title)).toEqual(['Chase: Deliver cut']);
    const runs = await runsOf(rule.id);
    const first = runs.find((r) => r.entityId === t0.id)!;
    const second = runs.find((r) => r.entityId === created[0]!.id)!;
    expect(second).toMatchObject({ state: 'skipped', errorCode: 'RECURSION', rootEventId: first.rootEventId, depth: 1 });
    const alerts = await db().select().from(incidents).where(and(eq(incidents.workspaceId, f.ws.workspaceId), sql`${incidents.alertKey} LIKE 'automation.chain:%'`));
    expect(alerts).toHaveLength(1);
    const ownerInbox = await db().select().from(notifications).where(and(eq(notifications.recipientMembershipId, f.ws.owner.membershipId), eq(notifications.eventType, 'automation.chain_stopped')));
    expect(ownerInbox).toHaveLength(1);

    // Depth: an event already 6 levels deep is refused.
    const dealRule = await enableRule(f.owner, f, await createRule(f.owner, f, { name: 'Deep', config: dealConfig({ conditions: [] }) }));
    const deal = await newDeal(f.owner, f);
    await dispatchOutbox();
    const root = newId();
    await db().insert(outboxEvents).values({ id: newId(), workspaceId: f.ws.workspaceId, eventType: 'deal.stage_changed', entityType: 'deal', entityId: deal.id, payload: { from: 'lead', to: 'discussing' }, occurredAt: clock.now(), rootEventId: root, parentEventId: newId(), depth: 6 });
    await settle();
    const deep = (await runsOf(dealRule.id)).find((r) => r.rootEventId === root)!;
    expect(deep).toMatchObject({ state: 'failed', errorCode: 'DEPTH_LIMIT', depth: 6 });

    // Budget: at most 50 created tasks/notifications per root event across the chain.
    const budgetRoot = newId();
    const fakeRun = newId();
    await db().insert(automationRuns).values({ id: fakeRun, workspaceId: f.ws.workspaceId, createdAt: clock.now(), updatedAt: clock.now(), ruleId: rule.id, ruleVersionId: rule.enabledVersionId!, eventId: budgetRoot, rootEventId: budgetRoot, operationKey: `test:${budgetRoot}`, state: 'succeeded' });
    await db().insert(automationActionEffects).values(Array.from({ length: 50 }, (_, i) => ({ workspaceId: f.ws.workspaceId, effectKey: `test:${budgetRoot}:${i}`, runId: fakeRun, entityType: 'task', entityId: newId() })));
    await db().insert(outboxEvents).values({ id: newId(), workspaceId: f.ws.workspaceId, eventType: 'deal.stage_changed', entityType: 'deal', entityId: deal.id, payload: { from: 'lead', to: 'discussing' }, occurredAt: clock.now(), rootEventId: budgetRoot, parentEventId: budgetRoot, depth: 1 });
    await settle();
    const over = (await runsOf(dealRule.id)).find((r) => r.rootEventId === budgetRoot)!;
    expect(over).toMatchObject({ state: 'failed', errorCode: 'BUDGET_EXCEEDED' });
    expect((await automationTasks(f.ws.workspaceId)).map((t) => t.title)).toEqual(['Chase: Deliver cut']);
  });

  it('pauses as Requires Attention when the owner loses scope, without any unauthorized action (T142)', async () => {
    const f = await autoSetup();
    const lead = await memberClient(f.ws, 'project_lead', { projects: [f.projectId], name: 'Lena Lead' });
    const rule = await enableRule(f.owner, f, await createRule(f.owner, f, { ownerMembershipId: lead.membershipId, config: dealConfig({ actions: [{ type: 'create_task', params: { title: 'Kick off: {{entity.title}}', assignee: { kind: 'rule_owner' } } }] }) }));
    expect(rule.state).toBe('enabled');
    const deal = await newDeal(f.owner, f);
    await settle();
    // Runtime path: access removed without any event → the run itself detects it and pauses the rule.
    await db().update(projectMemberships).set({ validTo: new Date(Date.now() - 1000) }).where(and(eq(projectMemberships.projectId, f.projectId), eq(projectMemberships.membershipId, lead.membershipId)));
    await moveDeal(f.owner, f, deal, ['negotiation', 'won']);
    await settle();
    const runs = (await runsOf(rule.id)).filter((r) => r.state !== 'skipped');
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ state: 'failed', errorCode: 'OWNER_ACCESS' });
    expect(await automationTasks(f.ws.workspaceId)).toHaveLength(0);
    const detail = await f.owner.call(A.get, { params: { ...f.W, ruleId: rule.id } });
    expect(detail.state).toBe('paused_requires_attention');
    expect(detail.pausedReason).toMatch(/owner no longer holds/);
    const inbox = await db().select().from(notifications).where(and(eq(notifications.recipientMembershipId, lead.membershipId), eq(notifications.eventType, 'automation.paused')));
    expect(inbox).toHaveLength(1);
    // Re-enabling is refused while the owner lacks the scope.
    expect((await f.owner.attempt(A.enable, { params: { ...f.W, ruleId: rule.id }, body: { versionId: detail.currentVersion!.id } }, { ifMatch: detail.rowVersion })).status).toBe(422);
  });

  it('revalidates proactively when an owner is removed from the project team (T142)', async () => {
    const f = await autoSetup();
    const lead = await memberClient(f.ws, 'project_lead', { projects: [f.projectId] });
    const rule = await enableRule(f.owner, f, await createRule(f.owner, f, { ownerMembershipId: lead.membershipId, config: dealConfig({ actions: [{ type: 'create_task', params: { title: 'Kick off', assignee: { kind: 'rule_owner' } } }] }) }));
    const project = await f.owner.call(projectEndpoints.get, { params: { ...f.W, projectId: f.projectId } });
    const membership = project.team.find((t) => t.member.membershipId === lead.membershipId)!;
    await f.owner.call(projectEndpoints.endMember, { params: { ...f.W, projectId: f.projectId, projectMemberId: membership.id }, body: { reason: 'Moved to another project' } });
    await settle();
    const [r] = await db().select().from(automationRules).where(eq(automationRules.id, rule.id));
    expect(r!.state).toBe('paused_requires_attention');
    // Events after the pause create no runs.
    const deal = await newDeal(f.owner, f);
    await moveDeal(f.owner, f, deal, ['negotiation', 'won']);
    await settle();
    expect(await runsOf(rule.id)).toHaveLength(0);
  });

  it('Disable cancels runs that have not started; completed effects stay', async () => {
    const f = await autoSetup();
    const rule = await enableRule(f.owner, f, await createRule(f.owner, f));
    const deal = await newDeal(f.owner, f);
    await moveDeal(f.owner, f, deal, ['negotiation', 'won']);
    await dispatchOutbox();
    const pending = (await runsOf(rule.id)).filter((r) => r.state === 'pending');
    expect(pending.length).toBeGreaterThan(0);
    const detail = await f.owner.call(A.get, { params: { ...f.W, ruleId: rule.id } });
    const disabled = await f.owner.call(A.disable, { params: { ...f.W, ruleId: rule.id }, body: { reason: 'Campaign paused' } }, { ifMatch: detail.rowVersion });
    expect(disabled.state).toBe('disabled');
    await runQueuedJobs(['automation.run']);
    const after = await runsOf(rule.id);
    expect(after.every((r) => r.state === 'skipped')).toBe(true);
    expect(after.some((r) => r.errorCode === 'RULE_DISABLED')).toBe(true);
    expect(await automationTasks(f.ws.workspaceId)).toHaveLength(0);
  });

  it('owner deactivation hands the rule over or pauses it as Needs Owner (F12)', async () => {
    const f = await autoSetup();
    const lead = await memberClient(f.ws, 'project_lead', { projects: [f.projectId] });
    const rule = await enableRule(f.owner, f, await createRule(f.owner, f, { ownerMembershipId: lead.membershipId, config: dealConfig({ actions: [{ type: 'notify', params: { recipients: [{ kind: 'rule_owner' }], title: 'Deal won' } }] }) }));
    const provider = RESPONSIBILITY_PROVIDERS.get('automations.owner')!;
    const base = (await memberJobContext(getAppServices(), f.ws.workspaceId, f.ws.owner.membershipId))!;
    const items = await provider.list(base, lead.membershipId);
    expect(items).toEqual([expect.objectContaining({ entityId: rule.id, requiresSuccessor: true })]);
    // A successor without the scope is refused.
    const creator = await memberClient(f.ws, 'creator', { projects: [f.projectId] });
    await expect(executeCommand(base, (c) => provider.transfer(c, lead.membershipId, [{ entityId: rule.id, successorMembershipId: creator.membershipId }]))).rejects.toThrow(/lacks/);
    await executeCommand(base, (c) => provider.transfer(c, lead.membershipId, [{ entityId: rule.id, successorMembershipId: null }]));
    const detail = await f.owner.call(A.get, { params: { ...f.W, ruleId: rule.id } });
    expect(detail).toMatchObject({ state: 'paused_needs_owner', needsOwner: true, owner: null });
    const list = await f.owner.call(A.list, { params: f.W, query: { needsAttention: true } });
    expect(list.items.map((r) => r.id)).toEqual([rule.id]);
  });

  it('notifications are in the Inbox immediately; email copies follow the quiet-hours policy (T144)', async () => {
    const f = await autoSetup();
    const member = await memberClient(f.ws, 'project_lead', { projects: [f.projectId] });
    // The recipient's quiet hours cover "now" in their zone.
    const now = getAppServices().clock.now();
    const local = DateTime.fromJSDate(now, { zone: 'Europe/Berlin' });
    const start = local.minus({ hours: 1 }).toFormat('HH:mm');
    const end = local.plus({ hours: 2 }).toFormat('HH:mm');
    await db()
      .update(userPreferences)
      .set({ timezone: 'Europe/Berlin', quietHoursStart: start, quietHoursEnd: end, notifications: { mentions: true, assignments: true, reviewRequests: true, dueReminders: true, emailImmediate: true } as never })
      .where(eq(userPreferences.userId, member.userId));
    const notifyConfig = (policy: 'respect' | 'ignore_for_inbox', title: string) =>
      dealConfig({ conditions: [], quietHoursPolicy: policy, actions: [{ type: 'notify', params: { recipients: [{ kind: 'member', membershipId: member.membershipId }], title } }] });
    await enableRule(f.owner, f, await createRule(f.owner, f, { name: 'Respect', config: notifyConfig('respect', 'Deal moved (respect)') }));
    await enableRule(f.owner, f, await createRule(f.owner, f, { name: 'Inbox only', config: notifyConfig('ignore_for_inbox', 'Deal moved (inbox)') }));
    await newDeal(f.owner, f);
    const deal = await newDeal(f.owner, f, f.projectId, 'Autumn launch');
    await moveDeal(f.owner, f, deal, ['discussing']);
    await dispatchOutbox();
    await runQueuedJobs(['automation.run']);
    const inbox = await db().select().from(notifications).where(and(eq(notifications.recipientMembershipId, member.membershipId), eq(notifications.eventType, 'automation.notification')));
    expect(inbox.map((n) => n.title).sort()).toEqual(['Deal moved (inbox)', 'Deal moved (respect)']);
    const mail = await db().select().from(jobs).where(eq(jobs.type, 'mail.notification'));
    expect(mail).toHaveLength(1);
    // Deferred to the end of the quiet hours (not sent now), within the next 3 hours.
    const delay = mail[0]!.runAt.getTime() - now.getTime();
    expect(delay).toBeGreaterThan(60 * 60_000);
    expect(delay).toBeLessThanOrEqual(3 * 3_600_000);
    expect(mail[0]!.runAt.toISOString()).toBe(quietHoursEnd(now, 'Europe/Berlin', end).toISOString());
    const ids = inbox.map((n) => n.id);
    expect(ids).toContain(String(mail[0]!.payload.notificationId));
  });

  it('scheduled rules run once per slot in the workspace time zone', async () => {
    const f = await autoSetup();
    const clock = mutableClock(new Date(Date.now() + 60_000).toISOString());
    const nextNine = (from: Date) => {
      let d = DateTime.fromJSDate(from, { zone: 'Europe/Berlin' }).set({ hour: 9, minute: 0, second: 0, millisecond: 0 });
      if (d.toJSDate() <= from) d = d.plus({ days: 1 });
      return d.toUTC().toJSDate();
    };
    const slot1 = nextNine(clock.now());
    const rule = await enableRule(
      f.owner,
      f,
      await createRule(f.owner, f, {
        name: 'Weekly metrics',
        scopeType: 'workspace',
        config: { trigger: { event: 'schedule.daily', schedule: { cadence: 'daily', localTime: '09:00' } }, conditions: [], actions: [{ type: 'create_task', params: { title: 'Update metrics ({{date}})', projectId: f.projectId, assignee: { kind: 'rule_owner' } } }], quietHoursPolicy: 'respect' },
      }),
    );
    expect(rule.nextScheduledAt).toBe(slot1.toISOString());
    await tick(f.ws.workspaceId);
    expect(await automationTasks(f.ws.workspaceId)).toHaveLength(0);
    clock.set(new Date(slot1.getTime() + 60_000).toISOString());
    await tick(f.ws.workspaceId);
    await tick(f.ws.workspaceId);
    const created = await automationTasks(f.ws.workspaceId);
    expect(created.map((t) => t.title)).toEqual([`Update metrics (${DateTime.fromJSDate(slot1, { zone: 'Europe/Berlin' }).toISODate()})`]);
    const [r] = await db().select().from(automationRules).where(eq(automationRules.id, rule.id));
    expect(r!.nextScheduledAt?.toISOString()).toBe(nextNine(new Date(slot1.getTime() + 60_000)).toISOString());
    // Missed slots after downtime run once, not in a burst.
    clock.set(new Date(slot1.getTime() + 4 * 86_400_000 + 3_600_000).toISOString());
    await tick(f.ws.workspaceId);
    expect(await automationTasks(f.ws.workspaceId)).toHaveLength(2);
  });

  it('task actions change only the triggering task and respect eligibility', async () => {
    const f = await autoSetup();
    const clock = mutableClock(new Date(Date.now() + 60_000).toISOString());
    const creator = await memberClient(f.ws, 'creator', { projects: [f.projectId] });
    await enableRule(
      f.owner,
      f,
      await createRule(f.owner, f, {
        name: 'Overdue triage',
        config: {
          trigger: { event: 'task.overdue', thresholdHours: 1 },
          conditions: [{ field: 'task.assignee', operator: 'equals', value: null }],
          actions: [
            { type: 'assign_member', params: { assignee: { kind: 'member', membershipId: creator.membershipId } } },
            { type: 'set_field', params: { field: 'priority', value: 'urgent' } },
            { type: 'add_tag', params: { tag: 'escalated' } },
            { type: 'add_checklist_item', params: { label: 'Agree a new deadline', mandatory: false } },
          ],
          quietHoursPolicy: 'respect',
        },
      }),
    );
    const due = new Date(clock.now().getTime() - 3 * 3_600_000).toISOString();
    const unassigned = await f.owner.call(taskEndpoints.create, { params: f.W, body: { title: 'Unassigned overdue', projectId: f.projectId, due: { kind: 'datetime', at: due, timezone: 'UTC' } } });
    const assigned = await f.owner.call(taskEndpoints.create, { params: f.W, body: { title: 'Assigned overdue', projectId: f.projectId, assigneeMembershipId: f.ws.owner.membershipId, due: { kind: 'datetime', at: due, timezone: 'UTC' } } });
    await tick(f.ws.workspaceId);
    const [t1] = await db().select().from(tasks).where(eq(tasks.id, unassigned.id));
    expect(t1).toMatchObject({ assigneeMembershipId: creator.membershipId, priority: 'urgent', tags: ['escalated'] });
    const detail = await f.owner.call(taskEndpoints.get, { params: { ...f.W, taskId: unassigned.id } });
    expect(detail.checklistItems.map((c) => c.label)).toEqual(['Agree a new deadline']);
    const [t2] = await db().select().from(tasks).where(eq(tasks.id, assigned.id));
    expect(t2).toMatchObject({ priority: 'normal', tags: [] });
    // The same deadline revision never triggers twice.
    clock.advance(10);
    await tick(f.ws.workspaceId);
    const effects = await db().select().from(automationActionEffects).where(eq(automationActionEffects.entityId, unassigned.id));
    expect(effects).toHaveLength(4);
  });
});

const tableCountAll = async (table: string) => Number((await db().execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM ${sql.identifier(table)}`)).rows[0]?.n ?? 0);
