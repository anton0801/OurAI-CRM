import { describe, expect, it } from 'vitest';
import { accountOccurrences } from './checkpoints';
import { plainDecimal } from './common';
import { formatMetricForPdf } from './reports/pdf';
import { nextScheduleRun } from './reports/schedules';

const iso = (d: Date) => d.toISOString();

describe('report schedule cadence', () => {
  it('runs daily at the local time, later today or tomorrow', () => {
    expect(iso(nextScheduleRun('daily', '08:00', 'UTC', new Date('2025-03-12T07:00:00Z')))).toBe('2025-03-12T08:00:00.000Z');
    expect(iso(nextScheduleRun('daily', '08:00', 'UTC', new Date('2025-03-12T08:00:00Z')))).toBe('2025-03-13T08:00:00.000Z');
  });

  it('runs weekly on Monday and monthly on the 1st in the schedule time zone', () => {
    // Wednesday 12 March 2025 → Monday 17 March, 09:00 Berlin (CET, UTC+1).
    expect(iso(nextScheduleRun('weekly', '09:00', 'Europe/Berlin', new Date('2025-03-12T10:00:00Z')))).toBe('2025-03-17T08:00:00.000Z');
    // After 1 March → 1 April, 09:00 Berlin (CEST, UTC+2).
    expect(iso(nextScheduleRun('monthly', '09:00', 'Europe/Berlin', new Date('2025-03-01T09:00:00Z')))).toBe('2025-04-01T07:00:00.000Z');
  });
});

describe('account snapshot occurrences', () => {
  it('finds the previous and next daily occurrence', () => {
    const o = accountOccurrences('daily', 1, '10:00', 'UTC', new Date('2025-03-12T12:00:00Z'));
    expect([iso(o.previous), iso(o.next)]).toEqual(['2025-03-12T10:00:00.000Z', '2025-03-13T10:00:00.000Z']);
  });

  it('uses the chosen weekday for weekly and the first such weekday of the month for monthly cadence', () => {
    const w = accountOccurrences('weekly', 5, '10:00', 'UTC', new Date('2025-03-12T12:00:00Z'));
    expect([iso(w.previous), iso(w.next)]).toEqual(['2025-03-07T10:00:00.000Z', '2025-03-14T10:00:00.000Z']);
    // First Monday of March 2025 is the 3rd; of April the 7th.
    const m = accountOccurrences('monthly', 1, '10:00', 'UTC', new Date('2025-03-12T12:00:00Z'));
    expect([iso(m.previous), iso(m.next)]).toEqual(['2025-03-03T10:00:00.000Z', '2025-04-07T10:00:00.000Z']);
  });
});

describe('value formatting', () => {
  it('strips storage padding and keeps unknown distinct from zero', () => {
    expect(plainDecimal('1500.000000')).toBe('1500');
    expect(plainDecimal('0.000000')).toBe('0');
    expect(plainDecimal('0.125000')).toBe('0.125');
    expect(plainDecimal(null)).toBeNull();
  });

  it('prints PDF values with units and availability labels, never 0 for missing data', () => {
    expect(formatMetricForPdf({ status: 'known', value: '1234.5', unit: 'count' })).toBe('1,234.5');
    expect(formatMetricForPdf({ status: 'known', value: '12.50', unit: 'percent' })).toBe('12.5 %');
    expect(formatMetricForPdf({ status: 'partial', value: '10', unit: 'count' })).toBe('10 (partial)');
    expect(formatMetricForPdf({ status: 'no_data', value: null, unit: 'count' })).toBe('No data');
    expect(formatMetricForPdf({ status: 'not_defined', value: null, unit: 'percent' })).not.toBe('0');
    expect(formatMetricForPdf(undefined)).toBe('No data');
  });
});
