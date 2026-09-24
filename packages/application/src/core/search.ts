import { and, eq, sql } from 'drizzle-orm';
import { searchDocuments, type DbOrTx } from '@castlane/database';

export interface SearchDocumentInput {
  workspaceId: string;
  entityType: string;
  entityId: string;
  title: string;
  body?: string;
  projectId?: string | null;
  accountId?: string | null;
  directionId?: string | null;
  /** Read permission that governs visibility (checked with the object's scope at query time). */
  permission: string;
  ownerMembershipId?: string | null;
  assigneeMembershipIds?: string[];
  restricted?: boolean;
  archived?: boolean;
  status?: string | null;
  thumbnailAssetId?: string | null;
  at: Date;
}

/** Upsert the search projection of an entity in the same transaction as the change. */
export const indexSearchDocument = async (db: DbOrTx, d: SearchDocumentInput): Promise<void> => {
  const values = {
    workspaceId: d.workspaceId,
    entityType: d.entityType,
    entityId: d.entityId,
    title: d.title.slice(0, 500),
    body: (d.body ?? '').slice(0, 20_000),
    projectId: d.projectId ?? null,
    accountId: d.accountId ?? null,
    directionId: d.directionId ?? null,
    permission: d.permission,
    ownerMembershipId: d.ownerMembershipId ?? null,
    assigneeMembershipIds: d.assigneeMembershipIds ?? [],
    restricted: d.restricted ?? false,
    archived: d.archived ?? false,
    status: d.status ?? null,
    thumbnailAssetId: d.thumbnailAssetId ?? null,
    updatedAt: d.at,
  };
  await db
    .insert(searchDocuments)
    .values(values)
    .onConflictDoUpdate({
      target: [searchDocuments.workspaceId, searchDocuments.entityType, searchDocuments.entityId],
      set: { ...values, updatedAt: sql`excluded.updated_at` },
    });
};

export const removeSearchDocument = async (db: DbOrTx, workspaceId: string, entityType: string, entityId: string) => {
  await db
    .delete(searchDocuments)
    .where(
      and(eq(searchDocuments.workspaceId, workspaceId), eq(searchDocuments.entityType, entityType), eq(searchDocuments.entityId, entityId)),
    );
};
