import { AppError } from '@castlane/domain';
import type { LookupItem, LookupType } from '@castlane/api-contracts';
import type { QueryContext } from './context';

export interface LookupInput {
  q?: string;
  /** Resolve these ids (used to show labels of already-selected values). Out-of-scope ids are omitted. */
  ids?: string[];
  projectId?: string;
  accountId?: string;
  directionId?: string;
  /** Type-specific parent (season for episodes, folder for assets, …). */
  parentId?: string;
  status?: string[];
  includeArchived?: boolean;
  limit: number;
}

/**
 * Picker data for one entity type (`EntitySelect` in the UI). The provider must apply the same
 * permission scope as the module list (`scopePredicate`) and throw 403 via `requirePermission` when
 * the member holds the read permission nowhere. Results are sorted by relevance/name.
 */
export interface LookupProvider {
  type: LookupType;
  search(ctx: QueryContext, input: LookupInput): Promise<LookupItem[]>;
}

export const LOOKUP_PROVIDERS = new Map<LookupType, LookupProvider>();

export const defineLookup = (p: LookupProvider) => {
  LOOKUP_PROVIDERS.set(p.type, p);
};

export const runLookup = async (ctx: QueryContext, type: LookupType, input: LookupInput) => {
  const p = LOOKUP_PROVIDERS.get(type);
  if (!p) throw new AppError('NOT_FOUND', 'This picker is not available.');
  return { items: await p.search(ctx, input) };
};

/** `ILIKE` pattern for a user query with LIKE wildcards neutralised. */
export const likePattern = (q: string) => `%${q.trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
