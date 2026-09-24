'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { ArrowsLeftRight, ChatCircle, PencilSimple, Plus } from '@phosphor-icons/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { PARTNER_INTERACTION_KINDS, partnerEndpoints, type PartnerDetail } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { LIMITS, PARTNER_KINDS } from '@castlane/domain';
import {
  Avatar,
  Badge,
  Banner,
  Button,
  ConfirmDialog,
  DateTimeInput,
  DescriptionList,
  Dialog,
  Drawer,
  Field,
  IconButton,
  Input,
  RadioGroup,
  Select,
  Spinner,
  StatusBadge,
  Textarea,
  formatDateTime,
  toast,
} from '@castlane/ui';
import { EntitySelect } from '@/components/common/entity-select';
import { ConflictDialog } from '@/components/common/conflict';
import { changedFields, pickChanged, useEditBase } from '@/lib/edit-base';
import { MemberSelect } from '@/components/common/pickers';
import { QueryState } from '@/components/common/query-state';
import { AssetThumb, FileUploader } from '@/components/media/file-uploader';
import { applyFieldErrors, useApiInfinite, useApiMutation, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useWorkspace, useWsPath } from '@/lib/workspace-context';
import { ExternalLink } from '@/features/accounts/platform';
import '@/features/accounts/labels';

const schema = z.object({
  kind: z.enum(PARTNER_KINDS),
  name: z.string().trim().min(2, 'Use 2–120 characters.').max(120, 'Use 2–120 characters.'),
  contactName: z.string().trim().max(120).optional(),
  businessEmail: z.string().trim().max(254).refine((v) => !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), 'Enter a valid e-mail address.').optional(),
  website: z.string().trim().max(LIMITS.urlMax).optional(),
  ownerMembershipId: z.string().uuid('Choose an owner.'),
  tags: z.string().max(1200).optional(),
  notes: z.string().max(LIMITS.noteMax).optional(),
  logoAssetId: z.string().nullable(),
});
type FormValues = z.infer<typeof schema>;

export const PartnerDrawer = ({ partnerId, onClose, onCreated }: { partnerId: string | null; onClose: () => void; onCreated?: (id: string) => void }) => {
  const { workspace } = useWorkspace();
  const q = useApiQuery(partnerEndpoints.get, { params: { workspaceId: workspace.id, partnerId: partnerId ?? '' } }, { enabled: !!partnerId });
  const [editing, setEditing] = useState(false);
  if (!partnerId) return <PartnerForm onClose={onClose} onSaved={(id) => onCreated?.(id)} />;
  if (editing && q.data) return <PartnerForm partner={q.data} onClose={() => setEditing(false)} onSaved={() => setEditing(false)} />;
  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      width={760}
      title={q.data?.name ?? 'Partner'}
      description={q.data ? `${label('partnerKind', q.data.kind)} · owner ${q.data.owner.displayName}` : undefined}
      headerActions={q.data?.permissions.update ? <IconButton label="Edit partner" icon={<PencilSimple size={16} />} onClick={() => setEditing(true)} /> : undefined}
    >
      <QueryState query={q}>{q.data ? <PartnerView p={q.data} onEdit={() => setEditing(true)} onClose={onClose} /> : null}</QueryState>
    </Drawer>
  );
};

const PartnerView = ({ p, onEdit, onClose }: { p: PartnerDetail; onEdit: () => void; onClose: () => void }) => {
  const { workspace, user } = useWorkspace();
  const wsPath = useWsPath();
  const router = useRouter();
  const [logOpen, setLogOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const interactions = useApiInfinite(partnerEndpoints.interactions, { params: { workspaceId: workspace.id, partnerId: p.id }, query: {} });
  const archive = useApiMutation(partnerEndpoints.archive, { invalidate: ['partners.'], silentErrors: true, successMessage: 'Partner archived' });
  const restore = useApiMutation(partnerEndpoints.restore, { invalidate: ['partners.'], successMessage: 'Partner restored' });
  return (
    <div className="flex flex-col gap-5">
      {p.mergedInto ? (
        <Banner tone="info">
          Merged into{' '}
          <Link className="underline" href={wsPath(`/partners?open=${p.mergedInto.id}`)}>
            {p.mergedInto.name}
          </Link>
          . Its deals and interactions moved there.
        </Banner>
      ) : p.archivedAt ? (
        <Banner tone="info">Archived records remain available in historical reports.</Banner>
      ) : null}
      <div className="flex items-start gap-4">
        {p.logoAssetId ? <AssetThumb workspaceId={workspace.id} assetId={p.logoAssetId} size={64} alt={`${p.name} logo`} className="h-10 w-10 object-cover" /> : <Avatar name={p.name} size={40} decorative />}
        <div className="flex flex-wrap gap-2">
          {p.permissions.createDeal ? (
            <Button size="sm" variant="primary" icon={<Plus size={12} />} onClick={() => router.push(wsPath(`/deals/new?partnerId=${p.id}`))}>
              New Deal
            </Button>
          ) : null}
          {p.permissions.logInteraction ? (
            <Button size="sm" icon={<ChatCircle size={14} />} onClick={() => setLogOpen(true)}>
              Log Interaction
            </Button>
          ) : null}
          {p.permissions.update ? (
            <Button size="sm" icon={<PencilSimple size={14} />} onClick={onEdit}>
              Edit
            </Button>
          ) : null}
          {p.permissions.merge ? (
            <Button size="sm" icon={<ArrowsLeftRight size={14} />} onClick={() => setMergeOpen(true)}>
              Merge Preview
            </Button>
          ) : null}
        </div>
      </div>
      <DescriptionList
        items={[
          { label: 'Contact', value: p.contactName },
          { label: 'Business e-mail', value: p.businessEmail ? <span className="break-all">{p.businessEmail}</span> : null },
          { label: 'Website', value: p.website ? <ExternalLink href={p.website} /> : null },
          { label: 'Owner', value: p.owner.displayName },
          { label: 'Tags', value: p.tags.length ? <span className="flex flex-wrap gap-1">{p.tags.map((t) => <Badge key={t}>{t}</Badge>)}</span> : null },
          { label: 'Notes', value: p.notes ? <span className="whitespace-pre-wrap">{p.notes}</span> : null },
        ]}
      />
      <p className="text-[12px] text-fg-2">The e-mail is a record for the team. Castlane does not send messages to partners.</p>
      <section className="flex flex-col gap-2">
        <h3 className="text-[16px] font-semibold text-fg">Deals</h3>
        {p.deals.length === 0 ? <p className="text-[13px] text-fg-2">No deals you can access.{p.hiddenDealCount ? ` ${p.hiddenDealCount} other deal(s) are outside your access.` : ''}</p> : null}
        <ul className="flex flex-col divide-y divide-line">
          {p.deals.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-[13px]">
              <Link href={wsPath(`/deals/${d.id}`)} className="font-medium text-fg hover:underline">
                {d.title}
              </Link>
              <span className="flex items-center gap-2">
                <span className="text-fg-2">{d.projects.map((x) => x.name).join(', ')}</span>
                <StatusBadge status={d.stage} label={label('dealStage', d.stage)} />
              </span>
            </li>
          ))}
        </ul>
        {p.deals.length && p.hiddenDealCount ? <p className="text-[12px] text-fg-2">{p.hiddenDealCount} other deal(s) are outside your access.</p> : null}
      </section>
      <section className="flex flex-col gap-2">
        <h3 className="text-[16px] font-semibold text-fg">Interactions</h3>
        <QueryState query={interactions} skeleton={<Spinner label="Loading interactions" />}>
          {interactions.items.length === 0 ? (
            <p className="text-[13px] text-fg-2">No interactions logged yet.</p>
          ) : (
            <ol className="flex flex-col divide-y divide-line">
              {interactions.items.map((i) => (
                <li key={i.id} className="flex flex-col gap-0.5 py-2 text-[13px]">
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge>{label('interactionKind', i.kind)}</Badge>
                    <span className="text-fg-2">
                      {formatDateTime(i.occurredAt, user.timezone)}
                      {i.author ? ` · ${i.author.displayName}` : ''}
                    </span>
                    {i.deal ? (
                      <Link href={wsPath(`/deals/${i.deal.id}`)} className="text-primary hover:underline">
                        {i.deal.title}
                      </Link>
                    ) : null}
                  </span>
                  <span className="whitespace-pre-wrap">{i.summary}</span>
                </li>
              ))}
            </ol>
          )}
          {interactions.hasNextPage ? (
            <Button size="sm" onClick={() => void interactions.fetchNextPage()} loading={interactions.isFetchingNextPage}>
              Load More
            </Button>
          ) : null}
        </QueryState>
      </section>
      {p.permissions.archive ? (
        <div>
          {p.archivedAt ? (
            !p.mergedInto ? (
              <Button loading={restore.isPending} onClick={() => void restore.run({ params: { workspaceId: workspace.id, partnerId: p.id }, body: {} }, { ifMatch: p.rowVersion }).catch(() => undefined)}>
                Restore Partner
              </Button>
            ) : null
          ) : (
            <Button variant="danger-secondary" onClick={() => setArchiveOpen(true)}>
              Archive Partner
            </Button>
          )}
        </div>
      ) : null}
      <LogInteractionDialog partner={p} open={logOpen} onOpenChange={setLogOpen} />
      <MergeDialog partner={p} open={mergeOpen} onOpenChange={setMergeOpen} onMerged={onClose} />
      <ConfirmDialog
        open={archiveOpen}
        onOpenChange={(o) => {
          setArchiveOpen(o);
          if (!o) setArchiveError(null);
        }}
        title="Archive partner?"
        body="Archived records remain available in historical reports. Partners with open deals cannot be archived."
        confirmLabel="Archive Partner"
        destructive
        loading={archive.isPending}
        onConfirm={async () => {
          try {
            await archive.run({ params: { workspaceId: workspace.id, partnerId: p.id }, body: {} }, { ifMatch: p.rowVersion });
            setArchiveOpen(false);
          } catch (e) {
            setArchiveError(isApiError(e) ? e.message : 'The partner could not be archived.');
          }
        }}
      >
        {archiveError ? <Banner tone="danger">{archiveError}</Banner> : null}
      </ConfirmDialog>
    </div>
  );
};

const nowLocal = () => {
  const d = new Date();
  d.setSeconds(0, 0);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

export const LogInteractionDialog = ({ partner, dealId, open, onOpenChange }: { partner: { id: string; deals?: { id: string; title: string }[] }; dealId?: string; open: boolean; onOpenChange: (o: boolean) => void }) => {
  const { workspace, user } = useWorkspace();
  const [kind, setKind] = useState<string | null>('call');
  const [when, setWhen] = useState(nowLocal());
  const [summary, setSummary] = useState('');
  const [deal, setDeal] = useState<string | null>(dealId ?? null);
  const [error, setError] = useState<string | null>(null);
  const log = useApiMutation(partnerEndpoints.logInteraction, { invalidate: ['partners.', 'deals.'], silentErrors: true, successMessage: 'Interaction logged' });
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      dirty={!!summary}
      title="Log interaction"
      description="Record a call, meeting or e-mail that happened outside Castlane."
      size="small"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={summary.trim().length < 3 || !kind || !when}
            loading={log.isPending}
            onClick={async () => {
              setError(null);
              try {
                await log.run({ params: { workspaceId: workspace.id, partnerId: partner.id }, body: { occurredAt: new Date(when).toISOString(), kind: kind as never, summary: summary.trim(), dealId: deal } });
                setSummary('');
                onOpenChange(false);
              } catch (e) {
                setError(isApiError(e) ? (e.fieldErrors[0]?.message ?? e.message) : 'The interaction could not be logged.');
              }
            }}
          >
            Log Interaction
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <Field label="Type" required>
          <Select value={kind} onChange={setKind} options={PARTNER_INTERACTION_KINDS.map((k) => ({ value: k, label: label('interactionKind', k) }))} />
        </Field>
        <Field label="When" required>
          <DateTimeInput value={when} onChange={(e) => setWhen(e.target.value)} timezone={user.timezone} />
        </Field>
        {!dealId && partner.deals?.length ? (
          <Field label="Deal">
            <Select value={deal} onChange={setDeal} clearable options={partner.deals.map((d) => ({ value: d.id, label: d.title }))} />
          </Field>
        ) : null}
        <Field label="Summary" required>
          <Textarea value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={LIMITS.noteMax} />
        </Field>
      </div>
    </Dialog>
  );
};

const MergeDialog = ({ partner, open, onOpenChange, onMerged }: { partner: PartnerDetail; open: boolean; onOpenChange: (o: boolean) => void; onMerged: () => void }) => {
  const { workspace } = useWorkspace();
  const [target, setTarget] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const preview = useApiQuery(partnerEndpoints.mergePreview, { params: { workspaceId: workspace.id, partnerId: partner.id }, query: { targetId: target ?? '' } }, { enabled: open && !!target, retry: false });
  const merge = useApiMutation(partnerEndpoints.merge, { invalidate: ['partners.', 'deals.'], silentErrors: true });
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setTarget(null);
          setError(null);
        }
        onOpenChange(o);
      }}
      title={`Merge ${partner.name} into another partner`}
      description="Deals and interactions move to the partner you choose. This partner is archived as merged and kept for history."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="danger"
            disabled={!preview.data}
            loading={merge.isPending}
            onClick={async () => {
              setError(null);
              try {
                const r = await merge.run({ params: { workspaceId: workspace.id, partnerId: partner.id }, body: { targetId: target!, previewToken: preview.data!.previewToken } }, { ifMatch: partner.rowVersion });
                toast.success(`Merged into ${r.name}`);
                onOpenChange(false);
                onMerged();
              } catch (e) {
                setError(isApiError(e) ? e.message : 'The partners could not be merged.');
                void preview.refetch();
              }
            }}
          >
            Merge Partners
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Merge into" required>
          <EntitySelect type="partner" value={target} onChange={setTarget} />
        </Field>
        {preview.isFetching ? <Spinner label="Preparing preview" /> : null}
        {preview.error ? <Banner tone="danger">{preview.error.message}</Banner> : null}
        {preview.data ? (
          <div className="flex flex-col gap-3 text-[13px]">
            <p>
              Moves {preview.data.moves.deals} deal(s) and {preview.data.moves.interactions} interaction(s) to <span className="font-medium">{preview.data.target.name}</span>.
            </p>
            {preview.data.differences.length ? (
              <table className="w-full border-collapse text-left">
                <caption className="sr-only">Field differences</caption>
                <thead>
                  <tr className="border-b border-line text-fg-2">
                    <th scope="col" className="py-1 pr-2 font-[550]">Field</th>
                    <th scope="col" className="py-1 pr-2 font-[550]">{partner.name}</th>
                    <th scope="col" className="py-1 font-[550]">{preview.data.target.name} (kept)</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.data.differences.map((d) => (
                    <tr key={d.field} className="border-b border-line last:border-b-0">
                      <td className="py-1 pr-2">{d.field}</td>
                      <td className="py-1 pr-2 text-fg-2">{d.source ?? '—'}</td>
                      <td className="py-1">{d.target ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-fg-2">No field differences.</p>
            )}
            <p className="text-fg-2">Empty contact fields of the kept partner are filled from this one; tags are combined.</p>
          </div>
        ) : null}
        {error ? <Banner tone="danger">{error}</Banner> : null}
      </div>
    </Dialog>
  );
};

const PartnerForm = ({ partner, onClose, onSaved }: { partner?: PartnerDetail; onClose: () => void; onSaved: (id: string) => void }) => {
  const { workspace, membershipId } = useWorkspace();
  const [error, setError] = useState<string | null>(null);
  const valuesOf = (partner: PartnerDetail): FormValues => ({
    kind: partner.kind,
    name: partner.name,
    contactName: partner.contactName ?? '',
    businessEmail: partner.businessEmail ?? '',
    website: partner.website ?? '',
    ownerMembershipId: partner.owner.membershipId,
    tags: partner.tags.join(', '),
    notes: partner.notes ?? '',
    logoAssetId: partner.logoAssetId,
  });
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: partner
      ? valuesOf(partner)
      : { kind: 'organization', name: '', ownerMembershipId: membershipId, logoAssetId: null },
  });
  // The partner as the form opened; only the fields changed since then are sent (T162).
  const edit = useEditBase(partner, { onReload: (x) => form.reset(valuesOf(x)) });
  const create = useApiMutation(partnerEndpoints.create, { invalidate: ['partners.'], silentErrors: true, successMessage: 'Partner added' });
  const update = useApiMutation(partnerEndpoints.update, { invalidate: ['partners.', 'deals.'], silentErrors: true, successMessage: 'Partner saved' });
  const logo = form.watch('logoAssetId');
  const errors = form.formState.errors;
  const onSubmit = form.handleSubmit(async (v) => {
    setError(null);
    const bodyOf = (v: FormValues) => ({
      kind: v.kind,
      name: v.name.trim(),
      contactName: v.contactName?.trim() || null,
      businessEmail: v.businessEmail?.trim() || null,
      website: v.website?.trim() || null,
      ownerMembershipId: v.ownerMembershipId,
      tags: (v.tags ?? '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      notes: v.notes?.trim() || null,
      logoAssetId: v.logoAssetId,
    });
    const body = bodyOf(v);
    try {
      if (partner) {
        const changed = changedFields(bodyOf(valuesOf(edit.start ?? partner)), body);
        await update.run({ params: { workspaceId: workspace.id, partnerId: partner.id }, body: pickChanged(body, changed) }, { ifMatch: edit.version });
        onSaved(partner.id);
      } else {
        const r = await create.run({ params: { workspaceId: workspace.id }, body });
        onSaved(r.id);
      }
    } catch (e) {
      if (edit.catchConflict(e)) return;
      if (!applyFieldErrors(e, form.setError as never)) setError(isApiError(e) ? e.message : 'The partner could not be saved.');
    }
  });
  const pending = create.isPending || update.isPending;
  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      dirty={form.formState.isDirty}
      title={partner ? `Edit ${partner.name}` : 'Add partner'}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" loading={pending} onClick={() => void onSubmit()}>
            {partner ? 'Save Changes' : 'Add Partner'}
          </Button>
        </>
      }
    >
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <Field label="Type" required>
          <Controller
            control={form.control}
            name="kind"
            render={({ field }) => <RadioGroup label="Type" orientation="horizontal" value={field.value} onValueChange={field.onChange} options={PARTNER_KINDS.map((k) => ({ value: k, label: label('partnerKind', k) }))} />}
          />
        </Field>
        <Field label="Name" required error={errors.name?.message}>
          <Input {...form.register('name')} maxLength={120} />
        </Field>
        <Field label="Contact Name" error={errors.contactName?.message}>
          <Input {...form.register('contactName')} maxLength={120} />
        </Field>
        <Field label="Business Email" error={errors.businessEmail?.message} helper="Stored for the team; Castlane never e-mails partners.">
          <Input {...form.register('businessEmail')} type="email" inputMode="email" autoComplete="off" />
        </Field>
        <Field label="Website" error={errors.website?.message}>
          <Input {...form.register('website')} inputMode="url" placeholder="https://" />
        </Field>
        <Field label="Owner" required error={errors.ownerMembershipId?.message}>
          <Controller control={form.control} name="ownerMembershipId" render={({ field }) => <MemberSelect value={field.value} onChange={(v) => field.onChange(v ?? '')} />} />
        </Field>
        <Field label="Tags" helper="Comma-separated, up to 30.">
          <Input {...form.register('tags')} />
        </Field>
        <Field label="Notes">
          <Textarea {...form.register('notes')} maxLength={LIMITS.noteMax} />
        </Field>
        <div className="flex flex-col gap-2">
          <span className="text-[12px] font-[550] text-fg">Logo</span>
          <p className="text-[12px] text-fg-2">Upload a logo yourself; logos are never downloaded automatically.</p>
          {logo ? (
            <div className="flex items-center gap-3">
              <AssetThumb workspaceId={workspace.id} assetId={logo} size={64} alt="Partner logo" className="h-10 w-10 object-cover" />
              <Button size="sm" variant="ghost" onClick={() => form.setValue('logoAssetId', null, { shouldDirty: true })}>
                Remove Logo
              </Button>
            </div>
          ) : null}
          <FileUploader
            workspaceId={workspace.id}
            purpose="logo"
            target={partner ? { entityType: 'partner', entityId: partner.id, role: 'logo' } : undefined}
            accept="image/jpeg,image/png,image/webp"
            multiple={false}
            label="Upload Logo"
            compact
            onUploaded={(i) => i.assetId && form.setValue('logoAssetId', i.assetId, { shouldDirty: true })}
          />
        </div>
      </form>
      <ConflictDialog {...edit.conflictDialog} />
    </Drawer>
  );
};
