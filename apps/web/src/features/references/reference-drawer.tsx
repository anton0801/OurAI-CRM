'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { Lightbulb, LinkSimple, PencilSimple, X } from '@phosphor-icons/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { REFERENCE_LINK_TARGETS, mediaEndpoints, referenceEndpoints, type ReferenceDetail } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { CONTENT_FORMATS, LIMITS, REFERENCE_TAGS } from '@castlane/domain';
import {
  Avatar,
  Badge,
  Banner,
  Button,
  ConfirmDialog,
  DescriptionList,
  Dialog,
  Drawer,
  Field,
  IconButton,
  Input,
  MultiSelect,
  RadioGroup,
  Select,
  StatusBadge,
  Textarea,
  formatDate,
  toast,
} from '@castlane/ui';
import { EntitySelect } from '@/components/common/entity-select';
import { ConflictDialog } from '@/components/common/conflict';
import { changedFields, pickChanged, useEditBase } from '@/lib/edit-base';
import { QueryState } from '@/components/common/query-state';
import { AssetThumb, FileUploader } from '@/components/media/file-uploader';
import { api } from '@/lib/api';
import { applyFieldErrors, useApiMutation, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useWorkspace, useWsPath } from '@/lib/workspace-context';
import { ExternalLink } from '@/features/accounts/platform';
import '@/features/accounts/labels';

const schema = z
  .object({
    title: z.string().trim().min(2, 'Use 2–120 characters.').max(120, 'Use 2–120 characters.'),
    sourceKind: z.enum(['link', 'file']),
    sourceUrl: z.string().trim().max(LIMITS.urlMax).optional(),
    sourceAssetId: z.string().nullable(),
    sourceAssetName: z.string().nullable(),
    previewAssetId: z.string().nullable(),
    whatToReuse: z.string().trim().min(3, 'Describe what to reuse.').max(LIMITS.noteMax),
    notes: z.string().max(LIMITS.noteMax).optional(),
    tags: z.array(z.enum(REFERENCE_TAGS)),
    projectId: z.string().nullable(),
  })
  .superRefine((v, ctx) => {
    if (v.sourceKind === 'link' && !v.sourceUrl?.trim()) ctx.addIssue({ code: 'custom', path: ['sourceUrl'], message: 'Add the link.' });
    if (v.sourceKind === 'file' && !v.sourceAssetId) ctx.addIssue({ code: 'custom', path: ['sourceAssetId'], message: 'Upload the file.' });
  });
type FormValues = z.infer<typeof schema>;

export const ReferenceDrawer = ({ referenceId, defaultProjectId, onClose, onCreated }: { referenceId: string | null; defaultProjectId?: string; onClose: () => void; onCreated?: (id: string) => void }) => {
  const { workspace } = useWorkspace();
  const q = useApiQuery(referenceEndpoints.get, { params: { workspaceId: workspace.id, referenceId: referenceId ?? '' } }, { enabled: !!referenceId });
  const [editing, setEditing] = useState(!referenceId);
  if (!referenceId) return <ReferenceForm defaultProjectId={defaultProjectId} onClose={onClose} onSaved={(id) => onCreated?.(id)} />;
  if (editing && q.data) return <ReferenceForm reference={q.data} onClose={() => setEditing(false)} onSaved={() => setEditing(false)} />;
  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      width={760}
      title={q.data?.title ?? 'Reference'}
      description={q.data ? `${q.data.project?.name ?? 'Workspace'} · added ${formatDate(q.data.createdAt)}` : undefined}
      headerActions={q.data?.permissions.update ? <IconButton label="Edit reference" icon={<PencilSimple size={16} />} onClick={() => setEditing(true)} /> : undefined}
    >
      <QueryState query={q}>{q.data ? <ReferenceView r={q.data} onEdit={() => setEditing(true)} /> : null}</QueryState>
    </Drawer>
  );
};

const ReferenceView = ({ r, onEdit }: { r: ReferenceDetail; onEdit: () => void }) => {
  const { workspace } = useWorkspace();
  const wsPath = useWsPath();
  const router = useRouter();
  const [linkOpen, setLinkOpen] = useState(false);
  const [ideaOpen, setIdeaOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const unlink = useApiMutation(referenceEndpoints.unlink, { invalidate: ['references.'], successMessage: 'Link removed' });
  const archive = useApiMutation(referenceEndpoints.archive, { invalidate: ['references.'], successMessage: 'Reference archived' });
  const restore = useApiMutation(referenceEndpoints.restore, { invalidate: ['references.'], successMessage: 'Reference restored' });
  const [downloading, setDownloading] = useState(false);
  return (
    <div className="flex flex-col gap-5">
      {r.archivedAt ? <Banner tone="info">Archived records remain available in historical reports. Linked content keeps this reference.</Banner> : null}
      {r.previewUrl ? (
        // Full preview with object-fit contain (never cropped).
        // eslint-disable-next-line @next/next/no-img-element
        <img src={r.previewUrl.replace('size=320', 'size=1280')} alt={`Preview of ${r.title}`} className="max-h-[420px] w-full rounded-[12px] bg-surface-2 object-contain" />
      ) : null}
      <div className="flex flex-wrap gap-2">
        {r.sourceUrl ? (
          <ExternalLink href={r.sourceUrl} className="text-[14px]">
            Open Source
          </ExternalLink>
        ) : null}
        {r.sourceAsset ? (
          <Button
            size="sm"
            loading={downloading}
            onClick={async () => {
              setDownloading(true);
              try {
                const d = await api.call(mediaEndpoints.download, { params: { workspaceId: workspace.id, assetId: r.sourceAsset!.id }, body: {} });
                window.location.assign(d.url);
              } catch (e) {
                toast.error(isApiError(e) ? e.message : 'The file could not be downloaded.');
              } finally {
                setDownloading(false);
              }
            }}
          >
            Download {r.sourceAsset.name}
          </Button>
        ) : null}
        {r.permissions.createIdea ? (
          r.idea ? (
            <Button size="sm" variant="primary" icon={<Lightbulb size={14} />} onClick={() => router.push(wsPath(`/content/${r.idea!.contentItemId}`))}>
              Open Idea
            </Button>
          ) : (
            <Button size="sm" variant="primary" icon={<Lightbulb size={14} />} onClick={() => setIdeaOpen(true)}>
              Create Idea
            </Button>
          )
        ) : null}
        {r.permissions.update ? (
          <Button size="sm" icon={<LinkSimple size={14} />} onClick={() => setLinkOpen(true)}>
            Link Projects
          </Button>
        ) : null}
        {r.permissions.update ? (
          <Button size="sm" icon={<PencilSimple size={14} />} onClick={onEdit}>
            Edit
          </Button>
        ) : null}
      </div>
      <DescriptionList
        items={[
          { label: 'What to reuse', value: <span className="whitespace-pre-wrap">{r.whatToReuse}</span> },
          { label: 'Notes', value: r.notes ? <span className="whitespace-pre-wrap">{r.notes}</span> : null },
          { label: 'Tags', value: r.tags.length ? <span className="flex flex-wrap gap-1">{r.tags.map((t) => <Badge key={t}>{label('referenceTag', t)}</Badge>)}</span> : null },
          {
            label: 'Author',
            value: (
              <span className="flex items-center gap-1.5">
                <Avatar name={r.author.displayName} src={r.author.avatarUrl} size={24} decorative /> {r.author.displayName}
              </span>
            ),
          },
          { label: 'Project', value: r.project ? <Link className="text-primary hover:underline" href={wsPath(`/projects/${r.project.id}`)}>{r.project.name}</Link> : 'Workspace-wide' },
          { label: 'Source', value: r.sourceUrl ? <span className="break-all">{r.sourceUrl}</span> : r.sourceAsset ? r.sourceAsset.name : null },
        ]}
      />
      <section className="flex flex-col gap-2">
        <h3 className="text-[16px] font-semibold text-fg">Used in</h3>
        {r.links.length === 0 && r.hiddenLinkCount === 0 ? <p className="text-[13px] text-fg-2">Not linked to any project, character or content yet.</p> : null}
        <ul className="flex flex-col divide-y divide-line">
          {r.links.map((l) => (
            <li key={l.id} className="flex items-center justify-between gap-2 py-2 text-[13px]">
              <span className="flex min-w-0 items-center gap-2">
                <Badge>{l.kind === 'idea' ? 'Idea' : l.sublabel ?? l.targetType}</Badge>
                <Link href={l.href} className="truncate text-fg hover:underline">
                  {l.label}
                </Link>
              </span>
              {r.permissions.update && l.kind !== 'idea' ? (
                <IconButton label={`Remove link to ${l.label}`} icon={<X size={14} />} onClick={() => void unlink.run({ params: { workspaceId: workspace.id, referenceId: r.id, linkId: l.id }, body: {} }).catch(() => undefined)} />
              ) : null}
            </li>
          ))}
        </ul>
        {r.hiddenLinkCount ? <p className="text-[12px] text-fg-2">Also used in {r.hiddenLinkCount} record(s) outside your access.</p> : null}
      </section>
      {r.permissions.archive ? (
        <div>
          {r.archivedAt ? (
            <Button onClick={() => void restore.run({ params: { workspaceId: workspace.id, referenceId: r.id }, body: {} }, { ifMatch: r.rowVersion }).catch(() => undefined)} loading={restore.isPending}>
              Restore Reference
            </Button>
          ) : (
            <Button variant="danger-secondary" onClick={() => setArchiveOpen(true)}>
              Archive Reference
            </Button>
          )}
        </div>
      ) : null}
      <LinkDialog reference={r} open={linkOpen} onOpenChange={setLinkOpen} />
      <IdeaDialog reference={r} open={ideaOpen} onOpenChange={setIdeaOpen} />
      <ConfirmDialog
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        title="Archive reference?"
        body={`Archived records remain available in historical reports. ${r.usage.content + r.usage.projects + r.usage.characters} link(s) are kept.`}
        confirmLabel="Archive Reference"
        destructive
        loading={archive.isPending}
        onConfirm={async () => {
          try {
            await archive.run({ params: { workspaceId: workspace.id, referenceId: r.id }, body: {} }, { ifMatch: r.rowVersion });
            setArchiveOpen(false);
          } catch {
            /* toast shown */
          }
        }}
      />
    </div>
  );
};

const LINK_LABEL: Record<(typeof REFERENCE_LINK_TARGETS)[number], string> = { project: 'Project', character: 'Character', content_item: 'Content' };

const LinkDialog = ({ reference, open, onOpenChange }: { reference: ReferenceDetail; open: boolean; onOpenChange: (o: boolean) => void }) => {
  const { workspace } = useWorkspace();
  const [type, setType] = useState<(typeof REFERENCE_LINK_TARGETS)[number]>('project');
  const [target, setTarget] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const link = useApiMutation(referenceEndpoints.link, { invalidate: ['references.'], silentErrors: true, successMessage: 'Reference linked' });
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Link reference"
      size="small"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!target}
            loading={link.isPending}
            onClick={async () => {
              setError(null);
              try {
                await link.run({ params: { workspaceId: workspace.id, referenceId: reference.id }, body: { targetType: type, targetId: target! } });
                setTarget(null);
                onOpenChange(false);
              } catch (e) {
                setError(isApiError(e) ? (e.fieldErrors[0]?.message ?? e.message) : 'The link could not be added.');
              }
            }}
          >
            Link
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <RadioGroup
          label="Link to"
          orientation="horizontal"
          value={type}
          onValueChange={(v) => {
            setType(v);
            setTarget(null);
          }}
          options={REFERENCE_LINK_TARGETS.map((t) => ({ value: t, label: LINK_LABEL[t] }))}
        />
        <Field label={LINK_LABEL[type]} required>
          <EntitySelect key={type} type={type} value={target} onChange={setTarget} filters={reference.project && type !== 'project' ? { projectId: reference.project.id } : undefined} />
        </Field>
      </div>
    </Dialog>
  );
};

const IdeaDialog = ({ reference, open, onOpenChange }: { reference: ReferenceDetail; open: boolean; onOpenChange: (o: boolean) => void }) => {
  const { workspace } = useWorkspace();
  const wsPath = useWsPath();
  const router = useRouter();
  const [projectId, setProjectId] = useState<string | null>(reference.project?.id ?? null);
  const [format, setFormat] = useState<string | null>('short_video');
  const [title, setTitle] = useState(reference.title);
  const [error, setError] = useState<string | null>(null);
  const idea = useApiMutation(referenceEndpoints.useAsIdea, { invalidate: ['references.', 'content.'], silentErrors: true });
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Create idea from reference"
      description="Creates one content draft in stage Idea, linked to this reference."
      size="small"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!projectId || !format || title.trim().length < 2}
            loading={idea.isPending}
            onClick={async () => {
              setError(null);
              try {
                const r = await idea.run({ params: { workspaceId: workspace.id, referenceId: reference.id }, body: { projectId: projectId!, format: format as never, title: title.trim() } });
                toast.success(r.created ? 'Idea created' : 'This reference already has an idea');
                onOpenChange(false);
                router.push(wsPath(`/content/${r.contentItemId}/edit`));
              } catch (e) {
                setError(isApiError(e) ? (e.fieldErrors[0]?.message ?? e.message) : 'The idea could not be created.');
              }
            }}
          >
            Create Idea
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <Field label="Project" required>
          <EntitySelect type="project" value={projectId} onChange={setProjectId} />
        </Field>
        <Field label="Format" required>
          <Select value={format} onChange={setFormat} options={CONTENT_FORMATS.map((f) => ({ value: f, label: label('contentFormat', f) }))} />
        </Field>
        <Field label="Title" required>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
        </Field>
      </div>
    </Dialog>
  );
};

/** Create / edit drawer: Title*, URL or File*, What to Reuse*, Notes, Tags, Project. */
const ReferenceForm = ({ reference, defaultProjectId, onClose, onSaved }: { reference?: ReferenceDetail; defaultProjectId?: string; onClose: () => void; onSaved: (id: string) => void }) => {
  const { workspace } = useWorkspace();
  const [error, setError] = useState<string | null>(null);
  const valuesOf = (reference?: ReferenceDetail): FormValues =>
    reference
      ? {
          title: reference.title,
          sourceKind: reference.sourceUrl || !reference.sourceAsset ? 'link' : 'file',
          sourceUrl: reference.sourceUrl ?? '',
          sourceAssetId: reference.sourceAsset?.id ?? null,
          sourceAssetName: reference.sourceAsset?.name ?? null,
          previewAssetId: reference.previewAssetId,
          whatToReuse: reference.whatToReuse,
          notes: reference.notes ?? '',
          tags: reference.tags,
          projectId: reference.project?.id ?? null,
        }
      : { title: '', sourceKind: 'link', sourceUrl: '', sourceAssetId: null, sourceAssetName: null, previewAssetId: null, whatToReuse: '', notes: '', tags: [], projectId: defaultProjectId ?? null };
  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: valuesOf(reference) });
  // Edits apply to the reference as it was opened; only changed fields are sent (T162).
  const edit = useEditBase(reference, { onReload: (latest) => form.reset(valuesOf(latest)) });
  const create = useApiMutation(referenceEndpoints.create, { invalidate: ['references.'], silentErrors: true, successMessage: 'Reference added' });
  const update = useApiMutation(referenceEndpoints.update, { invalidate: ['references.'], silentErrors: true, successMessage: 'Reference saved' });
  const kind = form.watch('sourceKind');
  const projectId = form.watch('projectId');
  const previewAssetId = form.watch('previewAssetId');
  const sourceAssetName = form.watch('sourceAssetName');
  const errors = form.formState.errors;
  const onSubmit = form.handleSubmit(async (v) => {
    setError(null);
    const bodyOf = (v: FormValues) => ({
      title: v.title.trim(),
      sourceUrl: v.sourceKind === 'link' ? v.sourceUrl?.trim() || null : null,
      sourceAssetId: v.sourceKind === 'file' ? v.sourceAssetId : null,
      previewAssetId: v.previewAssetId,
      whatToReuse: v.whatToReuse.trim(),
      notes: v.notes?.trim() || null,
      tags: v.tags,
      projectId: v.projectId,
    });
    const body = bodyOf(v);
    try {
      if (reference) {
        const before = bodyOf(valuesOf(edit.start ?? reference));
        await update.run({ params: { workspaceId: workspace.id, referenceId: reference.id }, body: pickChanged(body, changedFields(before, body)) }, { ifMatch: edit.version });
        onSaved(reference.id);
      } else {
        const r = await create.run({ params: { workspaceId: workspace.id }, body });
        onSaved(r.id);
      }
    } catch (e) {
      if (edit.catchConflict(e)) return;
      if (!applyFieldErrors(e, form.setError as never)) setError(isApiError(e) ? e.message : 'The reference could not be saved.');
    }
  });
  const pending = create.isPending || update.isPending;
  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      width={560}
      dirty={form.formState.isDirty}
      title={reference ? `Edit ${reference.title}` : 'Add reference'}
      description="A link is stored as a note; Castlane never downloads or previews other people’s videos."
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" loading={pending} onClick={() => void onSubmit()}>
            {reference ? 'Save Changes' : 'Add Reference'}
          </Button>
        </>
      }
    >
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <Field label="Title" required error={errors.title?.message}>
          <Input {...form.register('title')} maxLength={120} />
        </Field>
        <Field label="Source" required>
          <Controller
            control={form.control}
            name="sourceKind"
            render={({ field }) => (
              <RadioGroup
                label="Source"
                orientation="horizontal"
                value={field.value}
                onValueChange={field.onChange}
                options={[
                  { value: 'link', label: 'Link' },
                  { value: 'file', label: 'File' },
                ]}
              />
            )}
          />
        </Field>
        {kind === 'link' ? (
          <Field label="URL" required error={errors.sourceUrl?.message}>
            <Input {...form.register('sourceUrl')} inputMode="url" placeholder="https://" />
          </Field>
        ) : (
          <div className="flex flex-col gap-2">
            {sourceAssetName ? (
              <p className="text-[13px]">
                File: <span className="font-medium">{sourceAssetName}</span>
              </p>
            ) : null}
            <FileUploader
              workspaceId={workspace.id}
              purpose="reference"
              projectId={projectId}
              target={reference ? { entityType: 'reference', entityId: reference.id, role: 'source' } : undefined}
              multiple={false}
              label="Upload File"
              compact
              onUploaded={(i) => {
                if (!i.assetId) return;
                form.setValue('sourceAssetId', i.assetId, { shouldDirty: true, shouldValidate: true });
                form.setValue('sourceAssetName', i.file.name, { shouldDirty: true });
              }}
            />
            {errors.sourceAssetId?.message ? <p className="text-[12px] text-danger">{errors.sourceAssetId.message}</p> : null}
          </div>
        )}
        <div className="flex flex-col gap-2">
          <span className="text-[12px] font-[550] text-fg">Preview image</span>
          <p className="text-[12px] text-fg-2">Optional. Only an image you upload is shown; image files double as their own preview.</p>
          {previewAssetId ? (
            <div className="flex items-center gap-3">
              <AssetThumb workspaceId={workspace.id} assetId={previewAssetId} size={256} alt="Reference preview" className="h-[82px] w-[110px] object-cover" />
              <Button size="sm" variant="ghost" onClick={() => form.setValue('previewAssetId', null, { shouldDirty: true })}>
                Remove Preview
              </Button>
            </div>
          ) : null}
          <FileUploader
            workspaceId={workspace.id}
            purpose="reference"
            projectId={projectId}
            accept="image/jpeg,image/png,image/webp"
            multiple={false}
            label="Upload Preview"
            compact
            onUploaded={(i) => i.assetId && form.setValue('previewAssetId', i.assetId, { shouldDirty: true })}
          />
        </div>
        <Field label="What to Reuse" required error={errors.whatToReuse?.message}>
          <Textarea {...form.register('whatToReuse')} maxLength={LIMITS.noteMax} />
        </Field>
        <Field label="Notes">
          <Textarea {...form.register('notes')} maxLength={LIMITS.noteMax} />
        </Field>
        <Field label="Tags">
          <Controller
            control={form.control}
            name="tags"
            render={({ field }) => <MultiSelect value={field.value} onChange={field.onChange} options={REFERENCE_TAGS.map((t) => ({ value: t, label: label('referenceTag', t) }))} placeholder="Choose tags" />}
          />
        </Field>
        <Field label="Project" helper="Empty = visible to everyone with access to references.">
          <Controller control={form.control} name="projectId" render={({ field }) => <EntitySelect type="project" value={field.value} onChange={field.onChange} clearable />} />
        </Field>
        {reference?.archivedAt ? <StatusBadge status="archived" /> : null}
      </form>
      <ConflictDialog {...edit.conflictDialog} />
    </Drawer>
  );
};
