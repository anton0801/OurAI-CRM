'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter, useSearchParams } from 'next/navigation';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { ARTICLE_SCOPE_TYPES, knowledgeEndpoints } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { Banner, Button, Field, Input, PageHeader, Panel, RadioGroup, Switch } from '@castlane/ui';
import { EntitySelect } from '@/components/common/entity-select';
import { DirectionSelect, MemberSelect } from '@/components/common/pickers';
import { applyFieldErrors, useApiMutation } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUnsavedChangesGuard } from '@/lib/unsaved';
import { useWorkspace, useWsPath } from '@/lib/workspace-context';
import './labels';

const schema = z
  .object({
    title: z.string().trim().min(2, 'Use 2–120 characters.').max(120, 'Use 2–120 characters.'),
    categoryId: z.string().uuid('Choose a category.'),
    scopeType: z.enum(ARTICLE_SCOPE_TYPES),
    scopeId: z.string().nullable(),
    ownerMembershipId: z.string().uuid('Choose an owner.'),
    requiredReading: z.boolean(),
  })
  .refine((v) => v.scopeType === 'workspace' || !!v.scopeId, { message: 'Choose where the article applies.', path: ['scopeId'] });
type Values = z.infer<typeof schema>;

/** New Article: creates a draft only when saved (no empty records from abandoned forms). */
export const ArticleNew = () => {
  const { workspace, membershipId } = useWorkspace();
  const wsPath = useWsPath();
  const router = useRouter();
  const params = useSearchParams();
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      title: '',
      categoryId: params.get('category') ?? '',
      scopeType: params.get('projectId') ? 'project' : 'workspace',
      scopeId: params.get('projectId'),
      ownerMembershipId: membershipId,
      requiredReading: false,
    },
  });
  useUnsavedChangesGuard(form.formState.isDirty && !form.formState.isSubmitSuccessful);
  const create = useApiMutation(knowledgeEndpoints.create, { invalidate: ['knowledge.'], silentErrors: true, successMessage: 'Draft created' });
  const scopeType = form.watch('scopeType');
  const submit = form.handleSubmit(async (v) => {
    try {
      const r = await create.run({
        params: { workspaceId: workspace.id },
        body: { title: v.title, categoryId: v.categoryId, scopeType: v.scopeType, scopeId: v.scopeType === 'workspace' ? null : v.scopeId, ownerMembershipId: v.ownerMembershipId, requiredReading: v.requiredReading },
      });
      router.replace(wsPath(`/knowledge/${r.id}?tab=edit`));
    } catch (e) {
      if (!applyFieldErrors(e, form.setError as never)) form.setError('root', { message: isApiError(e) ? e.message : 'The article could not be created.' });
    }
  });
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        crumbs={[{ label: 'Knowledge', href: wsPath('/knowledge') }, { label: 'New Article' }]}
        title="New Article"
        description="The article starts as a draft. Readers see it only after you publish a version."
      />
      <form onSubmit={(e) => void submit(e)} noValidate className="flex max-w-[760px] flex-col gap-5">
        {form.formState.errors.root?.message ? <Banner tone="danger">{form.formState.errors.root.message}</Banner> : null}
        <Panel title="Article">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label="Title" required error={form.formState.errors.title?.message} className="md:col-span-2">
              <Input {...form.register('title')} maxLength={120} autoFocus />
            </Field>
            <Field label="Category" required error={form.formState.errors.categoryId?.message}>
              <Controller control={form.control} name="categoryId" render={({ field }) => <EntitySelect type="article_category" value={field.value || null} onChange={(v) => field.onChange(v ?? '')} />} />
            </Field>
            <Field label="Owner" required error={form.formState.errors.ownerMembershipId?.message}>
              <Controller control={form.control} name="ownerMembershipId" render={({ field }) => <MemberSelect value={field.value} onChange={(v) => field.onChange(v ?? '')} />} />
            </Field>
            <Field label="Scope" required helper="Who can read the published text." className="md:col-span-2">
              <Controller
                control={form.control}
                name="scopeType"
                render={({ field }) => (
                  <RadioGroup
                    label="Scope"
                    orientation="horizontal"
                    value={field.value}
                    onValueChange={(v) => {
                      field.onChange(v);
                      form.setValue('scopeId', null);
                    }}
                    options={ARTICLE_SCOPE_TYPES.map((s) => ({ value: s, label: label('articleScope', s) }))}
                  />
                )}
              />
            </Field>
            {scopeType !== 'workspace' ? (
              <Field label={scopeType === 'project' ? 'Project' : 'Direction'} required error={form.formState.errors.scopeId?.message} className="md:col-span-2">
                <Controller
                  control={form.control}
                  name="scopeId"
                  render={({ field }) => (scopeType === 'project' ? <EntitySelect type="project" value={field.value} onChange={(v) => field.onChange(v)} /> : <DirectionSelect value={field.value} onChange={field.onChange} />)}
                />
              </Field>
            ) : null}
            <div className="md:col-span-2">
              <Controller
                control={form.control}
                name="requiredReading"
                render={({ field }) => (
                  <Switch
                    label="Required reading"
                    description="After publishing, assign readers; they confirm with Acknowledge Read. A major revision asks them again."
                    checked={field.value}
                    onCheckedChange={field.onChange}
                  />
                )}
              />
            </div>
          </div>
        </Panel>
        <div className="flex justify-end gap-2">
          <Button onClick={() => router.back()} disabled={create.isPending}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={create.isPending}>
            Create Draft
          </Button>
        </div>
      </form>
    </div>
  );
};
