'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { AddressBook, DotsThree, GitMerge, UserPlus } from '@phosphor-icons/react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { ofmEndpoints as E, type EndpointResponse, type OfmContactSummary } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { CONTACT_STAGES } from '@castlane/domain';
import {
  Avatar,
  Banner,
  Button,
  DataTable,
  DateTimeInput,
  Dialog,
  Drawer,
  EmptyState,
  Field,
  IconButton,
  Input,
  Menu,
  MultiSelect,
  NoResults,
  PageHeader,
  RadioGroup,
  Select,
  Switch,
  Textarea,
  Toolbar,
  formatDateTime,
  formatMoney,
  type Column,
} from '@castlane/ui';
import { EntitySelect } from '@/components/common/entity-select';
import { MemberSelect } from '@/components/common/pickers';
import { QueryState } from '@/components/common/query-state';
import { useDebounced } from '@/components/common/use-debounced';
import { ConflictDialog } from '@/components/common/conflict';
import { useEditBase } from '@/lib/edit-base';
import { applyFieldErrors, useApiInfinite } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';
import { AccountChip, MemberChip, OfmNav, errorMessage, fromLocalInput, toLocalInput, useOfmMutation } from './common';
import { OfmAccountSelect, OfmModelSelect } from './pickers';

type Keys = 'q' | 'projectId' | 'accountId' | 'stage' | 'managerMembershipId' | 'followUp' | 'archived' | 'sort' | 'create' | 'merge';

export const PRIVACY_NOTE = 'Business facts only: no real names, passwords, card numbers or intimate profiles of clients.';

/** S45 OFM Contacts: per-account pseudonymous contacts; the same alias on two accounts is two contacts. */
export const ContactsScreen = () => {
  const { workspace, user } = useWorkspace();
  const can = useCan();
  const router = useRouter();
  const wsPath = useWsPath();
  const { state, set, list } = useUrlState<Keys>({ sort: 'updatedAt' });
  const [q, setQ] = useState(state.q ?? '');
  const dq = useDebounced(q, 300);
  const stages = list('stage') as OfmContactSummary['stage'][];
  const sort = (['updatedAt', 'lastActivityAt', 'nextFollowUpAt', 'alias'].includes(state.sort ?? '') ? state.sort : 'updatedAt') as 'updatedAt' | 'lastActivityAt' | 'nextFollowUpAt' | 'alias';
  const data = useApiInfinite(E.listContacts, {
    params: { workspaceId: workspace.id },
    query: {
      q: dq.trim() || undefined,
      projectId: state.projectId,
      accountId: state.accountId,
      stage: stages.length ? stages : undefined,
      managerMembershipId: state.managerMembershipId,
      followUp: state.followUp as 'due' | 'overdue' | 'none' | undefined,
      includeArchived: state.archived === '1' ? true : undefined,
      sort,
      direction: sort === 'alias' || sort === 'nextFollowUpAt' ? 'asc' : 'desc',
    },
  });
  useEffect(() => {
    if ((state.q ?? '') !== dq.trim()) set({ q: dq.trim() || null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dq]);
  const filtered = !!(dq.trim() || state.projectId || state.accountId || stages.length || state.managerMembershipId || state.followUp || state.archived);
  const write = can('contacts.write');
  const merge = can('contacts.merge');
  const showSpend = data.items.some((c) => c.confirmedSpend !== undefined);
  const [quick, setQuick] = useState<{ contact: OfmContactSummary; kind: 'assign' | 'followUp' } | null>(null);
  const [mergeFrom, setMergeFrom] = useState<OfmContactSummary | null>(null);

  const columns: Column<OfmContactSummary>[] = [
    {
      key: 'alias',
      header: 'Alias',
      sticky: true,
      minWidth: 200,
      cell: (c) => (
        <span className="inline-flex min-w-0 items-center gap-2">
          <Avatar name={c.alias} size={24} decorative />
          <span className="truncate font-medium">{c.alias}</span>
          {c.restricted ? <span className="text-[11px] text-warning">Restricted</span> : null}
        </span>
      ),
    },
    { key: 'account', header: 'Platform Account', minWidth: 180, cell: (c) => <AccountChip account={c.account} /> },
    { key: 'external', header: 'External Identifier', minWidth: 170, cell: (c) => <span className="font-mono text-[12px]">{c.externalIdentifier}</span> },
    { key: 'manager', header: 'Assigned Manager', minWidth: 170, cell: (c) => <MemberChip member={c.manager} /> },
    { key: 'stage', header: 'Stage', minWidth: 120, cell: (c) => c.stageLabel },
    { key: 'last', header: 'Last Activity', minWidth: 150, cell: (c) => (c.lastActivityAt ? formatDateTime(c.lastActivityAt, user.timezone) : '—') },
    {
      key: 'follow',
      header: 'Next Follow-up',
      minWidth: 150,
      cell: (c) => (c.nextFollowUpAt ? <span className={Date.parse(c.nextFollowUpAt) < Date.now() ? 'text-danger' : undefined}>{formatDateTime(c.nextFollowUpAt, user.timezone)}</span> : '—'),
    },
    {
      key: 'spend',
      header: 'Confirmed Spend',
      align: 'right',
      minWidth: 140,
      hidden: !showSpend,
      cell: (c) => (c.confirmedSpend?.length ? c.confirmedSpend.map((s) => formatMoney(s.amount, s.currency)).join(', ') : '—'),
    },
    {
      key: 'actions',
      header: '',
      headerLabel: 'Actions',
      width: 48,
      cell: (c) => {
        const open = !c.archivedAt && !c.mergedIntoId && !c.erasedAt;
        return (
          <span onClick={(e) => e.stopPropagation()}>
            <ContactMenu
              items={[
                { label: 'Open', onSelect: () => router.push(wsPath(`/ofm/contacts/${c.id}`)) },
                { label: 'Assign', onSelect: () => setQuick({ contact: c, kind: 'assign' }), hidden: !write || !open },
                { label: 'Add Follow-up', onSelect: () => setQuick({ contact: c, kind: 'followUp' }), hidden: !write || !open },
                { label: 'Merge Preview', onSelect: () => setMergeFrom(c), hidden: !merge || !open },
              ]}
            />
          </span>
        );
      },
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="OFM Contacts"
        crumbs={[{ label: 'OFM', href: wsPath('/ofm') }, { label: 'Contacts' }]}
        description="Minimal working records of platform clients per account. A manual log — not a platform inbox."
        actions={
          <>
            {write ? (
              <Button variant="primary" icon={<UserPlus size={14} />} onClick={() => set({ create: '1' })}>
                Add Contact
              </Button>
            ) : null}
            {merge ? (
              <Button icon={<GitMerge size={14} />} onClick={() => set({ merge: '1' })}>
                Merge Preview
              </Button>
            ) : null}
          </>
        }
      />
      <OfmNav />
      <Toolbar>
        <div className="w-full sm:w-[240px]">
          <Input type="search" aria-label="Search alias or external identifier" placeholder="Search alias or identifier" value={q} onChange={(e) => setQ(e.target.value)} maxLength={120} />
        </div>
        <div className="w-full sm:w-[180px]">
          <OfmModelSelect aria-label="Model" placeholder="All models" value={state.projectId} onChange={(v) => set({ projectId: v, accountId: null })} clearable />
        </div>
        <div className="w-full sm:w-[180px]">
          <OfmAccountSelect aria-label="Account" placeholder="All accounts" projectId={state.projectId} value={state.accountId} onChange={(v) => set({ accountId: v })} clearable />
        </div>
        <div className="w-full sm:w-[200px]">
          <MultiSelect aria-label="Stage" placeholder="Any stage" value={stages} onChange={(v) => set({ stage: v.join(',') || null })} options={CONTACT_STAGES.map((s) => ({ value: s, label: label('contactStage', s) }))} />
        </div>
        <div className="w-full sm:w-[180px]">
          <MemberSelect aria-label="Manager" placeholder="Any manager" value={state.managerMembershipId} onChange={(v) => set({ managerMembershipId: v })} clearable />
        </div>
        <div className="w-full sm:w-[160px]">
          <Select
            aria-label="Follow-up"
            placeholder="Any follow-up"
            clearable
            value={state.followUp ?? null}
            onChange={(v) => set({ followUp: v })}
            options={[
              { value: 'overdue', label: 'Overdue' },
              { value: 'due', label: 'Due in 7 days' },
              { value: 'none', label: 'No follow-up' },
            ]}
          />
        </div>
        <div className="w-full sm:w-[170px]">
          <Select
            aria-label="Sort"
            value={sort}
            onChange={(v) => set({ sort: v })}
            options={[
              { value: 'updatedAt', label: 'Recently updated' },
              { value: 'lastActivityAt', label: 'Last activity' },
              { value: 'nextFollowUpAt', label: 'Next follow-up' },
              { value: 'alias', label: 'Alias A–Z' },
            ]}
          />
        </div>
        <Switch label="Include archived" checked={state.archived === '1'} onCheckedChange={(c) => set({ archived: c ? '1' : null })} />
      </Toolbar>
      <QueryState query={data}>
        {data.items.length === 0 && !data.isFetching ? (
          filtered ? (
            <NoResults
              onClear={() => {
                setQ('');
                set({ q: null, projectId: null, accountId: null, stage: null, managerMembershipId: null, followUp: null, archived: null });
              }}
            />
          ) : (
            <EmptyState
              icon={<AddressBook size={28} />}
              title="No contacts yet"
              description={write ? 'Add platform clients you work with, one per account.' : 'Contacts of your accounts appear here.'}
              action={write ? <Button variant="primary" onClick={() => set({ create: '1' })}>Add Contact</Button> : undefined}
            />
          )
        ) : (
          <DataTable
            caption="OFM contacts"
            rows={data.items}
            columns={columns}
            getRowId={(c) => c.id}
            density={user.density}
            onRowClick={(c) => router.push(wsPath(`/ofm/contacts/${c.id}`))}
            hasMore={data.hasNextPage}
            loadingMore={data.isFetchingNextPage}
            onLoadMore={() => void data.fetchNextPage()}
          />
        )}
      </QueryState>
      {state.create === '1' ? <ContactDrawer preset={{ accountId: state.accountId }} onClose={(id) => (set({ create: null }), id ? router.push(wsPath(`/ofm/contacts/${id}`)) : undefined)} /> : null}
      {state.merge === '1' ? <MergeDialog onClose={() => set({ merge: null })} /> : null}
      {mergeFrom ? <MergeDialog sourceId={mergeFrom.id} accountId={mergeFrom.account.id} onClose={() => setMergeFrom(null)} /> : null}
      {quick ? <ContactQuickEdit contact={quick.contact} kind={quick.kind} onClose={() => setQuick(null)} /> : null}
    </div>
  );
};

// ——— Add / edit contact ———

const contactSchema = z.object({
  accountId: z.string().uuid('Choose an account.'),
  externalIdentifier: z.string().trim().min(1, 'Enter the identifier used on the platform.').max(200),
  alias: z.string().trim().min(2, 'At least 2 characters.').max(120),
  managerMembershipId: z.string().optional(),
  stage: z.enum(['new', 'active', 'follow_up', 'inactive']),
  businessNotes: z.string().max(20000).optional(),
  nextFollowUpAt: z.string().optional(),
  restricted: z.boolean(),
});
type ContactValues = z.infer<typeof contactSchema>;

export const ContactDrawer = ({ preset, onClose }: { preset?: { accountId?: string }; onClose: (id?: string) => void }) => {
  const { workspace, user } = useWorkspace();
  const can = useCan();
  const form = useForm<ContactValues>({
    resolver: zodResolver(contactSchema),
    defaultValues: { accountId: preset?.accountId ?? '', externalIdentifier: '', alias: '', managerMembershipId: '', stage: 'new', businessNotes: '', nextFollowUpAt: '', restricted: false },
  });
  const [error, setError] = useState<string | null>(null);
  const create = useOfmMutation(E.createContact, { successMessage: 'Contact added' });
  const errs = form.formState.errors;
  const submit = form.handleSubmit(async (v) => {
    setError(null);
    try {
      const res = await create.run({
        params: { workspaceId: workspace.id },
        body: {
          accountId: v.accountId,
          externalIdentifier: v.externalIdentifier.trim(),
          alias: v.alias.trim(),
          managerMembershipId: v.managerMembershipId || null,
          stage: v.stage,
          businessNotes: v.businessNotes?.trim() ? v.businessNotes : null,
          nextFollowUpAt: v.nextFollowUpAt ? fromLocalInput(v.nextFollowUpAt, user.timezone) : null,
          restricted: can('contacts.merge') ? v.restricted : undefined,
        },
      });
      onClose(res.id);
    } catch (e) {
      if (!applyFieldErrors(e, form.setError as never)) setError(errorMessage(e, 'The contact could not be added.'));
    }
  });
  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      title="Add Contact"
      description={PRIVACY_NOTE}
      dirty={form.formState.isDirty && !create.isPending}
      footer={
        <>
          <Button onClick={() => onClose()} disabled={create.isPending}>
            Cancel
          </Button>
          <Button variant="primary" loading={create.isPending} onClick={() => void submit()}>
            Add Contact
          </Button>
        </>
      }
    >
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <Field label="Platform Account" required error={errs.accountId?.message} helper="A contact belongs to exactly one account.">
          <Controller control={form.control} name="accountId" render={({ field }) => <OfmAccountSelect value={field.value} onChange={(a) => field.onChange(a ?? '')} />} />
        </Field>
        <Field label="External Identifier" required error={errs.externalIdentifier?.message} helper="The platform username or ID. Unique per account.">
          <Input {...form.register('externalIdentifier')} maxLength={200} autoComplete="off" />
        </Field>
        <Field label="Alias" required error={errs.alias?.message} helper="A working pseudonym, not a real name.">
          <Input {...form.register('alias')} maxLength={120} autoComplete="off" />
        </Field>
        <Field label="Assigned Manager">
          <Controller control={form.control} name="managerMembershipId" render={({ field }) => <MemberSelect value={field.value} onChange={(m) => field.onChange(m ?? '')} clearable />} />
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Stage" required>
            <Controller
              control={form.control}
              name="stage"
              render={({ field }) => <Select value={field.value} onChange={(s) => s && field.onChange(s)} options={(['new', 'active', 'follow_up', 'inactive'] as const).map((s) => ({ value: s, label: label('contactStage', s) }))} />}
            />
          </Field>
          <Field label="Next Follow-up">
            <DateTimeInput timezone={user.timezone} {...form.register('nextFollowUpAt')} />
          </Field>
        </div>
        <Field label="Business Notes" error={errs.businessNotes?.message} helper={PRIVACY_NOTE}>
          <Textarea {...form.register('businessNotes')} rows={4} maxLength={20000} />
        </Field>
        {can('contacts.merge') ? (
          <Controller
            control={form.control}
            name="restricted"
            render={({ field }) => <Switch label="Restricted" description="Only members with contact management rights see this contact." checked={field.value} onCheckedChange={field.onChange} />}
          />
        ) : null}
      </form>
    </Drawer>
  );
};

// ——— Merge ———

type Preview = EndpointResponse<typeof E.mergePreview>;
type Resolutions = { alias: 'source' | 'target'; managerMembershipId: 'source' | 'target'; stage: 'source' | 'target'; nextFollowUpAt: 'source' | 'target'; businessNotes: 'source' | 'target' | 'both' };
const FIELD_LABEL: Record<Preview['fields'][number]['field'], string> = {
  alias: 'Alias',
  managerMembershipId: 'Manager',
  stage: 'Stage',
  nextFollowUpAt: 'Next Follow-up',
  businessNotes: 'Business Notes',
};

/** Merge Preview → Merge: only contacts of the same account; references move and sales are never duplicated or summed. */
export const MergeDialog = ({ sourceId: presetSource, accountId, onClose }: { sourceId?: string; accountId?: string; onClose: (targetId?: string) => void }) => {
  const { workspace } = useWorkspace();
  const [source, setSource] = useState<string | null>(presetSource ?? null);
  const [target, setTarget] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [res, setRes] = useState<Resolutions>({ alias: 'target', managerMembershipId: 'target', stage: 'target', nextFollowUpAt: 'target', businessNotes: 'both' });
  const [error, setError] = useState<string | null>(null);
  const previewM = useOfmMutation(E.mergePreview);
  const merge = useOfmMutation(E.merge, { successMessage: 'Contacts merged' });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={preview ? 'Merge contacts?' : 'Merge Preview'}
      description={preview ? 'The source contact is archived and redirects to the target. Authors and history are kept.' : 'Choose two contacts of the same account.'}
      size="wide"
      footer={
        preview ? (
          <>
            <Button onClick={() => setPreview(null)} disabled={merge.isPending}>
              Back
            </Button>
            <Button
              variant="danger"
              loading={merge.isPending}
              onClick={async () => {
                setError(null);
                try {
                  const r = await merge.run({ params: { workspaceId: workspace.id }, body: { previewToken: preview.previewToken, fieldResolutions: res } });
                  onClose(r.id);
                } catch (e) {
                  setError(errorMessage(e, 'The merge failed. Nothing was changed.'));
                }
              }}
            >
              Merge Contacts
            </Button>
          </>
        ) : (
          <>
            <Button onClick={() => onClose()}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!source || !target || source === target}
              loading={previewM.isPending}
              onClick={async () => {
                setError(null);
                try {
                  setPreview(await previewM.run({ params: { workspaceId: workspace.id }, body: { sourceId: source!, targetId: target! } }));
                } catch (e) {
                  setError(errorMessage(e, 'The preview could not be built.'));
                }
              }}
            >
              Preview
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        {!preview ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label="Source (will be archived)" required>
              <EntitySelect type="ofm_contact" filters={{ accountId }} value={source} onChange={setSource} disabled={!!presetSource} />
            </Field>
            <Field label="Target (kept)" required>
              <EntitySelect type="ofm_contact" filters={{ accountId }} value={target} onChange={setTarget} />
            </Field>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {[
                { t: 'Source', c: preview.source },
                { t: 'Target', c: preview.target },
              ].map(({ t, c }) => (
                <div key={t} className="rounded-[12px] border border-line p-3 text-[13px]">
                  <p className="text-[12px] font-[550] text-fg-2">{t}</p>
                  <p className="font-medium text-fg">{c.alias}</p>
                  <p className="font-mono text-[12px] text-fg-2">{c.externalIdentifier}</p>
                  <p className="text-fg-2">{c.account.label}</p>
                </div>
              ))}
            </div>
            <p className="text-[13px] text-fg-2">
              Moves {preview.moves.interactions} interaction(s), {preview.moves.operations} operation(s), {preview.moves.saleCandidates} sale candidate(s) and {preview.moves.relations} relation(s) to the target.
              Sale candidates keep their own source transaction IDs; nothing is summed or duplicated.
            </p>
            {preview.fields.filter((f) => f.differs).length ? (
              <section className="flex flex-col gap-3">
                <h3 className="text-[14px] font-semibold text-fg">Differing fields</h3>
                {preview.fields
                  .filter((f) => f.differs)
                  .map((f) => (
                    <div key={f.field} className="flex flex-col gap-1">
                      <RadioGroup
                        label={FIELD_LABEL[f.field]}
                        orientation="horizontal"
                        value={res[f.field]}
                        onValueChange={(v) => setRes({ ...res, [f.field]: v })}
                        options={[
                          { value: 'target', label: `Keep target: ${f.target ?? '—'}` },
                          { value: 'source', label: `Use source: ${f.source ?? '—'}` },
                          ...(f.field === 'businessNotes' ? [{ value: 'both', label: 'Keep both' }] : []),
                        ]}
                      />
                    </div>
                  ))}
              </section>
            ) : (
              <p className="text-[13px] text-fg-2">No differing fields.</p>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
};

/** Row actions shared by list and workspace (assign / follow-up). */
export const ContactQuickEdit = ({ contact, kind, onClose }: { contact: OfmContactSummary; kind: 'assign' | 'followUp'; onClose: () => void }) => {
  const { workspace, user } = useWorkspace();
  const [manager, setManager] = useState<string | null>(contact.manager?.membershipId ?? null);
  const [follow, setFollow] = useState(toLocalInput(contact.nextFollowUpAt, user.timezone));
  const [error, setError] = useState<string | null>(null);
  // `contact` is the row as the dialog opened (T162).
  const edit = useEditBase(contact);
  const m = useOfmMutation(E.updateContact, { successMessage: kind === 'assign' ? 'Manager assigned' : 'Follow-up saved' });
  return (
    <>
      <Dialog
        open
        onOpenChange={(o) => !o && onClose()}
        size="small"
        title={kind === 'assign' ? 'Assign manager' : 'Next follow-up'}
        footer={
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              loading={m.isPending}
              onClick={async () => {
                setError(null);
                try {
                  await m.run(
                    {
                      params: { workspaceId: workspace.id, contactId: contact.id },
                      body: kind === 'assign' ? { managerMembershipId: manager } : { nextFollowUpAt: follow ? fromLocalInput(follow, user.timezone) : null },
                    },
                    { ifMatch: edit.version },
                  );
                  onClose();
                } catch (e) {
                  if (!edit.catchConflict(e)) setError(errorMessage(e));
                }
              }}
            >
              Save
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {error ? <Banner tone="danger">{error}</Banner> : null}
          {kind === 'assign' ? (
            <Field label="Manager">
              <MemberSelect value={manager} onChange={setManager} clearable />
            </Field>
          ) : (
            <Field label="Next Follow-up" helper="Empty clears the follow-up.">
              <DateTimeInput timezone={user.timezone} value={follow} onChange={(e) => setFollow(e.target.value)} />
            </Field>
          )}
        </div>
      </Dialog>
      <ConflictDialog {...edit.conflictDialog} />
    </>
  );
};

export const ContactMenu = ({ items }: { items: Parameters<typeof Menu>[0]['items'] }) => (
  <Menu label="Contact actions" trigger={<IconButton label="Contact actions" icon={<DotsThree size={18} weight="bold" />} />} items={items} />
);
