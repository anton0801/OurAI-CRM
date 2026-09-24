import type { ObjectScope } from '@castlane/authorization';
import { allowed } from '../core/access';
import type { QueryContext } from '../core/context';

export type LinkTargetScope = ObjectScope & { label?: string | null; href?: string | null };

/**
 * How to authorise access to an asset through an entity it is linked to (e.g. a contractor may
 * see a task attachment without reading the whole project). Modules register resolvers for
 * their entity types; unknown types grant nothing.
 */
export interface LinkAccessResolver {
  /** Read permission on the linked entity that grants reading the attachment. */
  permission: string;
  scope: (ctx: QueryContext, entityId: string) => Promise<LinkTargetScope | null>;
  /**
   * Optional custom read rule for entities whose audience is not a plain scope check (e.g.
   * workspace-wide knowledge articles readable by every member holding knowledge.read). When
   * present it replaces `allowed(permission, scope)`.
   */
  readable?: (ctx: QueryContext, entityId: string, scope: LinkTargetScope) => Promise<boolean> | boolean;
}

export const LINK_ACCESS = new Map<string, LinkAccessResolver>();
export const defineLinkAccess = (entityType: string, r: LinkAccessResolver) => {
  LINK_ACCESS.set(entityType, r);
};

/**
 * Resolve a link target for the actor: its scope (label/href/project) when the actor can read the
 * entity, otherwise null (callers answer 404 — existence is never revealed).
 */
export const resolveLinkTarget = async (ctx: QueryContext, entityType: string, entityId: string): Promise<LinkTargetScope | null> => {
  const r = LINK_ACCESS.get(entityType);
  if (!r) return null;
  const scope = await r.scope(ctx, entityId);
  if (!scope) return null;
  const ok = r.readable ? await r.readable(ctx, entityId, scope) : allowed(ctx, r.permission, scope);
  return ok ? scope : null;
};
