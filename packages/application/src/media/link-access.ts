import type { ObjectScope } from '@castlane/authorization';
import type { QueryContext } from '../core/context';

/**
 * How to authorise access to an asset through an entity it is linked to (e.g. a contractor may
 * see a task attachment without reading the whole project). Modules register resolvers for
 * their entity types; unknown types grant nothing.
 */
export interface LinkAccessResolver {
  /** Read permission on the linked entity that grants reading the attachment. */
  permission: string;
  scope: (ctx: QueryContext, entityId: string) => Promise<(ObjectScope & { label?: string | null; href?: string | null }) | null>;
}

export const LINK_ACCESS = new Map<string, LinkAccessResolver>();
export const defineLinkAccess = (entityType: string, r: LinkAccessResolver) => {
  LINK_ACCESS.set(entityType, r);
};
