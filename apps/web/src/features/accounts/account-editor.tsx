'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { accountEndpoints, type AccountDetail } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { LIMITS, PLATFORMS } from '@castlane/domain';
import { Banner, Button, Field, Input, PageHeader, Panel, RadioGroup, Select, Textarea } from '@castlane/ui';
import { ConflictDialog } from '@/components/common/conflict';
import { changedFields, pickChanged, useEditBase } from '@/lib/edit-base';
import { EntitySelect } from '@/components/common/entity-select';
import { MemberSelect } from '@/components/common/pickers';
import { useDebounced } from '@/components/common/use-debounced';
import { AssetThumb, FileUploader } from '@/components/media/file-uploader';
import { applyFieldErrors, useApiMutation, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUnsavedChangesGuard } from '@/lib/unsaved';
import { useWorkspace, useWsPath } from '@/lib/workspace-context';
import { AssignMemberDialog } from './account-dialogs';
import { NO_INTEGRATION_NOTE, WEEKDAY_OPTIONS } from './labels';
import { ExternalLink, accountTitle } from './platform';

const schema = z.object({
  platform: z.enum(PLATFORMS),
  profileUrl: z.string().trim().min(1, 'Enter the profile link.').max(LIMITS.urlMax),
  projectId: z.string().uuid('Choose a project.'),
  ownerMembershipId: z.string().uuid('Choose an owner.'),
  handle: z.string().trim().max(LIMITS.handleMax).optional(),
  displayName: z.string().trim().max(LIMITS.shortNameMax).optional(),
  language: z.string().trim().max(20).optional(),
  markets: z.string().max(600).optional(),
  purpose: z.string().max(2000).optional(),
  status: z.enum(['preparing', 'active']),
  notes: z.string().max(LIMITS.noteMax).optional(),
  tags: z.string().max(1200).optional(),
  avatarAssetId: z.string().uuid().nullable(),
  metricsCadence: z.enum(['daily', 'weekly', 'monthly']),
  metricsDayOfWeek: z.string(),
  metricsTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use the HH:MM format.'),
  captionMaxLength: z.string().regex(/^\d*$/, 'Enter a whole number.').optional(),
  identityChangeReason: z.string().max(LIMITS.reasonMax).optional(),
});
type FormValues = z.infer<typeof schema>;

const splitList = (v?: string) =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** S19 Account Editor: register an external account by link (no password, no OAuth, no download). */
export const AccountEditor = ({ account }: { account?: AccountDetail }) => {
  const router = useRouter();
  const params = useSearchParams();
  const wsPath = useWsPath();
  const { workspace, membershipId } = useWorkspace();
  const [error, setError] = useState<string | null>(null);
  const [assignOpen, setAssignOpen] = useState(false);
  const valuesOf = (account: AccountDetail): FormValues => ({
    platform: account.platform,
    profileUrl: account.originalUrl,
    projectId: account.project.id,
    ownerMembershipId: account.owner.membershipId,
    handle: account.handle ?? '',
    displayName: account.displayName ?? '',
    language: account.language ?? '',
    markets: account.markets.join(', '),
    purpose: account.purpose ?? '',
    status: 'preparing',
    notes: account.notes ?? '',
    tags: account.tags.join(', '),
    avatarAssetId: account.avatarAssetId,
    metricsCadence: account.metricsCadence,
    metricsDayOfWeek: String(account.metricsDayOfWeek),
    metricsTime: account.metricsTime,
    captionMaxLength: account.captionMaxLength ? String(account.captionMaxLength) : '',
    identityChangeReason: '',
  });
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: account
      ? {
          platform: account.platform,
          profileUrl: account.originalUrl,
          projectId: account.project.id,
          ownerMembershipId: account.owner.membershipId,
          handle: account.handle ?? '',
          displayName: account.displayName ?? '',
          language: account.language ?? '',
          markets: account.markets.join(', '),
          purpose: account.purpose ?? '',
          status: 'preparing',
          notes: account.notes ?? '',
          tags: account.tags.join(', '),
          avatarAssetId: account.avatarAssetId,
          metricsCadence: account.metricsCadence,
          metricsDayOfWeek: String(account.metricsDayOfWeek),
          metricsTime: account.metricsTime,
          captionMaxLength: account.captionMaxLength ? String(account.captionMaxLength) : '',
          identityChangeReason: '',
        }
      : {
          platform: 'instagram',
          profileUrl: '',
          projectId: params.get('projectId') ?? '',
          ownerMembershipId: membershipId,
          status: 'preparing',
          avatarAssetId: null,
          metricsCadence: 'weekly',
          metricsDayOfWeek: '1',
          metricsTime: '10:00',
        },
  });
  const dirty = form.formState.isDirty;
  useUnsavedChangesGuard(dirty && !form.formState.isSubmitSuccessful);
  // Edits apply to the account as the form opened; only changed fields are sent (T162).
  const edit = useEditBase(account, { onReload: (x) => form.reset(valuesOf(x)) });
  const create = useApiMutation(accountEndpoints.create, { invalidate: ['accounts.', 'projects.'], silentErrors: true, successMessage: 'Account added' });
  const update = useApiMutation(accountEndpoints.update, { invalidate: ['accounts.'], silentErrors: true, successMessage: 'Account saved' });

  const platform = form.watch('platform');
  const url = useDebounced(form.watch('profileUrl') ?? '', 400);
  const projectId = form.watch('projectId');
  const avatarAssetId = form.watch('avatarAssetId');
  const cadence = form.watch('metricsCadence');
  const preview = useApiQuery(
    accountEndpoints.urlPreview,
    { params: { workspaceId: workspace.id }, query: { platform, url, excludeAccountId: account?.id } },
    { enabled: url.trim().length > 8, staleTime: 30_000 },
  );
  const identityChanged = !!account && preview.data?.ok && preview.data.canonicalUrl !== account.canonicalUrl;

  const onSubmit = form.handleSubmit(async (v) => {
    setError(null);
    const commonOf = (v: FormValues) => ({
      platform: v.platform,
      profileUrl: v.profileUrl.trim(),
      ownerMembershipId: v.ownerMembershipId,
      handle: v.handle?.trim() || null,
      displayName: v.displayName?.trim() || null,
      language: v.language?.trim() || null,
      markets: splitList(v.markets),
      purpose: v.purpose?.trim() || null,
      notes: v.notes?.trim() || null,
      tags: splitList(v.tags),
      avatarAssetId: v.avatarAssetId,
      metricsCadence: v.metricsCadence,
      metricsDayOfWeek: Number(v.metricsDayOfWeek),
      metricsTime: v.metricsTime,
      captionMaxLength: v.captionMaxLength ? Number(v.captionMaxLength) : null,
    });
    const common = commonOf(v);
    try {
      if (account) {
        const changed = changedFields(commonOf(valuesOf(edit.start ?? account)), common);
        for (const group of [['platform', 'profileUrl'], ['metricsCadence', 'metricsDayOfWeek', 'metricsTime']] as const)
          if (group.some((k) => changed.includes(k))) changed.push(...group);
        const r = await update.run(
          { params: { workspaceId: workspace.id, accountId: account.id }, body: { ...pickChanged(common, changed), identityChangeReason: v.identityChangeReason?.trim() || undefined } },
          { ifMatch: edit.version },
        );
        form.reset(form.getValues());
        router.push(wsPath(`/accounts/${r.id}`));
      } else {
        const r = await create.run({ params: { workspaceId: workspace.id }, body: { ...common, projectId: v.projectId, status: v.status } });
        form.reset(form.getValues());
        router.replace(wsPath(`/accounts/${r.id}`));
      }
    } catch (e) {
      if (edit.catchConflict(e)) return;
      if (!applyFieldErrors(e, form.setError as never)) setError(isApiError(e) ? e.message : 'The account could not be saved.');
    }
  });

  const pending = create.isPending || update.isPending;
  const errors = form.formState.errors;
  const dup = preview.data?.duplicate;
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={account ? `Edit ${accountTitle(account)}` : 'Add Account'}
        crumbs={[{ label: 'Accounts', href: wsPath('/accounts') }, ...(account ? [{ label: accountTitle(account), href: wsPath(`/accounts/${account.id}`) }] : []), { label: account ? 'Edit' : 'New' }]}
        description={`${NO_INTEGRATION_NOTE} Castlane never asks for the platform password or one-time codes.`}
      />
      <form onSubmit={onSubmit} noValidate className="flex max-w-[920px] flex-col gap-5">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <Panel title="Profile link">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label="Platform" required error={errors.platform?.message}>
              <Controller
                control={form.control}
                name="platform"
                render={({ field }) => <Select value={field.value} onChange={(v) => field.onChange(v ?? 'other')} options={PLATFORMS.map((p) => ({ value: p, label: label('platform', p) }))} />}
              />
            </Field>
            <Field label="Profile URL" required error={errors.profileUrl?.message} helper="https:// link to the public profile. Tracking parameters are removed for duplicate detection; the original link is kept.">
              <Input {...form.register('profileUrl')} inputMode="url" autoComplete="off" placeholder="https://" />
            </Field>
            <div className="md:col-span-2" aria-live="polite">
              {preview.data && url.trim().length > 8 ? (
                preview.data.ok ? (
                  <div className="flex flex-col gap-2 rounded-[8px] bg-surface-2 px-3 py-2 text-[13px]">
                    <span>
                      Normalized: <span className="font-mono text-fg">{preview.data.canonicalUrl}</span>
                      {preview.data.handle ? <span className="text-fg-2"> · handle @{preview.data.handle}</span> : null}
                    </span>
                    {preview.data.removedParams.length ? <span className="text-fg-2">Ignored tracking parameters: {preview.data.removedParams.join(', ')}</span> : null}
                    {dup ? (
                      <Banner tone="warning">
                        {dup.account ? (
                          <>
                            This account is already registered: {dup.account.handle ? `@${dup.account.handle}` : 'existing account'} in {dup.account.projectName} ({label('accountStatus', dup.account.status)}).{' '}
                            <a className="underline" href={wsPath(`/accounts/${dup.account.id}`)}>
                              Open the existing account
                            </a>
                          </>
                        ) : (
                          'An account with this profile link already exists in the workspace. Ask its owner for access instead of adding it again.'
                        )}
                      </Banner>
                    ) : null}
                  </div>
                ) : (
                  <p className="text-[13px] text-danger">{preview.data.message}</p>
                )
              ) : null}
            </div>
            {identityChanged ? (
              <Field label="Reason for the link change" className="md:col-span-2" helper="The previous handle and link stay in the account history; publications keep pointing at this account.">
                <Input {...form.register('identityChangeReason')} maxLength={LIMITS.reasonMax} />
              </Field>
            ) : null}
            <Field label="Handle" error={errors.handle?.message} helper="Filled from the link when empty.">
              <Input {...form.register('handle')} maxLength={LIMITS.handleMax} placeholder={preview.data?.handle ?? ''} />
            </Field>
            <Field label="Display Name" error={errors.displayName?.message}>
              <Input {...form.register('displayName')} maxLength={LIMITS.shortNameMax} />
            </Field>
          </div>
        </Panel>
        <Panel title="Responsibility">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label="Project" required error={errors.projectId?.message} helper={account ? 'Use Transfer on the account page to move it to another project.' : undefined}>
              <Controller
                control={form.control}
                name="projectId"
                render={({ field }) => <EntitySelect type="project" value={field.value || null} onChange={(v) => field.onChange(v ?? '')} disabled={!!account} />}
              />
            </Field>
            <Field label="Owner" required error={errors.ownerMembershipId?.message}>
              <Controller control={form.control} name="ownerMembershipId" render={({ field }) => <MemberSelect value={field.value} onChange={(v) => field.onChange(v ?? '')} />} />
            </Field>
            {!account ? (
              <Field label="Status" className="md:col-span-2">
                <Controller
                  control={form.control}
                  name="status"
                  render={({ field }) => (
                    <RadioGroup
                      label="Status"
                      orientation="horizontal"
                      value={field.value}
                      onValueChange={field.onChange}
                      options={[
                        { value: 'preparing', label: 'Preparing', description: 'Being set up; not used for publishing yet.' },
                        { value: 'active', label: 'Active', description: 'In use for publishing.' },
                      ]}
                    />
                  )}
                />
              </Field>
            ) : null}
            {account ? (
              <div className="flex flex-wrap items-center justify-between gap-2 md:col-span-2">
                <p className="text-[13px] text-fg-2">
                  {account.assignments.length ? `${account.assignments.length} member(s) assigned.` : 'No members assigned yet.'}
                </p>
                {account.permissions.assign ? (
                  <Button size="sm" onClick={() => setAssignOpen(true)}>
                    Add Member
                  </Button>
                ) : null}
              </div>
            ) : (
              <p className="text-[13px] text-fg-2 md:col-span-2">Add team members on the account page after saving.</p>
            )}
          </div>
        </Panel>
        <Panel title="Details">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label="Language" helper="Language code, e.g. en, ru, es.">
              <Input {...form.register('language')} maxLength={20} />
            </Field>
            <Field label="Markets" helper="Comma-separated, e.g. US, UK, DE.">
              <Input {...form.register('markets')} />
            </Field>
            <Field label="Purpose" className="md:col-span-2">
              <Textarea {...form.register('purpose')} maxLength={2000} />
            </Field>
            <Field label="Notes" className="md:col-span-2">
              <Textarea {...form.register('notes')} maxLength={LIMITS.noteMax} />
            </Field>
            <Field label="Tags" helper="Comma-separated, up to 30." className="md:col-span-2">
              <Input {...form.register('tags')} />
            </Field>
          </div>
        </Panel>
        <Panel title="Metrics cadence" description="When the team plans to record account statistics manually.">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <Field label="Cadence">
              <Controller
                control={form.control}
                name="metricsCadence"
                render={({ field }) => (
                  <Select value={field.value} onChange={(v) => field.onChange(v ?? 'weekly')} options={(['daily', 'weekly', 'monthly'] as const).map((c) => ({ value: c, label: label('metricsCadence', c) }))} />
                )}
              />
            </Field>
            {cadence === 'weekly' ? (
              <Field label="Day of week">
                <Controller control={form.control} name="metricsDayOfWeek" render={({ field }) => <Select value={field.value} onChange={(v) => field.onChange(v ?? '1')} options={WEEKDAY_OPTIONS} />} />
              </Field>
            ) : null}
            <Field label="Time" error={errors.metricsTime?.message} helper={`Your time zone: ${workspace.timezone}`}>
              <Input {...form.register('metricsTime')} placeholder="10:00" inputMode="numeric" />
            </Field>
            <Field label="Caption limit" error={errors.captionMaxLength?.message} helper="Optional maximum caption length for this account.">
              <Input {...form.register('captionMaxLength')} inputMode="numeric" />
            </Field>
          </div>
        </Panel>
        <Panel title="Avatar" description="Upload a picture yourself; Castlane never downloads profile images.">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
            {avatarAssetId ? (
              <div className="flex flex-col items-start gap-2">
                <AssetThumb workspaceId={workspace.id} assetId={avatarAssetId} size={128} alt="Account avatar" className="h-20 w-20 object-cover" />
                <Button size="sm" variant="ghost" onClick={() => form.setValue('avatarAssetId', null, { shouldDirty: true })}>
                  Remove Avatar
                </Button>
              </div>
            ) : null}
            <div className="flex-1">
              {projectId ? (
                <FileUploader
                  workspaceId={workspace.id}
                  purpose="avatar"
                  projectId={projectId}
                  target={account ? { entityType: 'account', entityId: account.id, role: 'avatar' } : undefined}
                  accept="image/jpeg,image/png,image/webp"
                  multiple={false}
                  label="Upload Avatar"
                  hint="JPG, PNG or WebP up to 10 MB."
                  compact
                  onUploaded={(i) => i.assetId && form.setValue('avatarAssetId', i.assetId, { shouldDirty: true })}
                />
              ) : (
                <p className="text-[13px] text-fg-2">Choose the project first.</p>
              )}
            </div>
          </div>
        </Panel>
        {account?.canonicalUrl ? (
          <p className="text-[13px] text-fg-2">
            Current link: <ExternalLink href={account.canonicalUrl} />
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button onClick={() => router.back()} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={pending} disabled={!!dup}>
            {account ? 'Save Changes' : 'Save Account'}
          </Button>
        </div>
      </form>
      <ConflictDialog {...edit.conflictDialog} />
      {account ? <AssignMemberDialog open={assignOpen} onOpenChange={setAssignOpen} accountId={account.id} /> : null}
    </div>
  );
};
