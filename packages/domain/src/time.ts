import { DateTime, IANAZone, Interval } from 'luxon';

/**
 * Time helpers. Moments are stored in UTC; calendar days are ISO dates (YYYY-MM-DD);
 * every local-time computation takes an explicit IANA zone. Nothing here reads the
 * wall clock — callers pass `now` from an injected Clock.
 */
export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };
export const fixedClock = (iso: string | Date): Clock => {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return { now: () => new Date(d.getTime()) };
};

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const isValidTimeZone = (zone: unknown): zone is string => typeof zone === 'string' && IANAZone.isValidZone(zone);
export const isIsoDate = (value: unknown): value is string =>
  typeof value === 'string' && ISO_DATE_RE.test(value) && DateTime.fromISO(value, { zone: 'UTC' }).isValid;

/** End of a calendar day in a zone, as the exclusive boundary used for "Due by end of day". */
export const endOfLocalDayUtc = (isoDate: string, zone: string): Date => {
  const start = DateTime.fromISO(isoDate, { zone }).startOf('day');
  return start.plus({ days: 1 }).minus({ milliseconds: 1 }).toUTC().toJSDate();
};

export const startOfLocalDayUtc = (isoDate: string, zone: string): Date =>
  DateTime.fromISO(isoDate, { zone }).startOf('day').toUTC().toJSDate();

/** Local calendar date of a moment in a zone. */
export const localDate = (moment: Date, zone: string): string =>
  DateTime.fromJSDate(moment, { zone }).toISODate() as string;

/** Half-open UTC interval [start, end) for a local date range (inclusive dates). */
export const localDateRangeToUtc = (fromDate: string, toDateInclusive: string, zone: string): { start: Date; end: Date } => ({
  start: DateTime.fromISO(fromDate, { zone }).startOf('day').toUTC().toJSDate(),
  end: DateTime.fromISO(toDateInclusive, { zone }).startOf('day').plus({ days: 1 }).toUTC().toJSDate(),
});

/**
 * Combine a local date and wall time in a zone into a UTC moment. When the wall time does not
 * exist (spring-forward gap) luxon shifts forward; `dstShifted` reports it so the UI can warn.
 */
export const zonedDateTimeToUtc = (
  isoDate: string,
  time: string,
  zone: string,
): { utc: Date; dstShifted: boolean; offsetMinutes: number } => {
  const [h, m] = time.split(':').map((v) => Number(v));
  const dt = DateTime.fromISO(isoDate, { zone }).set({ hour: h ?? 0, minute: m ?? 0, second: 0, millisecond: 0 });
  const dstShifted = dt.hour !== (h ?? 0) || dt.minute !== (m ?? 0);
  return { utc: dt.toUTC().toJSDate(), dstShifted, offsetMinutes: dt.offset };
};

export const weekStartDate = (moment: Date, zone: string, weekStartsOn: 'monday' | 'sunday' = 'monday'): string => {
  const dt = DateTime.fromJSDate(moment, { zone }).startOf('day');
  const weekday = dt.weekday; // 1 = Monday … 7 = Sunday
  const diff = weekStartsOn === 'monday' ? weekday - 1 : weekday % 7;
  return dt.minus({ days: diff }).toISODate() as string;
};

export const addMinutes = (d: Date, minutes: number): Date => new Date(d.getTime() + minutes * 60_000);
export const addHours = (d: Date, hours: number): Date => new Date(d.getTime() + hours * 3_600_000);
export const addDays = (d: Date, days: number): Date => new Date(d.getTime() + days * 86_400_000);
export const diffMinutes = (a: Date, b: Date): number => (a.getTime() - b.getTime()) / 60_000;
export const diffSeconds = (a: Date, b: Date): number => Math.round((a.getTime() - b.getTime()) / 1000);

/** Number of days in the calendar month of an ISO date. */
export const daysInMonth = (isoDate: string): number => DateTime.fromISO(isoDate, { zone: 'UTC' }).daysInMonth as number;

export const intervalsOverlap = (aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean =>
  aStart.getTime() < bEnd.getTime() && bStart.getTime() < aEnd.getTime();

export const isoDateAddDays = (isoDate: string, days: number): string =>
  DateTime.fromISO(isoDate, { zone: 'UTC' }).plus({ days }).toISODate() as string;

export const eachIsoDate = (fromDate: string, toDateInclusive: string): string[] => {
  const out: string[] = [];
  let d = DateTime.fromISO(fromDate, { zone: 'UTC' });
  const end = DateTime.fromISO(toDateInclusive, { zone: 'UTC' });
  while (d <= end) {
    out.push(d.toISODate() as string);
    d = d.plus({ days: 1 });
  }
  return out;
};

export const isoWeekday = (isoDate: string): number => DateTime.fromISO(isoDate, { zone: 'UTC' }).weekday;

export { DateTime, Interval };
