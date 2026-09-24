'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { Controller, useForm, type UseFormReturn } from 'react-hook-form';
import { z } from 'zod';
import { accountEndpoints, publicationEndpoints as P, type PublicationDetail } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { isSafeUrl } from '@castlane/domain';
import { Banner, Button, Checkbox, DateTimeInput, Drawer, Field, Input, PageHeader, Panel, RadioGroup, Select, Textarea } from '@castlane/ui';
import { ConflictDialog } from '@/components/common/conflict';
import { EntitySelect } from '@/components/common/entity-select';
import { MemberSelect } from '@/components/common/pickers';
import { useDebounced } from '@/components/common/use-debounced';
import { applyFieldErrors, useApiMutation, useApiQuery } from '@/lib/hooks';
import { useEditBase } from '@/lib/edit-base';
import { useUnsavedChangesGuard } from '@/lib/unsaved';
import { useWorkspace, useWsPath } from '@/lib/workspace-context';
import { fromLocalInput, toLocalInput } from '@/features/tasks/format';
import { errorText, gateDetails, type GateDetails } from './format';
import { NO_INTEGRATION_NOTE, PUBLICATION_INVALIDATE, SCHEDULED_NOTE } from './labels';
import { TimezoneSelect } from './publication-dialogs';

const optionalHttps = z
  .string()
  .trim()
  .max(2048)
  .refine((v) => !v || isSafeUrl(v, { httpsOnly: true }), 'Enter a valid https link.');

const schema = z
  .object({
    mode: z.enum(['plan', 'historical']),
    accountId: z.string().uuid('Choose an account.'),
    contentItemId: z.string().uuid('Choose the content to place.'),
    contentVersionId: z.string().nullable(),
    ownerMembershipId: z.string().uuid('Choose who publishes it.'),
    caption: z.string().max(10000),
    cta: z.string().max(500),
    destinationUrl: optionalHttps,
    primaryCampaignId: z.string().nullable(),
    tags: z.string().max(1200),
    scheduledAt: z.string(),
    timezone: z.string().min(1),
    actualPublishedAt: z.string(),
    externalUrl: optionalHttps,
    noUrl: z.boolean(),
    noUrlReason: z.string().max(500),
    sourceNote: z.string().max(2000),
    accountOverrideReason: z.string().max(2000),
    conflictOverrideReason: z.string().max(2000),
  })
  .superRefine((v, ctx) => {
    if (v.mode === 'historical') {
      if (!v.actualPublishedAt) ctx.addIssue({ code: 'custom', path: ['actualPublishedAt'], message: 'Enter when the post went live.' });
      if (!v.noUrl && !v.externalUrl) ctx.addIssue({ code: 'custom', path: ['externalUrl'], message: 'Enter the https link of the post.' });
      if (v.noUrl && (v.noUrlReason.trim().length < 10 || v.noUrlReason.trim().length > 500)) ctx.addIssue({ code: 'custom', path: ['noUrlReason'], message: 'Explain in 10–500 characters why the URL is missing.' });
      if (v.sourceNote.trim().length < 3) ctx.addIssue({ code: 'custom', path: ['sourceNote'], message: 'Say where this record comes from.' });
    }
  });
type FormValues = z.infer<typeof schema>;

const splitTags = (s: string) => [...new Set(s.split(',').map((t) => t.trim()).filter(Boolean))];

/** Content and version pickers bound to the chosen account (content of the account's project only). */
const ContentFields = ({
  form,
  disabled,
  lockContent,
  pinApproved,
}: {
  form: UseFormReturn<FormValues>;
  disabled?: boolean;
  lockContent?: boolean;
  /** New placements: content prefilled from a link gets its approved version, like picking it does. */
  pinApproved?: boolean;
}) => {
  const { workspace } = useWorkspace();
  const accountId = form.watch('accountId');
  const contentItemId = form.watch('contentItemId');
  const [query, setQuery] = useState('');
  const q = useDebounced(query, 250);
  const validAccount = z.string().uuid().safeParse(accountId).success;
  const validContent = z.string().uuid().safeParse(contentItemId).success;
  const options = useApiQuery(
    P.contentOptions,
    { params: { workspaceId: workspace.id }, query: { accountId, q: q || undefined, ids: !q && validContent ? [contentItemId] : undefined, limit: 30 } },
    { enabled: validAccount },
  );
  const recent = useApiQuery(P.contentOptions, { params: { workspaceId: workspace.id }, query: { accountId, limit: 30 } }, { enabled: validAccount && !q });
  const versions = useApiQuery(P.contentVersions, { params: { workspaceId: workspace.id }, query: { contentItemId, accountId } }, { enabled: validAccount && validContent });
  const merged = useMemo(() => {
    const m = new Map([...(recent.data ?? []), ...(options.data ?? [])].map((o) => [o.id, o]));
    return [...m.values()];
  }, [recent.data, options.data]);
  const approvedOfPrefilled = pinApproved ? merged.find((o) => o.id === contentItemId)?.approvedVersion?.id : undefined;
  useEffect(() => {
    if (approvedOfPrefilled && !form.getValues('contentVersionId') && !form.getFieldState('contentVersionId').isDirty) form.setValue('contentVersionId', approvedOfPrefilled);
  }, [approvedOfPrefilled, form]);
  const errors = form.formState.errors;
  return (
    <>
      <Field label="Content" required error={errors.contentItemId?.message} helper={validAccount ? 'Content of the account’s project; the approved version is shown when there is one.' : 'Choose the account first.'}>
        <Controller
          control={form.control}
          name="contentItemId"
          render={({ field }) => (
            <Select
              value={field.value || null}
              disabled={disabled || lockContent || !validAccount}
              onQueryChange={setQuery}
              onChange={(v) => {
                field.onChange(v ?? '');
                const o = merged.find((x) => x.id === v);
                form.setValue('contentVersionId', o?.approvedVersion?.id ?? null, { shouldDirty: true });
              }}
              placeholder="Choose content"
              options={merged.map((o) => ({
                value: o.id,
                label: o.title,
                description: o.approvedVersion ? `Approved version ${o.approvedVersion.versionNo}` : `Not approved yet${o.latestVersionNo ? ` · latest version ${o.latestVersionNo}` : ''}`,
              }))}
            />
          )}
        />
      </Field>
      <Field label="Approved version" error={errors.contentVersionId?.message} helper="Scheduling needs an approved version; a draft may wait for approval.">
        <Controller
          control={form.control}
          name="contentVersionId"
          render={({ field }) => (
            <Select
              value={field.value}
              onChange={field.onChange}
              disabled={disabled || !validContent}
              clearable
              placeholder={versions.isLoading ? 'Loading…' : 'No version pinned'}
              options={(versions.data ?? []).map((v) => ({
                value: v.id,
                label: `Version ${v.versionNo}${v.approved ? ' · Approved' : v.approvalRevokedAt ? ' · Approval revoked' : ' · Not approved'}`,
                disabled: !v.approved,
              }))}
            />
          )}
        />
      </Field>
    </>
  );
};

const CaptionField = ({ form }: { form: UseFormReturn<FormValues> }) => {
  const { workspace } = useWorkspace();
  const accountId = form.watch('accountId');
  const caption = form.watch('caption');
  const account = useApiQuery(accountEndpoints.get, { params: { workspaceId: workspace.id, accountId } }, { enabled: z.string().uuid().safeParse(accountId).success, retry: false });
  const limit = account.data?.captionMaxLength ?? null;
  const length = [...(caption ?? '')].length;
  return (
    <Field
      label="Caption"
      error={form.formState.errors.caption?.message ?? (limit && length > limit ? `Longer than this account’s internal limit of ${limit} characters.` : undefined)}
      helper={limit ? `${length} / ${limit} characters (internal limit; check the platform manually).` : 'Stored as text; the platform’s own limits are checked manually.'}
    >
      <Textarea {...form.register('caption')} rows={5} />
    </Field>
  );
};

/** S32 `/publications/new`: Save Draft, Schedule, or record a placement that already happened. */
export const NewPublicationScreen = () => {
  const { workspace, user, membershipId } = useWorkspace();
  const router = useRouter();
  const params = useSearchParams();
  const wsPath = useWsPath();
  const [error, setError] = useState<string | null>(null);
  const [gates, setGates] = useState<GateDetails | null>(null);
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      mode: params.get('mode') === 'historical' ? 'historical' : 'plan',
      accountId: params.get('accountId') ?? '',
      contentItemId: params.get('contentItemId') ?? '',
      contentVersionId: null,
      ownerMembershipId: membershipId,
      caption: '',
      cta: '',
      destinationUrl: '',
      primaryCampaignId: params.get('campaignId'),
      tags: '',
      scheduledAt: params.get('at') ? toLocalInput(params.get('at'), user.timezone) : '',
      timezone: user.timezone,
      actualPublishedAt: '',
      externalUrl: '',
      noUrl: false,
      noUrlReason: '',
      sourceNote: '',
      accountOverrideReason: '',
      conflictOverrideReason: '',
    },
  });
  useUnsavedChangesGuard(form.formState.isDirty && !form.formState.isSubmitSuccessful);
  const create = useApiMutation(P.create, { invalidate: PUBLICATION_INVALIDATE, silentErrors: true });
  const historical = useApiMutation(P.createHistorical, { invalidate: PUBLICATION_INVALIDATE, silentErrors: true, successMessage: 'Past publication recorded' });
  const mode = form.watch('mode');
  const noUrl = form.watch('noUrl');
  const tz = form.watch('timezone');
  const errors = form.formState.errors;
  const accountId = form.watch('accountId');
  const [projectOfAccount, setProjectOfAccount] = useState<string | null>(null);
  const account = useApiQuery(accountEndpoints.get, { params: { workspaceId: workspace.id, accountId } }, { enabled: z.string().uuid().safeParse(accountId).success, retry: false });
  useEffect(() => setProjectOfAccount(account.data?.project.id ?? null), [account.data]);

  const submit = (schedule: boolean) =>
    form.handleSubmit(async (v) => {
      setError(null);
      const common = {
        contentItemId: v.contentItemId,
        accountId: v.accountId,
        contentVersionId: v.contentVersionId,
        ownerMembershipId: v.ownerMembershipId,
        caption: v.caption || null,
        cta: v.cta || null,
        destinationUrl: v.destinationUrl || null,
        primaryCampaignId: v.primaryCampaignId,
        descriptiveTags: splitTags(v.tags),
      };
      try {
        if (v.mode === 'historical') {
          const at = fromLocalInput(v.actualPublishedAt, user.timezone)!;
          const r = await historical.run({
            params: { workspaceId: workspace.id },
            body: { ...common, actualPublishedAt: at, sourceNote: v.sourceNote.trim(), ...(v.noUrl ? { noUrlReason: v.noUrlReason.trim() } : { externalUrl: v.externalUrl }) },
          });
          form.reset(form.getValues());
          router.replace(wsPath(`/publications/${r.id}`));
          return;
        }
        const at = v.scheduledAt ? fromLocalInput(v.scheduledAt, v.timezone) : null;
        if (schedule && !at) {
          form.setError('scheduledAt', { message: 'Choose the date and time to publish.' });
          return;
        }
        const r = await create.run({
          params: { workspaceId: workspace.id },
          body: {
            ...common,
            scheduledAt: at,
            timezone: v.timezone,
            schedule,
            accountOverrideReason: v.accountOverrideReason.trim() || undefined,
            conflictOverrideReason: v.conflictOverrideReason.trim() || undefined,
          },
        });
        form.reset(form.getValues());
        router.replace(wsPath(`/publications/${r.id}`));
      } catch (e) {
        const g = gateDetails(e);
        if (g) {
          setGates(g);
          setError(g.blockers?.[0]?.message ?? (isApiError(e) ? e.message : null));
        } else if (!applyFieldErrors(e, form.setError as never)) setError(errorText(e, 'The publication could not be saved.'));
      }
    })();

  const pending = create.isPending || historical.isPending;
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="New Publication" crumbs={[{ label: 'Calendar', href: wsPath('/calendar') }, { label: 'New Publication' }]} description={`One placement of one content item on one account. ${SCHEDULED_NOTE}`} />
      <form onSubmit={(e) => e.preventDefault()} noValidate className="flex max-w-[920px] flex-col gap-5">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <Panel title="Placement">
          <div className="flex flex-col gap-4">
            <Controller
              control={form.control}
              name="mode"
              render={({ field }) => (
                <RadioGroup
                  label="Kind of record"
                  orientation="horizontal"
                  value={field.value}
                  onValueChange={field.onChange}
                  options={[
                    { value: 'plan', label: 'Plan a publication', description: 'Save a draft or schedule it.' },
                    { value: 'historical', label: 'Record a past publication', description: 'Already published; needs a source note.' },
                  ]}
                />
              )}
            />
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field label="Account" required error={errors.accountId?.message} helper={NO_INTEGRATION_NOTE}>
                <Controller
                  control={form.control}
                  name="accountId"
                  render={({ field }) => (
                    <EntitySelect
                      type="account"
                      value={field.value || null}
                      onChange={(v) => field.onChange(v ?? '')}
                      filters={params.get('projectId') ? { projectId: params.get('projectId')! } : undefined}
                    />
                  )}
                />
              </Field>
              <Field label="Owner" required error={errors.ownerMembershipId?.message}>
                <Controller control={form.control} name="ownerMembershipId" render={({ field }) => <MemberSelect value={field.value} onChange={(v) => field.onChange(v ?? '')} />} />
              </Field>
              <ContentFields form={form} pinApproved />
            </div>
          </div>
        </Panel>
        {mode === 'plan' ? (
          <Panel title="Schedule">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field label="Scheduled at" error={errors.scheduledAt?.message} helper="Required to schedule; a draft may keep a tentative time.">
                <DateTimeInput {...form.register('scheduledAt')} timezone={tz} />
              </Field>
              <Field label="Time zone" required>
                <Controller control={form.control} name="timezone" render={({ field }) => <TimezoneSelect value={field.value} onChange={field.onChange} />} />
              </Field>
              {gates?.requiresOverride || gates?.overridable?.length ? (
                <Field label="Account status override reason" className="md:col-span-2" error={errors.accountOverrideReason?.message} helper={gates.overridable?.map((o) => o.message).join(' ')}>
                  <Textarea {...form.register('accountOverrideReason')} rows={2} />
                </Field>
              ) : null}
              {gates?.conflicts?.length ? (
                <Field label="Reason to keep both placements" className="md:col-span-2" error={errors.conflictOverrideReason?.message} helper={`Within 15 minutes of: ${gates.conflicts.map((c) => c.title).join(', ')}.`}>
                  <Textarea {...form.register('conflictOverrideReason')} rows={2} />
                </Field>
              ) : null}
            </div>
          </Panel>
        ) : (
          <Panel title="Published facts">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field label="Actual published at" required error={errors.actualPublishedAt?.message}>
                <DateTimeInput {...form.register('actualPublishedAt')} timezone={user.timezone} />
              </Field>
              <div className="flex items-end">
                <Controller control={form.control} name="noUrl" render={({ field }) => <Checkbox checked={field.value} onCheckedChange={field.onChange} label="The post has no permanent URL" />} />
              </div>
              {noUrl ? (
                <Field label="Why is the URL missing?" required className="md:col-span-2" error={errors.noUrlReason?.message}>
                  <Textarea {...form.register('noUrlReason')} rows={2} maxLength={500} />
                </Field>
              ) : (
                <Field label="External post URL" required className="md:col-span-2" error={errors.externalUrl?.message}>
                  <Input {...form.register('externalUrl')} placeholder="https://" inputMode="url" />
                </Field>
              )}
              <Field label="Source note" required className="md:col-span-2" error={errors.sourceNote?.message} helper="Where the record comes from (posting log, platform screenshot…).">
                <Textarea {...form.register('sourceNote')} rows={2} />
              </Field>
            </div>
          </Panel>
        )}
        <Panel title="Caption and links">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="md:col-span-2">
              <CaptionField form={form} />
            </div>
            <Field label="Call to action" error={errors.cta?.message}>
              <Input {...form.register('cta')} maxLength={500} />
            </Field>
            <Field label="Destination URL" error={errors.destinationUrl?.message} helper="For tagged links use Build Tagged URL in the campaign.">
              <Input {...form.register('destinationUrl')} placeholder="https://" inputMode="url" />
            </Field>
            <Field label="Primary campaign" error={errors.primaryCampaignId?.message} helper="Counts for campaign results and costs; tags are descriptive only.">
              <Controller
                control={form.control}
                name="primaryCampaignId"
                render={({ field }) => <EntitySelect type="campaign" value={field.value} onChange={field.onChange} clearable filters={projectOfAccount ? { projectId: projectOfAccount } : undefined} />}
              />
            </Field>
            <Field label="Descriptive tags" helper="Comma separated.">
              <Input {...form.register('tags')} />
            </Field>
          </div>
        </Panel>
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={() => router.back()} disabled={pending}>
            Cancel
          </Button>
          {mode === 'plan' ? (
            <>
              <Button loading={create.isPending} onClick={() => void submit(false)}>
                Save Draft
              </Button>
              <Button variant="primary" loading={create.isPending} onClick={() => void submit(true)}>
                Schedule
              </Button>
            </>
          ) : (
            <Button variant="primary" loading={historical.isPending} onClick={() => void submit(false)}>
              Record Publication
            </Button>
          )}
        </div>
      </form>
    </div>
  );
};

// ——— Edit drawer (Draft / Scheduled / Failed) ———

const editSchema = z.object({
  accountId: z.string().uuid('Choose an account.'),
  contentItemId: z.string().uuid('Choose the content to place.'),
  contentVersionId: z.string().nullable(),
  ownerMembershipId: z.string().uuid('Choose who publishes it.'),
  caption: z.string().max(10000),
  cta: z.string().max(500),
  destinationUrl: optionalHttps,
  primaryCampaignId: z.string().nullable(),
  tags: z.string().max(1200),
  scheduledAt: z.string(),
  timezone: z.string().min(1),
});
type EditValues = z.infer<typeof editSchema>;

export const PublicationEditDrawer = ({ publication: p, open, onOpenChange }: { publication: PublicationDetail; open: boolean; onOpenChange: (o: boolean) => void }) => {
  const { workspace, user } = useWorkspace();
  const [error, setError] = useState<string | null>(null);
  const draft = p.status === 'draft';
  const defaults = (p: PublicationDetail): EditValues => ({
    accountId: p.account.id,
    contentItemId: p.contentItemId,
    contentVersionId: p.contentVersion?.id ?? null,
    ownerMembershipId: p.owner.membershipId,
    caption: p.caption ?? '',
    cta: p.cta ?? '',
    destinationUrl: p.destinationUrl ?? '',
    primaryCampaignId: p.primaryCampaign?.id ?? null,
    tags: p.descriptiveTags.join(', '),
    scheduledAt: toLocalInput(p.scheduledAt, p.scheduleTimezone ?? user.timezone),
    timezone: p.scheduleTimezone ?? user.timezone,
  });
  const form = useForm<EditValues>({ resolver: zodResolver(editSchema), defaultValues: defaults(p) });
  // Opened values and If-Match stay put while live updates refresh `p` (T162); only dirty fields are sent.
  const edit = useEditBase(p, { open, onReload: (latest) => form.reset(defaults(latest)) });
  useEffect(() => {
    if (open) {
      form.reset(defaults(p));
      setError(null);
    }
  }, [open, p.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const update = useApiMutation(P.update, { invalidate: PUBLICATION_INVALIDATE, silentErrors: true, successMessage: 'Publication saved' });
  const errors = form.formState.errors;
  const tz = form.watch('timezone');
  const onSubmit = form.handleSubmit(async (v) => {
    setError(null);
    const d = form.formState.dirtyFields;
    const body: Record<string, unknown> = {};
    if (d.accountId) body.accountId = v.accountId;
    if (d.contentItemId) body.contentItemId = v.contentItemId;
    if (d.contentVersionId || d.contentItemId) body.contentVersionId = v.contentVersionId;
    if (d.ownerMembershipId) body.ownerMembershipId = v.ownerMembershipId;
    if (d.caption) body.caption = v.caption || null;
    if (d.cta) body.cta = v.cta || null;
    if (d.destinationUrl) body.destinationUrl = v.destinationUrl || null;
    if (d.primaryCampaignId) body.primaryCampaignId = v.primaryCampaignId;
    if (d.tags) body.descriptiveTags = splitTags(v.tags);
    if (draft && (d.scheduledAt || d.timezone)) {
      body.scheduledAt = v.scheduledAt ? fromLocalInput(v.scheduledAt, v.timezone) : null;
      body.timezone = v.timezone;
    }
    try {
      await update.run({ params: { workspaceId: workspace.id, publicationId: p.id }, body: body as never }, { ifMatch: edit.version });
      onOpenChange(false);
    } catch (e) {
      if (edit.catchConflict(e)) return;
      if (!applyFieldErrors(e, form.setError as never)) setError(errorText(e, 'The publication could not be saved.'));
    }
  });
  return (
    <>
      <Drawer
        open={open}
        onOpenChange={onOpenChange}
        title="Edit publication"
        description={p.title}
        width={760}
        dirty={form.formState.isDirty}
        footer={
          <>
            <Button onClick={() => onOpenChange(false)} disabled={update.isPending}>
              Cancel
            </Button>
            <Button variant="primary" loading={update.isPending} onClick={() => void onSubmit()}>
              Save
            </Button>
          </>
        }
      >
        <form onSubmit={(e) => e.preventDefault()} noValidate className="flex flex-col gap-4">
          {error ? <Banner tone="danger">{error}</Banner> : null}
          {!draft ? <Banner tone="info">The time of a {p.status} placement changes with Reschedule; the account and content are fixed after scheduling.</Banner> : null}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label="Account" required error={errors.accountId?.message}>
              <Controller
                control={form.control}
                name="accountId"
                render={({ field }) => (
                  <EntitySelect
                    type="account"
                    value={field.value || null}
                    disabled={!draft}
                    onChange={(v) => {
                      field.onChange(v ?? '');
                      form.setValue('contentItemId', '', { shouldDirty: true });
                      form.setValue('contentVersionId', null, { shouldDirty: true });
                    }}
                  />
                )}
              />
            </Field>
            <Field label="Owner" required error={errors.ownerMembershipId?.message}>
              <Controller control={form.control} name="ownerMembershipId" render={({ field }) => <MemberSelect value={field.value} onChange={(v) => field.onChange(v ?? '')} />} />
            </Field>
            <ContentFields form={form as unknown as UseFormReturn<FormValues>} lockContent={!draft} />
            {draft ? (
              <>
                <Field label="Tentative time" error={errors.scheduledAt?.message}>
                  <DateTimeInput {...form.register('scheduledAt')} timezone={tz} />
                </Field>
                <Field label="Time zone">
                  <Controller control={form.control} name="timezone" render={({ field }) => <TimezoneSelect value={field.value} onChange={field.onChange} />} />
                </Field>
              </>
            ) : null}
            <div className="md:col-span-2">
              <CaptionField form={form as unknown as UseFormReturn<FormValues>} />
            </div>
            <Field label="Call to action" error={errors.cta?.message}>
              <Input {...form.register('cta')} maxLength={500} />
            </Field>
            <Field label="Destination URL" error={errors.destinationUrl?.message}>
              <Input {...form.register('destinationUrl')} placeholder="https://" />
            </Field>
            <Field label="Primary campaign" error={errors.primaryCampaignId?.message}>
              <Controller control={form.control} name="primaryCampaignId" render={({ field }) => <EntitySelect type="campaign" value={field.value} onChange={field.onChange} clearable filters={{ projectId: p.project.id }} />} />
            </Field>
            <Field label="Descriptive tags" helper="Comma separated.">
              <Input {...form.register('tags')} />
            </Field>
          </div>
        </form>
      </Drawer>
      <ConflictDialog {...edit.conflictDialog} />
    </>
  );
};
