import { z } from 'zod';
import { TASK_PRIORITIES, TASK_STATUSES } from '@castlane/domain';
import { isoDate, isoDateTime, memberRef, timezone, uuid } from '../common';

/**
 * Deadline input: a calendar date ("Due by end of day" in the given zone) or an exact moment.
 * `null` clears the deadline explicitly (No Deadline).
 */
export const dueInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('date'), date: isoDate, timezone }),
  z.object({ kind: z.literal('datetime'), at: isoDateTime, timezone: timezone.nullable().optional() }),
]);
export type DueInputBody = z.infer<typeof dueInput>;

/** Stored deadline: the UTC moment plus, for date-only deadlines, the calendar date and its zone. */
export const dueView = z.object({ at: isoDateTime, date: isoDate.nullable(), timezone: z.string().nullable() });

export const taskStatus = z.enum(TASK_STATUSES);
export const taskPriority = z.enum(TASK_PRIORITIES);

/** A linked record, with the label only when the viewer may read it (otherwise `label` is null). */
export const linkedRef = z.object({
  type: z.enum(['account', 'content_item', 'publication', 'shift', 'operation', 'deal', 'deliverable', 'article']),
  id: uuid,
  label: z.string().nullable(),
  href: z.string().nullable(),
});
export type LinkedRef = z.infer<typeof linkedRef>;

export const taskRef = z.object({ id: uuid, title: z.string().nullable(), status: taskStatus.nullable(), readable: z.boolean() });

export const taskRow = z.object({
  id: uuid,
  title: z.string(),
  status: taskStatus,
  priority: taskPriority,
  project: z.object({ id: uuid, name: z.string() }),
  assignee: memberRef.nullable(),
  reviewer: memberRef.nullable(),
  startAt: isoDateTime.nullable(),
  due: dueView.nullable(),
  /** Computed: due_at < now and not Done/Cancelled. */
  overdue: z.boolean(),
  estimateMinutes: z.number().int().nullable(),
  blocked: z.object({ reason: z.string(), since: isoDateTime, nextCheckAt: isoDateTime.nullable() }).nullable(),
  dependencies: z.object({ total: z.number().int(), openPredecessors: z.number().int() }),
  checklist: z.object({ total: z.number().int(), done: z.number().int(), mandatoryOpen: z.number().int() }),
  subtasks: z.object({ total: z.number().int(), open: z.number().int() }),
  parent: taskRef.nullable(),
  linked: z.array(linkedRef),
  tags: z.array(z.string()),
  source: z.string(),
  recurring: z.boolean(),
  following: z.boolean(),
  completedAt: isoDateTime.nullable(),
  archivedAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
  rowVersion: z.number().int(),
});
export type TaskRow = z.infer<typeof taskRow>;
