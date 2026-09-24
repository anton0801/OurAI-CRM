'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { projectEndpoints, type ProjectDetail } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { LIMITS, PROJECT_TYPES } from '@castlane/domain';
import { Banner, Button, Checkbox, DateInput, Field, Input, PageHeader, Panel, RadioGroup, Switch, Textarea } from '@castlane/ui';
import { ConflictDialog } from '@/components/common/conflict';
import { DirectionSelect, MemberSelect } from '@/components/common/pickers';
import { applyFieldErrors, useApiMutation } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useWorkspace, useWsPath } from '@/lib/workspace-context';

const schema = z.object({
  name: z.string().trim().min(2, 'Use 2–120 characters.').max(120, 'Use 2–120 characters.'),
  type: z.enum(PROJECT_TYPES),
  directionId: z.string().uuid('Choose a direction.'),
  ownerMembershipId: z.string().uuid('Choose an owner.'),
  briefSummary: z.string().max(2000).optional(),
  description: z.string().max(LIMITS.noteMax).optional(),
  language: z.string().max(20).optional(),
  targetMarkets: z.string().max(600).optional(),
  audience: z.string().max(2000).optional(),
  tags: z.string().max(1200).optional(),
  startDate: z.string().optional(),
  ofmEnabled: z.boolean(),
  activate: z.boolean(),
});
type FormValues = z.infer<typeof schema>;

const splitList = (v?: string) =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** S14 Project Editor: create (Draft, optionally activated) or edit with If-Match. */
export const ProjectEditor = ({ project }: { project?: ProjectDetail }) => {
  const router = useRouter();
  const wsPath = useWsPath();
  const { workspace, membershipId } = useWorkspace();
  const [conflict, setConflict] = useState(false);
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: project
      ? {
          name: project.name,
          type: project.type,
          directionId: project.direction.id,
          ownerMembershipId: project.owner.membershipId,
          briefSummary: project.briefSummary ?? '',
          description: project.description ?? '',
          language: project.language ?? '',
          targetMarkets: project.targetMarkets.join(', '),
          audience: project.audience ?? '',
          tags: project.tags.join(', '),
          startDate: project.startDate ?? '',
          ofmEnabled: project.ofmEnabled,
          activate: false,
        }
      : { name: '', type: 'series', directionId: '', ownerMembershipId: membershipId, ofmEnabled: false, activate: true, briefSummary: '' },
  });
  const create = useApiMutation(projectEndpoints.create, { invalidate: ['projects.'], silentErrors: true });
  const update = useApiMutation(projectEndpoints.update, { invalidate: ['projects.'], silentErrors: true });
  const [error, setError] = useState<string | null>(null);
  const type = form.watch('type');

  const onSubmit = form.handleSubmit(async (v) => {
    setError(null);
    const body = {
      name: v.name,
      directionId: v.directionId,
      ownerMembershipId: v.ownerMembershipId,
      briefSummary: v.briefSummary?.trim() || null,
      description: v.description?.trim() || null,
      language: v.language?.trim() || null,
      targetMarkets: splitList(v.targetMarkets),
      audience: v.audience?.trim() || null,
      tags: splitList(v.tags),
      startDate: v.startDate || null,
      ofmEnabled: v.type === 'series' ? false : v.ofmEnabled,
    };
    try {
      if (project) {
        const { directionId: _ignored, ...patch } = body;
        void _ignored;
        const r = await update.run({ params: { workspaceId: workspace.id, projectId: project.id }, body: { ...patch, type: v.type } }, { ifMatch: project.rowVersion });
        router.push(wsPath(`/projects/${r.id}`));
      } else {
        const r = await create.run({ params: { workspaceId: workspace.id }, body: { ...body, type: v.type, activate: v.activate && !!body.briefSummary } });
        router.push(wsPath(`/projects/${r.id}`));
      }
    } catch (e) {
      if (isApiError(e) && e.code === 'VERSION_CONFLICT') setConflict(true);
      else if (!applyFieldErrors(e, form.setError as never)) setError(isApiError(e) ? e.message : 'The project could not be saved.');
    }
  });

  const pending = create.isPending || update.isPending;
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={project ? `Edit ${project.name}` : 'New Project'}
        crumbs={[{ label: 'Projects', href: wsPath('/projects') }, ...(project ? [{ label: project.name, href: wsPath(`/projects/${project.id}`) }] : []), { label: project ? 'Edit' : 'New' }]}
        description={project ? undefined : 'Creating a project does not create accounts, content or statistics.'}
      />
      <form onSubmit={onSubmit} noValidate className="flex max-w-[920px] flex-col gap-5">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <Panel title="Basics">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label="Name" required error={form.formState.errors.name?.message} className="md:col-span-2">
              <Input {...form.register('name')} maxLength={120} />
            </Field>
            <Field label="Type" required helper={project?.locked.type ? `Locked: ${project.locked.type}` : undefined} className="md:col-span-2">
              <Controller
                control={form.control}
                name="type"
                render={({ field }) => (
                  <RadioGroup
                    label="Type"
                    orientation="horizontal"
                    value={field.value}
                    onValueChange={field.onChange}
                    options={PROJECT_TYPES.map((t) => ({ value: t, label: label('projectType', t), disabled: !!project?.locked.type && t !== project.type }))}
                  />
                )}
              />
            </Field>
            <Field label="Direction" required error={form.formState.errors.directionId?.message} helper={project ? 'Use Transfer Direction on the project page to move it.' : undefined}>
              <Controller control={form.control} name="directionId" render={({ field }) => <DirectionSelect value={field.value} onChange={(v) => field.onChange(v ?? '')} disabled={!!project} />} />
            </Field>
            <Field label="Owner" required error={form.formState.errors.ownerMembershipId?.message}>
              <Controller control={form.control} name="ownerMembershipId" render={({ field }) => <MemberSelect value={field.value} onChange={(v) => field.onChange(v ?? '')} />} />
            </Field>
            {type !== 'series' ? (
              <div className="md:col-span-2">
                <Controller
                  control={form.control}
                  name="ofmEnabled"
                  render={({ field }) => (
                    <Switch
                      label="OFM Enabled"
                      description="Adds the OFM operations profile to this project. The model stays one project — no duplicate is created."
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  )}
                />
              </div>
            ) : null}
          </div>
        </Panel>
        <Panel title="Brief">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label="Brief summary" helper="Required before the project becomes Active." className="md:col-span-2">
              <Textarea {...form.register('briefSummary')} maxLength={2000} />
            </Field>
            <Field label="Description" className="md:col-span-2">
              <Textarea {...form.register('description')} maxLength={LIMITS.noteMax} />
            </Field>
            <Field label="Audience" className="md:col-span-2">
              <Input {...form.register('audience')} maxLength={2000} />
            </Field>
            <Field label="Language" helper="Language code, e.g. en, ru, es.">
              <Input {...form.register('language')} maxLength={20} />
            </Field>
            <Field label="Target Markets" helper="Comma-separated, e.g. US, UK, DE.">
              <Input {...form.register('targetMarkets')} />
            </Field>
            <Field label="Tags" helper="Comma-separated, up to 30.">
              <Input {...form.register('tags')} />
            </Field>
            <Field label="Start Date">
              <DateInput {...form.register('startDate')} />
            </Field>
          </div>
        </Panel>
        {!project ? (
          <Controller
            control={form.control}
            name="activate"
            render={({ field }) => (
              <Checkbox checked={field.value} onCheckedChange={field.onChange} label="Activate the project now" description="Requires a brief summary; otherwise the project is saved as Draft." />
            )}
          />
        ) : null}
        <div className="flex justify-end gap-2">
          <Button onClick={() => router.back()} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={pending}>
            {project ? 'Save Changes' : 'Create Project'}
          </Button>
        </div>
      </form>
      <ConflictDialog open={conflict} onOpenChange={setConflict} onReload={() => window.location.reload()} />
    </div>
  );
};
