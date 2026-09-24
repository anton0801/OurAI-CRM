'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { ArrowDown, ArrowUp, DotsThree, Plus, Star, Trash, WarningCircle } from '@phosphor-icons/react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Controller, useFieldArray, useForm } from 'react-hook-form';
import { z } from 'zod';
import { characterEndpoints, type CharacterDetail, type CharacterVersionView } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { LIMITS } from '@castlane/domain';
import {
  Badge,
  Banner,
  Button,
  Checkbox,
  ConfirmDialog,
  DescriptionList,
  Dialog,
  EmptyState,
  Field,
  IconButton,
  Input,
  Menu,
  PageHeader,
  Panel,
  StatusBadge,
  Textarea,
  formatDate,
  formatDateTime,
  toast,
  type MenuItem,
} from '@castlane/ui';
import { ConflictDialog } from '@/components/common/conflict';
import { useEditBase } from '@/lib/edit-base';
import { MemberSelect } from '@/components/common/pickers';
import { QueryState } from '@/components/common/query-state';
import { AssetThumb, FileUploader } from '@/components/media/file-uploader';
import { applyFieldErrors, useApiMutation, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { CHARACTER_PANELS } from '@/lib/slots';
import { useUnsavedChangesGuard } from '@/lib/unsaved';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';
import '@/features/slots';
import '@/features/accounts/labels';

const PROFILE_FIELDS: { key: keyof ProfileValues; label: string; helper?: string }[] = [
  { key: 'fictionalIdentityNote', label: 'Fictional identity note', helper: 'State that this is a fictional persona and anything viewers should know.' },
  { key: 'appearance', label: 'Appearance' },
  { key: 'voice', label: 'Voice' },
  { key: 'personality', label: 'Personality' },
  { key: 'tone', label: 'Tone' },
  { key: 'allowedVariation', label: 'Allowed variation', helper: 'What may change between materials (outfits, hair, lighting…).' },
  { key: 'biography', label: 'Biography' },
  { key: 'audience', label: 'Audience' },
  { key: 'styleConstraints', label: 'Style constraints' },
  { key: 'toolsSettings', label: 'Tools and settings', helper: 'Models, seeds and settings. Never paste API keys or passwords.' },
];

const text = z.string().max(LIMITS.noteMax).optional();
const schema = z.object({
  fictionalIdentityNote: text,
  appearance: text,
  voice: text,
  personality: text,
  tone: text,
  allowedVariation: text,
  biography: text,
  audience: text,
  styleConstraints: text,
  toolsSettings: text,
  adultDeclared: z.boolean(),
  statedAge: z.string().regex(/^\d{0,3}$/, 'Enter an age in years.').refine((v) => !v || Number(v) >= 18, 'The stated age must be 18 or older.').optional(),
  prompts: z.array(z.object({ title: z.string().trim().min(1, 'Give the prompt a title.').max(120), text: z.string().trim().min(1, 'Enter the prompt text.').max(LIMITS.noteMax), tool: z.string().max(80).optional() })).max(50),
  references: z.array(z.object({ assetId: z.string(), assetVersionId: z.string(), name: z.string() })).max(12, 'Use at most 12 reference images.'),
  changeNote: z.string().max(2000).optional(),
});
type ProfileValues = z.infer<typeof schema>;

const toValues = (v: CharacterVersionView): ProfileValues => ({
  fictionalIdentityNote: v.profile.fictionalIdentityNote ?? '',
  appearance: v.profile.appearance ?? '',
  voice: v.profile.voice ?? '',
  personality: v.profile.personality ?? '',
  tone: v.profile.tone ?? '',
  allowedVariation: v.profile.allowedVariation ?? '',
  biography: v.profile.biography ?? '',
  audience: v.profile.audience ?? '',
  styleConstraints: v.profile.styleConstraints ?? '',
  toolsSettings: v.profile.toolsSettings ?? '',
  adultDeclared: !!v.profile.adultAgeDeclaration?.declared,
  statedAge: v.profile.adultAgeDeclaration?.statedAge ? String(v.profile.adultAgeDeclaration.statedAge) : '',
  prompts: v.prompts.map((p) => ({ title: p.title, text: p.text, tool: p.tool ?? '' })),
  references: v.references.map((r) => ({ assetId: r.assetId, assetVersionId: r.assetVersionId, name: r.name })),
  changeNote: v.changeNote ?? '',
});

/** S16 Character Profile: identity, versioned profile (draft → submitted → approved), references and usage. */
export const CharacterProfileScreen = ({ projectId, characterId }: { projectId: string; characterId: string }) => {
  const { workspace } = useWorkspace();
  const wsPath = useWsPath();
  const can = useCan();
  const q = useApiQuery(characterEndpoints.get, { params: { workspaceId: workspace.id, characterId } });
  const [renameOpen, setRenameOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [affectedOpen, setAffectedOpen] = useState(false);
  const newVersion = useApiMutation(characterEndpoints.newVersion, { invalidate: ['characters.'], successMessage: 'New draft version started' });
  const setPrimary = useApiMutation(characterEndpoints.setPrimary, { invalidate: ['characters.'], successMessage: 'Primary character updated' });
  const archive = useApiMutation(characterEndpoints.archive, { invalidate: ['characters.', 'projects.get'], silentErrors: true });
  const restore = useApiMutation(characterEndpoints.restore, { invalidate: ['characters.'], successMessage: 'Character restored' });
  const [archiveError, setArchiveError] = useState<string | null>(null);

  return (
    <QueryState query={q}>
      {q.data
        ? (() => {
            const c = q.data;
            if (c.project.id !== projectId) return <EmptyState title="Not found" description="This character belongs to another project." />;
            const menu: MenuItem[] = [
              { label: 'Rename', onSelect: () => setRenameOpen(true), hidden: !c.permissions.write },
              {
                label: c.isPrimary ? 'Unmark as Primary' : 'Set as Primary',
                hidden: !c.permissions.setPrimary,
                onSelect: () => void setPrimary.run({ params: { workspaceId: workspace.id, characterId: c.id }, body: { primary: !c.isPrimary } }, { ifMatch: c.rowVersion }).catch(() => undefined),
              },
              { label: 'View Affected Content', onSelect: () => setAffectedOpen(true), hidden: !can('content.read') },
              { label: 'Archive Character', destructive: true, separatorBefore: true, onSelect: () => setArchiveOpen(true), hidden: !c.permissions.archive || !!c.archivedAt },
              {
                label: 'Restore Character',
                hidden: !c.permissions.archive || !c.archivedAt,
                onSelect: () => void restore.run({ params: { workspaceId: workspace.id, characterId: c.id }, body: {} }, { ifMatch: c.rowVersion }).catch(() => undefined),
              },
            ];
            const slotProps = { characterId: c.id, projectId: c.projectId };
            const panels = CHARACTER_PANELS.items.filter((p) => !p.visible || p.visible(slotProps, can));
            return (
              <div className="flex flex-col gap-5">
                <PageHeader
                  crumbs={[
                    { label: 'Projects', href: wsPath('/projects') },
                    { label: c.project.name, href: wsPath(`/projects/${c.project.id}?tab=characters`) },
                    { label: c.name },
                  ]}
                  title={c.name}
                  meta={
                    <>
                      {c.role ? <Badge>{c.role}</Badge> : null}
                      {c.isPrimary ? (
                        <Badge tone="primary" icon={<Star size={12} weight="fill" aria-hidden />}>
                          Primary character
                        </Badge>
                      ) : null}
                      {c.approvedVersion ? <StatusBadge status="approved" label={`Approved Profile Version v${c.approvedVersion.versionNo}`} /> : <Badge tone="warning">No approved profile yet</Badge>}
                      {c.archivedAt ? <StatusBadge status="archived" /> : null}
                    </>
                  }
                  actions={
                    <>
                      {c.permissions.write && !c.open ? (
                        <Button
                          variant="primary"
                          icon={<Plus size={14} />}
                          loading={newVersion.isPending}
                          onClick={() => void newVersion.run({ params: { workspaceId: workspace.id, characterId: c.id }, body: {} }).catch(() => undefined)}
                        >
                          New Version
                        </Button>
                      ) : null}
                      {menu.some((m) => !m.hidden) ? <Menu label="More actions" trigger={<IconButton label="More actions" icon={<DotsThree size={18} weight="bold" />} variant="secondary" />} items={menu} /> : null}
                    </>
                  }
                />
                {c.archivedAt ? <Banner tone="info">Archived records remain available in historical reports. Scenes and content keep their character version links.</Banner> : null}
                {c.flaggedContentCount > 0 ? (
                  <Banner
                    tone="warning"
                    action={
                      <Button size="sm" onClick={() => setAffectedOpen(true)}>
                        View Affected Content
                      </Button>
                    }
                  >
                    {c.flaggedContentCount} content item(s) need a consistency review after the latest profile approval. Their images were not changed.
                  </Banner>
                ) : null}
                <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
                  <div className="flex min-w-0 flex-col gap-5">
                    {c.open ? <OpenVersion character={c} version={c.open} /> : null}
                    {c.approved ? <ApprovedVersion version={c.approved} collapsed={!!c.open} /> : null}
                    {!c.open && !c.approved ? <EmptyState title="No profile version" description="Start a new version to describe this character." /> : null}
                  </div>
                  <div className="flex flex-col gap-5">
                    <Panel title="Versions">
                      <ol className="flex flex-col divide-y divide-line">
                        {c.versions.map((v) => (
                          <li key={v.id} className="flex flex-col gap-0.5 py-2 text-[13px]">
                            <span className="flex items-center gap-2">
                              <span className="font-medium">v{v.versionNo}</span>
                              <StatusBadge status={v.state} label={label('characterVersionState', v.state)} />
                            </span>
                            <span className="text-fg-2">{v.approvedAt ? `Approved ${formatDate(v.approvedAt)}` : `Started ${formatDate(v.createdAt)}`}</span>
                            {v.changeNote ? <span className="text-fg-2">{v.changeNote}</span> : null}
                          </li>
                        ))}
                      </ol>
                    </Panel>
                    {panels.map((p) => (
                      <Panel key={p.key} title={p.label}>
                        <p.component {...slotProps} />
                      </Panel>
                    ))}
                  </div>
                </div>
                <RenameDialog character={c} open={renameOpen} onOpenChange={setRenameOpen} />
                <AffectedContentDialog characterId={c.id} open={affectedOpen} onOpenChange={setAffectedOpen} />
                <ConfirmDialog
                  open={archiveOpen}
                  onOpenChange={(o) => {
                    setArchiveOpen(o);
                    if (!o) setArchiveError(null);
                  }}
                  title="Archive character?"
                  body="The profile and its versions stay in history. Scenes and content keep their links; the character is no longer offered for new work."
                  confirmLabel="Archive Character"
                  destructive
                  loading={archive.isPending}
                  onConfirm={async () => {
                    setArchiveError(null);
                    try {
                      await archive.run({ params: { workspaceId: workspace.id, characterId: c.id }, body: {} }, { ifMatch: c.rowVersion });
                      toast.success('Character archived');
                      setArchiveOpen(false);
                    } catch (e) {
                      setArchiveError(isApiError(e) ? e.message : 'The character could not be archived.');
                    }
                  }}
                >
                  {archiveError ? <Banner tone="danger">{archiveError}</Banner> : null}
                </ConfirmDialog>
              </div>
            );
          })()
        : null}
    </QueryState>
  );
};

const ReferenceGrid = ({ refs, onRemove, onMove }: { refs: { assetId: string; assetVersionId: string; name: string; thumbnailUrl?: string | null }[]; onRemove?: (i: number) => void; onMove?: (i: number, d: -1 | 1) => void }) => {
  const { workspace } = useWorkspace();
  if (!refs.length) return <p className="text-[13px] text-fg-2">No reference images yet.</p>;
  const main = refs[0];
  return (
    <div className="flex flex-col gap-3">
      {main ? (
        // Main preview up to 320×426, object-fit contain (never cropped).
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={main.thumbnailUrl ?? `/api/v1/workspaces/${workspace.id}/assets/${main.assetId}/thumbnail?size=640&versionId=${main.assetVersionId}`}
          alt={`Main reference: ${main.name}`}
          className="h-auto max-h-[426px] w-full max-w-[320px] rounded-[12px] bg-surface-2 object-contain"
        />
      ) : null}
      <ul className="flex flex-wrap gap-2">
        {refs.map((r, i) => (
          <li key={r.assetVersionId} className="flex flex-col items-center gap-1">
            <AssetThumb workspaceId={workspace.id} assetId={r.assetId} size={128} alt={r.name} className="h-32 w-24 object-cover" />
            {onRemove || onMove ? (
              <span className="flex gap-0.5">
                {onMove ? (
                  <>
                    <IconButton label={`Move ${r.name} earlier`} icon={<ArrowUp size={14} />} disabled={i === 0} onClick={() => onMove(i, -1)} />
                    <IconButton label={`Move ${r.name} later`} icon={<ArrowDown size={14} />} disabled={i === refs.length - 1} onClick={() => onMove(i, 1)} />
                  </>
                ) : null}
                {onRemove ? <IconButton label={`Remove ${r.name}`} icon={<Trash size={14} />} onClick={() => onRemove(i)} /> : null}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
};

/** The open (draft or submitted) version: Save Draft / Submit, or Approve / Request Changes. */
const OpenVersion = ({ character: c, version: v }: { character: CharacterDetail; version: CharacterVersionView }) => {
  const { workspace, membershipId, user } = useWorkspace();
  const editable = v.state === 'draft' && c.permissions.write;
  const form = useForm<ProfileValues>({ resolver: zodResolver(schema), defaultValues: toValues(v) });
  const prompts = useFieldArray({ control: form.control, name: 'prompts' });
  const refs = useFieldArray({ control: form.control, name: 'references' });
  const [error, setError] = useState<string | null>(null);
  const [submitOpen, setSubmitOpen] = useState(false);
  const [reviewer, setReviewer] = useState<string | null>(null);
  const [changesOpen, setChangesOpen] = useState(false);
  const [summary, setSummary] = useState('');
  const dirty = form.formState.isDirty;
  // The draft is edited against the version it was loaded at: a background refresh neither resets the
  // typing nor moves If-Match (T162); an untouched draft simply follows the latest saved version.
  const edit = useEditBase(v, { clean: !dirty, onReload: (latest) => form.reset(toValues(latest)) });
  useEffect(() => {
    form.reset(toValues(v));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v.id]);
  useUnsavedChangesGuard(dirty);
  const save = useApiMutation(characterEndpoints.updateVersion, { invalidate: ['characters.'], silentErrors: true, successMessage: 'Draft saved' });
  const submit = useApiMutation(characterEndpoints.submitVersion, { invalidate: ['characters.'], silentErrors: true, successMessage: 'Submitted for approval' });
  const approve = useApiMutation(characterEndpoints.approveVersion, { invalidate: ['characters.'], silentErrors: true, successMessage: 'Profile approved' });
  const requestChanges = useApiMutation(characterEndpoints.requestChanges, { invalidate: ['characters.'], silentErrors: true, successMessage: 'Changes requested' });

  const bodyOf = (x: ProfileValues) => ({
    profile: {
      fictionalIdentityNote: x.fictionalIdentityNote,
      appearance: x.appearance,
      voice: x.voice,
      personality: x.personality,
      tone: x.tone,
      allowedVariation: x.allowedVariation,
      biography: x.biography,
      audience: x.audience,
      styleConstraints: x.styleConstraints,
      toolsSettings: x.toolsSettings,
      ...(x.adultDeclared ? { adultAgeDeclaration: { declared: true, ...(x.statedAge ? { statedAge: Number(x.statedAge) } : {}) } } : {}),
    },
    prompts: x.prompts.map((p) => ({ title: p.title, text: p.text, ...(p.tool?.trim() ? { tool: p.tool.trim() } : {}) })),
    referenceAssetVersionIds: x.references.map((r) => r.assetVersionId),
    changeNote: x.changeNote?.trim() || null,
  });
  const handleError = (e: unknown) => {
    if (edit.catchConflict(e)) return;
    if (!applyFieldErrors(e, form.setError as never)) setError(isApiError(e) ? e.message : 'The profile could not be saved.');
    else setError(isApiError(e) ? e.message : null);
  };
  const onSave = form.handleSubmit(async (x) => {
    setError(null);
    try {
      const saved = await save.run({ params: { workspaceId: workspace.id, versionId: v.id }, body: bodyOf(x) }, { ifMatch: edit.version });
      if (saved.open?.id === v.id) edit.rebase(saved.open);
      form.reset(x);
    } catch (e) {
      handleError(e);
    }
  });
  const isAuthor = v.pendingReview?.author?.membershipId === membershipId;
  const errors = form.formState.errors;

  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          Profile v{v.versionNo}
          <StatusBadge status={v.state} label={label('characterVersionState', v.state)} />
        </span>
      }
      description={v.state === 'submitted' ? `Submitted ${v.submittedAt ? formatDateTime(v.submittedAt, user.timezone) : ''}${v.pendingReview?.reviewer ? ` · reviewer ${v.pendingReview.reviewer.displayName}` : ''}` : 'Draft — changes are saved only when you choose Save Draft.'}
      actions={
        <>
          {editable ? (
            <>
              <Button onClick={() => void onSave()} loading={save.isPending} disabled={!dirty}>
                Save Draft
              </Button>
              <Button variant="primary" disabled={dirty} onClick={() => setSubmitOpen(true)}>
                Submit
              </Button>
            </>
          ) : null}
          {v.state === 'submitted' && c.permissions.approve && v.pendingReview ? (
            <>
              <Button onClick={() => setChangesOpen(true)}>Request Changes</Button>
              <Button
                variant="primary"
                disabled={isAuthor}
                loading={approve.isPending}
                onClick={async () => {
                  setError(null);
                  try {
                    await approve.run({ params: { workspaceId: workspace.id, versionId: v.id }, body: { reviewId: v.pendingReview!.id } }, { ifMatch: v.rowVersion });
                  } catch (e) {
                    handleError(e);
                  }
                }}
              >
                Approve Profile
              </Button>
            </>
          ) : null}
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        {v.state === 'submitted' && isAuthor && c.permissions.approve ? <Banner tone="info">You submitted this version, so another approver must review it.</Banner> : null}
        {v.lastDecision?.decision === 'changes_requested' && v.state === 'draft' ? (
          <Banner tone="warning">
            Changes requested{v.lastDecision.decidedBy ? ` by ${v.lastDecision.decidedBy.displayName}` : ''}: {v.lastDecision.summary}
          </Banner>
        ) : null}
        {editable ? (
          <form onSubmit={onSave} noValidate className="flex flex-col gap-5">
            <section className="flex flex-col gap-3">
              <h3 className="text-[14px] font-semibold text-fg">Reference set</h3>
              <ReferenceGrid
                refs={refs.fields}
                onRemove={(i) => refs.remove(i)}
                onMove={(i, d) => refs.move(i, i + d)}
              />
              {errors.references?.message ? <p className="text-[12px] text-danger">{errors.references.message}</p> : null}
              {c.permissions.uploadReferences && refs.fields.length < 12 ? (
                <FileUploader
                  workspaceId={workspace.id}
                  purpose="reference"
                  projectId={c.projectId}
                  target={{ entityType: 'character', entityId: c.id, role: 'reference' }}
                  accept="image/jpeg,image/png,image/webp"
                  label="Attach Image"
                  hint={`Up to 12 reference portraits (${refs.fields.length} used). They are added to the draft; choose Save Draft to keep them.`}
                  compact
                  onUploaded={(i) => {
                    if (i.assetId && i.assetVersionId && form.getValues('references').length < 12) refs.append({ assetId: i.assetId, assetVersionId: i.assetVersionId, name: i.file.name });
                  }}
                />
              ) : null}
            </section>
            <section className="flex flex-col gap-3 rounded-[12px] border border-line p-4">
              <Controller
                control={form.control}
                name="adultDeclared"
                render={({ field }) => (
                  <Checkbox
                    checked={field.value}
                    onCheckedChange={field.onChange}
                    label="Adult age declaration"
                    description={c.project.ofmEnabled ? 'Required for OFM characters: this persona is an adult.' : 'Declare that this persona is an adult.'}
                  />
                )}
              />
              {errors.adultDeclared?.message ? <p className="text-[12px] text-danger">{errors.adultDeclared.message}</p> : null}
              <Field label="Stated age" error={errors.statedAge?.message} className="max-w-[160px]" helper="18 or older.">
                <Input {...form.register('statedAge')} inputMode="numeric" />
              </Field>
            </section>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {PROFILE_FIELDS.map((f) => (
                <Field key={f.key} label={f.label} helper={f.helper} error={(errors[f.key] as { message?: string } | undefined)?.message} className={f.key === 'biography' || f.key === 'toolsSettings' ? 'md:col-span-2' : undefined}>
                  <Textarea {...form.register(f.key as 'appearance')} maxLength={LIMITS.noteMax} />
                </Field>
              ))}
            </div>
            <section className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <h3 className="text-[14px] font-semibold text-fg">Approved prompts</h3>
                <Button size="sm" icon={<Plus size={12} />} onClick={() => prompts.append({ title: '', text: '', tool: '' })}>
                  Add Prompt
                </Button>
              </div>
              {prompts.fields.length === 0 ? <p className="text-[13px] text-fg-2">No prompts yet. Prompts are text only — never store API keys here.</p> : null}
              {prompts.fields.map((p, i) => (
                <div key={p.id} className="grid grid-cols-1 gap-3 rounded-[12px] border border-line p-3 md:grid-cols-[1fr_200px_auto]">
                  <Field label="Title" error={errors.prompts?.[i]?.title?.message}>
                    <Input {...form.register(`prompts.${i}.title`)} maxLength={120} />
                  </Field>
                  <Field label="Tool" error={errors.prompts?.[i]?.tool?.message}>
                    <Input {...form.register(`prompts.${i}.tool`)} maxLength={80} />
                  </Field>
                  <div className="flex items-end">
                    <IconButton label={`Remove prompt ${i + 1}`} icon={<Trash size={16} />} onClick={() => prompts.remove(i)} />
                  </div>
                  <Field label="Prompt" error={errors.prompts?.[i]?.text?.message} className="md:col-span-3">
                    <Textarea {...form.register(`prompts.${i}.text`)} maxLength={LIMITS.noteMax} />
                  </Field>
                </div>
              ))}
            </section>
            <Field label="Change note" helper="What changed in this version." error={errors.changeNote?.message}>
              <Input {...form.register('changeNote')} maxLength={2000} />
            </Field>
          </form>
        ) : (
          <ProfileView version={v} />
        )}
      </div>
      <ConflictDialog {...edit.conflictDialog} />
      <Dialog
        open={submitOpen}
        onOpenChange={setSubmitOpen}
        title={`Submit profile v${v.versionNo} for approval?`}
        description="After submission the version cannot be edited until it is approved or returned."
        size="small"
        footer={
          <>
            <Button onClick={() => setSubmitOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              loading={submit.isPending}
              onClick={async () => {
                setError(null);
                try {
                  await submit.run({ params: { workspaceId: workspace.id, versionId: v.id }, body: { reviewerMembershipId: reviewer } }, { ifMatch: edit.version });
                  setSubmitOpen(false);
                } catch (e) {
                  setSubmitOpen(false);
                  handleError(e);
                }
              }}
            >
              Submit
            </Button>
          </>
        }
      >
        <Field label="Reviewer" helper="Optional. Without a reviewer the project owner is asked.">
          <MemberSelect value={reviewer} onChange={setReviewer} projectId={c.projectId} permission="characters.approve" clearable />
        </Field>
      </Dialog>
      <ConfirmDialog
        open={changesOpen}
        onOpenChange={setChangesOpen}
        title="Request changes?"
        body="The version returns to draft with your summary. The review decision is kept in history."
        confirmLabel="Request Changes"
        loading={requestChanges.isPending}
        confirmDisabled={summary.trim().length < 3}
        onConfirm={async () => {
          try {
            await requestChanges.run({ params: { workspaceId: workspace.id, versionId: v.id }, body: { reviewId: v.pendingReview!.id, summary: summary.trim() } }, { ifMatch: v.rowVersion });
            setChangesOpen(false);
            setSummary('');
          } catch (e) {
            setChangesOpen(false);
            handleError(e);
          }
        }}
      >
        <Field label="What needs to change?" required>
          <Textarea value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={2000} />
        </Field>
      </ConfirmDialog>
    </Panel>
  );
};

const ProfileView = ({ version: v }: { version: CharacterVersionView }) => (
  <div className="flex flex-col gap-5">
    <section className="flex flex-col gap-3">
      <h3 className="text-[14px] font-semibold text-fg">Reference set</h3>
      <ReferenceGrid refs={v.references} />
    </section>
    <DescriptionList
      items={[
        {
          label: 'Adult age declaration',
          value: v.profile.adultAgeDeclaration?.declared ? `Declared adult${v.profile.adultAgeDeclaration.statedAge ? ` (${v.profile.adultAgeDeclaration.statedAge})` : ''}` : 'Not declared',
        },
        ...PROFILE_FIELDS.map((f) => ({ label: f.label, value: (v.profile as Record<string, string | undefined>)[f.key] ? <span className="whitespace-pre-wrap">{(v.profile as Record<string, string>)[f.key]}</span> : null })),
      ]}
    />
    <section className="flex flex-col gap-2">
      <h3 className="text-[14px] font-semibold text-fg">Approved prompts</h3>
      {v.prompts.length === 0 ? (
        <p className="text-[13px] text-fg-2">No prompts.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {v.prompts.map((p, i) => (
            <li key={i} className="rounded-[8px] border border-line p-3 text-[13px]">
              <span className="font-medium">{p.title}</span>
              {p.tool ? <span className="text-fg-2"> · {p.tool}</span> : null}
              <p className="mt-1 whitespace-pre-wrap font-mono text-[12px] text-fg-2">{p.text}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
    {v.changeNote ? <p className="text-[13px] text-fg-2">Change note: {v.changeNote}</p> : null}
  </div>
);

const ApprovedVersion = ({ version: v, collapsed }: { version: CharacterVersionView; collapsed: boolean }) => {
  const [open, setOpen] = useState(!collapsed);
  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          Approved Profile Version v{v.versionNo}
          <StatusBadge status="approved" />
        </span>
      }
      description={`${v.approvedAt ? `Approved ${formatDate(v.approvedAt)}` : ''}${v.approvedBy ? ` by ${v.approvedBy.displayName}` : ''}. Approved versions are frozen; content refers to them.`}
      actions={
        collapsed ? (
          <Button size="sm" variant="ghost" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            {open ? 'Hide' : 'Show'}
          </Button>
        ) : undefined
      }
    >
      {open ? <ProfileView version={v} /> : <p className="text-[13px] text-fg-2">The approved profile stays in use until the new version is approved.</p>}
    </Panel>
  );
};

const RenameDialog = ({ character: c, open, onOpenChange }: { character: CharacterDetail; open: boolean; onOpenChange: (o: boolean) => void }) => {
  const { workspace } = useWorkspace();
  const [name, setName] = useState(c.name);
  const [role, setRole] = useState(c.role ?? '');
  const update = useApiMutation(characterEndpoints.update, { invalidate: ['characters.'], successMessage: 'Character updated', silentErrors: true });
  const [error, setError] = useState<string | null>(null);
  const load = (x: CharacterDetail) => {
    setName(x.name);
    setRole(x.role ?? '');
  };
  // Opened values stay while live updates refresh `c`; only changed fields are sent (T162).
  const edit = useEditBase(c, { open, onReload: load });
  const start = edit.start ?? c;
  useEffect(() => {
    if (open) {
      load(c);
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, c.id]);
  return (
    <>
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      dirty={name !== start.name || role !== (start.role ?? '')}
      title="Rename character"
      size="small"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={name.trim().length < 2}
            loading={update.isPending}
            onClick={async () => {
              try {
                const body = {
                  ...(name.trim() !== start.name ? { name: name.trim() } : {}),
                  ...((role.trim() || null) !== (start.role ?? null) ? { role: role.trim() || null } : {}),
                };
                if (Object.keys(body).length) await update.run({ params: { workspaceId: workspace.id, characterId: c.id }, body }, { ifMatch: edit.version });
                onOpenChange(false);
              } catch (e) {
                if (!edit.catchConflict(e)) setError(isApiError(e) ? e.message : 'Could not save.');
              }
            }}
          >
            Save Changes
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <Field label="Name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
        </Field>
        <Field label="Role">
          <Input value={role} onChange={(e) => setRole(e.target.value)} maxLength={120} />
        </Field>
      </div>
    </Dialog>
    <ConflictDialog {...edit.conflictDialog} />
    </>
  );
};

/** View Affected Content: content items that use any version of this character (within content scope). */
const AffectedContentDialog = ({ characterId, open, onOpenChange }: { characterId: string; open: boolean; onOpenChange: (o: boolean) => void }) => {
  const { workspace } = useWorkspace();
  const wsPath = useWsPath();
  const q = useApiQuery(characterEndpoints.affectedContent, { params: { workspaceId: workspace.id, characterId } }, { enabled: open });
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Content using this character" size="regular">
      <QueryState query={q}>
        {q.data ? (
          q.data.items.length === 0 ? (
            <p className="text-[14px] text-fg-2">No content you can access uses this character yet.{q.data.hiddenCount ? ` ${q.data.hiddenCount} item(s) are outside your access.` : ''}</p>
          ) : (
            <div className="flex flex-col gap-2">
              <ul className="flex flex-col divide-y divide-line">
                {q.data.items.map((i) => (
                  <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-[13px]">
                    <Link href={wsPath(`/content/${i.id}`)} className="font-medium text-fg hover:underline">
                      {i.title}
                    </Link>
                    <span className="flex items-center gap-2">
                      <span className="text-fg-2">v{i.characterVersionNo}</span>
                      <StatusBadge status={i.stage} label={label('contentStage', i.stage)} />
                      {i.needsConsistencyReview ? (
                        <Badge tone="warning" icon={<WarningCircle size={12} aria-hidden />}>
                          Needs Consistency Review
                        </Badge>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
              {q.data.hiddenCount ? <p className="text-[12px] text-fg-2">{q.data.hiddenCount} more item(s) are outside your access.</p> : null}
            </div>
          )
        ) : null}
      </QueryState>
    </Dialog>
  );
};
