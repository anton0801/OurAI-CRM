'use client';
import { Plus, Trash } from '@phosphor-icons/react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { financeEndpoints as F, type EntryDetail, type FinanceCategory } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { ENTRY_TYPE_CLASSES, FINANCE_ENTRY_TYPES, formatMinor, tryParseAmountToMinor } from '@castlane/domain';
import {
  AmountInput,
  Banner,
  Button,
  Checkbox,
  DateInput,
  Field,
  IconButton,
  Input,
  PageHeader,
  Panel,
  PermissionDenied,
  Select,
  Switch,
  Textarea,
  toast,
} from '@castlane/ui';
import { ConflictDialog } from '@/components/common/conflict';
import { changedFields, pickChanged, useEditBase } from '@/lib/edit-base';
import { EntitySelect } from '@/components/common/entity-select';
import { useApiQuery } from '@/lib/hooks';
import { useUnsavedChangesGuard } from '@/lib/unsaved';
import { label } from '@/lib/labels';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';
import { AllocationEditor, allocationToSpec, emptyAllocation, rowKey, type AllocationForm } from './allocation-editor';
import { CurrencySelect, apiMessage, decimalOk, useFinanceParams, useFinanceMutation } from './common';

type EntryType = (typeof FINANCE_ENTRY_TYPES)[number];

type LineForm = {
  key: string;
  categoryId: string | null;
  amount: string;
  currency: string;
  description: string;
  transactionRef: string;
  commitmentId: string | null;
  fxEffect: 'gain' | 'loss' | null;
  ownAllocation: AllocationForm | null;
};

type FormState = {
  type: EntryType;
  title: string;
  recognitionDate: string;
  counterparty: string;
  sourceNamespace: string;
  sourceExternalId: string;
  accountId: string | null;
  campaignId: string | null;
  dealId: string | null;
  shiftId: string | null;
  refundOfEntryId: string | null;
  note: string;
  netOnly: boolean;
  controlTotal: string;
  lines: LineForm[];
  allocation: AllocationForm;
};

const newLine = (currency: string): LineForm => ({ key: rowKey(), categoryId: null, amount: '', currency, description: '', transactionRef: '', commitmentId: null, fxEffect: null, ownAllocation: null });

/** Rebuild an allocation form from a draft line's stored rows (percent when shares were given, otherwise exact). */
const lineAllocation = (l: EntryDetail['lines'][number]): AllocationForm | null => {
  if (!l.allocations.length) return null;
  const percent = l.allocations.every((a) => a.sharePercent !== null);
  return {
    mode: percent ? 'percent' : 'exact',
    rows: l.allocations.map((a) => ({ key: rowKey(), target: a.project ? 'project' : 'unallocated', projectId: a.project?.id ?? null, value: percent ? a.sharePercent! : a.amount.amount })),
  };
};

const sameAllocation = (a: AllocationForm | null, b: AllocationForm | null) =>
  !!a && !!b && a.mode === 'percent' && b.mode === 'percent' && JSON.stringify(a.rows.map((r) => [r.projectId, r.value])) === JSON.stringify(b.rows.map((r) => [r.projectId, r.value]));

const fromEntry = (e: EntryDetail): FormState => {
  const allocs = e.lines.map(lineAllocation);
  const shared = allocs.length > 0 && allocs.every((a) => sameAllocation(a, allocs[0]!)) ? allocs[0]! : null;
  return {
    type: e.type,
    title: e.title,
    recognitionDate: e.recognitionDate,
    counterparty: e.counterparty ?? '',
    sourceNamespace: e.source?.namespace ?? '',
    sourceExternalId: e.source?.externalId ?? '',
    accountId: e.account?.id ?? null,
    campaignId: e.campaign?.id ?? null,
    dealId: e.deal?.id ?? null,
    shiftId: e.shiftId,
    refundOfEntryId: e.refundOfEntryId,
    note: e.note ?? '',
    netOnly: e.netOnly,
    controlTotal: e.controlTotal?.amount ?? '',
    lines: e.lines.map((l, i) => ({
      key: rowKey(),
      categoryId: l.category.id,
      amount: l.amount.amount,
      currency: l.amount.currency,
      description: l.description ?? '',
      transactionRef: l.transactionRef ?? '',
      commitmentId: l.commitment?.id ?? null,
      fxEffect: l.fxEffect,
      ownAllocation: shared ? null : allocs[i] ?? null,
    })),
    allocation: shared ?? emptyAllocation(),
  };
};

const DECIMAL = /^\d+(\.\d+)?$/;

/**
 * S56 Financial Entry editor (new draft or draft/rejected edit). Save Draft keeps incomplete FX;
 * Submit sends it for posting by another approver. Nothing here posts.
 */
export const EntryEditor = ({ entry, onDone }: { entry?: EntryDetail; onDone?: () => void }) => {
  const router = useRouter();
  const search = useSearchParams();
  const wsPath = useWsPath();
  const can = useCan();
  const { workspace } = useWorkspace();
  const params = useFinanceParams();
  const base = workspace.baseCurrency;
  const initial = useMemo<FormState>(() => {
    if (entry) return fromEntry(entry);
    const t = search.get('type');
    const type: EntryType = (FINANCE_ENTRY_TYPES as readonly string[]).includes(t ?? '') ? (t as EntryType) : 'expense';
    const projectId = search.get('projectId');
    return {
      type,
      title: '',
      recognitionDate: new Date().toISOString().slice(0, 10),
      counterparty: '',
      sourceNamespace: '',
      sourceExternalId: '',
      accountId: search.get('accountId'),
      campaignId: search.get('campaignId'),
      dealId: search.get('dealId'),
      shiftId: null,
      refundOfEntryId: search.get('refundOf'),
      note: '',
      netOnly: false,
      controlTotal: '',
      lines: [newLine(base)],
      allocation: projectId ? { mode: 'percent', rows: [{ key: rowKey(), target: 'project', projectId, value: '100' }] } : emptyAllocation(),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry?.id]);
  const [f, setF] = useState<FormState>(initial);
  const [dirty, setDirty] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  // The draft is edited against the entry as it was opened (If-Match, changed fields only), so a
  // background refresh can neither overwrite someone else's change nor reset the typing (T162).
  const edit = useEditBase(entry, {
    onReload: (latest) => {
      setF(fromEntry(latest));
      setDirty(false);
    },
  });
  const [pendingAction, setPendingAction] = useState<'save' | 'submit' | null>(null);
  useUnsavedChangesGuard(dirty);
  const cats = useApiQuery(F.categoriesList, { params, query: {} }, { staleTime: 60_000 });
  const commitmentsQ = useApiQuery(F.commitmentsList, { params, query: { state: ['open', 'partially_consumed'], pageSize: 100 } }, { enabled: can('budgets.read') && f.type === 'expense', staleTime: 30_000 });
  const create = useFinanceMutation(F.entriesCreate, { invalidate: ['finance.'], silentErrors: true });
  const update = useFinanceMutation(F.entriesUpdate, { invalidate: ['finance.'], silentErrors: true });
  const submit = useFinanceMutation(F.entriesSubmit, { invalidate: ['finance.'], silentErrors: true });

  const patch = (p: Partial<FormState>) => {
    setF((x) => ({ ...x, ...p }));
    setDirty(true);
  };
  const patchLine = (i: number, p: Partial<LineForm>) => patch({ lines: f.lines.map((l, j) => (j === i ? { ...l, ...p } : l)) });

  const allowedClasses = ENTRY_TYPE_CLASSES[f.type];
  const catById = new Map((cats.data ?? []).map((c) => [c.id, c]));
  const categoryOptions = (cats.data ?? [])
    .filter((c: FinanceCategory) => allowedClasses.includes(c.accountingClass) && (!f.netOnly || c.accountingClass === 'revenue'))
    .map((c) => ({ value: c.id, label: c.name, description: label('accountingClass', c.accountingClass) }));
  const statement = f.type === 'platform_statement';
  const currencies = [...new Set(f.lines.map((l) => l.currency))];
  const singleCurrency = currencies.length === 1 ? currencies[0]! : null;

  // Signed total per currency (revenue +, refunds/fees/costs −), exact in minor units.
  const totals = currencies.map((cur) => {
    let sum = 0n;
    for (const l of f.lines.filter((x) => x.currency === cur)) {
      const m = l.amount ? tryParseAmountToMinor(l.amount, cur) : null;
      if (m === null) continue;
      const cls = l.categoryId ? catById.get(l.categoryId)?.accountingClass : undefined;
      const sign = cls === 'revenue' || (cls === 'fx_difference' && l.fxEffect === 'gain') ? 1n : -1n;
      sum += sign * m;
    }
    return { currency: cur, amount: formatMinor(sum, cur) };
  });
  const sharedAmount = singleCurrency ? f.lines.filter((l) => !l.ownAllocation).reduce((a, l) => a + (tryParseAmountToMinor(l.amount || '0', singleCurrency) ?? 0n), 0n) : null;

  const localErrors = (): Record<string, string> => {
    const e: Record<string, string> = {};
    if (f.title.trim().length < 2) e.title = 'Use 2–120 characters.';
    if (!f.recognitionDate) e.recognitionDate = 'Choose the recognition date.';
    f.lines.forEach((l, i) => {
      if (!l.categoryId) e[`lines.${i}.categoryId`] = 'Choose a category.';
      if (!DECIMAL.test(l.amount.trim())) e[`lines.${i}.amount`] = 'Enter an amount, e.g. 120.50.';
      if (l.categoryId && catById.get(l.categoryId)?.accountingClass === 'fx_difference' && !l.fxEffect) e[`lines.${i}.fxEffect`] = 'Choose gain or loss.';
    });
    if (statement && f.controlTotal && !/^-?\d+(\.\d+)?$/.test(f.controlTotal.trim())) e.controlTotal = 'Enter the statement total, e.g. 720.00.';
    const rowsOk = (a: AllocationForm, prefix: string) =>
      a.rows.forEach((r, j) => {
        if (r.target === 'project' && !r.projectId) e[`${prefix}.rows.${j}.value`] = 'Choose a project or Unallocated.';
      });
    rowsOk(f.allocation, 'allocation');
    f.lines.forEach((l, i) => l.ownAllocation && rowsOk(l.ownAllocation, `lines.${i}.allocation`));
    return e;
  };

  const bodyOf = (x: FormState) => ({
    type: x.type,
    title: x.title.trim(),
    recognitionDate: x.recognitionDate,
    counterparty: x.counterparty.trim() || null,
    sourceNamespace: x.sourceNamespace.trim() || null,
    sourceExternalId: x.sourceExternalId.trim() || null,
    accountId: x.accountId,
    campaignId: x.campaignId,
    dealId: x.dealId,
    shiftId: x.shiftId,
    refundOfEntryId: x.refundOfEntryId,
    note: x.note.trim() || null,
    netOnly: statement || x.type === 'revenue' ? x.netOnly : false,
    controlTotal: statement && x.controlTotal.trim() && singleCurrency ? { amount: x.controlTotal.trim(), currency: singleCurrency } : null,
    allocation: allocationToSpec(x.allocation),
    lines: x.lines.map((l) => ({
      categoryId: l.categoryId!,
      amount: l.amount.trim(),
      currency: l.currency,
      description: l.description.trim() || null,
      transactionRef: l.transactionRef.trim() || null,
      commitmentId: x.type === 'expense' ? l.commitmentId : null,
      fxEffect: l.categoryId && catById.get(l.categoryId)?.accountingClass === 'fx_difference' ? l.fxEffect : null,
      allocation: l.ownAllocation ? allocationToSpec(l.ownAllocation) : null,
    })),
  });
  const body = () => bodyOf(f);

  const save = async (andSubmit: boolean) => {
    setFormError(null);
    const local = localErrors();
    setErrors(local);
    if (Object.keys(local).length) {
      setFormError('Check the highlighted fields.');
      return;
    }
    setPendingAction(andSubmit ? 'submit' : 'save');
    try {
      const saved = entry
        ? await update.run(
            { params: { ...params, entryId: entry.id }, body: edit.start ? pickChanged(body(), changedFields(bodyOf(fromEntry(edit.start)), body())) : body() },
            { ifMatch: edit.version },
          )
        : await create.run({ params, body: body() });
      setDirty(false);
      if (andSubmit) {
        try {
          await submit.run({ params: { ...params, entryId: saved.id }, body: {} }, { ifMatch: saved.rowVersion });
          toast.success('Entry submitted for posting');
        } catch (e) {
          toast.error('The draft was saved but not submitted', apiMessage(e));
        }
      } else toast.success(entry ? 'Draft saved' : 'Draft created');
      if (onDone) onDone();
      else router.push(wsPath(`/finance/entries/${saved.id}`));
    } catch (e) {
      if (edit.catchConflict(e)) return;
      if (isApiError(e) && e.fieldErrors.length) {
        setErrors(Object.fromEntries(e.fieldErrors.map((x) => [x.field.replace(/^body\./, ''), x.message])));
        setFormError(e.message);
      } else setFormError(apiMessage(e, 'The entry could not be saved.'));
    } finally {
      setPendingAction(null);
    }
  };

  const lineErr = (i: number, k: string) => errors[`lines.${i}.${k}`];
  const commitmentOptions = (cur: string) =>
    (commitmentsQ.data?.items ?? []).filter((c) => c.remaining.currency === cur).map((c) => ({ value: c.id, label: c.description, description: `${c.project.name} · remaining ${c.remaining.amount} ${c.remaining.currency}` }));

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={entry ? `Edit ${entry.title}` : 'New Financial Entry'}
        crumbs={[{ label: 'Finance', href: wsPath('/finance') }, ...(entry ? [{ label: entry.title, href: wsPath(`/finance/entries/${entry.id}`) }] : []), { label: entry ? 'Edit' : 'New Entry' }]}
        description="Entries are saved as drafts. Posting is a separate step by an approver; posted entries are never edited, only reversed."
      />
      <form
        noValidate
        className="flex max-w-[1040px] flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          void save(false);
        }}
      >
        {formError ? <Banner tone="danger">{formError}</Banner> : null}
        {entry?.rejectedReason ? <Banner tone="warning">Rejected: {entry.rejectedReason}. Fix the draft and submit it again.</Banner> : null}
        <Panel title="Entry">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label="Type" required error={errors.type}>
              <Select value={f.type} onChange={(v) => v && patch({ type: v, netOnly: false, controlTotal: '' })} options={FINANCE_ENTRY_TYPES.map((t) => ({ value: t, label: label('entryType', t) }))} />
            </Field>
            <Field label="Recognition Date" required error={errors.recognitionDate} helper="The date the revenue or cost belongs to (accrual).">
              <DateInput value={f.recognitionDate} onChange={(e) => patch({ recognitionDate: e.target.value })} />
            </Field>
            <Field label="Title" required error={errors.title} className="md:col-span-2">
              <Input value={f.title} maxLength={120} onChange={(e) => patch({ title: e.target.value })} placeholder={statement ? 'e.g. Fansly statement March' : 'e.g. Editing studio invoice'} />
            </Field>
            <Field label="Counterparty" error={errors.counterparty}>
              <Input value={f.counterparty} maxLength={200} onChange={(e) => patch({ counterparty: e.target.value })} />
            </Field>
            {statement || f.type === 'revenue' ? (
              <div className="flex items-end">
                <Switch
                  label="Net Only"
                  description="The source reports only a net amount. Gross, refunds and fees stay Not provided."
                  checked={f.netOnly}
                  onCheckedChange={(v) => patch({ netOnly: v, lines: v ? [f.lines[0] ?? newLine(base)] : f.lines })}
                />
              </div>
            ) : null}
            {statement ? (
              <Field label="Statement Total" error={errors.controlTotal ?? errors['controlTotal.amount'] ?? errors['controlTotal.currency']} helper="Header total from the statement. It is a control sum, not a second income line.">
                <AmountInput currency={singleCurrency ?? '—'} value={f.controlTotal} onChange={(e) => decimalOk(e.target.value, true) && patch({ controlTotal: e.target.value })} disabled={!singleCurrency} />
              </Field>
            ) : null}
          </div>
        </Panel>

        <Panel
          title={statement ? 'Components' : 'Lines'}
          description={statement ? 'Gross sales, refunds and fees as separate lines; their net must match the statement total.' : undefined}
          actions={
            !f.netOnly ? (
              <Button size="sm" icon={<Plus size={12} />} onClick={() => patch({ lines: [...f.lines, newLine(f.lines[f.lines.length - 1]?.currency ?? base)] })} disabled={f.lines.length >= 200}>
                Add Line
              </Button>
            ) : undefined
          }
        >
          <div className="flex flex-col gap-4">
            {errors.lines ? <p className="text-[12px] text-danger">{errors.lines}</p> : null}
            {f.lines.map((l, i) => {
              const cls = l.categoryId ? catById.get(l.categoryId)?.accountingClass : undefined;
              return (
                <div key={l.key} className="flex flex-col gap-3 rounded-[12px] border border-line p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[12px] font-semibold text-fg-2">Line {i + 1}</span>
                    <IconButton label={`Remove line ${i + 1}`} icon={<Trash size={14} />} disabled={f.lines.length === 1} onClick={() => patch({ lines: f.lines.filter((_, j) => j !== i) })} />
                  </div>
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_120px]">
                    <Field label="Category" required error={lineErr(i, 'categoryId')}>
                      <Select value={l.categoryId} onChange={(v) => patchLine(i, { categoryId: v })} options={categoryOptions} searchable placeholder={cats.isLoading ? 'Loading…' : 'Choose a category'} />
                    </Field>
                    <Field label="Amount" required error={lineErr(i, 'amount')} helper={cls && cls !== 'revenue' && cls !== 'fx_difference' ? 'Enter a positive amount; the category sets the sign.' : undefined}>
                      <AmountInput currency={l.currency} value={l.amount} onChange={(e) => decimalOk(e.target.value) && patchLine(i, { amount: e.target.value })} />
                    </Field>
                    <Field label="Currency" required error={lineErr(i, 'currency')}>
                      <CurrencySelect value={l.currency} onChange={(v) => patchLine(i, { currency: v })} />
                    </Field>
                    <Field label="Description" error={lineErr(i, 'description')} className="md:col-span-2">
                      <Input value={l.description} maxLength={500} onChange={(e) => patchLine(i, { description: e.target.value })} />
                    </Field>
                    <Field label="Transaction ID" error={lineErr(i, 'transactionRef')} helper={statement ? 'Platform transaction reference, if listed.' : undefined}>
                      <Input value={l.transactionRef} maxLength={200} onChange={(e) => patchLine(i, { transactionRef: e.target.value })} />
                    </Field>
                    {cls === 'fx_difference' ? (
                      <Field label="FX Effect" required error={lineErr(i, 'fxEffect')}>
                        <Select value={l.fxEffect} onChange={(v) => patchLine(i, { fxEffect: v })} options={[{ value: 'gain' as const, label: 'Gain' }, { value: 'loss' as const, label: 'Loss' }]} />
                      </Field>
                    ) : null}
                    {f.type === 'expense' && can('budgets.read') ? (
                      <Field label="Commitment" error={lineErr(i, 'commitmentId')} helper="Posting consumes the commitment, so it is not counted twice." className="md:col-span-2">
                        <Select value={l.commitmentId} onChange={(v) => patchLine(i, { commitmentId: v })} options={commitmentOptions(l.currency)} clearable placeholder="No commitment" />
                      </Field>
                    ) : null}
                  </div>
                  <Checkbox
                    checked={!!l.ownAllocation}
                    onCheckedChange={(v) => patchLine(i, { ownAllocation: v ? emptyAllocation() : null })}
                    label="Allocate this line separately"
                    description="Otherwise the entry allocation below applies."
                  />
                  {l.ownAllocation ? (
                    <AllocationEditor
                      value={l.ownAllocation}
                      onChange={(a) => patchLine(i, { ownAllocation: a })}
                      amount={l.amount}
                      currency={l.currency}
                      errors={Object.fromEntries(Object.entries(errors).filter(([k]) => k.startsWith(`lines.${i}.allocation`)).map(([k, v]) => [k.replace(`lines.${i}.`, ''), v]))}
                    />
                  ) : null}
                </div>
              );
            })}
            <div className="flex flex-wrap justify-end gap-4 text-[13px]">
              {totals.map((t) => (
                <span key={t.currency} className="font-mono tabular-nums">
                  Net effect {t.amount} {t.currency}
                </span>
              ))}
            </div>
          </div>
        </Panel>

        <Panel title="Project / Allocation" description="Required for project results. Keep an explicit Unallocated row when the project is not known yet.">
          <AllocationEditor
            value={f.allocation}
            onChange={(a) => patch({ allocation: a })}
            amount={sharedAmount !== null && singleCurrency ? formatMinor(sharedAmount, singleCurrency) : undefined}
            currency={singleCurrency ?? base}
            errors={errors}
          />
        </Panel>

        <Panel title="Links and Source">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label="Source" error={errors.sourceNamespace} helper="System the record comes from, e.g. fansly, bank, manual.">
              <Input value={f.sourceNamespace} maxLength={60} onChange={(e) => patch({ sourceNamespace: e.target.value })} />
            </Field>
            <Field label="Source Transaction ID" error={errors.sourceExternalId} helper="Posting refuses a second entry with the same source and ID.">
              <Input value={f.sourceExternalId} maxLength={200} onChange={(e) => patch({ sourceExternalId: e.target.value })} />
            </Field>
            <Field label="Account" error={errors.accountId}>
              <EntitySelect type="account" value={f.accountId} onChange={(v) => patch({ accountId: v })} clearable placeholder="No account" />
            </Field>
            <Field label="Campaign" error={errors.campaignId}>
              <EntitySelect type="campaign" value={f.campaignId} onChange={(v) => patch({ campaignId: v })} clearable placeholder="No campaign" />
            </Field>
            <Field label="Deal" error={errors.dealId}>
              <EntitySelect type="deal" value={f.dealId} onChange={(v) => patch({ dealId: v })} clearable placeholder="No deal" />
            </Field>
            <Field label="Shift Reference" error={errors.shiftId}>
              <EntitySelect type="shift" value={f.shiftId} onChange={(v) => patch({ shiftId: v })} clearable placeholder="No shift" />
            </Field>
            {f.refundOfEntryId ? (
              <div className="md:col-span-2">
                <Banner tone="info" action={<Button size="sm" variant="ghost" onClick={() => patch({ refundOfEntryId: null })}>Remove</Button>}>
                  This entry records a refund of a posted revenue entry.
                </Banner>
                {errors.refundOfEntryId ? <p className="mt-1 text-[12px] text-danger">{errors.refundOfEntryId}</p> : null}
              </div>
            ) : null}
            <Field label="Note" error={errors.note} className="md:col-span-2">
              <Textarea value={f.note} maxLength={10000} onChange={(e) => patch({ note: e.target.value })} />
            </Field>
          </div>
          {!entry ? <p className="mt-3 text-[12px] text-fg-2">Save the draft to attach receipts and statements.</p> : null}
        </Panel>

        <div className="sticky bottom-0 z-10 -mx-4 flex flex-wrap justify-end gap-2 border-t border-line bg-surface px-4 py-3 md:static md:mx-0 md:border-0 md:bg-transparent md:p-0">
          <Button onClick={() => (onDone ? onDone() : router.back())} disabled={!!pendingAction}>
            Cancel
          </Button>
          <Button type="submit" loading={pendingAction === 'save'} disabled={!!pendingAction}>
            Save Draft
          </Button>
          {can('finance.submit') ? (
            <Button variant="primary" loading={pendingAction === 'submit'} disabled={!!pendingAction} onClick={() => void save(true)}>
              Submit
            </Button>
          ) : null}
        </div>
      </form>
      <ConflictDialog {...edit.conflictDialog} />
    </div>
  );
};

/** /finance/entries/new — members without finance.create see the standard permission state. */
export const NewEntryScreen = () => {
  const can = useCan();
  return can('finance.create') ? <EntryEditor /> : <PermissionDenied />;
};

