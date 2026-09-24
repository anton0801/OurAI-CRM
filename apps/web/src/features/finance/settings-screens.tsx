'use client';
import { CurrencyCircleDollar, Plus, Tag } from '@phosphor-icons/react';
import { useState } from 'react';
import { financeEndpoints as F, type FinanceCategory, type FxRate } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { ACCOUNTING_CLASSES } from '@castlane/domain';
import { Badge, Banner, Button, DataTable, DateInput, Dialog, EmptyState, Field, Input, PageHeader, Select, Switch, Toolbar, formatDate, formatDateTime, type Column } from '@castlane/ui';
import { QueryState } from '@/components/common/query-state';
import { useApiInfinite, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';
import { useCan, useWorkspace } from '@/lib/workspace-context';
import { CurrencySelect, FinanceNav, ReasonDialog, apiMessage, currencyOptions, isConflict, useFinanceParams, useFinanceMutation } from './common';

const fieldErrorsOf = (e: unknown) => (isApiError(e) ? Object.fromEntries(e.fieldErrors.map((x) => [x.field.replace(/^body\./, ''), x.message])) : {});

// ——— FX rates ———

/** FX rates with source and effective date. Rates used by posted records are frozen. */
export const FxRatesScreen = () => {
  const can = useCan();
  const { workspace, user } = useWorkspace();
  const params = useFinanceParams();
  const { state, set } = useUrlState<'from' | 'to'>();
  const query = { fromCurrency: state.from, toCurrency: state.to };
  const data = useApiInfinite(F.fxRatesList, { params, query });
  const [dialog, setDialog] = useState<{ rate?: FxRate } | null>(null);
  const manage = can('finance.post');
  const columns: Column<FxRate>[] = [
    { key: 'pair', header: 'Pair', sticky: true, minWidth: 120, cell: (r) => <span className="font-mono">{`${r.fromCurrency} → ${r.toCurrency}`}</span> },
    { key: 'rate', header: 'Rate', align: 'right', minWidth: 120, cell: (r) => <span className="font-mono tabular-nums">{r.rate}</span> },
    { key: 'date', header: 'Effective', minWidth: 120, cell: (r) => formatDate(r.effectiveDate) },
    { key: 'source', header: 'Source', minWidth: 180, cell: (r) => r.source },
    { key: 'used', header: 'Used', minWidth: 170, cell: (r) => (r.locked ? <Badge tone="info">Used by posted records</Badge> : <span className="text-fg-muted">Not used</span>) },
    { key: 'created', header: 'Added', minWidth: 190, cell: (r) => `${formatDateTime(r.createdAt, user.timezone)}${r.createdBy ? ` · ${r.createdBy.displayName}` : ''}` },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      headerLabel: 'Actions',
      minWidth: 90,
      hidden: !manage,
      cell: (r) =>
        r.locked ? null : (
          <Button size="sm" variant="ghost" onClick={() => setDialog({ rate: r })}>
            Edit
          </Button>
        ),
    },
  ];
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="FX Rates"
        description={`Rates to ${workspace.baseCurrency}. Posting uses the latest rate on or before the recognition date and freezes it; later edits never change posted base amounts.`}
        actions={manage ? <Button variant="primary" icon={<Plus size={14} weight="bold" />} onClick={() => setDialog({})}>Add Rate</Button> : undefined}
      />
      <FinanceNav />
      <Toolbar>
        <div className="w-[140px]">
          <CurrencyFilter label="From" value={state.from ?? null} onChange={(v) => set({ from: v })} />
        </div>
        <div className="w-[140px]">
          <CurrencyFilter label="To" value={state.to ?? null} onChange={(v) => set({ to: v })} />
        </div>
      </Toolbar>
      <QueryState query={data}>
        {data.items.length === 0 && !data.isFetching ? (
          <EmptyState icon={<CurrencyCircleDollar size={28} />} title="No FX rates" description="Add a rate with its source and effective date before posting entries in other currencies." />
        ) : (
          <DataTable caption="FX rates" rows={data.items} columns={columns} getRowId={(r) => r.id} density={user.density} hasMore={data.hasNextPage} loadingMore={data.isFetchingNextPage} onLoadMore={() => void data.fetchNextPage()} />
        )}
      </QueryState>
      {dialog ? <FxRateDialog rate={dialog.rate} onClose={() => setDialog(null)} /> : null}
    </div>
  );
};

const CurrencyFilter = ({ label: l, value, onChange }: { label: string; value: string | null; onChange: (v: string | null) => void }) => (
  <Select aria-label={`${l} currency`} placeholder={l} value={value} onChange={onChange} options={currencyOptions} searchable clearable />
);

const FxRateDialog = ({ rate, onClose }: { rate?: FxRate; onClose: () => void }) => {
  const { workspace } = useWorkspace();
  const params = useFinanceParams();
  const [from, setFrom] = useState(rate?.fromCurrency ?? 'USD');
  const [to, setTo] = useState(rate?.toCurrency ?? workspace.baseCurrency);
  const [value, setValue] = useState(rate?.rate ?? '');
  const [date, setDate] = useState(rate?.effectiveDate ?? new Date().toISOString().slice(0, 10));
  const [source, setSource] = useState(rate?.source ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const create = useFinanceMutation(F.fxRatesCreate, { invalidate: ['finance.'], silentErrors: true, successMessage: 'FX rate added' });
  const update = useFinanceMutation(F.fxRatesUpdate, { invalidate: ['finance.'], silentErrors: true, successMessage: 'FX rate updated' });
  const valid = /^\d+(\.\d{1,10})?$/.test(value.trim()) && Number(value) > 0 && source.trim().length >= 2 && !!date && from !== to;
  const save = async () => {
    setError(null);
    try {
      if (rate) await update.run({ params: { ...params, rateId: rate.id }, body: { rate: value.trim(), source: source.trim() } }, { ifMatch: rate.rowVersion });
      else await create.run({ params, body: { fromCurrency: from, toCurrency: to, rate: value.trim(), effectiveDate: date, source: source.trim() } });
      onClose();
    } catch (e) {
      setErrors(fieldErrorsOf(e));
      setError(isConflict(e) ? 'This rate changed or was used in the meantime. Close and reload.' : apiMessage(e));
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="small"
      title={rate ? 'Edit FX Rate' : 'Add FX Rate'}
      description="1 unit of the first currency equals the rate in the second currency."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={create.isPending || update.isPending} disabled={!valid} onClick={() => void save()}>
            {rate ? 'Save' : 'Add Rate'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <div className="grid grid-cols-2 gap-3">
          <Field label="From" required error={errors.fromCurrency}>
            <CurrencySelect value={from} onChange={setFrom} disabled={!!rate} />
          </Field>
          <Field label="To" required error={errors.toCurrency}>
            <CurrencySelect value={to} onChange={setTo} disabled={!!rate} />
          </Field>
        </div>
        <Field label="Rate" required error={errors.rate} helper="Up to 10 decimals.">
          <Input inputMode="decimal" className="text-right font-mono" value={value} onChange={(e) => /^\d*(\.\d*)?$/.test(e.target.value) && setValue(e.target.value)} />
        </Field>
        <Field label="Effective Date" required error={errors.effectiveDate}>
          <DateInput value={date} onChange={(e) => setDate(e.target.value)} disabled={!!rate} />
        </Field>
        <Field label="Source" required error={errors.source} helper="Where the rate comes from, e.g. ECB reference rate, bank statement.">
          <Input value={source} maxLength={200} onChange={(e) => setSource(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
};

// ——— Categories ———

/** Finance categories: the accounting class is fixed; categories are archived, never deleted. */
export const CategoriesScreen = () => {
  const can = useCan();
  const { user } = useWorkspace();
  const params = useFinanceParams();
  const { state, set } = useUrlState<'archived'>();
  const q = useApiQuery(F.categoriesList, { params, query: { includeArchived: state.archived === '1' ? true : undefined } });
  const [dialog, setDialog] = useState<{ category?: FinanceCategory } | null>(null);
  const [archive, setArchive] = useState<FinanceCategory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const archiveM = useFinanceMutation(F.categoriesArchive, { invalidate: ['finance.'], silentErrors: true });
  const manage = can('finance.post');
  const columns: Column<FinanceCategory>[] = [
    {
      key: 'name',
      header: 'Category',
      sticky: true,
      minWidth: 200,
      cell: (c) => (
        <span className="flex items-center gap-2">
          <span className={c.archivedAt ? 'text-fg-muted' : 'text-fg'}>{c.name}</span>
          {c.isSystem ? <Badge>Default</Badge> : null}
          {c.archivedAt ? <Badge>Archived</Badge> : null}
        </span>
      ),
    },
    { key: 'class', header: 'Accounting Class', minWidth: 190, cell: (c) => label('accountingClass', c.accountingClass) },
    { key: 'key', header: 'Key', minWidth: 160, cell: (c) => <span className="font-mono text-[12px] text-fg-2">{c.key}</span> },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      headerLabel: 'Actions',
      minWidth: 170,
      hidden: !manage,
      cell: (c) => (
        <span className="flex gap-1">
          {!c.archivedAt ? (
            <Button size="sm" variant="ghost" onClick={() => setDialog({ category: c })}>
              Rename
            </Button>
          ) : null}
          {c.archivedAt ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                void archiveM
                  .run({ params: { ...params, categoryId: c.id }, body: { restore: true } }, { ifMatch: c.rowVersion })
                  .catch((e) => setError(apiMessage(e)))
              }
            >
              Restore
            </Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => { setError(null); setArchive(c); }}>
              Archive
            </Button>
          )}
        </span>
      ),
    },
  ];
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Finance Categories"
        description="Each category has one accounting class that decides where its amounts count. Archived categories stay in history."
        actions={manage ? <Button variant="primary" icon={<Plus size={14} weight="bold" />} onClick={() => setDialog({})}>New Category</Button> : undefined}
      />
      <FinanceNav />
      <Toolbar>
        <div className="px-1">
          <Switch label="Show archived" checked={state.archived === '1'} onCheckedChange={(v) => set({ archived: v ? '1' : null })} />
        </div>
      </Toolbar>
      {error ? <Banner tone="danger">{error}</Banner> : null}
      <QueryState query={q}>
        {q.data && q.data.length === 0 ? (
          <EmptyState icon={<Tag size={28} />} title="No categories" description="Create categories for revenue, refunds, fees and costs." />
        ) : (
          <DataTable caption="Finance categories" rows={q.data ?? []} columns={columns} getRowId={(c) => c.id} density={user.density} />
        )}
      </QueryState>
      {dialog ? <CategoryDialog category={dialog.category} onClose={() => setDialog(null)} /> : null}
      <ReasonDialog
        open={!!archive}
        onOpenChange={(o) => !o && setArchive(null)}
        title="Archive Category"
        body="Archived records remain available in historical reports. The category can no longer be used on new entries."
        confirmLabel="Archive"
        reasonOptional
        loading={archiveM.isPending}
        error={error}
        onConfirm={(reason) =>
          void archiveM
            .run({ params: { ...params, categoryId: archive!.id }, body: { reason: reason || undefined } }, { ifMatch: archive!.rowVersion })
            .then(() => setArchive(null))
            .catch((e) => setError(apiMessage(e)))
        }
      />
    </div>
  );
};

const CategoryDialog = ({ category, onClose }: { category?: FinanceCategory; onClose: () => void }) => {
  const params = useFinanceParams();
  const [name, setName] = useState(category?.name ?? '');
  const [cls, setCls] = useState<(typeof ACCOUNTING_CLASSES)[number]>(category?.accountingClass ?? 'operating_expense');
  const [error, setError] = useState<string | null>(null);
  const create = useFinanceMutation(F.categoriesCreate, { invalidate: ['finance.', 'lookup.'], silentErrors: true, successMessage: 'Category created' });
  const update = useFinanceMutation(F.categoriesUpdate, { invalidate: ['finance.', 'lookup.'], silentErrors: true, successMessage: 'Category renamed' });
  const save = async () => {
    setError(null);
    try {
      if (category) await update.run({ params: { ...params, categoryId: category.id }, body: { name: name.trim() } }, { ifMatch: category.rowVersion });
      else await create.run({ params, body: { name: name.trim(), accountingClass: cls } });
      onClose();
    } catch (e) {
      setError(apiMessage(e));
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="small"
      title={category ? 'Rename Category' : 'New Category'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={create.isPending || update.isPending} disabled={name.trim().length < 2} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <Field label="Name" required>
          <Input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Accounting Class" required helper={category ? 'The class is fixed after creation.' : 'Cannot be changed later.'}>
          <Select value={cls} onChange={(v) => v && setCls(v)} disabled={!!category} options={ACCOUNTING_CLASSES.map((c) => ({ value: c, label: label('accountingClass', c) }))} />
        </Field>
      </div>
    </Dialog>
  );
};
