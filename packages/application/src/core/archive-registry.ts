import type { ImpactItem } from '@castlane/api-contracts';
import type { CommandContext, QueryContext } from './context';

/**
 * Archive / trash / restore behaviour per entity type. Modules register handlers; the generic
 * `/entities/*` endpoints (Archive screen, bulk actions) delegate to them. Archive never deletes
 * history; trash applies only to eligible drafts; purge is Owner-only and asynchronous.
 */
export interface ArchiveHandler {
  entityType: string;
  label: string;
  /** Open obligations and effects; blocking items prevent archiving until resolved. */
  preview(ctx: QueryContext, id: string): Promise<{ title: string; rowVersion: number; items: ImpactItem[] }>;
  archive(ctx: CommandContext, id: string, input: { reason?: string; resolutions?: Record<string, string> }): Promise<void>;
  restorePreview?(ctx: QueryContext, id: string): Promise<{ title: string; items: ImpactItem[] }>;
  restore?(ctx: CommandContext, id: string, input: { resolutions?: Record<string, string> }): Promise<void>;
  /** Only drafts that nothing depends on may go to trash. */
  trash?(ctx: CommandContext, id: string, reason: string): Promise<void>;
  purge?(ctx: CommandContext, id: string): Promise<void>;
}

export const ARCHIVE_HANDLERS = new Map<string, ArchiveHandler>();
export const defineArchiveHandler = (h: ArchiveHandler) => {
  ARCHIVE_HANDLERS.set(h.entityType, h);
};
