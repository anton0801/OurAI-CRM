'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { GOAL_SCOPE_TYPES, goalEndpoints, type GoalDetail } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { GOAL_TARGET_TYPES, isDecimalString } from '@castlane/domain';
import { Banner, Button, DateInput, Drawer, Field, Input, RadioGroup, Select, Textarea } from '@castlane/ui';
import { ConflictDialog } from '@/components/common/conflict';
import { EntitySelect, MultiEntitySelect } from '@/components/common/entity-select';
import { DirectionSelect, MemberSelect } from '@/components/common/pickers';
import { applyFieldErrors, useApiMutation, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useWorkspace } from '@/lib/workspace-context';
import './labels';

const decimal = z.string().trim().refine((v) => isDecimalString(v), 'Enter a number, e.g. 1200 or 12.5.');

const schema = z
  .object({
    name: z.string().trim().min(2, 'Use 2–120 characters.').max(120, 'Use 2–120 characters.'),
    ownerMembershipId: z.string().uuid('Choose an owner.'),
    scopeType: z.enum(GOAL_SCOPE_TYPES),
    scopeId: z.string().nullable(),
    metricId: z.string().min(1, 'Choose a metric.'),
    targetType: z.enum(GOAL_TARGET_TYPES),
    targetValue: decimal,
    baselineValue: z.string().trim(),
    periodStart: z.string().min(10, 'Choose the first day.'),
    periodEnd: z.string().min(10, 'Choose the last day.'),
    direction: z.enum(['increase', 'decrease']),
    linkedCampaignIds: z.array(z.string()),
    reason: z.string().trim().max(2000),
  })
  .superRefine((v, ctx) => {
    if (v.scopeType !== 'workspace' && !v.scopeId) ctx.addIssue({ code: 'custom', path: ['scopeId'], message: 'Choose the scope record.' });
    if (v.targetType !== 'absolute' && !v.baselineValue) ctx.addIssue({ code: 'custom', path: ['baselineValue'], message: 'A baseline is required for Increase By and Decrease To.' });
    if (v.baselineValue && !isDecimalString(v.baselineValue)) ctx.addIssue({ code: 'custom', path: ['baselineValue'], message: 'Enter a number.' });
    if (v.periodStart && v.periodEnd && v.periodEnd < v.periodStart) ctx.addIssue({ code: 'custom', path: ['periodEnd'], message: 'Choose an end on or after the start.' });
  });
type FormValues = z.infer<typeof schema>;

const monthBounds = () => {
  const d = new Date();
  const first = new Date(d.getFullYear(), d.getMonth(), 1);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  const iso = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  return { periodStart: iso(first), periodEnd: iso(last) };
};

const numEq = (a: string | null, b: string | null) => (a === null || a === '' ? b === null || b === '' : b !== null && b !== '' && Number(a) === Number(b));

/**
 * Create or edit a goal. The unit is fixed by the chosen metric; after the period started, a target
 * change needs a reason and becomes a new revision (the previous target stays in the history).
 */
export const GoalFormDrawer = ({
  open,
  onClose,
  goal,
  defaults,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  goal?: GoalDetail;
  defaults?: Partial<FormValues>;
  onSaved?: (g: GoalDetail) => void;
}) => {
  const { workspace, membershipId } = useWorkspace();
  const params = { workspaceId: workspace.id };
  const metrics = useApiQuery(goalEndpoints.metricOptions, { params }, { enabled: open, staleTime: 60_000 });
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initial = (): FormValues =>
    goal
      ? {
          name: goal.name,
          ownerMembershipId: goal.owner.membershipId,
          scopeType: goal.scope.type,
          scopeId: goal.scope.id,
          metricId: goal.metric.id,
          targetType: goal.targetType,
          targetValue: goal.targetValue,
          baselineValue: goal.baselineValue ?? '',
          periodStart: goal.periodStart,
          periodEnd: goal.periodEnd,
          direction: goal.direction,
          linkedCampaignIds: goal.linkedCampaigns.map((c) => c.id),
          reason: '',
        }
      : { name: '', ownerMembershipId: membershipId, scopeType: 'workspace', scopeId: null, metricId: '', targetType: 'absolute', targetValue: '', baselineValue: '', ...monthBounds(), direction: 'increase', linkedCampaignIds: [], reason: '', ...defaults };
  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: initial() });
  useEffect(() => {
    if (open) {
      form.reset(initial());
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, goal?.id, goal?.rowVersion]);
  const create = useApiMutation(goalEndpoints.create, { invalidate: ['goals.'], successMessage: 'Goal created', silentErrors: true });
  const update = useApiMutation(goalEndpoints.update, { invalidate: ['goals.'], successMessage: 'Goal saved', silentErrors: true });
  const v = form.watch();
  const metric = metrics.data?.find((m) => m.id === v.metricId);
  const targetChanged =
    !!goal && (v.targetType !== goal.targetType || !numEq(v.targetValue, goal.targetValue) || !numEq(v.baselineValue, goal.baselineValue) || v.periodStart !== goal.periodStart || v.periodEnd !== goal.periodEnd);
  const needsReason = !!goal?.periodStarted && targetChanged;

  const submit = form.handleSubmit(async (f) => {
    setError(null);
    if (needsReason && f.reason.trim().length < 3) {
      form.setError('reason', { type: 'required', message: 'The period already started: explain why the target changes.' });
      return;
    }
    const body = {
      name: f.name,
      ownerMembershipId: f.ownerMembershipId,
      scopeType: f.scopeType,
      scopeId: f.scopeType === 'workspace' ? null : f.scopeId,
      metricId: f.metricId,
      targetType: f.targetType,
      targetValue: f.targetValue,
      baselineValue: f.baselineValue ? f.baselineValue : null,
      periodStart: f.periodStart,
      periodEnd: f.periodEnd,
      direction: f.targetType === 'absolute' ? f.direction : undefined,
      linkedCampaignIds: f.linkedCampaignIds,
    };
    try {
      const saved = goal
        ? await update.run({ params: { ...params, goalId: goal.id }, body: { ...body, reason: needsReason ? f.reason : undefined } }, { ifMatch: goal.rowVersion })
        : await create.run({ params, body });
      onSaved?.(saved);
      onClose();
    } catch (e) {
      if (isApiError(e) && e.code === 'VERSION_CONFLICT') setConflict(true);
      else if (!applyFieldErrors(e, form.setError as never)) setError(isApiError(e) ? e.message : 'The goal could not be saved.');
    }
  });
  const pending = create.isPending || update.isPending;
  const e = form.formState.errors;
  const scopePicker = (field: { value: string | null; onChange: (v: string | null) => void }) => {
    switch (v.scopeType) {
      case 'direction':
        return <DirectionSelect value={field.value} onChange={field.onChange} />;
      case 'project':
        return <EntitySelect type="project" value={field.value} onChange={(x) => field.onChange(x)} />;
      case 'account':
        return <EntitySelect type="account" value={field.value} onChange={(x) => field.onChange(x)} />;
      case 'campaign':
        return <EntitySelect type="campaign" value={field.value} onChange={(x) => field.onChange(x)} />;
      default:
        return <Input value="Whole workspace" readOnly aria-readonly />;
    }
  };

  return (
    <>
      <Drawer
        open={open}
        onOpenChange={(o) => !o && onClose()}
        title={goal ? `Edit ${goal.name}` : 'New Goal'}
        description={goal ? `Revision ${goal.revisionNo}` : 'A planned result measured by a canonical metric.'}
        dirty={form.formState.isDirty}
        footer={
          <>
            <Button onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button variant="primary" loading={pending} onClick={() => void submit()}>
              {goal ? (needsReason ? 'Save Revision' : 'Save Changes') : 'Create Goal'}
            </Button>
          </>
        }
      >
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
          {error ? <Banner tone="danger">{error}</Banner> : null}
          <Field label="Name" required error={e.name?.message}>
            <Input {...form.register('name')} maxLength={120} />
          </Field>
          <Field label="Owner" required error={e.ownerMembershipId?.message}>
            <Controller control={form.control} name="ownerMembershipId" render={({ field }) => <MemberSelect value={field.value} onChange={(x) => field.onChange(x ?? '')} />} />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Scope" required>
              <Controller
                control={form.control}
                name="scopeType"
                render={({ field }) => (
                  <Select
                    value={field.value}
                    onChange={(x) => {
                      field.onChange(x ?? 'workspace');
                      form.setValue('scopeId', null, { shouldDirty: true });
                    }}
                    options={GOAL_SCOPE_TYPES.map((t) => ({ value: t, label: label('goalScope', t) }))}
                  />
                )}
              />
            </Field>
            <Field label="Scope record" required={v.scopeType !== 'workspace'} error={e.scopeId?.message}>
              <Controller control={form.control} name="scopeId" render={({ field }) => scopePicker(field)} />
            </Field>
          </div>
          <Field
            label="Metric"
            required
            error={e.metricId?.message}
            helper={metric ? `${metric.description} Unit: ${metric.unit}${metric.rate ? ' (rate)' : ''}.` : goal?.periodStarted ? 'The metric is fixed once the period started.' : 'Only metrics you can see are listed. The unit comes from the metric.'}
          >
            <Controller
              control={form.control}
              name="metricId"
              render={({ field }) => (
                <Select
                  value={field.value || null}
                  onChange={(x) => field.onChange(x ?? '')}
                  disabled={!!goal?.periodStarted}
                  placeholder={metrics.isLoading ? 'Loading…' : 'Choose a metric'}
                  options={(metrics.data ?? []).map((m) => ({ value: m.id, label: `${m.label} (${m.id})`, description: m.unit }))}
                  emptyText="No metrics are available for your role."
                />
              )}
            />
          </Field>
          <Field label="Target type" required>
            <Controller
              control={form.control}
              name="targetType"
              render={({ field }) => (
                <RadioGroup
                  label="Target type"
                  orientation="horizontal"
                  value={field.value}
                  onValueChange={field.onChange}
                  options={[
                    { value: 'absolute', label: 'Absolute', description: 'Progress = current ÷ target' },
                    { value: 'increase_by', label: 'Increase By', description: 'Progress = (current − baseline) ÷ target' },
                    { value: 'decrease_to', label: 'Decrease To', description: 'Progress = (baseline − current) ÷ (baseline − target)' },
                  ]}
                />
              )}
            />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label={v.targetType === 'increase_by' ? 'Increase by' : 'Target'} required error={e.targetValue?.message} helper={metric ? `In ${metric.unit}` : undefined}>
              <Input {...form.register('targetValue')} inputMode="decimal" />
            </Field>
            <Field label="Baseline" required={v.targetType !== 'absolute'} error={e.baselineValue?.message} helper="Value at the start of the period.">
              <Input {...form.register('baselineValue')} inputMode="decimal" />
            </Field>
            <Field label="Period start" required error={e.periodStart?.message}>
              <DateInput {...form.register('periodStart')} />
            </Field>
            <Field label="Period end" required error={e.periodEnd?.message}>
              <DateInput {...form.register('periodEnd')} />
            </Field>
          </div>
          {v.targetType === 'absolute' ? (
            <Field label="Direction">
              <Controller
                control={form.control}
                name="direction"
                render={({ field }) => (
                  <RadioGroup
                    label="Direction"
                    orientation="horizontal"
                    value={field.value}
                    onValueChange={field.onChange}
                    options={[
                      { value: 'increase', label: 'Increase' },
                      { value: 'decrease', label: 'Decrease' },
                    ]}
                  />
                )}
              />
            </Field>
          ) : null}
          <Field label="Linked campaigns" helper="Context only — campaigns do not change how the metric is measured.">
            <Controller control={form.control} name="linkedCampaignIds" render={({ field }) => <MultiEntitySelect type="campaign" value={field.value} onChange={field.onChange} max={20} />} />
          </Field>
          {needsReason ? (
            <Field label="Reason for the revision" required error={e.reason?.message} helper="The period already started. The previous target and baseline stay in the history.">
              <Textarea {...form.register('reason')} maxLength={2000} />
            </Field>
          ) : null}
        </form>
      </Drawer>
      <ConflictDialog open={conflict} onOpenChange={setConflict} onReload={() => window.location.reload()} />
    </>
  );
};
