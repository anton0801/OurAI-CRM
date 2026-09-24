import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { can } from '@castlane/authorization';
import { searchDocuments } from '@castlane/database';
import type { QueryContext } from '../core/context';
import { dbOf } from '../core/context';
import { LINK_ACCESS } from '../media/link-access';

export interface EntityKey {
  entityType: string;
  entityId: string;
  /** Project the reference was created in (fallback when the entity type has no resolver). */
  projectId?: string | null;
}

export interface EntityAccess {
  readable: boolean;
  /** Search projection of the entity when indexed (thumbnail, restricted flag). */
  thumbnailAssetId: string | null;
  restricted: boolean;
}

const keyOf = (k: { entityType: string; entityId: string }) => `${k.entityType}:${k.entityId}`;

/**
 * Re-check, at read time, whether the actor can still read the objects referenced by inbox
 * items, archive rows or audit links. Resolution order: the permission-aware search projection
 * (same permission and scope columns the module indexed), the module's link-access resolver, and
 * finally the project the reference belongs to. References that cannot be resolved at all are
 * treated as readable only when they carry no project (workspace-level notices).
 */
export const resolveEntityAccess = async (ctx: QueryContext, keys: EntityKey[]): Promise<Map<string, EntityAccess>> => {
  const out = new Map<string, EntityAccess>();
  const unique = [...new Map(keys.filter((k) => k.entityType && k.entityId).map((k) => [keyOf(k), k])).values()];
  if (unique.length === 0) return out;
  const canRestricted = (projectId: string | null) => can(ctx.actor.access, 'assets.restricted.read', { projectId });
  const docs = await dbOf(ctx)
    .select()
    .from(searchDocuments)
    .where(
      and(
        eq(searchDocuments.workspaceId, ctx.actor.workspaceId),
        or(...unique.map((k) => and(eq(searchDocuments.entityType, k.entityType), eq(searchDocuments.entityId, k.entityId)))),
      ),
    );
  const byKey = new Map(docs.map((d) => [keyOf(d), d]));
  for (const k of unique) {
    const d = byKey.get(keyOf(k));
    if (d) {
      const readable =
        can(ctx.actor.access, d.permission, {
          objectType: d.entityType,
          objectId: d.entityId,
          projectId: d.projectId,
          accountId: d.accountId,
          directionId: d.directionId,
          ownerMembershipId: d.ownerMembershipId,
          assignedMembershipIds: d.assigneeMembershipIds,
        }) &&
        (!d.restricted || canRestricted(d.projectId));
      out.set(keyOf(k), { readable, thumbnailAssetId: readable && !d.restricted ? d.thumbnailAssetId : null, restricted: d.restricted });
      continue;
    }
    const resolver = LINK_ACCESS.get(k.entityType);
    if (resolver) {
      const scope = await resolver.scope(ctx, k.entityId);
      out.set(keyOf(k), { readable: !!scope && can(ctx.actor.access, resolver.permission, scope), thumbnailAssetId: null, restricted: false });
      continue;
    }
    if (k.projectId) {
      out.set(keyOf(k), { readable: can(ctx.actor.access, 'projects.read', { projectId: k.projectId }), thumbnailAssetId: null, restricted: false });
      continue;
    }
    out.set(keyOf(k), { readable: true, thumbnailAssetId: null, restricted: false });
  }
  return out;
};

export const accessKey = keyOf;

/** Names of projects the actor can read (for filter options and labels). */
export const readableProjectNames = async (ctx: QueryContext, ids: string[]) => {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Map<string, string>();
  const rows = await dbOf(ctx).execute<{ id: string; name: string; direction_id: string; owner_membership_id: string }>(
    sql`SELECT id, name, direction_id, owner_membership_id FROM projects WHERE workspace_id = ${ctx.actor.workspaceId} AND id IN (${sql.join(unique.map((i) => sql`${i}::uuid`), sql`, `)}) AND deleted_at IS NULL`,
  );
  const out = new Map<string, string>();
  for (const r of rows.rows)
    if (can(ctx.actor.access, 'projects.read', { projectId: r.id, directionId: r.direction_id, ownerMembershipId: r.owner_membership_id })) out.set(r.id, r.name);
  return out;
};

void inArray;
