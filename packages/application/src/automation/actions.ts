import { and, eq, isNull } from 'drizzle-orm';
import { automationActionEffects, checkpointPolicies, metricCheckpoints, projects, tasks, templateVersions, type DbOrTx } from '@castlane/database';
import { AppError, DateTime, isAppError, newId, renderAutomationText } from '@castlane/domain';
import type { AutomationActionInput, AutomationPersonRef, AutomationRuleConfig, TaskCreateBody } from '@castlane/api-contracts';
import { authorizeObject } from '../core/access';
import { audit } from '../core/audit';
import type { CommandContext } from '../core/context';
import { emit } from '../core/events';
import { loadMemberRefs } from '../core/members';
import { notify } from '../core/notify';
import { stamp } from '../core/rows';
import { createIncident } from '../platform/incidents';
import { createTask, updateTask } from '../work/tasks';
import { addChecklistItem } from '../work/task-structure';
import { applyTaskTemplate } from '../work/templates';
import { loadLinkedInfo, memberCan, type LinkType } from '../work/shared';
import type { TriggerDefinition } from './catalog';
import { scopeContainsProject } from './principal';
import type { AutomationRecord, RuleScopeLike } from './records';

/**
 * Action execution. Every action runs through the owning module's use case with the rule
 * principal (owner ∩ scope), inside its own savepoint, and claims an effect key
 * (event + rule version + action index) so a retry or a duplicated delivery produces exactly one
 * observable effect (T140). Nothing here can approve, post finance, change roles, delete or send
 * an external message.
 */

export interface ActionEnv {
  rule: RuleScopeLike & { id: string; name: string; ownerMembershipId: string | null };
  config: AutomationRuleConfig;
  trigger: TriggerDefinition;
  record: AutomationRecord | null;
  /** `${eventId}:${ruleVersionId}` — effect keys append the action index. */
  effectBase: string;
  runId: string | null;
  zone: string;
  now: Date;
  dryRun: boolean;
}

export interface ActionOutcome {
  index: number;
  type: string;
  ok: boolean;
  skipped?: boolean;
  entityType?: string | null;
  entityId?: string | null;
  preview: string;
  error?: string | null;
  note?: string | null;
  /** Tasks/notifications created (per-root budget). */
  effects: number;
  /** The rule principal was refused (owner lost rights) — the rule must pause. */
  authFailure?: boolean;
}

interface HandlerResult {
  entityType: string | null;
  entityId: string | null;
  preview: string;
  note?: string | null;
  skipped?: boolean;
  /** Countable effects (tasks, notifications) for the effect table. */
  effects: { entityType: 'task' | 'notification'; entityId: string | null; key: string }[];
}

const fail = (message: string) => new AppError('VALIDATION_FAILED', message);

const fmt = (d: Date, zone: string) => `${DateTime.fromJSDate(d, { zone }).toFormat('d LLL yyyy HH:mm')} (${zone})`;

const texts = (env: ActionEnv) => ({
  ...(env.record?.texts ?? {}),
  'trigger.label': env.trigger.label,
  'rule.name': env.rule.name,
  date: DateTime.fromJSDate(env.now, { zone: env.zone }).toISODate(),
});

const render = (env: ActionEnv, template: string, max: number) => renderAutomationText(template, texts(env), max);

const projectRow = async (db: DbOrTx, ws: string, id: string) => {
  const [p] = await db.select({ id: projects.id, name: projects.name, ownerMembershipId: projects.ownerMembershipId }).from(projects).where(and(eq(projects.workspaceId, ws), eq(projects.id, id)));
  return p ?? null;
};

const resolvePerson = async (c: CommandContext, env: ActionEnv, ref: AutomationPersonRef | undefined, projectId: string | null): Promise<string | null> => {
  if (!ref) return null;
  switch (ref.kind) {
    case 'member':
      return ref.membershipId ?? null;
    case 'entity_assignee':
      return env.record?.people.assignee ?? null;
    case 'entity_owner':
      return env.record?.people.owner ?? null;
    case 'rule_owner':
      return env.rule.ownerMembershipId;
    case 'project_owner': {
      if (projectId && projectId !== env.record?.projectId) return (await projectRow(c.tx, c.actor.workspaceId, projectId))?.ownerMembershipId ?? null;
      return env.record?.people.projectOwner ?? null;
    }
  }
};

const nameOf = async (c: CommandContext, id: string | null) => (id ? ((await loadMemberRefs(c.tx, c.actor.workspaceId, [id])).get(id)?.displayName ?? 'Unknown member') : null);

/** The project a created task goes to: the chosen one or the record's; always inside the rule scope. */
const targetProject = async (c: CommandContext, env: ActionEnv, fixed: string | null | undefined) => {
  const projectId = fixed ?? env.record?.projectId ?? null;
  if (!projectId) throw fail('Choose a project for this action: the trigger has no project of its own.');
  if (!(await scopeContainsProject(c.tx, c.actor.workspaceId, env.rule, projectId))) throw fail('The chosen project is outside the rule scope.');
  const p = await projectRow(c.tx, c.actor.workspaceId, projectId);
  if (!p) throw fail('The chosen project no longer exists.');
  return p;
};

const LINK_TYPES: Record<string, LinkType> = { accountId: 'account', contentItemId: 'content_item', publicationId: 'publication', shiftId: 'shift', dealId: 'deal' };

/**
 * Typed links of the triggering record, only when the task is created in the record's project and
 * only those the rule principal may read (the tasks module validates the same way).
 */
const recordLinks = async (c: CommandContext, env: ActionEnv, projectId: string): Promise<Partial<TaskCreateBody>> => {
  if (!env.record || !env.record.projectIds.includes(projectId)) return {};
  const entries = Object.entries(env.record.links).filter(([k, v]) => !!v && LINK_TYPES[k]) as [string, string][];
  if (!entries.length) return {};
  const info = await loadLinkedInfo(c, entries.map(([k, id]) => ({ type: LINK_TYPES[k]!, id })));
  const out: Record<string, string> = {};
  for (const [k, id] of entries) {
    const i = info.get(`${LINK_TYPES[k]}:${id}`);
    if (i?.readable && (!i.projectId || i.projectId === projectId)) out[k] = id;
  }
  return out as Partial<TaskCreateBody>;
};

const dueFrom = (env: ActionEnv, hours: number | undefined) =>
  hours === undefined ? null : ({ kind: 'datetime', at: new Date(env.now.getTime() + hours * 3_600_000).toISOString(), timezone: env.zone } as const);

const requireTask = async (c: CommandContext, env: ActionEnv) => {
  if (!env.record?.taskId) throw fail('This action works on tasks only.');
  const [t] = await c.tx.select().from(tasks).where(and(eq(tasks.workspaceId, c.actor.workspaceId), eq(tasks.id, env.record.taskId))).for('update');
  if (!t || t.deletedAt) throw new AppError('NOT_FOUND', 'The task no longer exists.');
  return t;
};

/** updateTask needs the If-Match version: the rule acts on the row it just locked. */
const withVersion = (c: CommandContext, rowVersion: number): CommandContext => ({ ...c, request: { ...c.request, expectedVersion: rowVersion } });

const HANDLERS: { [K in AutomationActionInput['type']]: (c: CommandContext, env: ActionEnv, a: Extract<AutomationActionInput, { type: K }>, key: string) => Promise<HandlerResult> } = {
  async create_task(c, env, a, key) {
    const p = await targetProject(c, env, a.params.projectId);
    const assignee = await resolvePerson(c, env, a.params.assignee, p.id);
    const title = render(env, a.params.title, 200);
    const due = dueFrom(env, a.params.dueInHours);
    const id = await createTask(
      c,
      {
        title: title.text,
        projectId: p.id,
        description: a.params.description ? render(env, a.params.description, 2000).text : null,
        status: 'backlog',
        priority: a.params.priority ?? 'normal',
        assigneeMembershipId: assignee,
        due,
        tags: a.params.tags,
        checklist: a.params.checklist?.map((label) => ({ label, mandatory: false })),
        ...(a.params.linkToRecord === false ? {} : await recordLinks(c, env, p.id)),
      },
      { source: 'automation' },
    );
    const who = await nameOf(c, assignee);
    return {
      entityType: 'task',
      entityId: id,
      preview: `Create task “${title.text}” in ${p.name}${who ? `, assigned to ${who}` : ', unassigned'}${due ? `, due ${fmt(new Date(due.at), env.zone)}` : ''}.`,
      note: title.shortened ? 'The title was shortened to 200 characters.' : null,
      effects: [{ entityType: 'task', entityId: id, key }],
    };
  },

  async create_task_from_template(c, env, a, key) {
    const p = await targetProject(c, env, a.params.projectId);
    const [v] = await c.tx.select({ config: templateVersions.config }).from(templateVersions).where(and(eq(templateVersions.workspaceId, c.actor.workspaceId), eq(templateVersions.id, a.params.templateVersionId)));
    const startDate = DateTime.fromJSDate(new Date(env.now.getTime() + (a.params.startOffsetDays ?? 0) * 86_400_000), { zone: env.zone }).toISODate()!;
    const sameProject = env.record && env.record.projectId === p.id;
    const r = await applyTaskTemplate(c, {
      templateVersionId: a.params.templateVersionId,
      targetType: sameProject ? env.record!.entityType : 'project',
      targetId: sameProject ? env.record!.entityId : p.id,
      projectId: p.id,
      accountId: sameProject ? env.record!.accountId : null,
      startDate,
      applicationKey: `automation:${key}`,
    });
    const ids = [...r.taskIds, ...(r.coordinationTaskId ? [r.coordinationTaskId] : [])];
    return {
      entityType: 'project',
      entityId: p.id,
      preview: `Apply the task template (${(v?.config.tasks ?? []).length} tasks) in ${p.name}, starting ${startDate}.`,
      note: r.created ? `${ids.length} tasks created.` : 'The template was already applied for this event.',
      effects: ids.map((id, i) => ({ entityType: 'task' as const, entityId: id, key: `${key}#${i}` })),
    };
  },

  async assign_member(c, env, a) {
    const t = await requireTask(c, env);
    const assignee = await resolvePerson(c, env, a.params.assignee, t.projectId);
    if (!assignee) throw fail('No member can be resolved for this assignment.');
    const who = await nameOf(c, assignee);
    if (t.assigneeMembershipId === assignee) return { entityType: 'task', entityId: t.id, preview: `Keep ${who} as assignee of “${t.title}”.`, skipped: true, note: 'Already assigned to this member.', effects: [] };
    if (a.params.onlyIfUnassigned !== false && t.assigneeMembershipId)
      return { entityType: 'task', entityId: t.id, preview: `Assign “${t.title}” to ${who} only if unassigned.`, skipped: true, note: 'The task already has an assignee.', effects: [] };
    await updateTask(withVersion(c, t.rowVersion), t.id, { assigneeMembershipId: assignee });
    return { entityType: 'task', entityId: t.id, preview: `Assign “${t.title}” to ${who}.`, effects: [] };
  },

  async add_checklist_item(c, env, a) {
    const t = await requireTask(c, env);
    await addChecklistItem(c, t.id, { label: a.params.label, mandatory: !!a.params.mandatory });
    return { entityType: 'task', entityId: t.id, preview: `Add ${a.params.mandatory ? 'mandatory ' : ''}checklist item “${a.params.label}” to “${t.title}”.`, effects: [] };
  },

  async add_tag(c, env, a) {
    const t = await requireTask(c, env);
    if (t.tags.some((x) => x.toLocaleLowerCase('en') === a.params.tag.toLocaleLowerCase('en')))
      return { entityType: 'task', entityId: t.id, preview: `Tag “${t.title}” with ${a.params.tag}.`, skipped: true, note: 'The task already has this tag.', effects: [] };
    await updateTask(withVersion(c, t.rowVersion), t.id, { tags: [...t.tags, a.params.tag] });
    return { entityType: 'task', entityId: t.id, preview: `Tag “${t.title}” with ${a.params.tag}.`, effects: [] };
  },

  async set_field(c, env, a) {
    const t = await requireTask(c, env);
    if (t.priority === a.params.value)
      return { entityType: 'task', entityId: t.id, preview: `Set priority of “${t.title}” to ${a.params.value}.`, skipped: true, note: 'The priority already has this value.', effects: [] };
    await updateTask(withVersion(c, t.rowVersion), t.id, { priority: a.params.value });
    return { entityType: 'task', entityId: t.id, preview: `Set priority of “${t.title}” to ${a.params.value}.`, effects: [] };
  },

  async create_checkpoint(c, env, a, key) {
    const r = env.record;
    if (!r?.accountId || !r.projectId) throw fail('Checkpoints need an account or publication record.');
    authorizeObject(c, 'metrics.write', { objectType: 'metric_checkpoint', projectId: r.projectId, accountId: r.accountId }, 'metrics.read');
    const expectedAt = new Date(env.now.getTime() + a.params.dueInHours * 3_600_000);
    const half = ((a.params.windowHours ?? 24) * 3_600_000) / 2;
    const [policy] = await c.tx.select({ version: checkpointPolicies.version }).from(checkpointPolicies).where(and(eq(checkpointPolicies.workspaceId, c.actor.workspaceId), eq(checkpointPolicies.active, true))).limit(1);
    const id = newId();
    const onPublication = r.entityType === 'publication';
    await c.tx.insert(metricCheckpoints).values({
      ...stamp(c),
      id,
      entityType: onPublication ? 'publication' : 'account',
      entityId: onPublication ? r.entityId : r.accountId,
      accountId: r.accountId,
      projectId: r.projectId,
      publicationId: onPublication ? r.entityId : null,
      checkpointKey: `automation:${a.params.label}`.slice(0, 100),
      policyVersion: policy?.version ?? 0,
      expectedAt,
      windowStart: new Date(expectedAt.getTime() - half),
      windowEnd: new Date(expectedAt.getTime() + half),
      state: 'pending',
      occurrenceKey: `automation:${key}`,
      assigneeMembershipId: r.people.owner,
    });
    await audit(c, { action: 'metric_checkpoint.created', entityType: 'metric_checkpoint', entityId: id, projectId: r.projectId, metadata: { source: 'automation', ruleId: env.rule.id, label: a.params.label } });
    await emit(c, { type: 'metric_checkpoint.created', entityType: 'metric_checkpoint', entityId: id, revision: 1, payload: { source: 'automation' } });
    return { entityType: 'metric_checkpoint', entityId: id, preview: `Create metrics checkpoint “${a.params.label}” for ${r.texts['account.label'] ?? 'the account'}, expected ${fmt(expectedAt, env.zone)}.`, effects: [] };
  },

  async notify(c, env, a, key) {
    const resolved: string[] = [];
    // Sequential: one transaction connection never runs overlapping queries.
    for (const ref of a.params.recipients) {
      const id = await resolvePerson(c, env, ref, env.record?.projectId ?? null);
      if (id) resolved.push(id);
    }
    const ids = [...new Set(resolved)];
    const allowedIds: string[] = [];
    for (const id of ids) {
      // Recipients only learn about records they may open (no leak through notification bodies).
      const r = env.record
        ? await memberCan(c.app.db, c.actor.workspaceId, id, env.record.readPermission, { ...env.record.scope, assignedMembershipIds: [...(env.record.scope.assignedMembershipIds ?? [])] }, env.now)
        : await memberCan(c.app.db, c.actor.workspaceId, id, [], {}, env.now).then((x) => ({ ...x, ok: x.active }));
      if (r.ok) allowedIds.push(id);
    }
    const title = render(env, a.params.title, 140).text;
    const inboxOnly = env.config.quietHoursPolicy === 'ignore_for_inbox';
    const names = (await loadMemberRefs(c.tx, c.actor.workspaceId, allowedIds));
    const preview = `Notify ${allowedIds.length ? allowedIds.map((i) => names.get(i)?.displayName ?? 'member').join(', ') : 'nobody'}: “${title}”${inboxOnly ? ' (Inbox only)' : ' (Inbox now; email copies wait for quiet hours)'}.`;
    if (!allowedIds.length) return { entityType: null, entityId: null, preview, skipped: true, note: 'No recipient can open this record.', effects: [] };
    await notify(c.tx, {
      workspaceId: c.actor.workspaceId,
      recipientMembershipIds: allowedIds,
      eventType: 'automation.notification',
      eventKey: `automation:${key}`,
      kind: 'general',
      title,
      excerpt: a.params.message ? render(env, a.params.message, 500).text : null,
      entityType: env.record?.entityType,
      entityId: env.record?.entityId,
      projectId: env.record?.projectId ?? null,
      actorMembershipId: null,
      excludeActor: false,
      email: !inboxOnly,
      at: env.now,
    });
    return { entityType: null, entityId: null, preview, effects: allowedIds.map((m) => ({ entityType: 'notification' as const, entityId: null, key: `${key}#${m}` })) };
  },

  async request_internal_approval(c, env, a, key) {
    const p = await targetProject(c, env, null);
    const approver = await resolvePerson(c, env, a.params.approver, p.id);
    if (!approver) throw fail('No approver can be resolved for this request.');
    const title = render(env, a.params.title, 200);
    const due = dueFrom(env, a.params.dueInHours);
    const description = [a.params.note ? render(env, a.params.note, 1500).text : null, `Requested by the automation rule “${env.rule.name}”. Completing this task records your decision only — nothing is approved automatically.`]
      .filter(Boolean)
      .join('\n\n');
    const id = await createTask(
      c,
      { title: title.text, projectId: p.id, description, status: 'ready', priority: 'normal', assigneeMembershipId: approver, due, tags: ['approval'], ...(await recordLinks(c, env, p.id)) },
      { source: 'automation' },
    );
    await notify(c.tx, {
      workspaceId: c.actor.workspaceId,
      recipientMembershipIds: [approver],
      eventType: 'automation.approval_requested',
      eventKey: `automation:${key}:approval`,
      kind: 'review_request',
      title: `Approval requested: ${title.text}`.slice(0, 200),
      entityType: 'task',
      entityId: id,
      projectId: p.id,
      actorMembershipId: null,
      excludeActor: false,
      email: env.config.quietHoursPolicy !== 'ignore_for_inbox',
      at: env.now,
    });
    const who = await nameOf(c, approver);
    return {
      entityType: 'task',
      entityId: id,
      preview: `Ask ${who} for an internal approval: task “${title.text}” in ${p.name}${due ? `, due ${fmt(new Date(due.at), env.zone)}` : ''}.`,
      effects: [
        { entityType: 'task', entityId: id, key },
        { entityType: 'notification', entityId: null, key: `${key}#approval` },
      ],
    };
  },

  async create_incident(c, env, a) {
    const title = render(env, a.params.title, 200).text;
    const id = await createIncident(c, {
      kind: 'operational',
      severity: a.params.severity,
      title,
      description: a.params.description ? render(env, a.params.description, 2000).text : `Logged by the automation rule “${env.rule.name}”.`,
      projectId: env.record?.projectId ?? null,
      accountId: env.record?.accountId ?? null,
      ownerMembershipId: env.rule.ownerMembershipId,
    });
    return { entityType: 'incident', entityId: id, preview: `Log a ${a.params.severity} incident “${title}”.`, effects: [] };
  },
};

/** Planned countable effects of a configuration (for the per-root budget check before running). */
export const plannedEffects = async (db: DbOrTx, ws: string, config: AutomationRuleConfig): Promise<number> => {
  let n = 0;
  for (const a of config.actions) {
    if (a.type === 'create_task') n += 1;
    else if (a.type === 'request_internal_approval') n += 2;
    else if (a.type === 'notify') n += a.params.recipients.length;
    else if (a.type === 'create_task_from_template') {
      const [v] = await db.select({ config: templateVersions.config }).from(templateVersions).where(and(eq(templateVersions.workspaceId, ws), eq(templateVersions.id, a.params.templateVersionId)));
      n += Math.max(1, (v?.config.tasks ?? []).length + 1);
    }
  }
  return n;
};

const AUTH_CODES = new Set(['FORBIDDEN', 'NOT_FOUND', 'RECENT_AUTH_REQUIRED']);

/**
 * Run every action of a configuration. Each action has its own savepoint: a refused or invalid
 * action is reported without undoing the others. Transient (non-domain) errors propagate so the
 * job is retried as a whole.
 */
export const runAutomationActions = async (c: CommandContext, env: ActionEnv): Promise<ActionOutcome[]> => {
  const out: ActionOutcome[] = [];
  for (const [index, action] of env.config.actions.entries()) {
    const key = `${env.effectBase}:${index}`;
    if (!env.dryRun) {
      const [done] = await c.tx
        .select()
        .from(automationActionEffects)
        .where(and(eq(automationActionEffects.workspaceId, c.actor.workspaceId), eq(automationActionEffects.effectKey, key)));
      if (done) {
        out.push({ index, type: action.type, ok: true, skipped: true, entityType: done.entityType, entityId: done.entityId, preview: 'Already applied.', note: 'Already applied with the same operation key — not repeated.', effects: 0 });
        continue;
      }
    }
    try {
      const r = await c.tx.transaction(async (sp) => {
        const sc: CommandContext = { ...c, tx: sp };
        const handler = HANDLERS[action.type] as (c: CommandContext, env: ActionEnv, a: AutomationActionInput, key: string) => Promise<HandlerResult>;
        const res = await handler(sc, env, action, key);
        if (!env.dryRun && env.runId) {
          await sp.insert(automationActionEffects).values({ workspaceId: c.actor.workspaceId, effectKey: key, runId: env.runId, entityType: res.entityType, entityId: res.entityId, createdAt: env.now });
          for (const e of res.effects.filter((x) => x.key !== key))
            await sp.insert(automationActionEffects).values({ workspaceId: c.actor.workspaceId, effectKey: e.key, runId: env.runId, entityType: e.entityType, entityId: e.entityId, createdAt: env.now });
          // The base row stands for the main entity; count it when it is itself a task.
        }
        return res;
      });
      out.push({ index, type: action.type, ok: true, skipped: r.skipped, entityType: r.entityType, entityId: r.entityId, preview: r.preview, note: r.note ?? null, effects: r.effects.length });
    } catch (e) {
      if (!isAppError(e)) throw e;
      out.push({ index, type: action.type, ok: false, preview: '', error: e.message, effects: 0, authFailure: AUTH_CODES.has(e.code) });
    }
  }
  return out;
};

void isNull;
