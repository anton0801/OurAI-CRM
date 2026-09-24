'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import {
  characterEndpoints,
  contentEndpoints,
  templateEndpoints,
  type ContentDetail,
} from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { CONTENT_FORMATS, LIMITS } from '@castlane/domain';
import {
  Badge,
  Banner,
  Button,
  Checkbox,
  DateInput,
  DateTimeInput,
  Dialog,
  Field,
  Input,
  PageHeader,
  Panel,
  Select,
  Switch,
  Textarea,
  formatDate,
} from '@castlane/ui';
import { ConflictDialog } from '@/components/common/conflict';
import { changedFields, pickChanged, useEditBase } from '@/lib/edit-base';
import { EntitySelect, MultiEntitySelect } from '@/components/common/entity-select';
import { MemberSelect } from '@/components/common/pickers';
import { QueryState } from '@/components/common/query-state';
import { applyFieldErrors, useApiMutation, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUnsavedChangesGuard } from '@/lib/unsaved';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';
import { fromLocalInput, toLocalInput } from './format';
import { CONTENT_BRIEF_FIELDS } from './labels';

const optionalText = (max: number) => z.string().max(max).optional();

const schema = z
  .object({
    title: z
      .string()
      .trim()
      .min(LIMITS.taskTitleMin, `Use ${LIMITS.taskTitleMin}–${LIMITS.taskTitleMax} characters.`)
      .max(LIMITS.taskTitleMax),
    projectId: z.string().uuid('Choose a project.'),
    format: z.enum(CONTENT_FORMATS, { message: 'Choose a format.' }),
    ownerMembershipId: z.string().nullable(),
    reviewerMembershipId: z.string().nullable(),
    language: optionalText(20),
    dueAt: z.string().optional(),
    noDeadline: z.boolean(),
    tags: optionalText(1200),
    accountId: z.string().nullable(),
    episodeId: z.string().nullable(),
    referenceIds: z.array(z.string()),
    characterVersionIds: z.array(z.string()),
    summary: optionalText(2000),
    objective: optionalText(2000),
    audience: optionalText(2000),
    hook: optionalText(2000),
    script: optionalText(LIMITS.noteMax),
    captionDraft: optionalText(LIMITS.noteMax),
    cta: optionalText(500),
    notes: optionalText(LIMITS.noteMax),
    templateId: z.string().nullable(),
    templateStart: z.string().optional(),
  })
  .refine((v) => !(v.noDeadline && v.dueAt), {
    path: ['noDeadline'],
    message: 'Choose either a due date or No Deadline.',
  });
type FormValues = z.infer<typeof schema>;

const splitTags = (v?: string) =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** Characters of the project with their approved (or open draft) profile versions. */
const CharacterVersionsPicker = ({
  projectId,
  value,
  onChange,
}: {
  projectId: string;
  value: string[];
  onChange: (v: string[]) => void;
}) => {
  const { workspace } = useWorkspace();
  const q = useApiQuery(
    characterEndpoints.list,
    { params: { workspaceId: workspace.id, projectId }, query: {} },
    { enabled: !!projectId, retry: false },
  );
  if (!projectId) return <p className="text-[13px] text-fg-2">Choose a project first.</p>;
  if (q.error?.status === 403)
    return (
      <p className="text-[13px] text-fg-2">You do not have access to character profiles of this project.</p>
    );
  return (
    <QueryState query={q} skeleton={<p className="text-[13px] text-fg-2">Loading characters…</p>}>
      {(q.data ?? []).length === 0 ? (
        <p className="text-[13px] text-fg-2">This project has no character profiles yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {(q.data ?? [])
            .filter((c) => !c.archivedAt)
            .map((c) => {
              const versions = [
                c.approvedVersion
                  ? { id: c.approvedVersion.id, text: `Approved profile v${c.approvedVersion.versionNo}` }
                  : null,
                c.openVersion
                  ? {
                      id: c.openVersion.id,
                      text: `Profile v${c.openVersion.versionNo} (${c.openVersion.state})`,
                    }
                  : null,
              ].filter((x): x is { id: string; text: string } => !!x);
              const chosen = versions.find((v) => value.includes(v.id));
              return (
                <li key={c.id} className="flex flex-wrap items-center gap-3">
                  <Checkbox
                    checked={!!chosen}
                    disabled={!versions.length}
                    label={c.name}
                    description={versions.length ? undefined : 'No profile version yet'}
                    onCheckedChange={(on) => {
                      const others = value.filter((id) => !versions.some((v) => v.id === id));
                      onChange(on && versions[0] ? [...others, versions[0].id] : others);
                    }}
                  />
                  {chosen && versions.length > 1 ? (
                    <div className="w-[240px]">
                      <Select
                        aria-label={`Profile version of ${c.name}`}
                        value={chosen.id}
                        onChange={(id) =>
                          onChange([
                            ...value.filter((x) => !versions.some((v) => v.id === x)),
                            ...(id ? [id] : []),
                          ])
                        }
                        options={versions.map((v) => ({ value: v.id, label: v.text }))}
                      />
                    </div>
                  ) : chosen ? (
                    <Badge>{chosen.text}</Badge>
                  ) : null}
                </li>
              );
            })}
        </ul>
      )}
    </QueryState>
  );
};

/** Preview Generated Tasks for a new content item: the template's dated task graph (nothing is created). */
const TemplatePlanDialog = ({
  open,
  onOpenChange,
  templateId,
  startDate,
  projectId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  templateId: string;
  startDate: string;
  projectId: string;
}) => {
  const { workspace, user } = useWorkspace();
  const t = useApiQuery(
    templateEndpoints.get,
    { params: { workspaceId: workspace.id, templateId } },
    { enabled: open && !!templateId },
  );
  const plan = useApiQuery(
    templateEndpoints.previewApplication,
    {
      params: { workspaceId: workspace.id, templateId },
      body: { versionId: t.data?.published?.id, startDate, projectId },
    },
    { enabled: open && !!t.data?.published?.id },
  );
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Preview Generated Tasks"
      description="Names, dates and assignments the template would create. Nothing has been created yet."
      size="wide"
    >
      <QueryState query={t.data?.published ? plan : t}>
        {plan.data ? (
          <div className="flex flex-col gap-3">
            {plan.data.warnings.map((w) => (
              <Banner key={w} tone="warning">
                {w}
              </Banner>
            ))}
            <div className="overflow-x-auto rounded-[8px] border border-line">
              <table className="w-full min-w-[560px] text-[13px]">
                <caption className="sr-only">Generated tasks</caption>
                <thead className="bg-surface-2 text-left text-fg-2">
                  <tr>
                    <th className="px-3 py-2 font-[550]">Task</th>
                    <th className="px-3 py-2 font-[550]">Start</th>
                    <th className="px-3 py-2 font-[550]">Due</th>
                    <th className="px-3 py-2 font-[550]">Assignee</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {plan.data.tasks.map((task) => (
                    <tr key={task.key}>
                      <td className="px-3 py-2">{task.title}</td>
                      <td className="px-3 py-2">{formatDate(task.startDate, user.timezone)}</td>
                      <td className="px-3 py-2">{formatDate(task.dueDate, user.timezone)}</td>
                      <td className="px-3 py-2">
                        {task.assignee?.displayName ?? (
                          <span className="text-fg-muted">
                            Unassigned — a coordination task asks you to assign it
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : t.data && !t.data.published ? (
          <p className="text-[14px] text-fg-2">This template has no published version.</p>
        ) : null}
      </QueryState>
    </Dialog>
  );
};

/** S23 Content Editor: create (Idea draft, optionally applying a content template) or edit the brief with If-Match. */
export const ContentEditor = ({ content }: { content?: ContentDetail }) => {
  const router = useRouter();
  const search = useSearchParams();
  const wsPath = useWsPath();
  const can = useCan();
  const { workspace, user, membershipId } = useWorkspace();
  const [error, setError] = useState<string | null>(null);
  const [planOpen, setPlanOpen] = useState(false);
  const today = new Date().toISOString().slice(0, 10);
  const valuesOf = (content: ContentDetail): FormValues => ({
    title: content.title,
    projectId: content.project.id,
    format: content.format,
    ownerMembershipId: content.owner?.membershipId ?? null,
    reviewerMembershipId: content.reviewer?.membershipId ?? null,
    language: content.language ?? '',
    dueAt: toLocalInput(content.dueAt, user.timezone),
    noDeadline: content.noDeadline,
    tags: content.tags.join(', '),
    accountId: content.account?.id ?? null,
    episodeId: content.episode?.id ?? null,
    referenceIds: content.references.map((r) => r.id),
    characterVersionIds: content.characters.map((c) => c.versionId),
    ...Object.fromEntries(CONTENT_BRIEF_FIELDS.map((f) => [f.key, content.brief[f.key] ?? ''])),
    templateId: null,
    templateStart: today,
  });
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: content
      ? {
          title: content.title,
          projectId: content.project.id,
          format: content.format,
          ownerMembershipId: content.owner?.membershipId ?? null,
          reviewerMembershipId: content.reviewer?.membershipId ?? null,
          language: content.language ?? '',
          dueAt: toLocalInput(content.dueAt, user.timezone),
          noDeadline: content.noDeadline,
          tags: content.tags.join(', '),
          accountId: content.account?.id ?? null,
          episodeId: content.episode?.id ?? null,
          referenceIds: content.references.map((r) => r.id),
          characterVersionIds: content.characters.map((c) => c.versionId),
          ...Object.fromEntries(CONTENT_BRIEF_FIELDS.map((f) => [f.key, content.brief[f.key] ?? ''])),
          templateId: null,
          templateStart: today,
        }
      : {
          title: '',
          projectId: search.get('projectId') ?? '',
          format: (search.get('format') as FormValues['format']) ?? undefined,
          ownerMembershipId: membershipId,
          reviewerMembershipId: null,
          language: '',
          dueAt: '',
          noDeadline: false,
          tags: '',
          accountId: search.get('accountId'),
          episodeId: search.get('episodeId'),
          referenceIds: [],
          characterVersionIds: [],
          templateId: null,
          templateStart: today,
        },
  });
  const create = useApiMutation(contentEndpoints.create, {
    invalidate: ['content.'],
    silentErrors: true,
    successMessage: 'Content created',
  });
  const update = useApiMutation(contentEndpoints.update, {
    invalidate: ['content.'],
    silentErrors: true,
    successMessage: 'Content saved',
  });
  const templateQ = useApiQuery(
    templateEndpoints.get,
    { params: { workspaceId: workspace.id, templateId: form.watch('templateId') ?? '' } },
    { enabled: !!form.watch('templateId') },
  );
  const projectId = form.watch('projectId');
  const dirty = form.formState.isDirty;
  // Edits apply to the content as the form opened; only changed fields (and brief parts) are sent (T162).
  const edit = useEditBase(content, { onReload: (x) => form.reset(valuesOf(x)) });
  useUnsavedChangesGuard(dirty && !create.isSuccess && !update.isSuccess);
  const errors = form.formState.errors;

  const bodyOf = (v: FormValues) => ({
    title: v.title.trim(),
    format: v.format,
    ownerMembershipId: v.ownerMembershipId,
    reviewerMembershipId: v.reviewerMembershipId,
    language: v.language?.trim() || null,
    dueAt: v.noDeadline ? null : fromLocalInput(v.dueAt ?? '', user.timezone),
    noDeadline: v.noDeadline,
    tags: splitTags(v.tags),
    accountId: v.accountId,
    episodeId: v.episodeId,
    referenceIds: v.referenceIds,
    characterVersionIds: v.characterVersionIds,
    brief: Object.fromEntries(CONTENT_BRIEF_FIELDS.map((f) => [f.key, (v[f.key] ?? '').trim() || null])),
  });

  const submit = (withTemplate: boolean) =>
    form.handleSubmit(async (v) => {
      setError(null);
      try {
        if (content) {
          const body = bodyOf(v);
          const before = bodyOf(valuesOf(edit.start ?? content));
          const changed = changedFields(before, body);
          if (changed.includes('dueAt') || changed.includes('noDeadline')) changed.push('dueAt', 'noDeadline');
          const patch: Partial<typeof body> = pickChanged(body, changed);
          if (patch.brief) patch.brief = pickChanged(body.brief, changedFields(before.brief, body.brief)) as typeof body.brief;
          const r = await update.run({ params: { workspaceId: workspace.id, contentId: content.id }, body: patch }, { ifMatch: edit.version });
          router.push(wsPath(`/content/${r.id}`));
          return;
        }
        const publishedId = templateQ.data?.published?.id;
        if (withTemplate && !publishedId) {
          form.setError('templateId', {
            type: 'required',
            message: 'Choose a template with a published version.',
          });
          return;
        }
        const r = await create.run({
          params: { workspaceId: workspace.id },
          body: {
            ...bodyOf(v),
            projectId: v.projectId,
            ...(withTemplate && publishedId
              ? { applyTemplate: { templateVersionId: publishedId, startDate: v.templateStart || today } }
              : {}),
          },
        });
        router.push(wsPath(`/content/${r.id}`));
      } catch (e) {
        if (edit.catchConflict(e)) return;
        if (
          !applyFieldErrors(e, ((name: string, err: { type: string; message: string }) =>
            form.setError((name.startsWith('brief.') ? name.slice(6) : name) as never, err)) as never)
        )
          setError(
            isApiError(e)
              ? e.network
                ? 'You are offline. Changes are not being saved.'
                : e.message
              : 'The content could not be saved.',
          );
      }
    });

  const pending = create.isPending || update.isPending;
  const title = content ? `Edit ${content.title}` : 'New Content';
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={title}
        crumbs={[
          { label: 'Content', href: wsPath('/content') },
          ...(content ? [{ label: content.title, href: wsPath(`/content/${content.id}`) }] : []),
          { label: content ? 'Edit' : 'New' },
        ]}
        description={
          content
            ? 'Editing the brief never changes publication facts. Stages change through their own actions.'
            : 'An Idea needs a title, project and format. Owner, reviewer, objective and a deadline are required before Ready.'
        }
        meta={dirty ? <Badge tone="warning">You have unsaved changes.</Badge> : undefined}
      />
      <form onSubmit={submit(false)} noValidate className="flex max-w-[960px] flex-col gap-5">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <Panel title="Basics">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label="Title" required error={errors.title?.message} className="md:col-span-2">
              <Input {...form.register('title')} maxLength={LIMITS.taskTitleMax} autoFocus={!content} />
            </Field>
            <Field
              label="Project"
              required
              error={errors.projectId?.message}
              helper={content ? 'The project of existing content does not change.' : undefined}
            >
              <Controller
                control={form.control}
                name="projectId"
                render={({ field }) => (
                  <EntitySelect
                    type="project"
                    value={field.value || null}
                    disabled={!!content}
                    onChange={(v) => {
                      field.onChange(v ?? '');
                      form.setValue('accountId', null);
                      form.setValue('episodeId', null);
                      form.setValue('characterVersionIds', []);
                    }}
                  />
                )}
              />
            </Field>
            <Field label="Format" required error={errors.format?.message}>
              <Controller
                control={form.control}
                name="format"
                render={({ field }) => (
                  <Select
                    value={field.value ?? null}
                    onChange={(v) => field.onChange(v ?? undefined)}
                    options={CONTENT_FORMATS.map((f) => ({ value: f, label: label('contentFormat', f) }))}
                  />
                )}
              />
            </Field>
            <Field
              label="Owner"
              required
              helper="Required before Production."
              error={errors.ownerMembershipId?.message}
            >
              <Controller
                control={form.control}
                name="ownerMembershipId"
                render={({ field }) => (
                  <MemberSelect
                    value={field.value}
                    onChange={field.onChange}
                    projectId={projectId || undefined}
                    permission={projectId ? 'content.read' : undefined}
                    clearable
                  />
                )}
              />
            </Field>
            <Field
              label="Reviewer"
              helper="Members with approval rights in the project. Required before Ready."
              error={errors.reviewerMembershipId?.message}
            >
              <Controller
                control={form.control}
                name="reviewerMembershipId"
                render={({ field }) => (
                  <MemberSelect
                    value={field.value}
                    onChange={field.onChange}
                    projectId={projectId || undefined}
                    permission={projectId ? 'content.approve' : undefined}
                    clearable
                  />
                )}
              />
            </Field>
            <Field label={`Due At (${user.timezone})`} error={errors.dueAt?.message}>
              <DateTimeInput
                timezone={user.timezone}
                {...form.register('dueAt')}
                disabled={form.watch('noDeadline')}
              />
            </Field>
            <div className="flex flex-col justify-center gap-1">
              <Controller
                control={form.control}
                name="noDeadline"
                render={({ field }) => (
                  <Switch
                    label="No Deadline"
                    description="Explicitly no due date (never shown as overdue)."
                    checked={field.value}
                    onCheckedChange={(v) => {
                      field.onChange(v);
                      if (v) form.setValue('dueAt', '');
                    }}
                  />
                )}
              />
              {errors.noDeadline?.message ? (
                <p className="text-[12px] text-danger">{errors.noDeadline.message}</p>
              ) : null}
            </div>
            <Field label="Language" helper="Language code, e.g. en, ru, es.">
              <Input {...form.register('language')} maxLength={20} />
            </Field>
            <Field label="Tags" helper="Comma-separated, up to 30." error={errors.tags?.message}>
              <Input {...form.register('tags')} />
            </Field>
            <Field
              label="Planned Account"
              helper="Placements are planned separately; this only links the content."
              error={errors.accountId?.message}
            >
              <Controller
                control={form.control}
                name="accountId"
                render={({ field }) => (
                  <EntitySelect
                    type="account"
                    value={field.value}
                    onChange={field.onChange}
                    filters={{ projectId: projectId || undefined }}
                    disabled={!projectId}
                    clearable
                  />
                )}
              />
            </Field>
            <Field label="Episode" error={errors.episodeId?.message}>
              <Controller
                control={form.control}
                name="episodeId"
                render={({ field }) => (
                  <EntitySelect
                    type="episode"
                    value={field.value}
                    onChange={field.onChange}
                    filters={{ projectId: projectId || undefined }}
                    disabled={!projectId}
                    clearable
                  />
                )}
              />
            </Field>
          </div>
        </Panel>
        <Panel title="Brief">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {CONTENT_BRIEF_FIELDS.map((f) => (
              <Field
                key={f.key}
                label={f.label}
                className={f.long ? 'md:col-span-2' : undefined}
                error={errors[f.key]?.message}
                helper={f.key === 'summary' || f.key === 'objective' ? 'Required before Ready.' : undefined}
              >
                {f.long ? (
                  <Textarea
                    {...form.register(f.key)}
                    maxLength={f.key === 'summary' ? 2000 : LIMITS.noteMax}
                  />
                ) : (
                  <Input {...form.register(f.key)} maxLength={f.key === 'cta' ? 500 : 2000} />
                )}
              </Field>
            ))}
          </div>
        </Panel>
        <Panel title="References and Characters">
          <div className="grid grid-cols-1 gap-4">
            {can('references.read') ? (
              <Field label="References" helper="Linked references stay visible on the reference as usage.">
                <Controller
                  control={form.control}
                  name="referenceIds"
                  render={({ field }) => (
                    <MultiEntitySelect
                      type="reference"
                      value={field.value}
                      onChange={field.onChange}
                      max={50}
                    />
                  )}
                />
              </Field>
            ) : null}
            <Field
              label="Characters and Versions"
              helper="The exact profile versions are frozen with each submitted version."
            >
              <Controller
                control={form.control}
                name="characterVersionIds"
                render={({ field }) => (
                  <CharacterVersionsPicker
                    projectId={projectId}
                    value={field.value}
                    onChange={field.onChange}
                  />
                )}
              />
            </Field>
          </div>
        </Panel>
        {!content && can('tasks.create') ? (
          <Panel
            title="Template"
            description="Creates the production tasks and sets deliverable slots and the checklist. Applying the same template again never duplicates tasks."
          >
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field label="Content Template" error={errors.templateId?.message}>
                <Controller
                  control={form.control}
                  name="templateId"
                  render={({ field }) => (
                    <EntitySelect
                      type="template"
                      value={field.value}
                      onChange={field.onChange}
                      filters={{ status: ['content', 'task'] }}
                      clearable
                    />
                  )}
                />
              </Field>
              <Field label="Start Date" helper="Relative task dates count from this day.">
                <DateInput {...form.register('templateStart')} />
              </Field>
            </div>
          </Panel>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={() => router.back()} disabled={pending}>
            Cancel
          </Button>
          {!content && form.watch('templateId') ? (
            <>
              <Button onClick={() => setPlanOpen(true)} disabled={!projectId}>
                Preview Generated Tasks
              </Button>
              <Button loading={create.isPending} onClick={() => void submit(true)()}>
                Create and Apply Template
              </Button>
            </>
          ) : null}
          <Button type="submit" variant="primary" loading={pending}>
            {content ? 'Save Changes' : 'Save Draft'}
          </Button>
        </div>
      </form>
      {planOpen && form.watch('templateId') ? (
        <TemplatePlanDialog
          open={planOpen}
          onOpenChange={setPlanOpen}
          templateId={form.watch('templateId')!}
          startDate={form.watch('templateStart') || today}
          projectId={projectId}
        />
      ) : null}
      <ConflictDialog {...edit.conflictDialog} />
    </div>
  );
};

/** S23 in edit mode: loads the item once (edits keep the loaded revision for If-Match). */
export const ContentEditScreen = ({ contentId }: { contentId: string }) => {
  const { workspace } = useWorkspace();
  const q = useApiQuery(
    contentEndpoints.get,
    { params: { workspaceId: workspace.id, contentId } },
    { staleTime: Infinity, refetchOnWindowFocus: false },
  );
  return <QueryState query={q}>{q.data ? <ContentEditor content={q.data} /> : null}</QueryState>;
};
