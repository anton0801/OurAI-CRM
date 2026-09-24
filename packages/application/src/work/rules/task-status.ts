import type { EnumValue, TASK_STATUSES, TransitionTable } from '@castlane/domain';

/**
 * Pure task lifecycle rules (spec §11). Canonical statuses; "Blocked" is an independent flag and
 * "Overdue" is computed, never stored.
 */
export type TaskStatus = EnumValue<typeof TASK_STATUSES>;

export const TASK_TRANSITIONS: TransitionTable<TaskStatus> = {
  draft: ['backlog', 'ready', 'in_progress', 'cancelled'],
  backlog: ['draft', 'ready', 'in_progress', 'cancelled'],
  ready: ['backlog', 'in_progress', 'cancelled'],
  in_progress: ['ready', 'in_review', 'done', 'cancelled'],
  in_review: ['in_progress', 'done', 'cancelled'],
  // Reopen creates a new cycle; a cancelled task can be restored to the backlog.
  done: ['ready', 'in_progress'],
  cancelled: ['backlog'],
};

export const OPEN_TASK_STATUSES: readonly TaskStatus[] = ['draft', 'backlog', 'ready', 'in_progress', 'in_review'];
export const CLOSED_TASK_STATUSES: readonly TaskStatus[] = ['done', 'cancelled'];
/** Work has not started yet (recurrence rule changes and template diffs may touch these). */
export const NOT_STARTED_STATUSES: readonly TaskStatus[] = ['draft', 'backlog', 'ready'];

export const isOpenStatus = (s: TaskStatus): boolean => OPEN_TASK_STATUSES.includes(s);

/** Overdue = due_at < now AND status not Done/Cancelled. No deadline is never overdue (T052). */
export const isOverdue = (t: { dueAt: Date | null; status: TaskStatus }, now: Date): boolean =>
  !!t.dueAt && t.dueAt.getTime() < now.getTime() && isOpenStatus(t.status);

export type TransitionKind = 'start' | 'submit' | 'complete' | 'reopen' | 'cancel' | 'restore' | 'plan';

/** Classify a transition so the use case can apply the right permission and guards. */
export const transitionKind = (from: TaskStatus, to: TaskStatus): TransitionKind => {
  if (to === 'cancelled') return 'cancel';
  if (from === 'cancelled') return 'restore';
  if (from === 'done') return 'reopen';
  if (to === 'done') return 'complete';
  if (to === 'in_review') return 'submit';
  if (to === 'in_progress' && from !== 'in_review') return 'start';
  return 'plan';
};

/**
 * Cycle number for the next status event: a reopen of a Done task starts a new cycle, so the
 * completion count uses the last valid Done per task (T051) and reopened work is counted apart.
 */
export const nextCycle = (currentCycle: number, from: TaskStatus, to: TaskStatus): number =>
  from === 'done' && to !== 'done' ? currentCycle + 1 : currentCycle;

/**
 * baseline_due_at is fixed at the first Ready with a deadline, or — if the deadline is first set
 * later — when it is set on a task already past Draft/Backlog. Ordinary reschedules never move it.
 */
export const baselineAfter = (input: {
  baseline: Date | null;
  status: TaskStatus;
  dueAt: Date | null;
}): Date | null => {
  if (input.baseline) return input.baseline;
  if (!input.dueAt) return null;
  return input.status === 'draft' || input.status === 'backlog' ? null : input.dueAt;
};
