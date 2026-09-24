import { sql } from 'drizzle-orm';
import { tags as tagTable } from '@castlane/database';
import { AppError, LIMITS, newId, normalizeKey, normalizeTag } from '@castlane/domain';
import type { CommandContext } from './context';

/**
 * Normalise tags against the workspace dictionary (case-insensitive uniqueness): the first
 * spelling wins, later variants map onto it. Enforces the per-object limit (30) and length.
 */
export const resolveTags = async (ctx: CommandContext, input: string[] | undefined): Promise<string[]> => {
  if (!input || input.length === 0) return [];
  const cleaned = [...new Map(input.map((t) => [normalizeKey(t), normalizeTag(t)])).values()];
  if (cleaned.length > LIMITS.tagsPerObject) throw new AppError('VALIDATION_FAILED', `Use at most ${LIMITS.tagsPerObject} tags.`);
  for (const t of cleaned)
    if (t.length < LIMITS.tagMin || t.length > LIMITS.tagMax) throw new AppError('VALIDATION_FAILED', `Tags must be ${LIMITS.tagMin}–${LIMITS.tagMax} characters.`);
  const at = ctx.app.clock.now();
  const out: string[] = [];
  for (const t of cleaned) {
    const res = await ctx.tx.execute<{ name: string }>(sql`
      INSERT INTO ${tagTable} (id, workspace_id, name, name_key, created_at, updated_at, created_by, updated_by)
      VALUES (${newId()}, ${ctx.actor.workspaceId}, ${t}, ${normalizeKey(t)}, ${at}, ${at}, ${ctx.actor.userId}, ${ctx.actor.userId})
      ON CONFLICT (workspace_id, name_key) DO UPDATE SET updated_at = ${tagTable.updatedAt}
      RETURNING name`);
    out.push(res.rows[0]?.name ?? t);
  }
  return out;
};
