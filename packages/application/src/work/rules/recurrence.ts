import { DateTime, zonedDateTimeToUtc } from '@castlane/domain';

/**
 * Recurrence calendar (pure, deterministic). Occurrences are identified by their local calendar
 * date in the rule's IANA zone; the occurrence key never depends on the server's zone, so a retry
 * after an outage produces the same keys (T054).
 */
export interface RecurrenceSpec {
  cadence: 'daily' | 'weekly' | 'monthly';
  intervalCount: number;
  /** ISO weekdays 1 (Mon) … 7 (Sun) for weekly rules; empty = weekday of startsOn. */
  weekdays: number[];
  /** Day of month for monthly rules; null = day of startsOn. */
  monthDay: number | null;
  /** What to do when the month has no such day (e.g. the 31st in April). */
  monthDayPolicy: 'last_day_of_month' | 'skip_month';
  localTime: string;
  timezone: string;
  startsOn: string;
  endsOn: string | null;
}

export interface Occurrence {
  key: string;
  localDate: string;
  scheduledFor: Date;
  /** True when the rule's day did not exist in that month and Last Day of Month applied. */
  clampedToMonthEnd: boolean;
  /** The local wall time does not exist that day (DST gap) and was shifted forward. */
  dstShifted: boolean;
}

const d = (iso: string) => DateTime.fromISO(iso, { zone: 'UTC' });
const iso = (dt: DateTime) => dt.toISODate() as string;

/** Local dates of the rule in [fromDate, toDate] (inclusive, ISO dates), at most `limit`. */
export const occurrenceDates = (
  spec: RecurrenceSpec,
  fromDate: string,
  toDate: string,
  limit = 1000,
): { date: string; clamped: boolean }[] => {
  const start = d(spec.startsOn);
  let from = d(fromDate);
  if (from < start) from = start;
  let to = d(toDate);
  if (spec.endsOn && d(spec.endsOn) < to) to = d(spec.endsOn);
  if (to < from) return [];
  const every = Math.max(1, Math.floor(spec.intervalCount || 1));
  const out: { date: string; clamped: boolean }[] = [];

  if (spec.cadence === 'daily') {
    const offset = Math.floor(from.diff(start, 'days').days);
    let k = Math.ceil(offset / every);
    for (;;) {
      const day = start.plus({ days: k * every });
      if (day > to || out.length >= limit) break;
      if (day >= from) out.push({ date: iso(day), clamped: false });
      k++;
    }
    return out;
  }

  if (spec.cadence === 'weekly') {
    const weekdays = [...new Set(spec.weekdays.length ? spec.weekdays : [start.weekday])].filter((w) => w >= 1 && w <= 7).sort();
    const anchorMonday = start.minus({ days: start.weekday - 1 });
    let weekIndex = Math.max(0, Math.floor(from.minus({ days: from.weekday - 1 }).diff(anchorMonday, 'days').days / 7));
    weekIndex -= weekIndex % every;
    for (;;) {
      const monday = anchorMonday.plus({ weeks: weekIndex });
      if (monday > to || out.length >= limit) break;
      for (const w of weekdays) {
        const day = monday.plus({ days: w - 1 });
        if (day < from || day > to) continue;
        out.push({ date: iso(day), clamped: false });
        if (out.length >= limit) break;
      }
      weekIndex += every;
    }
    return out;
  }

  // monthly
  const wanted = spec.monthDay ?? start.day;
  const firstMonth = start.startOf('month');
  const monthsFrom = Math.max(0, Math.floor(from.startOf('month').diff(firstMonth, 'months').months));
  let m = Math.floor(monthsFrom / every) * every;
  for (;;) {
    const month = firstMonth.plus({ months: m });
    if (month > to || out.length >= limit) break;
    const dim = month.daysInMonth as number;
    let day: DateTime | null = null;
    let clamped = false;
    if (wanted <= dim) day = month.set({ day: wanted });
    else if (spec.monthDayPolicy === 'last_day_of_month') {
      day = month.set({ day: dim });
      clamped = true;
    }
    if (day && day >= from && day <= to) out.push({ date: iso(day), clamped });
    m += every;
  }
  return out;
};

/** Occurrences whose scheduled UTC moment lies in [fromUtc, toUtc]. */
export const occurrencesBetween = (spec: RecurrenceSpec, fromUtc: Date, toUtc: Date, limit = 1000): Occurrence[] => {
  // Local dates can differ from UTC dates by up to one day either side.
  const fromDate = iso(DateTime.fromJSDate(fromUtc, { zone: spec.timezone }).minus({ days: 1 }));
  const toDate = iso(DateTime.fromJSDate(toUtc, { zone: spec.timezone }).plus({ days: 1 }));
  const out: Occurrence[] = [];
  for (const o of occurrenceDates(spec, fromDate, toDate, limit + 4)) {
    const z = zonedDateTimeToUtc(o.date, spec.localTime, spec.timezone);
    if (z.utc < fromUtc || z.utc > toUtc) continue;
    out.push({ key: o.date, localDate: o.date, scheduledFor: z.utc, clampedToMonthEnd: o.clamped, dstShifted: z.dstShifted });
    if (out.length >= limit) break;
  }
  return out;
};

/** The first occurrence strictly after `afterUtc` (used by previews and "next due"). */
export const nextOccurrence = (spec: RecurrenceSpec, afterUtc: Date, searchDays = 800): Occurrence | null => {
  const list = occurrencesBetween(spec, new Date(afterUtc.getTime() + 1), new Date(afterUtc.getTime() + searchDays * 86_400_000), 1);
  return list[0] ?? null;
};

/**
 * "After completion" mode: the next occurrence is one interval after the local completion date, at
 * the rule's local time (a monthly rule keeps its day policy).
 */
export const nextAfterCompletion = (spec: RecurrenceSpec, completedAt: Date): Occurrence => {
  const local = DateTime.fromJSDate(completedAt, { zone: spec.timezone }).startOf('day');
  const every = Math.max(1, Math.floor(spec.intervalCount || 1));
  let target: DateTime;
  let clamped = false;
  if (spec.cadence === 'daily') target = local.plus({ days: every });
  else if (spec.cadence === 'weekly') target = local.plus({ weeks: every });
  else {
    const month = local.startOf('month').plus({ months: every });
    const wanted = spec.monthDay ?? d(spec.startsOn).day;
    const dim = month.daysInMonth as number;
    if (wanted <= dim) target = month.set({ day: wanted });
    else if (spec.monthDayPolicy === 'last_day_of_month') {
      target = month.set({ day: dim });
      clamped = true;
    } else target = month.plus({ months: 1 }).set({ day: Math.min(wanted, month.plus({ months: 1 }).daysInMonth as number) });
  }
  const date = target.toISODate() as string;
  const z = zonedDateTimeToUtc(date, spec.localTime, spec.timezone);
  return { key: date, localDate: date, scheduledFor: z.utc, clampedToMonthEnd: clamped, dstShifted: z.dstShifted };
};

export interface GenerationPlan {
  /** Occurrences to create as tasks (past backfill first, then future within the horizon). */
  create: (Occurrence & { overdue: boolean })[];
  /** Past occurrences not created as tasks: recorded as Missed, listed on the overdue occurrence. */
  missed: Occurrence[];
  generatedThrough: Date;
}

/**
 * Fixed-schedule generation for one run. Occurrences scheduled up to `now + horizonDays` and after
 * `lastGeneratedThrough` are due for generation. Past ones (missed during an outage or before the
 * rule existed) are not all created: by default only the latest becomes one overdue task and the
 * rest are listed as missed dates; `backfillLimit` (≤ 30) creates that many of the latest instead.
 */
export const planGeneration = (
  spec: RecurrenceSpec,
  input: { now: Date; lastGeneratedThrough: Date | null; horizonDays: number; backfillLimit: number; ruleCreatedAt: Date },
): GenerationPlan => {
  const horizon = Math.min(30, Math.max(1, Math.floor(input.horizonDays || 30)));
  const until = new Date(input.now.getTime() + horizon * 86_400_000);
  // Occurrences before the rule existed are not "missed": generation starts at its creation.
  const startOfRule = zonedDateTimeToUtc(spec.startsOn, '00:00', spec.timezone).utc;
  const since = input.lastGeneratedThrough
    ? new Date(input.lastGeneratedThrough.getTime() + 1)
    : new Date(Math.max(startOfRule.getTime(), input.ruleCreatedAt.getTime()));
  if (until < since) return { create: [], missed: [], generatedThrough: input.lastGeneratedThrough ?? until };
  const all = occurrencesBetween(spec, since, until, 2000);
  const past = all.filter((o) => o.scheduledFor.getTime() <= input.now.getTime());
  const future = all.filter((o) => o.scheduledFor.getTime() > input.now.getTime());
  const backfill = Math.min(30, Math.max(1, Math.floor(input.backfillLimit || 0) || 1));
  const createdPast = past.slice(-backfill).map((o) => ({ ...o, overdue: true }));
  const missed = past.slice(0, Math.max(0, past.length - backfill));
  return { create: [...createdPast, ...future.map((o) => ({ ...o, overdue: false }))], missed, generatedThrough: until };
};
