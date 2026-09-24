'use client';
import { Copy, LinkSimple, Plus } from '@phosphor-icons/react';
import Link from 'next/link';
import { useState } from 'react';
import { trackingLinkEndpoints as TL, type CampaignDetail, type TrackingLinkRow } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { isSafeUrl } from '@castlane/domain';
import { Badge, Banner, Button, Checkbox, DataTable, Dialog, EmptyState, Field, Input, Menu, Switch, Textarea, Toolbar, toast, type Column } from '@castlane/ui';
import { ConflictDialog } from '@/components/common/conflict';
import { EntitySelect } from '@/components/common/entity-select';
import { QueryState } from '@/components/common/query-state';
import { useDebounced } from '@/components/common/use-debounced';
import { useApiMutation, useApiQuery } from '@/lib/hooks';
import { useUrlState } from '@/lib/url-state';
import { useWorkspace, useWsPath } from '@/lib/workspace-context';
import { CAMPAIGN_INVALIDATE, TAGGED_URL_NOTE } from './labels';

const UTM: { key: 'utmSource' | 'utmMedium' | 'utmCampaign' | 'utmContent' | 'utmTerm'; label: string; param: string; hint?: string }[] = [
  { key: 'utmSource', label: 'Source', param: 'utm_source', hint: 'e.g. instagram' },
  { key: 'utmMedium', label: 'Medium', param: 'utm_medium', hint: 'e.g. social' },
  { key: 'utmCampaign', label: 'Campaign', param: 'utm_campaign' },
  { key: 'utmContent', label: 'Content', param: 'utm_content' },
  { key: 'utmTerm', label: 'Term', param: 'utm_term' },
];

type Utm = Record<(typeof UTM)[number]['key'], string>;
const emptyUtm: Utm = { utmSource: '', utmMedium: '', utmCampaign: '', utmContent: '', utmTerm: '' };

const copy = async (text: string) => {
  try {
    await navigator.clipboard.writeText(text);
    toast.success('Link copied');
  } catch {
    toast.error('The link could not be copied. Select it and copy it manually.');
  }
};

/** S34 Links tab: tagged URLs of the campaign. Links carry no click counts of their own. */
export const CampaignLinksTab = ({ campaign: c }: { campaign: CampaignDetail }) => {
  const { workspace, user } = useWorkspace();
  const wsPath = useWsPath();
  const { state, set } = useUrlState<'linksArchived' | 'highlight'>();
  const archived = state.linksArchived === '1';
  const q = useApiQuery(TL.list, { params: { workspaceId: workspace.id }, query: { campaignId: c.id, includeArchived: archived || undefined } });
  const [editing, setEditing] = useState<TrackingLinkRow | 'new' | null>(null);
  const [archiving, setArchiving] = useState<TrackingLinkRow | null>(null);
  const restore = useApiMutation(TL.archive, { invalidate: CAMPAIGN_INVALIDATE, successMessage: 'Link restored' });
  const canManage = c.permissions.manageLinks && c.status !== 'archived';

  const columns: Column<TrackingLinkRow>[] = [
    {
      key: 'label',
      header: 'Label',
      sticky: true,
      minWidth: 200,
      cell: (l) => (
        <span className="flex flex-col">
          <span className="font-medium text-fg">
            {l.label} {l.id === state.highlight ? <Badge tone="info">Opened from search</Badge> : null} {l.archivedAt ? <Badge>Archived</Badge> : null}
          </span>
          {l.publication ? (
            <Link href={wsPath(`/publications/${l.publication.id}`)} className="text-[12px] text-fg-2 hover:underline">
              For {l.publication.title}
            </Link>
          ) : null}
        </span>
      ),
    },
    {
      key: 'url',
      header: 'Tagged URL',
      minWidth: 320,
      cell: (l) => (
        <span className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg-2" title={l.builtUrl}>
            {l.builtUrl}
          </code>
          <Button size="sm" variant="ghost" icon={<Copy size={14} />} onClick={() => void copy(l.builtUrl)} aria-label={`Copy tagged URL ${l.label}`}>
            Copy
          </Button>
        </span>
      ),
    },
    { key: 'source', header: 'Source / Medium', minWidth: 160, cell: (l) => [l.utmSource, l.utmMedium].filter(Boolean).join(' / ') || <span className="text-fg-muted">—</span> },
    {
      key: 'clicks',
      header: 'Reported clicks',
      align: 'right',
      minWidth: 130,
      cell: (l) => (l.reportedClicks === null ? <span className="text-fg-muted" title="No source report references this link">Not reported</span> : l.reportedClicks),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      minWidth: 90,
      hidden: !canManage,
      cell: (l) => (
        <Menu
          label={`Actions for ${l.label}`}
          trigger={<Button size="sm" variant="ghost">Actions</Button>}
          items={[
            { label: 'Edit', hidden: !!l.archivedAt, onSelect: () => setEditing(l) },
            { label: 'Archive', hidden: !!l.archivedAt, destructive: true, onSelect: () => setArchiving(l) },
            {
              label: 'Restore',
              hidden: !l.archivedAt,
              onSelect: () => void restore.run({ params: { workspaceId: workspace.id, linkId: l.id }, body: { restore: true } }, { ifMatch: l.rowVersion }).catch(() => undefined),
            },
          ]}
        />
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-fg-2">{TAGGED_URL_NOTE}</p>
      <Toolbar>
        <Switch label="Show archived" checked={archived} onCheckedChange={(v) => set({ linksArchived: v ? '1' : null })} />
        {canManage ? (
          <div className="ml-auto">
            <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={() => setEditing('new')}>
              Build Tagged URL
            </Button>
          </div>
        ) : null}
      </Toolbar>
      <QueryState query={q}>
        {q.data && q.data.length ? (
          <DataTable caption="Tagged links" rows={q.data} columns={columns} getRowId={(l) => l.id} density={user.density} />
        ) : (
          <EmptyState
            icon={<LinkSimple size={28} />}
            title="No tagged links"
            description="Build a tagged URL to share in a placement or bio. Reported clicks appear only after you add a source report."
            action={canManage ? <Button variant="primary" onClick={() => setEditing('new')}>Build Tagged URL</Button> : undefined}
          />
        )}
      </QueryState>
      {editing ? <TaggedUrlDialog campaign={c} link={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
      {archiving ? <ArchiveLinkDialog link={archiving} onClose={() => setArchiving(null)} /> : null}
    </div>
  );
};

/** Build Tagged URL: live preview with URL-encoded parameters; different existing values are never replaced silently. */
const TaggedUrlDialog = ({ campaign: c, link, onClose }: { campaign: CampaignDetail; link: TrackingLinkRow | null; onClose: () => void }) => {
  const { workspace } = useWorkspace();
  const [labelText, setLabel] = useState(link?.label ?? '');
  const [destination, setDestination] = useState(link?.destinationUrl ?? '');
  const [utm, setUtm] = useState<Utm>(
    link
      ? { utmSource: link.utmSource ?? '', utmMedium: link.utmMedium ?? '', utmCampaign: link.utmCampaign ?? '', utmContent: link.utmContent ?? '', utmTerm: link.utmTerm ?? '' }
      : { ...emptyUtm, utmCampaign: c.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60) },
  );
  const [publicationId, setPublicationId] = useState<string | null>(link?.publication?.id ?? null);
  const [overwrite, setOverwrite] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  // Debounce a string (a fresh object each render would never settle).
  const debouncedKey = useDebounced(JSON.stringify({ destination, utm }), 300);
  const debounced = JSON.parse(debouncedKey) as { destination: string; utm: Utm };
  const preview = useApiQuery(
    TL.preview,
    {
      params: { workspaceId: workspace.id },
      query: {
        destinationUrl: debounced.destination.trim(),
        utmSource: debounced.utm.utmSource.trim() || undefined,
        utmMedium: debounced.utm.utmMedium.trim() || undefined,
        utmCampaign: debounced.utm.utmCampaign.trim() || undefined,
        utmContent: debounced.utm.utmContent.trim() || undefined,
        utmTerm: debounced.utm.utmTerm.trim() || undefined,
      },
    },
    { enabled: debounced.destination.trim().length > 8 },
  );
  const create = useApiMutation(TL.create, { invalidate: CAMPAIGN_INVALIDATE, silentErrors: true, successMessage: 'Tagged link saved' });
  const update = useApiMutation(TL.update, { invalidate: CAMPAIGN_INVALIDATE, silentErrors: true, successMessage: 'Tagged link saved' });
  const conflicts = preview.data?.conflicts ?? [];
  const pending = create.isPending || update.isPending;

  const submit = async () => {
    const next: Record<string, string> = {};
    if (labelText.trim().length < 2) next.label = 'Use 2–120 characters.';
    if (!isSafeUrl(destination.trim(), { httpsOnly: true })) next.destinationUrl = 'Enter a valid https link.';
    if (conflicts.length && !overwrite) next.overwrite = 'Confirm that the existing parameters may be replaced, or change the values.';
    setErrors(next);
    setError(null);
    if (Object.keys(next).length) return;
    const body = {
      label: labelText.trim(),
      destinationUrl: destination.trim(),
      publicationId,
      overwriteConflicts: overwrite || undefined,
      ...Object.fromEntries(UTM.map((u) => [u.key, utm[u.key].trim() || null])),
    };
    try {
      if (link) await update.run({ params: { workspaceId: workspace.id, linkId: link.id }, body }, { ifMatch: link.rowVersion });
      else await create.run({ params: { workspaceId: workspace.id, campaignId: c.id }, body: body as typeof body & { label: string; destinationUrl: string } });
      onClose();
    } catch (e) {
      if (isApiError(e) && e.code === 'VERSION_CONFLICT') setConflict(true);
      else if (isApiError(e) && e.fieldErrors.length) setErrors(Object.fromEntries(e.fieldErrors.map((f) => [f.field.replace(/^body\./, ''), f.message])));
      else setError(isApiError(e) ? e.message : 'The link could not be saved.');
    }
  };

  return (
    <>
      <Dialog
        open
        onOpenChange={(o) => !o && onClose()}
        title={link ? 'Edit tagged link' : 'Build Tagged URL'}
        description={TAGGED_URL_NOTE}
        dirty={!!labelText || !!destination}
        footer={
          <>
            <Button onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button variant="primary" loading={pending} onClick={() => void submit()}>
              Save Link
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {error ? <Banner tone="danger">{error}</Banner> : null}
          <Field label="Label" required error={errors.label}>
            <Input value={labelText} onChange={(e) => setLabel(e.target.value)} maxLength={120} autoFocus placeholder="e.g. Bio link, story swipe-up" />
          </Field>
          <Field label="Destination URL" required error={errors.destinationUrl} helper="The page people land on. Must be an https link.">
            <Input value={destination} onChange={(e) => setDestination(e.target.value)} inputMode="url" placeholder="https://" />
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {UTM.map((u) => (
              <Field key={u.key} label={`${u.label} (${u.param})`} error={errors[u.key]}>
                <Input value={utm[u.key]} onChange={(e) => setUtm({ ...utm, [u.key]: e.target.value })} maxLength={200} placeholder={u.hint} />
              </Field>
            ))}
          </div>
          <Field label="Placement" error={errors.publicationId} helper="Optional: the publication that uses this link (a project of this campaign).">
            <EntitySelect type="publication" value={publicationId} onChange={setPublicationId} clearable />
          </Field>
          <div className="flex flex-col gap-2 rounded-[12px] border border-line bg-surface-2 p-3">
            <span className="text-[12px] font-semibold text-fg-2">Preview</span>
            {preview.data?.url ? (
              <code className="break-all font-mono text-[12px] text-fg">{preview.data.url}</code>
            ) : (
              <span className="text-[13px] text-fg-2">{preview.data?.message ?? 'Enter the destination URL to see the tagged link.'}</span>
            )}
          </div>
          {conflicts.length ? (
            <Banner tone="warning">
              <div className="flex flex-col gap-2">
                <span>The destination already has these parameters with other values:</span>
                <ul className="list-disc pl-5 text-[13px]">
                  {conflicts.map((x) => (
                    <li key={x.key}>
                      {x.key}: “{x.existing}” → “{x.proposed}”
                    </li>
                  ))}
                </ul>
                <Checkbox label="Replace the existing values" checked={overwrite} onCheckedChange={(v) => setOverwrite(v === true)} />
                {errors.overwrite ? <span className="text-[13px] text-danger">{errors.overwrite}</span> : null}
              </div>
            </Banner>
          ) : null}
        </div>
      </Dialog>
      <ConflictDialog open={conflict} onOpenChange={setConflict} onReload={() => window.location.reload()} />
    </>
  );
};

const ArchiveLinkDialog = ({ link, onClose }: { link: TrackingLinkRow; onClose: () => void }) => {
  const { workspace } = useWorkspace();
  const [reason, setReason] = useState('');
  const m = useApiMutation(TL.archive, { invalidate: CAMPAIGN_INVALIDATE, successMessage: 'Link archived' });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="small"
      title="Archive tagged link?"
      description={link.label}
      footer={
        <>
          <Button onClick={onClose} disabled={m.isPending}>
            Keep
          </Button>
          <Button
            variant="danger"
            loading={m.isPending}
            onClick={() =>
              void m
                .run({ params: { workspaceId: workspace.id, linkId: link.id }, body: reason.trim().length >= 3 ? { reason: reason.trim() } : {} }, { ifMatch: link.rowVersion })
                .then(onClose)
                .catch(() => undefined)
            }
          >
            Archive
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-[14px] text-fg-2">The link keeps working wherever it was shared. Source reports that reference it keep it.</p>
        <Field label="Reason" helper="Optional.">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={2000} />
        </Field>
      </div>
    </Dialog>
  );
};
