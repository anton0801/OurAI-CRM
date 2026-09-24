import { z } from 'zod';
import { PLATFORMS, PROJECT_STATUSES, PROJECT_TYPES } from '@castlane/domain';
import { endpoint } from './core';
import { isoDate, isoDateTime, memberRef, money, uuid, wsId } from './common';
import { goalMeasuredValue } from './goals';

/**
 * Overview S08 (§17, §25.4): permitted KPI definitions + values + coverage + drill-down filters,
 * computed inside the member's scope before aggregation. Finance appears only with finance access.
 */

export const OVERVIEW_PERIODS = ['last_7_days', 'last_30_days', 'this_week', 'last_week', 'this_month', 'last_month', 'this_quarter', 'last_quarter', 'this_year', 'custom'] as const;

export const NEEDS_ATTENTION_KINDS = [
  'overdue_task',
  'blocked_task',
  'review_waiting',
  'publication_unapproved',
  'checkpoint_missing',
  'shift_end_forgotten',
  'budget_overspent',
] as const;

export const overviewQuery = z.object({
  period: z.enum(OVERVIEW_PERIODS).default('last_30_days'),
  from: isoDate.optional(),
  to: isoDate.optional(),
  directionId: uuid.optional(),
  projectId: uuid.optional(),
});

export const overviewKpi = z.object({
  key: z.enum(['published', 'on_time_rate', 'pending_reviews', 'overdue_tasks']),
  label: z.string(),
  /** Catalogue id (M01, M07, M08) or null for operational counts. */
  metricId: z.string().nullable(),
  description: z.string(),
  value: goalMeasuredValue,
  comparison: z.object({ status: z.enum(['known', 'no_comparison']), abs: z.string().nullable(), pct: z.string().nullable(), unitLabel: z.enum(['pp', 'unit']), previousLabel: z.string() }).nullable(),
  /** Opens the filtered source records. */
  href: z.string().nullable(),
});
export type OverviewKpi = z.infer<typeof overviewKpi>;

export const needsAttentionItem = z.object({
  kind: z.enum(NEEDS_ATTENTION_KINDS),
  id: uuid,
  title: z.string(),
  detail: z.string(),
  severity: z.enum(['warning', 'danger']),
  at: isoDateTime.nullable(),
  href: z.string(),
  actionLabel: z.string(),
  project: z.object({ id: uuid, name: z.string() }).nullable(),
});
export type NeedsAttentionItem = z.infer<typeof needsAttentionItem>;

export const overviewProjectRow = z.object({
  id: uuid,
  name: z.string(),
  type: z.enum(PROJECT_TYPES),
  status: z.enum(PROJECT_STATUSES),
  direction: z.object({ id: uuid, name: z.string() }),
  owner: memberRef,
  thumbnailUrl: z.string().nullable(),
  openTasks: z.number().int(),
  overdueTasks: z.number().int(),
  nextMilestone: z.object({ title: z.string(), dueDate: isoDate.nullable() }).nullable(),
  lastPublicationAt: isoDateTime.nullable(),
});
export type OverviewProjectRow = z.infer<typeof overviewProjectRow>;

export const overviewResponse = z.object({
  period: z.object({ preset: z.enum(OVERVIEW_PERIODS), fromDate: isoDate, toDate: isoDate, zone: z.string(), start: isoDateTime, end: isoDateTime }),
  asOf: isoDateTime,
  filters: z.object({ direction: z.object({ id: uuid, name: z.string() }).nullable(), project: z.object({ id: uuid, name: z.string() }).nullable() }),
  /** T169: nothing in scope yet — show the checklist, no KPIs or charts. */
  setup: z.object({
    empty: z.boolean(),
    steps: z.array(z.object({ key: z.enum(['project', 'account', 'task']), label: z.string(), done: z.boolean(), permitted: z.boolean(), href: z.string() })),
  }),
  kpis: z.array(overviewKpi),
  trend: z.object({
    grain: z.enum(['day', 'week', 'month']),
    series: z.array(z.object({ key: z.string(), label: z.string(), metricId: z.string(), unit: z.string(), points: z.array(z.object({ bucket: isoDate, value: goalMeasuredValue })) })),
    unavailableReason: z.string().nullable(),
  }),
  needsAttention: z.object({
    counts: z.array(z.object({ kind: z.enum(NEEDS_ATTENTION_KINDS), label: z.string(), count: z.number().int() })),
    total: z.number().int(),
    items: z.array(needsAttentionItem),
  }),
  projects: z.object({ items: z.array(overviewProjectRow), total: z.number().int() }),
  /** Absent without metrics.read. */
  freshness: z
    .object({
      accounts: z.array(
        z.object({
          id: uuid,
          label: z.string(),
          platform: z.enum(PLATFORMS),
          project: z.object({ id: uuid, name: z.string() }),
          lastObservedAt: isoDateTime.nullable(),
          lastEnteredAt: isoDateTime.nullable(),
          overdue: z.boolean(),
        }),
      ),
      totalAccounts: z.number().int(),
      staleAccounts: z.number().int(),
      coverage: goalMeasuredValue,
    })
    .optional(),
  /** Absent without finance.read (T016) — never null-filled. */
  finance: z
    .object({
      baseCurrency: z.string(),
      netRevenue: money,
      operatingExpenses: money,
      operatingResult: money,
      grossIncomplete: z.boolean(),
      cash: z.array(z.object({ currency: z.string(), movement: money })),
      draftCount: z.number().int(),
    })
    .optional(),
  permissions: z.object({ createProject: z.boolean(), exportView: z.boolean(), reviewQueue: z.boolean() }),
});
export type OverviewResponse = z.infer<typeof overviewResponse>;

export const overviewEndpoints = {
  get: endpoint({
    id: 'overview.get',
    method: 'GET',
    path: '/workspaces/{workspaceId}/overview',
    summary: 'Overview for a period and scope: KPIs with coverage and drill-down, trend, Needs Attention, projects, data freshness.',
    tags: ['Overview'],
    auth: 'workspace',
    params: wsId({}),
    query: overviewQuery,
    response: overviewResponse,
  }),
};
