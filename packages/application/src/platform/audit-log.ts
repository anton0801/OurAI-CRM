import { and, desc, eq, gt, gte, inArray, isNotNull, like, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import { entityHref } from '@castlane/api-contracts';
import { can } from '@castlane/authorization';
import { auditEvents } from '@castlane/database';
import { clampPageSize, decodeCursor, encodeCursor, notFound } from '@castlane/domain';
import { requirePermission, scopePredicate } from '../core/access';
import type { QueryContext } from '../core/context';
import { dbOf } from '../core/context';
import { defineExportDataset } from '../core/export-registry';
import { loadMemberRefs } from '../core/members';

type AuditRow = typeof auditEvents.$inferSelect;

export interface AuditFilter {
  actorMembershipId?: string;
  action?: string;
  entityType?: string;
  entityId?: string;
  projectId?: string;
  from?: string;
  to?: string;
  source?: AuditRow['source'][];
}

/** Permission needed to see the values of a sensitive event (the event itself stays visible, masked). */
const SENSITIVE_VALUE_PERMISSION: Record<AuditRow['sensitivity'], string | null> = {
  normal: null,
  finance: 'finance.read',
  ofm: 'contacts.read',
  security: 'access.read',
};

/**
 * Audit scope: `audit.read` in SQL (workspace grants see everything in the workspace; project-scoped
 * grants see the events of those projects only), applied before pagination.
 */
const auditWhere = (ctx: QueryContext, f: AuditFilter, permission = 'audit.read'): SQL =>
  and(
    eq(auditEvents.workspaceId, ctx.actor.workspaceId),
    scopePredicate(ctx, permission, { projectId: auditEvents.projectId }),
    f.actorMembershipId ? eq(auditEvents.actorMembershipId, f.actorMembershipId) : undefined,
    f.action ? (f.action.endsWith('.') ? like(auditEvents.action, `${f.action.replace(/[%_\\]/g, (m) => `\\${m}`)}%`) : eq(auditEvents.action, f.action)) : undefined,
    f.entityType ? eq(auditEvents.entityType, f.entityType) : undefined,
    f.entityId ? eq(auditEvents.entityId, f.entityId) : undefined,
    f.projectId ? eq(auditEvents.projectId, f.projectId) : undefined,
    f.from ? gte(auditEvents.occurredAt, new Date(f.from)) : undefined,
    f.to ? lt(auditEvents.occurredAt, new Date(f.to)) : undefined,
    f.source?.length ? inArray(auditEvents.source, f.source) : undefined,
  )!;

const valuesVisible = (ctx: QueryContext, r: AuditRow): boolean => {
  const p = SENSITIVE_VALUE_PERMISSION[r.sensitivity];
  return !p || can(ctx.actor.access, p, { projectId: r.projectId });
};

/**
 * Serialise audit rows for a viewer. Viewing the audit log never grants access to all fields of
 * the source object: values of finance/OFM/security events are hidden unless the viewer holds the
 * corresponding permission; secrets were never written in the first place.
 */
export const toAuditItems = async (ctx: QueryContext, rows: AuditRow[]) => {
  const refs = await loadMemberRefs(dbOf(ctx), ctx.actor.workspaceId, rows.map((r) => r.actorMembershipId));
  return rows.map((r) => {
    const visible = valuesVisible(ctx, r);
    const member = r.actorMembershipId ? refs.get(r.actorMembershipId) : undefined;
    return {
      id: r.id,
      occurredAt: r.occurredAt.toISOString(),
      actor: {
        kind: r.actorKind,
        membershipId: r.actorMembershipId,
        displayName: member?.displayName ?? r.actorDisplay ?? (r.actorKind === 'system' ? 'System' : r.actorKind === 'automation' ? 'Automation' : r.actorKind === 'import' ? 'Import' : 'Unknown'),
        avatarUrl: member?.avatarUrl ?? null,
      },
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      projectId: r.projectId,
      href: r.entityType && r.entityId ? entityHref(ctx.actor.workspaceId, r.entityType, r.entityId, { projectId: r.projectId }) : null,
      requestId: r.requestId,
      source: r.source,
      reason: visible ? r.reason : r.reason ? '[hidden]' : null,
      sensitivity: r.sensitivity,
      masked: !visible,
      changes: Object.entries(r.diff ?? {}).map(([field, v]) => (visible ? { field, from: v.from, to: v.to } : { field, from: '[hidden]', to: '[hidden]' })),
      metadata: visible ? (r.metadata ?? null) : null,
    };
  });
};

export const listAuditEvents = async (ctx: QueryContext, input: AuditFilter & { cursor?: string; pageSize?: number }) => {
  requirePermission(ctx, 'audit.read');
  const size = clampPageSize(input.pageSize);
  const c = input.cursor ? decodeCursor(input.cursor) : null;
  const rows = await ctx.app.db
    .select()
    .from(auditEvents)
    .where(
      and(
        auditWhere(ctx, input),
        c ? or(lt(auditEvents.occurredAt, new Date(String(c.v[0]))), and(eq(auditEvents.occurredAt, new Date(String(c.v[0]))), lt(auditEvents.id, c.id))) : undefined,
      ),
    )
    .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
    .limit(size + 1);
  const hasMore = rows.length > size;
  const pageRows = hasMore ? rows.slice(0, size) : rows;
  const last = pageRows[pageRows.length - 1];
  return { items: await toAuditItems(ctx, pageRows), hasMore, nextCursor: hasMore && last ? encodeCursor({ v: [last.occurredAt.toISOString()], id: last.id }) : null };
};

export const getAuditEvent = async (ctx: QueryContext, id: string) => {
  requirePermission(ctx, 'audit.read');
  const [r] = await ctx.app.db.select().from(auditEvents).where(and(auditWhere(ctx, {}), eq(auditEvents.id, id)));
  if (!r) throw notFound('Audit event');
  return (await toAuditItems(ctx, [r]))[0]!;
};

/** Distinct action names and entity types within the viewer's scope (last 180 days) for filters. */
export const auditFacets = async (ctx: QueryContext) => {
  requirePermission(ctx, 'audit.read');
  const since = new Date(ctx.app.clock.now().getTime() - 180 * 86_400_000);
  const where = and(auditWhere(ctx, {}), gt(auditEvents.occurredAt, since));
  const [actions, types] = await Promise.all([
    ctx.app.db.selectDistinct({ v: auditEvents.action }).from(auditEvents).where(where).orderBy(auditEvents.action).limit(300),
    ctx.app.db.selectDistinct({ v: auditEvents.entityType }).from(auditEvents).where(and(where, isNotNull(auditEvents.entityType))).orderBy(auditEvents.entityType).limit(100),
  ]);
  return { actions: actions.map((a) => a.v), entityTypes: types.map((t) => t.v!).filter(Boolean) };
};

// ——— Export dataset: audit events (Export Permitted Events) ———

defineExportDataset({
  key: 'audit_events',
  label: 'Audit events',
  permission: 'audit.export',
  classification: 'private',
  columns: [
    { key: 'occurredAt', label: 'Occurred At (UTC)', type: 'datetime', default: true },
    { key: 'eventId', label: 'Event ID', type: 'id', default: true },
    { key: 'actor', label: 'Actor', type: 'text', default: true },
    { key: 'action', label: 'Action', type: 'text', default: true },
    { key: 'entityType', label: 'Entity Type', type: 'text', default: true },
    { key: 'entityId', label: 'Entity ID', type: 'id', default: true },
    { key: 'projectId', label: 'Project ID', type: 'id' },
    { key: 'source', label: 'Source', type: 'text', default: true },
    { key: 'reason', label: 'Reason', type: 'text', default: true },
    { key: 'changes', label: 'Changes', type: 'text', default: true },
    { key: 'requestId', label: 'Request ID', type: 'text' },
    { key: 'sensitivity', label: 'Sensitivity', type: 'text' },
  ],
  filters: [
    { key: 'action', label: 'Action', type: 'text' },
    { key: 'entityType', label: 'Entity type', type: 'text' },
    { key: 'projectId', label: 'Project', type: 'reference', lookup: 'project' },
    { key: 'from', label: 'From', type: 'date' },
    { key: 'to', label: 'To', type: 'date' },
  ],
  async *rows(ctx, input) {
    // Audit read scope applies to exports as well (export needs audit.read and audit.export).
    const f = input.filters as Record<string, string | undefined>;
    const filter: AuditFilter = {
      action: f.action || undefined,
      entityType: f.entityType || undefined,
      entityId: f.entityId || undefined,
      projectId: f.projectId || undefined,
      actorMembershipId: f.actorMembershipId || undefined,
      from: f.from ? new Date(f.from).toISOString() : undefined,
      to: f.to ? new Date(f.to).toISOString() : undefined,
    };
    let before: { at: Date; id: string } | null = null;
    for (;;) {
      const rows: AuditRow[] = await ctx.app.db
        .select()
        .from(auditEvents)
        .where(
          and(
            auditWhere(ctx, filter),
            lte(auditEvents.occurredAt, input.boundAt),
            before ? or(lt(auditEvents.occurredAt, before.at), and(eq(auditEvents.occurredAt, before.at), lt(auditEvents.id, before.id))) : undefined,
          ),
        )
        .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
        .limit(500);
      if (rows.length === 0) return;
      const items = await toAuditItems(ctx, rows);
      for (const it of items)
        yield {
          occurredAt: it.occurredAt,
          eventId: it.id,
          actor: it.actor.displayName,
          action: it.action,
          entityType: it.entityType,
          entityId: it.entityId,
          projectId: it.projectId,
          source: it.source,
          reason: it.reason,
          changes: it.changes.length ? it.changes.map((c) => `${c.field}: ${JSON.stringify(c.from ?? null)} → ${JSON.stringify(c.to ?? null)}`).join('; ') : null,
          requestId: it.requestId,
          sensitivity: it.sensitivity,
        };
      const last: AuditRow = rows[rows.length - 1]!;
      before = { at: last.occurredAt, id: last.id };
      if (rows.length < 500) return;
    }
  },
});

void sql;
