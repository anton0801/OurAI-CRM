import { DateTime } from 'luxon';
import { defineEnum, type EnumValue } from './enums';
import type { FieldError } from './errors';
import { isUuid } from './ids';
import { isDecimalString, toBig } from './decimal';

/**
 * Automations (spec §19): a safe, declarative rule language. Triggers, condition operators and
 * action types are closed vocabularies — no JavaScript, SQL or webhook URLs are ever stored or
 * executed. Everything in this file is pure and unit-tested.
 */

export const AUTOMATION_TRIGGER_KEYS = defineEnum([
  'content.submitted',
  'content.approved',
  'content.changes_requested',
  'publication.published',
  'task.due_soon',
  'task.overdue',
  'checkpoint.due',
  'checkpoint.overdue',
  'shift.ended',
  'shift.report_overdue',
  'handover.unacknowledged',
  'budget.threshold_crossed',
  'account.metrics_stale',
  'deal.stage_changed',
  'schedule.daily',
  'schedule.weekly',
  'schedule.monthly',
] as const);
export type AutomationTriggerKey = EnumValue<typeof AUTOMATION_TRIGGER_KEYS>;

/** event: domain event from the outbox; deadline: time-based scan with a unique deadline key; schedule: calendar. */
export type AutomationTriggerKind = 'event' | 'deadline' | 'schedule';

export const AUTOMATION_TRIGGER_KIND: Record<AutomationTriggerKey, AutomationTriggerKind> = {
  'content.submitted': 'event',
  'content.approved': 'event',
  'content.changes_requested': 'event',
  'publication.published': 'event',
  'task.due_soon': 'deadline',
  'task.overdue': 'deadline',
  'checkpoint.due': 'deadline',
  'checkpoint.overdue': 'deadline',
  'shift.ended': 'event',
  'shift.report_overdue': 'deadline',
  'handover.unacknowledged': 'event',
  'budget.threshold_crossed': 'event',
  'account.metrics_stale': 'deadline',
  'deal.stage_changed': 'event',
  'schedule.daily': 'schedule',
  'schedule.weekly': 'schedule',
  'schedule.monthly': 'schedule',
};

export const AUTOMATION_ACTION_TYPES = defineEnum([
  'create_task',
  'create_task_from_template',
  'assign_member',
  'add_checklist_item',
  'add_tag',
  'set_field',
  'create_checkpoint',
  'notify',
  'request_internal_approval',
  'create_incident',
] as const);
export type AutomationActionType = EnumValue<typeof AUTOMATION_ACTION_TYPES>;

export const AUTOMATION_OPERATORS = defineEnum(['equals', 'not_equals', 'in', 'gte', 'lte', 'elapsed_gte'] as const);
export type AutomationOperator = EnumValue<typeof AUTOMATION_OPERATORS>;

export const AUTOMATION_QUIET_HOURS_POLICIES = defineEnum(['respect', 'ignore_for_inbox'] as const);
export const AUTOMATION_SCOPE_TYPES = defineEnum(['workspace', 'direction', 'project', 'account'] as const);
export const AUTOMATION_SCHEDULE_CADENCES = defineEnum(['daily', 'weekly', 'monthly'] as const);
export const AUTOMATION_PERSON_KINDS = defineEnum(['member', 'entity_assignee', 'entity_owner', 'rule_owner', 'project_owner'] as const);
export type AutomationPersonKind = EnumValue<typeof AUTOMATION_PERSON_KINDS>;
export const AUTOMATION_FIELD_TYPES = defineEnum(['enum', 'member', 'tags', 'number', 'datetime', 'boolean', 'id', 'text'] as const);
export type AutomationFieldType = EnumValue<typeof AUTOMATION_FIELD_TYPES>;

/** Fields an automation may set (set_field): an explicit allow-list per entity type. */
export const AUTOMATION_SETTABLE_FIELDS = defineEnum(['priority'] as const);

/** Operational limits (§19). */
export const AUTOMATION_LIMITS = {
  /** Maximum causation depth of a chain started by one root event. */
  maxDepth: 5,
  /** Created tasks/notifications per root event across every rule in the chain. */
  maxEffectsPerRoot: 50,
  /** Default rule rate; excess runs are throttled (delayed), never dropped. */
  runsPerHour: 100,
  maxConditions: 20,
  maxActions: 10,
  /** Candidates handled per rule per deadline scan (the rest are picked up by the next scan). */
  deadlineScanBatch: 200,
  maxThresholdHours: 8760,
} as const;

/** Transient retry policy: 30 s, 2 min, 10 min, 30 min, 2 h (max 5 retries after the first attempt). */
export const AUTOMATION_RETRY_DELAYS_SECONDS = [30, 120, 600, 1800, 7200] as const;

export const OPERATORS_BY_FIELD_TYPE: Record<AutomationFieldType, readonly AutomationOperator[]> = {
  enum: ['equals', 'not_equals', 'in'],
  member: ['equals', 'not_equals', 'in'],
  tags: ['equals', 'in'],
  number: ['gte', 'lte', 'equals'],
  datetime: ['elapsed_gte'],
  boolean: ['equals'],
  id: ['equals', 'not_equals', 'in'],
  text: ['equals', 'not_equals'],
};

export const OPERATOR_LABELS: Record<AutomationOperator, string> = {
  equals: 'is',
  not_equals: 'is not',
  in: 'is any of',
  gte: 'is at least',
  lte: 'is at most',
  elapsed_gte: 'was at least (hours ago)',
};

export interface AutomationFieldSpec {
  key: string;
  label: string;
  type: AutomationFieldType;
  options?: readonly string[];
  /** Entity picker type for id/member values (UI hint). */
  lookup?: string;
  unit?: string;
}

/**
 * Fact values of the triggering record. `null` for number/datetime means Unknown (never 0);
 * for member/id/enum/tags/text it means Empty (e.g. an unassigned task).
 */
export type AutomationFactValue = string | number | boolean | string[] | null;
export type AutomationFacts = Record<string, AutomationFactValue>;

export interface AutomationConditionInput {
  field: string;
  operator: AutomationOperator;
  value: unknown;
}

export interface AutomationConditionResult {
  index: number;
  field: string;
  operator: AutomationOperator;
  expected: unknown;
  actual: AutomationFactValue;
  passed: boolean;
  /** Why an unknown value did not match (Unknown ≠ 0). */
  reason?: string;
}

const UNKNOWN_IS_UNKNOWN: ReadonlySet<AutomationFieldType> = new Set(['number', 'datetime']);

const isEmpty = (v: AutomationFactValue | undefined) => v === null || v === undefined || (Array.isArray(v) && v.length === 0) || v === '';

const toNumber = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && isDecimalString(v)) return Number(v);
  return null;
};

const cmpNumbers = (a: number | string, b: number | string): number => toBig(String(a)).cmp(toBig(String(b)));

const norm = (v: unknown, type: AutomationFieldType) => (type === 'tags' && typeof v === 'string' ? v.trim().toLocaleLowerCase('en') : v);

/** Evaluate one condition against the facts of the triggering record at `now`. */
export const evaluateAutomationCondition = (
  c: AutomationConditionInput,
  index: number,
  facts: AutomationFacts,
  fields: readonly AutomationFieldSpec[],
  now: Date,
): AutomationConditionResult => {
  const spec = fields.find((f) => f.key === c.field);
  const actual = facts[c.field] ?? null;
  const base = { index, field: c.field, operator: c.operator, expected: c.value, actual };
  if (!spec) return { ...base, passed: false, reason: 'Unknown field' };
  const type = spec.type;
  if (UNKNOWN_IS_UNKNOWN.has(type) && actual === null) return { ...base, passed: false, reason: 'Unknown value — never treated as 0' };
  switch (c.operator) {
    case 'equals':
    case 'not_equals': {
      let eq: boolean;
      if (c.value === null) eq = isEmpty(actual);
      else if (Array.isArray(actual)) eq = actual.some((a) => norm(a, type) === norm(c.value, type));
      else if (type === 'number') {
        const n = toNumber(c.value);
        eq = n !== null && typeof actual === 'number' && cmpNumbers(actual, n) === 0;
      } else eq = actual !== null && norm(actual, type) === norm(c.value, type);
      return { ...base, passed: c.operator === 'equals' ? eq : !eq };
    }
    case 'in': {
      const list = Array.isArray(c.value) ? c.value.map((v) => norm(v, type)) : [];
      const passed = Array.isArray(actual) ? actual.some((a) => list.includes(norm(a, type))) : actual !== null && list.includes(norm(actual, type));
      return { ...base, passed };
    }
    case 'gte':
    case 'lte': {
      const n = toNumber(c.value);
      if (n === null || typeof actual !== 'number') return { ...base, passed: false, reason: 'Unknown value — never treated as 0' };
      const r = cmpNumbers(actual, n);
      return { ...base, passed: c.operator === 'gte' ? r >= 0 : r <= 0 };
    }
    case 'elapsed_gte': {
      const hours = toNumber(c.value);
      const at = typeof actual === 'string' ? Date.parse(actual) : NaN;
      if (hours === null || Number.isNaN(at)) return { ...base, passed: false, reason: 'No date recorded' };
      return { ...base, passed: now.getTime() - at >= hours * 3_600_000 };
    }
    default:
      return { ...base, passed: false, reason: 'Unsupported operator' };
  }
};

/** All conditions must pass (AND). An empty list always matches. */
export const evaluateAutomationConditions = (
  conditions: readonly AutomationConditionInput[],
  facts: AutomationFacts,
  fields: readonly AutomationFieldSpec[],
  now: Date,
): { matched: boolean; results: AutomationConditionResult[] } => {
  const results = conditions.map((c, i) => evaluateAutomationCondition(c, i, facts, fields, now));
  return { matched: results.every((r) => r.passed), results };
};

const fe = (field: string, code: string, message: string): FieldError => ({ field, code, message });

/** Static validation of a condition list against the trigger's field catalogue. */
export const validateAutomationConditions = (conditions: readonly AutomationConditionInput[], fields: readonly AutomationFieldSpec[], prefix = 'config.conditions'): FieldError[] => {
  const errors: FieldError[] = [];
  if (conditions.length > AUTOMATION_LIMITS.maxConditions) errors.push(fe(prefix, 'TOO_MANY', `Use at most ${AUTOMATION_LIMITS.maxConditions} conditions.`));
  conditions.forEach((c, i) => {
    const at = `${prefix}.${i}`;
    const spec = fields.find((f) => f.key === c.field);
    if (!spec) {
      errors.push(fe(`${at}.field`, 'UNKNOWN_FIELD', 'This field is not available for the chosen trigger.'));
      return;
    }
    if (!OPERATORS_BY_FIELD_TYPE[spec.type].includes(c.operator)) {
      errors.push(fe(`${at}.operator`, 'INVALID_OPERATOR', `"${OPERATOR_LABELS[c.operator] ?? c.operator}" cannot be used with ${spec.label}.`));
      return;
    }
    const v = c.value;
    const bad = (message: string) => errors.push(fe(`${at}.value`, 'INVALID_VALUE', message));
    const scalarOk = (x: unknown): boolean => {
      switch (spec.type) {
        case 'enum':
          return typeof x === 'string' && (!spec.options || spec.options.includes(x));
        case 'member':
        case 'id':
          return isUuid(x);
        case 'tags':
        case 'text':
          return typeof x === 'string' && x.trim().length > 0 && x.length <= 200;
        case 'boolean':
          return typeof x === 'boolean';
        case 'number':
          return toNumber(x) !== null;
        case 'datetime':
          return toNumber(x) !== null && toNumber(x)! >= 0 && toNumber(x)! <= AUTOMATION_LIMITS.maxThresholdHours;
        default:
          return false;
      }
    };
    if (c.operator === 'in') {
      if (!Array.isArray(v) || v.length === 0 || v.length > 50 || !v.every(scalarOk)) bad('Choose one or more valid values.');
    } else if (v === null) {
      if (!(c.operator === 'equals' || c.operator === 'not_equals') || !['member', 'id', 'enum', 'tags', 'text'].includes(spec.type)) bad('Choose a value.');
    } else if (!scalarOk(v)) {
      bad(spec.type === 'datetime' ? `Enter hours between 0 and ${AUTOMATION_LIMITS.maxThresholdHours}.` : spec.type === 'number' ? 'Enter a number.' : 'Choose a valid value.');
    }
  });
  return errors;
};

// ——— Schedules ———

export interface AutomationSchedule {
  cadence: 'daily' | 'weekly' | 'monthly';
  /** Local wall time HH:MM in the workspace zone. */
  localTime: string;
  /** ISO weekday 1 = Monday … 7 = Sunday (weekly). */
  weekday?: number;
  /** Day of month 1–31; months without that day use their last day (monthly). */
  monthDay?: number;
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const validateAutomationSchedule = (s: AutomationSchedule | undefined, prefix = 'config.trigger.schedule'): FieldError[] => {
  if (!s) return [fe(prefix, 'REQUIRED', 'Choose when the rule runs.')];
  const errors: FieldError[] = [];
  if (!TIME_RE.test(s.localTime)) errors.push(fe(`${prefix}.localTime`, 'INVALID', 'Use a time like 09:00.'));
  if (s.cadence === 'weekly' && !(Number.isInteger(s.weekday) && s.weekday! >= 1 && s.weekday! <= 7)) errors.push(fe(`${prefix}.weekday`, 'REQUIRED', 'Choose a weekday.'));
  if (s.cadence === 'monthly' && !(Number.isInteger(s.monthDay) && s.monthDay! >= 1 && s.monthDay! <= 31)) errors.push(fe(`${prefix}.monthDay`, 'REQUIRED', 'Choose a day of the month.'));
  return errors;
};

/**
 * Next scheduled slot strictly after `after`, computed in the workspace zone (DST-safe: the wall
 * time is kept; a non-existent wall time moves forward with the clock change).
 */
export const nextAutomationSlot = (s: AutomationSchedule, zone: string, after: Date): Date => {
  const [h, m] = s.localTime.split(':').map(Number);
  const base = DateTime.fromJSDate(after, { zone });
  const at = (d: DateTime) => d.set({ hour: h ?? 0, minute: m ?? 0, second: 0, millisecond: 0 });
  for (let i = 0; i < 400; i++) {
    let candidate: DateTime | null = null;
    if (s.cadence === 'daily') candidate = at(base.startOf('day').plus({ days: i }));
    else if (s.cadence === 'weekly') {
      const d = base.startOf('day').plus({ days: i });
      if (d.weekday === (s.weekday ?? 1)) candidate = at(d);
    } else {
      const month = base.startOf('month').plus({ months: i });
      const day = Math.min(s.monthDay ?? 1, month.daysInMonth ?? 28);
      candidate = at(month.set({ day }));
    }
    if (candidate && candidate.toMillis() > after.getTime()) return candidate.toUTC().toJSDate();
  }
  throw new Error('No schedule slot found');
};

// ——— Causation chain, budget and rate ———

export type AutomationChainVerdict =
  | { ok: true }
  | { ok: false; code: 'DEPTH_LIMIT' | 'RECURSION' | 'BUDGET_EXCEEDED'; message: string };

/**
 * Guard for cyclic triggers (§19): depth ≤ 5; a rule may not run twice in the same causation
 * chain; at most 50 created tasks/notifications per root event across the chain.
 */
export const automationChainVerdict = (input: { depth: number; ruleAlreadyInChain: boolean; effectsInChain: number; plannedEffects: number }): AutomationChainVerdict => {
  if (input.depth > AUTOMATION_LIMITS.maxDepth)
    return { ok: false, code: 'DEPTH_LIMIT', message: `The causation chain is deeper than ${AUTOMATION_LIMITS.maxDepth} steps. The rule was stopped to prevent a loop.` };
  if (input.ruleAlreadyInChain) return { ok: false, code: 'RECURSION', message: 'This rule already ran for an earlier event of the same chain. It cannot trigger itself again.' };
  if (input.effectsInChain + input.plannedEffects > AUTOMATION_LIMITS.maxEffectsPerRoot)
    return {
      ok: false,
      code: 'BUDGET_EXCEEDED',
      message: `This chain would create more than ${AUTOMATION_LIMITS.maxEffectsPerRoot} tasks or notifications (${input.effectsInChain} already created, ${input.plannedEffects} planned). It was stopped.`,
    };
  return { ok: true };
};

/**
 * Rate limit: given the start times of runs executed in the last hour, return when the next run
 * may start (null = now). Throttled runs wait; the source event is never dropped.
 */
export const automationThrottleUntil = (recentStarts: readonly Date[], now: Date, limit: number = AUTOMATION_LIMITS.runsPerHour, windowMs = 3_600_000): Date | null => {
  const inWindow = recentStarts.filter((d) => now.getTime() - d.getTime() < windowMs).sort((a, b) => a.getTime() - b.getTime());
  if (inWindow.length < limit) return null;
  const release = inWindow[inWindow.length - limit]!;
  return new Date(release.getTime() + windowMs);
};

export const automationRetryDelaySeconds = (attempt: number): number | null => AUTOMATION_RETRY_DELAYS_SECONDS[attempt - 1] ?? null;

// ——— Text placeholders ———

export const AUTOMATION_PLACEHOLDERS = defineEnum(['entity.title', 'project.name', 'account.label', 'trigger.label', 'rule.name', 'date'] as const);

const PLACEHOLDER_RE = /\{\{\s*([a-z.]+)\s*\}\}/g;

/** Placeholders that are not in the allow-list (validation). */
export const unknownAutomationPlaceholders = (text: string): string[] => {
  const out: string[] = [];
  for (const m of text.matchAll(PLACEHOLDER_RE)) if (!(AUTOMATION_PLACEHOLDERS as readonly string[]).includes(m[1]!)) out.push(m[1]!);
  return out;
};

/**
 * Plain-text substitution of {{placeholders}} (never evaluated as code). Values longer than the
 * limit are shortened with an ellipsis and reported so the run log can show it.
 */
export const renderAutomationText = (template: string, values: Partial<Record<string, string | null>>, maxLength: number): { text: string; shortened: boolean } => {
  const text = template.replace(PLACEHOLDER_RE, (_m, key: string) => values[key] ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return { text, shortened: false };
  return { text: `${text.slice(0, maxLength - 1).trimEnd()}…`, shortened: true };
};

/** Deterministic UUID (v8 layout) for synthetic trigger events (deadlines, schedules) derived from a hash hex string. */
export const uuidFromHex = (hex: string): string => {
  const h = (hex + '0'.repeat(32)).slice(0, 32).split('');
  h[12] = '8';
  h[16] = ['8', '9', 'a', 'b'][parseInt(h[16]!, 16) % 4]!;
  const s = h.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
};
