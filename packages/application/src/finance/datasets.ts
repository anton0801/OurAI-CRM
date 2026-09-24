import { and, asc, eq, gt, inArray, isNull, lte, sql } from 'drizzle-orm';
import { can, listFilter } from '@castlane/authorization';
import {
  compensationLines,
  compensationRuns,
  financeCategories,
  financialAllocations,
  financialEntries,
  financialEntryLines,
  fxRates,
  projects,
} from '@castlane/database';
import { AppError, FINANCE_ENTRY_TYPES, ENTRY_TYPE_CLASSES, SUPPORTED_CURRENCIES, formatMinor, isPositiveRate, tryParseAmountToMinor } from '@castlane/domain';
import { defineExportDataset } from '../core/export-registry';
import { defineImportDataset, type ImportIssue } from '../core/import-registry';
import { dbOf, type CommandContext } from '../core/context';
import { loadMemberRefs } from '../core/members';
import { audit } from '../core/audit';
import { createFxRate, updateFxRate } from './categories';
import { createEntry, entryVisibilitySql, updateEntry } from './entries';

// ——— Import: Financial Drafts (§22.1 — drafts only, never posted: T148) ———

export interface FinancialDraftRow {
  type: (typeof FINANCE_ENTRY_TYPES)[number];
  title: string;
  recognitionDate: string;
  categoryId: string;
  amount: string;
  currency: string;
  counterparty: string | null;
  sourceNamespace: string | null;
  sourceExternalId: string | null;
  transactionRef: string | null;
  projectId: string | null;
  netOnly: boolean;
  note: string | null;
}

const str = (v: unknown) => (v === null || v === undefined ? '' : String(v).trim());

defineImportDataset<FinancialDraftRow>({
  key: 'financial_drafts',
  label: 'Financial Drafts',
  permission: 'finance.create',
  columns: [
    { key: 'type', label: 'Type', type: 'enum', required: true, enumValues: FINANCE_ENTRY_TYPES, aliases: ['entry type'] },
    { key: 'title', label: 'Title', type: 'text', required: true, aliases: ['description', 'name'] },
    { key: 'recognition_date', label: 'Recognition Date', type: 'date', required: true, aliases: ['date'] },
    { key: 'category', label: 'Category', type: 'reference', required: true, description: 'Category key, name or id.' },
    { key: 'amount', label: 'Amount', type: 'amount', required: true },
    { key: 'currency', label: 'Currency', type: 'currency', required: true },
    { key: 'counterparty', label: 'Counterparty', type: 'text' },
    { key: 'source_namespace', label: 'Source Namespace', type: 'text', aliases: ['source'] },
    { key: 'source_external_id', label: 'Source Transaction ID', type: 'text', aliases: ['transaction id', 'external id'] },
    { key: 'transaction_ref', label: 'Line Transaction Ref', type: 'text' },
    { key: 'project', label: 'Project', type: 'reference', description: 'Project id or exact name; empty = Unallocated.' },
    { key: 'net_only', label: 'Net Only', type: 'boolean' },
    { key: 'note', label: 'Note', type: 'long_text' },
  ],
  duplicatePolicies: ['skip', 'revise_existing', 'error'],
  async validate(ctx, row, opts) {
    const errors: ImportIssue[] = [];
    const warnings: ImportIssue[] = [];
    const db = dbOf(ctx);
    const ws = ctx.actor.workspaceId;
    const type = str(row.type) as FinancialDraftRow['type'];
    if (!FINANCE_ENTRY_TYPES.includes(type)) errors.push({ field: 'type', code: 'INVALID', message: `Use one of ${FINANCE_ENTRY_TYPES.join(', ')}.` });
    const title = str(row.title);
    if (title.length < 2 || title.length > 120) errors.push({ field: 'title', code: 'LENGTH', message: 'Use 2–120 characters.' });
    const recognitionDate = str(row.recognition_date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(recognitionDate)) errors.push({ field: 'recognition_date', code: 'DATE', message: 'Use the YYYY-MM-DD format.' });
    const currency = str(row.currency).toUpperCase();
    if (!SUPPORTED_CURRENCIES.includes(currency)) errors.push({ field: 'currency', code: 'CURRENCY', message: 'Unsupported currency.' });
    const amount = str(row.amount);
    const minor = currency && SUPPORTED_CURRENCIES.includes(currency) ? tryParseAmountToMinor(amount, currency) : null;
    if (minor === null || minor <= 0n) errors.push({ field: 'amount', code: 'AMOUNT', message: `Enter a positive amount with at most the decimals of ${currency || 'the currency'} (no guessing of separators).` });

    // Category: id, key or exact name (unambiguous).
    const catRef = str(row.category);
    const cats = await db.select().from(financeCategories).where(and(eq(financeCategories.workspaceId, ws), isNull(financeCategories.archivedAt)));
    const matches = cats.filter((c) => c.id === catRef || c.key === catRef || c.name.toLowerCase() === catRef.toLowerCase());
    if (matches.length !== 1) errors.push({ field: 'category', code: matches.length ? 'AMBIGUOUS' : 'NOT_FOUND', message: matches.length ? 'Several categories match; use the key.' : 'Unknown category.' });
    const cat = matches.length === 1 ? matches[0]! : null;
    if (cat && FINANCE_ENTRY_TYPES.includes(type) && !ENTRY_TYPE_CLASSES[type].includes(cat.accountingClass))
      errors.push({ field: 'category', code: 'CLASS', message: `A ${type} cannot use a ${cat.accountingClass.replace('_', ' ')} category.` });
    if (cat?.accountingClass === 'fx_difference') errors.push({ field: 'category', code: 'CLASS', message: 'FX differences come from settlements, not imports.' });

    // Project: id or exact name within the importer's scope; unknown is a blocking error.
    let projectId: string | null = null;
    const pref = str(row.project);
    if (pref) {
      const ps = await db.select({ id: projects.id, name: projects.name }).from(projects).where(and(eq(projects.workspaceId, ws), isNull(projects.deletedAt)));
      const pm = ps.filter((p) => p.id === pref || p.name.toLowerCase() === pref.toLowerCase());
      if (pm.length !== 1) errors.push({ field: 'project', code: pm.length ? 'AMBIGUOUS' : 'NOT_FOUND', message: pm.length ? 'Several projects have this name; use the id.' : 'Unknown project.' });
      else if (!can(ctx.actor.access, 'finance.create', { projectId: pm[0]!.id })) errors.push({ field: 'project', code: 'FORBIDDEN', message: 'You cannot record finance for this project.' });
      else projectId = pm[0]!.id;
    } else if (!can(ctx.actor.access, 'finance.create')) errors.push({ field: 'project', code: 'REQUIRED', message: 'Choose a project you may record finance for.' });

    const netOnly = ['true', '1', 'yes'].includes(str(row.net_only).toLowerCase());
    if (netOnly && cat && cat.accountingClass !== 'revenue') errors.push({ field: 'net_only', code: 'NET_ONLY', message: 'Net Only applies to a revenue line.' });
    const sourceExternalId = str(row.source_external_id) || null;
    const sourceNamespace = sourceExternalId ? str(row.source_namespace) || 'import' : null;
    let action: 'create' | 'update' | 'skip' = 'create';
    let targetId: string | undefined;
    let targetRowVersion: number | undefined;
    if (sourceExternalId) {
      const [dup] = await db
        .select()
        .from(financialEntries)
        .where(and(eq(financialEntries.workspaceId, ws), eq(financialEntries.sourceNamespace, sourceNamespace!), eq(financialEntries.sourceExternalId, sourceExternalId)));
      if (dup) {
        if (opts.duplicatePolicy === 'skip') {
          action = 'skip';
          warnings.push({ field: 'source_external_id', code: 'DUPLICATE_SKIPPED', message: 'This source transaction is already recorded; the row is skipped.' });
        } else if (opts.duplicatePolicy === 'revise_existing' && (dup.state === 'draft' || dup.state === 'rejected')) {
          action = 'update';
          targetId = dup.id;
          targetRowVersion = dup.rowVersion;
        } else
          errors.push({
            field: 'source_external_id',
            code: 'DUPLICATE',
            message: dup.state === 'posted' || dup.state === 'submitted' ? 'This source transaction is already recorded and can no longer be revised by import.' : 'This source transaction is already recorded.',
          });
      }
    }
    return {
      action,
      targetId,
      targetRowVersion,
      dedupeKey: sourceExternalId ? `${sourceNamespace}:${sourceExternalId}` : undefined,
      errors,
      warnings,
      normalized: {
        type,
        title,
        recognitionDate,
        categoryId: cat?.id ?? '',
        amount: minor !== null && currency ? formatMinor(minor, currency) : amount,
        currency,
        counterparty: str(row.counterparty) || null,
        sourceNamespace,
        sourceExternalId,
        transactionRef: str(row.transaction_ref) || null,
        projectId,
        netOnly,
        note: str(row.note) || null,
      },
    };
  },
  async apply(ctx, row, v) {
    const input = {
      type: row.type,
      title: row.title,
      recognitionDate: row.recognitionDate,
      counterparty: row.counterparty,
      sourceNamespace: row.sourceNamespace,
      sourceExternalId: row.sourceExternalId,
      note: row.note,
      netOnly: row.netOnly,
      lines: [{ categoryId: row.categoryId, amount: row.amount, currency: row.currency, transactionRef: row.transactionRef }],
      allocation: row.projectId ? { mode: 'weights' as const, rows: [{ projectId: row.projectId, value: '1' }] } : null,
    };
    if (v.action === 'update' && v.targetId) {
      const scoped: CommandContext = { ...ctx, request: { ...ctx.request, expectedVersion: v.targetRowVersion } };
      await updateEntry(scoped, v.targetId, input);
      return v.targetId;
    }
    // Imports only ever create drafts; posting stays a separate, authorised command.
    return createEntry(ctx, input, { via: 'import' });
  },
  async undo(ctx, entityId) {
    const [e] = await ctx.tx.select().from(financialEntries).where(and(eq(financialEntries.workspaceId, ctx.actor.workspaceId), eq(financialEntries.id, entityId))).for('update');
    if (!e) return;
    if (e.state !== 'draft' || e.rowVersion !== 1)
      throw new AppError('INVALID_STATE', 'This entry changed after the import (edited, submitted or posted) and is kept.', { details: { reason: 'changed_after_import', entryId: e.id, state: e.state } });
    await ctx.tx.delete(financialAllocations).where(eq(financialAllocations.entryId, e.id));
    await ctx.tx.delete(financialEntryLines).where(eq(financialEntryLines.entryId, e.id));
    await ctx.tx.delete(financialEntries).where(eq(financialEntries.id, e.id));
    await audit(ctx, { action: 'financial_entry.import_undone', entityType: 'financial_entry', entityId: e.id, sensitivity: 'finance' });
  },
});

// ——— Import: FX rates ———

export interface FxRateImportRow {
  fromCurrency: string;
  toCurrency: string;
  rate: string;
  effectiveDate: string;
  source: string;
}

defineImportDataset<FxRateImportRow>({
  key: 'fx_rates',
  label: 'FX Rates',
  permission: 'finance.post',
  columns: [
    { key: 'from_currency', label: 'From Currency', type: 'currency', required: true, aliases: ['from'] },
    { key: 'to_currency', label: 'To Currency', type: 'currency', required: true, aliases: ['to'] },
    { key: 'rate', label: 'Rate', type: 'decimal', required: true },
    { key: 'effective_date', label: 'Effective Date', type: 'date', required: true, aliases: ['date'] },
    { key: 'source', label: 'Source Note', type: 'text', required: true },
  ],
  duplicatePolicies: ['skip', 'revise_existing', 'error'],
  async validate(ctx, row, opts) {
    const errors: ImportIssue[] = [];
    const warnings: ImportIssue[] = [];
    const from = str(row.from_currency).toUpperCase();
    const to = str(row.to_currency).toUpperCase();
    const rate = str(row.rate);
    const effectiveDate = str(row.effective_date);
    const source = str(row.source);
    if (!SUPPORTED_CURRENCIES.includes(from)) errors.push({ field: 'from_currency', code: 'CURRENCY', message: 'Unsupported currency.' });
    if (!SUPPORTED_CURRENCIES.includes(to)) errors.push({ field: 'to_currency', code: 'CURRENCY', message: 'Unsupported currency.' });
    if (from === to) errors.push({ field: 'to_currency', code: 'SAME', message: 'Use two different currencies.' });
    if (!/^\d+(\.\d{1,10})?$/.test(rate) || !isPositiveRate(rate)) errors.push({ field: 'rate', code: 'RATE', message: 'Enter a positive rate with a dot and at most 10 decimals.' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) errors.push({ field: 'effective_date', code: 'DATE', message: 'Use the YYYY-MM-DD format.' });
    if (source.length < 2) errors.push({ field: 'source', code: 'REQUIRED', message: 'Describe where the rate comes from.' });
    let action: 'create' | 'update' | 'skip' = 'create';
    let targetId: string | undefined;
    let targetRowVersion: number | undefined;
    if (!errors.length) {
      const [dup] = await dbOf(ctx)
        .select()
        .from(fxRates)
        .where(and(eq(fxRates.workspaceId, ctx.actor.workspaceId), eq(fxRates.fromCurrency, from), eq(fxRates.toCurrency, to), eq(fxRates.effectiveDate, effectiveDate), eq(fxRates.source, source)));
      if (dup) {
        if (opts.duplicatePolicy === 'skip') {
          action = 'skip';
          warnings.push({ field: 'rate', code: 'DUPLICATE_SKIPPED', message: 'A rate for this pair, date and source exists; skipped.' });
        } else if (opts.duplicatePolicy === 'revise_existing' && !dup.firstUsedAt) {
          action = 'update';
          targetId = dup.id;
          targetRowVersion = dup.rowVersion;
        } else errors.push({ field: 'rate', code: 'DUPLICATE', message: dup.firstUsedAt ? 'The existing rate was used by posted records and is frozen.' : 'A rate for this pair, date and source exists.' });
      }
    }
    return { action, targetId, targetRowVersion, dedupeKey: `${from}/${to}/${effectiveDate}/${source}`, errors, warnings, normalized: { fromCurrency: from, toCurrency: to, rate, effectiveDate, source } };
  },
  async apply(ctx, row, v) {
    if (v.action === 'update' && v.targetId) {
      await updateFxRate({ ...ctx, request: { ...ctx.request, expectedVersion: v.targetRowVersion } }, v.targetId, { rate: row.rate });
      return v.targetId;
    }
    return createFxRate(ctx, row, { source: 'import' });
  },
  async undo(ctx, entityId) {
    const [r] = await ctx.tx.select().from(fxRates).where(and(eq(fxRates.workspaceId, ctx.actor.workspaceId), eq(fxRates.id, entityId))).for('update');
    if (!r) return;
    if (r.firstUsedAt) throw new AppError('INVALID_STATE', 'This rate was used by posted records and is kept.', { details: { reason: 'rate_used', rateId: r.id } });
    await ctx.tx.delete(fxRates).where(eq(fxRates.id, r.id));
    await audit(ctx, { action: 'fx_rate.import_undone', entityType: 'fx_rate', entityId: r.id, sensitivity: 'finance' });
  },
});

// ——— Export: ledger lines (one row per allocation) ———

defineExportDataset({
  key: 'finance_ledger_lines',
  label: 'Ledger Lines',
  permission: 'finance.read',
  classification: 'finance',
  columns: [
    { key: 'entry_id', label: 'Entry ID', type: 'id', default: true },
    { key: 'entry_title', label: 'Entry', type: 'text', default: true },
    { key: 'entry_type', label: 'Type', type: 'text', default: true },
    { key: 'state', label: 'State', type: 'text', default: true },
    { key: 'recognition_date', label: 'Recognition Date', type: 'date', default: true },
    { key: 'line_no', label: 'Line', type: 'integer', default: true },
    { key: 'category', label: 'Category', type: 'text', default: true },
    { key: 'accounting_class', label: 'Accounting Class', type: 'text', default: true },
    { key: 'project', label: 'Project', type: 'text', default: true },
    { key: 'amount', label: 'Amount', type: 'amount', default: true, permission: 'finance.read' },
    { key: 'currency', label: 'Currency', type: 'currency', default: true },
    { key: 'fx_rate', label: 'FX Rate', type: 'decimal', permission: 'finance.read' },
    { key: 'base_amount', label: 'Base Amount', type: 'amount', default: true, permission: 'finance.read' },
    { key: 'base_currency', label: 'Base Currency', type: 'currency', default: true },
    { key: 'is_reversal', label: 'Reversal', type: 'boolean', default: true },
    { key: 'components_unknown', label: 'Net Only (components unknown)', type: 'boolean' },
    { key: 'source_namespace', label: 'Source Namespace', type: 'text' },
    { key: 'source_external_id', label: 'Source Transaction ID', type: 'text' },
    { key: 'transaction_ref', label: 'Line Transaction Ref', type: 'text' },
    { key: 'allocation_effective_date', label: 'Allocation Effective Date', type: 'date' },
  ],
  filters: [
    { key: 'from', label: 'From', type: 'date' },
    { key: 'to', label: 'To', type: 'date' },
    { key: 'state', label: 'State', type: 'enum', enumValues: ['posted', 'draft', 'submitted', 'rejected'] },
    { key: 'projectId', label: 'Project', type: 'reference', lookup: 'project' },
  ],
  async *rows(ctx, input) {
    const db = dbOf(ctx);
    const ws = ctx.actor.workspaceId;
    const f = input.filters as { from?: string; to?: string; state?: string; projectId?: string };
    const filter = listFilter(ctx.actor.access, 'finance.read');
    const allocScope =
      filter.kind === 'all'
        ? undefined
        : filter.kind === 'scoped' && filter.projectIds.length
          ? inArray(financialAllocations.projectId, filter.projectIds)
          : sql`false`;
    const cats = new Map((await db.select().from(financeCategories).where(eq(financeCategories.workspaceId, ws))).map((c) => [c.id, c.name]));
    const pnames = new Map((await db.select({ id: projects.id, name: projects.name }).from(projects).where(eq(projects.workspaceId, ws))).map((p) => [p.id, p.name]));
    let after = '00000000-0000-0000-0000-000000000000';
    for (;;) {
      const rows = await db
        .select({ a: financialAllocations, l: financialEntryLines, e: financialEntries })
        .from(financialAllocations)
        .innerJoin(financialEntryLines, eq(financialEntryLines.id, financialAllocations.lineId))
        .innerJoin(financialEntries, eq(financialEntries.id, financialAllocations.entryId))
        .where(
          and(
            eq(financialAllocations.workspaceId, ws),
            gt(financialAllocations.id, after),
            lte(financialAllocations.createdAt, input.boundAt),
            entryVisibilitySql(ctx),
            allocScope,
            f.state ? eq(financialEntries.state, f.state as never) : eq(financialEntries.state, 'posted'),
            f.from ? sql`${financialAllocations.effectiveDate} >= ${f.from}` : undefined,
            f.to ? sql`${financialAllocations.effectiveDate} <= ${f.to}` : undefined,
            f.projectId ? eq(financialAllocations.projectId, f.projectId) : undefined,
          ),
        )
        .orderBy(asc(financialAllocations.id))
        .limit(1000);
      if (!rows.length) return;
      for (const { a, l, e } of rows) {
        const cur = l.currency.trim();
        const base = l.baseCurrency.trim();
        const sign = l.isReversal ? -1n : 1n;
        yield {
          entry_id: e.id,
          entry_title: e.title,
          entry_type: e.type,
          state: e.state === 'posted' && e.reversedByEntryId ? 'reversed' : e.state,
          recognition_date: e.recognitionDate,
          line_no: l.lineNo,
          category: cats.get(l.categoryId) ?? null,
          accounting_class: l.accountingClass,
          project: a.projectId ? (pnames.get(a.projectId) ?? a.projectId) : 'Unallocated',
          amount: formatMinor(a.amountMinor * sign, cur),
          currency: cur,
          fx_rate: l.fxRate,
          base_amount: a.baseAmountMinor === null ? null : formatMinor(a.baseAmountMinor * sign, base),
          base_currency: base,
          is_reversal: l.isReversal,
          components_unknown: l.componentsUnknown,
          source_namespace: e.sourceNamespace,
          source_external_id: e.sourceExternalId,
          transaction_ref: l.transactionRef,
          allocation_effective_date: a.effectiveDate,
        };
      }
      after = rows[rows.length - 1]!.a.id;
    }
  },
});

// ——— Export: compensation lines (current calculation version of each run) ———

defineExportDataset({
  key: 'compensation_lines',
  label: 'Compensation Lines',
  permission: 'compensation.runs.read',
  classification: 'finance',
  columns: [
    { key: 'run_id', label: 'Run ID', type: 'id', default: true },
    { key: 'period_start', label: 'Period Start', type: 'date', default: true },
    { key: 'period_end', label: 'Period End', type: 'date', default: true },
    { key: 'run_state', label: 'Run State', type: 'text', default: true },
    { key: 'recipient', label: 'Recipient', type: 'text', default: true },
    { key: 'component', label: 'Component', type: 'text', default: true },
    { key: 'source_type', label: 'Source Type', type: 'text', default: true },
    { key: 'source_label', label: 'Source', type: 'text', default: true },
    { key: 'entitlement_key', label: 'Entitlement Key', type: 'text' },
    { key: 'quantity', label: 'Quantity', type: 'decimal', default: true },
    { key: 'rate', label: 'Rate', type: 'text' },
    { key: 'amount', label: 'Amount', type: 'amount', default: true, permission: 'compensation.runs.read' },
    { key: 'currency', label: 'Currency', type: 'currency', default: true },
    { key: 'excluded', label: 'Excluded', type: 'boolean', default: true },
    { key: 'exclusion_reason', label: 'Exclusion Reason', type: 'text' },
  ],
  filters: [
    { key: 'runId', label: 'Run', type: 'text' },
    { key: 'from', label: 'Period From', type: 'date' },
    { key: 'to', label: 'Period To', type: 'date' },
  ],
  async *rows(ctx, input) {
    if (!can(ctx.actor.access, 'compensation.runs.read')) throw new AppError('FORBIDDEN', 'Compensation exports need workspace-wide compensation access.');
    const db = dbOf(ctx);
    const ws = ctx.actor.workspaceId;
    const f = input.filters as { runId?: string; from?: string; to?: string };
    const runs = await db
      .select()
      .from(compensationRuns)
      .where(
        and(
          eq(compensationRuns.workspaceId, ws),
          lte(compensationRuns.createdAt, input.boundAt),
          f.runId ? eq(compensationRuns.id, f.runId) : undefined,
          f.from ? sql`${compensationRuns.periodEnd} >= ${f.from}` : undefined,
          f.to ? sql`${compensationRuns.periodStart} <= ${f.to}` : undefined,
        ),
      )
      .orderBy(asc(compensationRuns.periodStart), asc(compensationRuns.id));
    for (const r of runs) {
      const lines = await db
        .select()
        .from(compensationLines)
        .where(and(eq(compensationLines.workspaceId, ws), eq(compensationLines.runId, r.id), eq(compensationLines.calculationVersion, r.calculationVersion)))
        .orderBy(asc(compensationLines.recipientMembershipId), asc(compensationLines.entitlementKey));
      const refs = await loadMemberRefs(db, ws, lines.map((l) => l.recipientMembershipId));
      for (const l of lines)
        yield {
          run_id: r.id,
          period_start: r.periodStart,
          period_end: r.periodEnd,
          run_state: r.state,
          recipient: refs.get(l.recipientMembershipId)?.displayName ?? 'Former Member',
          component: l.component,
          source_type: l.sourceType,
          source_label: (l.explanation.sourceLabel as string | undefined) ?? l.sourceId,
          entitlement_key: l.entitlementKey,
          quantity: l.quantity,
          rate: l.rate,
          amount: formatMinor(l.amountMinor, l.currency.trim()),
          currency: l.currency.trim(),
          excluded: l.excluded,
          exclusion_reason: l.exclusionReason,
        };
    }
  },
});
