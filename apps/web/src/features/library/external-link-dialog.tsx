'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { mediaEndpoints } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { isSafeUrl } from '@castlane/domain';
import { Banner, Button, Dialog, Field, Input, Textarea } from '@castlane/ui';
import { EntitySelect } from '@/components/common/entity-select';
import { applyFieldErrors, useApiMutation } from '@/lib/hooks';
import { useWorkspace } from '@/lib/workspace-context';
import { splitTags } from './library-utils';

const schema = z.object({
  url: z
    .string()
    .trim()
    .max(2048)
    .refine((v) => isSafeUrl(v), 'Enter a complete http:// or https:// link.'),
  title: z.string().trim().min(2, 'Use 2–120 characters.').max(120, 'Use 2–120 characters.'),
  projectId: z.string().nullable(),
  description: z.string().max(2000).optional(),
  tags: z.string().max(1200).optional(),
});
type Values = z.infer<typeof schema>;

/**
 * Add External Link (S36): a metadata-only file. The server never downloads or previews it; the
 * Library shows it as an External Link (T081).
 */
export const ExternalLinkDialog = ({
  open,
  onOpenChange,
  folderId,
  defaultProjectId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  folderId: string | null;
  defaultProjectId: string | null;
  onCreated?: (assetId: string) => void;
}) => {
  const { workspace } = useWorkspace();
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { url: '', title: '', projectId: defaultProjectId, description: '', tags: '' } });
  useEffect(() => {
    if (open) form.reset({ url: '', title: '', projectId: defaultProjectId, description: '', tags: '' });
  }, [open, defaultProjectId, form]);
  const create = useApiMutation(mediaEndpoints.externalLink, { invalidate: ['assets.'], silentErrors: true, successMessage: 'External link added' });
  const submit = form.handleSubmit(async (v) => {
    try {
      const r = await create.run({
        params: { workspaceId: workspace.id },
        body: { url: v.url, title: v.title, projectId: v.projectId, folderId, description: v.description?.trim() || null, tags: splitTags(v.tags ?? '') },
      });
      onOpenChange(false);
      onCreated?.(r.id);
    } catch (e) {
      if (!applyFieldErrors(e, form.setError as never)) form.setError('root', { message: isApiError(e) ? e.message : 'The link could not be added.' });
    }
  });
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      dirty={form.formState.isDirty && !create.isPending}
      title="Add External Link"
      description="The link is stored as a note. Castlane does not download or preview it, and it is not a local copy of the file."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)} disabled={create.isPending}>
            Cancel
          </Button>
          <Button variant="primary" loading={create.isPending} onClick={() => void submit()}>
            Add Link
          </Button>
        </>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)} noValidate>
        {form.formState.errors.root?.message ? <Banner tone="danger">{form.formState.errors.root.message}</Banner> : null}
        <Field label="Link" required error={form.formState.errors.url?.message}>
          <Input {...form.register('url')} inputMode="url" placeholder="https://" />
        </Field>
        <Field label="Title" required error={form.formState.errors.title?.message}>
          <Input {...form.register('title')} maxLength={120} />
        </Field>
        {!folderId ? (
          <Field label="Project" helper="Leave empty for the workspace library (needs workspace-wide file access).">
            <Controller control={form.control} name="projectId" render={({ field }) => <EntitySelect type="project" value={field.value} onChange={(v) => field.onChange(v)} clearable />} />
          </Field>
        ) : null}
        <Field label="Description" error={form.formState.errors.description?.message}>
          <Textarea {...form.register('description')} maxLength={2000} />
        </Field>
        <Field label="Tags" helper="Comma-separated." error={form.formState.errors.tags?.message}>
          <Input {...form.register('tags')} />
        </Field>
      </form>
    </Dialog>
  );
};
