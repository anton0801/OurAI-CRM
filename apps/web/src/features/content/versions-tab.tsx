'use client';
import { CheckCircle, FolderOpen, PaperPlaneTilt, Plus, Trash, WarningCircle } from '@phosphor-icons/react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import {
  contentVersionEndpoints,
  mediaEndpoints,
  type ContentDetail,
  type ContentVersionDetail,
  type ContentVersionFile,
  type ContentVersionSummary,
} from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { LIMITS } from '@castlane/domain';
import {
  Badge,
  Banner,
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  Field,
  IconButton,
  Input,
  Panel,
  Select,
  StatusBadge,
  Textarea,
  cn,
  formatBytes,
  formatDateTime,
  toast,
} from '@castlane/ui';
import { ConflictDialog } from '@/components/common/conflict';
import { EntitySelect } from '@/components/common/entity-select';
import { MemberSelect } from '@/components/common/pickers';
import { QueryState } from '@/components/common/query-state';
import { DropZone, UploadList } from '@/components/media/file-uploader';
import { useUpload } from '@/components/media/use-upload';
import { api } from '@/lib/api';
import { changedFields, pickChanged, useEditBase } from '@/lib/edit-base';
import { useApiMutation, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';
import { useWorkspace, useWsPath } from '@/lib/workspace-context';
import {
  VersionCommentComposer,
  VersionComments,
  markersFor,
  useVersionComments,
  type AnnotationDraft,
} from '../reviews/review-comments';
import { CONTENT_BRIEF_FIELDS } from './labels';
import { FileMeta, FileViewer, type ViewerHandle } from './media-viewer';

const INVALIDATE = ['content.'];
const PENDING = ['uploading', 'uploaded', 'checking', 'processing'];

const ACCEPT: Partial<Record<string, string>> = {
  main_video: 'video/*',
  main_image: 'image/*',
  image_set: 'image/*',
  cover: 'image/*',
  subtitles: '.srt,.vtt,text/vtt',
  caption: '.txt,text/plain',
  audio: 'audio/*',
};

/** Version pointer strip (S24: up to 8 thumbnails 72×48). */
export const VersionStrip = ({
  versions,
  selectedId,
  onSelect,
}: {
  versions: ContentVersionSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) => (
  <ol className="flex gap-2 overflow-x-auto pb-1" aria-label="Versions">
    {versions.slice(0, 8).map((v) => (
      <li key={v.id}>
        <button
          type="button"
          onClick={() => onSelect(v.id)}
          aria-pressed={selectedId === v.id}
          aria-label={`Version ${v.versionNo}, ${label('versionState', v.state)}${v.isLatest ? ', latest' : ''}${v.isApproved ? ', approved' : ''}`}
          className={cn(
            'flex w-[88px] flex-col items-center gap-1 rounded-[8px] border p-1 text-[12px] focus-visible:outline-2 focus-visible:outline-[var(--c-focus)]',
            selectedId === v.id ? 'border-primary bg-selection' : 'border-line bg-surface hover:bg-surface-2',
          )}
        >
          {v.thumbnailUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={v.thumbnailUrl}
              alt=""
              width={72}
              height={48}
              loading="lazy"
              className="h-12 w-[72px] rounded-[6px] object-cover"
            />
          ) : (
            <span
              aria-hidden
              className="flex h-12 w-[72px] items-center justify-center rounded-[6px] bg-surface-2 font-mono text-fg-2"
            >
              v{v.versionNo}
            </span>
          )}
          <span className="font-semibold text-fg">v{v.versionNo}</span>
          <span className="truncate text-fg-2">
            {v.isApproved ? 'Approved' : label('versionState', v.state)}
          </span>
        </button>
      </li>
    ))}
  </ol>
);

/** Upload files into one deliverable slot; each file is attached as soon as its upload starts (it blocks Submit until Available). */
const SlotUploader = ({
  content,
  version,
  slot,
  multiple,
  replace,
}: {
  content: ContentDetail;
  version: ContentVersionDetail;
  slot: ContentVersionFile['slot'];
  multiple: boolean;
  replace: boolean;
}) => {
  const { workspace } = useWorkspace();
  const attach = useApiMutation(contentVersionEndpoints.attachFile, {
    invalidate: INVALIDATE,
    silentErrors: true,
  });
  const u = useUpload({
    workspaceId: workspace.id,
    purpose: 'content',
    projectId: content.project.id,
    checkDuplicates: true,
  });
  const attached = useRef(new Set<string>());
  useEffect(() => {
    for (const i of u.items) {
      if (
        !i.assetVersionId ||
        attached.current.has(i.assetVersionId) ||
        ['failed', 'cancelled', 'rejected', 'duplicate'].includes(i.state)
      )
        continue;
      attached.current.add(i.assetVersionId);
      void attach
        .run({
          params: { workspaceId: workspace.id, contentId: content.id, versionId: version.id },
          body: { slot, assetVersionId: i.assetVersionId },
        })
        .catch((e) => {
          toast.error(
            isApiError(e)
              ? (e.fieldErrors[0]?.message ?? e.message)
              : 'The file could not be added to the version.',
          );
        });
    }
  }, [u.items, attach, workspace.id, content.id, version.id, slot]);
  return (
    <div className="flex flex-col gap-2">
      <DropZone
        compact
        accept={ACCEPT[slot]}
        multiple={multiple}
        label={`${replace ? 'Replace' : 'Upload'} ${label('contentSlot', slot)}`}
        onFiles={u.add}
        hint={
          replace
            ? 'The new file replaces the current one in this version.'
            : 'Files are checked before they become available.'
        }
      />
      <UploadList
        u={u}
        workspaceId={workspace.id}
        target={{ entityType: 'content_version', entityId: version.id, role: slot }}
      />
    </div>
  );
};

/** Reuse a file that is already in the Library (its current stored version). */
const LibraryFileDialog = ({
  open,
  onOpenChange,
  content,
  version,
  slots,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  content: ContentDetail;
  version: ContentVersionDetail;
  slots: ContentVersionFile['slot'][];
}) => {
  const { workspace } = useWorkspace();
  const [assetId, setAssetId] = useState<string | null>(null);
  const [slot, setSlot] = useState<ContentVersionFile['slot'] | null>(slots[0] ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const attach = useApiMutation(contentVersionEndpoints.attachFile, {
    invalidate: INVALIDATE,
    silentErrors: true,
    successMessage: 'File added to the version',
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setAssetId(null);
          setError(null);
        }
        onOpenChange(o);
      }}
      title="Use a Library File"
      description="The stored file is reused as is; no copy is made."
      size="small"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!assetId || !slot}
            loading={busy || attach.isPending}
            onClick={async () => {
              setError(null);
              setBusy(true);
              try {
                const a = await api.call(mediaEndpoints.get, {
                  params: { workspaceId: workspace.id, assetId: assetId! },
                });
                const v = a.currentVersion ?? a.pendingVersion;
                if (!v) throw new Error('This file has no stored version.');
                await attach.run({
                  params: { workspaceId: workspace.id, contentId: content.id, versionId: version.id },
                  body: { slot: slot!, assetVersionId: v.id },
                });
                onOpenChange(false);
                setAssetId(null);
              } catch (e) {
                setError(isApiError(e) ? (e.fieldErrors[0]?.message ?? e.message) : (e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Add File
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <Field label="Slot" required>
          <Select
            value={slot}
            onChange={setSlot}
            options={slots.map((s) => ({ value: s, label: label('contentSlot', s) }))}
          />
        </Field>
        <Field label="File" required>
          <EntitySelect
            type="asset"
            value={assetId}
            onChange={setAssetId}
            filters={{ projectId: content.project.id }}
          />
        </Field>
      </div>
    </Dialog>
  );
};

const SubmitDialog = ({
  open,
  onOpenChange,
  content,
  version,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  content: ContentDetail;
  version: ContentVersionDetail;
}) => {
  const { workspace } = useWorkspace();
  const [reviewer, setReviewer] = useState<string | null>(content.reviewer?.membershipId ?? null);
  const [error, setError] = useState<string | null>(null);
  const submit = useApiMutation(contentVersionEndpoints.submit, {
    invalidate: [...INVALIDATE, 'reviews.', 'myWork.'],
    silentErrors: true,
    successMessage: `Version ${version.versionNo} submitted for review`,
  });
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Submit version ${version.versionNo} for review?`}
      description="The version, its files, the brief and the character versions are frozen. Later changes go into a new version."
      size="small"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            icon={<PaperPlaneTilt size={14} />}
            loading={submit.isPending}
            onClick={async () => {
              setError(null);
              try {
                await submit.run(
                  {
                    params: { workspaceId: workspace.id, contentId: content.id },
                    body: {
                      versionId: version.id,
                      reviewPolicyVersion: content.reviewPolicy.version,
                      ...(reviewer && reviewer !== content.reviewer?.membershipId
                        ? { reviewerMembershipId: reviewer }
                        : {}),
                    },
                  },
                  { ifMatch: content.rowVersion },
                );
                onOpenChange(false);
              } catch (e) {
                setError(isApiError(e) ? e.message : 'The version could not be submitted.');
              }
            }}
          >
            Submit for Review
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 text-[14px]">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <p>
          Review steps: {content.reviewPolicy.steps.map((s) => label('reviewStep', s)).join(' → ')}.{' '}
          {content.reviewPolicy.allowSelfReview
            ? 'The project allows an exceptional, audited self-review.'
            : 'The author cannot approve their own version.'}
        </p>
        <Field label="Reviewer" helper="Members with approval rights in this project.">
          <MemberSelect
            value={reviewer}
            onChange={setReviewer}
            projectId={content.project.id}
            permission="content.approve"
          />
        </Field>
      </div>
    </Dialog>
  );
};

const NewVersionDialog = ({
  open,
  onOpenChange,
  content,
  versions,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  content: ContentDetail;
  versions: ContentVersionSummary[];
  onCreated: (id: string) => void;
}) => {
  const { workspace } = useWorkspace();
  const [note, setNote] = useState('');
  const [fixes, setFixes] = useState('');
  const [copyFrom, setCopyFrom] = useState<string | null>(versions[0]?.id ?? null);
  const [error, setError] = useState<string | null>(null);
  const create = useApiMutation(contentVersionEndpoints.create, {
    invalidate: INVALIDATE,
    silentErrors: true,
    successMessage: 'New version started',
  });
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Start version ${(versions[0]?.versionNo ?? 0) + 1}`}
      description="A new draft version. Earlier versions, their comments and decisions stay unchanged."
      dirty={!!(note || fixes)}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            loading={create.isPending}
            onClick={async () => {
              setError(null);
              try {
                const v = await create.run({
                  params: { workspaceId: workspace.id, contentId: content.id },
                  body: {
                    note: note.trim() || undefined,
                    fixesClaimed: fixes.trim() || undefined,
                    copyFilesFromVersionId: copyFrom ?? undefined,
                  },
                });
                setNote('');
                setFixes('');
                onOpenChange(false);
                onCreated(v.id);
              } catch (e) {
                setError(isApiError(e) ? e.message : 'The version could not be created.');
              }
            }}
          >
            Start Version
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <Field label="Note">
          <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
        </Field>
        {content.stage === 'changes_requested' || versions.length ? (
          <Field
            label="Fixes made"
            helper="Tell the reviewer what changed compared with the previous version."
          >
            <Textarea value={fixes} onChange={(e) => setFixes(e.target.value)} maxLength={LIMITS.noteMax} />
          </Field>
        ) : null}
        {versions.length ? (
          <Field
            label="Start from files of"
            helper="Unchanged files are reused; replace the ones you changed."
          >
            <Select
              value={copyFrom}
              onChange={setCopyFrom}
              clearable
              placeholder="No files (empty version)"
              options={versions.map((v) => ({
                value: v.id,
                label: `Version ${v.versionNo} (${v.fileCount} files)`,
              }))}
            />
          </Field>
        ) : null}
      </div>
    </Dialog>
  );
};

const DraftVersion = ({ content, version }: { content: ContentDetail; version: ContentVersionDetail }) => {
  const { workspace } = useWorkspace();
  const params = { workspaceId: workspace.id, contentId: content.id, versionId: version.id };
  const update = useApiMutation(contentVersionEndpoints.update, {
    invalidate: INVALIDATE,
    silentErrors: true,
  });
  const remove = useApiMutation(contentVersionEndpoints.removeFile, {
    invalidate: INVALIDATE,
    successMessage: 'File removed from the version',
  });
  const [submitOpen, setSubmitOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [newItem, setNewItem] = useState('');
  const [note, setNote] = useState(version.note ?? '');
  const [fixes, setFixes] = useState(version.fixesClaimed ?? '');
  const [touched, setTouched] = useState(false);
  // The notes are edited against the version as it was loaded (T162): a background refresh neither
  // overwrites the typing nor moves If-Match; untouched notes follow the latest saved version.
  const notes = useEditBase(version, {
    clean: !touched,
    onReload: (x) => {
      setNote(x.note ?? '');
      setFixes(x.fixesClaimed ?? '');
      setTouched(false);
    },
  });
  const notesStart = notes.start ?? version;
  useEffect(() => {
    setNote(version.note ?? '');
    setFixes(version.fixesClaimed ?? '');
    setTouched(false);
  }, [version.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const saveChecklist = async (items: { label: string; done: boolean; mandatory: boolean }[]) => {
    try {
      const saved = await update.run({ params, body: { checklist: items } }, { ifMatch: version.rowVersion });
      // Our own checklist change directly on top of the notes' base: the notes stay current.
      if (saved.rowVersion === (notes.version ?? 0) + 1) notes.rebase(saved);
    } catch (e) {
      toast.error(
        isApiError(e)
          ? e.code === 'VERSION_CONFLICT'
            ? 'The version changed. It was reloaded; try again.'
            : (e.fieldErrors[0]?.message ?? e.message)
          : 'The checklist was not saved.',
      );
    }
  };
  const slotRows = [
    ...version.deliverableSlots,
    ...version.files
      .filter((f) => !version.deliverableSlots.some((s) => s.slot === f.slot))
      .map((f) => ({ slot: f.slot, required: false, filled: true })),
  ].filter((s, i, arr) => arr.findIndex((x) => x.slot === s.slot) === i);
  const checklist = version.checklist.map(({ label: l, done, mandatory }) => ({ label: l, done, mandatory }));
  const canSubmit = version.permissions.submit;
  return (
    <div className="flex flex-col gap-4">
      <Panel
        title="Deliverables"
        description="Required slots must have a file, and every file must be Available before the version can be submitted."
        actions={
          version.permissions.upload ? (
            <Button size="sm" icon={<FolderOpen size={14} />} onClick={() => setLibraryOpen(true)}>
              Use Library File
            </Button>
          ) : undefined
        }
      >
        <ul className="flex flex-col divide-y divide-line">
          {slotRows.map((s) => {
            const files = version.files.filter((f) => f.slot === s.slot);
            const multi = ['image_set', 'other', 'document', 'subtitles'].includes(s.slot);
            return (
              <li key={s.slot} className="flex flex-col gap-2 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[14px] font-semibold text-fg">{label('contentSlot', s.slot)}</span>
                  {s.required ? (
                    <Badge tone={files.length ? 'success' : 'warning'}>
                      {files.length ? 'Required · added' : 'Required'}
                    </Badge>
                  ) : (
                    <Badge>Optional</Badge>
                  )}
                </div>
                {files.map((f) => (
                  <div
                    key={f.id}
                    className="flex flex-wrap items-center gap-3 rounded-[8px] border border-line p-2"
                  >
                    {f.thumbnailUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={f.thumbnailUrl}
                        alt=""
                        width={64}
                        height={40}
                        className="h-10 w-16 rounded-[6px] object-cover"
                        loading="lazy"
                      />
                    ) : null}
                    <span className="min-w-0 flex-1 truncate text-[13px]">
                      {f.fileName} <span className="text-fg-2">· {formatBytes(f.byteSize)}</span>
                    </span>
                    <StatusBadge status={f.status} />
                    {PENDING.includes(f.status) ? (
                      <span className="text-[12px] text-fg-2">
                        Your file is being checked and prepared for preview.
                      </span>
                    ) : null}
                    {version.permissions.upload ? (
                      <IconButton
                        label={`Remove ${f.fileName} from this version`}
                        icon={<Trash size={16} />}
                        onClick={() => void remove.run({ params: { ...params, fileId: f.id }, body: {} })}
                      />
                    ) : null}
                  </div>
                ))}
                {version.permissions.upload ? (
                  <SlotUploader
                    content={content}
                    version={version}
                    slot={s.slot}
                    multiple={multi}
                    replace={!multi && files.length > 0}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      </Panel>
      <Panel title="Checklist" description="Mandatory items must be done before submitting.">
        <ul className="flex flex-col gap-2">
          {version.checklist.map((i, idx) => (
            <li key={i.label} className="flex items-start justify-between gap-2">
              <Checkbox
                checked={i.done}
                disabled={!version.permissions.edit || update.isPending}
                onCheckedChange={(v) =>
                  void saveChecklist(checklist.map((c, j) => (j === idx ? { ...c, done: v } : c)))
                }
                label={i.label}
                description={i.mandatory ? 'Mandatory' : 'Optional'}
              />
              {!i.fromTemplate && version.permissions.edit ? (
                <IconButton
                  label={`Remove checklist item ${i.label}`}
                  icon={<Trash size={14} />}
                  onClick={() => void saveChecklist(checklist.filter((_, j) => j !== idx))}
                />
              ) : null}
            </li>
          ))}
        </ul>
        {version.permissions.edit ? (
          <form
            className="mt-3 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (newItem.trim().length < 2) return;
              void saveChecklist([
                ...checklist,
                { label: newItem.trim(), done: false, mandatory: false },
              ]).then(() => setNewItem(''));
            }}
          >
            <Input
              value={newItem}
              onChange={(e) => setNewItem(e.target.value)}
              placeholder="Add an optional check"
              aria-label="New checklist item"
              maxLength={200}
            />
            <Button type="submit" icon={<Plus size={14} />} disabled={newItem.trim().length < 2}>
              Add
            </Button>
          </form>
        ) : null}
      </Panel>
      {version.permissions.edit ? (
        <Panel title="Notes for the reviewer">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field label="Version note">
              <Input
                value={note}
                onChange={(e) => {
                  setNote(e.target.value);
                  setTouched(true);
                }}
                maxLength={2000}
              />
            </Field>
            <Field label="Fixes made">
              <Textarea
                value={fixes}
                onChange={(e) => {
                  setFixes(e.target.value);
                  setTouched(true);
                }}
                maxLength={LIMITS.noteMax}
                className="min-h-[40px]"
              />
            </Field>
          </div>
          <div className="mt-3 flex justify-end">
            <Button
              size="sm"
              disabled={note === (notesStart.note ?? '') && fixes === (notesStart.fixesClaimed ?? '')}
              loading={update.isPending}
              onClick={() => {
                const body = { note: note.trim() || null, fixesClaimed: fixes.trim() || null };
                const before = { note: notesStart.note?.trim() || null, fixesClaimed: notesStart.fixesClaimed?.trim() || null };
                void update
                  .run({ params, body: pickChanged(body, changedFields(before, body)) }, { ifMatch: notes.version })
                  .then((saved) => {
                    notes.rebase(saved);
                    setTouched(false);
                    toast.success('Notes saved');
                  })
                  .catch((e) => {
                    if (!notes.catchConflict(e)) toast.error(isApiError(e) ? e.message : 'The notes were not saved.');
                  });
              }}
            >
              Save Notes
            </Button>
          </div>
          <ConflictDialog {...notes.conflictDialog} />
        </Panel>
      ) : null}
      <div className="flex flex-col gap-2 rounded-[12px] border border-line bg-surface p-4">
        {version.submitMissing.length ? (
          <>
            <p className="flex items-center gap-2 text-[14px] font-semibold text-fg">
              <WarningCircle size={16} className="text-warning" aria-hidden /> Before submitting
            </p>
            <ul className="list-disc pl-6 text-[13px] text-fg-2">
              {version.submitMissing.map((m, i) => (
                <li key={`${m.code}-${i}`}>{m.message}</li>
              ))}
            </ul>
          </>
        ) : (
          <p className="flex items-center gap-2 text-[14px] text-fg">
            <CheckCircle size={16} className="text-primary" aria-hidden /> Ready to submit.
          </p>
        )}
        {!['production', 'changes_requested'].includes(content.stage) ? (
          <p className="text-[13px] text-fg-2">Move the content to Production to submit this version.</p>
        ) : null}
        {canSubmit ? (
          <div className="flex justify-end">
            <Button
              variant="primary"
              icon={<PaperPlaneTilt size={14} />}
              disabled={version.submitMissing.length > 0}
              onClick={() => setSubmitOpen(true)}
            >
              Submit for Review
            </Button>
          </div>
        ) : null}
      </div>
      <SubmitDialog open={submitOpen} onOpenChange={setSubmitOpen} content={content} version={version} />
      <LibraryFileDialog
        open={libraryOpen}
        onOpenChange={setLibraryOpen}
        content={content}
        version={version}
        slots={slotRows.map((s) => s.slot)}
      />
    </div>
  );
};

const SubmittedVersion = ({
  content,
  version,
}: {
  content: ContentDetail;
  version: ContentVersionDetail;
}) => {
  const wsPath = useWsPath();
  const { user } = useWorkspace();
  const [fileId, setFileId] = useState<string | null>(version.files[0]?.assetVersionId ?? null);
  const [draft, setDraft] = useState<AnnotationDraft>({ file: null, point: null, placing: false });
  const [active, setActive] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(true);
  const viewer = useRef<ViewerHandle>(null);
  const comments = useVersionComments(version.id);
  const file = version.files.find((f) => f.assetVersionId === fileId) ?? version.files[0] ?? null;
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
      <div className="flex min-w-0 flex-col gap-3 xl:col-span-2">
        {version.files.length > 1 ? (
          <div className="flex flex-wrap gap-1" role="group" aria-label="Files of this version">
            {version.files.map((f) => (
              <Button
                key={f.id}
                size="sm"
                variant={file?.id === f.id ? 'secondary' : 'ghost'}
                aria-pressed={file?.id === f.id}
                onClick={() => setFileId(f.assetVersionId)}
              >
                {label('contentSlot', f.slot)}
                {f.position ? ` ${f.position + 1}` : ''}
              </Button>
            ))}
          </div>
        ) : null}
        {file ? (
          <>
            <FileViewer
              ref={viewer}
              file={file}
              markers={markersFor(comments.numbered, file.assetVersionId)}
              activeMarkerId={active}
              onSelectMarker={setActive}
              placing={draft.placing && draft.file?.assetVersionId === file.assetVersionId}
              pendingPoint={draft.file?.assetVersionId === file.assetVersionId ? draft.point : null}
              onPlacePoint={(p) => setDraft({ ...draft, point: p, placing: false })}
              caption={`${content.title} version ${version.versionNo}, ${label('contentSlot', file.slot)}`}
            />
            <FileMeta file={file} />
          </>
        ) : (
          <EmptyState
            title="No files"
            description={
              content.format === 'text_post'
                ? 'This text post was submitted with its caption draft.'
                : 'This version has no files.'
            }
          />
        )}
        {version.briefSnapshot ? (
          <Panel
            title="Brief at submission"
            description="Frozen with the version; later brief edits do not change it."
          >
            <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {CONTENT_BRIEF_FIELDS.filter((f) => version.briefSnapshot?.[f.key]).map((f) => (
                <div key={f.key} className={f.long ? 'sm:col-span-2' : undefined}>
                  <dt className="text-[12px] font-[550] text-fg-2">{f.label}</dt>
                  <dd className="whitespace-pre-wrap text-[14px] text-fg">
                    {version.briefSnapshot?.[f.key]}
                  </dd>
                </div>
              ))}
            </dl>
          </Panel>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-col gap-3">
        <Panel title="Reviews">
          {version.reviews.length === 0 ? (
            <p className="text-[14px] text-fg-2">No review yet.</p>
          ) : (
            <ol className="flex flex-col gap-2">
              {version.reviews.map((r) => (
                <li
                  key={r.id}
                  className="flex flex-col gap-1 rounded-[8px] border border-line p-2 text-[13px]"
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">Round {r.roundNo}</span>
                    <Badge>{label('reviewStep', r.stepKind)}</Badge>
                    <StatusBadge status={r.status} label={label('reviewStatus', r.status)} />
                  </span>
                  {r.decision ? (
                    <span className="text-fg-2">
                      {label('reviewDecision', r.decision.kind)} by{' '}
                      {r.decision.by?.displayName ?? 'a reviewer'} ·{' '}
                      {formatDateTime(r.decision.at, user.timezone)}
                      {r.decision.summary ? ` — ${r.decision.summary}` : ''}
                    </span>
                  ) : null}
                  <Link
                    href={wsPath(`/reviews/${r.id}`)}
                    className="text-[13px] font-medium text-fg underline-offset-2 hover:underline"
                  >
                    {r.status === 'pending' ? 'Open Review' : 'View Review'}
                  </Link>
                </li>
              ))}
            </ol>
          )}
          {version.approvalRevokedAt ? (
            <Banner tone="danger">
              Approval revoked {formatDateTime(version.approvalRevokedAt, user.timezone)}:{' '}
              {version.approvalRevokedReason}
            </Banner>
          ) : null}
        </Panel>
        {!content.archivedAt ? (
          <VersionCommentComposer
            versionId={version.id}
            files={version.files}
            selectedFile={file}
            draft={draft}
            onDraftChange={setDraft}
            currentTimeMs={() => viewer.current?.currentTimeMs() ?? null}
            onCreated={(c) => setActive(c.id)}
          />
        ) : null}
        <VersionComments
          versionId={version.id}
          files={version.files}
          data={comments}
          activeId={active}
          showResolved={showResolved}
          onShowResolvedChange={setShowResolved}
          onSelect={(t) => {
            if (t.assetVersionId) setFileId(t.assetVersionId);
            setActive(t.id);
            if (t.timecodeMs !== null) viewer.current?.seek(t.timecodeMs);
          }}
        />
      </div>
    </div>
  );
};

/** S24 Versions tab: version strip (Latest and Approved pointers), the selected version, its files, checklist, reviews and comments. */
export const VersionsTab = ({ content }: { content: ContentDetail }) => {
  const { workspace, user } = useWorkspace();
  const { state, set } = useUrlState<'version'>();
  const [newOpen, setNewOpen] = useState(false);
  const versions = useApiQuery(contentVersionEndpoints.list, {
    params: { workspaceId: workspace.id, contentId: content.id },
  });
  const list = versions.data ?? [];
  const selectedId =
    state.version && list.some((v) => v.id === state.version)
      ? state.version
      : (content.draftVersion?.id ?? content.currentVersion?.id ?? list[0]?.id ?? null);
  const detail = useApiQuery(
    contentVersionEndpoints.get,
    { params: { workspaceId: workspace.id, contentId: content.id, versionId: selectedId ?? '' } },
    {
      enabled: !!selectedId,
      refetchInterval: (q) => (q.state.data?.files.some((f) => PENDING.includes(f.status)) ? 4000 : false),
    },
  );
  const canStart =
    content.permissions.upload &&
    !content.draftVersion &&
    ['ready', 'production', 'changes_requested', 'review'].includes(content.stage);
  const v = detail.data;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <QueryState query={versions} skeleton={<div className="h-20" />}>
          {list.length ? (
            <VersionStrip versions={list} selectedId={selectedId} onSelect={(id) => set({ version: id })} />
          ) : (
            <p className="text-[14px] text-fg-2">No versions yet.</p>
          )}
        </QueryState>
        {canStart ? (
          <Button variant="primary" icon={<Plus size={14} />} onClick={() => setNewOpen(true)}>
            Upload Version
          </Button>
        ) : null}
      </div>
      {content.stage === 'approved' && content.permissions.upload ? (
        <Banner tone="info">
          This content is approved. Start a New Revision (More → Start New Revision) to upload a new version;
          the approved version stays pinned for existing placements.
        </Banner>
      ) : null}
      {list.length === 0 && !versions.isLoading ? (
        <EmptyState
          icon={<Plus size={24} />}
          title="No versions yet"
          description={
            ['idea', 'brief'].includes(content.stage)
              ? 'Versions are uploaded once the content is Ready or in Production.'
              : 'Upload the first version to start the review cycle.'
          }
          action={
            canStart ? (
              <Button variant="primary" onClick={() => setNewOpen(true)}>
                Upload Version
              </Button>
            ) : undefined
          }
        />
      ) : selectedId ? (
        <QueryState query={detail}>
          {v ? (
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-[18px] font-semibold text-fg">Version {v.versionNo}</h2>
                <StatusBadge
                  status={v.state === 'submitted' ? 'review' : v.state}
                  label={label('versionState', v.state)}
                />
                {v.isLatest ? <Badge>Latest</Badge> : null}
                {v.isApproved ? <StatusBadge status="approved" label="Approved version" /> : null}
                {v.submittedAt ? (
                  <span className="text-[13px] text-fg-2">
                    Submitted {formatDateTime(v.submittedAt, user.timezone)}
                    {v.submittedBy ? ` by ${v.submittedBy.displayName}` : ''}
                  </span>
                ) : null}
              </div>
              {v.note || v.fixesClaimed ? (
                <div className="flex flex-col gap-1 text-[14px]">
                  {v.note ? <p>{v.note}</p> : null}
                  {v.fixesClaimed ? <p className="text-fg-2">Fixes made: {v.fixesClaimed}</p> : null}
                </div>
              ) : null}
              {v.state === 'draft' ? (
                <DraftVersion content={content} version={v} />
              ) : (
                <SubmittedVersion content={content} version={v} />
              )}
            </div>
          ) : null}
        </QueryState>
      ) : null}
      <NewVersionDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        content={content}
        versions={list}
        onCreated={(id) => set({ version: id })}
      />
    </div>
  );
};
