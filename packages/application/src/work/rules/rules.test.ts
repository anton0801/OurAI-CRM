import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { canTransition, TASK_STATUSES } from '@castlane/domain';
import { createsCycle, cyclePath, isAcyclic, propagateSchedule, reachableFrom, type DependencyEdge, type ScheduledNode } from './graph';
import { nextAfterCompletion, occurrenceDates, occurrencesBetween, planGeneration, type RecurrenceSpec } from './recurrence';
import { resolveDue, shiftDue } from './due';
import { baselineAfter, isOverdue, nextCycle, TASK_TRANSITIONS, transitionKind } from './task-status';
import { capacityOn, computeWorkload, DEFAULT_CAPACITY_TEMPLATE, splitEvenly } from './workload';
import { findOverlaps, validateInterval } from './time';

const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

describe('task status rules', () => {
  it('no status can be reached from itself and closed states only reopen/restore', () => {
    for (const s of TASK_STATUSES) expect(canTransition(TASK_TRANSITIONS, s, s)).toBe(false);
    expect(TASK_TRANSITIONS.done).toEqual(['ready', 'in_progress']);
    expect(TASK_TRANSITIONS.cancelled).toEqual(['backlog']);
    // Review-required work cannot jump from Ready straight to Done.
    expect(canTransition(TASK_TRANSITIONS, 'ready', 'done')).toBe(false);
  });

  it('classifies transitions and starts a new cycle on reopen (T051)', () => {
    expect(transitionKind('ready', 'in_progress')).toBe('start');
    expect(transitionKind('in_review', 'in_progress')).toBe('plan');
    expect(transitionKind('in_progress', 'done')).toBe('complete');
    expect(transitionKind('done', 'in_progress')).toBe('reopen');
    expect(nextCycle(1, 'done', 'in_progress')).toBe(2);
    expect(nextCycle(2, 'in_progress', 'done')).toBe(2);
  });

  it('overdue is computed and a task without deadline is never overdue (T052)', () => {
    const now = new Date('2026-10-01T12:00:00Z');
    expect(isOverdue({ dueAt: null, status: 'in_progress' }, now)).toBe(false);
    expect(isOverdue({ dueAt: new Date('2026-10-01T11:00:00Z'), status: 'in_progress' }, now)).toBe(true);
    expect(isOverdue({ dueAt: new Date('2026-10-01T11:00:00Z'), status: 'done' }, now)).toBe(false);
  });

  it('baseline is fixed at first Ready or at the first deadline after Ready', () => {
    const due = new Date('2026-10-10T10:00:00Z');
    expect(baselineAfter({ baseline: null, status: 'draft', dueAt: due })).toBeNull();
    expect(baselineAfter({ baseline: null, status: 'ready', dueAt: due })).toEqual(due);
    const b = new Date('2026-10-05T10:00:00Z');
    expect(baselineAfter({ baseline: b, status: 'in_progress', dueAt: due })).toEqual(b);
  });
});

describe('dependency graph (T048)', () => {
  it('rejects self edges and cycles with the offending path', () => {
    const edges: DependencyEdge[] = [
      { predecessorId: 'a', successorId: 'b' },
      { predecessorId: 'b', successorId: 'c' },
    ];
    expect(createsCycle(edges, 'a', 'a')).toBe(true);
    expect(cyclePath(edges, 'c', 'a')).toEqual(['c', 'a', 'b', 'c']);
    expect(createsCycle(edges, 'a', 'c')).toBe(false);
    expect([...reachableFrom(edges, 'a')].sort()).toEqual(['b', 'c']);
  });

  it('property: accepting only edges that do not close a cycle keeps the graph acyclic', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.constantFrom(...ids), fc.constantFrom(...ids)), { maxLength: 60 }), (pairs) => {
        const edges: DependencyEdge[] = [];
        for (const [p, s] of pairs) {
          if (edges.some((e) => e.predecessorId === p && e.successorId === s)) continue;
          if (!createsCycle(edges, p, s)) edges.push({ predecessorId: p, successorId: s });
        }
        expect(isAcyclic(edges)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it('property: createsCycle agrees with a brute-force acyclicity check', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.constantFrom(...ids), fc.constantFrom(...ids)), { maxLength: 25 }),
        fc.constantFrom(...ids),
        fc.constantFrom(...ids),
        (pairs, p, s) => {
          const edges: DependencyEdge[] = [];
          for (const [a, b] of pairs) if (a !== b && !createsCycle(edges, a, b)) edges.push({ predecessorId: a, successorId: b });
          expect(createsCycle(edges, p, s)).toBe(p === s || !isAcyclic([...edges, { predecessorId: p, successorId: s }]));
        },
      ),
      { numRuns: 300 },
    );
  });

  it('propagates Finish-to-Start pushes downstream only, never pulling earlier', () => {
    const day = (n: number) => new Date(Date.UTC(2026, 9, n, 17));
    const nodes = new Map<string, ScheduledNode>([
      ['a', { id: 'a', startAt: day(1), dueAt: day(3), dateOnly: false, open: true }],
      ['b', { id: 'b', startAt: day(4), dueAt: day(6), dateOnly: false, open: true }],
      ['c', { id: 'c', startAt: day(7), dueAt: day(8), dateOnly: false, open: true }],
      ['d', { id: 'd', startAt: day(5), dueAt: day(9), dateOnly: false, open: false }],
    ]);
    const edges: DependencyEdge[] = [
      { predecessorId: 'a', successorId: 'b' },
      { predecessorId: 'b', successorId: 'c' },
      { predecessorId: 'a', successorId: 'd' },
    ];
    const later = propagateSchedule(nodes, edges, { id: 'a', startAt: day(1), dueAt: day(5) });
    const byId = new Map(later.map((c) => [c.id, c]));
    expect(byId.get('b')!.toStart).toEqual(day(5));
    expect(byId.get('b')!.toDue).toEqual(day(7));
    // c already starts when b is now due: nothing to push.
    expect(byId.has('c')).toBe(false);
    expect(byId.has('d')).toBe(false);
    const earlier = propagateSchedule(nodes, edges, { id: 'a', startAt: day(1), dueAt: day(2) });
    expect(earlier.map((c) => c.id)).toEqual(['a']);
  });
});

describe('deadlines (T053)', () => {
  it('date-only deadline is the end of the chosen day in the task zone, identical for every viewer', () => {
    const berlin = resolveDue({ kind: 'date', date: '2026-10-12', timezone: 'Europe/Berlin' });
    expect(berlin.dueAt.toISOString()).toBe('2026-10-12T21:59:59.999Z');
    const ny = resolveDue({ kind: 'date', date: '2026-10-12', timezone: 'America/New_York' });
    expect(ny.dueAt.toISOString()).toBe('2026-10-13T03:59:59.999Z');
    expect(berlin.dueDate).toBe('2026-10-12');
  });

  it('shifting a date-only deadline keeps end of day across a DST change', () => {
    const d = resolveDue({ kind: 'date', date: '2026-10-24', timezone: 'Europe/Berlin' });
    const next = shiftDue(d, 2);
    expect(next.dueDate).toBe('2026-10-26');
    expect(next.dueAt.toISOString()).toBe('2026-10-26T22:59:59.999Z');
  });
});

const baseSpec: RecurrenceSpec = {
  cadence: 'monthly',
  intervalCount: 1,
  weekdays: [],
  monthDay: 31,
  monthDayPolicy: 'last_day_of_month',
  localTime: '09:00',
  timezone: 'Europe/Berlin',
  startsOn: '2026-01-31',
  endsOn: null,
};

describe('recurrence (T054, T055)', () => {
  it('monthly on the 31st uses the last day of shorter months, reproducibly', () => {
    const dates = occurrenceDates(baseSpec, '2026-01-01', '2026-06-30').map((o) => o.date);
    expect(dates).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30']);
    expect(occurrenceDates(baseSpec, '2028-02-01', '2028-02-29').map((o) => o.date)).toEqual(['2028-02-29']);
    const skip = occurrenceDates({ ...baseSpec, monthDayPolicy: 'skip_month' }, '2026-01-01', '2026-06-30').map((o) => o.date);
    expect(skip).toEqual(['2026-01-31', '2026-03-31', '2026-05-31']);
  });

  it('weekly rules honour weekdays and interval; daily rules honour interval', () => {
    const weekly: RecurrenceSpec = { ...baseSpec, cadence: 'weekly', weekdays: [1, 3], monthDay: null, intervalCount: 2, startsOn: '2026-10-05' };
    expect(occurrenceDates(weekly, '2026-10-01', '2026-10-31').map((o) => o.date)).toEqual(['2026-10-05', '2026-10-07', '2026-10-19', '2026-10-21']);
    const daily: RecurrenceSpec = { ...baseSpec, cadence: 'daily', intervalCount: 3, monthDay: null, startsOn: '2026-10-01' };
    expect(occurrenceDates(daily, '2026-10-02', '2026-10-12').map((o) => o.date)).toEqual(['2026-10-04', '2026-10-07', '2026-10-10']);
  });

  it('local time is kept across DST in the rule zone', () => {
    const daily: RecurrenceSpec = { ...baseSpec, cadence: 'daily', monthDay: null, startsOn: '2026-10-24' };
    const occ = occurrencesBetween(daily, new Date('2026-10-24T00:00:00Z'), new Date('2026-10-26T23:00:00Z'));
    expect(occ.map((o) => o.scheduledFor.toISOString())).toEqual(['2026-10-24T07:00:00.000Z', '2026-10-25T08:00:00.000Z', '2026-10-26T08:00:00.000Z']);
  });

  it('after an outage only one overdue occurrence is created and the rest are listed as missed', () => {
    const daily: RecurrenceSpec = { ...baseSpec, cadence: 'daily', monthDay: null, startsOn: '2026-09-01' };
    const plan = planGeneration(daily, {
      now: new Date('2026-10-10T12:00:00Z'),
      lastGeneratedThrough: new Date('2026-10-01T00:00:00Z'),
      horizonDays: 3,
      backfillLimit: 0,
      ruleCreatedAt: new Date('2026-09-01T00:00:00Z'),
    });
    expect(plan.create.filter((c) => c.overdue).map((c) => c.key)).toEqual(['2026-10-10']);
    expect(plan.missed.map((m) => m.key)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09']);
    expect(plan.create.filter((c) => !c.overdue).map((c) => c.key)).toEqual(['2026-10-11', '2026-10-12', '2026-10-13']);
    const backfill = planGeneration(daily, {
      now: new Date('2026-10-10T12:00:00Z'),
      lastGeneratedThrough: new Date('2026-10-01T00:00:00Z'),
      horizonDays: 3,
      backfillLimit: 3,
      ruleCreatedAt: new Date('2026-09-01T00:00:00Z'),
    });
    expect(backfill.create.filter((c) => c.overdue).map((c) => c.key)).toEqual(['2026-10-08', '2026-10-09', '2026-10-10']);
  });

  it('property: occurrence keys are unique, sorted and inside the requested range', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('daily', 'weekly', 'monthly') as fc.Arbitrary<'daily' | 'weekly' | 'monthly'>,
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 1, max: 31 }),
        fc.subarray([1, 2, 3, 4, 5, 6, 7]),
        fc.integer({ min: 0, max: 400 }),
        (cadence, every, monthDay, weekdays, offset) => {
          const spec: RecurrenceSpec = { ...baseSpec, cadence, intervalCount: every, monthDay, weekdays, startsOn: '2026-01-15' };
          const from = new Date(Date.UTC(2026, 0, 15) + offset * 86_400_000).toISOString().slice(0, 10);
          const to = new Date(Date.UTC(2026, 0, 15) + (offset + 120) * 86_400_000).toISOString().slice(0, 10);
          const list = occurrenceDates(spec, from, to).map((o) => o.date);
          expect(new Set(list).size).toBe(list.length);
          expect([...list].sort()).toEqual(list);
          for (const x of list) expect(x >= from && x <= to).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('after-completion mode schedules one interval after the local completion date', () => {
    const weekly: RecurrenceSpec = { ...baseSpec, cadence: 'weekly', monthDay: null, weekdays: [] };
    expect(nextAfterCompletion(weekly, new Date('2026-10-01T22:30:00Z')).key).toBe('2026-10-09');
    expect(nextAfterCompletion(baseSpec, new Date('2026-01-31T10:00:00Z')).key).toBe('2026-02-28');
  });
});

describe('workload (T060)', () => {
  it('spreads remaining estimates over available working days; unestimated is a count, not zero hours', () => {
    const r = computeWorkload({
      from: '2026-10-05',
      to: '2026-10-11',
      today: '2026-10-05',
      profiles: [{ effectiveFrom: '2026-01-01', weekdayMinutes: DEFAULT_CAPACITY_TEMPLATE }],
      absentDates: new Set(['2026-10-07']),
      tasks: [
        { id: 't1', remainingMinutes: 600, startDate: null, dueDate: '2026-10-09' },
        { id: 't2', remainingMinutes: null, startDate: null, dueDate: '2026-10-08' },
        { id: 't3', remainingMinutes: 120, startDate: null, dueDate: null },
        { id: 't4', remainingMinutes: 60, startDate: null, dueDate: '2026-10-01' },
      ],
      manual: new Map(),
    });
    expect(r.days.find((d) => d.date === '2026-10-07')!.plannedMinutes).toBe(0);
    expect(r.plannedMinutes).toBe(600);
    expect(r.unestimatedCount).toBe(1);
    expect(r.unscheduledMinutes).toBe(120);
    expect(r.overdueMinutes).toBe(60);
    expect(r.capacityMinutes).toBe(5 * 480);
    expect(r.availableMinutes).toBe(4 * 480);
    expect(r.overloadMinutes).toBe(0);
  });

  it('capacity that is not set stays unknown (never assumed)', () => {
    const r = computeWorkload({ from: '2026-10-05', to: '2026-10-06', today: '2026-10-05', profiles: [], absentDates: new Set(), tasks: [], manual: new Map() });
    expect(r.capacityMinutes).toBeNull();
    expect(r.overloadMinutes).toBeNull();
    expect(capacityOn([], '2026-10-05')).toBeNull();
  });

  it('property: the even split conserves minutes exactly', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100_000 }), fc.integer({ min: 1, max: 60 }), (total, parts) => {
        const s = splitEvenly(total, parts);
        expect(s.reduce((a, b) => a + b, 0)).toBe(total);
        expect(Math.max(...s) - Math.min(...s)).toBeLessThanOrEqual(1);
      }),
    );
  });
});

describe('time entries (T059)', () => {
  it('detects overlapping intervals but not touching ones', () => {
    const t = (h: number) => new Date(Date.UTC(2026, 9, 5, h));
    expect(
      findOverlaps([
        { id: 'a', startedAt: t(9), endedAt: t(11) },
        { id: 'b', startedAt: t(10), endedAt: t(12) },
        { id: 'c', startedAt: t(12), endedAt: t(13) },
      ]),
    ).toEqual([['a', 'b']]);
  });

  it('validates duration, order and future ends', () => {
    const now = new Date('2026-10-05T12:00:00Z');
    expect(validateInterval(new Date('2026-10-05T10:00:00Z'), new Date('2026-10-05T09:00:00Z'), now)).toBe('END_BEFORE_START');
    expect(validateInterval(new Date('2026-10-03T10:00:00Z'), new Date('2026-10-04T11:00:00Z'), now)).toBe('TOO_LONG');
    expect(validateInterval(new Date('2026-10-05T11:00:00Z'), new Date('2026-10-05T13:00:00Z'), now)).toBe('IN_FUTURE');
    expect(validateInterval(new Date('2026-10-05T09:00:00Z'), new Date('2026-10-05T11:00:00Z'), now)).toBeNull();
  });
});
