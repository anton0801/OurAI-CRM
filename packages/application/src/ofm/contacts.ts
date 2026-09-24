import { and, desc, eq, ilike, inArray, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import {
  erasureRequests,
  interactionLogs,
  ofmContactRelations,
  ofmContacts,
  operations,
  saleCandidates,
  shiftAccounts,
  shifts,
} from '@castlane/database';
import { AppError, CONTACT_STAGE_TRANSITIONS, CONTACT_STAGES, assertTransition, formatMinor, newId, notFound } from '@castlane/domain';
import { allowed, requirePermission } from '../core/access';
import { audit, diffFields } from '../core/audit';
import { all, dbOf, type CommandContext, type QueryContext } from '../core/context';
import { emit } from '../core/events';
import { enqueueJob } from '../core/jobs';
import { likePattern } from '../core/lookup-registry';
import { loadMemberRefs, refOrUnknown } from '../core/members';
import { notify } from '../core/notify';
import { assertVersion, lockById, stamp, touch } from '../core/rows';
import { indexSearchDocument } from '../core/search';
import { defineTombstoneReplay, recordTombstone } from '../platform/tombstones';
import {
  accountRefOr,
  assertAccountOpen,
  assertActiveMember,
  assertNoForbiddenContent,
  exprKeyset,
  fieldErr,
  invalid,
  loadAccountInfos,
  loadProfiles,
  loadProjectInfos,
  me,
  projectRefOr,
  requireOfmAccount,
  resolveSettings,
  signToken,
  verifyToken,
  workspaceInfo,
  type Ctx,
} from './common';
import {
  canReadContact,
  canReadShift,
  contactRefs,
  contactScope,
  contactVisibility,
  operationScope,
  operationSummaries,
  saleViews,
  canReadSale,
  type ContactRow,
} from './views';

/**
 * OFM contacts (S45/S46, §13.4): a manual work log per platform account — never a platform inbox.
 * Unique per account + external identifier (the same alias on two accounts is two contacts, T095).
 * Aliases and notes are sensitive: they never enter notifications, search snippets, logs or audit diffs.
 */

type Stage = (typeof CONTACT_STAGES)[number];
const MASKED = ['alias', 'externalIdentifier', 'businessNotes'];
const DEFAULT_RETENTION_DAYS = 180;

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

const indexContact = (ctx: CommandContext, c: ContactRow) =>
  // Only the alias is indexed (contacts are a separate permission-gated dataset; notes never indexed).
  indexSearchDocument(ctx.tx, {
    workspaceId: ctx.actor.workspaceId,
    entityType: 'ofm_contact',
    entityId: c.id,
    title: c.alias,
    body: '',
    projectId: c.projectId,
    accountId: c.accountId,
    permission: 'contacts.read',
    ownerMembershipId: c.managerMembershipId,
    restricted: true,
    archived: !!c.archivedAt,
    status: c.stage,
    at: ctx.app.clock.now(),
  });

/** Confirmed spend per contact: posted finance linked through verified candidates (finance.read only). */
const confirmedSpend = async (ctx: Ctx, ids: string[]) => {
  const out = new Map<string, { amount: string; currency: string }[]>();
  if (!ids.length) return out;
  const res = await dbOf(ctx).execute<{ contact_id: string; currency: string; total: string }>(sql`
    SELECT sc.contact_id, l.currency, SUM(
      (CASE WHEN l.accounting_class = 'revenue' THEN 1 WHEN l.accounting_class IN ('contra_revenue', 'fee') THEN -1 ELSE 0 END)
      * (CASE WHEN l.is_reversal THEN -1 ELSE 1 END) * l.amount_minor)::text AS total
    FROM financial_entry_lines l
    JOIN financial_entries e ON e.id = l.entry_id
    JOIN sale_candidates sc ON sc.id = COALESCE(e.sale_candidate_id, (SELECT e2.sale_candidate_id FROM financial_entries e2 WHERE e2.id = e.reverses_entry_id))
    WHERE e.workspace_id = ${ctx.actor.workspaceId} AND e.state = 'posted'
      AND sc.contact_id IN (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})
    GROUP BY sc.contact_id, l.currency`);
  for (const r of res.rows) out.set(r.contact_id, [...(out.get(r.contact_id) ?? []), { amount: formatMinor(BigInt(r.total), r.currency), currency: r.currency }]);
  return out;
};

export const contactSummaries = async (ctx: Ctx, rows: ContactRow[]) => {
  if (!rows.length) return [];
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const [accounts, projects, refs, profiles, wsInfo] = await all(ctx, [
    () => loadAccountInfos(db, ws, rows.map((r) => r.accountId)),
    () => loadProjectInfos(db, ws, rows.map((r) => r.projectId)),
    () => loadMemberRefs(db, ws, rows.map((r) => r.managerMembershipId)),
    () => loadProfiles(db, ws, rows.map((r) => r.projectId)),
    () => workspaceInfo(db, ws),
  ] as const);
  const financeIds = rows.filter((r) => allowed(ctx, 'finance.read', { projectId: r.projectId })).map((r) => r.id);
  const spend = await confirmedSpend(ctx, financeIds);
  return rows.map((c) => {
    const labels = resolveSettings(profiles.get(c.projectId)?.settings, wsInfo.settings.maxShiftAccounts).contactStageLabels;
    return {
      id: c.id,
      account: accountRefOr(accounts, c.accountId, c.projectId),
      project: projectRefOr(projects, c.projectId),
      externalIdentifier: c.externalIdentifier,
      alias: c.alias,
      manager: refOrUnknown(refs, c.managerMembershipId),
      stage: c.stage,
      stageLabel: labels[c.stage],
      lastActivityAt: iso(c.lastActivityAt),
      nextFollowUpAt: iso(c.nextFollowUpAt),
      restricted: c.restricted,
      archivedAt: iso(c.archivedAt),
      mergedIntoId: c.mergedIntoId,
      erasedAt: iso(c.erasedAt),
      ...(financeIds.includes(c.id) ? { confirmedSpend: spend.get(c.id) ?? [] } : {}),
      updatedAt: c.updatedAt.toISOString(),
      rowVersion: c.rowVersion,
    };
  });
};

export interface ListContactsInput {
  cursor?: string;
  pageSize?: number;
  q?: string;
  accountId?: string;
  projectId?: string;
  stage?: Stage[];
  managerMembershipId?: string;
  followUp?: 'due' | 'overdue' | 'none';
  includeArchived?: boolean;
  sort: 'lastActivityAt' | 'nextFollowUpAt' | 'alias' | 'updatedAt';
  direction: 'asc' | 'desc';
}

export const listContacts = async (ctx: QueryContext, input: ListContactsInput) => {
  requirePermission(ctx, 'contacts.read');
  const now = ctx.app.clock.now();
  const endOfDay = new Date(now.getTime() + 24 * 3_600_000);
  const sortExpr: SQL | typeof ofmContacts.alias =
    input.sort === 'alias'
      ? ofmContacts.alias
      : input.sort === 'lastActivityAt'
        ? sql`COALESCE(${ofmContacts.lastActivityAt}, 'epoch'::timestamptz)`
        : input.sort === 'nextFollowUpAt'
          ? sql`COALESCE(${ofmContacts.nextFollowUpAt}, 'infinity'::timestamptz)`
          : sql`${ofmContacts.updatedAt}`;
  const kind = input.sort === 'alias' ? 'text' : 'timestamp';
  const k = exprKeyset(sortExpr, ofmContacts.id, kind, input.direction, input);
  const rows = await ctx.app.db
    .select()
    .from(ofmContacts)
    .where(
      and(
        eq(ofmContacts.workspaceId, ctx.actor.workspaceId),
        isNull(ofmContacts.mergedIntoId),
        contactVisibility(ctx),
        input.includeArchived ? undefined : isNull(ofmContacts.archivedAt),
        input.accountId ? eq(ofmContacts.accountId, input.accountId) : undefined,
        input.projectId ? eq(ofmContacts.projectId, input.projectId) : undefined,
        input.stage?.length ? inArray(ofmContacts.stage, input.stage) : undefined,
        input.managerMembershipId ? eq(ofmContacts.managerMembershipId, input.managerMembershipId) : undefined,
        input.followUp === 'overdue' ? lt(ofmContacts.nextFollowUpAt, now) : undefined,
        input.followUp === 'due' ? lt(ofmContacts.nextFollowUpAt, endOfDay) : undefined,
        input.followUp === 'none' ? isNull(ofmContacts.nextFollowUpAt) : undefined,
        // Restricted search: alias or exact-prefix identifier inside the visible scope only.
        input.q && input.q.length >= 2 ? or(ilike(ofmContacts.alias, likePattern(input.q)), ilike(ofmContacts.externalIdentifier, `${input.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`)) : undefined,
        k.where,
      ),
    )
    .orderBy(...k.orderBy)
    .limit(k.limit);
  const page = k.finish(
    rows,
    (r) => (input.sort === 'alias' ? r.alias : input.sort === 'lastActivityAt' ? (r.lastActivityAt ?? new Date(0)) : input.sort === 'nextFollowUpAt' ? (r.nextFollowUpAt ?? new Date(8.64e15)) : r.updatedAt),
    (r) => r.id,
  );
  return { ...page, items: await contactSummaries(ctx, page.items) };
};

const loadReadable = async (ctx: Ctx, id: string) => {
  const [c] = await dbOf(ctx).select().from(ofmContacts).where(and(eq(ofmContacts.workspaceId, ctx.actor.workspaceId), eq(ofmContacts.id, id)));
  if (!c || !canReadContact(ctx, c)) throw notFound('Contact');
  return c;
};

export const getContact = async (ctx: QueryContext | CommandContext, id: string) => {
  requirePermission(ctx, 'contacts.read');
  const c = await loadReadable(ctx, id);
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const scope = contactScope(c);
  const [summary] = await contactSummaries(ctx, [c]);
  const [ops, sales, relations, erasures, wsInfo] = await all(ctx, [
    () => db.select().from(operations).where(and(eq(operations.workspaceId, ws), eq(operations.contactId, id))).orderBy(desc(operations.createdAt)).limit(50),
    () => db.select().from(saleCandidates).where(and(eq(saleCandidates.workspaceId, ws), eq(saleCandidates.contactId, id))).orderBy(desc(saleCandidates.occurredAt)).limit(50),
    () =>
      db
        .select()
        .from(ofmContactRelations)
        .where(and(eq(ofmContactRelations.workspaceId, ws), or(eq(ofmContactRelations.contactAId, id), eq(ofmContactRelations.contactBId, id)))),
    () => db.select().from(erasureRequests).where(and(eq(erasureRequests.workspaceId, ws), eq(erasureRequests.entityType, 'ofm_contact'), eq(erasureRequests.entityId, id))).orderBy(desc(erasureRequests.createdAt)),
    () => workspaceInfo(db, ws),
  ] as const);
  const otherIds = relations.map((r) => (r.contactAId === id ? r.contactBId : r.contactAId));
  const [refs, others] = await all(ctx, [
    () => contactRefs(ctx, otherIds),
    () => (otherIds.length ? db.select().from(ofmContacts).where(inArray(ofmContacts.id, otherIds)) : Promise.resolve([] as ContactRow[])),
  ] as const);
  const otherAccounts = await loadAccountInfos(db, ws, others.map((o) => o.accountId));
  const retentionDays = wsInfo.settings.retention?.ofmArchivedNotesDays ?? DEFAULT_RETENTION_DAYS;
  const open = !c.archivedAt && !c.mergedIntoId && !c.erasedAt;
  const write = allowed(ctx, 'contacts.write', scope);
  const merge = allowed(ctx, 'contacts.merge', scope);
  const visibleSales = sales.filter((sc) => canReadSale(ctx, sc));
  return {
    ...summary!,
    businessNotes: c.businessNotes,
    operations: await operationSummaries(ctx, ops.filter((o) => allowed(ctx, 'operations.read', operationScope(o)))),
    ...(visibleSales.length || allowed(ctx, 'sale-candidates.write', scope) ? { saleCandidates: await saleViews(ctx, visibleSales) } : {}),
    relations: relations.map((r) => {
      const otherId = r.contactAId === id ? r.contactBId : r.contactAId;
      const o = others.find((x) => x.id === otherId);
      const ref = refs.get(otherId) ?? { id: otherId, restricted: true as const };
      return {
        id: r.id,
        contact: ref,
        account: o && !ref.restricted ? accountRefOr(otherAccounts, o.accountId, o.projectId) : null,
        reason: r.reason,
        createdAt: r.createdAt.toISOString(),
      };
    }),
    erasureRequests: erasures.map((e) => ({ id: e.id, state: e.state, reason: e.reason, createdAt: e.createdAt.toISOString(), completedAt: iso(e.completedAt), result: e.result })),
    retentionDeleteAfter: c.archivedAt ? new Date(c.archivedAt.getTime() + retentionDays * 86_400_000).toISOString() : null,
    permissions: {
      edit: open && write,
      changeStage: open && write,
      merge: open && merge,
      relate: open && allowed(ctx, 'contacts.relate', scope),
      erase: !c.erasedAt && allowed(ctx, 'contacts.erase', scope) && !erasures.some((e) => e.state === 'queued' || e.state === 'running'),
      archive: write && !c.mergedIntoId && !c.erasedAt,
      restrict: open && merge,
      logInteraction: open && write,
      createOperation: open && allowed(ctx, 'operations.write', scope),
      linkSale: open && allowed(ctx, 'sale-candidates.write', scope),
    },
  };
};

const authorizeContactWrite = (ctx: Ctx, c: ContactRow, permission = 'contacts.write') => {
  if (!canReadContact(ctx, c)) throw notFound('Contact');
  if (!allowed(ctx, permission, contactScope(c))) throw new AppError('FORBIDDEN', 'You cannot change this contact.');
};

const lockContact = async (ctx: CommandContext, id: string, permission = 'contacts.write') => {
  const c = await lockById(ctx, ofmContacts, id, 'Contact');
  authorizeContactWrite(ctx, c, permission);
  return c;
};

const assertOpen = (c: ContactRow) => {
  if (c.mergedIntoId) throw invalid('This contact was merged into another contact.', { mergedIntoId: c.mergedIntoId });
  if (c.erasedAt) throw invalid('This contact was erased.');
};

const notifyManager = (ctx: CommandContext, c: ContactRow, managerId: string | null) =>
  managerId
    ? notify(ctx.tx, {
        workspaceId: ctx.actor.workspaceId,
        recipientMembershipIds: [managerId],
        eventType: 'ofm_contact.assigned',
        eventKey: `ofm_contact.assigned:${c.id}:${managerId}:${c.rowVersion}`,
        kind: 'assignment',
        // Never the alias or notes (§20): only the fact.
        title: 'An OFM contact was assigned to you',
        sensitive: true,
        entityType: 'ofm_contact',
        entityId: c.id,
        projectId: c.projectId,
        actorMembershipId: ctx.actor.membershipId,
        at: ctx.app.clock.now(),
      })
    : Promise.resolve(0);

export const createContact = async (
  ctx: CommandContext,
  input: { accountId: string; externalIdentifier: string; alias: string; managerMembershipId?: string | null; stage: Exclude<Stage, 'archived'>; businessNotes?: string | null; nextFollowUpAt?: string | null; restricted?: boolean },
) => {
  const { account, project } = await requireOfmAccount(ctx, input.accountId);
  const scope = { projectId: project.id, accountId: account.id };
  if (!allowed(ctx, 'contacts.write', scope)) {
    if (allowed(ctx, 'contacts.read', scope) || allowed(ctx, 'ofm.overview.read', scope)) throw new AppError('FORBIDDEN', 'You cannot add contacts for this account.');
    throw notFound('Account');
  }
  assertAccountOpen(account);
  assertNoForbiddenContent('alias', input.alias);
  assertNoForbiddenContent('businessNotes', input.businessNotes);
  if (input.restricted && !allowed(ctx, 'contacts.merge', scope)) throw new AppError('FORBIDDEN', 'Restricting contacts needs the contacts merge permission.');
  if (input.managerMembershipId) await assertActiveMember(ctx, input.managerMembershipId, 'managerMembershipId');
  const externalIdentifier = input.externalIdentifier.trim();
  const [dup] = await ctx.tx
    .select()
    .from(ofmContacts)
    .where(and(eq(ofmContacts.workspaceId, ctx.actor.workspaceId), eq(ofmContacts.accountId, account.id), eq(ofmContacts.externalIdentifier, externalIdentifier)));
  if (dup)
    throw new AppError('DUPLICATE', 'A contact with this external identifier already exists on this account.', {
      fieldErrors: [{ field: 'externalIdentifier', code: 'DUPLICATE', message: 'This identifier is already registered for the account.' }],
      details: canReadContact(ctx, dup) ? { existingContactId: dup.id } : undefined,
    });
  const id = newId();
  const [row] = await ctx.tx
    .insert(ofmContacts)
    .values({
      ...stamp(ctx),
      id,
      accountId: account.id,
      projectId: project.id,
      externalIdentifier,
      alias: input.alias.trim(),
      managerMembershipId: input.managerMembershipId ?? null,
      stage: input.stage,
      businessNotes: input.businessNotes?.trim() || null,
      nextFollowUpAt: input.nextFollowUpAt ? new Date(input.nextFollowUpAt) : null,
      restricted: !!input.restricted,
    })
    .returning();
  await audit(ctx, {
    action: 'ofm_contact.created',
    entityType: 'ofm_contact',
    entityId: id,
    projectId: project.id,
    diff: diffFields(null, row!, ['accountId', 'alias', 'externalIdentifier', 'managerMembershipId', 'stage', 'businessNotes', 'restricted'], MASKED),
    sensitivity: 'ofm',
  });
  await emit(ctx, { type: 'ofm_contact.created', entityType: 'ofm_contact', entityId: id, revision: 1 });
  await indexContact(ctx, row!);
  if (row!.managerMembershipId && row!.managerMembershipId !== me(ctx)) await notifyManager(ctx, row!, row!.managerMembershipId);
  return id;
};

export const updateContact = async (
  ctx: CommandContext,
  id: string,
  input: { alias?: string; managerMembershipId?: string | null; businessNotes?: string | null; nextFollowUpAt?: string | null; restricted?: boolean },
) => {
  const c = await lockContact(ctx, id);
  assertVersion(ctx, c);
  assertOpen(c);
  if (c.archivedAt) throw invalid('Restore the contact before editing it.');
  if (input.alias !== undefined) assertNoForbiddenContent('alias', input.alias);
  if (input.businessNotes !== undefined) assertNoForbiddenContent('businessNotes', input.businessNotes);
  if (input.restricted !== undefined && input.restricted !== c.restricted && !allowed(ctx, 'contacts.merge', contactScope(c)))
    throw new AppError('FORBIDDEN', 'Restricting contacts needs the contacts merge permission.');
  if (input.managerMembershipId) await assertActiveMember(ctx, input.managerMembershipId, 'managerMembershipId');
  const [row] = await ctx.tx
    .update(ofmContacts)
    .set({
      alias: input.alias?.trim() ?? c.alias,
      managerMembershipId: input.managerMembershipId !== undefined ? input.managerMembershipId : c.managerMembershipId,
      businessNotes: input.businessNotes !== undefined ? input.businessNotes?.trim() || null : c.businessNotes,
      nextFollowUpAt: input.nextFollowUpAt !== undefined ? (input.nextFollowUpAt ? new Date(input.nextFollowUpAt) : null) : c.nextFollowUpAt,
      restricted: input.restricted ?? c.restricted,
      ...touch(ctx, ofmContacts),
    })
    .where(eq(ofmContacts.id, id))
    .returning();
  await audit(ctx, {
    action: 'ofm_contact.updated',
    entityType: 'ofm_contact',
    entityId: id,
    projectId: c.projectId,
    diff: diffFields(c, row!, ['alias', 'managerMembershipId', 'businessNotes', 'nextFollowUpAt', 'restricted'], MASKED),
    sensitivity: 'ofm',
  });
  await emit(ctx, { type: 'ofm_contact.updated', entityType: 'ofm_contact', entityId: id, revision: row!.rowVersion });
  await indexContact(ctx, row!);
  if (row!.managerMembershipId && row!.managerMembershipId !== c.managerMembershipId && row!.managerMembershipId !== me(ctx)) await notifyManager(ctx, row!, row!.managerMembershipId);
  return id;
};

export const changeContactStage = async (ctx: CommandContext, id: string, input: { stage: Exclude<Stage, 'archived'>; reason?: string }) => {
  const c = await lockContact(ctx, id);
  assertVersion(ctx, c);
  assertOpen(c);
  if (c.archivedAt) throw invalid('Restore the contact before changing its stage.');
  assertTransition(CONTACT_STAGE_TRANSITIONS, c.stage, input.stage, 'contact');
  const [row] = await ctx.tx.update(ofmContacts).set({ stage: input.stage, ...touch(ctx, ofmContacts) }).where(eq(ofmContacts.id, id)).returning();
  await audit(ctx, { action: 'ofm_contact.stage_changed', entityType: 'ofm_contact', entityId: id, projectId: c.projectId, reason: input.reason, diff: { stage: { from: c.stage, to: input.stage } }, sensitivity: 'ofm' });
  await emit(ctx, { type: 'ofm_contact.stage_changed', entityType: 'ofm_contact', entityId: id, revision: row!.rowVersion, payload: { from: c.stage, to: input.stage } });
  await indexContact(ctx, row!);
  return id;
};

export const archiveContactInternal = async (ctx: CommandContext, c: ContactRow, reason: string) => {
  if (c.archivedAt) throw invalid('This contact is already archived.');
  const now = ctx.app.clock.now();
  const [row] = await ctx.tx
    .update(ofmContacts)
    .set({ archivedAt: now, archivedBy: ctx.actor.userId, archiveReason: reason, stage: 'archived', ...touch(ctx, ofmContacts) })
    .where(eq(ofmContacts.id, c.id))
    .returning();
  await audit(ctx, { action: 'ofm_contact.archived', entityType: 'ofm_contact', entityId: c.id, projectId: c.projectId, reason, sensitivity: 'ofm' });
  await emit(ctx, { type: 'ofm_contact.archived', entityType: 'ofm_contact', entityId: c.id, revision: row!.rowVersion });
  await indexContact(ctx, row!);
};

export const archiveContact = async (ctx: CommandContext, id: string, input: { reason: string }) => {
  const c = await lockContact(ctx, id);
  assertVersion(ctx, c);
  if (c.mergedIntoId) throw invalid('Merged contacts are already archived.');
  await archiveContactInternal(ctx, c, input.reason);
  return id;
};

export const restoreContact = async (ctx: CommandContext, id: string, opts: { skipVersion?: boolean } = {}) => {
  const c = await lockContact(ctx, id);
  if (!opts.skipVersion) assertVersion(ctx, c);
  assertOpen(c);
  if (!c.archivedAt) throw invalid('This contact is not archived.');
  const [row] = await ctx.tx
    .update(ofmContacts)
    .set({ archivedAt: null, archivedBy: null, archiveReason: null, stage: 'inactive', ...touch(ctx, ofmContacts) })
    .where(eq(ofmContacts.id, id))
    .returning();
  await audit(ctx, { action: 'ofm_contact.restored', entityType: 'ofm_contact', entityId: id, projectId: c.projectId, sensitivity: 'ofm' });
  await emit(ctx, { type: 'ofm_contact.restored', entityType: 'ofm_contact', entityId: id, revision: row!.rowVersion });
  await indexContact(ctx, row!);
  return id;
};

// ——— Merge (T096) ———

const mergeCounts = async (ctx: Ctx, sourceId: string) => {
  const db = dbOf(ctx);
  const ws = ctx.actor.workspaceId;
  const c = (t: SQL) => db.execute<{ n: string }>(t).then((r) => Number(r.rows[0]?.n ?? 0));
  const [interactions, ops, sales, relations] = await all(ctx, [
    () => c(sql`SELECT count(*)::text AS n FROM interaction_logs WHERE workspace_id = ${ws} AND contact_id = ${sourceId}`),
    () => c(sql`SELECT count(*)::text AS n FROM operations WHERE workspace_id = ${ws} AND contact_id = ${sourceId}`),
    () => c(sql`SELECT count(*)::text AS n FROM sale_candidates WHERE workspace_id = ${ws} AND contact_id = ${sourceId}`),
    () => c(sql`SELECT count(*)::text AS n FROM ofm_contact_relations WHERE workspace_id = ${ws} AND (contact_a_id = ${sourceId} OR contact_b_id = ${sourceId})`),
  ] as const);
  return { interactions, operations: ops, saleCandidates: sales, relations };
};

const assertMergeable = (ctx: Ctx, source: ContactRow, target: ContactRow) => {
  for (const c of [source, target]) {
    if (!canReadContact(ctx, c)) throw notFound('Contact');
    if (!allowed(ctx, 'contacts.merge', contactScope(c))) throw new AppError('FORBIDDEN', 'You cannot merge these contacts.');
    assertOpen(c);
  }
  if (source.id === target.id) throw fieldErr('targetId', 'SAME', 'Choose two different contacts.');
  if (source.accountId !== target.accountId)
    throw invalid('Contacts of different accounts cannot be merged — the same pseudonym on two accounts is not the same person. Link them as related contacts instead.', { code: 'CROSS_ACCOUNT' });
};

export const mergePreview = async (ctx: QueryContext, input: { sourceId: string; targetId: string }) => {
  requirePermission(ctx, 'contacts.merge');
  const source = await loadReadable(ctx, input.sourceId);
  const target = await loadReadable(ctx, input.targetId);
  assertMergeable(ctx, source, target);
  const [summaries, moves, sales] = await all(ctx, [
    () => contactSummaries(ctx, [source, target]),
    () => mergeCounts(ctx, source.id),
    () =>
      ctx.app.db
        .select({ sourceNamespace: saleCandidates.sourceNamespace, sourceTransactionId: saleCandidates.sourceTransactionId, state: saleCandidates.state })
        .from(saleCandidates)
        .where(and(eq(saleCandidates.workspaceId, ctx.actor.workspaceId), inArray(saleCandidates.contactId, [source.id, target.id]))),
  ] as const);
  const val = (c: ContactRow, f: 'alias' | 'managerMembershipId' | 'stage' | 'nextFollowUpAt' | 'businessNotes') => {
    const v = c[f];
    return v instanceof Date ? v.toISOString() : ((v as string | null) ?? null);
  };
  const { token, expiresAt } = signToken(ctx, 'contact-merge', { s: source.id, t: target.id, sv: source.rowVersion, tv: target.rowVersion });
  return {
    previewToken: token,
    expiresAt: expiresAt.toISOString(),
    source: summaries[0]!,
    target: summaries[1]!,
    fields: (['alias', 'managerMembershipId', 'stage', 'nextFollowUpAt', 'businessNotes'] as const).map((f) => ({
      field: f,
      source: val(source, f),
      target: val(target, f),
      differs: val(source, f) !== val(target, f),
    })),
    moves,
    saleTransactionRefs: sales,
  };
};

export const mergeContacts = async (
  ctx: CommandContext,
  input: {
    previewToken: string;
    fieldResolutions: { alias: 'source' | 'target'; managerMembershipId: 'source' | 'target'; stage: 'source' | 'target'; nextFollowUpAt: 'source' | 'target'; businessNotes: 'source' | 'target' | 'both' };
  },
) => {
  const p = verifyToken<{ s: string; t: string; sv: number; tv: number }>(ctx, 'contact-merge', input.previewToken);
  const [first, second] = [p.s, p.t].sort();
  const a = await lockById(ctx, ofmContacts, first!, 'Contact');
  const b = await lockById(ctx, ofmContacts, second!, 'Contact');
  const source = a.id === p.s ? a : b;
  const target = a.id === p.t ? a : b;
  assertMergeable(ctx, source, target);
  if (source.rowVersion !== p.sv || target.rowVersion !== p.tv) throw new AppError('CONFLICT', 'The contacts changed after the preview. Preview again.');
  const r = input.fieldResolutions;
  const pick = <K extends keyof ContactRow>(k: K, side: 'source' | 'target') => (side === 'source' ? source[k] : target[k]);
  const notes =
    r.businessNotes === 'both'
      ? [target.businessNotes, source.businessNotes ? `Merged notes:\n${source.businessNotes}` : null].filter(Boolean).join('\n\n') || null
      : pick('businessNotes', r.businessNotes);
  const lastActivity = [source.lastActivityAt, target.lastActivityAt].filter((d): d is Date => !!d).sort((x, y) => y.getTime() - x.getTime())[0] ?? null;
  const ws = ctx.actor.workspaceId;
  // References move to the target; authors, timestamps and source transaction ids stay untouched.
  const moved = await mergeCounts(ctx, source.id);
  await ctx.tx.update(interactionLogs).set({ contactId: target.id }).where(and(eq(interactionLogs.workspaceId, ws), eq(interactionLogs.contactId, source.id)));
  await ctx.tx.update(operations).set({ contactId: target.id }).where(and(eq(operations.workspaceId, ws), eq(operations.contactId, source.id)));
  await ctx.tx.update(saleCandidates).set({ contactId: target.id }).where(and(eq(saleCandidates.workspaceId, ws), eq(saleCandidates.contactId, source.id)));
  const rels = await ctx.tx.select().from(ofmContactRelations).where(and(eq(ofmContactRelations.workspaceId, ws), or(eq(ofmContactRelations.contactAId, source.id), eq(ofmContactRelations.contactBId, source.id))));
  for (const rel of rels) {
    const other = rel.contactAId === source.id ? rel.contactBId : rel.contactAId;
    const [existing] = await ctx.tx
      .select({ id: ofmContactRelations.id })
      .from(ofmContactRelations)
      .where(
        and(
          ne(ofmContactRelations.id, rel.id),
          or(and(eq(ofmContactRelations.contactAId, target.id), eq(ofmContactRelations.contactBId, other)), and(eq(ofmContactRelations.contactAId, other), eq(ofmContactRelations.contactBId, target.id))),
        ),
      );
    if (other === target.id || existing) await ctx.tx.delete(ofmContactRelations).where(eq(ofmContactRelations.id, rel.id));
    else await ctx.tx.update(ofmContactRelations).set(rel.contactAId === source.id ? { contactAId: target.id } : { contactBId: target.id }).where(eq(ofmContactRelations.id, rel.id));
  }
  const at = ctx.app.clock.now();
  const [t] = await ctx.tx
    .update(ofmContacts)
    .set({
      alias: pick('alias', r.alias),
      managerMembershipId: pick('managerMembershipId', r.managerMembershipId),
      stage: pick('stage', r.stage),
      nextFollowUpAt: pick('nextFollowUpAt', r.nextFollowUpAt),
      businessNotes: notes,
      lastActivityAt: lastActivity,
      restricted: source.restricted || target.restricted,
      ...touch(ctx, ofmContacts),
    })
    .where(eq(ofmContacts.id, target.id))
    .returning();
  const [s] = await ctx.tx
    .update(ofmContacts)
    .set({ mergedIntoId: target.id, archivedAt: at, archivedBy: ctx.actor.userId, archiveReason: 'Merged', stage: 'archived', businessNotes: null, ...touch(ctx, ofmContacts) })
    .where(eq(ofmContacts.id, source.id))
    .returning();
  await audit(ctx, {
    action: 'ofm_contact.merged',
    entityType: 'ofm_contact',
    entityId: target.id,
    projectId: target.projectId,
    metadata: { sourceId: source.id, moved, resolutions: r },
    diff: diffFields(target, t!, ['alias', 'managerMembershipId', 'stage', 'nextFollowUpAt', 'businessNotes'], MASKED),
    sensitivity: 'ofm',
  });
  await audit(ctx, { action: 'ofm_contact.merged_into', entityType: 'ofm_contact', entityId: source.id, projectId: source.projectId, metadata: { targetId: target.id }, sensitivity: 'ofm' });
  await emit(ctx, { type: 'ofm_contact.merged', entityType: 'ofm_contact', entityId: target.id, revision: t!.rowVersion, payload: { sourceId: source.id } });
  await indexContact(ctx, t!);
  await indexContact(ctx, s!);
  return target.id;
};

export const relateContacts = async (ctx: CommandContext, id: string, input: { relatedContactId: string; reason: string }) => {
  const a = await lockContact(ctx, id, 'contacts.relate');
  const b = await lockById(ctx, ofmContacts, input.relatedContactId, 'Contact');
  authorizeContactWrite(ctx, b, 'contacts.relate');
  assertOpen(a);
  assertOpen(b);
  if (a.accountId === b.accountId) throw fieldErr('relatedContactId', 'SAME_ACCOUNT', 'Contacts of the same account are merged, not related.');
  const [existing] = await ctx.tx
    .select({ id: ofmContactRelations.id })
    .from(ofmContactRelations)
    .where(or(and(eq(ofmContactRelations.contactAId, a.id), eq(ofmContactRelations.contactBId, b.id)), and(eq(ofmContactRelations.contactAId, b.id), eq(ofmContactRelations.contactBId, a.id))));
  if (existing) throw new AppError('DUPLICATE', 'These contacts are already related.');
  const relId = newId();
  await ctx.tx.insert(ofmContactRelations).values({ ...stamp(ctx), id: relId, contactAId: a.id, contactBId: b.id, reason: input.reason });
  await audit(ctx, { action: 'ofm_contact.related', entityType: 'ofm_contact', entityId: a.id, projectId: a.projectId, reason: input.reason, metadata: { relatedContactId: b.id, relationId: relId }, sensitivity: 'ofm' });
  await emit(ctx, { type: 'ofm_contact.related', entityType: 'ofm_contact', entityId: a.id });
  return a.id;
};

// ——— Erasure & retention (§22.3) ———

export const requestErasure = async (ctx: CommandContext, id: string, input: { reason: string }) => {
  const c = await lockContact(ctx, id, 'contacts.erase');
  if (c.erasedAt) throw invalid('This contact was already erased.');
  const counts = await mergeCounts(ctx, c.id);
  const plan = {
    contact: 'pseudonymise alias and external identifier; delete business notes',
    interactions: counts.interactions,
    operationDetails: counts.operations,
    saleCandidatesKept: counts.saleCandidates,
    note: 'Financial references stay, linked to the pseudonymised contact.',
  };
  const reqId = newId();
  await ctx.tx.insert(erasureRequests).values({ ...stamp(ctx), id: reqId, entityType: 'ofm_contact', entityId: c.id, reason: input.reason, plan });
  await enqueueJob(ctx.tx, { type: 'ofm.contact_erasure', workspaceId: ctx.actor.workspaceId, pool: 'data', payload: { requestId: reqId }, idempotencyKey: `ofm.contact_erasure:${reqId}`, requestedBy: ctx.actor.membershipId });
  await audit(ctx, { action: 'ofm_contact.erasure_requested', entityType: 'ofm_contact', entityId: c.id, projectId: c.projectId, reason: input.reason, metadata: { requestId: reqId }, sensitivity: 'ofm' });
  await emit(ctx, { type: 'ofm_contact.erasure_requested', entityType: 'ofm_contact', entityId: c.id });
  return { id: reqId, state: 'queued', plan };
};

/**
 * Pseudonymise a contact: alias and external identifier replaced, business notes, interaction
 * notes and operation details deleted; financial references stay linked to the pseudonym.
 */
const pseudonymiseContact = async (ctx: CommandContext, c: typeof ofmContacts.$inferSelect, at: Date) => {
  const pseudonym = `Erased contact ${c.id.slice(0, 8)}`;
  const [row] = await ctx.tx
    .update(ofmContacts)
    .set({
      alias: pseudonym,
      externalIdentifier: `erased:${c.id}`,
      businessNotes: null,
      erasedAt: at,
      restricted: true,
      nextFollowUpAt: null,
      archivedAt: c.archivedAt ?? at,
      archiveReason: c.archiveReason ?? 'Erased',
      stage: 'archived',
      rowVersion: sql`${ofmContacts.rowVersion} + 1`,
      updatedAt: at,
    })
    .where(eq(ofmContacts.id, c.id))
    .returning();
  const inter = await ctx.tx
    .update(interactionLogs)
    .set({ businessNote: '[erased]', erasedAt: at, rowVersion: sql`${interactionLogs.rowVersion} + 1`, updatedAt: at })
    .where(and(eq(interactionLogs.contactId, c.id), isNull(interactionLogs.erasedAt)))
    .returning({ id: interactionLogs.id });
  const ops = await ctx.tx
    .update(operations)
    .set({ details: null, rowVersion: sql`${operations.rowVersion} + 1`, updatedAt: at })
    .where(and(eq(operations.contactId, c.id), sql`${operations.details} IS NOT NULL`))
    .returning({ id: operations.id });
  await indexContact(ctx, row!);
  return { interactionsErased: inter.length, operationDetailsErased: ops.length };
};

// Disaster restore to a point before the erasure: the journal replays it before access reopens (T157).
defineTombstoneReplay('ofm_contact', 'erase', async (ctx, t) => {
  const [c] = await ctx.tx.select().from(ofmContacts).where(eq(ofmContacts.id, t.entityId)).for('update');
  if (!c) return 'not_present';
  await pseudonymiseContact(ctx, c, c.erasedAt ?? t.executedAt);
  return 'applied';
});

/** Job body: pseudonymise the contact, delete personal notes, keep financial links (idempotent). */
export const executeContactErasure = async (ctx: CommandContext, requestId: string) => {
  const [req] = await ctx.tx.select().from(erasureRequests).where(eq(erasureRequests.id, requestId)).for('update');
  if (!req || req.state === 'completed') return req?.result ?? null;
  const at = ctx.app.clock.now();
  await ctx.tx.update(erasureRequests).set({ state: 'running', updatedAt: at }).where(eq(erasureRequests.id, requestId));
  const [c] = await ctx.tx.select().from(ofmContacts).where(eq(ofmContacts.id, req.entityId)).for('update');
  if (!c) {
    await ctx.tx.update(erasureRequests).set({ state: 'failed', result: { error: 'Contact not found' }, updatedAt: at }).where(eq(erasureRequests.id, requestId));
    return null;
  }
  const { interactionsErased, operationDetailsErased } = await pseudonymiseContact(ctx, c, at);
  const [sales] = await ctx.tx.select({ n: sql<string>`count(*)::text` }).from(saleCandidates).where(eq(saleCandidates.contactId, c.id));
  await recordTombstone(ctx, { workspaceId: c.workspaceId, entityType: 'ofm_contact', entityId: c.id, action: 'erase', details: { requestId } });
  const result = { contact: 'pseudonymised', interactionsErased, operationDetailsErased, saleCandidatesKept: Number(sales?.n ?? 0), searchIndex: 'updated' };
  await ctx.tx.update(erasureRequests).set({ state: 'completed', result, completedAt: at, updatedAt: at }).where(eq(erasureRequests.id, requestId));
  await audit(ctx, { action: 'ofm_contact.erased', entityType: 'ofm_contact', entityId: c.id, projectId: c.projectId, metadata: { requestId, ...result }, sensitivity: 'ofm' });
  await emit(ctx, { type: 'ofm_contact.erased', entityType: 'ofm_contact', entityId: c.id });
  return result;
};

/** Retention: business notes of contacts archived longer than the policy (default 180 d) are deleted. */
export const applyContactRetention = async (ctx: CommandContext) => {
  const info = await workspaceInfo(ctx.tx, ctx.actor.workspaceId);
  const days = info.settings.retention?.ofmArchivedNotesDays ?? DEFAULT_RETENTION_DAYS;
  const cutoff = new Date(ctx.app.clock.now().getTime() - days * 86_400_000);
  const due = await ctx.tx
    .select({ id: ofmContacts.id, projectId: ofmContacts.projectId })
    .from(ofmContacts)
    .where(
      and(
        eq(ofmContacts.workspaceId, ctx.actor.workspaceId),
        lt(ofmContacts.archivedAt, cutoff),
        or(
          sql`${ofmContacts.businessNotes} IS NOT NULL`,
          sql`EXISTS (SELECT 1 FROM interaction_logs il WHERE il.contact_id = ${ofmContacts.id} AND il.erased_at IS NULL)`,
        ),
      ),
    )
    .limit(500);
  const at = ctx.app.clock.now();
  for (const c of due) {
    await ctx.tx.update(ofmContacts).set({ businessNotes: null, rowVersion: sql`${ofmContacts.rowVersion} + 1`, updatedAt: at }).where(eq(ofmContacts.id, c.id));
    const n = await ctx.tx
      .update(interactionLogs)
      .set({ businessNote: '[removed by retention policy]', erasedAt: at, updatedAt: at })
      .where(and(eq(interactionLogs.contactId, c.id), isNull(interactionLogs.erasedAt)))
      .returning({ id: interactionLogs.id });
    await audit(ctx, { action: 'ofm_contact.retention_applied', entityType: 'ofm_contact', entityId: c.id, projectId: c.projectId, metadata: { retentionDays: days, interactions: n.length }, sensitivity: 'ofm' });
  }
  return { contacts: due.length, retentionDays: days };
};

// ——— Interactions ———

type InteractionRow = typeof interactionLogs.$inferSelect;

const interactionViews = async (ctx: Ctx, rows: InteractionRow[]) => {
  const refs = await loadMemberRefs(dbOf(ctx), ctx.actor.workspaceId, rows.map((r) => r.membershipId));
  return rows.map((r) => ({
    id: r.id,
    contactId: r.contactId,
    type: r.type,
    occurredAt: r.occurredAt.toISOString(),
    businessNote: r.businessNote,
    member: refOrUnknown(refs, r.membershipId)!,
    shiftId: r.shiftId,
    erasedAt: iso(r.erasedAt),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    edited: r.rowVersion > 1 && !r.erasedAt,
    rowVersion: r.rowVersion,
    canEdit: r.membershipId === me(ctx) && !r.erasedAt,
  }));
};

export const listInteractions = async (ctx: QueryContext, input: { contactId: string; cursor?: string; pageSize?: number }) => {
  requirePermission(ctx, 'contacts.read');
  await loadReadable(ctx, input.contactId);
  const k = exprKeyset(interactionLogs.occurredAt, interactionLogs.id, 'timestamp', 'desc', input);
  const rows = await ctx.app.db
    .select()
    .from(interactionLogs)
    .where(and(eq(interactionLogs.workspaceId, ctx.actor.workspaceId), eq(interactionLogs.contactId, input.contactId), k.where))
    .orderBy(...k.orderBy)
    .limit(k.limit);
  const page = k.finish(rows, (r) => r.occurredAt, (r) => r.id);
  return { ...page, items: await interactionViews(ctx, page.items) };
};

export const createInteraction = async (
  ctx: CommandContext,
  input: { contactId: string; type: InteractionRow['type']; occurredAt: string; businessNote: string; shiftId?: string | null },
) => {
  const c = await lockContact(ctx, input.contactId);
  assertOpen(c);
  if (c.archivedAt) throw invalid('Restore the contact before logging interactions.');
  assertNoForbiddenContent('businessNote', input.businessNote);
  const occurredAt = new Date(input.occurredAt);
  if (occurredAt.getTime() > ctx.app.clock.now().getTime() + 5 * 60_000) throw fieldErr('occurredAt', 'IN_FUTURE', 'An interaction cannot happen in the future.');
  if (input.shiftId) {
    const [s] = await ctx.tx.select().from(shifts).where(and(eq(shifts.workspaceId, ctx.actor.workspaceId), eq(shifts.id, input.shiftId)));
    const [link] = s ? await ctx.tx.select({ id: shiftAccounts.id }).from(shiftAccounts).where(and(eq(shiftAccounts.shiftId, s.id), eq(shiftAccounts.accountId, c.accountId))) : [];
    if (!s || !canReadShift(ctx, s) || !link) throw fieldErr('shiftId', 'NOT_FOUND', 'Choose a shift that covers this contact’s account.');
  }
  const id = newId();
  const [row] = await ctx.tx
    .insert(interactionLogs)
    .values({ ...stamp(ctx), id, contactId: c.id, accountId: c.accountId, membershipId: me(ctx), shiftId: input.shiftId ?? null, occurredAt, type: input.type, businessNote: input.businessNote.trim() })
    .returning();
  if (!c.lastActivityAt || c.lastActivityAt.getTime() < occurredAt.getTime())
    await ctx.tx.update(ofmContacts).set({ lastActivityAt: occurredAt, ...touch(ctx, ofmContacts) }).where(eq(ofmContacts.id, c.id));
  // Authorship is audited; the note text never is.
  await audit(ctx, { action: 'ofm_interaction.logged', entityType: 'ofm_contact', entityId: c.id, projectId: c.projectId, metadata: { interactionId: id, type: input.type }, sensitivity: 'ofm' });
  await emit(ctx, { type: 'ofm_interaction.logged', entityType: 'ofm_contact', entityId: c.id });
  return (await interactionViews(ctx, [row!]))[0]!;
};

export const updateInteraction = async (ctx: CommandContext, id: string, input: { type?: InteractionRow['type']; occurredAt?: string; businessNote?: string }) => {
  const r = await lockById(ctx, interactionLogs, id, 'Interaction');
  const [c] = await ctx.tx.select().from(ofmContacts).where(eq(ofmContacts.id, r.contactId));
  if (!c || !canReadContact(ctx, c)) throw notFound('Interaction');
  if (r.membershipId !== me(ctx) || !allowed(ctx, 'contacts.write', contactScope(c))) throw new AppError('FORBIDDEN', 'Only the author can edit an interaction.');
  assertVersion(ctx, r);
  if (r.erasedAt) throw invalid('Erased interactions cannot be edited.');
  if (input.businessNote !== undefined) assertNoForbiddenContent('businessNote', input.businessNote);
  const occurredAt = input.occurredAt ? new Date(input.occurredAt) : r.occurredAt;
  if (occurredAt.getTime() > ctx.app.clock.now().getTime() + 5 * 60_000) throw fieldErr('occurredAt', 'IN_FUTURE', 'An interaction cannot happen in the future.');
  const [row] = await ctx.tx
    .update(interactionLogs)
    .set({ type: input.type ?? r.type, occurredAt, businessNote: input.businessNote?.trim() ?? r.businessNote, ...touch(ctx, interactionLogs) })
    .where(eq(interactionLogs.id, id))
    .returning();
  await audit(ctx, {
    action: 'ofm_interaction.edited',
    entityType: 'ofm_contact',
    entityId: c.id,
    projectId: c.projectId,
    metadata: { interactionId: id },
    diff: diffFields(r, row!, ['type', 'occurredAt', 'businessNote'], ['businessNote']),
    sensitivity: 'ofm',
  });
  await emit(ctx, { type: 'ofm_interaction.edited', entityType: 'ofm_contact', entityId: c.id });
  return (await interactionViews(ctx, [row!]))[0]!;
};

export { loadReadable as loadReadableContact };
