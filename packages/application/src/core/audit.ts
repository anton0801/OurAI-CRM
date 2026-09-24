import { auditEvents, type DbOrTx } from '@castlane/database';
import { newId } from '@castlane/domain';
import type { CommandContext } from './context';

/** Field names whose values are never written to the audit diff. */
const SECRET_FIELDS = /password|token|secret|mfa|recovery|otp|signed_?url|smtp_?pass/i;

export type Diff = Record<string, { from?: unknown; to?: unknown }>;

const normalize = (v: unknown): unknown => {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'bigint') return v.toString();
  return v;
};

/**
 * Compute a field diff between two records for the audit log. Secret fields are dropped and
 * `masked` fields (sensitive text such as contact notes) are recorded as changed without values.
 */
export const diffFields = (
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
  fields: string[],
  masked: string[] = [],
): Diff => {
  const d: Diff = {};
  for (const f of fields) {
    if (SECRET_FIELDS.test(f)) continue;
    const a = normalize(before?.[f]);
    const b = normalize(after[f]);
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    d[f] = masked.includes(f) ? { from: '[masked]', to: '[masked]' } : { from: a, to: b };
  }
  return d;
};

export interface AuditInput {
  action: string;
  entityType?: string;
  entityId?: string;
  projectId?: string | null;
  reason?: string | null;
  diff?: Diff;
  metadata?: Record<string, unknown>;
  sensitivity?: 'normal' | 'finance' | 'ofm' | 'security';
}

export const audit = async (ctx: CommandContext, input: AuditInput): Promise<void> => {
  await ctx.tx.insert(auditEvents).values({
    id: newId(),
    workspaceId: ctx.actor.workspaceId,
    actorUserId: ctx.actor.userId,
    actorMembershipId: ctx.actor.membershipId,
    actorKind: ctx.actor.kind === 'user' ? 'user' : ctx.actor.kind,
    actorDisplay: ctx.actor.displayName,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    projectId: input.projectId ?? null,
    occurredAt: ctx.app.clock.now(),
    requestId: ctx.request.requestId,
    source: ctx.request.source,
    reason: input.reason ?? null,
    diff: input.diff && Object.keys(input.diff).length ? input.diff : null,
    metadata: input.metadata ?? null,
    sensitivity: input.sensitivity ?? 'normal',
    ipHash: ctx.request.ipHash ?? null,
  });
};

/** Audit outside a workspace command (sign-in failures, bootstrap). */
export const auditRaw = async (
  db: DbOrTx,
  input: AuditInput & {
    workspaceId: string | null;
    actorUserId: string | null;
    actorKind: 'user' | 'system' | 'anonymous';
    requestId?: string;
    at: Date;
    ipHash?: string | null;
  },
): Promise<void> => {
  await db.insert(auditEvents).values({
    id: newId(),
    workspaceId: input.workspaceId,
    actorUserId: input.actorUserId,
    actorKind: input.actorKind,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    occurredAt: input.at,
    requestId: input.requestId,
    source: 'system',
    reason: input.reason ?? null,
    diff: input.diff ?? null,
    metadata: input.metadata ?? null,
    sensitivity: input.sensitivity ?? 'security',
    ipHash: input.ipHash ?? null,
  });
};
