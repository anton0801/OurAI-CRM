import { and, desc, eq } from 'drizzle-orm';
import { checkpointPolicies, metricCheckpoints, projects, type DbOrTx } from '@castlane/database';
import { newId } from '@castlane/domain';
import type { CommandContext } from '../core/context';
import { stamp, touch } from '../core/rows';
import { memberCan } from '../work/shared';
import { createTask } from '../work/tasks';
import { checkpointWindows, type CheckpointPolicyEntry } from './logic';
import type { PublicationRowDb } from './scope';
import { systemSubContext } from './support';

/**
 * Metric checkpoints of a published placement (§12, §15). Created exactly once per publication and
 * policy entry: `occurrence_key = publication:{id}:{policyKey}` is unique per workspace, so a repeated
 * Mark Published (another idempotency key, a retried job) can never create a second set (T065).
 *
 * Fields filled for the insights module (Metrics Inbox, M14/M40):
 *   entity_type='publication', entity_id=publication_id=<publication>, account_id, project_id (project
 *   at creation), checkpoint_key (policy key, e.g. pub_24h), policy_version, expected_at =
 *   actual_published_at + offset, window_start/window_end = expected ± tolerance (UTC elapsed time),
 *   state='pending', assignee_membership_id = publication owner. completed_observation_id, timing
 *   (early/on_time/late from the real observed_at), missing_reason are set by the insights module.
 */

const FALLBACK_POLICY: CheckpointPolicyEntry[] = [
  { key: 'pub_24h', offsetHours: 24, toleranceHours: 2 },
  { key: 'pub_7d', offsetHours: 168, toleranceHours: 12 },
];

export const activePublicationPolicy = async (db: DbOrTx, workspaceId: string): Promise<{ version: number; entries: CheckpointPolicyEntry[] }> => {
  const [p] = await db
    .select()
    .from(checkpointPolicies)
    .where(and(eq(checkpointPolicies.workspaceId, workspaceId), eq(checkpointPolicies.active, true)))
    .orderBy(desc(checkpointPolicies.version))
    .limit(1);
  const entries = p?.config.publication?.map((e) => ({ key: e.key, offsetHours: e.offsetHours, toleranceHours: e.toleranceHours })) ?? [];
  return p && entries.length ? { version: p.version, entries } : { version: p?.version ?? 0, entries: FALLBACK_POLICY };
};

export const occurrenceKeyOf = (publicationId: string, key: string) => `publication:${publicationId}:${key}`;

/** Insert the policy's checkpoints for a published placement; returns only rows created now. */
export const createPublicationCheckpoints = async (ctx: CommandContext, p: PublicationRowDb) => {
  if (!p.actualPublishedAt) return [];
  const policy = await activePublicationPolicy(ctx.tx, ctx.actor.workspaceId);
  const created: (typeof metricCheckpoints.$inferSelect)[] = [];
  for (const w of checkpointWindows(p.actualPublishedAt, policy.entries)) {
    const rows = await ctx.tx
      .insert(metricCheckpoints)
      .values({
        ...stamp(ctx),
        id: newId(),
        entityType: 'publication',
        entityId: p.id,
        accountId: p.accountId,
        projectId: p.projectId,
        publicationId: p.id,
        checkpointKey: w.key,
        policyVersion: policy.version,
        expectedAt: w.expectedAt,
        windowStart: w.windowStart,
        windowEnd: w.windowEnd,
        state: 'pending',
        occurrenceKey: occurrenceKeyOf(p.id, w.key),
        assigneeMembershipId: p.ownerMembershipId,
      })
      .onConflictDoNothing()
      .returning();
    created.push(...rows);
  }
  return created;
};

/**
 * After a correction of the actual publication time, move only pending checkpoints (§12: completed
 * observations keep their real observed_at). Returns the number of moved checkpoints.
 */
export const recalculatePendingCheckpoints = async (ctx: CommandContext, p: PublicationRowDb, from: Date, to: Date) => {
  const rows = await ctx.tx
    .select()
    .from(metricCheckpoints)
    .where(and(eq(metricCheckpoints.workspaceId, ctx.actor.workspaceId), eq(metricCheckpoints.publicationId, p.id), eq(metricCheckpoints.state, 'pending')));
  const shift = to.getTime() - from.getTime();
  for (const c of rows)
    await ctx.tx
      .update(metricCheckpoints)
      .set({
        expectedAt: new Date(c.expectedAt.getTime() + shift),
        windowStart: new Date(c.windowStart.getTime() + shift),
        windowEnd: new Date(c.windowEnd.getTime() + shift),
        ...touch(ctx, metricCheckpoints),
      })
      .where(eq(metricCheckpoints.id, c.id));
  return rows.length;
};

const TASK_PERMISSIONS = ['tasks.read', 'tasks.create', 'tasks.assign', 'tasks.edit', 'publications.read', 'accounts.read', 'content.read'];

/** Assign follow-up work to the publication owner only when they can see the task; otherwise leave it for the lead's Unassigned queue. */
const assigneeFor = async (ctx: CommandContext, p: PublicationRowDb, accountId: string | null) => {
  const r = await memberCan(ctx.app.db, ctx.actor.workspaceId, p.ownerMembershipId, 'tasks.read', { projectId: p.projectId, accountId, assignedMembershipIds: [p.ownerMembershipId] }, ctx.app.clock.now());
  return r.ok ? p.ownerMembershipId : null;
};

const projectOpen = async (ctx: CommandContext, projectId: string) => {
  const [proj] = await ctx.tx.select({ status: projects.status }).from(projects).where(eq(projects.id, projectId));
  return !!proj && proj.status !== 'archived';
};

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/**
 * F07: measurement tasks for the checkpoints created now (only for windows that are still ahead — a
 * historical entry does not flood My Work with overdue tasks) through the tasks module's createTask.
 */
export const createMeasurementTasks = async (
  ctx: CommandContext,
  p: PublicationRowDb,
  title: string,
  account: { label: string; projectId: string | null },
  created: (typeof metricCheckpoints.$inferSelect)[],
  labelOf: (c: typeof metricCheckpoints.$inferSelect) => string,
) => {
  const now = ctx.app.clock.now();
  const upcoming = created.filter((c) => c.windowEnd.getTime() > now.getTime());
  if (!upcoming.length || !(await projectOpen(ctx, p.projectId))) return [];
  const sys = await systemSubContext(ctx, TASK_PERMISSIONS);
  const accountId = account.projectId === p.projectId ? p.accountId : null;
  const assignee = await assigneeFor(ctx, p, accountId);
  const ids: string[] = [];
  for (const c of upcoming) {
    const label = labelOf(c);
    ids.push(
      await createTask(
        sys,
        {
          title: clip(`Record ${label} metrics: ${title}`, 200),
          projectId: p.projectId,
          description: `Enter the ${label} numbers of this publication on ${account.label} between ${c.windowStart.toISOString()} and ${c.windowEnd.toISOString()} (UTC) in the Metrics Inbox. Observations outside this window are kept but labelled Early or Late.`,
          status: 'backlog',
          priority: 'normal',
          assigneeMembershipId: assignee,
          due: { kind: 'datetime', at: c.windowEnd.toISOString(), timezone: p.scheduleTimezone ?? ctx.actor.timezone },
          publicationId: p.id,
          // A task links the account only while it still belongs to the placement's project (transfers).
          accountId,
        },
        { source: 'automation' },
      ),
    );
  }
  return ids;
};

/** "URL Missing" follow-up (§12): a task to add the post URL when it was confirmed without one. */
export const createMissingUrlTask = async (ctx: CommandContext, p: PublicationRowDb, title: string, account: { projectId: string | null }) => {
  if (!(await projectOpen(ctx, p.projectId))) return null;
  const sys = await systemSubContext(ctx, TASK_PERMISSIONS);
  const accountId = account.projectId === p.projectId ? p.accountId : null;
  return createTask(
    sys,
    {
      title: clip(`Add the post URL: ${title}`, 200),
      projectId: p.projectId,
      description: `The publication was confirmed without a post URL (${p.noUrlReason ?? 'no reason given'}). When the URL is known, record it with Correct Publication.`,
      status: 'backlog',
      priority: 'normal',
      assigneeMembershipId: await assigneeFor(ctx, p, accountId),
      due: { kind: 'datetime', at: new Date(ctx.app.clock.now().getTime() + 24 * 3_600_000).toISOString(), timezone: p.scheduleTimezone ?? ctx.actor.timezone },
      publicationId: p.id,
      accountId,
    },
    { source: 'automation' },
  );
};
