import { eachIsoDate, isoWeekday } from '@castlane/domain';

/**
 * Workload planning model (spec §11, S29). Pure and deterministic:
 *   available capacity = schedule minutes − approved absences;
 *   planned = remaining estimate spread evenly over the available working days between start
 *   (or today) and the deadline, unless a manager set a manual allocation;
 *   overload = max(0, planned − available).
 * Unestimated tasks are never counted as zero hours: they are reported as a separate count (T060).
 * This is a planning aid, not measured working time.
 */
export const WEEKDAY_KEYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
export type WeekdayKey = (typeof WEEKDAY_KEYS)[number];
export type WeekdayMinutes = Record<WeekdayKey, number>;

export const DEFAULT_CAPACITY_TEMPLATE: WeekdayMinutes = {
  monday: 480,
  tuesday: 480,
  wednesday: 480,
  thursday: 480,
  friday: 480,
  saturday: 0,
  sunday: 0,
};

export interface CapacityProfile {
  effectiveFrom: string;
  weekdayMinutes: WeekdayMinutes;
}

/** Capacity in minutes on a date from the latest profile effective on or before it; null = not set. */
export const capacityOn = (profiles: readonly CapacityProfile[], date: string): number | null => {
  let best: CapacityProfile | null = null;
  for (const p of profiles) if (p.effectiveFrom <= date && (!best || p.effectiveFrom > best.effectiveFrom)) best = p;
  if (!best) return null;
  return best.weekdayMinutes[WEEKDAY_KEYS[isoWeekday(date) - 1]!] ?? 0;
};

export interface WorkloadTask {
  id: string;
  /** Remaining estimate in minutes; null = not estimated. */
  remainingMinutes: number | null;
  startDate: string | null;
  dueDate: string | null;
}

export interface WorkloadInput {
  from: string;
  to: string;
  today: string;
  profiles: readonly CapacityProfile[];
  /** Dates fully covered by an approved absence. */
  absentDates: ReadonlySet<string>;
  tasks: readonly WorkloadTask[];
  /** Manual allocations (task → date → minutes) replace the even split for that task. */
  manual: ReadonlyMap<string, ReadonlyMap<string, number>>;
}

export interface WorkloadDay {
  date: string;
  capacityMinutes: number | null;
  absent: boolean;
  availableMinutes: number | null;
  plannedMinutes: number;
  overloadMinutes: number | null;
}

export interface WorkloadResult {
  days: WorkloadDay[];
  capacityMinutes: number | null;
  capacityCoverage: 'full' | 'partial' | 'none';
  availableMinutes: number | null;
  plannedMinutes: number;
  overloadMinutes: number | null;
  /** Sum of per-day overloads (a busy day is not offset by a free day). */
  dailyOverloadMinutes: number | null;
  unestimatedCount: number;
  unestimatedTaskIds: string[];
  unscheduledCount: number;
  unscheduledMinutes: number;
  overdueCount: number;
  overdueMinutes: number;
  perTask: { id: string; plannedInPeriod: number; method: 'even' | 'manual' | 'deadline_day' }[];
}

/** Integer split with the remainder going to the earliest days, so the parts always sum exactly. */
export const splitEvenly = (total: number, parts: number): number[] => {
  if (parts <= 0) return [];
  const base = Math.floor(total / parts);
  let rest = total - base * parts;
  return Array.from({ length: parts }, () => {
    const extra = rest > 0 ? 1 : 0;
    rest -= extra;
    return base + extra;
  });
};

const maxDate = (a: string, b: string) => (a > b ? a : b);

export const computeWorkload = (input: WorkloadInput): WorkloadResult => {
  const period = eachIsoDate(input.from, input.to);
  const inPeriod = new Set(period);
  const dayInfo = (date: string) => {
    const cap = capacityOn(input.profiles, date);
    const absent = input.absentDates.has(date);
    const available = cap === null ? null : absent ? 0 : cap;
    // Unknown capacity: Monday–Friday are assumed working days for spreading only (never shown as capacity).
    const working = absent ? false : cap === null ? isoWeekday(date) <= 5 : cap > 0;
    return { cap, absent, available, working };
  };
  const planned = new Map<string, number>(period.map((d) => [d, 0]));
  const perTask: WorkloadResult['perTask'] = [];
  const unestimated: string[] = [];
  let unscheduledCount = 0;
  let unscheduledMinutes = 0;
  let overdueCount = 0;
  let overdueMinutes = 0;

  for (const t of input.tasks) {
    const windowStart = t.startDate ? maxDate(t.startDate, input.today) : input.today;
    const intersects = !t.dueDate || (t.dueDate >= input.from && windowStart <= input.to) || t.dueDate < input.today;
    if (t.remainingMinutes === null) {
      if (t.dueDate && t.dueDate >= input.from && (t.startDate ?? t.dueDate) <= input.to) unestimated.push(t.id);
      else if (!t.dueDate) unscheduledCount++;
      continue;
    }
    const manual = input.manual.get(t.id);
    if (manual && manual.size > 0) {
      let sum = 0;
      for (const [date, minutes] of manual) {
        if (!inPeriod.has(date)) continue;
        planned.set(date, (planned.get(date) ?? 0) + minutes);
        sum += minutes;
      }
      perTask.push({ id: t.id, plannedInPeriod: sum, method: 'manual' });
      continue;
    }
    if (!t.dueDate) {
      unscheduledCount++;
      unscheduledMinutes += t.remainingMinutes;
      continue;
    }
    if (t.dueDate < input.today) {
      overdueCount++;
      overdueMinutes += t.remainingMinutes;
      continue;
    }
    if (!intersects || t.remainingMinutes === 0) {
      perTask.push({ id: t.id, plannedInPeriod: 0, method: 'even' });
      continue;
    }
    const window = eachIsoDate(windowStart, t.dueDate);
    const working = window.filter((date) => dayInfo(date).working);
    const targets = working.length ? working : [t.dueDate];
    const parts = splitEvenly(t.remainingMinutes, targets.length);
    let sum = 0;
    targets.forEach((date, i) => {
      if (!inPeriod.has(date)) return;
      planned.set(date, (planned.get(date) ?? 0) + parts[i]!);
      sum += parts[i]!;
    });
    perTask.push({ id: t.id, plannedInPeriod: sum, method: working.length ? 'even' : 'deadline_day' });
  }

  let capKnown = 0;
  let capSum = 0;
  let availSum = 0;
  let overloadSum = 0;
  let plannedSum = 0;
  const days: WorkloadDay[] = period.map((date) => {
    const info = dayInfo(date);
    const p = planned.get(date) ?? 0;
    plannedSum += p;
    if (info.cap !== null) {
      capKnown++;
      capSum += info.cap;
      availSum += info.available ?? 0;
    }
    const overload = info.available === null ? null : Math.max(0, p - info.available);
    if (overload) overloadSum += overload;
    return { date, capacityMinutes: info.cap, absent: info.absent, availableMinutes: info.available, plannedMinutes: p, overloadMinutes: overload };
  });
  const coverage = capKnown === 0 ? 'none' : capKnown === period.length ? 'full' : 'partial';
  return {
    days,
    capacityMinutes: coverage === 'none' ? null : capSum,
    capacityCoverage: coverage,
    availableMinutes: coverage === 'none' ? null : availSum,
    plannedMinutes: plannedSum,
    // Period overload = max(0, planned − available) where capacity is known.
    overloadMinutes: coverage === 'none' ? null : Math.max(0, plannedSum - availSum),
    dailyOverloadMinutes: coverage === 'none' ? null : overloadSum,
    unestimatedCount: unestimated.length,
    unestimatedTaskIds: unestimated,
    unscheduledCount,
    unscheduledMinutes,
    overdueCount,
    overdueMinutes,
    perTask,
  };
};
