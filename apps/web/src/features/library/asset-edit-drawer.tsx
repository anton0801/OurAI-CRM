'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { folderEndpoints, mediaEndpoints, type AssetDetail } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { isSafeUrl } from '@castlane/domain';
import { Banner, Button, Drawer, Field, Input, Select, Textarea } from '@castlane/ui';
import { ConflictDialog } from '@/components/common/conflict';
import { useEditBase } from '@/lib/edit-base';
import { applyFieldErrors, useApiMutation, useApiQuery } from '@/lib/hooks';
import { useWorkspace } from '@/lib/workspace-context';
import { splitTags } from './library-utils';

const schema = z.object({
  name: z.string().trim().min(2, 'Use 2–120 characters.').max(120, 'Use 2–120 characters.'),
  description: z.string().max(2000),
  tags: z.string().max(1200),
  folderId: z.string(),
  sensitivity: z.enum(['normal', 'restricted']),
  externalUrl: z.string().max(2048),
});
type Values = z.infer<typeof schema>;

/** Edit Details (S37): metadata only — the stored file never changes (If-Match, conflict dialog). */
export const AssetEditDrawer = ({ open, onOpenChange, asset }: { open: boolean; onOpenChange: (o: boolean) => void; asset: AssetDetail }) => {
  const { workspace } = useWorkspace();
  const folders = useApiQuery(folderEndpoints.list, { params: { workspaceId: workspace.id }, query: {} }, { enabled: open });
  const defaults = (asset: AssetDetail): Values => ({
    name: asset.name,
    description: asset.description ?? '',
    tags: asset.tags.join(', '),
    folderId: asset.folderId ?? '__root__',
    sensitivity: asset.sensitivity,
    externalUrl: asset.externalUrl ?? '',
  });
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: defaults(asset) });
  // Opened values and If-Match stay put while live updates refresh `asset` (T162); only dirty fields are sent.
  const edit = useEditBase(asset, { open, onReload: (latest) => form.reset(defaults(latest)) });
  useEffect(() => {
    if (open) form.reset(defaults(asset));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, asset.id]);
  const update = useApiMutation(mediaEndpoints.update, { invalidate: ['assets.'], silentErrors: true, successMessage: 'File details saved' });
  const sensitivity = form.watch('sensitivity');
  const submit = form.handleSubmit(async (v) => {
    if (asset.kind === 'external_link' && !isSafeUrl(v.externalUrl)) {
      form.setError('externalUrl', { message: 'Enter a complete http:// or https:// link.' });
      return;
    }
    const d = form.formState.dirtyFields;
    const body = {
      ...(d.name ? { name: v.name } : {}),
      ...(d.description ? { description: v.description.trim() || null } : {}),
      ...(d.tags ? { tags: splitTags(v.tags) } : {}),
      ...(d.folderId ? { folderId: v.folderId === '__root__' ? null : v.folderId } : {}),
      ...(d.sensitivity ? { sensitivity: v.sensitivity } : {}),
      ...(d.externalUrl && asset.kind === 'external_link' ? { externalUrl: v.externalUrl } : {}),
    };
    try {
      await update.run({ params: { workspaceId: workspace.id, assetId: asset.id }, body }, { ifMatch: edit.version });
      onOpenChange(false);
    } catch (e) {
      if (edit.catchConflict(e)) return;
      if (!applyFieldErrors(e, form.setError as never)) form.setError('root', { message: isApiError(e) ? e.message : 'The details could not be saved.' });
    }
  });
  const folderOptions = [
    { value: '__root__', label: 'Library root (no folder)' },
    ...(folders.data ?? [])
      .filter((f) => !f.archivedAt && (f.projectId === null || f.projectId === asset.projectId))
      .map((f) => ({ value: f.id, label: `${'— '.repeat(f.depth)}${f.name}`, description: f.projectName ?? (f.projectId ? undefined : 'Workspace library') })),
  ];
  return (
    <>
      <Drawer
        open={open}
        onOpenChange={onOpenChange}
        title="Edit File Details"
        description="The stored file never changes; upload a new version to replace it."
        dirty={form.formState.isDirty && !update.isPending}
        footer={
          <>
            <Button onClick={() => onOpenChange(false)} disabled={update.isPending}>
              Cancel
            </Button>
            <Button variant="primary" loading={update.isPending} disabled={!form.formState.isDirty} onClick={() => void submit()}>
              Save Changes
            </Button>
          </>
        }
      >
        <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)} noValidate>
          {form.formState.errors.root?.message ? <Banner tone="danger">{form.formState.errors.root.message}</Banner> : null}
          <Field label="Name" required error={form.formState.errors.name?.message}>
            <Input {...form.register('name')} maxLength={120} />
          </Field>
          {asset.kind === 'external_link' ? (
            <Field label="Link" required error={form.formState.errors.externalUrl?.message}>
              <Input {...form.register('externalUrl')} inputMode="url" />
            </Field>
          ) : null}
          <Field label="Description" error={form.formState.errors.description?.message}>
            <Textarea {...form.register('description')} maxLength={2000} />
          </Field>
          <Field label="Tags" helper="Comma-separated, up to 30." error={form.formState.errors.tags?.message}>
            <Input {...form.register('tags')} />
          </Field>
          <Field label="Folder" helper="Only folders of this file’s project or the workspace library. Use Move in the Library to change the project." error={form.formState.errors.folderId?.message}>
            <Controller control={form.control} name="folderId" render={({ field }) => <Select value={field.value} onChange={(v) => field.onChange(v ?? '__root__')} options={folderOptions} searchable />} />
          </Field>
          {asset.permissions.changeSensitivity ? (
            <Field label="Sensitivity" error={form.formState.errors.sensitivity?.message}>
              <Controller
                control={form.control}
                name="sensitivity"
                render={({ field }) => (
                  <Select
                    value={field.value}
                    onChange={(v) => field.onChange(v ?? 'normal')}
                    options={[
                      { value: 'normal', label: 'Normal' },
                      { value: 'restricted', label: 'Restricted Media' },
                    ]}
                  />
                )}
              />
            </Field>
          ) : null}
          {sensitivity === 'restricted' && asset.sensitivity !== 'restricted' ? (
            <Banner tone="warning">
              Only members with restricted-media access will see this file, and it leaves search and thumbnails. Copies that were already downloaded cannot be recalled.
            </Banner>
          ) : null}
        </form>
      </Drawer>
      <ConflictDialog {...edit.conflictDialog} />
    </>
  );
};
