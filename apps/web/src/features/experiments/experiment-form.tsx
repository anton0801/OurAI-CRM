'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { ArrowDown, ArrowUp, Plus, Trash } from '@phosphor-icons/react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Controller, useFieldArray, useForm } from 'react-hook-form';
import { z } from 'zod';
import { experimentEndpoints as X, type ExperimentDetail } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { Banner, Button, DateTimeInput, Drawer, Field, IconButton, Input, Select, Textarea } from '@castlane/ui';
import { ConflictDialog } from '@/components/common/conflict';
import { EntitySelect } from '@/components/common/entity-select';
import { MemberSelect } from '@/components/common/pickers';
import { AssetThumb, FileUploader } from '@/components/media/file-uploader';
import { applyFieldErrors, useApiMutation, useApiQuery } from '@/lib/hooks';
import { useWorkspace, useWsPath } from '@/lib/workspace-context';
import { fromLocalInput, toLocalInput } from '@/features/tasks/format';
import { EXPERIMENT_INVALIDATE, WINDOW_PRESETS } from './labels';

const intText = (min: number, max: number, msg: string) => z.string().trim().regex(/^\d+$/, msg).refine((v) => Number(v) >= min && Number(v) <= max, msg);

const schema = z.object({
  hypothesis: z.string().trim().min(10, 'State the hypothesis in at least 10 characters.').max(2000),
  projectId: z.string().uuid('Choose a project.'),
  ownerMembershipId: z.string().uuid('Choose an owner.'),
  primaryMetricKey: z.string().min(3, 'Choose the primary metric.'),
  observationWindowHours: intText(1, 24 * 90, 'Enter 1–2160 hours.'),
  minimumSample: intText(1, 1000, 'Enter 1–1000 placements per variant.'),
  startAt: z.string(),
  endAt: z.string(),
  limitations: z.string().max(5000),
  variants: z
    .array(z.object({ id: z.string().optional(), name: z.string().trim().min(1, 'Name the variant.').max(120), description: z.string().max(2000), thumbnailAssetId: z.string().nullable() }))
    .min(2, 'Define at least two variants.')
    .max(8, 'Use at most 8 variants.'),
  reason: z.string().max(2000),
});
type FormValues = z.infer<typeof schema>;

/**
 * Create / edit an experiment plan (S35). The plan is fixed at start; afterwards every change needs
 * a reason and becomes a numbered plan revision.
 */
export const ExperimentFormDrawer = ({
  open,
  onOpenChange,
  experiment,
  initialProjectId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  experiment?: ExperimentDetail;
  initialProjectId?: string | null;
}) => {
  const { workspace, user, membershipId } = useWorkspace();
  const router = useRouter();
  const wsPath = useWsPath();
  const tz = user.timezone;
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const metrics = useApiQuery(X.metrics, { params: { workspaceId: workspace.id } });
  const running = experiment?.status === 'running';
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: experiment
      ? {
          hypothesis: experiment.hypothesis,
          projectId: experiment.project.id,
          ownerMembershipId: experiment.owner.membershipId,
          primaryMetricKey: experiment.primaryMetricKey,
          observationWindowHours: String(experiment.observationWindowHours),
          minimumSample: String(experiment.minimumSample),
          startAt: toLocalInput(experiment.startAt, tz),
          endAt: toLocalInput(experiment.endAt, tz),
          limitations: experiment.limitations ?? '',
          variants: experiment.variants.map((v) => ({ id: v.id, name: v.name, description: v.description ?? '', thumbnailAssetId: v.thumbnailAssetId })),
          reason: '',
        }
      : {
          hypothesis: '',
          projectId: initialProjectId ?? '',
          ownerMembershipId: membershipId,
          primaryMetricKey: '',
          observationWindowHours: '72',
          minimumSample: '3',
          startAt: '',
          endAt: '',
          limitations: '',
          variants: [
            { name: 'A', description: '', thumbnailAssetId: null },
            { name: 'B', description: '', thumbnailAssetId: null },
          ],
          reason: '',
        },
  });
  const variants = useFieldArray({ control: form.control, name: 'variants' });
  const create = useApiMutation(X.create, { invalidate: EXPERIMENT_INVALIDATE, silentErrors: true, successMessage: 'Experiment created as Draft' });
  const update = useApiMutation(X.update, { invalidate: EXPERIMENT_INVALIDATE, silentErrors: true, successMessage: running ? 'Plan revision saved' : 'Experiment saved' });
  const errors = form.formState.errors;
  const projectId = form.watch('projectId');
  const windowHours = form.watch('observationWindowHours');

  const submit = form.handleSubmit(async (v) => {
    setError(null);
    if (running && v.reason.trim().length < 3) {
      form.setError('reason', { message: 'The experiment is running: give a reason for this plan revision.' });
      return;
    }
    const startAt = v.startAt ? fromLocalInput(v.startAt, tz) : null;
    const endAt = v.endAt ? fromLocalInput(v.endAt, tz) : null;
    if (startAt && endAt && endAt <= startAt) {
      form.setError('endAt', { message: 'The end must be after the start.' });
      return;
    }
    const body = {
      hypothesis: v.hypothesis.trim(),
      ownerMembershipId: v.ownerMembershipId,
      primaryMetricKey: v.primaryMetricKey,
      observationWindowHours: Number(v.observationWindowHours),
      minimumSample: Number(v.minimumSample),
      startAt,
      endAt,
      limitations: v.limitations.trim() || null,
      variants: v.variants.map((x) => ({ ...(x.id ? { id: x.id } : {}), name: x.name.trim(), description: x.description.trim() || null, thumbnailAssetId: x.thumbnailAssetId })),
    };
    try {
      if (experiment) {
        await update.run({ params: { workspaceId: workspace.id, experimentId: experiment.id }, body: { ...body, ...(running ? { reason: v.reason.trim() } : {}) } }, { ifMatch: experiment.rowVersion });
        form.reset(v);
        onOpenChange(false);
      } else {
        const r = await create.run({ params: { workspaceId: workspace.id }, body: { ...body, projectId: v.projectId } });
        form.reset(v);
        onOpenChange(false);
        router.push(wsPath(`/experiments/${r.id}`));
      }
    } catch (e) {
      if (isApiError(e) && e.code === 'VERSION_CONFLICT') setConflict(true);
      else if (!applyFieldErrors(e, form.setError as never)) setError(isApiError(e) ? e.message : 'The experiment could not be saved.');
    }
  });
  const pending = create.isPending || update.isPending;

  return (
    <>
      <Drawer
        open={open}
        onOpenChange={onOpenChange}
        width={760}
        title={experiment ? (running ? 'Revise plan' : 'Edit experiment') : 'New Experiment'}
        description={
          running
            ? 'The experiment is running. Changes are saved as a new plan version with your reason; earlier versions stay visible.'
            : 'An organic comparison of content formats. Fix the variants, metric and comparison window before you start.'
        }
        dirty={form.formState.isDirty}
        footer={
          <>
            <Button onClick={() => onOpenChange(false)} disabled={pending}>
              Cancel
            </Button>
            <Button variant="primary" loading={pending} onClick={() => void submit()}>
              {experiment ? 'Save' : 'Create Experiment'}
            </Button>
          </>
        }
      >
        <form onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate className="flex flex-col gap-4">
          {error ? <Banner tone="danger">{error}</Banner> : null}
          <Field label="Hypothesis" required error={errors.hypothesis?.message} helper="e.g. Vertical teasers under 15 s get more views at 72 h than 30 s teasers.">
            <Textarea {...form.register('hypothesis')} rows={3} maxLength={2000} autoFocus />
          </Field>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label="Project" required error={errors.projectId?.message} helper={experiment ? 'The project cannot change; duplicate the hypothesis into another project instead.' : undefined}>
              <Controller
                control={form.control}
                name="projectId"
                render={({ field }) => <EntitySelect type="project" value={field.value || null} onChange={(v) => field.onChange(v ?? '')} disabled={!!experiment} />}
              />
            </Field>
            <Field label="Owner" required error={errors.ownerMembershipId?.message} helper="Only the owner may select a variant when concluding.">
              <Controller control={form.control} name="ownerMembershipId" render={({ field }) => <MemberSelect value={field.value} onChange={(v) => field.onChange(v ?? '')} />} />
            </Field>
            <Field label="Primary metric" required error={errors.primaryMetricKey?.message} helper="A cumulative per-post metric, compared at the same post age.">
              <Controller
                control={form.control}
                name="primaryMetricKey"
                render={({ field }) => (
                  <Select
                    value={field.value || null}
                    onChange={(v) => field.onChange(v ?? '')}
                    placeholder={metrics.isLoading ? 'Loading…' : 'Choose a metric'}
                    options={(metrics.data ?? []).map((m) => ({ value: m.key, label: m.label, description: m.description }))}
                  />
                )}
              />
            </Field>
            <Field label="Observation window (hours after publishing)" required error={errors.observationWindowHours?.message}>
              <div className="flex flex-col gap-2">
                <Input {...form.register('observationWindowHours')} inputMode="numeric" />
                <div className="flex flex-wrap gap-1" role="group" aria-label="Window presets">
                  {WINDOW_PRESETS.map((h) => (
                    <Button key={h.hours} size="sm" variant={windowHours === String(h.hours) ? 'secondary' : 'ghost'} onClick={() => form.setValue('observationWindowHours', String(h.hours), { shouldDirty: true })}>
                      {h.label}
                    </Button>
                  ))}
                </div>
              </div>
            </Field>
            <Field label="Minimum sample per variant" required error={errors.minimumSample?.message} helper="Fewer comparable placements show Insufficient sample.">
              <Input {...form.register('minimumSample')} inputMode="numeric" />
            </Field>
            <div />
            <Field label="Planned start" error={errors.startAt?.message} helper="Optional; Start uses now when empty.">
              <DateTimeInput {...form.register('startAt')} timezone={tz} />
            </Field>
            <Field label="Planned end" error={errors.endAt?.message}>
              <DateTimeInput {...form.register('endAt')} timezone={tz} />
            </Field>
          </div>
          <Field label="Limitations" helper="Known confounders: posting time, account size, paid boosts, trends.">
            <Textarea {...form.register('limitations')} rows={3} maxLength={5000} />
          </Field>
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h3 className="text-[14px] font-semibold text-fg">Variants</h3>
              <Button size="sm" icon={<Plus size={12} />} disabled={variants.fields.length >= 8} onClick={() => variants.append({ name: String.fromCharCode(65 + variants.fields.length), description: '', thumbnailAssetId: null })}>
                Add Variant
              </Button>
            </div>
            {errors.variants?.message || errors.variants?.root?.message ? <p className="text-[13px] text-danger">{errors.variants?.message ?? errors.variants?.root?.message}</p> : null}
            {variants.fields.map((f, i) => {
              const thumb = form.watch(`variants.${i}.thumbnailAssetId`);
              return (
                <div key={f.id} className="flex flex-col gap-3 rounded-[12px] border border-line p-3">
                  <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_auto]">
                    <Field label={`Variant ${i + 1} name`} required error={errors.variants?.[i]?.name?.message}>
                      <Input {...form.register(`variants.${i}.name`)} maxLength={120} />
                    </Field>
                    <div className="flex gap-1">
                      <IconButton label={`Move variant ${i + 1} up`} icon={<ArrowUp size={16} />} disabled={i === 0} onClick={() => variants.move(i, i - 1)} />
                      <IconButton label={`Move variant ${i + 1} down`} icon={<ArrowDown size={16} />} disabled={i === variants.fields.length - 1} onClick={() => variants.move(i, i + 1)} />
                      <IconButton label={`Remove variant ${i + 1}`} icon={<Trash size={16} />} disabled={variants.fields.length <= 2} onClick={() => variants.remove(i)} />
                    </div>
                  </div>
                  <Field label="Description">
                    <Textarea {...form.register(`variants.${i}.description`)} rows={2} maxLength={2000} />
                  </Field>
                  {thumb ? (
                    <div className="flex items-center gap-3">
                      <AssetThumb workspaceId={workspace.id} assetId={thumb} size={320} className="h-[100px] w-[160px]" alt={`Variant ${i + 1} example`} />
                      <Button size="sm" variant="ghost" onClick={() => form.setValue(`variants.${i}.thumbnailAssetId`, null, { shouldDirty: true })}>
                        Remove Image
                      </Button>
                    </div>
                  ) : (
                    <FileUploader
                      workspaceId={workspace.id}
                      purpose="content"
                      projectId={projectId || null}
                      accept="image/jpeg,image/png,image/webp"
                      multiple={false}
                      compact
                      label="Upload Example Image"
                      hint="Optional, shown at 160×100."
                      onUploaded={(u) => u.assetId && form.setValue(`variants.${i}.thumbnailAssetId`, u.assetId, { shouldDirty: true })}
                    />
                  )}
                </div>
              );
            })}
          </div>
          {running ? (
            <Field label="Reason for this revision" required error={errors.reason?.message}>
              <Textarea {...form.register('reason')} rows={2} maxLength={2000} />
            </Field>
          ) : null}
        </form>
      </Drawer>
      <ConflictDialog open={conflict} onOpenChange={setConflict} onReload={() => window.location.reload()} />
    </>
  );
};
