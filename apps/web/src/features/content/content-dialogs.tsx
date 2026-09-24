'use client';
import { DownloadSimple, FileZip } from '@phosphor-icons/react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  contentEndpoints,
  contentVersionEndpoints,
  exportEndpoints,
  templateEndpoints,
  type ContentDetail,
  type ContentTemplatePreview,
} from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { LIMITS } from '@castlane/domain';
import {
  Badge,
  Banner,
  Button,
  Checkbox,
  DateInput,
  Dialog,
  Field,
  Input,
  StatusBadge,
  Textarea,
  formatBytes,
  formatDate,
  formatDateTime,
  toast,
} from '@castlane/ui';
import { EntitySelect } from '@/components/common/entity-select';
import { QueryState } from '@/components/common/query-state';
import { api } from '@/lib/api';
import { useApiMutation, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useWorkspace, useWsPath } from '@/lib/workspace-context';
import { useFileActions } from './media-viewer';

const INVALIDATE = ['content.', 'tasks.', 'myWork.'];

/**
 * Apply Template (S23/S24): preview the dated task graph and the diff against earlier template
 * tasks — started and completed tasks are always kept, not-started ones may be cancelled (T037).
 */
export const ApplyTemplateDialog = ({
  open,
  onOpenChange,
  content,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  content: ContentDetail;
}) => {
  const { workspace, user } = useWorkspace();
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [startDate, setStartDate] = useState(new Date().toISOString().slice(0, 10));
  const [preview, setPreview] = useState<ContentTemplatePreview | null>(null);
  const [cancel, setCancel] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const apply = useApiMutation(contentEndpoints.applyTemplate, {
    invalidate: INVALIDATE,
    silentErrors: true,
  });
  const reset = () => {
    setPreview(null);
    setCancel(new Set());
    setError(null);
  };
  const runPreview = async () => {
    setError(null);
    setLoading(true);
    try {
      const t = await api.call(templateEndpoints.get, {
        params: { workspaceId: workspace.id, templateId: templateId! },
      });
      if (!t.published) throw new Error('This template has no published version.');
      setPreview(
        await api.call(contentEndpoints.templatePreview, {
          params: { workspaceId: workspace.id, contentId: content.id },
          body: { templateVersionId: t.published.id, startDate },
        }),
      );
    } catch (e) {
      setError(isApiError(e) ? (e.fieldErrors[0]?.message ?? e.message) : (e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
      title="Apply Template"
      description="Review the tasks before anything is created. Completed tasks are never overwritten."
      size="wide"
      footer={
        preview ? (
          <>
            <Button onClick={reset}>Back</Button>
            <Button
              variant="primary"
              loading={apply.isPending}
              disabled={preview.alreadyApplied && cancel.size === 0}
              onClick={async () => {
                setError(null);
                try {
                  const r = await apply.run(
                    {
                      params: { workspaceId: workspace.id, contentId: content.id },
                      body: {
                        templateVersionId: preview.template.templateVersionId,
                        previewToken: preview.previewToken,
                        startDate,
                        cancelTaskIds: [...cancel],
                      },
                    },
                    { ifMatch: content.rowVersion },
                  );
                  onOpenChange(false);
                  reset();
                  toast.success(
                    r.created
                      ? `${r.taskIds.length} task${r.taskIds.length === 1 ? '' : 's'} created`
                      : 'This template was already applied; no tasks were duplicated.',
                  );
                } catch (e) {
                  setError(isApiError(e) ? e.message : 'The template could not be applied.');
                }
              }}
            >
              {preview.alreadyApplied ? 'Apply Changes' : 'Create Tasks'}
            </Button>
          </>
        ) : (
          <>
            <Button onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!templateId}
              loading={loading}
              onClick={() => void runPreview()}
            >
              Preview Generated Tasks
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        {!preview ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label="Template" required>
              <EntitySelect
                type="template"
                value={templateId}
                onChange={setTemplateId}
                filters={{ status: ['content', 'task'] }}
              />
            </Field>
            <Field label="Start Date" helper="Relative task dates count from this day.">
              <DateInput value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </Field>
          </div>
        ) : (
          <>
            <p className="text-[14px]">
              {preview.template.name} v{preview.template.versionNo}
              {preview.alreadyApplied ? <Badge className="ml-2">Already applied — no new tasks</Badge> : null}
            </p>
            {preview.add.length ? (
              <section aria-label="Tasks to add" className="flex flex-col gap-2">
                <h3 className="text-[14px] font-semibold">Add ({preview.add.length})</h3>
                <div className="overflow-x-auto rounded-[8px] border border-line">
                  <table className="w-full min-w-[560px] text-[13px]">
                    <thead className="bg-surface-2 text-left text-fg-2">
                      <tr>
                        <th className="px-3 py-2 font-[550]">Task</th>
                        <th className="px-3 py-2 font-[550]">Start</th>
                        <th className="px-3 py-2 font-[550]">Due</th>
                        <th className="px-3 py-2 font-[550]">Assignee</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {preview.add.map((t) => (
                        <tr key={t.key}>
                          <td className="px-3 py-2">{t.title}</td>
                          <td className="px-3 py-2">{formatDate(t.startDate, user.timezone)}</td>
                          <td className="px-3 py-2">{formatDate(t.dueDate, user.timezone)}</td>
                          <td className="px-3 py-2">
                            {t.assignee?.displayName ?? <span className="text-fg-muted">Unassigned</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {preview.unassignedCount ? (
                  <p className="text-[12px] text-fg-2">
                    Unassigned tasks stay unassigned; a coordination task asks you to assign them. Nobody is
                    picked automatically.
                  </p>
                ) : null}
              </section>
            ) : null}
            {preview.keep.length ? (
              <section aria-label="Kept tasks" className="flex flex-col gap-2">
                <h3 className="text-[14px] font-semibold">
                  Keep — started or completed ({preview.keep.length})
                </h3>
                <ul className="flex flex-col gap-1 text-[13px]">
                  {preview.keep.map((t) => (
                    <li key={t.taskId} className="flex items-center gap-2">
                      <StatusBadge status={t.status} label={label('taskStatus', t.status)} /> {t.title}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {preview.cancelable.length ? (
              <section aria-label="Not started tasks" className="flex flex-col gap-2">
                <h3 className="text-[14px] font-semibold">
                  Not started — keep or cancel ({preview.cancelable.length})
                </h3>
                <ul className="flex flex-col gap-2">
                  {preview.cancelable.map((t) => (
                    <li key={t.taskId}>
                      <Checkbox
                        checked={cancel.has(t.taskId)}
                        onCheckedChange={(v) =>
                          setCancel((s) => {
                            const n = new Set(s);
                            if (v) n.add(t.taskId);
                            else n.delete(t.taskId);
                            return n;
                          })
                        }
                        label={`Cancel “${t.title}”`}
                        description={t.templateName ? `From ${t.templateName}` : undefined}
                      />
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            <p className="text-[12px] text-fg-2">
              Deliverables from now on:{' '}
              {preview.deliverableSlots
                .map((s) => `${label('contentSlot', s.slot)}${s.required ? ' (required)' : ''}`)
                .join(', ')}
              . Checklist: {preview.checklist.length} item(s).
            </p>
          </>
        )}
      </div>
    </Dialog>
  );
};

/** Duplicate as New Draft (F11): new Idea with chosen fields and attachments; nothing historical is copied. */
export const DuplicateDialog = ({
  open,
  onOpenChange,
  content,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  content: ContentDetail;
}) => {
  const { workspace } = useWorkspace();
  const wsPath = useWsPath();
  const router = useRouter();
  const [title, setTitle] = useState(`${content.title} (copy)`.slice(0, 200));
  const [projectId, setProjectId] = useState<string | null>(content.project.id);
  const [fields, setFields] = useState<Set<string>>(new Set(['brief', 'references', 'tags', 'language']));
  const [files, setFiles] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const sourceVersion = content.approvedVersion?.id ?? content.currentVersion?.id ?? null;
  const version = useApiQuery(
    contentVersionEndpoints.get,
    { params: { workspaceId: workspace.id, contentId: content.id, versionId: sourceVersion ?? '' } },
    { enabled: open && !!sourceVersion },
  );
  const dup = useApiMutation(contentEndpoints.duplicate, {
    invalidate: ['content.'],
    silentErrors: true,
    successMessage: 'New draft created',
  });
  const same = projectId === content.project.id;
  const OPTIONS = [
    { key: 'brief', label: 'Brief' },
    { key: 'references', label: 'References' },
    { key: 'tags', label: 'Tags' },
    { key: 'language', label: 'Language' },
    { key: 'characters', label: 'Characters and versions', sameOnly: true },
    { key: 'account', label: 'Planned account', sameOnly: true },
    { key: 'episode', label: 'Episode', sameOnly: true },
  ];
  const toggle = (set: Set<string>, key: string, on: boolean) => {
    const n = new Set(set);
    if (on) n.add(key);
    else n.delete(key);
    return n;
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Duplicate as New Draft"
      description="The copy starts as a new Idea with a link to this content. Views, publications, payouts, approvals and versions are not copied."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!projectId || title.trim().length < LIMITS.taskTitleMin}
            loading={dup.isPending}
            onClick={async () => {
              setError(null);
              try {
                const r = await dup.run({
                  params: { workspaceId: workspace.id, contentId: content.id },
                  body: {
                    targetProjectId: projectId!,
                    title: title.trim(),
                    copiedFieldSet: [...fields].filter(
                      (f) => same || !OPTIONS.find((o) => o.key === f)?.sameOnly,
                    ) as never,
                    attachmentAssetVersionIds: [...files],
                  },
                });
                onOpenChange(false);
                router.push(wsPath(`/content/${r.id}`));
              } catch (e) {
                setError(
                  isApiError(e)
                    ? (e.fieldErrors[0]?.message ?? e.message)
                    : 'The draft could not be created.',
                );
              }
            }}
          >
            Create Draft
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <Field label="Title" required>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={LIMITS.taskTitleMax} />
        </Field>
        <Field label="Project" required>
          <EntitySelect type="project" value={projectId} onChange={setProjectId} />
        </Field>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-[12px] font-[550] text-fg">Copy</legend>
          {OPTIONS.map((o) => (
            <Checkbox
              key={o.key}
              checked={fields.has(o.key) && (same || !o.sameOnly)}
              disabled={!same && o.sameOnly}
              onCheckedChange={(v) => setFields((s) => toggle(s, o.key, v))}
              label={o.label}
              description={!same && o.sameOnly ? 'Only within the same project.' : undefined}
            />
          ))}
        </fieldset>
        {sourceVersion ? (
          <QueryState query={version}>
            {version.data?.files.length ? (
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 text-[12px] font-[550] text-fg">
                  Attach files from version {version.data.versionNo}
                </legend>
                {version.data.files.map((f) => (
                  <Checkbox
                    key={f.id}
                    checked={files.has(f.assetVersionId)}
                    onCheckedChange={(v) => setFiles((s) => toggle(s, f.assetVersionId, v))}
                    label={`${label('contentSlot', f.slot)} · ${f.fileName}`}
                    description={formatBytes(f.byteSize)}
                  />
                ))}
              </fieldset>
            ) : null}
          </QueryState>
        ) : null}
      </div>
    </Dialog>
  );
};

/** Block / Pause (independent flags with reason) and their clearing with a resolution. */
export const FlagDialog = ({
  open,
  onOpenChange,
  content,
  flag,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  content: ContentDetail;
  flag: 'blocked' | 'paused';
}) => {
  const { workspace } = useWorkspace();
  const on = flag === 'blocked' ? !content.blocked : !content.paused;
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const set = useApiMutation(contentEndpoints.setFlag, {
    invalidate: ['content.'],
    silentErrors: true,
    successMessage: on
      ? flag === 'blocked'
        ? 'Content blocked'
        : 'Content paused'
      : flag === 'blocked'
        ? 'Content unblocked'
        : 'Content resumed',
  });
  const title = on
    ? flag === 'blocked'
      ? 'Mark as Blocked'
      : 'Pause Content'
    : flag === 'blocked'
      ? 'Unblock'
      : 'Resume';
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setText('');
          setError(null);
        }
        onOpenChange(o);
      }}
      title={title}
      description={
        on
          ? 'The stage stays as it is; the flag, its reason and duration are recorded.'
          : 'The flag interval is closed and kept in the history.'
      }
      size="small"
      dirty={!!text}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={on && text.trim().length < 3}
            loading={set.isPending}
            onClick={async () => {
              setError(null);
              try {
                await set.run(
                  {
                    params: { workspaceId: workspace.id, contentId: content.id },
                    body: {
                      flag,
                      on,
                      ...(on ? { reason: text.trim() } : { resolution: text.trim() || undefined }),
                    },
                  },
                  { ifMatch: content.rowVersion },
                );
                setText('');
                onOpenChange(false);
              } catch (e) {
                setError(
                  isApiError(e) ? (e.fieldErrors[0]?.message ?? e.message) : 'The change was not saved.',
                );
              }
            }}
          >
            {title}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <Field label={on ? 'Reason' : 'Resolution (optional)'} required={on}>
          <Textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={LIMITS.reasonMax} />
        </Field>
      </div>
    </Dialog>
  );
};

/**
 * Download Approved (S24): the approved originals one by one, or the ZIP content package
 * (manifest.json, files, subtitles, metadata) generated in the background with a 7-day file.
 */
export const DownloadApprovedDialog = ({
  open,
  onOpenChange,
  content,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  content: ContentDetail;
}) => {
  const { workspace, user } = useWorkspace();
  const wsPath = useWsPath();
  const actions = useFileActions();
  const approvedId = content.approvedVersion?.id ?? '';
  const version = useApiQuery(
    contentVersionEndpoints.get,
    { params: { workspaceId: workspace.id, contentId: content.id, versionId: approvedId } },
    { enabled: open && !!approvedId },
  );
  const packages = useApiQuery(
    contentEndpoints.packages,
    { params: { workspaceId: workspace.id, contentId: content.id } },
    {
      enabled: open && content.permissions.exportPackage,
      refetchInterval: (q) =>
        q.state.data?.some((p) => p.state === 'queued' || p.state === 'running') ? 3000 : false,
    },
  );
  const request = useApiMutation(contentEndpoints.requestPackage, {
    invalidate: ['content.packages', 'exports.'],
    silentErrors: true,
    successMessage: 'Package requested. It appears here when the file is ready.',
  });
  const [error, setError] = useState<string | null>(null);
  const download = async (exportId: string) => {
    try {
      const r = await api.call(exportEndpoints.download, { params: { workspaceId: workspace.id, exportId } });
      window.location.assign(r.url);
    } catch (e) {
      setError(isApiError(e) ? e.message : 'The download could not be started.');
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Download Approved — v${content.approvedVersion?.versionNo ?? ''}`}
      description="Approved originals exactly as stored. Downloading does not publish anything."
      size="regular"
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <QueryState query={version}>
          <ul className="flex flex-col divide-y divide-line rounded-[8px] border border-line">
            {(version.data?.files ?? []).map((f) => (
              <li
                key={f.id}
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-[13px]"
              >
                <span className="min-w-0 flex-1 truncate">
                  {label('contentSlot', f.slot)} · {f.fileName}{' '}
                  <span className="text-fg-2">· {formatBytes(f.byteSize)}</span>
                </span>
                {f.canDownload ? (
                  <Button
                    size="sm"
                    icon={<DownloadSimple size={14} />}
                    onClick={() => void actions.download(f)}
                  >
                    Download
                  </Button>
                ) : (
                  <span className="text-fg-2">No download access</span>
                )}
              </li>
            ))}
          </ul>
        </QueryState>
        {content.permissions.exportPackage ? (
          <section aria-label="Content package" className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-[14px] font-semibold">ZIP package</h3>
              <Button
                icon={<FileZip size={14} />}
                loading={request.isPending}
                onClick={async () => {
                  setError(null);
                  try {
                    await request.run({
                      params: { workspaceId: workspace.id, contentId: content.id },
                      body: {},
                    });
                  } catch (e) {
                    setError(isApiError(e) ? e.message : 'The package could not be requested.');
                  }
                }}
              >
                Export Package
              </Button>
            </div>
            <p className="text-[12px] text-fg-2">
              manifest.json, the approved files, subtitles and metadata. Files are kept for 7 days; access is
              checked again at download.
            </p>
            {(packages.data ?? []).map((p) => (
              <div
                key={p.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-[8px] border border-line px-3 py-2 text-[13px]"
              >
                <span>
                  {formatDateTime(p.createdAt, user.timezone)} <StatusBadge status={p.state} />
                  {p.state === 'running' ? ` ${p.progress}%` : ''}
                  {p.errorMessage ? <span className="ml-2 text-danger">{p.errorMessage}</span> : null}
                </span>
                {p.permissions.download ? (
                  <Button size="sm" icon={<DownloadSimple size={14} />} onClick={() => void download(p.id)}>
                    Download ZIP
                  </Button>
                ) : null}
              </div>
            ))}
            <a href={wsPath('/exports')} className="text-[13px] text-fg underline-offset-2 hover:underline">
              All exports
            </a>
          </section>
        ) : null}
      </div>
    </Dialog>
  );
};
