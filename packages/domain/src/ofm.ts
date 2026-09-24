import Big from 'big.js';
import { DateTime } from 'luxon';
import { ROUND_HALF_EVEN, isDecimalString, isValidPercent, toBig } from './decimal';
import type {
  CONTACT_STAGES,
  EnumValue,
  OPERATION_STATUSES,
  QUALITY_REVIEW_STATES,
  SHIFT_REPORT_STATES,
  SHIFT_STATES,
  SWAP_REQUEST_STATES,
} from './enums';
import type { TransitionTable } from './state-machine';
import { isIsoDate, isValidTimeZone, zonedDateTimeToUtc } from './time';

/**
 * OFM domain rules (spec §13): shift lifecycle, net hours, repeat schedules with DST awareness,
 * quality rubric scoring and sale attribution. Pure and browser-safe; the clock is always passed in.
 */

export type ShiftState = EnumValue<typeof SHIFT_STATES>;
export type ShiftReportState = EnumValue<typeof SHIFT_REPORT_STATES>;
export type OperationStatus = EnumValue<typeof OPERATION_STATUSES>;
export type QualityReviewState = EnumValue<typeof QUALITY_REVIEW_STATES>;
export type SwapRequestState = EnumValue<typeof SWAP_REQUEST_STATES>;
export type ContactStage = EnumValue<typeof CONTACT_STAGES>;

/** Scheduled → Active ↔ Paused → Ended; Scheduled → Cancelled/Missed. Cancelling an active shift is not allowed (End with Aborted). */
export const SHIFT_TRANSITIONS: TransitionTable<ShiftState> = {
  scheduled: ['active', 'cancelled', 'missed'],
  active: ['paused', 'ended'],
  paused: ['active', 'ended'],
  ended: [],
  cancelled: [],
  missed: [],
};

/** Not Started → Draft → Submitted → Changes Requested → Submitted → Approved. */
export const SHIFT_REPORT_TRANSITIONS: TransitionTable<ShiftReportState> = {
  not_started: ['draft'],
  draft: ['submitted'],
  submitted: ['approved', 'changes_requested'],
  changes_requested: ['submitted'],
  approved: [],
};

/** Open → In Progress → Waiting → Completed; Cancelled with a reason. Completion never implies payment. */
export const OPERATION_TRANSITIONS: TransitionTable<OperationStatus> = {
  open: ['in_progress', 'waiting', 'completed', 'cancelled'],
  in_progress: ['open', 'waiting', 'completed', 'cancelled'],
  waiting: ['in_progress', 'completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

export const QUALITY_REVIEW_TRANSITIONS: TransitionTable<QualityReviewState> = {
  draft: ['published'],
  published: ['disputed'],
  disputed: ['resolved'],
  resolved: [],
};

export const SWAP_TRANSITIONS: TransitionTable<SwapRequestState> = {
  pending_acceptance: ['pending_approval', 'declined', 'cancelled'],
  pending_approval: ['approved', 'declined', 'cancelled'],
  approved: [],
  declined: [],
  cancelled: [],
};

/** Contact stages are descriptive labels; Archived is reached through the archive command only. */
export const CONTACT_STAGE_TRANSITIONS: TransitionTable<ContactStage> = {
  new: ['active', 'follow_up', 'inactive'],
  active: ['new', 'follow_up', 'inactive'],
  follow_up: ['new', 'active', 'inactive'],
  inactive: ['new', 'active', 'follow_up'],
  archived: [],
};

export const SHIFT_LIMITS = {
  minMinutes: 15,
  maxMinutes: 16 * 60,
  /** Primary account plus up to 9 additional accounts. */
  maxAccounts: 10,
  /** Starting earlier than this before scheduled start needs a supervisor override. */
  earlyStartMinutes: 15,
  /** A forgotten End raises a supervisor alert this long after the scheduled end. */
  forgottenEndGraceMinutes: 30,
  repeatMaxWeeks: 8,
  reminderMinutesBefore: 30,
} as const;

// ——— Time accounting ———

export interface BreakInterval {
  startedAt: Date;
  endedAt: Date | null;
}

export interface NetTime {
  /** Net seconds = (actual_end − actual_start − closed breaks); null while the shift has no actual end (Pending). */
  netSeconds: number | null;
  grossSeconds: number | null;
  breakSeconds: number;
}

const clampMs = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** Break seconds inside [start, end]; an open break counts until `end`. */
export const breakSecondsWithin = (start: Date, end: Date, breaks: BreakInterval[]): number => {
  const s = start.getTime();
  const e = end.getTime();
  let total = 0;
  for (const b of breaks) {
    const bs = clampMs(b.startedAt.getTime(), s, e);
    const be = clampMs((b.endedAt ?? end).getTime(), s, e);
    if (be > bs) total += be - bs;
  }
  return Math.round(total / 1000);
};

/** Shift net hours (M28). Unknown end is Pending (null), never zero. */
export const shiftNetTime = (actualStart: Date | null, actualEnd: Date | null, breaks: BreakInterval[]): NetTime => {
  if (!actualStart || !actualEnd) return { netSeconds: null, grossSeconds: null, breakSeconds: 0 };
  const gross = Math.max(0, Math.round((actualEnd.getTime() - actualStart.getTime()) / 1000));
  const brk = breakSecondsWithin(actualStart, actualEnd, breaks);
  return { netSeconds: Math.max(0, gross - brk), grossSeconds: gross, breakSeconds: brk };
};

/** Worked seconds of a running shift at `now` (server timer; refresh never resets it). */
export const runningNetSeconds = (actualStart: Date, now: Date, breaks: BreakInterval[]): number => {
  const gross = Math.max(0, Math.round((now.getTime() - actualStart.getTime()) / 1000));
  return Math.max(0, gross - breakSecondsWithin(actualStart, now, breaks));
};

/** Net hours as a decimal string with 2 places (e.g. "7.25"); null when pending. */
export const netHoursString = (netSeconds: number | null): string | null =>
  netSeconds === null ? null : new Big(netSeconds).div(3600).round(2, ROUND_HALF_EVEN).toFixed(2);

export interface BreakIssue {
  index: number;
  code: 'BREAK_OPEN' | 'BREAK_OUTSIDE_SHIFT' | 'BREAK_OVERLAP' | 'BREAK_NEGATIVE';
  message: string;
}

/** Breaks must be closed, inside the actual interval and must not overlap each other. */
export const validateBreaks = (actualStart: Date, actualEnd: Date | null, breaks: BreakInterval[]): BreakIssue[] => {
  const issues: BreakIssue[] = [];
  const sorted = breaks.map((b, index) => ({ ...b, index })).sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  for (const b of sorted) {
    if (!b.endedAt) {
      if (actualEnd) issues.push({ index: b.index, code: 'BREAK_OPEN', message: 'Every break must have an end time.' });
      continue;
    }
    if (b.endedAt.getTime() < b.startedAt.getTime()) issues.push({ index: b.index, code: 'BREAK_NEGATIVE', message: 'A break cannot end before it starts.' });
    if (b.startedAt.getTime() < actualStart.getTime() || (actualEnd && b.endedAt.getTime() > actualEnd.getTime()))
      issues.push({ index: b.index, code: 'BREAK_OUTSIDE_SHIFT', message: 'Breaks must lie within the actual shift time.' });
  }
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    const prevEnd = prev.endedAt ?? actualEnd ?? new Date(8.64e15);
    if (cur.startedAt.getTime() < prevEnd.getTime())
      issues.push({ index: cur.index, code: 'BREAK_OVERLAP', message: 'Breaks must not overlap.' });
  }
  return issues;
};

/** Actual start minus scheduled start in minutes (positive = late). A fact, not a penalty. */
export const lateMinutes = (scheduledStart: Date, actualStart: Date | null): number | null =>
  actualStart ? Math.round((actualStart.getTime() - scheduledStart.getTime()) / 60_000) : null;

export const shiftDurationMinutes = (start: Date, end: Date): number => Math.round((end.getTime() - start.getTime()) / 60_000);

export const isValidShiftDuration = (start: Date, end: Date): boolean => {
  const m = shiftDurationMinutes(start, end);
  return m >= SHIFT_LIMITS.minMinutes && m <= SHIFT_LIMITS.maxMinutes;
};

// ——— Daylight saving awareness ———

export interface DstInfo {
  startOffsetMinutes: number;
  endOffsetMinutes: number;
  /** The UTC offset changes inside the interval: wall-clock and elapsed durations differ. */
  offsetChanges: boolean;
  localStart: string;
  localEnd: string;
  elapsedMinutes: number;
  wallClockMinutes: number;
}

export const dstInfo = (start: Date, end: Date, zone: string): DstInfo => {
  const s = DateTime.fromJSDate(start, { zone });
  const e = DateTime.fromJSDate(end, { zone });
  const elapsed = shiftDurationMinutes(start, end);
  const wall = elapsed + (e.offset - s.offset);
  return {
    startOffsetMinutes: s.offset,
    endOffsetMinutes: e.offset,
    offsetChanges: s.offset !== e.offset,
    localStart: s.toFormat("yyyy-LL-dd'T'HH:mm"),
    localEnd: e.toFormat("yyyy-LL-dd'T'HH:mm"),
    elapsedMinutes: elapsed,
    wallClockMinutes: wall,
  };
};

export interface RepeatPattern {
  /** First calendar day of the horizon (inclusive), in the pattern's zone. */
  startDate: string;
  /** Horizon length in weeks (1–8). */
  weeks: number;
  /** ISO weekdays 1 = Monday … 7 = Sunday. */
  weekdays: number[];
  /** Local wall times HH:mm. An end at or before the start ends on the next day (overnight). */
  startTime: string;
  endTime: string;
  timezone: string;
}

export interface RepeatOccurrence {
  /** Local calendar date of the start (also the occurrence key). */
  date: string;
  start: Date;
  end: Date;
  durationMinutes: number;
  /** Wall time did not exist (spring-forward gap) and was shifted forward. */
  dstShifted: boolean;
  /** The UTC offset changes during the occurrence. */
  offsetChanges: boolean;
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export const validateRepeatPattern = (p: RepeatPattern): string[] => {
  const errors: string[] = [];
  if (!isIsoDate(p.startDate)) errors.push('startDate');
  if (!Number.isInteger(p.weeks) || p.weeks < 1 || p.weeks > SHIFT_LIMITS.repeatMaxWeeks) errors.push('weeks');
  if (!p.weekdays.length || p.weekdays.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) errors.push('weekdays');
  if (!TIME_RE.test(p.startTime)) errors.push('startTime');
  if (!TIME_RE.test(p.endTime)) errors.push('endTime');
  if (!isValidTimeZone(p.timezone)) errors.push('timezone');
  return errors;
};

/** Expand a weekly pattern into concrete UTC intervals (preview up to 8 weeks). */
export const repeatOccurrences = (p: RepeatPattern): RepeatOccurrence[] => {
  if (validateRepeatPattern(p).length) return [];
  const out: RepeatOccurrence[] = [];
  const first = DateTime.fromISO(p.startDate, { zone: 'UTC' });
  const days = p.weeks * 7;
  const wanted = new Set(p.weekdays);
  const overnight = p.endTime <= p.startTime;
  for (let i = 0; i < days; i++) {
    const d = first.plus({ days: i });
    if (!wanted.has(d.weekday)) continue;
    const date = d.toISODate() as string;
    const endDate = overnight ? (d.plus({ days: 1 }).toISODate() as string) : date;
    const s = zonedDateTimeToUtc(date, p.startTime, p.timezone);
    const e = zonedDateTimeToUtc(endDate, p.endTime, p.timezone);
    const info = dstInfo(s.utc, e.utc, p.timezone);
    out.push({
      date,
      start: s.utc,
      end: e.utc,
      durationMinutes: shiftDurationMinutes(s.utc, e.utc),
      dstShifted: s.dstShifted || e.dstShifted,
      offsetChanges: info.offsetChanges,
    });
  }
  return out;
};

// ——— Quality rubric (§13.6, M31) ———

export interface RubricCriterionDef {
  key: string;
  label: string;
  /** Percent weight as a decimal string. */
  weight: string;
  description?: string;
}

export interface CriterionScore {
  key: string;
  /** 0–4, or null for Not Applicable. */
  score: number | null;
  evidenceAssetIds?: string[];
  note?: string;
}

export const QUALITY_SCORE_MAX = 4;

export const DEFAULT_OFM_RUBRIC: RubricCriterionDef[] = [
  { key: 'handover_completeness', label: 'Handover Completeness', weight: '25' },
  { key: 'task_follow_through', label: 'Task Follow-through', weight: '25' },
  { key: 'data_accuracy', label: 'Data Accuracy', weight: '25' },
  { key: 'response_process_compliance', label: 'Response Process Compliance', weight: '25' },
];

export interface RubricIssue {
  field: string;
  code: string;
  message: string;
}

/** Rubric criteria: unique keys, positive weights with ≤ 4 decimals, total exactly 100. */
export const validateRubricCriteria = (criteria: RubricCriterionDef[]): RubricIssue[] => {
  const issues: RubricIssue[] = [];
  if (criteria.length === 0) issues.push({ field: 'criteria', code: 'REQUIRED', message: 'Add at least one criterion.' });
  const keys = new Set<string>();
  let total = new Big(0);
  criteria.forEach((c, i) => {
    if (!/^[a-z][a-z0-9_]{1,59}$/.test(c.key)) issues.push({ field: `criteria.${i}.key`, code: 'INVALID', message: 'Use a lowercase key (letters, digits, underscores).' });
    if (keys.has(c.key)) issues.push({ field: `criteria.${i}.key`, code: 'DUPLICATE', message: 'Criterion keys must be unique.' });
    keys.add(c.key);
    if (!isValidPercent(c.weight) || toBig(c.weight).lte(0)) {
      issues.push({ field: `criteria.${i}.weight`, code: 'INVALID', message: 'Weight must be a percentage above 0 with at most 4 decimals.' });
    } else total = total.plus(toBig(c.weight));
  });
  if (criteria.length && !total.eq(100)) issues.push({ field: 'criteria', code: 'WEIGHTS_NOT_100', message: 'Weights must add up to exactly 100%.' });
  return issues;
};

/** Scores must cover every criterion exactly once with 0–4 or Not Applicable. */
export const validateScores = (criteria: RubricCriterionDef[], scores: CriterionScore[], opts: { requireAll: boolean }): RubricIssue[] => {
  const issues: RubricIssue[] = [];
  const known = new Set(criteria.map((c) => c.key));
  const seen = new Set<string>();
  scores.forEach((s, i) => {
    if (!known.has(s.key)) issues.push({ field: `scores.${i}.key`, code: 'UNKNOWN_CRITERION', message: 'This criterion is not part of the rubric version.' });
    if (seen.has(s.key)) issues.push({ field: `scores.${i}.key`, code: 'DUPLICATE', message: 'Each criterion can be scored once.' });
    seen.add(s.key);
    if (s.score !== null && (!Number.isInteger(s.score) || s.score < 0 || s.score > QUALITY_SCORE_MAX))
      issues.push({ field: `scores.${i}.score`, code: 'OUT_OF_RANGE', message: 'Score each criterion 0–4 or mark it Not Applicable.' });
  });
  if (opts.requireAll)
    for (const c of criteria)
      if (!seen.has(c.key)) issues.push({ field: `scores.${c.key}`, code: 'REQUIRED', message: `Score “${c.label}” or mark it Not Applicable.` });
  return issues;
};

export interface QualityResult {
  /** Percentage with 2 decimals, or null = No Score (every criterion Not Applicable). Never 0 for "nothing applicable". */
  total: string | null;
  applicableWeight: string;
  applicableCriteria: number;
  notApplicableCriteria: number;
}

/** Total = Σ(score/4 × weight) / Σ(applicable weights) × 100. All N/A → No Score. */
export const qualityScore = (criteria: RubricCriterionDef[], scores: CriterionScore[]): QualityResult => {
  const byKey = new Map(scores.map((s) => [s.key, s]));
  let weighted = new Big(0);
  let weightSum = new Big(0);
  let applicable = 0;
  let na = 0;
  for (const c of criteria) {
    const s = byKey.get(c.key);
    if (!s || s.score === null || s.score === undefined) {
      na++;
      continue;
    }
    const w = toBig(c.weight);
    weighted = weighted.plus(new Big(s.score).div(QUALITY_SCORE_MAX).times(w));
    weightSum = weightSum.plus(w);
    applicable++;
  }
  return {
    total: weightSum.eq(0) ? null : weighted.div(weightSum).times(100).round(2, ROUND_HALF_EVEN).toFixed(2),
    applicableWeight: weightSum.toString(),
    applicableCriteria: applicable,
    notApplicableCriteria: na,
  };
};

/** Negative scores (0 or 1) need evidence before a review can be published (T101). */
export const negativeScoresWithoutEvidence = (scores: CriterionScore[]): string[] =>
  scores.filter((s) => s.score !== null && s.score <= 1 && !(s.evidenceAssetIds && s.evidenceAssetIds.length)).map((s) => s.key);

// ——— Sale attribution (§13.5) ———

export interface AllocationShareInput {
  membershipId: string;
  sharePercent: string;
}

export interface AllocationSummary {
  totalPercent: string;
  /** 100 − total: the part of the base that stays Unassigned. */
  unassignedPercent: string;
  status: 'unassigned' | 'partial' | 'full';
  issues: RubricIssue[];
}

/** Shares are explicit (never inferred from shift timing); their sum is ≤ 100 % and the rest stays Unassigned. */
export const summarizeAllocations = (shares: AllocationShareInput[]): AllocationSummary => {
  const issues: RubricIssue[] = [];
  const seen = new Set<string>();
  let total = new Big(0);
  shares.forEach((s, i) => {
    if (seen.has(s.membershipId)) issues.push({ field: `claimedAllocations.${i}.membershipId`, code: 'DUPLICATE', message: 'Each member can appear once.' });
    seen.add(s.membershipId);
    if (!isDecimalString(s.sharePercent) || !isValidPercent(s.sharePercent) || toBig(s.sharePercent).lte(0)) {
      issues.push({ field: `claimedAllocations.${i}.sharePercent`, code: 'INVALID', message: 'Share must be above 0 and at most 100 with up to 4 decimals.' });
      return;
    }
    total = total.plus(toBig(s.sharePercent));
  });
  if (total.gt(100)) issues.push({ field: 'claimedAllocations', code: 'OVER_100', message: 'Attribution shares cannot exceed 100% in total.' });
  const unassigned = total.gt(100) ? new Big(0) : new Big(100).minus(total);
  return {
    totalPercent: total.toString(),
    unassignedPercent: unassigned.toString(),
    status: total.eq(0) ? 'unassigned' : total.eq(100) ? 'full' : 'partial',
    issues,
  };
};

/** Handover completion (M30): acknowledged required handovers / required handovers; none required → Not Applicable (null). */
export const handoverCompletionPercent = (acknowledged: number, required: number): string | null =>
  required === 0 ? null : new Big(acknowledged).times(100).div(required).round(2, ROUND_HALF_EVEN).toFixed(2);
