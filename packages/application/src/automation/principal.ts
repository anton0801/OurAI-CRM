import { and, eq } from 'drizzle-orm';
import { can, type AccessGrant, type AccessSnapshot, type ObjectScope } from '@castlane/authorization';
import { automationRules, memberships, projects, users, workspaces, type DbOrTx } from '@castlane/database';
import { newId, type AutomationActionType } from '@castlane/domain';
import type { AutomationActionInput, AutomationRuleConfig } from '@castlane/api-contracts';
import { loadAccessSnapshot } from '../core/access';
import type { AppServices, Causation, QueryContext } from '../core/context';
import { triggerDef } from './catalog';
import { ruleScopeObject, type RuleScopeLike } from './records';

type RuleRow = typeof automationRules.$inferSelect;

/** Read permission the rule owner needs for the records of a trigger. */
export const RECORD_READ_PERMISSION: Record<string, string> = {
  content_item: 'content.read',
  publication: 'publications.read',
  task: 'tasks.read',
  metric_checkpoint: 'metrics.read',
  shift: 'shifts.read.scope',
  handover: 'handovers.read',
  budget: 'budgets.read',
  account: 'accounts.read',
  deal: 'deals.read',
};

const assigns = (ref: { kind: string } | undefined) => !!ref && ref.kind !== 'rule_owner';

/** Permissions one action needs (checked for the rule owner inside the rule scope). */
export const actionPermissions = (a: AutomationActionInput): string[] => {
  switch (a.type) {
    case 'create_task':
      return ['tasks.create', ...(assigns(a.params.assignee) ? ['tasks.assign'] : [])];
    case 'create_task_from_template':
      return ['tasks.create'];
    case 'assign_member':
      return ['tasks.assign'];
    case 'add_checklist_item':
    case 'add_tag':
    case 'set_field':
      return ['tasks.edit'];
    case 'create_checkpoint':
      return ['metrics.write'];
    case 'notify':
      return [];
    case 'request_internal_approval':
      return ['tasks.create', ...(assigns(a.params.approver) ? ['tasks.assign'] : [])];
    case 'create_incident':
      return ['incidents.write'];
  }
};

export const requiredPermissions = (config: AutomationRuleConfig): string[] => {
  const t = triggerDef(config.trigger.event);
  const read = t?.entityType ? [RECORD_READ_PERMISSION[t.entityType]!] : [];
  return [...new Set([...read, ...config.actions.flatMap(actionPermissions)])];
};

/** Fixed projects referenced by actions (they must lie inside the rule scope). */
export const fixedProjectIds = (config: AutomationRuleConfig): string[] =>
  [
    ...new Set(
      config.actions
        .map((a) => (a.type === 'create_task' || a.type === 'create_task_from_template' ? a.params.projectId : null))
        .filter((x): x is string => !!x),
    ),
  ];

export interface AuthorityGap {
  permission: string;
  where: 'scope' | 'project';
  projectId?: string;
}

/**
 * Does `access` hold every permission the rule needs over its whole declared scope (and on each
 * fixed project)? Used for the owner (execution principal) and for the member enabling the rule.
 */
export const authorityGaps = async (db: DbOrTx, ws: string, rule: RuleScopeLike, config: AutomationRuleConfig, access: AccessSnapshot): Promise<AuthorityGap[]> => {
  const scope = await ruleScopeObject(db, ws, rule);
  const gaps: AuthorityGap[] = [];
  for (const p of requiredPermissions(config)) if (!can(access, p, scope)) gaps.push({ permission: p, where: 'scope' });
  for (const projectId of fixedProjectIds(config)) {
    const perms = config.actions.filter((a) => (a.type === 'create_task' || a.type === 'create_task_from_template') && a.params.projectId === projectId).flatMap(actionPermissions);
    for (const p of new Set(perms)) if (!can(access, p, { projectId })) gaps.push({ permission: p, where: 'project', projectId });
  }
  return gaps;
};

export const describeGaps = (gaps: AuthorityGap[]) => [...new Set(gaps.map((g) => g.permission))].join(', ');

/**
 * Intersection of the owner's rights with the rule scope (§19 execution principal): grants that
 * reach beyond the scope are narrowed to it; grants that cannot be bounded (assigned objects, own
 * records) are dropped. Owner status is not inherited — the owner role is narrowed like any grant.
 */
export const narrowAccess = (s: AccessSnapshot, rule: RuleScopeLike): AccessSnapshot => {
  // A workspace rule keeps every grant (the Owner role grant still carries all permissions), but never
  // the Owner status itself: Owner-only exceptions are never exercised implicitly by an automation.
  if (rule.scopeType === 'workspace' || !rule.scopeId) return { ...s, isOwner: false };
  const R = { scopeType: rule.scopeType, scopeId: rule.scopeId } as const;
  const dirOf = (projectId: string | null | undefined) => (projectId ? (s.projectDirection.get(projectId) ?? null) : null);
  const projectOfAccount = (accountId: string) => s.accountProject.get(accountId) ?? null;
  const projectInScope = (projectId: string) =>
    rule.scopeType === 'project' ? projectId === rule.scopeId : rule.scopeType === 'direction' ? dirOf(projectId) === rule.scopeId : false;
  const accountInScope = (accountId: string) => (rule.scopeType === 'account' ? accountId === rule.scopeId : projectInScope(projectOfAccount(accountId) ?? ''));
  const scopeProject = rule.scopeType === 'project' ? rule.scopeId : rule.scopeType === 'account' ? projectOfAccount(rule.scopeId) : null;
  const scopeDirection = rule.scopeType === 'direction' ? rule.scopeId : dirOf(scopeProject);
  const grants: AccessGrant[] = [];
  for (const g of s.grants) {
    const narrowed = { ...g, ...R } as AccessGrant;
    switch (g.scopeType) {
      case 'workspace':
        grants.push(narrowed);
        break;
      case 'direction':
        if (g.scopeId && g.scopeId === scopeDirection) grants.push(narrowed);
        break;
      case 'project':
        if (g.scopeId && (rule.scopeType === 'direction' ? dirOf(g.scopeId) === rule.scopeId : g.scopeId === scopeProject)) grants.push(rule.scopeType === 'direction' ? g : narrowed);
        break;
      case 'account':
        if (g.scopeId && accountInScope(g.scopeId)) grants.push(g);
        break;
      case 'assigned_projects':
        if (rule.scopeType === 'direction') grants.push(g);
        else if (scopeProject && s.assignedProjectIds.has(scopeProject)) grants.push(narrowed);
        break;
      case 'assigned_accounts':
        if (rule.scopeType === 'account') {
          if (s.assignedAccountIds.has(rule.scopeId)) grants.push(narrowed);
        } else grants.push(g);
        break;
      default:
        // assigned_object / own_records cannot be bounded to a project scope.
        break;
    }
  }
  return {
    ...s,
    isOwner: false,
    grants,
    assignedProjectIds: new Set([...s.assignedProjectIds].filter(projectInScope)),
    assignedAccountIds: new Set([...s.assignedAccountIds].filter(accountInScope)),
  };
};

export type PrincipalResult =
  | { ok: true; ctx: QueryContext; ownerAccess: AccessSnapshot; ownerName: string }
  | { ok: false; problem: 'needs_owner' | 'owner_inactive' };

/**
 * The execution principal of a rule: an automation actor carrying the owner's identity (for
 * audit) and the owner's current rights narrowed to the rule scope. Rights are re-read now, so a
 * revoked owner can never act through a rule.
 */
export const rulePrincipal = async (
  app: AppServices,
  rule: Pick<RuleRow, 'id' | 'workspaceId' | 'name' | 'ownerMembershipId' | 'scopeType' | 'scopeId'>,
  opts: { causation?: Causation; requestId?: string; db?: DbOrTx } = {},
): Promise<PrincipalResult> => {
  if (!rule.ownerMembershipId) return { ok: false, problem: 'needs_owner' };
  const db = opts.db ?? app.db;
  const [m] = await db
    .select({ userId: memberships.userId, status: memberships.status, name: users.displayName, tz: workspaces.timezone })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .where(and(eq(memberships.workspaceId, rule.workspaceId), eq(memberships.id, rule.ownerMembershipId)));
  if (!m || m.status !== 'active') return { ok: false, problem: 'owner_inactive' };
  const access = await loadAccessSnapshot(app.db, rule.workspaceId, m.userId, app.clock.now());
  if (!access || access.membershipStatus !== 'active') return { ok: false, problem: 'owner_inactive' };
  const ctx: QueryContext = {
    app,
    actor: {
      kind: 'automation',
      userId: m.userId,
      membershipId: rule.ownerMembershipId,
      workspaceId: rule.workspaceId,
      displayName: `Automation “${rule.name}” (owner ${m.name})`,
      access: narrowAccess(access, rule),
      timezone: m.tz,
    },
    request: { requestId: opts.requestId ?? `auto_${newId().slice(0, 8)}`, source: 'automation', causation: opts.causation },
  };
  return { ok: true, ctx, ownerAccess: access, ownerName: m.name };
};

export const scopeContainsProject = async (db: DbOrTx, ws: string, rule: RuleScopeLike, projectId: string): Promise<boolean> => {
  if (rule.scopeType === 'workspace') return true;
  const obj: ObjectScope | undefined = await ruleScopeObject(db, ws, rule);
  if (rule.scopeType === 'project') return projectId === rule.scopeId;
  if (rule.scopeType === 'account') return projectId === obj?.projectId;
  const [p] = await db.select({ directionId: projects.directionId }).from(projects).where(and(eq(projects.workspaceId, ws), eq(projects.id, projectId)));
  return !!p && p.directionId === rule.scopeId;
};

export type { AutomationActionType };
