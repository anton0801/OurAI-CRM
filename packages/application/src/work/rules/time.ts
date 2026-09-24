/**
 * Time recording rules (spec §11, S30). Pure helpers: interval validation and overlap detection.
 * Breaks and task time are never merged automatically; the member resolves overlaps explicitly.
 */
export const MAX_ENTRY_SECONDS = 24 * 3600;
/** A timer running longer than this is flagged Needs Review (it is never stopped automatically). */
export const TIMER_REVIEW_AFTER_SECONDS = 12 * 3600;

export interface TimedInterval {
  id: string;
  startedAt: Date;
  endedAt: Date;
}

export type IntervalProblem = 'END_BEFORE_START' | 'TOO_LONG' | 'IN_FUTURE';

export const validateInterval = (startedAt: Date, endedAt: Date, now: Date): IntervalProblem | null => {
  if (endedAt.getTime() <= startedAt.getTime()) return 'END_BEFORE_START';
  if (endedAt.getTime() - startedAt.getTime() > MAX_ENTRY_SECONDS * 1000) return 'TOO_LONG';
  if (endedAt.getTime() > now.getTime() + 60_000) return 'IN_FUTURE';
  return null;
};

/** Pairs of entries whose intervals intersect (touching end = start is not an overlap). */
export const findOverlaps = (entries: readonly TimedInterval[]): [string, string][] => {
  const sorted = [...entries].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime() || a.id.localeCompare(b.id));
  const out: [string, string][] = [];
  const active: TimedInterval[] = [];
  for (const e of sorted) {
    for (let i = active.length - 1; i >= 0; i--) if (active[i]!.endedAt.getTime() <= e.startedAt.getTime()) active.splice(i, 1);
    for (const a of active) out.push(a.id < e.id ? [a.id, e.id] : [e.id, a.id]);
    active.push(e);
  }
  return out;
};

/** Ids involved in at least one overlap. */
export const overlappingIds = (entries: readonly TimedInterval[]): Set<string> => {
  const s = new Set<string>();
  for (const [a, b] of findOverlaps(entries)) {
    s.add(a);
    s.add(b);
  }
  return s;
};
