'use client';
import { Plus } from '@phosphor-icons/react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ofmEndpoints as E, type OfmContactDetail, type OfmInteraction } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { CONTACT_STAGE_TRANSITIONS, INTERACTION_TYPES } from '@castlane/domain';
import {
  Avatar,
  Badge,
  Banner,
  Button,
  DateTimeInput,
  DescriptionList,
  Dialog,
  Field,
  Input,
  PageHeader,
  Panel,
  Select,
  Switch,
  Textarea,
  formatDateTime,
  formatMoney,
  type MenuItem,
} from '@castlane/ui';
import { ConflictDialog } from '@/components/common/conflict';
import { EntitySelect } from '@/components/common/entity-select';
import { MemberSelect } from '@/components/common/pickers';
import { QueryState } from '@/components/common/query-state';
import { useApiInfinite, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useWorkspace, useWsPath } from '@/lib/workspace-context';
import { AccountChip, MemberChip, OfmNav, ReasonDialog, errorMessage, fromLocalInput, runAction, toLocalInput, useOfmMutation } from './common';
import { ContactMenu, MergeDialog, PRIVACY_NOTE } from './contacts-screen';
import { InteractionDialog, OperationDetailDrawer, OperationDrawer, OperationRow, SaleCandidateDrawer, SaleCandidateList } from './operation-dialogs';

type Dlg = 'edit' | 'stage' | 'merge' | 'relate' | 'archive' | 'erase' | 'interaction' | 'followUp' | 'request' | 'sale' | 'linkSale' | null;

/** S46 Contact Workspace: manual records of one contact — notes, interactions, requests, follow-ups and sale links. */
export const ContactWorkspace = ({ contactId }: { contactId: string }) => {
  const { workspace, user } = useWorkspace();
  const wsPath = useWsPath();
  const router = useRouter();
  const mergedFrom = useSearchParams().get('mergedFrom');
  const q = useApiQuery(E.getContact, { params: { workspaceId: workspace.id, contactId } });
  const [dlg, setDlg] = useState<Dlg>(null);
  const [openOp, setOpenOp] = useState<string | null>(null);
  const restore = useOfmMutation(E.restoreContact, { successMessage: 'Contact restored' });
  const archive = useOfmMutation(E.archiveContact, { successMessage: 'Contact archived' });
  const erase = useOfmMutation(E.requestErasure, { successMessage: 'Erasure queued' });
  const c = q.data;

  useEffect(() => {
    if (c?.mergedIntoId) router.replace(wsPath(`/ofm/contacts/${c.mergedIntoId}?mergedFrom=${c.id}`));
  }, [c?.mergedIntoId, c?.id, router, wsPath]);

  const menu: MenuItem[] = c
    ? [
        { label: 'Edit', onSelect: () => setDlg('edit'), hidden: !c.permissions.edit },
        { label: 'Change Stage', onSelect: () => setDlg('stage'), hidden: !c.permissions.changeStage },
        { label: 'Merge Into…', onSelect: () => setDlg('merge'), hidden: !c.permissions.merge },
        { label: 'Relate to Contact', onSelect: () => setDlg('relate'), hidden: !c.permissions.relate },
        { label: 'Restore', onSelect: () => void runAction(() => restore.run({ params: { workspaceId: workspace.id, contactId: c.id } }, { ifMatch: c.rowVersion })), hidden: !c.permissions.archive || !c.archivedAt || !!c.erasedAt },
        { label: 'Archive', onSelect: () => setDlg('archive'), hidden: !c.permissions.archive || !!c.archivedAt, separatorBefore: true },
        { label: 'Request Erasure', destructive: true, onSelect: () => setDlg('erase'), hidden: !c.permissions.erase },
      ]
    : [];

  return (
    <QueryState query={q}>
      {c && !c.mergedIntoId ? (
        <div className="flex flex-col gap-5">
          <PageHeader
            crumbs={[{ label: 'OFM', href: wsPath('/ofm') }, { label: 'Contacts', href: wsPath('/ofm/contacts') }, { label: c.alias }]}
            title={
              <span className="inline-flex items-center gap-3">
                <Avatar name={c.alias} size={40} decorative />
                {c.alias}
              </span>
            }
            meta={
              <>
                <Badge>{c.stageLabel}</Badge>
                {c.restricted ? <Badge tone="warning">Restricted</Badge> : null}
                {c.archivedAt ? <Badge tone="warning">Archived</Badge> : null}
                {c.erasedAt ? <Badge tone="danger">Erased</Badge> : null}
              </>
            }
            description="A journal of manual records, not a platform inbox. Stages are descriptive — no scores are computed."
            actions={
              <>
                {c.permissions.logInteraction ? (
                  <Button variant="primary" onClick={() => setDlg('interaction')}>
                    Log Interaction
                  </Button>
                ) : null}
                {menu.some((m) => !m.hidden) ? <ContactMenu items={menu} /> : null}
              </>
            }
          />
          <OfmNav />
          {mergedFrom ? <Banner tone="info">The contact you opened was merged into this one. Its history now appears here.</Banner> : null}
          {c.archivedAt && c.retentionDeleteAfter ? (
            <Banner tone="info">Archived. Business notes are deleted after {formatDateTime(c.retentionDeleteAfter, user.timezone)} under the retention policy.</Banner>
          ) : null}
          {c.erasureRequests.some((e) => e.state === 'queued' || e.state === 'running') ? <Banner tone="warning">An erasure request is being processed.</Banner> : null}
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
            <div className="flex min-w-0 flex-col gap-5">
              <Panel title="Business Notes" actions={c.permissions.edit ? <Button size="sm" onClick={() => setDlg('edit')}>Edit</Button> : undefined}>
                {c.businessNotes ? <p className="whitespace-pre-wrap text-[14px] leading-[22px] text-fg">{c.businessNotes}</p> : <p className="text-[13px] text-fg-2">No business notes.</p>}
              </Panel>
              <InteractionsPanel contact={c} />
              <Panel
                title="Requests and Follow-ups"
                actions={
                  c.permissions.createOperation ? (
                    <div className="flex gap-2">
                      <Button size="sm" icon={<Plus size={14} />} onClick={() => setDlg('followUp')}>
                        Create Follow-up
                      </Button>
                      <Button size="sm" icon={<Plus size={14} />} onClick={() => setDlg('request')}>
                        Register Request
                      </Button>
                    </div>
                  ) : undefined
                }
              >
                {c.operations.length ? (
                  <ul className="flex flex-col divide-y divide-line rounded-[12px] border border-line">
                    {c.operations.map((o) => (
                      <OperationRow key={o.id} op={o} onOpen={() => setOpenOp(o.id)} />
                    ))}
                  </ul>
                ) : (
                  <p className="text-[13px] text-fg-2">No requests or follow-ups.</p>
                )}
              </Panel>
              {c.saleCandidates ? (
                <Panel
                  title="Linked Financial References"
                  description="Sale candidates stay Pending Verification until Finance confirms them."
                  actions={
                    c.permissions.linkSale ? (
                      <div className="flex gap-2">
                        <Button size="sm" onClick={() => setDlg('linkSale')}>
                          Link Sale Candidate
                        </Button>
                        <Button size="sm" icon={<Plus size={14} />} onClick={() => setDlg('sale')}>
                          Register
                        </Button>
                      </div>
                    ) : undefined
                  }
                >
                  <SaleCandidateList items={c.saleCandidates} empty="No sale candidates linked." />
                </Panel>
              ) : null}
            </div>
            <div className="flex min-w-0 flex-col gap-5">
              <Panel title="Details">
                <DescriptionList
                  columns={1}
                  items={[
                    { label: 'Account', value: <AccountChip account={c.account} /> },
                    { label: 'Model', value: c.project.name },
                    { label: 'External Identifier', value: <span className="font-mono text-[13px]">{c.externalIdentifier}</span> },
                    { label: 'Manager', value: <MemberChip member={c.manager} /> },
                    { label: 'Stage', value: c.stageLabel },
                    { label: 'Last Activity', value: c.lastActivityAt ? formatDateTime(c.lastActivityAt, user.timezone) : null },
                    { label: 'Next Follow-up', value: c.nextFollowUpAt ? formatDateTime(c.nextFollowUpAt, user.timezone) : null },
                    {
                      label: 'Confirmed Spend',
                      value: c.confirmedSpend?.length ? c.confirmedSpend.map((s) => formatMoney(s.amount, s.currency)).join(', ') : 'None confirmed',
                      hidden: c.confirmedSpend === undefined,
                    },
                  ]}
                />
              </Panel>
              <Panel title="Relations" description="Explicit links to contacts of other accounts. They do not mean the same person.">
                {c.relations.length ? (
                  <ul className="flex flex-col gap-2 text-[13px]">
                    {c.relations.map((r) => (
                      <li key={r.id}>
                        {r.contact.restricted ? (
                          <span className="text-fg-2">Restricted contact</span>
                        ) : (
                          <a className="font-medium hover:underline" href={wsPath(`/ofm/contacts/${r.contact.id}`)}>
                            {r.contact.alias}
                          </a>
                        )}
                        {r.account ? <span className="text-fg-2"> · {r.account.label}</span> : null}
                        <p className="text-[12px] text-fg-2">{r.reason}</p>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-[13px] text-fg-2">No relations.</p>
                )}
              </Panel>
              {c.erasureRequests.length ? (
                <Panel title="Erasure Requests">
                  <ul className="flex flex-col gap-2 text-[13px]">
                    {c.erasureRequests.map((e) => (
                      <li key={e.id}>
                        <Badge tone={e.state === 'completed' ? 'success' : e.state === 'failed' ? 'danger' : 'warning'}>{label('erasureState', e.state)}</Badge>
                        <p className="text-[12px] text-fg-2">
                          {formatDateTime(e.createdAt, user.timezone)} · {e.reason}
                        </p>
                      </li>
                    ))}
                  </ul>
                </Panel>
              ) : null}
            </div>
          </div>
          {dlg === 'edit' ? <EditContactDialog contact={c} onClose={() => setDlg(null)} /> : null}
          {dlg === 'stage' ? <StageDialog contact={c} onClose={() => setDlg(null)} /> : null}
          {dlg === 'merge' ? <MergeDialog sourceId={c.id} accountId={c.account.id} onClose={(t) => (setDlg(null), t ? router.push(wsPath(`/ofm/contacts/${t}`)) : undefined)} /> : null}
          {dlg === 'relate' ? <RelateDialog contact={c} onClose={() => setDlg(null)} /> : null}
          {dlg === 'interaction' ? <InteractionDialog contactId={c.id} onClose={() => setDlg(null)} /> : null}
          {dlg === 'followUp' || dlg === 'request' ? (
            <OperationDrawer preset={{ accountId: c.account.id, contactId: c.id, type: dlg === 'followUp' ? 'follow_up' : 'content_request' }} onClose={() => setDlg(null)} />
          ) : null}
          {dlg === 'sale' ? <SaleCandidateDrawer preset={{ accountId: c.account.id, contactId: c.id }} onClose={() => setDlg(null)} /> : null}
          {dlg === 'linkSale' ? <LinkSaleDialog contact={c} onClose={() => setDlg(null)} /> : null}
          <ReasonDialog
            open={dlg === 'archive'}
            onOpenChange={(o) => !o && setDlg(null)}
            title="Archive contact?"
            body="The contact leaves active lists. Business notes are deleted after the retention period (180 days by default). Financial references stay."
            confirmLabel="Archive"
            destructive
            onConfirm={(reason) => archive.run({ params: { workspaceId: workspace.id, contactId: c.id }, body: { reason } }, { ifMatch: c.rowVersion })}
          />
          <ReasonDialog
            open={dlg === 'erase'}
            onOpenChange={(o) => !o && setDlg(null)}
            title="Request erasure?"
            body="Personal notes, interactions and the alias are erased by a background job. Required financial references stay, pseudonymised. This cannot be undone."
            confirmLabel="Request Erasure"
            destructive
            onConfirm={(reason) => erase.run({ params: { workspaceId: workspace.id, contactId: c.id }, body: { reason } })}
          />
          {openOp ? <OperationDetailDrawer id={openOp} onClose={() => setOpenOp(null)} /> : null}
        </div>
      ) : null}
    </QueryState>
  );
};

const InteractionsPanel = ({ contact }: { contact: OfmContactDetail }) => {
  const { workspace, user } = useWorkspace();
  const data = useApiInfinite(E.listInteractions, { params: { workspaceId: workspace.id }, query: { contactId: contact.id } });
  const [editing, setEditing] = useState<OfmInteraction | null>(null);
  return (
    <Panel title="Interactions" description="Entered by people. Castlane does not read platform messages.">
      <QueryState query={data}>
        {data.items.length ? (
          <ul className="flex flex-col gap-3">
            {data.items.map((i) => (
              <li key={i.id} className="flex flex-col gap-1 border-b border-line pb-3 last:border-0 last:pb-0">
                <div className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-fg-2">
                  <span className="inline-flex items-center gap-2">
                    <Badge>{label('interactionType', i.type)}</Badge>
                    {formatDateTime(i.occurredAt, user.timezone)} · {i.member.displayName}
                    {i.edited ? ' · edited' : ''}
                  </span>
                  {i.canEdit && !i.erasedAt ? (
                    <Button size="sm" variant="ghost" onClick={() => setEditing(i)}>
                      Edit
                    </Button>
                  ) : null}
                </div>
                <p className="whitespace-pre-wrap text-[14px] leading-[22px] text-fg">{i.erasedAt ? <span className="text-fg-muted">Erased</span> : i.businessNote}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[13px] text-fg-2">No interactions logged.</p>
        )}
        {data.hasNextPage ? (
          <div className="mt-3">
            <Button size="sm" loading={data.isFetchingNextPage} onClick={() => void data.fetchNextPage()}>
              Load More
            </Button>
          </div>
        ) : null}
      </QueryState>
      {editing ? <EditInteractionDialog interaction={editing} onClose={() => setEditing(null)} /> : null}
    </Panel>
  );
};

const EditInteractionDialog = ({ interaction, onClose }: { interaction: OfmInteraction; onClose: () => void }) => {
  const { workspace, user } = useWorkspace();
  const [type, setType] = useState(interaction.type);
  const [when, setWhen] = useState(toLocalInput(interaction.occurredAt, user.timezone));
  const [note, setNote] = useState(interaction.businessNote);
  const [error, setError] = useState<string | null>(null);
  const m = useOfmMutation(E.updateInteraction, { successMessage: 'Interaction updated' });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Edit interaction"
      dirty={note !== interaction.businessNote}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!note.trim() || !when}
            loading={m.isPending}
            onClick={async () => {
              setError(null);
              try {
                await m.run(
                  { params: { workspaceId: workspace.id, interactionId: interaction.id }, body: { type, occurredAt: fromLocalInput(when, user.timezone) ?? undefined, businessNote: note.trim() } },
                  { ifMatch: interaction.rowVersion },
                );
                onClose();
              } catch (e) {
                setError(errorMessage(e));
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
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Type">
            <Select value={type} onChange={(t) => t && setType(t)} options={INTERACTION_TYPES.map((t) => ({ value: t, label: label('interactionType', t) }))} />
          </Field>
          <Field label="Occurred At">
            <DateTimeInput timezone={user.timezone} value={when} onChange={(e) => setWhen(e.target.value)} />
          </Field>
        </div>
        <Field label="Business Note" required>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={5} maxLength={20000} />
        </Field>
      </div>
    </Dialog>
  );
};

const EditContactDialog = ({ contact, onClose }: { contact: OfmContactDetail; onClose: () => void }) => {
  const { workspace, user } = useWorkspace();
  const [alias, setAlias] = useState(contact.alias);
  const [manager, setManager] = useState<string | null>(contact.manager?.membershipId ?? null);
  const [notes, setNotes] = useState(contact.businessNotes ?? '');
  const [follow, setFollow] = useState(toLocalInput(contact.nextFollowUpAt, user.timezone));
  const [restricted, setRestricted] = useState(contact.restricted);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const m = useOfmMutation(E.updateContact, { successMessage: 'Contact updated' });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Edit contact"
      description={PRIVACY_NOTE}
      dirty
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={alias.trim().length < 2}
            loading={m.isPending}
            onClick={async () => {
              setError(null);
              try {
                await m.run(
                  {
                    params: { workspaceId: workspace.id, contactId: contact.id },
                    body: {
                      alias: alias.trim(),
                      managerMembershipId: manager,
                      businessNotes: notes.trim() ? notes : null,
                      nextFollowUpAt: follow ? fromLocalInput(follow, user.timezone) : null,
                      restricted: contact.permissions.restrict ? restricted : undefined,
                    },
                  },
                  { ifMatch: contact.rowVersion },
                );
                onClose();
              } catch (e) {
                if (isApiError(e) && e.code === 'VERSION_CONFLICT') setConflict(true);
                else setError(errorMessage(e));
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
        <Field label="Alias" required>
          <Input value={alias} onChange={(e) => setAlias(e.target.value)} maxLength={120} />
        </Field>
        <Field label="Manager">
          <MemberSelect value={manager} onChange={setManager} clearable />
        </Field>
        <Field label="Next Follow-up">
          <DateTimeInput timezone={user.timezone} value={follow} onChange={(e) => setFollow(e.target.value)} />
        </Field>
        <Field label="Business Notes" helper={PRIVACY_NOTE}>
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={6} maxLength={20000} />
        </Field>
        {contact.permissions.restrict ? <Switch label="Restricted" description="Only members with contact management rights see this contact." checked={restricted} onCheckedChange={setRestricted} /> : null}
      </div>
      <ConflictDialog open={conflict} onOpenChange={setConflict} onReload={() => window.location.reload()} />
    </Dialog>
  );
};

const StageDialog = ({ contact, onClose }: { contact: OfmContactDetail; onClose: () => void }) => {
  const { workspace } = useWorkspace();
  const options = CONTACT_STAGE_TRANSITIONS[contact.stage].filter((s): s is Exclude<typeof s, 'archived'> => s !== 'archived');
  const [stage, setStage] = useState<(typeof options)[number] | null>(options[0] ?? null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const m = useOfmMutation(E.changeContactStage, { successMessage: 'Stage changed' });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="small"
      title="Change stage"
      description="Stages describe the working relationship. Nothing is scored or inferred."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!stage}
            loading={m.isPending}
            onClick={async () => {
              setError(null);
              try {
                await m.run({ params: { workspaceId: workspace.id, contactId: contact.id }, body: { stage: stage!, reason: reason.trim() || undefined } }, { ifMatch: contact.rowVersion });
                onClose();
              } catch (e) {
                setError(errorMessage(e));
              }
            }}
          >
            Change Stage
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <Field label="Stage" required>
          <Select value={stage} onChange={setStage} options={options.map((s) => ({ value: s, label: label('contactStage', s) }))} />
        </Field>
        <Field label="Reason">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} />
        </Field>
      </div>
    </Dialog>
  );
};

const RelateDialog = ({ contact, onClose }: { contact: OfmContactDetail; onClose: () => void }) => {
  const { workspace } = useWorkspace();
  const [related, setRelated] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const m = useOfmMutation(E.relateContacts, { successMessage: 'Relation added' });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="small"
      title="Relate to contact"
      description="Records that two pseudonymous contacts are related, with a reason. It does not merge identities."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!related || reason.trim().length < 3}
            loading={m.isPending}
            onClick={async () => {
              setError(null);
              try {
                await m.run({ params: { workspaceId: workspace.id, contactId: contact.id }, body: { relatedContactId: related!, reason: reason.trim() } });
                onClose();
              } catch (e) {
                setError(errorMessage(e));
              }
            }}
          >
            Add Relation
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <Field label="Related Contact" required>
          <EntitySelect type="ofm_contact" value={related} onChange={setRelated} />
        </Field>
        <Field label="Reason" required helper="At least 3 characters.">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} />
        </Field>
      </div>
    </Dialog>
  );
};

const LinkSaleDialog = ({ contact, onClose }: { contact: OfmContactDetail; onClose: () => void }) => {
  const { workspace, user } = useWorkspace();
  const list = useApiQuery(E.listSaleCandidates, { params: { workspaceId: workspace.id }, query: { accountId: contact.account.id, state: ['pending'], pageSize: 100 } });
  const [chosen, setChosen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const m = useOfmMutation(E.updateSaleCandidate, { successMessage: 'Sale candidate linked' });
  const options = (list.data?.items ?? [])
    .filter((c) => c.contact?.id !== contact.id)
    .map((c) => ({ value: c.id, label: `${c.sourceNamespace} · ${c.sourceTransactionId}`, description: formatDateTime(c.occurredAt, user.timezone) }));
  const candidate = list.data?.items.find((c) => c.id === chosen);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="small"
      title="Link Sale Candidate"
      description="Link a Pending sale candidate of this account to the contact."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!candidate}
            loading={m.isPending}
            onClick={async () => {
              if (!candidate) return;
              setError(null);
              try {
                await m.run({ params: { workspaceId: workspace.id, candidateId: candidate.id }, body: { contactId: contact.id } }, { ifMatch: candidate.rowVersion });
                onClose();
              } catch (e) {
                setError(errorMessage(e));
              }
            }}
          >
            Link
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <Field label="Sale Candidate" required>
          <Select value={chosen} onChange={setChosen} options={options} placeholder={list.isLoading ? 'Loading…' : 'Choose a candidate'} emptyText="No pending candidates on this account" />
        </Field>
      </div>
    </Dialog>
  );
};
