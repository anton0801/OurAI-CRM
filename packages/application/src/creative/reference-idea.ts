import { contentItems, references } from '@castlane/database';
import type { CommandContext } from '../core/context';
import { createContent } from '../production/content';

type ContentFormat = (typeof contentItems.$inferSelect)['format'];

/**
 * Create the content draft (stage Idea) for "Use as Idea" (S21 → S23, T035) through the content
 * module's create use case: project access and content.create are checked there, the draft is
 * owned by the member, indexed, audited and gets its first stage event. The reference link
 * (kind 'idea') is written by the caller.
 */
export const createIdeaDraftFromReference = async (
  ctx: CommandContext,
  reference: typeof references.$inferSelect,
  input: { projectId: string; format: ContentFormat; title?: string },
): Promise<string> =>
  createContent(
    ctx,
    {
      projectId: input.projectId,
      title: (input.title ?? reference.title).trim(),
      format: input.format,
      brief: {
        notes: [`Reference: ${reference.title}`, `What to reuse: ${reference.whatToReuse}`, reference.sourceUrl ? `Source: ${reference.sourceUrl}` : null].filter(Boolean).join('\n'),
      },
    },
    { originReferenceId: reference.id },
  );
