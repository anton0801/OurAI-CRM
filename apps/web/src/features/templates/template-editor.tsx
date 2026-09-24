'use client';
import { ArrowLeft, Eye } from '@phosphor-icons/react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { templateEndpoints, type TemplateConfigInput, type TemplateDetail, type TemplatePreview } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { localDate } from '@castlane/domain';
import {
  Badge,
  Banner,
  Button,
  DataTable,
  DateInput,
  Dialog,
  Field,
  Input,
  Menu,
  PageHeader,
  Panel,
  Select,
  StatusBadge,
  Textarea,
  formatDate,
  formatDateTime,
  formatDuration,
  type Column,
} from '@castlane/ui';
import { ConflictDialog } from '@/components/common/conflict';
import { changedFields, pickChanged, useEditBase } from '@/lib/edit-base';
import { MemberSelect } from '@/components/common/pickers';
import { QueryState } from '@/components/common/query-state';
import { useApiMutation, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUnsavedChangesGuard } from '@/lib/unsaved';
import { useWorkspace, useWsPath } from '@/lib/workspace-context';
import { TemplateConfigEditor } from './config-editors';

const INVALIDATE = ['templates.get', 'templates.list'];
const statusTone = (s: string) => (s === 'published' ? 'active' : s === 'disabled' ? 'archived' : 'draft');

/** Strip empty optional values so the draft compares and saves cleanly. */
const normalize = (c: TemplateConfigInput): TemplateConfigInput => JSON.parse(JSON.stringify(c)) as TemplateConfigInput;

/** Template detail: edit the draft (versions are immutable once published), publish, preview application. */
export const TemplateEditor = ({ templateId }: { templateId: string }) => {
  const { workspace } = useWorkspace();
  const wsPath = useWsPath();
  const params = { workspaceId: workspace.id, templateId };
  const q = useApiQuery(templateEndpoints.get, { params });
  const t = q.data;
  return (
    <div className="flex flex-col gap-5">
      <Link href={wsPath('/settings/templates')} className="inline-flex w-fit items-center gap-1 text-[13px] text-fg-2 hover:text-fg">
        <ArrowLeft size={14} aria-hidden /> All templates
      </Link>
      <QueryState query={q}>{t ? <EditorBody key={`${t.id}:${t.draft?.id ?? 'none'}`} t={t} /> : null}</QueryState>
    </div>
  );
};

const EditorBody = ({ t }: { t: TemplateDetail }) => {
  const { workspace, user } = useWorkspace();
  const params = { workspaceId: workspace.id, templateId: t.id };
  const manage = t.permissions.manage;
  const latest = useMemo(() => normalize(t.draft?.config ?? t.published?.config ?? {}), [t]);
  // The draft is edited from `start` (as loaded): a background refresh no longer remounts the editor
  // or moves If-Match; an untouched editor follows the latest saved draft (T162).
  const [start, setStart] = useState<TemplateConfigInput>(latest);
  const [config, setConfig] = useState<TemplateConfigInput>(latest);
  const [errors, setErrors] = useState<{ field: string; message: string }[]>([]);
  const [dialog, setDialog] = useState<null | 'rename' | 'disable' | 'preview'>(null);
  const dirty = !!t.draft && JSON.stringify(normalize(config)) !== JSON.stringify(start);
  const edit = useEditBase(t.draft, {
    clean: !dirty,
    onReload: (d) => {
      const c = normalize(d.config);
      setConfig(c);
      setStart(c);
    },
  });
  useUnsavedChangesGuard(dirty);
  const opts = { invalidate: INVALIDATE, silentErrors: true };
  const save = useApiMutation(templateEndpoints.saveDraft, { ...opts, successMessage: 'Draft saved' });
  const publish = useApiMutation(templateEndpoints.publish, { ...opts, successMessage: 'Template published. New applications use this version.' });
  const newVersion = useApiMutation(templateEndpoints.newVersion, { ...opts, successMessage: 'Draft version created' });
  const enable = useApiMutation(templateEndpoints.enable, { ...opts, successMessage: 'Template enabled' });
  const [error, setError] = useState<string | null>(null);
  const handle = (e: unknown) => {
    if (edit.catchConflict(e)) return;
    if (isApiError(e) && e.fieldErrors.length) {
      setErrors(e.fieldErrors.map((f) => ({ field: f.field.replace(/^body\./, ''), message: f.message })));
      setError(null);
    } else setError(isApiError(e) ? e.message : 'The action failed.');
  };
  const doSave = async () => {
    if (!t.draft) return false;
    setError(null);
    setErrors([]);
    try {
      const r = await save.run({ params: { ...params, versionId: t.draft.id }, body: { config: normalize(config) } }, { ifMatch: edit.version });
      if (r.draft) edit.rebase(r.draft);
      setStart(normalize(config));
      return true;
    } catch (e) {
      handle(e);
      return false;
    }
  };
  const doPublish = async () => {
    if (!t.draft) return;
    setError(null);
    setErrors([]);
    try {
      // Save first (so what is published is what is on screen), then publish with the template's version.
      if (dirty) {
        const r = await save.run({ params: { ...params, versionId: t.draft.id }, body: { config: normalize(config) } }, { ifMatch: edit.version });
        await publish.run({ params, body: { draftVersionId: t.draft.id } }, { ifMatch: r.rowVersion });
      } else await publish.run({ params, body: { draftVersionId: t.draft.id } }, { ifMatch: t.rowVersion });
    } catch (e) {
      handle(e);
    }
  };
  const errorMap = Object.fromEntries(errors.map((e) => [e.field, e.message]));
  const status = t.status;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={t.name}
        crumbs={[{ label: 'Settings' }, { label: 'Templates' }, { label: t.name }]}
        description={t.description ?? undefined}
        meta={
          <>
            <Badge>{label('templateKind', t.kind)}</Badge>
            <StatusBadge status={statusTone(status)} label={label('templateStatus', status)} />
            {t.publishedVersion ? <span className="text-[12px] text-fg-2">Published version {t.publishedVersion.versionNo}</span> : null}
            {t.draft ? <span className="text-[12px] text-fg-2">Editing draft version {t.draft.versionNo}</span> : null}
          </>
        }
        actions={
          <>
            <Button icon={<Eye size={14} />} onClick={() => setDialog('preview')} disabled={!(t.published || t.draft)}>
              Preview Application
            </Button>
            {manage && t.draft ? (
              <>
                <Button onClick={() => void doSave()} loading={save.isPending && !publish.isPending} disabled={!dirty}>
                  Save Draft
                </Button>
                <Button variant="primary" onClick={() => void doPublish()} loading={publish.isPending}>
                  Publish
                </Button>
              </>
            ) : null}
            {manage && !t.draft ? (
              <Button variant="primary" loading={newVersion.isPending} onClick={() => void newVersion.run({ params, body: {} }).catch(handle)}>
                New Version
              </Button>
            ) : null}
            {manage ? (
              <Menu
                label="More template actions"
                trigger={<Button variant="ghost">More</Button>}
                items={[
                  { label: 'Rename', onSelect: () => setDialog('rename') },
                  { label: 'Disable Template', destructive: true, hidden: !!t.disabledAt, onSelect: () => setDialog('disable') },
                  { label: 'Enable Template', hidden: !t.disabledAt, onSelect: () => void enable.run({ params }, { ifMatch: t.rowVersion }).catch(handle) },
                ]}
              />
            ) : null}
          </>
        }
      />
      {t.disabledAt ? <Banner tone="warning">Disabled {formatDateTime(t.disabledAt, user.timezone)}. It cannot be applied to new work; records already created from it are unchanged.</Banner> : null}
      {error ? <Banner tone="danger">{error}</Banner> : null}
      {errors.length ? (
        <Banner tone="danger">
          Fix these before publishing:
          <ul className="mt-1 list-disc pl-5">
            {errors.map((e, i) => (
              <li key={i}>{e.message}</li>
            ))}
          </ul>
        </Banner>
      ) : null}
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1fr_300px]">
        <Panel
          title={t.draft ? `Draft version ${t.draft.versionNo}` : t.published ? `Published version ${t.published.versionNo}` : 'Configuration'}
          description={t.draft ? 'Changes apply only after you publish. Published versions never change.' : manage ? 'Published versions are read-only. Create a new version to make changes.' : undefined}
        >
          <TemplateConfigEditor kind={t.kind} value={config} onChange={setConfig} readOnly={!manage || !t.draft} errors={errorMap} />
        </Panel>
        <Panel title="Versions">
          <ol className="flex flex-col gap-2">
            {t.versions.map((v) => (
              <li key={v.id} className="flex flex-col gap-0.5 rounded-[8px] border border-line px-3 py-2">
                <span className="flex items-center justify-between gap-2">
                  <span className="text-[13px] font-medium text-fg">Version {v.versionNo}</span>
                  <StatusBadge status={statusTone(v.state)} label={label('templateVersionState', v.state)} />
                </span>
                <span className="text-[12px] text-fg-2">
                  {v.publishedAt ? `Published ${formatDate(v.publishedAt, user.timezone)}` : `Created ${formatDate(v.createdAt, user.timezone)}`}
                  {v.createdBy ? ` by ${v.createdBy}` : ''}
                </span>
                <span className="text-[12px] text-fg-2">
                  Used {v.applications} time{v.applications === 1 ? '' : 's'}
                </span>
              </li>
            ))}
          </ol>
        </Panel>
      </div>
      {dialog === 'rename' ? <RenameDialog t={t} onClose={() => setDialog(null)} /> : null}
      {dialog === 'disable' ? <DisableDialog t={t} onClose={() => setDialog(null)} /> : null}
      {dialog === 'preview' ? <PreviewDialog t={t} onClose={() => setDialog(null)} /> : null}
      <ConflictDialog {...edit.conflictDialog} />
    </div>
  );
};

const RenameDialog = ({ t, onClose }: { t: TemplateDetail; onClose: () => void }) => {
  const { workspace } = useWorkspace();
  const [name, setName] = useState(t.name);
  const [description, setDescription] = useState(t.description ?? '');
  // Renamed against the template as the dialog opened (T162).
  const edit = useEditBase(t, {
    onReload: (x) => {
      setName(x.name);
      setDescription(x.description ?? '');
    },
  });
  const s = edit.start ?? t;
  const update = useApiMutation(templateEndpoints.update, { invalidate: INVALIDATE, successMessage: 'Template updated' });
  return (
    <>
      <Dialog
        open
        onOpenChange={(o) => !o && onClose()}
        title="Rename template"
        dirty={name !== s.name || description !== (s.description ?? '')}
        footer={
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              loading={update.isPending}
              disabled={name.trim().length < 2}
              onClick={() => {
                const body = { name: name.trim(), description: description.trim() || null };
                const before = { name: s.name, description: s.description?.trim() || null };
                void update.run({ params: { workspaceId: workspace.id, templateId: t.id }, body: pickChanged(body, changedFields(before, body)) }, { ifMatch: edit.version }).then(onClose, (e: unknown) => edit.catchConflict(e));
              }}
            >
              Save Changes
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="Name" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
          </Field>
          <Field label="Description">
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={2000} />
          </Field>
        </div>
      </Dialog>
      <ConflictDialog {...edit.conflictDialog} />
    </>
  );
};

const DisableDialog = ({ t, onClose }: { t: TemplateDetail; onClose: () => void }) => {
  const { workspace } = useWorkspace();
  const [reason, setReason] = useState('');
  const edit = useEditBase(t);
  const disable = useApiMutation(templateEndpoints.disable, { invalidate: INVALIDATE, successMessage: 'Template disabled' });
  return (
    <>
      <Dialog
        open
        size="small"
        onOpenChange={(o) => !o && onClose()}
        title="Disable this template?"
        description="It can no longer be applied. Tasks and content already created from it keep their version."
        footer={
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="danger" loading={disable.isPending} onClick={() => void disable.run({ params: { workspaceId: workspace.id, templateId: t.id }, body: { reason: reason.trim() || undefined } }, { ifMatch: edit.version }).then(onClose, (e: unknown) => edit.catchConflict(e))}>
              Disable Template
            </Button>
          </>
        }
      >
        <Field label="Reason">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
        </Field>
      </Dialog>
      <ConflictDialog {...edit.conflictDialog} />
    </>
  );
};

/** Dry run: dated task graph with proposed assignees per role. Creates nothing. */
const PreviewDialog = ({ t, onClose }: { t: TemplateDetail; onClose: () => void }) => {
  const { workspace, user } = useWorkspace();
  const [startDate, setStartDate] = useState(localDate(new Date(), user.timezone));
  const [versionId, setVersionId] = useState<string | undefined>(t.published?.id ?? t.draft?.id);
  const [assignees, setAssignees] = useState<Record<string, string>>({});
  const [result, setResult] = useState<TemplatePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const preview = useApiMutation(templateEndpoints.previewApplication, { silentErrors: true });
  const config = versionId === t.draft?.id ? t.draft?.config : t.published?.config;
  const roles = [...new Set((config?.tasks ?? []).map((n) => n.defaultRoleKey).filter((r): r is string => !!r))];
  const run = async () => {
    setError(null);
    try {
      setResult(await preview.run({ params: { workspaceId: workspace.id, templateId: t.id }, body: { startDate, versionId, assignees: Object.keys(assignees).length ? assignees : undefined } }));
    } catch (e) {
      setResult(null);
      setError(isApiError(e) ? e.message : 'Preview failed.');
    }
  };
  useEffect(() => {
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [versionId]);
  type Row = TemplatePreview['tasks'][number];
  const columns: Column<Row>[] = [
    { key: 'title', header: 'Task', sticky: true, minWidth: 220, cell: (r) => <span className="flex flex-col"><span className="text-fg">{r.title}</span>{r.dependsOn.length ? <span className="text-[12px] text-fg-2">After {r.dependsOn.join(', ')}</span> : null}</span> },
    { key: 'start', header: 'Start', minWidth: 110, cell: (r) => formatDate(r.startDate) },
    { key: 'due', header: 'Due', minWidth: 110, cell: (r) => formatDate(r.dueDate) },
    { key: 'estimate', header: 'Estimate', align: 'right', minWidth: 90, cell: (r) => (r.estimateMinutes !== null ? formatDuration(r.estimateMinutes * 60) : '—') },
    { key: 'assignee', header: 'Assignee', minWidth: 160, cell: (r) => r.assignee?.displayName ?? (r.roleKey ? <span className="text-fg-2">{r.roleKey} (unassigned)</span> : '—') },
    { key: 'review', header: 'Review', minWidth: 80, cell: (r) => (r.requiresReview ? 'Yes' : '—') },
  ];
  return (
    <Dialog
      open
      size="wide"
      onOpenChange={(o) => !o && onClose()}
      title="Preview Application"
      description="How the template would lay out work. No records are created."
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button variant="primary" loading={preview.isPending} onClick={() => void run()}>
            Update Preview
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Start Date" className="w-[170px]">
            <DateInput value={startDate} onChange={(e) => e.target.value && setStartDate(e.target.value)} />
          </Field>
          {t.published && t.draft ? (
            <Field label="Version" className="w-[220px]">
              <Select
                value={versionId ?? null}
                onChange={(v) => v && setVersionId(v)}
                options={[
                  { value: t.published.id, label: `Published version ${t.published.versionNo}` },
                  { value: t.draft.id, label: `Draft version ${t.draft.versionNo}` },
                ]}
              />
            </Field>
          ) : null}
          {roles.map((r) => (
            <Field key={r} label={`Role: ${r}`} className="w-[200px]">
              <MemberSelect
                value={assignees[r] ?? null}
                clearable
                placeholder="Unassigned"
                onChange={(v) =>
                  setAssignees((cur) => {
                    const next = { ...cur };
                    if (v) next[r] = v;
                    else delete next[r];
                    return next;
                  })
                }
              />
            </Field>
          ))}
        </div>
        {error ? <Banner tone="danger">{error}</Banner> : null}
        {result ? (
          <>
            <p className="text-[13px] text-fg">
              Version {result.versionNo}: {result.tasks.length} task{result.tasks.length === 1 ? '' : 's'} from {formatDate(result.startDate)}
              {result.endDate ? ` to ${formatDate(result.endDate)}` : ''}, total estimate {formatDuration(result.totalEstimateMinutes * 60)}.
            </p>
            {result.warnings.length ? (
              <Banner tone="warning">
                <ul className="list-disc pl-5">
                  {result.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </Banner>
            ) : null}
            {result.tasks.length ? <DataTable caption="Planned tasks" rows={result.tasks} columns={columns} getRowId={(r) => r.key} density="compact" /> : null}
            {result.checklist.length ? (
              <section>
                <h3 className="text-[13px] font-semibold text-fg">Checklist</h3>
                <ul className="mt-1 list-disc pl-5 text-[13px] text-fg">
                  {result.checklist.map((c, i) => (
                    <li key={i}>
                      {c.label}
                      {c.mandatory ? ' (mandatory)' : ''}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {result.rubric.length ? (
              <section>
                <h3 className="text-[13px] font-semibold text-fg">Rubric</h3>
                <ul className="mt-1 list-disc pl-5 text-[13px] text-fg">
                  {result.rubric.map((r) => (
                    <li key={r.key}>
                      {r.label} — {r.weight}%
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </>
        ) : null}
      </div>
    </Dialog>
  );
};
