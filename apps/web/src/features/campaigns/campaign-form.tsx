'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { Plus, Trash } from '@phosphor-icons/react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Controller, useFieldArray, useForm } from 'react-hook-form';
import { z } from 'zod';
import { campaignEndpoints as C, type CampaignDetail } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { Banner, Button, DateInput, Drawer, Field, IconButton, Input, Textarea } from '@castlane/ui';
import { ConflictDialog } from '@/components/common/conflict';
import { EntitySelect, MultiEntitySelect } from '@/components/common/entity-select';
import { MemberSelect } from '@/components/common/pickers';
import { AssetThumb, FileUploader } from '@/components/media/file-uploader';
import { applyFieldErrors, useApiMutation } from '@/lib/hooks';
import { useWorkspace, useWsPath } from '@/lib/workspace-context';
import { CAMPAIGN_INVALIDATE } from './labels';

const schema = z
  .object({
    name: z.string().trim().min(2, 'Use 2–120 characters.').max(120, 'Use 2–120 characters.'),
    objective: z.string().trim().min(3, 'Describe the objective (at least 3 characters).').max(2000),
    ownerMembershipId: z.string().uuid('Choose an owner.'),
    startDate: z.string().min(10, 'Choose a start date.'),
    endDate: z.string().min(10, 'Choose an end date.'),
    projectIds: z.array(z.string()).min(1, 'Choose at least one project.').max(50),
    partnerId: z.string().nullable(),
    goals: z
      .array(
        z.object({
          metricKey: z.string().trim().min(2, 'Name the metric.').max(80),
          target: z.string().trim().min(1, 'Enter a target.').max(40),
          unit: z.string().trim().min(1, 'Enter a unit.').max(20),
        }),
      )
      .max(20),
    tags: z.string().max(1200),
    coverAssetId: z.string().nullable(),
  })
  .refine((v) => !v.startDate || !v.endDate || v.endDate >= v.startDate, { path: ['endDate'], message: 'The end date must be on or after the start date.' });
type FormValues = z.infer<typeof schema>;

const splitTags = (s: string) => [...new Set(s.split(',').map((t) => t.trim()).filter(Boolean))];

/**
 * New / Edit Campaign drawer (S33/S34). Creating a campaign creates no accounts, metrics, costs or
 * results; it starts as Planned.
 */
export const CampaignFormDrawer = ({
  open,
  onOpenChange,
  campaign,
  initialProjectId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  campaign?: CampaignDetail;
  initialProjectId?: string | null;
}) => {
  const { workspace, membershipId } = useWorkspace();
  const router = useRouter();
  const wsPath = useWsPath();
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: campaign
      ? {
          name: campaign.name,
          objective: campaign.objective,
          ownerMembershipId: campaign.owner.membershipId,
          startDate: campaign.startDate,
          endDate: campaign.endDate,
          projectIds: campaign.projects.map((p) => p.id),
          partnerId: campaign.partner?.id ?? null,
          goals: campaign.goals,
          tags: campaign.tags.join(', '),
          coverAssetId: campaign.coverAssetId,
        }
      : {
          name: '',
          objective: '',
          ownerMembershipId: membershipId,
          startDate: '',
          endDate: '',
          projectIds: initialProjectId ? [initialProjectId] : [],
          partnerId: null,
          goals: [],
          tags: '',
          coverAssetId: null,
        },
  });
  const goals = useFieldArray({ control: form.control, name: 'goals' });
  const create = useApiMutation(C.create, { invalidate: CAMPAIGN_INVALIDATE, silentErrors: true, successMessage: 'Campaign created' });
  const update = useApiMutation(C.update, { invalidate: CAMPAIGN_INVALIDATE, silentErrors: true, successMessage: 'Campaign saved' });
  const errors = form.formState.errors;
  const cover = form.watch('coverAssetId');
  const projectIds = form.watch('projectIds');

  const submit = form.handleSubmit(async (v) => {
    setError(null);
    const body = {
      name: v.name.trim(),
      objective: v.objective.trim(),
      ownerMembershipId: v.ownerMembershipId,
      startDate: v.startDate,
      endDate: v.endDate,
      projectIds: v.projectIds,
      partnerId: v.partnerId,
      goals: v.goals.map((g) => ({ metricKey: g.metricKey.trim(), target: g.target.trim(), unit: g.unit.trim() })),
      tags: splitTags(v.tags),
      coverAssetId: v.coverAssetId,
    };
    try {
      if (campaign) {
        await update.run({ params: { workspaceId: workspace.id, campaignId: campaign.id }, body }, { ifMatch: campaign.rowVersion });
        form.reset(v);
        onOpenChange(false);
      } else {
        const r = await create.run({ params: { workspaceId: workspace.id }, body });
        form.reset(v);
        onOpenChange(false);
        router.push(wsPath(`/campaigns/${r.id}`));
      }
    } catch (e) {
      if (isApiError(e) && e.code === 'VERSION_CONFLICT') setConflict(true);
      else if (!applyFieldErrors(e, form.setError as never)) setError(isApiError(e) ? e.message : 'The campaign could not be saved.');
    }
  });
  const pending = create.isPending || update.isPending;

  return (
    <>
      <Drawer
        open={open}
        onOpenChange={onOpenChange}
        width={760}
        title={campaign ? 'Edit campaign' : 'New Campaign'}
        description={campaign ? campaign.name : 'A campaign groups placements, tagged links and reported results across projects. It starts as Planned.'}
        dirty={form.formState.isDirty}
        footer={
          <>
            <Button onClick={() => onOpenChange(false)} disabled={pending}>
              Cancel
            </Button>
            <Button variant="primary" loading={pending} onClick={() => void submit()}>
              {campaign ? 'Save' : 'Create Campaign'}
            </Button>
          </>
        }
      >
        <form onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate className="flex flex-col gap-4">
          {error ? <Banner tone="danger">{error}</Banner> : null}
          <Field label="Name" required error={errors.name?.message}>
            <Input {...form.register('name')} maxLength={120} autoFocus />
          </Field>
          <Field label="Objective" required error={errors.objective?.message} helper="What the campaign should achieve, in plain words.">
            <Textarea {...form.register('objective')} rows={3} maxLength={2000} />
          </Field>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label="Owner" required error={errors.ownerMembershipId?.message}>
              <Controller control={form.control} name="ownerMembershipId" render={({ field }) => <MemberSelect value={field.value} onChange={(v) => field.onChange(v ?? '')} />} />
            </Field>
            <Field label="Partner" helper="Optional. Deals are linked from the campaign page.">
              <Controller control={form.control} name="partnerId" render={({ field }) => <EntitySelect type="partner" value={field.value} onChange={field.onChange} clearable />} />
            </Field>
            <Field label="Start date" required error={errors.startDate?.message}>
              <DateInput {...form.register('startDate')} />
            </Field>
            <Field label="End date" required error={errors.endDate?.message}>
              <DateInput {...form.register('endDate')} />
            </Field>
          </div>
          <Field
            label="Projects"
            required
            error={errors.projectIds?.message}
            helper={campaign ? 'A project with placements or cost allocations in this campaign cannot be removed.' : 'Members see the campaign through any of its projects; changing it needs access to all of them.'}
          >
            <Controller control={form.control} name="projectIds" render={({ field }) => <MultiEntitySelect type="project" value={field.value} onChange={field.onChange} max={50} />} />
          </Field>
          <Field label="Tags" helper="Comma-separated. Tags describe the campaign; they never add costs or results.">
            <Input {...form.register('tags')} />
          </Field>
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <h3 className="text-[14px] font-semibold text-fg">Goals</h3>
              <Button size="sm" icon={<Plus size={12} />} onClick={() => goals.append({ metricKey: '', target: '', unit: 'count' })} disabled={goals.fields.length >= 20}>
                Add Goal
              </Button>
            </div>
            {goals.fields.length === 0 ? <p className="text-[13px] text-fg-2">No goals yet. Goals are targets only; results come from recorded metrics and source reports.</p> : null}
            {goals.fields.map((f, i) => (
              <div key={f.id} className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_140px_120px_auto]">
                <Field label="Metric" error={errors.goals?.[i]?.metricKey?.message}>
                  <Input {...form.register(`goals.${i}.metricKey`)} maxLength={80} placeholder="e.g. Conversions" />
                </Field>
                <Field label="Target" error={errors.goals?.[i]?.target?.message}>
                  <Input {...form.register(`goals.${i}.target`)} maxLength={40} inputMode="decimal" />
                </Field>
                <Field label="Unit" error={errors.goals?.[i]?.unit?.message}>
                  <Input {...form.register(`goals.${i}.unit`)} maxLength={20} />
                </Field>
                <IconButton label={`Remove goal ${i + 1}`} icon={<Trash size={16} />} onClick={() => goals.remove(i)} />
              </div>
            ))}
          </div>
          <div className="flex flex-col gap-2">
            <h3 className="text-[14px] font-semibold text-fg">Cover</h3>
            {cover ? (
              <div className="flex items-center gap-3">
                <AssetThumb workspaceId={workspace.id} assetId={cover} size={64} className="h-10 w-10" alt="Campaign cover" />
                <Button size="sm" variant="ghost" onClick={() => form.setValue('coverAssetId', null, { shouldDirty: true })}>
                  Remove Cover
                </Button>
              </div>
            ) : (
              <FileUploader
                workspaceId={workspace.id}
                purpose="cover"
                projectId={projectIds[0] ?? null}
                accept="image/jpeg,image/png,image/webp"
                multiple={false}
                compact
                label="Upload Cover"
                hint="Optional image shown at 40×40 in the campaign list."
                onUploaded={(u) => u.assetId && form.setValue('coverAssetId', u.assetId, { shouldDirty: true })}
              />
            )}
          </div>
        </form>
      </Drawer>
      <ConflictDialog open={conflict} onOpenChange={setConflict} onReload={() => window.location.reload()} />
    </>
  );
};
