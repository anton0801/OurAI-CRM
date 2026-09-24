import { and, asc, desc, eq, gt, ilike, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import {
  memberships,
  ofmAssignments,
  ofmContacts,
  ofmProfiles,
  operations,
  qualityReviews,
  saleCandidates,
  shiftBreaks,
  shiftReports,
  shiftReportVersions,
  shifts,
  socialAccounts,
  users,
} from '@castlane/database';
import { AppError, DateTime, isUuid, netHoursString, normalizeEmail, shiftNetTime, CONTACT_STAGES } from '@castlane/domain';
import { allowed, requireAnyPermission, requirePermission } from '../core/access';
import { defineArchiveHandler } from '../core/archive-registry';
import { audit } from '../core/audit';
import { dbOf, type CommandContext, type QueryContext } from '../core/context';
import { defineExportDataset } from '../core/export-registry';
import { defineImportDataset, type ImportIssue } from '../core/import-registry';
import { defineLookup, likePattern } from '../core/lookup-registry';
import { loadMemberRefs, refOrUnknown } from '../core/members';
import { defineResponsibilityProvider } from '../core/responsibility-registry';
import { lockById, touch } from '../core/rows';
import { removeSearchDocument } from '../core/search';
import { defineLinkAccess } from '../media/link-access';
import { endAssignment, transferAssignment } from './assignments';
import { accountLabel, forbiddenContentIssue, isOfmProject, loadAccountInfos, loadProjectInfos } from './common';
import { archiveContactInternal, createContact, restoreContact, updateContact } from './contacts';
import { archiveOperationInternal, restoreOperationInternal } from './operations';
import { checkSaleDuplicate, createSaleCandidate } from './sales';
import { cancelShiftInternal, reassignShift } from './shifts';
import { canReadContact, contactScope, contactVisibility, operationScope, saleScope, shiftScope, shiftVisibility } from './views';

// ——— Lookups (EntitySelect) ———

defineLookup({
  type: 'ofm_contact',
  async search(ctx, input) {
    // Sensitive: contacts permission required; restricted contacts only for their manager/merge holders.
    requirePermission(ctx, 'contacts.read');
    const rows = await dbOf(ctx)
      .select()
      .from(ofmContacts)
      .where(
        and(
          eq(ofmContacts.workspaceId, ctx.actor.workspaceId),
          isNull(ofmContacts.mergedIntoId),
          contactVisibility(ctx),
          input.ids?.length ? inArray(ofmContacts.id, input.ids) : undefined,
          !input.ids?.length && !input.includeArchived ? isNull(ofmContacts.archivedAt) : undefined,
          input.accountId ? eq(ofmContacts.accountId, input.accountId) : undefined,
          input.projectId ? eq(ofmContacts.projectId, input.projectId) : undefined,
          input.q ? or(ilike(ofmContacts.alias, likePattern(input.q)), ilike(ofmContacts.externalIdentifier, `${input.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`)) : undefined,
        ),
      )
      .orderBy(asc(ofmContacts.alias))
      .limit(input.ids?.length ? Math.max(input.ids.length, input.limit) : input.limit);
    const accounts = await loadAccountInfos(dbOf(ctx), ctx.actor.workspaceId, rows.map((r) => r.accountId));
    return rows.map((r) => ({
      id: r.id,
      label: r.alias,
      sublabel: accounts.get(r.accountId) ? accountLabel(accounts.get(r.accountId)!) : null,
      status: r.stage,
      projectId: r.projectId,
      archived: !!r.archivedAt,
    }));
  },
});

defineLookup({
  type: 'shift',
  async search(ctx, input) {
    requireAnyPermission(ctx, ['shifts.read.scope', 'shifts.read.own']);
    const now = ctx.app.clock.now();
    const rows = await dbOf(ctx)
      .select()
      .from(shifts)
      .where(
        and(
          eq(shifts.workspaceId, ctx.actor.workspaceId),
          shiftVisibility(ctx),
          input.ids?.length ? inArray(shifts.id, input.ids) : undefined,
          input.projectId ? eq(shifts.projectId, input.projectId) : undefined,
          input.accountId ? sql`EXISTS (SELECT 1 FROM shift_accounts sa WHERE sa.shift_id = ${shifts.id} AND sa.account_id = ${input.accountId})` : undefined,
          input.status?.length ? inArray(shifts.state, input.status as never[]) : undefined,
          !input.ids?.length && !input.includeArchived ? sql`${shifts.state} NOT IN ('cancelled')` : undefined,
        ),
      )
      .orderBy(sql`abs(extract(epoch from (${shifts.scheduledStart} - ${now}::timestamptz)))`, desc(shifts.id))
      .limit(input.ids?.length ? Math.max(input.ids.length, input.limit) : input.limit);
    const db = dbOf(ctx);
    const [refs, accounts] = [await loadMemberRefs(db, ctx.actor.workspaceId, rows.map((r) => r.membershipId)), await loadAccountInfos(db, ctx.actor.workspaceId, rows.map((r) => r.primaryAccountId))];
    const tz = ctx.actor.timezone;
    return rows
      .map((r) => {
        const s = DateTime.fromJSDate(r.scheduledStart, { zone: tz });
        const e = DateTime.fromJSDate(r.scheduledEnd, { zone: tz });
        return {
          id: r.id,
          label: `${s.toFormat('ccc d LLL HH:mm')}–${e.toFormat('HH:mm')} · ${refOrUnknown(refs, r.membershipId)!.displayName}`,
          sublabel: accounts.get(r.primaryAccountId) ? accountLabel(accounts.get(r.primaryAccountId)!) : null,
          status: r.state,
          projectId: r.projectId,
          archived: r.state === 'cancelled',
        };
      })
      .filter((x) => !input.q || x.label.toLowerCase().includes(input.q.toLowerCase()) || (x.sublabel ?? '').toLowerCase().includes(input.q.toLowerCase()));
  },
});

// ——— Responsibilities (F12 deactivation) ———

defineResponsibilityProvider({
  kind: 'ofm.shifts',
  label: 'Scheduled OFM shifts',
  unassignedBehaviour: 'Cancelled with the reason “Member deactivated” (history kept).',
  async list(ctx, membershipId) {
    const rows = await dbOf(ctx)
      .select()
      .from(shifts)
      .where(and(eq(shifts.workspaceId, ctx.actor.workspaceId), eq(shifts.membershipId, membershipId), eq(shifts.state, 'scheduled')))
      .orderBy(asc(shifts.scheduledStart));
    const accounts = await loadAccountInfos(dbOf(ctx), ctx.actor.workspaceId, rows.map((r) => r.primaryAccountId));
    return rows.map((s) => ({
      kind: 'ofm.shifts',
      entityType: 'shift',
      entityId: s.id,
      title: `Shift ${s.scheduledStart.toISOString().slice(0, 16).replace('T', ' ')} UTC · ${accounts.get(s.primaryAccountId) ? accountLabel(accounts.get(s.primaryAccountId)!) : 'account'}`,
      projectId: s.projectId,
      dueAt: s.scheduledStart.toISOString(),
      requiresSuccessor: false,
    }));
  },
  async transfer(ctx, fromMembershipId, resolutions) {
    const rows = await ctx.tx
      .select()
      .from(shifts)
      .where(and(eq(shifts.workspaceId, ctx.actor.workspaceId), eq(shifts.membershipId, fromMembershipId), eq(shifts.state, 'scheduled')))
      .for('update');
    for (const s of rows) {
      const successor = resolutions.find((r) => r.entityId === s.id)?.successorMembershipId ?? null;
      if (successor) await reassignShift(ctx, s, successor, 'Member deactivated');
      else await cancelShiftInternal(ctx, s, 'Member deactivated');
    }
  },
});

defineResponsibilityProvider({
  kind: 'ofm.assignments',
  label: 'OFM account assignments',
  unassignedBehaviour: 'Ended now; the account keeps its other assignments and history.',
  async list(ctx, membershipId) {
    const now = ctx.app.clock.now();
    const rows = await dbOf(ctx)
      .select()
      .from(ofmAssignments)
      .where(
        and(
          eq(ofmAssignments.workspaceId, ctx.actor.workspaceId),
          eq(ofmAssignments.membershipId, membershipId),
          isNull(ofmAssignments.endedAt),
          or(isNull(ofmAssignments.validTo), gt(ofmAssignments.validTo, now)),
        ),
      );
    const accounts = await loadAccountInfos(dbOf(ctx), ctx.actor.workspaceId, rows.map((r) => r.accountId));
    return rows.map((a) => ({
      kind: 'ofm.assignments',
      entityType: 'ofm_assignment',
      entityId: a.id,
      title: `OFM assignment · ${accounts.get(a.accountId) ? accountLabel(accounts.get(a.accountId)!) : 'account'}`,
      projectId: a.projectId,
      dueAt: a.validTo?.toISOString() ?? null,
      requiresSuccessor: false,
    }));
  },
  async transfer(ctx, fromMembershipId, resolutions) {
    const now = ctx.app.clock.now();
    const rows = await ctx.tx
      .select()
      .from(ofmAssignments)
      .where(and(eq(ofmAssignments.workspaceId, ctx.actor.workspaceId), eq(ofmAssignments.membershipId, fromMembershipId), isNull(ofmAssignments.endedAt), or(isNull(ofmAssignments.validTo), gt(ofmAssignments.validTo, now))));
    for (const a of rows) {
      const successor = resolutions.find((r) => r.entityId === a.id)?.successorMembershipId ?? null;
      if (successor) await transferAssignment(ctx, a.id, { toMembershipId: successor, reason: 'Member deactivated', moveFutureShifts: true }, { skipVersion: true });
      else await endAssignment(ctx, a.id, { reason: 'Member deactivated' }, { skipVersion: true });
    }
  },
});

defineResponsibilityProvider({
  kind: 'ofm.contacts.manager',
  label: 'Managed OFM contacts',
  unassignedBehaviour: 'Left without a manager (visible to the account team and supervisor).',
  async list(ctx, membershipId) {
    const rows = await dbOf(ctx)
      .select({ id: ofmContacts.id, projectId: ofmContacts.projectId, accountId: ofmContacts.accountId, nextFollowUpAt: ofmContacts.nextFollowUpAt })
      .from(ofmContacts)
      .where(and(eq(ofmContacts.workspaceId, ctx.actor.workspaceId), eq(ofmContacts.managerMembershipId, membershipId), isNull(ofmContacts.archivedAt), isNull(ofmContacts.mergedIntoId)));
    const accounts = await loadAccountInfos(dbOf(ctx), ctx.actor.workspaceId, rows.map((r) => r.accountId));
    // Aliases are sensitive: the impact list names the account only.
    return rows.map((c) => ({
      kind: 'ofm.contacts.manager',
      entityType: 'ofm_contact',
      entityId: c.id,
      title: `OFM contact on ${accounts.get(c.accountId) ? accountLabel(accounts.get(c.accountId)!) : 'account'}`,
      projectId: c.projectId,
      dueAt: c.nextFollowUpAt?.toISOString() ?? null,
      requiresSuccessor: false,
    }));
  },
  async transfer(ctx, fromMembershipId, resolutions) {
    const rows = await ctx.tx
      .select()
      .from(ofmContacts)
      .where(and(eq(ofmContacts.workspaceId, ctx.actor.workspaceId), eq(ofmContacts.managerMembershipId, fromMembershipId), isNull(ofmContacts.mergedIntoId)));
    for (const c of rows) {
      const successor = resolutions.find((r) => r.entityId === c.id)?.successorMembershipId ?? null;
      await ctx.tx.update(ofmContacts).set({ managerMembershipId: successor, ...touch(ctx, ofmContacts) }).where(eq(ofmContacts.id, c.id));
      await audit(ctx, { action: 'ofm_contact.manager_transferred', entityType: 'ofm_contact', entityId: c.id, projectId: c.projectId, diff: { managerMembershipId: { from: fromMembershipId, to: successor } }, sensitivity: 'ofm' });
    }
  },
});

defineResponsibilityProvider({
  kind: 'ofm.operations.owner',
  label: 'Open OFM operations',
  unassignedBehaviour: 'Moved to the model’s OFM supervisor.',
  async list(ctx, membershipId) {
    const rows = await dbOf(ctx)
      .select()
      .from(operations)
      .where(and(eq(operations.workspaceId, ctx.actor.workspaceId), eq(operations.ownerMembershipId, membershipId), inArray(operations.status, ['open', 'in_progress', 'waiting'])));
    return rows.map((o) => ({ kind: 'ofm.operations.owner', entityType: 'operation', entityId: o.id, title: o.title, projectId: o.projectId, dueAt: o.dueAt?.toISOString() ?? null, requiresSuccessor: true }));
  },
  async transfer(ctx, fromMembershipId, resolutions) {
    const rows = await ctx.tx
      .select()
      .from(operations)
      .where(and(eq(operations.workspaceId, ctx.actor.workspaceId), eq(operations.ownerMembershipId, fromMembershipId), inArray(operations.status, ['open', 'in_progress', 'waiting'])));
    for (const o of rows) {
      let successor = resolutions.find((r) => r.entityId === o.id)?.successorMembershipId ?? null;
      if (!successor) {
        const [p] = await ctx.tx.select({ s: ofmProfiles.supervisorMembershipId }).from(ofmProfiles).where(eq(ofmProfiles.projectId, o.projectId));
        successor = p?.s ?? null;
      }
      if (!successor || successor === fromMembershipId)
        throw new AppError('VALIDATION_FAILED', 'Choose a successor for the open OFM operations (no OFM supervisor is set for the model).', { details: { operationId: o.id } });
      await ctx.tx.update(operations).set({ ownerMembershipId: successor, ...touch(ctx, operations) }).where(eq(operations.id, o.id));
      await audit(ctx, { action: 'operation.owner_transferred', entityType: 'operation', entityId: o.id, projectId: o.projectId, diff: { ownerMembershipId: { from: fromMembershipId, to: successor } } });
    }
  },
});

// ——— Archive handlers ———

defineArchiveHandler({
  entityType: 'ofm_contact',
  label: 'OFM contact',
  async preview(ctx, id) {
    const [c] = await dbOf(ctx).select().from(ofmContacts).where(and(eq(ofmContacts.workspaceId, ctx.actor.workspaceId), eq(ofmContacts.id, id)));
    if (!c || !canReadContact(ctx, c)) throw new AppError('NOT_FOUND', 'Contact was not found.');
    if (!allowed(ctx, 'contacts.write', contactScope(c))) throw new AppError('FORBIDDEN', 'You cannot archive this contact.');
    const [ops] = await dbOf(ctx).select({ n: sql<string>`count(*)::text` }).from(operations).where(and(eq(operations.contactId, id), inArray(operations.status, ['open', 'in_progress', 'waiting'])));
    const [pending] = await dbOf(ctx).select({ n: sql<string>`count(*)::text` }).from(saleCandidates).where(and(eq(saleCandidates.contactId, id), eq(saleCandidates.state, 'pending')));
    return {
      title: c.alias,
      rowVersion: c.rowVersion,
      items: [
        { kind: 'open_operations', label: 'Open operations stay open', count: Number(ops?.n ?? 0), blocking: false },
        { kind: 'pending_sales', label: 'Pending sale candidates stay in review', count: Number(pending?.n ?? 0), blocking: false },
        { kind: 'retention', label: 'Business notes are deleted after the retention period', count: 1, blocking: false, resolution: 'Default 180 days after archiving.' },
      ].filter((i) => i.count > 0),
    };
  },
  async archive(ctx, id, input) {
    const c = await lockById(ctx, ofmContacts, id, 'Contact');
    if (!canReadContact(ctx, c) || !allowed(ctx, 'contacts.write', contactScope(c))) throw new AppError('NOT_FOUND', 'Contact was not found.');
    await archiveContactInternal(ctx, c, input.reason ?? 'Archived');
  },
  async restorePreview(ctx, id) {
    const [c] = await dbOf(ctx).select().from(ofmContacts).where(and(eq(ofmContacts.workspaceId, ctx.actor.workspaceId), eq(ofmContacts.id, id)));
    if (!c || !canReadContact(ctx, c)) throw new AppError('NOT_FOUND', 'Contact was not found.');
    return { title: c.alias, items: c.erasedAt || c.mergedIntoId ? [{ kind: 'closed', label: 'Erased or merged contacts cannot be restored', count: 1, blocking: true }] : [] };
  },
  async restore(ctx, id) {
    await restoreContact(ctx, id, { skipVersion: true });
  },
});

defineArchiveHandler({
  entityType: 'operation',
  label: 'OFM operation',
  async preview(ctx, id) {
    const [o] = await dbOf(ctx).select().from(operations).where(and(eq(operations.workspaceId, ctx.actor.workspaceId), eq(operations.id, id)));
    if (!o || !allowed(ctx, 'operations.read', operationScope(o))) throw new AppError('NOT_FOUND', 'Operation was not found.');
    if (!allowed(ctx, 'operations.write', operationScope(o))) throw new AppError('FORBIDDEN', 'You cannot archive this operation.');
    const open = ['open', 'in_progress', 'waiting'].includes(o.status);
    return { title: o.title, rowVersion: o.rowVersion, items: open ? [{ kind: 'open', label: 'The operation is still open', count: 1, blocking: true, resolution: 'Complete or cancel it first.' }] : [] };
  },
  async archive(ctx, id, input) {
    const o = await lockById(ctx, operations, id, 'Operation');
    if (!allowed(ctx, 'operations.write', operationScope(o))) throw new AppError('NOT_FOUND', 'Operation was not found.');
    if (['open', 'in_progress', 'waiting'].includes(o.status)) throw new AppError('INVALID_STATE', 'Complete or cancel the operation before archiving it.');
    if (o.archivedAt) throw new AppError('INVALID_STATE', 'The operation is already archived.');
    await archiveOperationInternal(ctx, o, input.reason);
  },
  async restorePreview(ctx, id) {
    const [o] = await dbOf(ctx).select().from(operations).where(and(eq(operations.workspaceId, ctx.actor.workspaceId), eq(operations.id, id)));
    if (!o || !allowed(ctx, 'operations.read', operationScope(o))) throw new AppError('NOT_FOUND', 'Operation was not found.');
    return { title: o.title, items: [] };
  },
  async restore(ctx, id) {
    const o = await lockById(ctx, operations, id, 'Operation');
    if (!allowed(ctx, 'operations.write', operationScope(o))) throw new AppError('NOT_FOUND', 'Operation was not found.');
    await restoreOperationInternal(ctx, o);
  },
});

// ——— Attachment / evidence access through OFM records ———

defineLinkAccess('shift', {
  permission: 'shifts.read.scope',
  scope: async (ctx, id) => {
    const [s] = await dbOf(ctx).select().from(shifts).where(and(eq(shifts.workspaceId, ctx.actor.workspaceId), eq(shifts.id, id)));
    return s ? { ...shiftScope(s), label: 'Shift', href: `/w/${s.workspaceId}/ofm/shifts/${s.id}` } : null;
  },
});
defineLinkAccess('operation', {
  permission: 'operations.read',
  scope: async (ctx, id) => {
    const [o] = await dbOf(ctx).select().from(operations).where(and(eq(operations.workspaceId, ctx.actor.workspaceId), eq(operations.id, id)));
    return o ? { ...operationScope(o), label: o.title, href: `/w/${o.workspaceId}/ofm/operations?open=${o.id}` } : null;
  },
});
defineLinkAccess('sale_candidate', {
  permission: 'sale-candidates.write',
  scope: async (ctx, id) => {
    const [s] = await dbOf(ctx).select().from(saleCandidates).where(and(eq(saleCandidates.workspaceId, ctx.actor.workspaceId), eq(saleCandidates.id, id)));
    return s ? { ...saleScope(s), label: 'Sale candidate', href: `/w/${s.workspaceId}/ofm/operations?tab=sales&open=${s.id}` } : null;
  },
});
defineLinkAccess('ofm_contact', {
  permission: 'contacts.read',
  scope: async (ctx, id) => {
    const [c] = await dbOf(ctx).select().from(ofmContacts).where(and(eq(ofmContacts.workspaceId, ctx.actor.workspaceId), eq(ofmContacts.id, id)));
    // The label never carries the alias: link metadata may be shown outside the contacts permission.
    return c && canReadContact(ctx, c) ? { ...contactScope(c), label: 'OFM contact', href: `/w/${c.workspaceId}/ofm/contacts/${c.id}` } : null;
  },
});
defineLinkAccess('quality_review', {
  permission: 'quality.read.scope',
  scope: async (ctx, id) => {
    const [r] = await dbOf(ctx).select().from(qualityReviews).where(and(eq(qualityReviews.workspaceId, ctx.actor.workspaceId), eq(qualityReviews.id, id)));
    return r ? { objectType: 'quality_review', objectId: r.id, projectId: r.projectId, label: 'Quality review', href: `/w/${r.workspaceId}/ofm/quality?open=${r.id}` } : null;
  },
});

// ——— Import datasets (engine owned by the platform module) ———

const resolveAccount = async (ctx: QueryContext, ref: unknown, issues: ImportIssue[]) => {
  const v = String(ref ?? '').trim();
  if (!v) {
    issues.push({ field: 'account', code: 'REQUIRED', message: 'Account is required.' });
    return null;
  }
  const db = dbOf(ctx);
  const handle = v.replace(/^@/, '').toLowerCase();
  const where = isUuid(v) ? eq(socialAccounts.id, v) : sql`lower(${socialAccounts.handle}) = ${handle}`;
  const rows = await db
    .select()
    .from(socialAccounts)
    .where(and(eq(socialAccounts.workspaceId, ctx.actor.workspaceId), where, isNull(socialAccounts.deletedAt), isNull(socialAccounts.archivedAt)))
    .limit(3);
  if (rows.length === 0) {
    issues.push({ field: 'account', code: 'UNKNOWN_ACCOUNT', message: 'No active account matches. Accounts are never created by imports.' });
    return null;
  }
  if (rows.length > 1) {
    issues.push({ field: 'account', code: 'AMBIGUOUS', message: 'Several accounts share this handle. Use the account ID.' });
    return null;
  }
  const a = rows[0]!;
  const project = (await loadProjectInfos(db, ctx.actor.workspaceId, [a.projectId])).get(a.projectId);
  if (!project || !isOfmProject(project)) {
    issues.push({ field: 'account', code: 'OFM_NOT_ENABLED', message: 'OFM is not enabled for this account’s model.' });
    return null;
  }
  return a;
};

const resolveMember = async (ctx: QueryContext, ref: unknown, issues: ImportIssue[], field: string) => {
  const v = String(ref ?? '').trim();
  if (!v) return null;
  const rows = await dbOf(ctx)
    .select({ id: memberships.id, status: memberships.status })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.workspaceId, ctx.actor.workspaceId), isUuid(v) ? eq(memberships.id, v) : eq(users.normalizedEmail, normalizeEmail(v))));
  if (!rows[0] || rows[0].status !== 'active') {
    issues.push({ field, code: 'UNKNOWN_MEMBER', message: 'No active member matches.' });
    return null;
  }
  return rows[0].id;
};

interface ContactImportRow {
  accountId: string;
  externalIdentifier: string;
  alias: string;
  stage: Exclude<(typeof CONTACT_STAGES)[number], 'archived'>;
  managerMembershipId: string | null;
  nextFollowUpAt: string | null;
  businessNotes: string | null;
}

defineImportDataset<ContactImportRow>({
  key: 'ofm_contacts',
  label: 'OFM Contacts',
  permission: 'contacts.write',
  duplicatePolicies: ['skip', 'revise_existing', 'error'],
  columns: [
    { key: 'account', label: 'Account (ID or handle)', type: 'reference', required: true, aliases: ['account', 'account_id', 'handle'] },
    { key: 'external_identifier', label: 'External Identifier', type: 'text', required: true, aliases: ['external id', 'identifier', 'username'] },
    { key: 'alias', label: 'Alias', type: 'text', required: true, aliases: ['alias', 'pseudonym', 'name'] },
    { key: 'stage', label: 'Stage', type: 'enum', enumValues: CONTACT_STAGES.filter((s) => s !== 'archived') },
    { key: 'manager', label: 'Assigned Manager (member ID or e-mail)', type: 'reference', aliases: ['manager', 'manager_email'] },
    { key: 'next_follow_up_at', label: 'Next Follow-up', type: 'datetime' },
    { key: 'business_notes', label: 'Business Notes', type: 'long_text', aliases: ['notes'] },
  ],
  async validate(ctx, row, opts) {
    const errors: ImportIssue[] = [];
    const warnings: ImportIssue[] = [];
    const account = await resolveAccount(ctx, row.account, errors);
    const externalIdentifier = String(row.external_identifier ?? '').trim();
    const alias = String(row.alias ?? '').trim();
    if (!externalIdentifier) errors.push({ field: 'external_identifier', code: 'REQUIRED', message: 'External identifier is required.' });
    if (alias.length < 2 || alias.length > 120) errors.push({ field: 'alias', code: 'LENGTH', message: 'Alias must be 2–120 characters.' });
    for (const [field, text] of [['alias', alias], ['business_notes', row.business_notes]] as const) {
      const issue = forbiddenContentIssue(text ? String(text) : null);
      if (issue) errors.push({ field, code: 'FORBIDDEN_CONTENT', message: issue });
    }
    const stage = (row.stage ? String(row.stage) : 'new') as ContactImportRow['stage'];
    if (!CONTACT_STAGES.includes(stage) || stage === ('archived' as string)) errors.push({ field: 'stage', code: 'INVALID', message: 'Unknown stage.' });
    const managerMembershipId = await resolveMember(ctx, row.manager, errors, 'manager');
    if (account && !allowed(ctx, 'contacts.write', { projectId: account.projectId, accountId: account.id }))
      errors.push({ field: 'account', code: 'FORBIDDEN', message: 'You cannot add contacts for this account.' });
    const normalized: ContactImportRow = {
      accountId: account?.id ?? '',
      externalIdentifier,
      alias,
      stage,
      managerMembershipId,
      nextFollowUpAt: row.next_follow_up_at ? String(row.next_follow_up_at) : null,
      businessNotes: row.business_notes ? String(row.business_notes) : null,
    };
    let action: 'create' | 'update' | 'skip' = 'create';
    let targetId: string | undefined;
    let targetRowVersion: number | undefined;
    if (account && externalIdentifier) {
      const [existing] = await dbOf(ctx)
        .select()
        .from(ofmContacts)
        .where(and(eq(ofmContacts.workspaceId, ctx.actor.workspaceId), eq(ofmContacts.accountId, account.id), eq(ofmContacts.externalIdentifier, externalIdentifier)));
      if (existing) {
        if (opts.duplicatePolicy === 'error') errors.push({ field: 'external_identifier', code: 'DUPLICATE', message: 'This contact already exists for the account.' });
        else if (opts.duplicatePolicy === 'skip') {
          action = 'skip';
          warnings.push({ field: 'external_identifier', code: 'DUPLICATE_SKIPPED', message: 'Existing contact — row skipped.' });
        } else if (existing.mergedIntoId || existing.erasedAt || existing.archivedAt) errors.push({ field: 'external_identifier', code: 'CLOSED', message: 'The existing contact is archived, merged or erased.' });
        else {
          action = 'update';
          targetId = existing.id;
          targetRowVersion = existing.rowVersion;
        }
      }
    }
    return { action, normalized, errors, warnings, targetId, targetRowVersion, dedupeKey: `${normalized.accountId}:${externalIdentifier}` };
  },
  async apply(ctx, row, v) {
    if (v.action === 'update' && v.targetId) {
      const c: CommandContext = { ...ctx, request: { ...ctx.request, expectedVersion: v.targetRowVersion } };
      await updateContact(c, v.targetId, { alias: row.alias, managerMembershipId: row.managerMembershipId ?? undefined, nextFollowUpAt: row.nextFollowUpAt ?? undefined, businessNotes: row.businessNotes ?? undefined });
      return v.targetId;
    }
    return createContact(ctx, { accountId: row.accountId, externalIdentifier: row.externalIdentifier, alias: row.alias, stage: row.stage, managerMembershipId: row.managerMembershipId, nextFollowUpAt: row.nextFollowUpAt, businessNotes: row.businessNotes });
  },
  async undo(ctx, entityId) {
    const c = await lockById(ctx, ofmContacts, entityId, 'Contact');
    const [deps] = await ctx.tx.execute<{ n: string }>(sql`
      SELECT ((SELECT count(*) FROM interaction_logs WHERE contact_id = ${entityId}) + (SELECT count(*) FROM operations WHERE contact_id = ${entityId})
        + (SELECT count(*) FROM sale_candidates WHERE contact_id = ${entityId}) + (SELECT count(*) FROM ofm_contact_relations WHERE contact_a_id = ${entityId} OR contact_b_id = ${entityId}))::text AS n`).then((r) => r.rows);
    if (c.rowVersion !== 1 || Number(deps?.n ?? 0) > 0)
      throw new AppError('INVALID_STATE', 'The contact was changed or has linked records; archive it instead.', { details: { contactId: entityId, dependencies: Number(deps?.n ?? 0) } });
    await ctx.tx.delete(ofmContacts).where(eq(ofmContacts.id, entityId));
    await removeSearchDocument(ctx.tx, ctx.actor.workspaceId, 'ofm_contact', entityId);
    await audit(ctx, { action: 'ofm_contact.import_undone', entityType: 'ofm_contact', entityId, projectId: c.projectId, sensitivity: 'ofm' });
  },
});

interface SaleImportRow {
  accountId: string;
  sourceNamespace: string;
  sourceTransactionId: string;
  occurredAt: string;
  currency: string;
  gross: string | null;
  refund: string | null;
  fee: string | null;
  net: string | null;
  contactId: string | null;
  shiftId: string | null;
  sourceNote: string | null;
}

defineImportDataset<SaleImportRow>({
  key: 'sale_candidates',
  label: 'Sale Candidates',
  permission: 'sale-candidates.write',
  // Financial facts are never revised by an import: duplicates are skipped or blocking.
  duplicatePolicies: ['skip', 'error'],
  columns: [
    { key: 'account', label: 'Account (ID or handle)', type: 'reference', required: true },
    { key: 'source_namespace', label: 'Source', type: 'text', required: true, aliases: ['source', 'platform'] },
    { key: 'source_transaction_id', label: 'Source Transaction ID', type: 'text', required: true, aliases: ['transaction id', 'transaction_id', 'id'] },
    { key: 'occurred_at', label: 'Occurred At', type: 'datetime', required: true, aliases: ['date', 'time'] },
    { key: 'currency', label: 'Currency', type: 'currency', required: true },
    { key: 'gross', label: 'Gross', type: 'amount' },
    { key: 'refund', label: 'Refund', type: 'amount' },
    { key: 'fee', label: 'Fee', type: 'amount' },
    { key: 'net', label: 'Net', type: 'amount' },
    { key: 'contact_external_identifier', label: 'Contact External Identifier', type: 'text' },
    { key: 'shift_id', label: 'Shift ID', type: 'reference' },
    { key: 'source_note', label: 'Source Note', type: 'long_text' },
  ],
  async validate(ctx, row, opts) {
    const errors: ImportIssue[] = [];
    const warnings: ImportIssue[] = [];
    const account = await resolveAccount(ctx, row.account, errors);
    const ns = String(row.source_namespace ?? '').trim().toLowerCase();
    const tx = String(row.source_transaction_id ?? '').trim();
    if (!ns) errors.push({ field: 'source_namespace', code: 'REQUIRED', message: 'Source is required.' });
    if (!tx) errors.push({ field: 'source_transaction_id', code: 'REQUIRED', message: 'Source transaction ID is required for imported sales.' });
    if (!row.occurred_at) errors.push({ field: 'occurred_at', code: 'REQUIRED', message: 'Occurred At is required.' });
    if (!row.currency) errors.push({ field: 'currency', code: 'REQUIRED', message: 'Currency is required.' });
    if (!row.gross && !row.net) errors.push({ field: 'gross', code: 'REQUIRED', message: 'Gross or net amount is required.' });
    if (account && !allowed(ctx, 'sale-candidates.write', { projectId: account.projectId, accountId: account.id }))
      errors.push({ field: 'account', code: 'FORBIDDEN', message: 'You cannot register sales for this account.' });
    let contactId: string | null = null;
    if (account && row.contact_external_identifier) {
      const [c] = await dbOf(ctx)
        .select()
        .from(ofmContacts)
        .where(and(eq(ofmContacts.workspaceId, ctx.actor.workspaceId), eq(ofmContacts.accountId, account.id), eq(ofmContacts.externalIdentifier, String(row.contact_external_identifier).trim())));
      if (!c || !canReadContact(ctx, c)) errors.push({ field: 'contact_external_identifier', code: 'UNKNOWN_CONTACT', message: 'No contact of this account matches.' });
      else contactId = c.id;
    }
    const shiftId = row.shift_id ? String(row.shift_id) : null;
    if (shiftId && !isUuid(shiftId)) errors.push({ field: 'shift_id', code: 'INVALID', message: 'Shift ID must be an ID.' });
    let action: 'create' | 'skip' = 'create';
    if (ns && tx) {
      const dup = await checkSaleDuplicate(ctx, { sourceNamespace: ns, sourceTransactionId: tx });
      if (dup.duplicate) {
        if (opts.duplicatePolicy === 'skip') {
          action = 'skip';
          warnings.push({ field: 'source_transaction_id', code: 'DUPLICATE_SKIPPED', message: 'Already registered — row skipped (revenue is never doubled).' });
        } else errors.push({ field: 'source_transaction_id', code: 'DUPLICATE', message: 'This source transaction is already registered.' });
      }
    }
    return {
      action,
      normalized: {
        accountId: account?.id ?? '',
        sourceNamespace: ns,
        sourceTransactionId: tx,
        occurredAt: String(row.occurred_at ?? ''),
        currency: String(row.currency ?? ''),
        gross: row.gross ? String(row.gross) : null,
        refund: row.refund ? String(row.refund) : null,
        fee: row.fee ? String(row.fee) : null,
        net: row.net ? String(row.net) : null,
        contactId,
        shiftId,
        sourceNote: row.source_note ? String(row.source_note) : null,
      },
      errors,
      warnings,
      dedupeKey: `${ns}:${tx}`,
    };
  },
  async apply(ctx, row) {
    return createSaleCandidate(ctx, {
      accountId: row.accountId,
      sourceNamespace: row.sourceNamespace,
      sourceTransactionId: row.sourceTransactionId,
      manualReference: false,
      occurredAt: new Date(row.occurredAt).toISOString(),
      currency: row.currency,
      gross: row.gross,
      refund: row.refund,
      fee: row.fee,
      net: row.net,
      contactId: row.contactId,
      shiftId: row.shiftId,
      sourceNote: row.sourceNote,
      evidenceAssetIds: [],
      claimedAllocations: [],
    });
  },
  async undo(ctx, entityId) {
    const s = await lockById(ctx, saleCandidates, entityId, 'Sale candidate');
    if (s.state !== 'pending' || s.rowVersion !== 1 || s.financialEntryId)
      throw new AppError('INVALID_STATE', 'The candidate was reviewed or changed; it cannot be removed by undo.', { details: { candidateId: entityId, state: s.state } });
    await ctx.tx.delete(saleCandidates).where(eq(saleCandidates.id, entityId));
    await audit(ctx, { action: 'sale_candidate.import_undone', entityType: 'sale_candidate', entityId, projectId: s.projectId, sensitivity: 'finance' });
  },
});

// ——— Export datasets (classification 'ofm') ———

const PAGE = 500;

defineExportDataset({
  key: 'ofm_shifts',
  label: 'OFM Shifts',
  permission: 'shifts.read.scope',
  classification: 'ofm',
  columns: [
    { key: 'id', label: 'Shift ID', type: 'id', default: true },
    { key: 'project', label: 'Model', type: 'text', default: true },
    { key: 'member', label: 'Member', type: 'text', default: true },
    { key: 'primary_account', label: 'Primary Account', type: 'text', default: true },
    { key: 'scheduled_start', label: 'Scheduled Start (UTC)', type: 'datetime', default: true },
    { key: 'scheduled_end', label: 'Scheduled End (UTC)', type: 'datetime', default: true },
    { key: 'timezone', label: 'Time Zone', type: 'text' },
    { key: 'state', label: 'State', type: 'text', default: true },
    { key: 'report_state', label: 'Report State', type: 'text', default: true },
    { key: 'actual_start', label: 'Actual Start (UTC)', type: 'datetime', default: true },
    { key: 'actual_end', label: 'Actual End (UTC)', type: 'datetime', default: true },
    { key: 'net_hours', label: 'Net Hours (blank = Pending)', type: 'decimal', default: true },
    { key: 'needs_review', label: 'Needs Review', type: 'text' },
    { key: 'corrected_at', label: 'Corrected At (UTC)', type: 'datetime' },
  ],
  filters: [
    { key: 'projectId', label: 'Model', type: 'reference', lookup: 'project' },
    { key: 'membershipId', label: 'Member', type: 'reference' },
    { key: 'from', label: 'From', type: 'date' },
    { key: 'to', label: 'To', type: 'date' },
  ],
  async *rows(ctx, input) {
    requireAnyPermission(ctx, ['shifts.read.scope', 'shifts.read.own']);
    const f = input.filters as { projectId?: string; membershipId?: string; from?: string; to?: string };
    let cursor: { start: Date; id: string } | null = null;
    for (;;) {
      const rows: (typeof shifts.$inferSelect)[] = await ctx.app.db
        .select()
        .from(shifts)
        .where(
          and(
            eq(shifts.workspaceId, ctx.actor.workspaceId),
            shiftVisibility(ctx),
            lte(shifts.createdAt, input.boundAt),
            f.projectId ? eq(shifts.projectId, f.projectId) : undefined,
            f.membershipId ? eq(shifts.membershipId, f.membershipId) : undefined,
            f.from ? sql`${shifts.scheduledEnd} >= ${new Date(f.from)}` : undefined,
            f.to ? sql`${shifts.scheduledStart} < ${new Date(f.to)}` : undefined,
            cursor ? or(gt(shifts.scheduledStart, cursor.start), and(eq(shifts.scheduledStart, cursor.start), gt(shifts.id, cursor.id))) : undefined,
          ),
        )
        .orderBy(asc(shifts.scheduledStart), asc(shifts.id))
        .limit(PAGE);
      if (!rows.length) return;
      const db = ctx.app.db;
      const [refs, accounts, projectsMap, breaks] = [
        await loadMemberRefs(db, ctx.actor.workspaceId, rows.map((r) => r.membershipId)),
        await loadAccountInfos(db, ctx.actor.workspaceId, rows.map((r) => r.primaryAccountId)),
        await loadProjectInfos(db, ctx.actor.workspaceId, rows.map((r) => r.projectId)),
        await db.select().from(shiftBreaks).where(inArray(shiftBreaks.shiftId, rows.map((r) => r.id))),
      ];
      for (const s of rows) {
        const net = shiftNetTime(s.actualStart, s.actualEnd, breaks.filter((b) => b.shiftId === s.id)).netSeconds;
        yield {
          id: s.id,
          project: projectsMap.get(s.projectId)?.name ?? null,
          member: refOrUnknown(refs, s.membershipId)!.displayName,
          primary_account: accounts.get(s.primaryAccountId) ? accountLabel(accounts.get(s.primaryAccountId)!) : null,
          scheduled_start: s.scheduledStart.toISOString(),
          scheduled_end: s.scheduledEnd.toISOString(),
          timezone: s.timezone,
          state: s.state,
          report_state: s.reportState,
          actual_start: s.actualStart?.toISOString() ?? null,
          actual_end: s.actualEnd?.toISOString() ?? null,
          net_hours: netHoursString(net),
          needs_review: s.needsReviewReason,
          corrected_at: s.correctedAt?.toISOString() ?? null,
        };
      }
      const last = rows[rows.length - 1]!;
      cursor = { start: last.scheduledStart, id: last.id };
      if (rows.length < PAGE) return;
    }
  },
});

defineExportDataset({
  key: 'ofm_shift_reports',
  label: 'OFM Shift Reports',
  permission: 'shifts.read.scope',
  classification: 'ofm',
  columns: [
    { key: 'shift_id', label: 'Shift ID', type: 'id', default: true },
    { key: 'member', label: 'Member', type: 'text', default: true },
    { key: 'scheduled_start', label: 'Shift Start (UTC)', type: 'datetime', default: true },
    { key: 'report_state', label: 'Report State', type: 'text', default: true },
    { key: 'version_no', label: 'Version', type: 'integer', default: true },
    { key: 'version_state', label: 'Version State', type: 'text', default: true },
    { key: 'summary', label: 'Summary', type: 'text', default: true },
    { key: 'completed_work', label: 'Completed Work', type: 'text' },
    { key: 'issues', label: 'Issues', type: 'text' },
    { key: 'next_actions', label: 'Next Actions', type: 'text' },
    { key: 'conversations_handled', label: 'Conversations Handled (Manual Report)', type: 'integer' },
    { key: 'follow_ups_completed', label: 'Follow-ups Completed (Manual Report)', type: 'integer' },
    { key: 'content_requests', label: 'Content Requests (Manual Report)', type: 'integer' },
    { key: 'conversion_events', label: 'Conversion Events (Manual Report)', type: 'integer' },
    { key: 'no_open_items', label: 'No Open Items', type: 'boolean' },
    { key: 'submitted_at', label: 'Submitted At (UTC)', type: 'datetime', default: true },
    { key: 'approved_at', label: 'Approved At (UTC)', type: 'datetime', default: true },
  ],
  filters: [
    { key: 'projectId', label: 'Model', type: 'reference', lookup: 'project' },
    { key: 'from', label: 'From', type: 'date' },
    { key: 'to', label: 'To', type: 'date' },
  ],
  async *rows(ctx, input) {
    requireAnyPermission(ctx, ['shifts.read.scope', 'shifts.read.own']);
    const f = input.filters as { projectId?: string; from?: string; to?: string };
    let cursor: { start: Date; id: string } | null = null;
    type Row = { s: typeof shifts.$inferSelect; r: typeof shiftReports.$inferSelect; v: typeof shiftReportVersions.$inferSelect };
    for (;;) {
      const rows: Row[] = await ctx.app.db
        .select({ s: shifts, r: shiftReports, v: shiftReportVersions })
        .from(shiftReports)
        .innerJoin(shifts, eq(shifts.id, shiftReports.shiftId))
        .innerJoin(shiftReportVersions, eq(shiftReportVersions.reportId, shiftReports.id))
        .where(
          and(
            eq(shiftReports.workspaceId, ctx.actor.workspaceId),
            shiftVisibility(ctx),
            lte(shiftReportVersions.createdAt, input.boundAt),
            sql`${shiftReportVersions.state} <> 'draft'`,
            f.projectId ? eq(shifts.projectId, f.projectId) : undefined,
            f.from ? sql`${shifts.scheduledEnd} >= ${new Date(f.from)}` : undefined,
            f.to ? sql`${shifts.scheduledStart} < ${new Date(f.to)}` : undefined,
            cursor ? or(gt(shifts.scheduledStart, cursor.start), and(eq(shifts.scheduledStart, cursor.start), gt(shiftReportVersions.id, cursor.id))) : undefined,
          ),
        )
        .orderBy(asc(shifts.scheduledStart), asc(shiftReportVersions.id))
        .limit(PAGE);
      if (!rows.length) return;
      const refs = await loadMemberRefs(ctx.app.db, ctx.actor.workspaceId, rows.map((x) => x.s.membershipId));
      for (const { s, r, v } of rows)
        yield {
          shift_id: s.id,
          member: refOrUnknown(refs, s.membershipId)!.displayName,
          scheduled_start: s.scheduledStart.toISOString(),
          report_state: r.state,
          version_no: v.versionNo,
          version_state: v.state,
          summary: v.summary,
          completed_work: v.completedWork,
          issues: v.issues,
          next_actions: v.nextActions,
          conversations_handled: v.counts.conversationsHandled,
          follow_ups_completed: v.counts.followUpsCompleted,
          content_requests: v.counts.contentRequests,
          conversion_events: v.counts.conversionEvents,
          no_open_items: v.noOpenItems,
          submitted_at: v.submittedAt?.toISOString() ?? null,
          approved_at: r.approvedVersionId === v.id ? (r.approvedAt?.toISOString() ?? null) : null,
        };
      const last: Row = rows[rows.length - 1]!;
      cursor = { start: last.s.scheduledStart, id: last.v.id };
      if (rows.length < PAGE) return;
    }
  },
});

