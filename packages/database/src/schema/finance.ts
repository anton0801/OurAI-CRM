import { index, pgTable, uniqueIndex } from 'drizzle-orm/pg-core';
import {
  ACCOUNTING_CLASSES,
  ADJUSTMENT_STATES,
  BUDGET_VERSION_STATES,
  COMMITMENT_STATES,
  COMPENSATION_RULE_STATES,
  COMPENSATION_RULE_TYPES,
  COMPENSATION_RUN_STATES,
  FINANCE_ENTRY_STATES,
  FINANCE_ENTRY_TYPES,
  HOURLY_SOURCES,
  PRORATION_POLICIES,
  REVENUE_SHARE_BASES,
  SETTLEMENT_DIRECTIONS,
  SETTLEMENT_STATES,
} from '@castlane/domain';
import {
  archivable,
  boolean,
  currency,
  day,
  dec,
  enumCheck,
  enumText,
  integer,
  json,
  minor,
  rawCheck,
  sql,
  tenantBase,
  text,
  tfk,
  ts,
  uuid,
} from '../columns';
import { memberships, tenantUnique } from './identity';

export const financeCategories = pgTable(
  'finance_categories',
  {
    ...tenantBase(),
    ...archivable(),
    key: text('key').notNull(),
    name: text('name').notNull(),
    /** Fixed accounting class; a category can be renamed but never re-classed. */
    accountingClass: enumText('accounting_class', ACCOUNTING_CLASSES).notNull(),
    isSystem: boolean('is_system').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [
    tenantUnique('finance_categories', t),
    uniqueIndex('finance_categories_key_uq').on(t.workspaceId, t.key),
    enumCheck('finance_categories_class_ck', 'accounting_class', ACCOUNTING_CLASSES),
  ],
);

/** Economic document. Posted documents are immutable; corrections are reversals/replacements. */
export const financialEntries = pgTable(
  'financial_entries',
  {
    ...tenantBase(),
    type: enumText('type', FINANCE_ENTRY_TYPES).notNull(),
    state: enumText('state', FINANCE_ENTRY_STATES).notNull().default('draft'),
    recognitionDate: day('recognition_date').notNull(),
    title: text('title').notNull(),
    counterparty: text('counterparty'),
    sourceNamespace: text('source_namespace'),
    sourceExternalId: text('source_external_id'),
    accountId: uuid('account_id'),
    campaignId: uuid('campaign_id'),
    shiftId: uuid('shift_id'),
    saleCandidateId: uuid('sale_candidate_id'),
    dealId: uuid('deal_id'),
    compensationRunId: uuid('compensation_run_id'),
    note: text('note'),
    evidenceAssetIds: uuid('evidence_asset_ids').array().notNull().default(sql`'{}'::uuid[]`),
    /** Net-only statement: components (gross/fee/refund) unknown, never invented. */
    netOnly: boolean('net_only').notNull().default(false),
    /** Header total of a statement: control sum only, never an extra revenue line. */
    controlTotalMinor: minor('control_total_minor'),
    controlTotalCurrency: currency('control_total_currency'),
    submittedAt: ts('submitted_at'),
    submittedBy: uuid('submitted_by'),
    postedAt: ts('posted_at'),
    postedBy: uuid('posted_by'),
    selfApprovalReason: text('self_approval_reason'),
    rejectedAt: ts('rejected_at'),
    rejectedReason: text('rejected_reason'),
    reversesEntryId: uuid('reverses_entry_id'),
    reversedByEntryId: uuid('reversed_by_entry_id'),
    replacementOfEntryId: uuid('replacement_of_entry_id'),
    reversalReason: text('reversal_reason'),
  },
  (t) => [
    tenantUnique('financial_entries', t),
    uniqueIndex('financial_entries_source_uq')
      .on(t.workspaceId, t.sourceNamespace, t.sourceExternalId)
      .where(sql`source_external_id IS NOT NULL`),
    uniqueIndex('financial_entries_reversal_uq').on(t.reversesEntryId).where(sql`reverses_entry_id IS NOT NULL`),
    uniqueIndex('financial_entries_comp_run_uq').on(t.compensationRunId).where(sql`compensation_run_id IS NOT NULL AND reverses_entry_id IS NULL`),
    index('financial_entries_recognition_idx').on(t.workspaceId, t.state, t.recognitionDate),
    enumCheck('financial_entries_type_ck', 'type', FINANCE_ENTRY_TYPES),
    enumCheck('financial_entries_state_ck', 'state', FINANCE_ENTRY_STATES),
  ],
);

export const financialEntryLines = pgTable(
  'financial_entry_lines',
  {
    ...tenantBase(),
    entryId: uuid('entry_id').notNull(),
    lineNo: integer('line_no').notNull(),
    categoryId: uuid('category_id').notNull(),
    accountingClass: enumText('accounting_class', ACCOUNTING_CLASSES).notNull(),
    /** Always positive; the accounting class determines its effect on results. */
    amountMinor: minor('amount_minor').notNull(),
    currency: currency('currency').notNull(),
    fxRate: dec('fx_rate', 24, 10),
    fxRateId: uuid('fx_rate_id'),
    baseAmountMinor: minor('base_amount_minor'),
    baseCurrency: currency('base_currency').notNull(),
    description: text('description'),
    sourceNamespace: text('source_namespace'),
    transactionRef: text('transaction_ref'),
    componentsUnknown: boolean('components_unknown').notNull().default(false),
    /** Reversal lines negate an original line. */
    reversesLineId: uuid('reverses_line_id'),
    isReversal: boolean('is_reversal').notNull().default(false),
  },
  (t) => [
    tenantUnique('financial_entry_lines', t),
    tfk('fel_entry_fk', t.workspaceId, t.entryId, financialEntries),
    tfk('fel_category_fk', t.workspaceId, t.categoryId, financeCategories),
    uniqueIndex('fel_line_no_uq').on(t.entryId, t.lineNo),
    uniqueIndex('fel_transaction_uq')
      .on(t.workspaceId, t.sourceNamespace, t.transactionRef)
      .where(sql`transaction_ref IS NOT NULL AND is_reversal = false`),
    rawCheck('fel_amount_ck', '"amount_minor" >= 0'),
  ],
);

export const financialAllocations = pgTable(
  'financial_allocations',
  {
    ...tenantBase(),
    lineId: uuid('line_id').notNull(),
    entryId: uuid('entry_id').notNull(),
    /** Null project = explicit Unallocated remainder. */
    projectId: uuid('project_id'),
    campaignId: uuid('campaign_id'),
    contentItemId: uuid('content_item_id'),
    amountMinor: minor('amount_minor').notNull(),
    baseAmountMinor: minor('base_amount_minor'),
    sharePercent: dec('share_percent', 9, 4),
    ruleSnapshot: json<Record<string, unknown>>('rule_snapshot'),
    effectiveDate: day('effective_date').notNull(),
    adjustmentOfId: uuid('adjustment_of_id'),
    supersededAt: ts('superseded_at'),
  },
  (t) => [
    tenantUnique('financial_allocations', t),
    tfk('fa_line_fk', t.workspaceId, t.lineId, financialEntryLines),
    index('fa_project_idx').on(t.workspaceId, t.projectId, t.effectiveDate),
  ],
);

export const fxRates = pgTable(
  'fx_rates',
  {
    ...tenantBase(),
    fromCurrency: currency('from_currency').notNull(),
    toCurrency: currency('to_currency').notNull(),
    rate: dec('rate', 24, 10).notNull(),
    effectiveDate: day('effective_date').notNull(),
    source: text('source').notNull(),
    firstUsedAt: ts('first_used_at'),
  },
  (t) => [
    tenantUnique('fx_rates', t),
    uniqueIndex('fx_rates_uq').on(t.workspaceId, t.fromCurrency, t.toCurrency, t.effectiveDate, t.source),
    rawCheck('fx_rates_positive_ck', '"rate" > 0'),
  ],
);

export const settlements = pgTable(
  'settlements',
  {
    ...tenantBase(),
    direction: enumText('direction', SETTLEMENT_DIRECTIONS).notNull(),
    state: enumText('state', SETTLEMENT_STATES).notNull().default('draft'),
    amountMinor: minor('amount_minor').notNull(),
    currency: currency('currency').notNull(),
    paidAt: ts('paid_at').notNull(),
    paymentSourceNamespace: text('payment_source_namespace').notNull().default('manual'),
    paymentReference: text('payment_reference'),
    manualReference: boolean('manual_reference').notNull().default(false),
    duplicateAckReason: text('duplicate_ack_reason'),
    counterparty: text('counterparty'),
    evidenceAssetIds: uuid('evidence_asset_ids').array().notNull().default(sql`'{}'::uuid[]`),
    note: text('note'),
    remainderPolicy: text('remainder_policy', { enum: ['none', 'advance', 'unallocated'] }).notNull().default('none'),
    unallocatedMinor: minor('unallocated_minor').notNull().default(sql`0`),
    confirmedAt: ts('confirmed_at'),
    confirmedBy: uuid('confirmed_by'),
    reversedAt: ts('reversed_at'),
    reversalReason: text('reversal_reason'),
    reversalEffectiveDate: day('reversal_effective_date'),
    compensationRunId: uuid('compensation_run_id'),
  },
  (t) => [
    tenantUnique('settlements', t),
    uniqueIndex('settlements_reference_uq')
      .on(t.workspaceId, t.paymentSourceNamespace, t.paymentReference)
      .where(sql`payment_reference IS NOT NULL`),
    index('settlements_paid_idx').on(t.workspaceId, t.state, t.paidAt),
    rawCheck('settlements_amount_ck', '"amount_minor" > 0'),
    enumCheck('settlements_state_ck', 'state', SETTLEMENT_STATES),
  ],
);

export const settlementAllocations = pgTable(
  'settlement_allocations',
  {
    ...tenantBase(),
    settlementId: uuid('settlement_id').notNull(),
    targetType: text('target_type', { enum: ['entry', 'compensation_run'] }).notNull(),
    targetEntryId: uuid('target_entry_id'),
    targetRunId: uuid('target_run_id'),
    recipientMembershipId: uuid('recipient_membership_id'),
    /** Amount in settlement currency. */
    amountMinor: minor('amount_minor').notNull(),
    /** Amount settled in the target document currency. */
    documentAmountMinor: minor('document_amount_minor').notNull(),
    documentCurrency: currency('document_currency').notNull(),
    effectiveFxRate: dec('effective_fx_rate', 24, 10),
    realizedDifferenceEntryId: uuid('realized_difference_entry_id'),
    reversedAt: ts('reversed_at'),
    reversalReason: text('reversal_reason'),
  },
  (t) => [
    tenantUnique('settlement_allocations', t),
    tfk('sa_settlement_fk', t.workspaceId, t.settlementId, settlements),
    index('sa_target_entry_idx').on(t.workspaceId, t.targetEntryId),
    index('sa_target_run_idx').on(t.workspaceId, t.targetRunId),
    rawCheck('sa_amount_ck', '"amount_minor" > 0 AND "document_amount_minor" > 0'),
  ],
);

export const budgets = pgTable(
  'budgets',
  {
    ...tenantBase(),
    ...archivable(),
    name: text('name').notNull(),
    scopeType: text('scope_type', { enum: ['workspace', 'direction', 'project', 'campaign'] }).notNull(),
    scopeId: uuid('scope_id'),
    periodStart: day('period_start').notNull(),
    periodEnd: day('period_end').notNull(),
    currency: currency('currency').notNull(),
    ownerMembershipId: uuid('owner_membership_id').notNull(),
    approvedVersionId: uuid('approved_version_id'),
    alertThresholds: integer('alert_thresholds').array().notNull().default(sql`'{80,100,120}'::int[]`),
    copiedFromId: uuid('copied_from_id'),
  },
  (t) => [
    tenantUnique('budgets', t),
    tfk('budgets_owner_fk', t.workspaceId, t.ownerMembershipId, memberships),
    rawCheck('budgets_period_ck', '"period_end" >= "period_start"'),
  ],
);

export const budgetVersions = pgTable(
  'budget_versions',
  {
    ...tenantBase(),
    budgetId: uuid('budget_id').notNull(),
    versionNo: integer('version_no').notNull(),
    state: enumText('state', BUDGET_VERSION_STATES).notNull().default('draft'),
    reason: text('reason'),
    submittedAt: ts('submitted_at'),
    approvedAt: ts('approved_at'),
    approvedBy: uuid('approved_by'),
  },
  (t) => [
    tenantUnique('budget_versions', t),
    tfk('budget_versions_budget_fk', t.workspaceId, t.budgetId, budgets),
    uniqueIndex('budget_versions_no_uq').on(t.budgetId, t.versionNo),
  ],
);

export const budgetLines = pgTable(
  'budget_lines',
  {
    ...tenantBase(),
    budgetVersionId: uuid('budget_version_id').notNull(),
    categoryId: uuid('category_id').notNull(),
    plannedMinor: minor('planned_minor').notNull(),
    note: text('note'),
  },
  (t) => [
    tenantUnique('budget_lines', t),
    tfk('budget_lines_version_fk', t.workspaceId, t.budgetVersionId, budgetVersions),
    tfk('budget_lines_category_fk', t.workspaceId, t.categoryId, financeCategories),
    uniqueIndex('budget_lines_uq').on(t.budgetVersionId, t.categoryId),
    rawCheck('budget_lines_amount_ck', '"planned_minor" >= 0'),
  ],
);

/** Each threshold crossing notifies once per budget version until explicitly reset. */
export const budgetAlerts = pgTable(
  'budget_alerts',
  {
    ...tenantBase(),
    budgetVersionId: uuid('budget_version_id').notNull(),
    threshold: integer('threshold').notNull(),
    crossedAt: ts('crossed_at').notNull(),
    resetAt: ts('reset_at'),
  },
  (t) => [
    tenantUnique('budget_alerts', t),
    uniqueIndex('budget_alerts_active_uq').on(t.budgetVersionId, t.threshold).where(sql`reset_at IS NULL`),
  ],
);

export const commitments = pgTable(
  'commitments',
  {
    ...tenantBase(),
    projectId: uuid('project_id').notNull(),
    budgetId: uuid('budget_id'),
    categoryId: uuid('category_id').notNull(),
    amountMinor: minor('amount_minor').notNull(),
    consumedMinor: minor('consumed_minor').notNull().default(sql`0`),
    currency: currency('currency').notNull(),
    dueDate: day('due_date'),
    counterparty: text('counterparty'),
    description: text('description').notNull(),
    state: enumText('state', COMMITMENT_STATES).notNull().default('open'),
    cancelReason: text('cancel_reason'),
  },
  (t) => [
    tenantUnique('commitments', t),
    rawCheck('commitments_amount_ck', '"amount_minor" > 0 AND "consumed_minor" >= 0 AND "consumed_minor" <= "amount_minor"'),
  ],
);

export const commitmentConsumptions = pgTable(
  'commitment_consumptions',
  {
    ...tenantBase(),
    commitmentId: uuid('commitment_id').notNull(),
    entryLineId: uuid('entry_line_id').notNull(),
    amountMinor: minor('amount_minor').notNull(),
    reversedAt: ts('reversed_at'),
  },
  (t) => [
    tenantUnique('commitment_consumptions', t),
    tfk('cc_commitment_fk', t.workspaceId, t.commitmentId, commitments),
    uniqueIndex('cc_uq').on(t.commitmentId, t.entryLineId).where(sql`reversed_at IS NULL`),
  ],
);

/** Manager attribution of verified revenue (shares ≤ 100 %, remainder Unassigned). */
export const revenueAttributions = pgTable(
  'revenue_attributions',
  {
    ...tenantBase(),
    entryId: uuid('entry_id').notNull(),
    membershipId: uuid('membership_id').notNull(),
    sharePercent: dec('share_percent', 9, 4).notNull(),
    basis: text('basis', { enum: ['source_assignment', 'manual'] }).notNull(),
    reason: text('reason'),
    saleCandidateId: uuid('sale_candidate_id'),
    supersededAt: ts('superseded_at'),
    campaignId: uuid('campaign_id'),
  },
  (t) => [
    tenantUnique('revenue_attributions', t),
    tfk('ra_entry_fk', t.workspaceId, t.entryId, financialEntries),
    rawCheck('ra_share_ck', '"share_percent" > 0 AND "share_percent" <= 100'),
  ],
);

export const compensationRules = pgTable(
  'compensation_rules',
  {
    ...tenantBase(),
    ...archivable(),
    name: text('name').notNull(),
    recipientScopeType: text('recipient_scope_type', { enum: ['member', 'role'] }).notNull(),
    recipientMembershipId: uuid('recipient_membership_id'),
    recipientRoleId: uuid('recipient_role_id'),
    componentKey: text('component_key').notNull(),
    stackGroup: text('stack_group'),
    currentVersionId: uuid('current_version_id'),
  },
  (t) => [tenantUnique('compensation_rules', t)],
);

export const compensationRuleVersions = pgTable(
  'compensation_rule_versions',
  {
    ...tenantBase(),
    ruleId: uuid('rule_id').notNull(),
    versionNo: integer('version_no').notNull(),
    state: enumText('state', COMPENSATION_RULE_STATES).notNull().default('draft'),
    type: enumText('type', COMPENSATION_RULE_TYPES).notNull(),
    effectiveFrom: day('effective_from').notNull(),
    /** Exclusive end [from, to). */
    effectiveTo: day('effective_to'),
    rateMinor: minor('rate_minor'),
    ratePercent: dec('rate_percent', 9, 4),
    currency: currency('currency').notNull(),
    revenueBasis: enumText('revenue_basis', REVENUE_SHARE_BASES),
    hourlySource: enumText('hourly_source', HOURLY_SOURCES),
    proration: enumText('proration', PRORATION_POLICIES).notNull().default('none'),
    eligibleProjectIds: uuid('eligible_project_ids').array().notNull().default(sql`'{}'::uuid[]`),
    contributorResponsibility: text('contributor_responsibility'),
    refundPolicy: text('refund_policy', { enum: ['adjust_next_open_run'] }).notNull().default('adjust_next_open_run'),
    stacking: json<{ allowWith?: string[] }>('stacking').notNull().default({}),
    approvedAt: ts('approved_at'),
    approvedBy: uuid('approved_by'),
    endedAt: ts('ended_at'),
  },
  (t) => [
    tenantUnique('compensation_rule_versions', t),
    tfk('crv_rule_fk', t.workspaceId, t.ruleId, compensationRules),
    uniqueIndex('crv_no_uq').on(t.ruleId, t.versionNo),
    rawCheck('crv_percent_ck', '"rate_percent" IS NULL OR ("rate_percent" > 0 AND "rate_percent" <= 100)'),
  ],
);

export const compensationRuns = pgTable(
  'compensation_runs',
  {
    ...tenantBase(),
    periodStart: day('period_start').notNull(),
    periodEnd: day('period_end').notNull(),
    state: enumText('state', COMPENSATION_RUN_STATES).notNull().default('draft'),
    participantMembershipIds: uuid('participant_membership_ids').array().notNull().default(sql`'{}'::uuid[]`),
    calculationVersion: integer('calculation_version').notNull().default(0),
    sourceDigest: text('source_digest'),
    calculatedAt: ts('calculated_at'),
    submittedAt: ts('submitted_at'),
    approvedAt: ts('approved_at'),
    approvedBy: uuid('approved_by'),
    expenseEntryId: uuid('expense_entry_id'),
    cancelReason: text('cancel_reason'),
    returnReason: text('return_reason'),
    totals: json<{ currency: string; amountMinor: string; paidMinor: string }[]>('totals').notNull().default([]),
    snapshot: json<Record<string, unknown>>('snapshot'),
  },
  (t) => [
    tenantUnique('compensation_runs', t),
    rawCheck('compensation_runs_period_ck', '"period_end" >= "period_start"'),
    enumCheck('compensation_runs_state_ck', 'state', COMPENSATION_RUN_STATES),
  ],
);

export const compensationLines = pgTable(
  'compensation_lines',
  {
    ...tenantBase(),
    runId: uuid('run_id').notNull(),
    calculationVersion: integer('calculation_version').notNull(),
    recipientMembershipId: uuid('recipient_membership_id').notNull(),
    ruleVersionId: uuid('rule_version_id'),
    adjustmentId: uuid('adjustment_id'),
    sourceType: text('source_type').notNull(),
    sourceId: text('source_id').notNull(),
    component: text('component').notNull(),
    entitlementKey: text('entitlement_key').notNull(),
    quantity: dec('quantity', 24, 6),
    rate: text('rate'),
    amountMinor: minor('amount_minor').notNull(),
    currency: currency('currency').notNull(),
    excluded: boolean('excluded').notNull().default(false),
    exclusionReason: text('exclusion_reason'),
    explanation: json<Record<string, unknown>>('explanation').notNull().default({}),
  },
  (t) => [
    tenantUnique('compensation_lines', t),
    tfk('compensation_lines_run_fk', t.workspaceId, t.runId, compensationRuns),
    index('compensation_lines_run_idx').on(t.workspaceId, t.runId, t.calculationVersion),
  ],
);

/** An entitlement can be claimed by at most one approved run. */
export const compensationClaims = pgTable(
  'compensation_claims',
  {
    ...tenantBase(),
    entitlementKey: text('entitlement_key').notNull(),
    runId: uuid('run_id').notNull(),
    lineId: uuid('line_id').notNull(),
    claimedAt: ts('claimed_at').notNull(),
  },
  (t) => [tenantUnique('compensation_claims', t), uniqueIndex('compensation_claims_key_uq').on(t.workspaceId, t.entitlementKey)],
);

export const compensationAdjustments = pgTable(
  'compensation_adjustments',
  {
    ...tenantBase(),
    recipientMembershipId: uuid('recipient_membership_id').notNull(),
    amountMinor: minor('amount_minor').notNull(),
    currency: currency('currency').notNull(),
    reason: text('reason').notNull(),
    kind: text('kind', { enum: ['manual_bonus', 'manual_adjustment', 'refund', 'reallocation', 'reversal', 'carry_forward'] }).notNull(),
    state: enumText('state', ADJUSTMENT_STATES).notNull().default('draft'),
    originalEntitlementKey: text('original_entitlement_key'),
    sourceRunId: uuid('source_run_id'),
    appliedRunId: uuid('applied_run_id'),
    reversesAdjustmentId: uuid('reverses_adjustment_id'),
    approvedBy: uuid('approved_by'),
    approvedAt: ts('approved_at'),
  },
  (t) => [tenantUnique('compensation_adjustments', t)],
);

export const periodLocks = pgTable(
  'period_locks',
  {
    ...tenantBase(),
    periodStart: day('period_start').notNull(),
    periodEnd: day('period_end').notNull(),
    state: text('state', { enum: ['locked', 'reopened'] }).notNull().default('locked'),
    lockedAt: ts('locked_at').notNull(),
    lockedBy: uuid('locked_by').notNull(),
    unresolvedItems: json<{ kind: string; count: number; note?: string }[]>('unresolved_items').notNull().default([]),
    reopenedAt: ts('reopened_at'),
    reopenedBy: uuid('reopened_by'),
    reopenReason: text('reopen_reason'),
  },
  (t) => [
    tenantUnique('period_locks', t),
    uniqueIndex('period_locks_active_uq').on(t.workspaceId, t.periodStart).where(sql`state = 'locked'`),
  ],
);
