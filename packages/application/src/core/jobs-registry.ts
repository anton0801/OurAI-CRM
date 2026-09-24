import { and, eq } from 'drizzle-orm';
import type { AccessSnapshot } from '@castlane/authorization';
import { memberships, users, workspaces, type Tx } from '@castlane/database';
import { newId } from '@castlane/domain';
import { loadAccessSnapshot } from './access';
import type { Actor, AppServices, Causation, QueryContext } from './context';
import type { JobPool } from './jobs';

export interface JobRecord {
  id: string;
  type: string;
  workspaceId: string | null;
  payload: Record<string, unknown>;
  attempts: number;
  causation: { rootEventId?: string; parentEventId?: string; depth?: number } | null;
  requestedBy: string | null;
}

export interface JobContext {
  app: AppServices;
  job: JobRecord;
  /** Extend the lease and report progress (0–100, never 100 before the final commit). */
  heartbeat: (progress?: number, note?: string) => Promise<void>;
  /** True when a cancellation was requested for this job. */
  cancelled: () => Promise<boolean>;
}

export type JobHandler = (ctx: JobContext) => Promise<Record<string, unknown> | void>;

export interface JobDefinition {
  type: string;
  pool: JobPool;
  handler: JobHandler;
  /** Lease duration; long jobs must heartbeat within it. */
  leaseSeconds?: number;
}

export const JOB_DEFINITIONS = new Map<string, JobDefinition>();

export const defineJob = (type: string, pool: JobPool, handler: JobHandler, opts: { leaseSeconds?: number } = {}) => {
  // Re-definition replaces the previous handler (module re-evaluation during development).
  JOB_DEFINITIONS.set(type, { type, pool, handler, leaseSeconds: opts.leaseSeconds });
};

export interface OutboxEventRecord {
  id: string;
  workspaceId: string | null;
  eventType: string;
  entityType: string | null;
  entityId: string | null;
  payload: Record<string, unknown>;
  actorMembershipId: string | null;
  occurredAt: Date;
  rootEventId: string;
  parentEventId: string | null;
  depth: number;
}

/**
 * Outbox consumers run inside the dispatcher's transaction and must be idempotent: they usually
 * enqueue a job keyed by `${consumer}:${event.id}` (at-least-once delivery, same observable effect).
 */
export interface OutboxConsumer {
  name: string;
  /** Event types handled; '*' for all. */
  events: string[] | '*';
  handle: (tx: Tx, event: OutboxEventRecord, app: AppServices) => Promise<void>;
}

export const OUTBOX_CONSUMERS: OutboxConsumer[] = [];
export const defineConsumer = (c: OutboxConsumer) => {
  const i = OUTBOX_CONSUMERS.findIndex((x) => x.name === c.name);
  if (i >= 0) OUTBOX_CONSUMERS[i] = c;
  else OUTBOX_CONSUMERS.push(c);
};

/**
 * Periodic schedules. The scheduler enqueues `job` once per time bucket using an idempotency key,
 * so several worker instances never duplicate a run.
 */
export interface ScheduleDefinition {
  name: string;
  everySeconds: number;
  jobType: string;
  pool?: JobPool;
}
export const SCHEDULES: ScheduleDefinition[] = [];
export const defineSchedule = (s: ScheduleDefinition) => {
  const i = SCHEDULES.findIndex((x) => x.name === s.name);
  if (i >= 0) SCHEDULES[i] = s;
  else SCHEDULES.push(s);
};

/**
 * Build an actor for background work performed on behalf of a member: permissions are re-read
 * now (a revoked member's job fails authorisation instead of running with stale rights).
 */
export const memberJobContext = async (
  app: AppServices,
  workspaceId: string,
  membershipId: string,
  opts: { requestId?: string; causation?: Causation; source?: 'automation' | 'import' | 'system' } = {},
): Promise<QueryContext | null> => {
  const [m] = await app.db
    .select({ userId: memberships.userId, name: users.displayName, tz: workspaces.timezone })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .where(and(eq(memberships.id, membershipId), eq(memberships.workspaceId, workspaceId)));
  if (!m) return null;
  const access = await loadAccessSnapshot(app.db, workspaceId, m.userId, app.clock.now());
  if (!access || access.membershipStatus !== 'active') return null;
  const actor: Actor = {
    kind: opts.source === 'automation' ? 'automation' : opts.source === 'import' ? 'import' : 'user',
    userId: m.userId,
    membershipId,
    workspaceId,
    displayName: m.name,
    access,
    timezone: m.tz,
  };
  return { app, actor, request: { requestId: opts.requestId ?? `job_${newId().slice(0, 8)}`, source: opts.source ?? 'system', causation: opts.causation } };
};

/**
 * System actor for maintenance work (reminders, checkpoint generation, retention). It holds only
 * the permissions listed, at workspace scope, and is audited as "system".
 */
export const systemJobContext = async (
  app: AppServices,
  workspaceId: string,
  permissions: string[],
  opts: { requestId?: string; causation?: Causation } = {},
): Promise<QueryContext> => {
  const [ws] = await app.db.select({ tz: workspaces.timezone }).from(workspaces).where(eq(workspaces.id, workspaceId));
  const access: AccessSnapshot = {
    workspaceId,
    userId: '00000000-0000-4000-8000-000000000000',
    membershipId: '00000000-0000-4000-8000-000000000000',
    membershipStatus: 'active',
    accessRevision: 0,
    isOwner: false,
    grants: [{ roleId: 'system', roleKey: 'system', permissions: new Set(permissions), scopeType: 'workspace', scopeId: null }],
    denies: [],
    assignedProjectIds: new Set(),
    assignedAccountIds: new Set(),
    projectDirection: new Map(),
    accountProject: new Map(),
  };
  return {
    app,
    actor: { kind: 'system', userId: null, membershipId: null, workspaceId, displayName: 'System', access, timezone: ws?.tz ?? 'UTC' },
    request: { requestId: opts.requestId ?? `sys_${newId().slice(0, 8)}`, source: 'system', causation: opts.causation },
  };
};
