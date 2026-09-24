import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  AUTOMATION_LIMITS,
  automationChainVerdict,
  automationRetryDelaySeconds,
  automationThrottleUntil,
  evaluateAutomationConditions,
  nextAutomationSlot,
  renderAutomationText,
  unknownAutomationPlaceholders,
  uuidFromHex,
  validateAutomationConditions,
  validateAutomationSchedule,
  type AutomationFieldSpec,
} from './automation';
import { isUuid } from './ids';

const FIELDS: AutomationFieldSpec[] = [
  { key: 'task.priority', label: 'Priority', type: 'enum', options: ['low', 'normal', 'high', 'urgent'] },
  { key: 'task.assignee', label: 'Assignee', type: 'member' },
  { key: 'task.tags', label: 'Tags', type: 'tags' },
  { key: 'task.hoursOverdue', label: 'Hours overdue', type: 'number' },
  { key: 'task.dueAt', label: 'Due', type: 'datetime' },
  { key: 'task.blocked', label: 'Blocked', type: 'boolean' },
];
const NOW = new Date('2026-09-24T12:00:00Z');
const M = '7b0c8f19-43b5-4d56-8f0c-c9a1b427ea22';

describe('automation conditions', () => {
  it('matches enum, member, tags and boolean facts with AND semantics', () => {
    const facts = { 'task.priority': 'high', 'task.assignee': M, 'task.tags': ['Launch', 'hook'], 'task.blocked': false, 'task.hoursOverdue': 30, 'task.dueAt': '2026-09-23T10:00:00Z' };
    const r = evaluateAutomationConditions(
      [
        { field: 'task.priority', operator: 'in', value: ['high', 'urgent'] },
        { field: 'task.assignee', operator: 'equals', value: M },
        { field: 'task.tags', operator: 'equals', value: 'launch' },
        { field: 'task.blocked', operator: 'equals', value: false },
        { field: 'task.hoursOverdue', operator: 'gte', value: 24 },
        { field: 'task.dueAt', operator: 'elapsed_gte', value: 24 },
      ],
      facts,
      FIELDS,
      NOW,
    );
    expect(r.matched).toBe(true);
    const miss = evaluateAutomationConditions([{ field: 'task.priority', operator: 'not_equals', value: 'high' }], facts, FIELDS, NOW);
    expect(miss.matched).toBe(false);
  });

  it('never treats an unknown number or date as 0 (unknown ≠ 0)', () => {
    const facts = { 'task.hoursOverdue': null, 'task.dueAt': null };
    for (const c of [
      { field: 'task.hoursOverdue', operator: 'lte' as const, value: 10 },
      { field: 'task.hoursOverdue', operator: 'gte' as const, value: 0 },
      { field: 'task.hoursOverdue', operator: 'equals' as const, value: 0 },
      { field: 'task.dueAt', operator: 'elapsed_gte' as const, value: 0 },
    ]) {
      const r = evaluateAutomationConditions([c], facts, FIELDS, NOW);
      expect(r.matched).toBe(false);
      expect(r.results[0]!.reason).toBeTruthy();
    }
  });

  it('treats an empty member as known empty (unassigned)', () => {
    expect(evaluateAutomationConditions([{ field: 'task.assignee', operator: 'equals', value: null }], { 'task.assignee': null }, FIELDS, NOW).matched).toBe(true);
    expect(evaluateAutomationConditions([{ field: 'task.assignee', operator: 'not_equals', value: M }], { 'task.assignee': null }, FIELDS, NOW).matched).toBe(true);
  });

  it('validates fields, operators and values against the trigger catalogue', () => {
    const errors = validateAutomationConditions(
      [
        { field: 'task.unknown', operator: 'equals', value: 'x' },
        { field: 'task.priority', operator: 'gte', value: 'high' },
        { field: 'task.priority', operator: 'equals', value: 'critical' },
        { field: 'task.hoursOverdue', operator: 'gte', value: 'many' },
        { field: 'task.assignee', operator: 'in', value: [] },
        { field: 'task.priority', operator: 'equals', value: 'high' },
      ],
      FIELDS,
    );
    expect(errors.map((e) => e.field)).toEqual([
      'config.conditions.0.field',
      'config.conditions.1.operator',
      'config.conditions.2.value',
      'config.conditions.3.value',
      'config.conditions.4.value',
    ]);
  });

  it('evaluation is deterministic and total for arbitrary facts (property)', () => {
    fc.assert(
      fc.property(fc.option(fc.integer({ min: -1000, max: 1000 }), { nil: null }), fc.integer({ min: -1000, max: 1000 }), (actual, threshold) => {
        const gte = evaluateAutomationConditions([{ field: 'task.hoursOverdue', operator: 'gte', value: threshold }], { 'task.hoursOverdue': actual }, FIELDS, NOW).matched;
        const lte = evaluateAutomationConditions([{ field: 'task.hoursOverdue', operator: 'lte', value: threshold }], { 'task.hoursOverdue': actual }, FIELDS, NOW).matched;
        if (actual === null) return !gte && !lte;
        return gte === actual >= threshold && lte === actual <= threshold;
      }),
    );
  });
});

describe('automation schedules', () => {
  it('computes daily, weekly and monthly slots in the workspace zone', () => {
    const after = new Date('2026-09-24T12:00:00Z'); // Thursday, 14:00 in Berlin
    expect(nextAutomationSlot({ cadence: 'daily', localTime: '09:00' }, 'Europe/Berlin', after).toISOString()).toBe('2026-09-25T07:00:00.000Z');
    expect(nextAutomationSlot({ cadence: 'daily', localTime: '18:30' }, 'Europe/Berlin', after).toISOString()).toBe('2026-09-24T16:30:00.000Z');
    expect(nextAutomationSlot({ cadence: 'weekly', localTime: '09:00', weekday: 1 }, 'Europe/Berlin', after).toISOString()).toBe('2026-09-28T07:00:00.000Z');
    expect(nextAutomationSlot({ cadence: 'monthly', localTime: '08:00', monthDay: 31 }, 'Europe/Berlin', after).toISOString()).toBe('2026-09-30T06:00:00.000Z');
    expect(nextAutomationSlot({ cadence: 'monthly', localTime: '08:00', monthDay: 1 }, 'Europe/Berlin', after).toISOString()).toBe('2026-10-01T06:00:00.000Z');
  });

  it('keeps the wall time across a DST change', () => {
    const before = new Date('2026-10-24T12:00:00Z'); // Berlin switches to CET on 25 October
    expect(nextAutomationSlot({ cadence: 'daily', localTime: '09:00' }, 'Europe/Berlin', before).toISOString()).toBe('2026-10-25T08:00:00.000Z');
  });

  it('slots are strictly after the reference moment (property)', () => {
    fc.assert(
      fc.property(fc.date({ min: new Date('2026-01-01T00:00:00Z'), max: new Date('2027-12-31T00:00:00Z'), noInvalidDate: true }), fc.integer({ min: 1, max: 31 }), (d, day) => {
        const n = nextAutomationSlot({ cadence: 'monthly', localTime: '07:15', monthDay: day }, 'America/New_York', d);
        return n.getTime() > d.getTime() && n.getTime() - d.getTime() <= 32 * 86_400_000;
      }),
    );
  });

  it('validates schedules', () => {
    expect(validateAutomationSchedule({ cadence: 'weekly', localTime: '25:00' }).map((e) => e.field)).toEqual(['config.trigger.schedule.localTime', 'config.trigger.schedule.weekday']);
    expect(validateAutomationSchedule({ cadence: 'daily', localTime: '06:45' })).toEqual([]);
  });
});

describe('automation chain limits', () => {
  it('stops at depth, recursion and budget (T141)', () => {
    expect(automationChainVerdict({ depth: 5, ruleAlreadyInChain: false, effectsInChain: 0, plannedEffects: 1 }).ok).toBe(true);
    expect(automationChainVerdict({ depth: 6, ruleAlreadyInChain: false, effectsInChain: 0, plannedEffects: 1 })).toMatchObject({ ok: false, code: 'DEPTH_LIMIT' });
    expect(automationChainVerdict({ depth: 1, ruleAlreadyInChain: true, effectsInChain: 0, plannedEffects: 1 })).toMatchObject({ ok: false, code: 'RECURSION' });
    expect(automationChainVerdict({ depth: 1, ruleAlreadyInChain: false, effectsInChain: 49, plannedEffects: 2 })).toMatchObject({ ok: false, code: 'BUDGET_EXCEEDED' });
    expect(automationChainVerdict({ depth: 1, ruleAlreadyInChain: false, effectsInChain: 49, plannedEffects: 1 }).ok).toBe(true);
  });

  it('throttles above the hourly rate without dropping runs (T141)', () => {
    const now = new Date('2026-09-24T12:00:00Z');
    const starts = Array.from({ length: AUTOMATION_LIMITS.runsPerHour }, (_, i) => new Date(now.getTime() - (3_000_000 - i * 1000)));
    const until = automationThrottleUntil(starts, now);
    expect(until?.toISOString()).toBe(new Date(starts[0]!.getTime() + 3_600_000).toISOString());
    expect(automationThrottleUntil(starts.slice(1), now)).toBeNull();
    // Runs older than one hour do not count.
    expect(automationThrottleUntil(starts.map((d) => new Date(d.getTime() - 3_600_000)), now)).toBeNull();
  });

  it('retry delays follow the policy and stop after five retries', () => {
    expect([1, 2, 3, 4, 5, 6].map(automationRetryDelaySeconds)).toEqual([30, 120, 600, 1800, 7200, null]);
  });
});

describe('automation text', () => {
  it('substitutes allowed placeholders as plain text and reports shortening', () => {
    expect(renderAutomationText('Follow up: {{entity.title}} ({{project.name}})', { 'entity.title': 'Morning <b>Reel</b>', 'project.name': 'Emma' }, 200)).toEqual({
      text: 'Follow up: Morning <b>Reel</b> (Emma)',
      shortened: false,
    });
    const long = renderAutomationText('{{entity.title}}', { 'entity.title': 'x'.repeat(300) }, 200);
    expect(long.text.length).toBe(200);
    expect(long.shortened).toBe(true);
    expect(unknownAutomationPlaceholders('Hi {{entity.title}} {{process.env}}')).toEqual(['process.env']);
  });

  it('derives stable UUIDs from hashes', () => {
    const a = uuidFromHex('0123456789abcdef0123456789abcdef');
    expect(isUuid(a)).toBe(true);
    expect(uuidFromHex('0123456789abcdef0123456789abcdef')).toBe(a);
  });
});
