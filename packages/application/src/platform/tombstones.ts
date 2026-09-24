import { eq } from 'drizzle-orm';
import { deletionTombstones, workspaces } from '@castlane/database';
import { newId } from '@castlane/domain';
import { auditRaw } from '../core/audit';
import { executeSystemCommand } from '../core/command';
import type { AppServices, CommandContext } from '../core/context';
import { enqueueJob } from '../core/jobs';
import { defineJob, systemJobContext } from '../core/jobs-registry';

/**
 * Deletion tombstones (spec §22.3, §27.2). Every permanent deletion or erasure writes a tombstone
 * row and — through a job queued in the same transaction — a write-once journal object in storage,
 * outside the database backups. After a disaster restore the journal is replayed BEFORE users get
 * access again, so a contact erased after the recovery point is erased again (T157). The journal
 * holds identifiers only (entity type/id, action, time), never the erased content.
 */
export const TOMBSTONE_JOURNAL_PREFIX = 'journal/tombstones/';

export type TombstoneAction = 'purge' | 'erase' | 'revoke';

export interface TombstoneRecord {
  id: string;
  workspaceId: string;
  entityType: string;
  entityId: string;
  action: TombstoneAction;
  details: Record<string, unknown>;
  executedAt: Date;
}

/** Re-apply one tombstone to a restored database. `not_present`: nothing to delete any more. */
export type TombstoneReplayHandler = (ctx: CommandContext, t: TombstoneRecord) => Promise<'applied' | 'not_present'>;

const REPLAY_HANDLERS = new Map<string, TombstoneReplayHandler>();

export const defineTombstoneReplay = (entityType: string, action: TombstoneAction, handler: TombstoneReplayHandler) => {
  REPLAY_HANDLERS.set(`${entityType}:${action}`, handler);
};

/** Write the tombstone in the caller's transaction and queue its journal copy. */
export const recordTombstone = async (ctx: CommandContext, t: { workspaceId: string; entityType: string; entityId: string; action: TombstoneAction; details?: Record<string, unknown> }) => {
  const id = newId();
  await ctx.tx.insert(deletionTombstones).values({ id, workspaceId: t.workspaceId, entityType: t.entityType, entityId: t.entityId, action: t.action, details: t.details ?? {}, executedAt: ctx.app.clock.now() });
  await enqueueJob(ctx.tx, { type: 'tombstones.journal', pool: 'light', workspaceId: t.workspaceId, payload: { tombstoneId: id }, idempotencyKey: `tombstones.journal:${id}` });
  return id;
};

const journalKey = (t: { id: string; executedAt: Date }) =>
  `${TOMBSTONE_JOURNAL_PREFIX}${t.executedAt.toISOString().slice(0, 10)}/${t.executedAt.toISOString().replace(/[:.]/g, '-')}_${t.id}.json`;

defineJob('tombstones.journal', 'light', async ({ app, job }) => {
  const id = String(job.payload.tombstoneId ?? '');
  const [t] = await app.db.select().from(deletionTombstones).where(eq(deletionTombstones.id, id));
  if (!t) return { skipped: 'missing' };
  const key = journalKey(t);
  if (await app.storage.headObject(key)) return { key, existing: true };
  const body = { format: 'castlane-tombstone', formatVersion: 1, id: t.id, workspaceId: t.workspaceId, entityType: t.entityType, entityId: t.entityId, action: t.action, details: t.details, executedAt: t.executedAt.toISOString() };
  await app.storage.putObject(key, Buffer.from(JSON.stringify(body)), { contentType: 'application/json' });
  return { key };
});

const parseEntry = (raw: string): TombstoneRecord | null => {
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    if (j.format !== 'castlane-tombstone' || typeof j.id !== 'string' || typeof j.workspaceId !== 'string' || typeof j.entityType !== 'string' || typeof j.entityId !== 'string') return null;
    if (j.action !== 'purge' && j.action !== 'erase' && j.action !== 'revoke') return null;
    const executedAt = new Date(String(j.executedAt));
    if (Number.isNaN(executedAt.getTime())) return null;
    return { id: j.id, workspaceId: j.workspaceId, entityType: j.entityType, entityId: j.entityId, action: j.action, details: (j.details as Record<string, unknown>) ?? {}, executedAt };
  } catch {
    return null;
  }
};

const readText = async (app: AppServices, key: string) => {
  const { stream } = await app.storage.getObjectStream(key);
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks).toString('utf8');
};

export interface TombstoneReplayReport {
  journalEntries: number;
  /** Entries at or before the recovery point (already contained in the restored data). */
  beforeRecoveryPoint: number;
  alreadyApplied: number;
  applied: number;
  notPresent: number;
  /** Dry run: entries that would be applied. */
  pending: number;
  unreadable: string[];
  unknown: { id: string; entityType: string; action: string }[];
  failed: { id: string; entityType: string; error: string }[];
}

/**
 * Replay the journal against the current (restored) database: every tombstone not yet present is
 * applied by its module handler and recorded again with the same id, so a second run changes
 * nothing. Run it while the application is closed to users (runbook "Disaster restore").
 */
export const replayTombstones = async (app: AppServices, opts: { since?: Date; dryRun?: boolean } = {}): Promise<TombstoneReplayReport> => {
  const report: TombstoneReplayReport = { journalEntries: 0, beforeRecoveryPoint: 0, alreadyApplied: 0, applied: 0, notPresent: 0, pending: 0, unreadable: [], unknown: [], failed: [] };
  const keys = await app.storage.listObjects(TOMBSTONE_JOURNAL_PREFIX);
  for (const key of keys) {
    report.journalEntries++;
    const t = parseEntry(await readText(app, key));
    if (!t) {
      report.unreadable.push(key);
      continue;
    }
    if (opts.since && t.executedAt <= opts.since) {
      report.beforeRecoveryPoint++;
      continue;
    }
    const [present] = await app.db.select({ id: deletionTombstones.id }).from(deletionTombstones).where(eq(deletionTombstones.id, t.id));
    if (present) {
      report.alreadyApplied++;
      continue;
    }
    const handler = REPLAY_HANDLERS.get(`${t.entityType}:${t.action}`);
    if (!handler) {
      report.unknown.push({ id: t.id, entityType: t.entityType, action: t.action });
      continue;
    }
    if (opts.dryRun) {
      report.pending++;
      continue;
    }
    try {
      const [ws] = await app.db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, t.workspaceId));
      if (!ws) {
        // The whole workspace postdates the recovery point: nothing of it exists to delete.
        await app.db.insert(deletionTombstones).values({ id: t.id, workspaceId: t.workspaceId, entityType: t.entityType, entityId: t.entityId, action: t.action, details: { ...t.details, replayedAt: app.clock.now().toISOString(), replayOutcome: 'not_present' }, executedAt: t.executedAt });
        report.notPresent++;
        continue;
      }
      const ctx = await systemJobContext(app, t.workspaceId, [], { requestId: `replay_${t.id.slice(0, 8)}` });
      const outcome = await executeSystemCommand(ctx, async (c) => {
        const r = await handler(c, t);
        await c.tx.insert(deletionTombstones).values({ id: t.id, workspaceId: t.workspaceId, entityType: t.entityType, entityId: t.entityId, action: t.action, details: { ...t.details, replayedAt: c.app.clock.now().toISOString(), replayOutcome: r }, executedAt: t.executedAt });
        await auditRaw(c.tx, { action: 'tombstone.replayed', workspaceId: t.workspaceId, actorUserId: null, actorKind: 'system', entityType: t.entityType, entityId: t.entityId, at: c.app.clock.now(), requestId: c.request.requestId, metadata: { tombstoneId: t.id, action: t.action, outcome: r } });
        return r;
      });
      if (outcome === 'applied') report.applied++;
      else report.notPresent++;
    } catch (e) {
      report.failed.push({ id: t.id, entityType: t.entityType, error: (e as Error).message.slice(0, 300) });
    }
  }
  return report;
};
