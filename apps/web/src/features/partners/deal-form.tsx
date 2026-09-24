'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { Plus, Trash } from '@phosphor-icons/react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Controller, useFieldArray, useForm } from 'react-hook-form';
import { z } from 'zod';
import { dealEndpoints, type DealDetail } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { SUPPORTED_CURRENCIES } from '@castlane/domain';
import { AmountInput, Banner, Button, DateInput, Field, IconButton, Input, PageHeader, Panel, Select } from '@castlane/ui';
import { ConflictDialog } from '@/components/common/conflict';
import { EntitySelect, MultiEntitySelect } from '@/components/common/entity-select';
import { MemberSelect } from '@/components/common/pickers';
import { applyFieldErrors, useApiMutation } from '@/lib/hooks';
import { useUnsavedChangesGuard } from '@/lib/unsaved';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';

const amount = z.string().trim().regex(/^(\d+(\.\d{1,3})?)?$/, 'Enter an amount like 1250.00.');
const schema = z.object({
  title: z.string().trim().min(2, 'Use 2–120 characters.').max(120, 'Use 2–120 characters.'),
  partnerId: z.string().uuid('Choose a partner.'),
  ownerMembershipId: z.string().uuid('Choose an owner.'),
  projectIds: z.array(z.string()).min(1, 'Choose at least one project.'),
  amount: amount.optional(),
  currency: z.string().length(3),
  expectedCloseDate: z.string().optional(),
  campaignId: z.string().nullable(),
  paymentSchedule: z.array(z.object({ dueDate: z.string().min(10, 'Choose a date.'), amount: amount.refine((v) => !!v, 'Enter an amount.'), note: z.string().max(500).optional() })).max(50),
});
type FormValues = z.infer<typeof schema>;

/**
 * Deal create/edit form (S74). Amounts are plans only and appear only for members with finance
 * access; the server omits and refuses them otherwise.
 */
export const DealForm = ({ deal, onDone, embedded }: { deal?: DealDetail; onDone?: () => void; embedded?: boolean }) => {
  const { workspace, membershipId } = useWorkspace();
  const can = useCan();
  const router = useRouter();
  const params = useSearchParams();
  const wsPath = useWsPath();
  const finance = deal ? deal.permissions.editAmounts : can('finance.read');
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: deal
      ? {
          title: deal.title,
          partnerId: deal.partner.id,
          ownerMembershipId: deal.owner.membershipId,
          projectIds: deal.projects.map((p) => p.id),
          amount: deal.amount?.amount ?? '',
          currency: deal.amount?.currency ?? workspace.baseCurrency,
          expectedCloseDate: deal.expectedCloseDate ?? '',
          campaignId: deal.campaign?.id ?? null,
          paymentSchedule: (deal.paymentSchedule ?? []).map((p) => ({ dueDate: p.dueDate, amount: p.amount, note: p.note ?? '' })),
        }
      : {
          title: '',
          partnerId: params.get('partnerId') ?? '',
          ownerMembershipId: membershipId,
          projectIds: params.get('projectId') ? [params.get('projectId')!] : [],
          amount: '',
          currency: workspace.baseCurrency,
          expectedCloseDate: '',
          campaignId: null,
          paymentSchedule: [],
        },
  });
  const schedule = useFieldArray({ control: form.control, name: 'paymentSchedule' });
  useUnsavedChangesGuard(form.formState.isDirty && !form.formState.isSubmitSuccessful);
  const create = useApiMutation(dealEndpoints.create, { invalidate: ['deals.', 'partners.'], silentErrors: true, successMessage: 'Deal created' });
  const update = useApiMutation(dealEndpoints.update, { invalidate: ['deals.', 'partners.'], silentErrors: true, successMessage: 'Deal saved' });
  const currency = form.watch('currency');
  const errors = form.formState.errors;

  const onSubmit = form.handleSubmit(async (v) => {
    setError(null);
    const body = {
      title: v.title.trim(),
      partnerId: v.partnerId,
      ownerMembershipId: v.ownerMembershipId,
      projectIds: v.projectIds,
      expectedCloseDate: v.expectedCloseDate || null,
      campaignId: v.campaignId,
      ...(finance
        ? {
            amount: v.amount ? { amount: v.amount, currency: v.currency } : null,
            paymentSchedule: v.paymentSchedule.map((p) => ({ dueDate: p.dueDate, amount: p.amount, currency: v.currency, ...(p.note?.trim() ? { note: p.note.trim() } : {}) })),
          }
        : {}),
    };
    try {
      if (deal) {
        await update.run({ params: { workspaceId: workspace.id, dealId: deal.id }, body }, { ifMatch: deal.rowVersion });
        onDone?.();
      } else {
        const r = await create.run({ params: { workspaceId: workspace.id }, body });
        form.reset(form.getValues());
        router.replace(wsPath(`/deals/${r.id}`));
      }
    } catch (e) {
      if (isApiError(e) && e.code === 'VERSION_CONFLICT') setConflict(true);
      else if (!applyFieldErrors(e, form.setError as never)) setError(isApiError(e) ? e.message : 'The deal could not be saved.');
    }
  });
  const pending = create.isPending || update.isPending;

  return (
    <div className="flex flex-col gap-5">
      {!embedded ? (
        <PageHeader
          title="New Deal"
          crumbs={[{ label: 'Partners', href: wsPath('/partners?tab=deals') }, { label: 'New Deal' }]}
          description="A deal starts as a Lead. Its amount is a plan: winning a deal never records income or payments."
        />
      ) : null}
      <form onSubmit={onSubmit} noValidate className="flex max-w-[920px] flex-col gap-5">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <Panel title="Deal">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label="Title" required error={errors.title?.message} className="md:col-span-2">
              <Input {...form.register('title')} maxLength={120} />
            </Field>
            <Field label="Partner" required error={errors.partnerId?.message}>
              <Controller control={form.control} name="partnerId" render={({ field }) => <EntitySelect type="partner" value={field.value || null} onChange={(v) => field.onChange(v ?? '')} />} />
            </Field>
            <Field label="Owner" required error={errors.ownerMembershipId?.message}>
              <Controller control={form.control} name="ownerMembershipId" render={({ field }) => <MemberSelect value={field.value} onChange={(v) => field.onChange(v ?? '')} />} />
            </Field>
            <Field label="Projects" required error={errors.projectIds?.message} className="md:col-span-2">
              <Controller control={form.control} name="projectIds" render={({ field }) => <MultiEntitySelect type="project" value={field.value} onChange={field.onChange} max={20} />} />
            </Field>
            <Field label="Expected close date">
              <DateInput {...form.register('expectedCloseDate')} />
            </Field>
            <Field label="Campaign" helper="Link an existing campaign, or create one from the deal page.">
              <Controller control={form.control} name="campaignId" render={({ field }) => <EntitySelect type="campaign" value={field.value} onChange={field.onChange} clearable />} />
            </Field>
          </div>
        </Panel>
        {finance ? (
          <Panel title="Planned amounts" description="Plans only. Income is recorded by finance when it is actually earned.">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field label="Amount" error={errors.amount?.message}>
                <AmountInput {...form.register('amount')} currency={currency} />
              </Field>
              <Field label="Currency">
                <Controller control={form.control} name="currency" render={({ field }) => <Select value={field.value} onChange={(v) => field.onChange(v ?? workspace.baseCurrency)} options={SUPPORTED_CURRENCIES.map((c) => ({ value: c, label: c }))} />} />
              </Field>
            </div>
            <div className="mt-4 flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <h3 className="text-[14px] font-semibold text-fg">Payment schedule</h3>
                <Button size="sm" icon={<Plus size={12} />} onClick={() => schedule.append({ dueDate: '', amount: '', note: '' })}>
                  Add Payment Date
                </Button>
              </div>
              {schedule.fields.length === 0 ? <p className="text-[13px] text-fg-2">No planned payment dates.</p> : null}
              {schedule.fields.map((f, i) => (
                <div key={f.id} className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[160px_160px_1fr_auto]">
                  <Field label="Due date" error={errors.paymentSchedule?.[i]?.dueDate?.message}>
                    <DateInput {...form.register(`paymentSchedule.${i}.dueDate`)} />
                  </Field>
                  <Field label="Amount" error={errors.paymentSchedule?.[i]?.amount?.message}>
                    <AmountInput {...form.register(`paymentSchedule.${i}.amount`)} currency={currency} />
                  </Field>
                  <Field label="Note">
                    <Input {...form.register(`paymentSchedule.${i}.note`)} maxLength={500} />
                  </Field>
                  <IconButton label={`Remove payment date ${i + 1}`} icon={<Trash size={16} />} onClick={() => schedule.remove(i)} />
                </div>
              ))}
            </div>
          </Panel>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button onClick={() => (onDone ? onDone() : router.back())} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={pending}>
            {deal ? 'Save' : 'Create Deal'}
          </Button>
        </div>
      </form>
      <ConflictDialog open={conflict} onOpenChange={setConflict} onReload={() => window.location.reload()} />
    </div>
  );
};
