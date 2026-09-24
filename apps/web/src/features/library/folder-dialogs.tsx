'use client';
import { useEffect, useMemo, useState } from 'react';
import { folderEndpoints, type FolderView } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { Banner, Button, ConfirmDialog, Dialog, Field, Input, RadioGroup, Select } from '@castlane/ui';
import { EntitySelect } from '@/components/common/entity-select';
import { ConflictDialog } from '@/components/common/conflict';
import { useEditBase } from '@/lib/edit-base';
import { useApiMutation, useApiQuery } from '@/lib/hooks';
import { useWorkspace } from '@/lib/workspace-context';
import { subtreeOf } from './library-utils';

const INVALIDATE = ['folders.', 'assets.'];

/** New Folder / New Subfolder / Rename. */
export const FolderFormDialog = ({
  open,
  onOpenChange,
  mode,
  parent,
  folder,
  defaultProjectId,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  mode: 'create' | 'rename';
  parent?: FolderView | null;
  folder?: FolderView | null;
  defaultProjectId?: string | null;
  onSaved?: (id: string) => void;
}) => {
  const { workspace } = useWorkspace();
  const [name, setName] = useState('');
  const [scope, setScope] = useState<'workspace' | 'project'>('project');
  const [projectId, setProjectId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A rename is saved against the folder as the dialog opened; a live refresh (a new `folder`
  // object) no longer resets the typed name (T162).
  const edit = useEditBase(mode === 'rename' ? folder : null, { open, onReload: (x) => setName(x.name) });
  useEffect(() => {
    if (!open) return;
    setName(mode === 'rename' ? (folder?.name ?? '') : '');
    setProjectId(defaultProjectId ?? null);
    setScope(defaultProjectId ? 'project' : 'workspace');
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, folder?.id, defaultProjectId]);
  const create = useApiMutation(folderEndpoints.create, { invalidate: INVALIDATE, silentErrors: true, successMessage: 'Folder created' });
  const rename = useApiMutation(folderEndpoints.update, { invalidate: INVALIDATE, silentErrors: true, successMessage: 'Folder renamed' });
  const pending = create.isPending || rename.isPending;
  const dirty = mode === 'rename' ? name !== (edit.start ?? folder)?.name : name.trim().length > 0;
  const submit = async () => {
    setError(null);
    try {
      if (mode === 'rename' && folder) {
        const r = await rename.run({ params: { workspaceId: workspace.id, folderId: folder.id }, body: { name } }, { ifMatch: edit.version });
        onSaved?.(r.id);
      } else {
        const r = await create.run({
          params: { workspaceId: workspace.id },
          body: parent ? { name, parentId: parent.id } : { name, projectId: scope === 'project' ? projectId : null },
        });
        onSaved?.(r.id);
      }
      onOpenChange(false);
    } catch (e) {
      if (!edit.catchConflict(e)) setError(isApiError(e) ? (e.fieldErrors[0]?.message ?? e.message) : 'The folder could not be saved.');
    }
  };
  const valid = name.trim().length >= 2 && name.trim().length <= 120 && (mode === 'rename' || parent || scope === 'workspace' || !!projectId);
  return (
    <>
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
        dirty={dirty && !pending}
        size="small"
        title={mode === 'rename' ? 'Rename Folder' : parent ? `New Subfolder in ${parent.name}` : 'New Folder'}
        description={mode === 'create' ? 'Folders organise files; they never change who can see a file.' : undefined}
        footer={
          <>
            <Button onClick={() => onOpenChange(false)} disabled={pending}>
              Cancel
            </Button>
            <Button variant="primary" loading={pending} disabled={!valid} onClick={() => void submit()}>
              {mode === 'rename' ? 'Save' : 'Create Folder'}
            </Button>
          </>
        }
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) void submit();
          }}
        >
          {error ? <Banner tone="danger">{error}</Banner> : null}
          <Field label="Name" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoFocus />
          </Field>
          {mode === 'create' && !parent ? (
            <>
              <RadioGroup
                label="Library"
                value={scope}
                onValueChange={setScope}
                options={[
                  { value: 'project', label: 'Project library', description: 'Visible to members who can see the project’s files.' },
                  { value: 'workspace', label: 'Workspace library', description: 'Needs workspace-wide file access.' },
                ]}
              />
              {scope === 'project' ? (
                <Field label="Project" required>
                  <EntitySelect type="project" value={projectId} onChange={(v) => setProjectId(v)} />
                </Field>
              ) : null}
            </>
          ) : null}
          {mode === 'create' && parent ? <p className="text-[13px] text-fg-2">{parent.projectName ? `Part of the ${parent.projectName} library.` : 'Part of the workspace library.'}</p> : null}
        </form>
      </Dialog>
      <ConflictDialog {...edit.conflictDialog} />
    </>
  );
};

/** Move a folder within its library (same project); cycles and depth are checked by the server. */
export const MoveFolderDialog = ({ open, onOpenChange, folder, folders }: { open: boolean; onOpenChange: (o: boolean) => void; folder: FolderView | null; folders: FolderView[] }) => {
  const { workspace } = useWorkspace();
  const [target, setTarget] = useState<string>('__root__');
  const [error, setError] = useState<string | null>(null);
  // The move is applied to the folder as the dialog opened; a live refresh keeps the chosen target (T162).
  const edit = useEditBase(folder, { open, onReload: (x) => setTarget(x.parentId ?? '__root__') });
  useEffect(() => {
    if (open) {
      setTarget(folder?.parentId ?? '__root__');
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, folder?.id]);
  const move = useApiMutation(folderEndpoints.move, { invalidate: INVALIDATE, silentErrors: true, successMessage: 'Folder moved' });
  const options = useMemo(() => {
    if (!folder) return [];
    const excluded = new Set(subtreeOf(folders, folder.id));
    return [
      { value: '__root__', label: 'Top level' },
      ...folders
        .filter((f) => f.projectId === folder.projectId && !excluded.has(f.id) && !f.archivedAt)
        .map((f) => ({ value: f.id, label: `${'— '.repeat(f.depth)}${f.name}` })),
    ];
  }, [folder, folders]);
  return (
    <>
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
        size="small"
        title={folder ? `Move ${folder.name}` : 'Move Folder'}
        description="Folders move within the same library. To move files to another project, select the files and use Move — the change of access is previewed first."
        footer={
          <>
            <Button onClick={() => onOpenChange(false)} disabled={move.isPending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={move.isPending}
              disabled={!folder || target === (folder.parentId ?? '__root__')}
              onClick={async () => {
                if (!folder) return;
                setError(null);
                try {
                  await move.run({ params: { workspaceId: workspace.id, folderId: folder.id }, body: { parentId: target === '__root__' ? null : target } }, { ifMatch: edit.version });
                  onOpenChange(false);
                } catch (e) {
                  if (!edit.catchConflict(e)) setError(isApiError(e) ? (e.fieldErrors[0]?.message ?? e.message) : 'The folder could not be moved.');
                }
              }}
            >
              Move Folder
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {error ? <Banner tone="danger">{error}</Banner> : null}
          <Field label="Move to">
            <Select value={target} onChange={(v) => setTarget(v ?? '__root__')} options={options} searchable />
          </Field>
        </div>
      </Dialog>
      <ConflictDialog {...edit.conflictDialog} />
    </>
  );
};

/** Archive with preview: a folder must be empty (contents moved or archived first). */
export const ArchiveFolderDialog = ({ open, onOpenChange, folder, onArchived }: { open: boolean; onOpenChange: (o: boolean) => void; folder: FolderView | null; onArchived?: () => void }) => {
  const { workspace } = useWorkspace();
  const preview = useApiQuery(folderEndpoints.archivePreview, { params: { workspaceId: workspace.id, folderId: folder?.id ?? '' } }, { enabled: open && !!folder });
  const archive = useApiMutation(folderEndpoints.archive, { invalidate: INVALIDATE, successMessage: 'Folder archived' });
  const blocking = preview.data?.items.filter((i) => i.blocking) ?? [];
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={folder ? `Archive ${folder.name}?` : 'Archive folder?'}
      destructive
      confirmLabel="Archive Folder"
      loading={archive.isPending}
      confirmDisabled={!preview.data || blocking.length > 0}
      body="Archived records remain available in historical reports. The folder is hidden from the Library and can be restored from the Archive."
      onConfirm={async () => {
        if (!folder || !preview.data) return;
        await archive.run({ params: { workspaceId: workspace.id, folderId: folder.id }, body: {} }, { ifMatch: preview.data.rowVersion });
        onOpenChange(false);
        onArchived?.();
      }}
    >
      {preview.isLoading ? <p className="text-[13px] text-fg-2">Checking the folder’s contents…</p> : null}
      {blocking.length ? (
        <Banner tone="warning">
          <ul className="flex flex-col gap-1">
            {blocking.map((i) => (
              <li key={i.kind}>
                {i.label}: {i.count}. {i.resolution}
              </li>
            ))}
          </ul>
        </Banner>
      ) : null}
    </ConfirmDialog>
  );
};
