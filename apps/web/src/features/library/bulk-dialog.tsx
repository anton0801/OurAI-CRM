'use client';
import { useEffect, useState } from 'react';
import { mediaEndpoints, type AssetFilter, type EndpointResponse, type FolderView } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { Badge, Banner, Button, Dialog, Field, Input, Select, Textarea, type Tone } from '@castlane/ui';
import { useApiMutation } from '@/lib/hooks';
import { useWorkspace } from '@/lib/workspace-context';
import { splitTags } from './library-utils';

export type BulkAction = 'move' | 'tag' | 'untag' | 'archive';

const TITLES: Record<BulkAction, string> = { move: 'Move Files', tag: 'Add Tags', untag: 'Remove Tags', archive: 'Archive Files' };
const OUTCOME: Record<string, { label: string; tone: Tone }> = {
  apply: { label: 'Will change', tone: 'success' },
  skip: { label: 'Skipped', tone: 'neutral' },
  denied: { label: 'Not allowed', tone: 'danger' },
  conflict: { label: 'Conflict', tone: 'warning' },
};

type Preview = EndpointResponse<typeof mediaEndpoints.bulkPreview>;
type Result = EndpointResponse<typeof mediaEndpoints.bulkApply>;

/**
 * Bulk Move / Tag / Archive (§4.6): parameters → server preview (available, denied, conflicting
 * files and changes of project access) → apply → per-file result with Retry Failures.
 */
export const BulkDialog = ({
  open,
  onOpenChange,
  action,
  selection,
  folders,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  action: BulkAction;
  selection: { assetIds: string[] } | { filter: AssetFilter; expectedCount: number | null };
  folders: FolderView[];
  onDone: () => void;
}) => {
  const { workspace } = useWorkspace();
  const [folderId, setFolderId] = useState<string>('__root__');
  const [tags, setTags] = useState('');
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const previewM = useApiMutation(mediaEndpoints.bulkPreview, { silentErrors: true });
  const applyM = useApiMutation(mediaEndpoints.bulkApply, { invalidate: ['assets.', 'folders.'], silentErrors: true });
  useEffect(() => {
    if (open) {
      setPreview(null);
      setResult(null);
      setError(null);
      setTags('');
      setReason('');
      setFolderId('__root__');
    }
  }, [open, action]);
  const count = 'assetIds' in selection ? selection.assetIds.length : selection.expectedCount;
  const paramsValid = action === 'move' ? true : action === 'archive' ? true : splitTags(tags).length > 0;

  const runPreview = async () => {
    setError(null);
    try {
      const p = await previewM.run({
        params: { workspaceId: workspace.id },
        body: {
          action,
          ...('assetIds' in selection ? { assetIds: selection.assetIds } : { filter: selection.filter, expectedCount: selection.expectedCount ?? undefined }),
          ...(action === 'move' ? { folderId: folderId === '__root__' ? null : folderId } : {}),
          ...(action === 'tag' || action === 'untag' ? { tags: splitTags(tags) } : {}),
          ...(action === 'archive' && reason.trim() ? { reason: reason.trim() } : {}),
        },
      });
      setPreview(p);
    } catch (e) {
      setError(isApiError(e) ? (e.fieldErrors[0]?.message ?? e.message) : 'The preview could not be created.');
    }
  };
  const runApply = async (onlyIds?: string[]) => {
    if (!preview) return;
    setError(null);
    try {
      const r = await applyM.run({ params: { workspaceId: workspace.id }, body: { token: preview.token, ...(onlyIds ? { onlyIds } : {}) } });
      setResult(r);
      if (!r.failed.length) onDone();
    } catch (e) {
      setError(isApiError(e) ? e.message : 'The change could not be applied.');
    }
  };
  const names = new Map(preview?.items.map((i) => [i.id, i.name]) ?? []);
  const countChanged = preview && !('assetIds' in selection) && selection.expectedCount !== null && preview.items.length !== selection.expectedCount;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="regular"
      title={TITLES[action]}
      description={count !== null ? `${count} selected file${count === 1 ? '' : 's'}` : 'All files matching the current filters'}
      footer={
        result ? (
          <>
            {result.failed.length ? (
              <Button loading={applyM.isPending} onClick={() => void runApply(result.failed.map((f) => f.id))}>
                Retry Failures
              </Button>
            ) : null}
            <Button
              variant="primary"
              onClick={() => {
                onOpenChange(false);
                onDone();
              }}
            >
              Done
            </Button>
          </>
        ) : preview ? (
          <>
            <Button onClick={() => setPreview(null)} disabled={applyM.isPending}>
              Back
            </Button>
            <Button variant={action === 'archive' ? 'danger' : 'primary'} loading={applyM.isPending} disabled={preview.counts.apply === 0} onClick={() => void runApply()}>
              {`Apply to ${preview.counts.apply} file${preview.counts.apply === 1 ? '' : 's'}`}
            </Button>
          </>
        ) : (
          <>
            <Button onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button variant="primary" loading={previewM.isPending} disabled={!paramsValid} onClick={() => void runPreview()}>
              Preview Changes
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        {!preview && !result ? (
          <>
            {action === 'move' ? (
              <Field label="Target folder" helper="Moving into a folder of another project changes who can see the file; the preview lists every such change.">
                <Select
                  value={folderId}
                  onChange={(v) => setFolderId(v ?? '__root__')}
                  searchable
                  options={[
                    { value: '__root__', label: 'Library root (no folder)' },
                    ...folders.filter((f) => !f.archivedAt).map((f) => ({ value: f.id, label: `${'— '.repeat(f.depth)}${f.name}`, description: f.projectName ?? (f.projectId ? undefined : 'Workspace library') })),
                  ]}
                />
              </Field>
            ) : null}
            {action === 'tag' || action === 'untag' ? (
              <Field label="Tags" required helper="Comma-separated, 2–40 characters each.">
                <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="e.g. Approved, Season 1" />
              </Field>
            ) : null}
            {action === 'archive' ? (
              <>
                <p className="text-[14px] text-fg-2">Archived records remain available in historical reports. Links from approved or published work keep their exact file version.</p>
                <Field label="Reason">
                  <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
                </Field>
              </>
            ) : null}
          </>
        ) : null}
        {preview && !result ? (
          <>
            <Banner tone="info">Review changes before applying them. No records have been changed yet.</Banner>
            {countChanged ? (
              <Banner tone="warning">
                The number of matching files changed since you selected them ({selection && 'expectedCount' in selection ? selection.expectedCount : ''} → {preview.items.length}).
              </Banner>
            ) : null}
            {preview.truncated ? <Banner tone="warning">Only the first 1,000 matching files are included. Narrow the filters to change the rest.</Banner> : null}
            <div className="flex flex-wrap gap-2">
              {(['apply', 'skip', 'denied', 'conflict'] as const).map((k) => (
                <Badge key={k} tone={OUTCOME[k]!.tone}>
                  {OUTCOME[k]!.label}: {preview.counts[k]}
                </Badge>
              ))}
            </div>
            <ul className="max-h-[320px] divide-y divide-line overflow-y-auto rounded-[8px] border border-line">
              {preview.items.map((i) => (
                <li key={i.id} className="flex flex-col gap-0.5 px-3 py-2 text-[13px]">
                  <span className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-fg">{i.name}</span>
                    <Badge tone={OUTCOME[i.outcome]!.tone}>{OUTCOME[i.outcome]!.label}</Badge>
                  </span>
                  {i.reason ? <span className="text-fg-2">{i.reason}</span> : null}
                  {i.scopeChange ? (
                    <span className="text-warning">
                      Access changes: {i.scopeChange.fromProjectName ?? (i.scopeChange.fromProjectId ? 'another project' : 'workspace library')} →{' '}
                      {i.scopeChange.toProjectName ?? (i.scopeChange.toProjectId ? 'another project' : 'workspace library')}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {result ? (
          <>
            <Banner tone={result.failed.length ? 'warning' : 'success'}>
              {result.applied.length} changed{result.failed.length ? `, ${result.failed.length} failed` : ''}
              {result.skipped ? `, ${result.skipped} not included` : ''}.
            </Banner>
            {result.failed.length ? (
              <ul className="flex flex-col gap-1 text-[13px]">
                {result.failed.map((f) => (
                  <li key={f.id}>
                    <span className="font-medium text-fg">{names.get(f.id) ?? 'File'}</span>: <span className="text-fg-2">{f.reason}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        ) : null}
      </div>
    </Dialog>
  );
};
