'use client';
import { useEffect, useMemo, useState } from 'react';
import { LOOKUP_TYPES, mediaEndpoints, type AssetVersionView, type LookupType } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { Banner, Button, Dialog, Field, Select } from '@castlane/ui';
import { EntitySelect } from '@/components/common/entity-select';
import { useApiMutation, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useWorkspace } from '@/lib/workspace-context';

/**
 * Link to Content / Link (S36/S37): attach a file to another record the member can read. The
 * link is checked against both the file's and the record's scope; removing it never deletes the file.
 */
export const LinkDialog = ({
  open,
  onOpenChange,
  assetId,
  assetName,
  versions,
  defaultType = 'content_item',
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  assetId: string | null;
  assetName?: string;
  versions?: AssetVersionView[];
  defaultType?: string;
}) => {
  const { workspace } = useWorkspace();
  const targets = useApiQuery(mediaEndpoints.linkTargets, { params: { workspaceId: workspace.id } }, { enabled: open, staleTime: 300_000 });
  const types = useMemo(() => (targets.data ?? []).filter((t): t is LookupType => (LOOKUP_TYPES as readonly string[]).includes(t)), [targets.data]);
  const [type, setType] = useState<LookupType | null>(null);
  const [entityId, setEntityId] = useState<string | null>(null);
  const [role, setRole] = useState('attachment');
  const [versionId, setVersionId] = useState<string>('current');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setEntityId(null);
    setRole('attachment');
    setVersionId('current');
    setError(null);
  }, [open]);
  useEffect(() => {
    if (open && !type && types.length) setType((types.includes(defaultType as LookupType) ? defaultType : types[0]) as LookupType);
  }, [open, type, types, defaultType]);
  const link = useApiMutation(mediaEndpoints.link, { invalidate: ['assets.'], silentErrors: true, successMessage: 'File linked' });
  const available = (versions ?? []).filter((v) => v.status === 'available' && !v.deletedAt);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="small"
      title={assetName ? `Link “${assetName}”` : 'Link File'}
      description="The file is shown on the chosen record. Removing the link later does not delete the file."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)} disabled={link.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={link.isPending}
            disabled={!type || !entityId || !assetId}
            onClick={async () => {
              if (!type || !entityId || !assetId) return;
              setError(null);
              try {
                await link.run({ params: { workspaceId: workspace.id, assetId }, body: { target: { entityType: type, entityId, role }, ...(versionId !== 'current' ? { versionId } : {}) } });
                onOpenChange(false);
              } catch (e) {
                setError(isApiError(e) ? e.message : 'The file could not be linked.');
              }
            }}
          >
            Link File
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        {targets.isError ? <Banner tone="danger">Link targets could not be loaded.</Banner> : null}
        <Field label="Record type" required>
          <Select
            value={type}
            onChange={(v) => {
              setType(v as LookupType | null);
              setEntityId(null);
            }}
            options={types.map((t) => ({ value: t, label: label('entityType', t) }))}
            placeholder={targets.isLoading ? 'Loading…' : 'Choose a type'}
          />
        </Field>
        {type ? (
          <Field label={label('entityType', type)} required>
            <EntitySelect key={type} type={type} value={entityId} onChange={(v) => setEntityId(v)} />
          </Field>
        ) : null}
        <Field label="Role">
          <Select
            value={role}
            onChange={(v) => setRole(v ?? 'attachment')}
            options={[
              { value: 'attachment', label: 'Attachment' },
              { value: 'reference', label: 'Reference' },
            ]}
          />
        </Field>
        {available.length > 1 ? (
          <Field label="Version" helper="Link a specific version to keep pointing at exactly that file.">
            <Select
              value={versionId}
              onChange={(v) => setVersionId(v ?? 'current')}
              options={[{ value: 'current', label: 'Always the current version' }, ...available.map((v) => ({ value: v.id, label: `Version ${v.versionNo} — ${v.originalFilename}` }))]}
            />
          </Field>
        ) : null}
      </div>
    </Dialog>
  );
};
