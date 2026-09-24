import { and, desc, eq, inArray, isNull, max, sql } from 'drizzle-orm';
import type { ObjectScope } from '@castlane/authorization';
import {
  budgets,
  contentItems,
  contentVersions,
  dealProjects,
  deals,
  directions,
  handovers,
  metricCheckpoints,
  metricObservations,
  projects,
  publications,
  reviews,
  shiftBreaks,
  shifts,
  socialAccounts,
  taskDueRevisions,
  tasks,
  type DbOrTx,
} from '@castlane/database';
import { netHoursString, shiftNetTime, type AutomationFacts } from '@castlane/domain';
import { entityHref } from '@castlane/api-contracts';

/**
 * The record that triggered a rule, reduced to what rules may use: typed facts for conditions,
 * plain-text labels for placeholders, the people rules can address, the scope object used for
 * authorization and the typed links a created task may carry. Loaded without authorization —
 * callers check the rule principal (and, for previews, the requesting member) against `scope`.
 */
export type AutomationRecordType = 'content_item' | 'publication' | 'task' | 'metric_checkpoint' | 'shift' | 'handover' | 'budget' | 'account' | 'deal';

export interface AutomationRecord {
  entityType: AutomationRecordType;
  entityId: string;
  label: string;
  projectIds: string[];
  projectId: string | null;
  accountId: string | null;
  directionIds: string[];
  scope: ObjectScope;
  readPermission: string;
  facts: AutomationFacts;
  texts: { 'entity.title': string; 'project.name': string | null; 'account.label': string | null };
  people: { assignee: string | null; owner: string | null; projectOwner: string | null };
  links: { accountId?: string; contentItemId?: string; publicationId?: string; shiftId?: string; dealId?: string };
  /** When the record itself is a task (task-targeted actions). */
  taskId: string | null;
  href: string;
}

interface ProjectInfo {
  id: string;
  name: string;
  type: string;
  directionId: string;
  ownerMembershipId: string;
}

const projectInfo = async (db: DbOrTx, ws: string, ids: (string | null | undefined)[]): Promise<Map<string, ProjectInfo>> => {
  const list = [...new Set(ids.filter((x): x is string => !!x))];
  if (!list.length) return new Map();
  const rows = await db
    .select({ id: projects.id, name: projects.name, type: projects.type, directionId: projects.directionId, ownerMembershipId: projects.ownerMembershipId })
    .from(projects)
    .where(and(eq(projects.workspaceId, ws), inArray(projects.id, list)));
  return new Map(rows.map((r) => [r.id, r]));
};

const accountInfo = async (db: DbOrTx, ws: string, id: string | null | undefined) => {
  if (!id) return null;
  const [a] = await db
    .select({ id: socialAccounts.id, handle: socialAccounts.handle, displayName: socialAccounts.displayName, platform: socialAccounts.platform, projectId: socialAccounts.projectId, status: socialAccounts.status, ownerMembershipId: socialAccounts.ownerMembershipId })
    .from(socialAccounts)
    .where(and(eq(socialAccounts.workspaceId, ws), eq(socialAccounts.id, id)));
  return a ?? null;
};

export const accountLabelOf = (a: { handle: string | null; displayName: string | null; platform: string }) => (a.handle ? `@${a.handle}` : (a.displayName ?? a.platform));

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

const projectFacts = (p: ProjectInfo | undefined): AutomationFacts => ({
  'project.id': p?.id ?? null,
  'project.type': p?.type ?? null,
  'direction.id': p?.directionId ?? null,
});

const base = (
  ws: string,
  entityType: AutomationRecordType,
  entityId: string,
  label: string,
  p: ProjectInfo | undefined,
  extra: Partial<AutomationRecord> & Pick<AutomationRecord, 'scope' | 'readPermission' | 'facts'>,
): AutomationRecord => ({
  entityType,
  entityId,
  label,
  projectIds: p ? [p.id] : [],
  projectId: p?.id ?? null,
  accountId: null,
  directionIds: p ? [p.directionId] : [],
  texts: { 'entity.title': label, 'project.name': p?.name ?? null, 'account.label': null },
  people: { assignee: null, owner: null, projectOwner: p?.ownerMembershipId ?? null },
  links: {},
  taskId: null,
  href: entityHref(ws, entityType, entityId, { projectId: p?.id ?? null }),
  ...extra,
  facts: { ...projectFacts(p), ...extra.facts },
});

const hoursBetween = (from: Date, to: Date) => Math.floor((to.getTime() - from.getTime()) / 3_600_000);

export const loadContentRecord = async (db: DbOrTx, ws: string, id: string): Promise<AutomationRecord | null> => {
  const [c] = await db.select().from(contentItems).where(and(eq(contentItems.workspaceId, ws), eq(contentItems.id, id)));
  if (!c || c.deletedAt) return null;
  const p = (await projectInfo(db, ws, [c.projectId])).get(c.projectId);
  const [lastReview] = await db
    .select({ submittedAt: reviews.submittedAt })
    .from(reviews)
    .where(and(eq(reviews.workspaceId, ws), eq(reviews.subjectId, c.id)))
    .orderBy(desc(reviews.submittedAt))
    .limit(1);
  return base(ws, 'content_item', c.id, c.title, p, {
    scope: { objectType: 'content_item', objectId: c.id, projectId: c.projectId, assignedMembershipIds: [c.ownerMembershipId, c.reviewerMembershipId], ownerMembershipId: c.ownerMembershipId },
    readPermission: 'content.read',
    facts: {
      'content.format': c.format,
      'content.stage': c.stage,
      'content.owner': c.ownerMembershipId,
      'content.reviewer': c.reviewerMembershipId,
      'content.tags': c.tags,
      'content.dueAt': iso(c.dueAt),
      'content.submittedAt': iso(lastReview?.submittedAt),
    },
    people: { assignee: c.ownerMembershipId, owner: c.ownerMembershipId, projectOwner: p?.ownerMembershipId ?? null },
    links: { contentItemId: c.id },
  });
};

/** Content triggers may arrive as content, version or review events; all resolve to the content item. */
export const contentIdFromEvent = async (db: DbOrTx, ws: string, entityType: string | null, entityId: string | null): Promise<string | null> => {
  if (!entityId) return null;
  if (entityType === 'content_item' || entityType === 'content') return entityId;
  if (entityType === 'content_version') {
    const [v] = await db.select({ id: contentVersions.contentItemId }).from(contentVersions).where(and(eq(contentVersions.workspaceId, ws), eq(contentVersions.id, entityId)));
    return v?.id ?? null;
  }
  if (entityType === 'review') {
    const [r] = await db.select({ targetType: reviews.targetType, subjectId: reviews.subjectId }).from(reviews).where(and(eq(reviews.workspaceId, ws), eq(reviews.id, entityId)));
    return r && r.targetType === 'content_version' ? r.subjectId : null;
  }
  return null;
};

export const loadPublicationRecord = async (db: DbOrTx, ws: string, id: string): Promise<AutomationRecord | null> => {
  const [pub] = await db.select().from(publications).where(and(eq(publications.workspaceId, ws), eq(publications.id, id)));
  if (!pub || pub.deletedAt) return null;
  const [p, a, c] = [(await projectInfo(db, ws, [pub.projectId])).get(pub.projectId), await accountInfo(db, ws, pub.accountId), (await db.select({ title: contentItems.title }).from(contentItems).where(eq(contentItems.id, pub.contentItemId)))[0]];
  const label = c?.title ? `${c.title}${a ? ` · ${accountLabelOf(a)}` : ''}` : 'Publication';
  return base(ws, 'publication', pub.id, label, p, {
    accountId: pub.accountId,
    scope: { objectType: 'publication', objectId: pub.id, projectId: pub.projectId, accountId: pub.accountId, assignedMembershipIds: [pub.ownerMembershipId], ownerMembershipId: pub.ownerMembershipId },
    readPermission: 'publications.read',
    facts: {
      'publication.status': pub.status,
      'publication.format': pub.format,
      'publication.owner': pub.ownerMembershipId,
      'publication.tags': pub.descriptiveTags,
      'publication.actualPublishedAt': iso(pub.actualPublishedAt),
      'account.id': pub.accountId,
      'account.platform': a?.platform ?? null,
    },
    texts: { 'entity.title': label, 'project.name': p?.name ?? null, 'account.label': a ? accountLabelOf(a) : null },
    people: { assignee: pub.ownerMembershipId, owner: pub.ownerMembershipId, projectOwner: p?.ownerMembershipId ?? null },
    links: { publicationId: pub.id, accountId: pub.accountId, contentItemId: pub.contentItemId },
  });
};

const OPEN_TASK = new Set(['draft', 'backlog', 'ready', 'in_progress', 'in_review']);

export const loadTaskRecord = async (db: DbOrTx, ws: string, id: string, now: Date): Promise<AutomationRecord | null> => {
  const [t] = await db.select().from(tasks).where(and(eq(tasks.workspaceId, ws), eq(tasks.id, id)));
  if (!t || t.deletedAt) return null;
  const p = (await projectInfo(db, ws, [t.projectId])).get(t.projectId);
  const a = await accountInfo(db, ws, t.accountId);
  const [rev] = await db.select({ rev: max(taskDueRevisions.deadlineRevision) }).from(taskDueRevisions).where(eq(taskDueRevisions.taskId, t.id));
  const overdue = t.dueAt && OPEN_TASK.has(t.status) ? Math.max(0, hoursBetween(t.dueAt, now)) : t.dueAt ? 0 : null;
  return base(ws, 'task', t.id, t.title, p, {
    accountId: t.accountId,
    scope: { objectType: 'task', objectId: t.id, projectId: t.projectId, accountId: t.accountId, assignedMembershipIds: [t.assigneeMembershipId, t.reviewerMembershipId], createdByUserId: t.createdBy },
    readPermission: 'tasks.read',
    facts: {
      'task.status': t.status,
      'task.priority': t.priority,
      'task.assignee': t.assigneeMembershipId,
      'task.reviewer': t.reviewerMembershipId,
      'task.tags': t.tags,
      'task.dueAt': iso(t.dueAt),
      'task.hoursOverdue': overdue,
      'task.blocked': !!t.blockedAt,
      'task.source': t.source,
      'task.deadlineRevision': Number(rev?.rev ?? 0),
    },
    texts: { 'entity.title': t.title, 'project.name': p?.name ?? null, 'account.label': a ? accountLabelOf(a) : null },
    people: { assignee: t.assigneeMembershipId, owner: t.reviewerMembershipId ?? p?.ownerMembershipId ?? null, projectOwner: p?.ownerMembershipId ?? null },
    links: t.accountId ? { accountId: t.accountId } : {},
    taskId: t.id,
  });
};

export const loadCheckpointRecord = async (db: DbOrTx, ws: string, id: string): Promise<AutomationRecord | null> => {
  const [c] = await db.select().from(metricCheckpoints).where(and(eq(metricCheckpoints.workspaceId, ws), eq(metricCheckpoints.id, id)));
  if (!c) return null;
  const p = (await projectInfo(db, ws, [c.projectId])).get(c.projectId);
  const a = await accountInfo(db, ws, c.accountId);
  const label = `Metrics checkpoint ${c.checkpointKey}${a ? ` · ${accountLabelOf(a)}` : ''}`;
  return base(ws, 'metric_checkpoint', c.id, label, p, {
    accountId: c.accountId,
    scope: { objectType: 'metric_checkpoint', objectId: c.id, projectId: c.projectId, accountId: c.accountId, assignedMembershipIds: [c.assigneeMembershipId] },
    readPermission: 'metrics.read',
    facts: {
      'checkpoint.key': c.checkpointKey,
      'checkpoint.state': c.state,
      'checkpoint.assignee': c.assigneeMembershipId,
      'checkpoint.expectedAt': c.expectedAt.toISOString(),
      'account.id': c.accountId,
      'account.platform': a?.platform ?? null,
    },
    texts: { 'entity.title': label, 'project.name': p?.name ?? null, 'account.label': a ? accountLabelOf(a) : null },
    people: { assignee: c.assigneeMembershipId, owner: a?.ownerMembershipId ?? null, projectOwner: p?.ownerMembershipId ?? null },
    links: { accountId: c.accountId, ...(c.publicationId ? { publicationId: c.publicationId } : {}) },
  });
};

export const loadShiftRecord = async (db: DbOrTx, ws: string, id: string): Promise<AutomationRecord | null> => {
  const [s] = await db.select().from(shifts).where(and(eq(shifts.workspaceId, ws), eq(shifts.id, id)));
  if (!s) return null;
  const p = (await projectInfo(db, ws, [s.projectId])).get(s.projectId);
  const a = await accountInfo(db, ws, s.primaryAccountId);
  const breaks = await db.select({ startedAt: shiftBreaks.startedAt, endedAt: shiftBreaks.endedAt }).from(shiftBreaks).where(eq(shiftBreaks.shiftId, s.id));
  const net = shiftNetTime(s.actualStart, s.actualEnd, breaks);
  const label = `Shift${a ? ` · ${accountLabelOf(a)}` : ''} · ${s.scheduledStart.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  const hours = netHoursString(net.netSeconds);
  return base(ws, 'shift', s.id, label, p, {
    accountId: s.primaryAccountId,
    scope: { objectType: 'shift', objectId: s.id, projectId: s.projectId, accountId: s.primaryAccountId, assignedMembershipIds: [s.membershipId, s.supervisorMembershipId], ownerMembershipId: s.membershipId },
    readPermission: 'shifts.read.scope',
    facts: {
      'shift.member': s.membershipId,
      'shift.state': s.state,
      'shift.reportState': s.reportState,
      'shift.netHours': hours === null ? null : Number(hours),
      'shift.actualEnd': iso(s.actualEnd),
      'account.id': s.primaryAccountId,
      'account.platform': a?.platform ?? null,
    },
    texts: { 'entity.title': label, 'project.name': p?.name ?? null, 'account.label': a ? accountLabelOf(a) : null },
    people: { assignee: s.membershipId, owner: s.supervisorMembershipId ?? p?.ownerMembershipId ?? null, projectOwner: p?.ownerMembershipId ?? null },
    links: { shiftId: s.id, accountId: s.primaryAccountId },
  });
};

export const loadHandoverRecord = async (db: DbOrTx, ws: string, id: string): Promise<AutomationRecord | null> => {
  const [h] = await db
    .select({ h: handovers, projectId: shifts.projectId, member: shifts.membershipId, supervisor: shifts.supervisorMembershipId })
    .from(handovers)
    .innerJoin(shifts, eq(shifts.id, handovers.fromShiftId))
    .where(and(eq(handovers.workspaceId, ws), eq(handovers.id, id)));
  if (!h) return null;
  const p = (await projectInfo(db, ws, [h.projectId])).get(h.projectId);
  const a = await accountInfo(db, ws, h.h.accountId);
  const label = `Handover${a ? ` · ${accountLabelOf(a)}` : ''}`;
  return base(ws, 'handover', h.h.id, label, p, {
    accountId: h.h.accountId,
    scope: { objectType: 'handover', objectId: h.h.id, projectId: h.projectId, accountId: h.h.accountId, assignedMembershipIds: [h.h.recipientMembershipId, h.member, h.supervisor] },
    readPermission: 'handovers.read',
    facts: {
      'handover.state': h.h.state,
      'handover.recipient': h.h.recipientMembershipId,
      'handover.submittedAt': iso(h.h.submittedAt),
      'handover.noOpenItems': h.h.noOpenItems,
      'account.id': h.h.accountId,
      'account.platform': a?.platform ?? null,
    },
    texts: { 'entity.title': label, 'project.name': p?.name ?? null, 'account.label': a ? accountLabelOf(a) : null },
    people: { assignee: h.h.recipientMembershipId, owner: h.supervisor ?? p?.ownerMembershipId ?? null, projectOwner: p?.ownerMembershipId ?? null },
    links: { accountId: h.h.accountId, shiftId: h.h.fromShiftId },
  });
};

export const loadBudgetRecord = async (db: DbOrTx, ws: string, id: string, payload: Record<string, unknown> = {}): Promise<AutomationRecord | null> => {
  const [b] = await db.select().from(budgets).where(and(eq(budgets.workspaceId, ws), eq(budgets.id, id)));
  if (!b) return null;
  const p = b.scopeType === 'project' && b.scopeId ? (await projectInfo(db, ws, [b.scopeId])).get(b.scopeId) : undefined;
  const threshold = typeof payload.threshold === 'number' ? payload.threshold : null;
  const directionIds = b.scopeType === 'direction' && b.scopeId ? [b.scopeId] : p ? [p.directionId] : [];
  const r = base(ws, 'budget', b.id, b.name, p, {
    scope: { objectType: 'budget', objectId: b.id, projectId: b.scopeType === 'project' ? b.scopeId : null, directionId: b.scopeType === 'direction' ? b.scopeId : null, ownerMembershipId: b.ownerMembershipId },
    readPermission: 'budgets.read',
    facts: { 'budget.scopeType': b.scopeType, 'budget.threshold': threshold, 'budget.owner': b.ownerMembershipId },
    people: { assignee: b.ownerMembershipId, owner: b.ownerMembershipId, projectOwner: p?.ownerMembershipId ?? null },
  });
  return { ...r, directionIds };
};

export const loadAccountRecord = async (db: DbOrTx, ws: string, id: string, now: Date): Promise<AutomationRecord | null> => {
  const a = await accountInfo(db, ws, id);
  if (!a) return null;
  const p = (await projectInfo(db, ws, [a.projectId])).get(a.projectId);
  const [last] = await db
    .select({ observedAt: max(metricObservations.observedAt) })
    .from(metricObservations)
    .where(and(eq(metricObservations.workspaceId, ws), eq(metricObservations.accountId, id), sql`${metricObservations.qualityState} NOT IN ('superseded', 'rejected', 'pending_correction')`));
  const lastAt = last?.observedAt ?? null;
  const label = accountLabelOf(a);
  return base(ws, 'account', a.id, label, p, {
    accountId: a.id,
    scope: { objectType: 'account', objectId: a.id, projectId: a.projectId, accountId: a.id, ownerMembershipId: a.ownerMembershipId },
    readPermission: 'accounts.read',
    facts: {
      'account.id': a.id,
      'account.platform': a.platform,
      'account.status': a.status,
      'account.owner': a.ownerMembershipId,
      'account.lastObservedAt': iso(lastAt),
      // Never observed → Unknown (not 0 and not "infinitely stale").
      'account.daysSinceObservation': lastAt ? Math.floor((now.getTime() - lastAt.getTime()) / 86_400_000) : null,
    },
    texts: { 'entity.title': label, 'project.name': p?.name ?? null, 'account.label': label },
    people: { assignee: a.ownerMembershipId, owner: a.ownerMembershipId, projectOwner: p?.ownerMembershipId ?? null },
    links: { accountId: a.id },
  });
};

export const loadDealRecord = async (db: DbOrTx, ws: string, id: string, payload: Record<string, unknown> = {}): Promise<AutomationRecord | null> => {
  const [d] = await db.select().from(deals).where(and(eq(deals.workspaceId, ws), eq(deals.id, id)));
  if (!d) return null;
  const links = await db.select({ projectId: dealProjects.projectId }).from(dealProjects).where(and(eq(dealProjects.workspaceId, ws), eq(dealProjects.dealId, id))).orderBy(dealProjects.createdAt);
  const infos = await projectInfo(db, ws, links.map((l) => l.projectId));
  const first = links[0] ? infos.get(links[0].projectId) : undefined;
  const r = base(ws, 'deal', d.id, d.title, first, {
    scope: { objectType: 'deal', objectId: d.id, projectId: first?.id ?? null, ownerMembershipId: d.ownerMembershipId, assignedMembershipIds: [d.ownerMembershipId] },
    readPermission: 'deals.read',
    // Event triggers see the stage change they were raised for, not a later stage.
    facts: { 'deal.stage': typeof payload.to === 'string' ? payload.to : d.stage, 'deal.fromStage': typeof payload.from === 'string' ? payload.from : null, 'deal.owner': d.ownerMembershipId },
    people: { assignee: d.ownerMembershipId, owner: d.ownerMembershipId, projectOwner: first?.ownerMembershipId ?? null },
    links: { dealId: d.id },
  });
  return { ...r, projectIds: links.map((l) => l.projectId), directionIds: [...new Set([...infos.values()].map((i) => i.directionId))] };
};

export const loadAutomationRecord = async (
  db: DbOrTx,
  ws: string,
  entityType: string,
  entityId: string,
  now: Date,
  payload: Record<string, unknown> = {},
): Promise<AutomationRecord | null> => {
  switch (entityType) {
    case 'content_item':
      return loadContentRecord(db, ws, entityId);
    case 'publication':
      return loadPublicationRecord(db, ws, entityId);
    case 'task':
      return loadTaskRecord(db, ws, entityId, now);
    case 'metric_checkpoint':
      return loadCheckpointRecord(db, ws, entityId);
    case 'shift':
      return loadShiftRecord(db, ws, entityId);
    case 'handover':
      return loadHandoverRecord(db, ws, entityId);
    case 'budget':
      return loadBudgetRecord(db, ws, entityId, payload);
    case 'account':
      return loadAccountRecord(db, ws, entityId, now);
    case 'deal':
      return loadDealRecord(db, ws, entityId, payload);
    default:
      return null;
  }
};

export interface RuleScopeLike {
  scopeType: 'workspace' | 'direction' | 'project' | 'account';
  scopeId: string | null;
}

/** Is the record inside the rule's declared scope? */
export const recordInRuleScope = (rule: RuleScopeLike, r: Pick<AutomationRecord, 'projectIds' | 'accountId' | 'directionIds'>): boolean => {
  switch (rule.scopeType) {
    case 'workspace':
      return true;
    case 'direction':
      return !!rule.scopeId && r.directionIds.includes(rule.scopeId);
    case 'project':
      return !!rule.scopeId && r.projectIds.includes(rule.scopeId);
    case 'account':
      return !!rule.scopeId && r.accountId === rule.scopeId;
  }
};

/** Label of a rule scope target (names are shown only to members who manage automations). */
export const scopeLabels = async (db: DbOrTx, ws: string, rules: RuleScopeLike[]): Promise<Map<string, string>> => {
  const out = new Map<string, string>();
  const ids = (t: RuleScopeLike['scopeType']) => [...new Set(rules.filter((r) => r.scopeType === t && r.scopeId).map((r) => r.scopeId!))];
  const d = ids('direction');
  const p = ids('project');
  const a = ids('account');
  if (d.length) for (const r of await db.select({ id: directions.id, name: directions.name }).from(directions).where(and(eq(directions.workspaceId, ws), inArray(directions.id, d)))) out.set(r.id, r.name);
  if (p.length) for (const r of await db.select({ id: projects.id, name: projects.name }).from(projects).where(and(eq(projects.workspaceId, ws), inArray(projects.id, p)))) out.set(r.id, r.name);
  if (a.length)
    for (const r of await db
      .select({ id: socialAccounts.id, handle: socialAccounts.handle, displayName: socialAccounts.displayName, platform: socialAccounts.platform })
      .from(socialAccounts)
      .where(and(eq(socialAccounts.workspaceId, ws), inArray(socialAccounts.id, a))))
      out.set(r.id, accountLabelOf(r));
  return out;
};

export const scopeLabelOf = (rule: RuleScopeLike, labels: Map<string, string>) =>
  rule.scopeType === 'workspace' ? 'Whole workspace' : (labels.get(rule.scopeId ?? '') ?? 'Unavailable record');

/** Resolve a rule scope (project → direction, account → project/direction) for authorization checks. */
export const ruleScopeObject = async (db: DbOrTx, ws: string, rule: RuleScopeLike): Promise<ObjectScope | undefined> => {
  if (rule.scopeType === 'workspace' || !rule.scopeId) return undefined;
  if (rule.scopeType === 'direction') return { objectType: 'direction', objectId: rule.scopeId, directionId: rule.scopeId };
  if (rule.scopeType === 'project') {
    const [p] = await db.select({ directionId: projects.directionId }).from(projects).where(and(eq(projects.workspaceId, ws), eq(projects.id, rule.scopeId)));
    return { objectType: 'project', objectId: rule.scopeId, projectId: rule.scopeId, directionId: p?.directionId ?? null };
  }
  const [a] = await db
    .select({ projectId: socialAccounts.projectId, directionId: projects.directionId })
    .from(socialAccounts)
    .innerJoin(projects, eq(projects.id, socialAccounts.projectId))
    .where(and(eq(socialAccounts.workspaceId, ws), eq(socialAccounts.id, rule.scopeId)));
  return { objectType: 'account', objectId: rule.scopeId, accountId: rule.scopeId, projectId: a?.projectId ?? null, directionId: a?.directionId ?? null };
};

/** Does the scope target exist in the workspace? */
export const scopeTargetExists = async (db: DbOrTx, ws: string, rule: RuleScopeLike): Promise<boolean> => {
  if (rule.scopeType === 'workspace') return !rule.scopeId;
  if (!rule.scopeId) return false;
  const table = rule.scopeType === 'direction' ? directions : rule.scopeType === 'project' ? projects : socialAccounts;
  const [r] = await db.select({ id: table.id }).from(table).where(and(eq(table.workspaceId, ws), eq(table.id, rule.scopeId)));
  return !!r;
};

void isNull;
