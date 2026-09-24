import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { listFilter } from '@castlane/authorization';
import { projects, referenceLinks, references } from '@castlane/database';
import { AppError, isSafeUrl, REFERENCE_TAGS } from '@castlane/domain';
import { audit } from '../core/audit';
import { dbOf, type CommandContext } from '../core/context';
import { emit } from '../core/events';
import { defineExportDataset } from '../core/export-registry';
import { defineImportDataset, type ImportIssue } from '../core/import-registry';
import { loadMemberRefs } from '../core/members';
import { removeSearchDocument } from '../core/search';
import { asList, asText, resolveProjectRef } from '../accounts/datasets';
import { createReference, loadReference, updateReference } from './references';

type Tag = (typeof REFERENCE_TAGS)[number];

interface ReferenceImportRow {
  title: string;
  sourceUrl: string;
  whatToReuse: string;
  notes: string | null;
  tags: Tag[];
  projectId: string | null;
}

/**
 * Import Center dataset "references": links only (files go through the Library uploader). A row is a
 * duplicate when a non-archived reference in the same project (or workspace-wide) has the same link.
 */
defineImportDataset<ReferenceImportRow>({
  key: 'references',
  label: 'References',
  permission: 'references.write',
  duplicatePolicies: ['skip', 'revise_existing', 'error'],
  columns: [
    { key: 'title', label: 'Title', type: 'text', required: true, aliases: ['name'] },
    { key: 'source_url', label: 'Source URL', type: 'url', required: true, aliases: ['url', 'link'] },
    { key: 'what_to_reuse', label: 'What to Reuse', type: 'long_text', required: true, aliases: ['reuse', 'why'] },
    { key: 'notes', label: 'Notes', type: 'long_text' },
    { key: 'tags', label: 'Tags', type: 'tags', description: `Any of: ${REFERENCE_TAGS.join(', ')}.` },
    { key: 'project', label: 'Project', type: 'reference', description: 'Project id or exact name; empty = workspace-wide.' },
  ],
  async validate(ctx, row, opts) {
    const errors: ImportIssue[] = [];
    const warnings: ImportIssue[] = [];
    const title = asText(row.title);
    if (!title || title.length < 2 || title.length > 120) errors.push({ field: 'title', code: 'INVALID', message: 'Title must be 2–120 characters.' });
    const url = asText(row.source_url);
    if (!url || !isSafeUrl(url)) errors.push({ field: 'source_url', code: 'INVALID_URL', message: 'Enter a valid http(s) link.' });
    const reuse = asText(row.what_to_reuse);
    if (!reuse || reuse.length < 3) errors.push({ field: 'what_to_reuse', code: 'REQUIRED', message: 'Describe what to reuse (at least 3 characters).' });
    const rawTags = asList(row.tags).map((t) => t.toLowerCase());
    const unknown = rawTags.filter((t) => !(REFERENCE_TAGS as readonly string[]).includes(t));
    if (unknown.length) errors.push({ field: 'tags', code: 'INVALID', message: `Unknown tags: ${unknown.join(', ')}.` });
    let projectId: string | null = null;
    if (asText(row.project)) {
      const p = await resolveProjectRef(ctx, row.project, 'references.write');
      if (p.error) errors.push(p.error);
      else projectId = p.id ?? null;
    }
    const normalized: ReferenceImportRow = {
      title: title ?? '',
      sourceUrl: url ?? '',
      whatToReuse: reuse ?? '',
      notes: asText(row.notes),
      tags: [...new Set(rawTags.filter((t): t is Tag => (REFERENCE_TAGS as readonly string[]).includes(t)))],
      projectId,
    };
    const dedupeKey = `${projectId ?? 'workspace'}|${url ?? ''}`;
    if (errors.length) return { action: 'create', normalized, errors, warnings, dedupeKey };
    const [existing] = await dbOf(ctx)
      .select()
      .from(references)
      .where(
        and(
          eq(references.workspaceId, ctx.actor.workspaceId),
          eq(references.sourceUrl, url!),
          projectId ? eq(references.projectId, projectId) : isNull(references.projectId),
          isNull(references.archivedAt),
        ),
      );
    if (!existing) return { action: 'create', normalized, errors, warnings, dedupeKey };
    if (opts.duplicatePolicy === 'skip') {
      warnings.push({ field: 'source_url', code: 'DUPLICATE', message: 'A reference with this link already exists; the row is skipped.' });
      return { action: 'skip', normalized, errors, warnings, dedupeKey, targetId: existing.id };
    }
    if (opts.duplicatePolicy === 'error') {
      errors.push({ field: 'source_url', code: 'DUPLICATE', message: 'A reference with this link already exists.' });
      return { action: 'create', normalized, errors, warnings, dedupeKey };
    }
    return { action: 'update', normalized, errors, warnings, dedupeKey, targetId: existing.id, targetRowVersion: existing.rowVersion };
  },
  async apply(ctx, row, v) {
    const c: CommandContext = { ...ctx, request: { ...ctx.request, source: 'import' } };
    if (v.action === 'update' && v.targetId) {
      await updateReference({ ...c, request: { ...c.request, expectedVersion: v.targetRowVersion } }, v.targetId, {
        title: row.title,
        whatToReuse: row.whatToReuse,
        notes: row.notes ?? undefined,
        tags: row.tags.length ? row.tags : undefined,
      });
      return v.targetId;
    }
    return createReference(c, { title: row.title, sourceUrl: row.sourceUrl, whatToReuse: row.whatToReuse, notes: row.notes, tags: row.tags, projectId: row.projectId });
  },
  async undo(ctx, entityId) {
    const r = await loadReference(ctx, entityId, { lock: true });
    const [{ n } = { n: 0 }] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(referenceLinks).where(eq(referenceLinks.referenceId, r.id));
    const obstacles: string[] = [];
    if (r.rowVersion > 1) obstacles.push('The reference was edited after the import.');
    if (Number(n) > 0) obstacles.push('The reference is linked to projects, characters or content.');
    if (obstacles.length) throw new AppError('INVALID_STATE', 'This reference can no longer be removed automatically.', { details: { obstacles } });
    // An untouched, unlinked imported note is removed completely (nothing references it).
    await ctx.tx.delete(references).where(eq(references.id, r.id));
    await removeSearchDocument(ctx.tx, r.workspaceId, 'reference', r.id);
    await audit(ctx, { action: 'reference.import_undone', entityType: 'reference', entityId: r.id, projectId: r.projectId });
    await emit(ctx, { type: 'reference.deleted', entityType: 'reference', entityId: r.id });
  },
});

defineExportDataset({
  key: 'references',
  label: 'References',
  permission: 'references.read',
  classification: 'normal',
  columns: [
    { key: 'id', label: 'Reference ID', type: 'id', default: true },
    { key: 'title', label: 'Title', type: 'text', default: true },
    { key: 'source_url', label: 'Source URL', type: 'text', default: true },
    { key: 'what_to_reuse', label: 'What to Reuse', type: 'text', default: true },
    { key: 'notes', label: 'Notes', type: 'text' },
    { key: 'tags', label: 'Tags', type: 'text', default: true },
    { key: 'project_id', label: 'Project ID', type: 'id' },
    { key: 'project_name', label: 'Project', type: 'text', default: true },
    { key: 'author', label: 'Author', type: 'text', default: true },
    { key: 'created_at', label: 'Created At', type: 'datetime', default: true },
    { key: 'archived_at', label: 'Archived At', type: 'datetime' },
  ],
  filters: [
    { key: 'projectId', label: 'Project', type: 'reference', lookup: 'project' },
    { key: 'tag', label: 'Tag', type: 'enum', enumValues: REFERENCE_TAGS },
  ],
  async *rows(ctx, input) {
    const f = input.filters as { projectId?: string; tag?: string | string[]; includeArchived?: boolean };
    const tags = asList(f.tag);
    const lf = listFilter(ctx.actor.access, 'references.read');
    if (lf.kind === 'none') return;
    const visibility =
      lf.kind === 'all'
        ? undefined
        : or(isNull(references.projectId), eq(references.ownerMembershipId, ctx.actor.membershipId ?? '00000000-0000-4000-8000-000000000000'), lf.projectIds.length ? inArray(references.projectId, lf.projectIds) : undefined);
    let cursor: { createdAt: Date; id: string } | null = null;
    for (;;) {
      const page: (typeof references.$inferSelect)[] = await ctx.app.db
        .select()
        .from(references)
        .where(
          and(
            eq(references.workspaceId, ctx.actor.workspaceId),
            visibility,
            lte(references.createdAt, input.boundAt),
            f.projectId ? eq(references.projectId, f.projectId) : undefined,
            tags.length ? sql`${references.tags} && ${sql`ARRAY[${sql.join(tags.map((t) => sql`${t}`), sql`, `)}]::text[]`}` : undefined,
            f.includeArchived ? undefined : isNull(references.archivedAt),
            cursor ? sql`(${references.createdAt}, ${references.id}) > (${cursor.createdAt}, ${cursor.id}::uuid)` : undefined,
          ),
        )
        .orderBy(asc(references.createdAt), asc(references.id))
        .limit(500);
      if (!page.length) return;
      const refs = await loadMemberRefs(ctx.app.db, ctx.actor.workspaceId, page.map((r) => r.ownerMembershipId));
      const pids = [...new Set(page.map((r) => r.projectId).filter((x): x is string => !!x))];
      const names = new Map(pids.length ? (await ctx.app.db.select({ id: projects.id, name: projects.name }).from(projects).where(inArray(projects.id, pids))).map((p) => [p.id, p.name]) : []);
      for (const r of page)
        yield {
          id: r.id,
          title: r.title,
          source_url: r.sourceUrl,
          what_to_reuse: r.whatToReuse,
          notes: r.notes,
          tags: r.tags.join(', '),
          project_id: r.projectId,
          project_name: r.projectId ? (names.get(r.projectId) ?? null) : null,
          author: refs.get(r.ownerMembershipId)?.displayName ?? null,
          created_at: r.createdAt.toISOString(),
          archived_at: r.archivedAt?.toISOString() ?? null,
        };
      const last = page[page.length - 1]!;
      cursor = { createdAt: last.createdAt, id: last.id };
      if (page.length < 500) return;
    }
  },
});
