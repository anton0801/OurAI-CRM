import { Big, isDecimalString, isoDateAddDays } from '@castlane/domain';

export type TemplateKind = 'task' | 'content' | 'checklist' | 'quality_rubric';

export interface PlanTaskNode {
  key: string;
  title: string;
  responsibility?: string;
  defaultRoleKey?: string;
  offsetDaysFromStart?: number;
  durationDays?: number;
  estimateMinutes?: number;
  dependsOn?: string[];
  checklist?: { label: string; mandatory: boolean }[];
  requiresReview?: boolean;
}

export interface PlanConfig {
  checklist?: { label: string; mandatory: boolean }[];
  tasks?: PlanTaskNode[];
  rubric?: { key: string; label: string; weight: string }[];
}

export interface ConfigIssue {
  field: string;
  code: string;
  message: string;
}

/**
 * Topological order of the task graph (Kahn). Returns null when the dependencies contain a cycle.
 * Ties keep the author's order so previews are stable.
 */
export const topologicalOrder = (tasks: PlanTaskNode[]): PlanTaskNode[] | null => {
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const indeg = new Map(tasks.map((t) => [t.key, 0]));
  const next = new Map<string, string[]>(tasks.map((t) => [t.key, []]));
  for (const t of tasks)
    for (const d of new Set(t.dependsOn ?? [])) {
      if (!byKey.has(d)) continue;
      indeg.set(t.key, (indeg.get(t.key) ?? 0) + 1);
      next.get(d)!.push(t.key);
    }
  const queue = tasks.filter((t) => indeg.get(t.key) === 0).map((t) => t.key);
  const out: PlanTaskNode[] = [];
  while (queue.length) {
    const k = queue.shift()!;
    out.push(byKey.get(k)!);
    for (const n of next.get(k)!) {
      indeg.set(n, indeg.get(n)! - 1);
      if (indeg.get(n) === 0) queue.push(n);
    }
  }
  return out.length === tasks.length ? out : null;
};

/**
 * Semantic checks before a version can be published: unique keys, dependencies on existing tasks,
 * no cycles (finish-to-start graph), rubric weights summing to exactly 100.
 */
export const validateTemplateConfig = (kind: TemplateKind, config: PlanConfig): ConfigIssue[] => {
  const issues: ConfigIssue[] = [];
  const tasks = config.tasks ?? [];
  if (kind === 'task' && tasks.length === 0) issues.push({ field: 'config.tasks', code: 'REQUIRED', message: 'Add at least one task.' });
  const keys = new Set<string>();
  tasks.forEach((t, i) => {
    if (keys.has(t.key)) issues.push({ field: `config.tasks.${i}.key`, code: 'DUPLICATE', message: `The key “${t.key}” is used twice.` });
    keys.add(t.key);
  });
  tasks.forEach((t, i) => {
    for (const d of t.dependsOn ?? []) {
      if (d === t.key) issues.push({ field: `config.tasks.${i}.dependsOn`, code: 'SELF', message: `“${t.title}” cannot depend on itself.` });
      else if (!keys.has(d)) issues.push({ field: `config.tasks.${i}.dependsOn`, code: 'UNKNOWN', message: `“${t.title}” depends on an unknown task “${d}”.` });
    }
  });
  if (tasks.length && !issues.length && !topologicalOrder(tasks)) issues.push({ field: 'config.tasks', code: 'CYCLE', message: 'The task dependencies form a cycle.' });
  if (kind === 'checklist' && !(config.checklist ?? []).length) issues.push({ field: 'config.checklist', code: 'REQUIRED', message: 'Add at least one checklist item.' });
  if (kind === 'quality_rubric') {
    const rubric = config.rubric ?? [];
    if (!rubric.length) issues.push({ field: 'config.rubric', code: 'REQUIRED', message: 'Add at least one criterion.' });
    const rk = new Set<string>();
    let sum = new Big(0);
    let numeric = true;
    rubric.forEach((r, i) => {
      if (rk.has(r.key)) issues.push({ field: `config.rubric.${i}.key`, code: 'DUPLICATE', message: `The key “${r.key}” is used twice.` });
      rk.add(r.key);
      if (!isDecimalString(r.weight) || new Big(r.weight).lte(0)) {
        numeric = false;
        issues.push({ field: `config.rubric.${i}.weight`, code: 'INVALID', message: 'Weights must be positive numbers.' });
      } else sum = sum.plus(new Big(r.weight));
    });
    if (rubric.length && numeric && !sum.eq(100)) issues.push({ field: 'config.rubric', code: 'WEIGHTS', message: `Weights must add up to 100 (now ${sum.toString()}).` });
  }
  return issues;
};

export interface PlannedTask {
  key: string;
  title: string;
  startDate: string;
  dueDate: string;
  estimateMinutes: number | null;
  dependsOn: string[];
  responsibility: string | null;
  roleKey: string | null;
  checklist: { label: string; mandatory: boolean }[];
  requiresReview: boolean;
}

const maxDate = (a: string, b: string) => (a > b ? a : b);

/**
 * Dry-run of a template application: calendar dates from the start date and offsets, pushed later
 * where a predecessor finishes after the planned start (finish-to-start). Creates nothing.
 */
export const planTemplate = (config: PlanConfig, startDate: string): { tasks: PlannedTask[]; endDate: string | null; totalEstimateMinutes: number; warnings: string[] } => {
  const ordered = topologicalOrder(config.tasks ?? []);
  if (!ordered) throw new Error('cycle');
  const due = new Map<string, string>();
  const warnings: string[] = [];
  const out: PlannedTask[] = [];
  for (const t of ordered) {
    let start = isoDateAddDays(startDate, t.offsetDaysFromStart ?? 0);
    for (const d of t.dependsOn ?? []) {
      const pd = due.get(d);
      if (pd && pd > start) {
        warnings.push(`“${t.title}” starts ${pd} instead of ${start} because it waits for “${config.tasks!.find((x) => x.key === d)?.title ?? d}”.`);
        start = maxDate(start, pd);
      }
    }
    const end = isoDateAddDays(start, t.durationDays ?? 0);
    due.set(t.key, end);
    out.push({
      key: t.key,
      title: t.title,
      startDate: start,
      dueDate: end,
      estimateMinutes: t.estimateMinutes ?? null,
      dependsOn: t.dependsOn ?? [],
      responsibility: t.responsibility ?? null,
      roleKey: t.defaultRoleKey ?? null,
      checklist: t.checklist ?? [],
      requiresReview: !!t.requiresReview,
    });
  }
  const endDate = out.length ? out.map((t) => t.dueDate).reduce(maxDate) : null;
  return { tasks: out, endDate, totalEstimateMinutes: out.reduce((n, t) => n + (t.estimateMinutes ?? 0), 0), warnings };
};
