import { endOfLocalDayUtc, isIsoDate, isValidTimeZone, localDate } from '@castlane/domain';

/**
 * Deadline input. A date-only deadline means "by the end of that calendar day in the task time
 * zone" and is stored once as a UTC moment plus the date and zone, so members in other zones see
 * the same deadline in their local time (T053).
 */
export type DueInput = { kind: 'date'; date: string; timezone: string } | { kind: 'datetime'; at: string; timezone?: string | null };

export interface ResolvedDue {
  dueAt: Date;
  dueDate: string | null;
  dueTimezone: string | null;
}

export const resolveDue = (input: DueInput): ResolvedDue => {
  if (input.kind === 'date') {
    if (!isIsoDate(input.date)) throw new Error('INVALID_DATE');
    if (!isValidTimeZone(input.timezone)) throw new Error('INVALID_TIMEZONE');
    return { dueAt: endOfLocalDayUtc(input.date, input.timezone), dueDate: input.date, dueTimezone: input.timezone };
  }
  const at = new Date(input.at);
  if (Number.isNaN(at.getTime())) throw new Error('INVALID_DATETIME');
  return { dueAt: at, dueDate: null, dueTimezone: input.timezone && isValidTimeZone(input.timezone) ? input.timezone : null };
};

/** Local calendar date of a deadline for a viewer (date-only deadlines keep their own date in their zone). */
export const dueLocalDate = (due: { dueAt: Date; dueDate: string | null }, viewerZone: string): string =>
  localDate(due.dueAt, viewerZone);

/** Shift a deadline by whole days (date-only) keeping "end of day" in its zone across DST changes. */
export const shiftDue = (due: ResolvedDue, days: number): ResolvedDue => {
  if (due.dueDate && due.dueTimezone) {
    const [y, m, dd] = due.dueDate.split('-').map(Number);
    const base = Date.UTC(y!, (m ?? 1) - 1, dd ?? 1);
    const next = new Date(base + days * 86_400_000).toISOString().slice(0, 10);
    return { dueAt: endOfLocalDayUtc(next, due.dueTimezone), dueDate: next, dueTimezone: due.dueTimezone };
  }
  return { ...due, dueAt: new Date(due.dueAt.getTime() + days * 86_400_000) };
};
