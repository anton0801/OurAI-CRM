'use client';
import { ChatCircle, DotsThree, FileText, Megaphone, PencilSimple, Plus } from '@phosphor-icons/react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { dealEndpoints, mediaEndpoints, type DealDetail, type DeliverableRow } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { CONTENT_FORMATS, LIMITS } from '@castlane/domain';
import {
  AmountInput,
  Avatar,
  Badge,
  Banner,
  Button,
  ConfirmDialog,
  DataTable,
  DateInput,
  DateTimeInput,
  DescriptionList,
  Dialog,
  Drawer,
  EmptyState,
  Field,
  IconButton,
  Input,
  Menu,
  PageHeader,
  Panel,
  Select,
  StatusBadge,
  Textarea,
  formatDate,
  formatDateTime,
  formatMoney,
  toast,
  type MenuItem,
} from '@castlane/ui';
import { EntitySelect } from '@/components/common/entity-select';
import { MemberSelect } from '@/components/common/pickers';
import { QueryState } from '@/components/common/query-state';
import { FileUploader } from '@/components/media/file-uploader';
import { api } from '@/lib/api';
import { useApiMutation, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { DEAL_PANELS } from '@/lib/slots';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';
import '@/features/slots';
import '@/features/accounts/labels';
import { DealForm } from './deal-form';
import { LogInteractionDialog } from './partner-drawer';

const STAGE_ACTION: Record<string, string> = {
  lead: 'Move to Lead',
  discussing: 'Move to Discussing',
  proposal: 'Move to Proposal',
  negotiation: 'Move to Negotiation',
  won: 'Mark Won',
  delivering: 'Start Delivering',
  fulfilled: 'Close Fulfilled',
  lost: 'Mark Lost',
  cancelled: 'Cancel Deal',
};

const toLocalInput = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

/** S74 Partnership Deal: from proposal to delivered work. A Won deal is not Paid (T138). */
export const DealWorkspace = ({ dealId }: { dealId: string }) => {
  const { workspace, user } = useWorkspace();
  const wsPath = useWsPath();
  const can = useCan();
  const q = useApiQuery(dealEndpoints.get, { params: { workspaceId: workspace.id, dealId } });
  const [editOpen, setEditOpen] = useState(false);
  const [target, setTarget] = useState<DealDetail['stage'] | null>(null);
  const [campaignOpen, setCampaignOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [deliverable, setDeliverable] = useState<DeliverableRow | 'new' | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const archive = useApiMutation(dealEndpoints.archive, { invalidate: ['deals.', 'partners.'], successMessage: 'Deal archived' });
  const restore = useApiMutation(dealEndpoints.restore, { invalidate: ['deals.', 'partners.'], successMessage: 'Deal restored' });

  return (
    <QueryState query={q}>
      {q.data
        ? (() => {
            const d = q.data;
            const archived = !!d.archivedAt;
            const menu: MenuItem[] = [
              ...d.allowedTransitions.map((t) => ({ label: STAGE_ACTION[t] ?? t, destructive: t === 'lost' || t === 'cancelled', onSelect: () => setTarget(t) })),
              { label: 'Create Campaign', icon: <Megaphone size={14} />, onSelect: () => setCampaignOpen(true), hidden: !d.permissions.createCampaign, separatorBefore: true },
              { label: 'Log Interaction', icon: <ChatCircle size={14} />, onSelect: () => setLogOpen(true), hidden: !d.permissions.logInteraction },
              { label: 'Archive Deal', destructive: true, onSelect: () => setArchiveOpen(true), hidden: !d.permissions.archive || archived, separatorBefore: true },
              {
                label: 'Restore Deal',
                onSelect: () => void restore.run({ params: { workspaceId: workspace.id, dealId: d.id }, body: {} }, { ifMatch: d.rowVersion }).catch(() => undefined),
                hidden: !d.permissions.archive || !archived,
              },
            ];
            const panels = DEAL_PANELS.items.filter((p) => !p.visible || p.visible({ dealId: d.id }, can));
            return (
              <div className="flex flex-col gap-5">
                <PageHeader
                  crumbs={[{ label: 'Partners', href: wsPath('/partners?tab=deals') }, { label: d.partner.name, href: wsPath(`/partners?open=${d.partner.id}`) }, { label: d.title }]}
                  title={d.title}
                  meta={
                    <>
                      <StatusBadge status={d.stage} label={label('dealStage', d.stage)} />
                      <Link href={wsPath(`/partners?open=${d.partner.id}`)} className="text-[13px] text-fg-2 hover:underline">
                        {d.partner.name}
                      </Link>
                      <span className="flex items-center gap-1.5 text-[13px] text-fg-2">
                        <Avatar name={d.owner.displayName} src={d.owner.avatarUrl} size={24} decorative /> {d.owner.displayName}
                      </span>
                      {archived ? <StatusBadge status="archived" /> : null}
                    </>
                  }
                  actions={
                    <>
                      {d.permissions.update ? (
                        <Button icon={<PencilSimple size={14} />} onClick={() => setEditOpen(true)}>
                          Edit
                        </Button>
                      ) : null}
                      {menu.some((m) => !m.hidden) ? <Menu label="More actions" trigger={<IconButton label="More actions" icon={<DotsThree size={18} weight="bold" />} variant="secondary" />} items={menu} /> : null}
                    </>
                  }
                />
                {archived ? <Banner tone="info">Archived records remain available in historical reports.</Banner> : null}
                {d.stage === 'won' || d.stage === 'delivering' || d.stage === 'fulfilled' ? (
                  <Banner tone="info">Won does not mean paid. The deal amount is a plan until finance records the income and payment.</Banner>
                ) : null}
                {d.stageReason && (d.stage === 'lost' || d.stage === 'cancelled') ? (
                  <Banner tone="warning">
                    {label('dealStage', d.stage)}: {d.stageReason}
                  </Banner>
                ) : null}
                <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
                  <div className="flex min-w-0 flex-col gap-5">
                    <Panel title="Overview">
                      <DescriptionList
                        columns={3}
                        items={[
                          { label: 'Projects', value: <span className="flex flex-wrap gap-1">{d.projects.map((p) => <Link key={p.id} className="text-primary hover:underline" href={wsPath(`/projects/${p.id}`)}>{p.name}</Link>)}</span> },
                          { label: 'Planned amount', value: d.amount ? formatMoney(d.amount.amount, d.amount.currency) : 'Not provided', hidden: !d.permissions.viewAmounts },
                          { label: 'Expected close', value: d.expectedCloseDate ? formatDate(d.expectedCloseDate) : null },
                          { label: 'Campaign', value: d.campaign ? <Link className="text-primary hover:underline" href={wsPath(`/campaigns/${d.campaign.id}`)}>{d.campaign.name}</Link> : null },
                          { label: 'Outcome', value: d.outcome },
                          { label: 'Closed', value: d.closedAt ? formatDateTime(d.closedAt, user.timezone) : null },
                        ]}
                      />
                    </Panel>
                    <Panel
                      title="Deliverables"
                      description={`${d.deliverables.open} open of ${d.deliverables.total}`}
                      actions={
                        d.permissions.manageDeliverables ? (
                          <Button size="sm" icon={<Plus size={12} />} onClick={() => setDeliverable('new')}>
                            Add Deliverable
                          </Button>
                        ) : undefined
                      }
                      bodyClassName="p-0"
                    >
                      <DeliverablesTable deal={d} onEdit={(r) => setDeliverable(r)} />
                    </Panel>
                    {d.permissions.viewAmounts ? (
                      <Panel title="Payment schedule" description="Planned dates only — this never records a payment.">
                        {(d.paymentSchedule ?? []).length === 0 ? (
                          <p className="text-[13px] text-fg-2">No planned payment dates.</p>
                        ) : (
                          <ul className="flex flex-col divide-y divide-line">
                            {(d.paymentSchedule ?? []).map((p, i) => (
                              <li key={i} className="flex items-center justify-between py-2 text-[13px]">
                                <span>
                                  {formatDate(p.dueDate)}
                                  {p.note ? <span className="text-fg-2"> · {p.note}</span> : null}
                                </span>
                                <span className="font-mono tabular-nums">{formatMoney(p.amount, p.currency)}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </Panel>
                    ) : null}
                    {panels.map((p) => (
                      <Panel key={p.key} title={p.label}>
                        <p.component dealId={d.id} />
                      </Panel>
                    ))}
                  </div>
                  <div className="flex flex-col gap-5">
                    <DocumentsPanel deal={d} />
                    <Panel
                      title="Interactions"
                      actions={
                        d.permissions.logInteraction ? (
                          <Button size="sm" icon={<ChatCircle size={12} />} onClick={() => setLogOpen(true)}>
                            Log Interaction
                          </Button>
                        ) : undefined
                      }
                    >
                      {d.interactions.length === 0 ? (
                        <p className="text-[13px] text-fg-2">No interactions logged for this deal.</p>
                      ) : (
                        <ol className="flex flex-col divide-y divide-line">
                          {d.interactions.map((i) => (
                            <li key={i.id} className="flex flex-col gap-0.5 py-2 text-[13px]">
                              <span className="flex items-center gap-2">
                                <Badge>{label('interactionKind', i.kind)}</Badge>
                                <span className="text-fg-2">{formatDateTime(i.occurredAt, user.timezone)}</span>
                              </span>
                              <span className="whitespace-pre-wrap">{i.summary}</span>
                              {i.author ? <span className="text-[12px] text-fg-2">{i.author.displayName}</span> : null}
                            </li>
                          ))}
                        </ol>
                      )}
                    </Panel>
                    <Panel title="Stage history">
                      <ol className="flex flex-col divide-y divide-line">
                        {d.stageEvents.map((e) => (
                          <li key={e.id} className="flex flex-col gap-0.5 py-2 text-[13px]">
                            <span className="flex flex-wrap items-center gap-1.5">
                              {e.fromStage ? <StatusBadge status={e.fromStage} label={label('dealStage', e.fromStage)} /> : <span className="text-fg-2">Created as</span>}
                              {e.fromStage ? <span aria-hidden>→</span> : null}
                              <StatusBadge status={e.toStage} label={label('dealStage', e.toStage)} />
                            </span>
                            <span className="text-fg-2">
                              {formatDateTime(e.occurredAt, user.timezone)}
                              {e.actorName ? ` · ${e.actorName}` : ''}
                            </span>
                            {e.reason ? <span>{e.reason}</span> : null}
                          </li>
                        ))}
                      </ol>
                    </Panel>
                  </div>
                </div>
                <Drawer open={editOpen} onOpenChange={setEditOpen} width={760} title={`Edit ${d.title}`}>
                  {editOpen ? <DealForm deal={d} embedded onDone={() => setEditOpen(false)} /> : null}
                </Drawer>
                <StageDialog deal={d} target={target} onClose={() => setTarget(null)} />
                <CampaignDialog deal={d} open={campaignOpen} onOpenChange={setCampaignOpen} />
                <LogInteractionDialog partner={{ id: d.partner.id }} dealId={d.id} open={logOpen} onOpenChange={setLogOpen} />
                {deliverable ? <DeliverableDialog deal={d} deliverable={deliverable === 'new' ? null : deliverable} onClose={() => setDeliverable(null)} /> : null}
                <ConfirmDialog
                  open={archiveOpen}
                  onOpenChange={setArchiveOpen}
                  title="Archive deal?"
                  body="Archived records remain available in historical reports."
                  confirmLabel="Archive Deal"
                  destructive
                  loading={archive.isPending}
                  onConfirm={async () => {
                    try {
                      await archive.run({ params: { workspaceId: workspace.id, dealId: d.id }, body: {} }, { ifMatch: d.rowVersion });
                      setArchiveOpen(false);
                    } catch {
                      /* toast shown */
                    }
                  }}
                />
              </div>
            );
          })()
        : null}
    </QueryState>
  );
};

const DELIVERABLE_ACTIONS: Record<string, { target: DeliverableRow['status']; label: string; reason?: string }[]> = {
  open: [
    { target: 'delivered', label: 'Mark Delivered' },
    { target: 'cancelled', label: 'Cancel', reason: 'Why is it cancelled?' },
  ],
  delivered: [
    { target: 'accepted', label: 'Accept' },
    { target: 'open', label: 'Request Rework', reason: 'What needs to be reworked?' },
    { target: 'cancelled', label: 'Cancel', reason: 'Why is it cancelled?' },
  ],
  accepted: [],
  cancelled: [{ target: 'open', label: 'Reopen', reason: 'Why is it reopened?' }],
};

const DeliverablesTable = ({ deal, onEdit }: { deal: DealDetail; onEdit: (r: DeliverableRow) => void }) => {
  const { workspace, user } = useWorkspace();
  const wsPath = useWsPath();
  const [pending, setPending] = useState<{ row: DeliverableRow; target: DeliverableRow['status']; reason?: string; label: string } | null>(null);
  const [reason, setReason] = useState('');
  const transition = useApiMutation(dealEndpoints.transitionDeliverable, { invalidate: ['deals.'], successMessage: 'Deliverable updated' });
  const rows = deal.deliverableItems.filter((r) => !r.archivedAt);
  const run = async (row: DeliverableRow, target: DeliverableRow['status'], why?: string) => {
    try {
      await transition.run({ params: { workspaceId: workspace.id, deliverableId: row.id }, body: { targetStatus: target, reason: why } }, { ifMatch: row.rowVersion });
      setPending(null);
      setReason('');
    } catch {
      /* toast shown */
    }
  };
  return (
    <>
      <DataTable
        caption="Deliverables"
        rows={rows}
        getRowId={(r) => r.id}
        empty={<EmptyState className="m-4" title="No deliverables yet" description="List what the partner receives: format, account, due date and acceptance criteria." />}
        columns={[
          {
            key: 'title',
            header: 'Deliverable',
            sticky: true,
            minWidth: 200,
            cell: (r) => (
              <span className="flex flex-col">
                <span className="font-medium">{r.title}</span>
                {r.acceptanceCriteria ? <span className="line-clamp-1 text-[12px] text-fg-2">{r.acceptanceCriteria}</span> : null}
              </span>
            ),
          },
          { key: 'format', header: 'Format', minWidth: 110, cell: (r) => (r.format ? label('contentFormat', r.format) : '—') },
          { key: 'where', header: 'Account / Project', minWidth: 160, cell: (r) => (r.account ? (r.account.handle ? `@${r.account.handle}` : label('platform', r.account.platform)) : (r.project?.name ?? '—')) },
          { key: 'due', header: 'Due', minWidth: 140, cell: (r) => (r.dueAt ? formatDateTime(r.dueAt, user.timezone) : '—') },
          {
            key: 'content',
            header: 'Content',
            minWidth: 150,
            cell: (r) =>
              r.contentItem ? (
                <Link className="text-primary hover:underline" href={wsPath(`/content/${r.contentItem.id}`)}>
                  {r.contentItem.title}
                </Link>
              ) : (
                '—'
              ),
          },
          {
            key: 'amount',
            header: 'Agreed',
            align: 'right',
            minWidth: 110,
            hidden: !deal.permissions.viewAmounts,
            cell: (r) => (r.agreedAmount ? formatMoney(r.agreedAmount.amount, r.agreedAmount.currency) : <span className="text-fg-muted">Not provided</span>),
          },
          { key: 'status', header: 'Status', minWidth: 110, cell: (r) => <StatusBadge status={r.status} label={label('deliverableStatus', r.status)} /> },
          {
            key: 'actions',
            header: <span className="sr-only">Actions</span>,
            headerLabel: 'Actions',
            minWidth: 90,
            align: 'right',
            hidden: !deal.permissions.update,
            cell: (r) => {
              const items: MenuItem[] = [
                { label: 'Edit', onSelect: () => onEdit(r), hidden: r.status === 'accepted' || r.status === 'cancelled' },
                ...(DELIVERABLE_ACTIONS[r.status] ?? []).map((a) => ({ label: a.label, onSelect: () => (a.reason ? setPending({ row: r, target: a.target, reason: a.reason, label: a.label }) : void run(r, a.target)) })),
              ];
              return items.some((i) => !i.hidden) ? <Menu label={`Actions for ${r.title}`} trigger={<IconButton label={`Actions for ${r.title}`} icon={<DotsThree size={18} weight="bold" />} />} items={items} /> : null;
            },
          },
        ]}
      />
      <ConfirmDialog
        open={!!pending}
        onOpenChange={(o) => {
          if (!o) {
            setPending(null);
            setReason('');
          }
        }}
        title={pending ? `${pending.label}: ${pending.row.title}` : ''}
        body="The change is recorded in the deal history."
        confirmLabel={pending?.label ?? 'Confirm'}
        loading={transition.isPending}
        confirmDisabled={reason.trim().length < 3}
        onConfirm={() => pending && void run(pending.row, pending.target, reason.trim())}
      >
        <Field label={pending?.reason ?? 'Reason'} required>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} />
        </Field>
      </ConfirmDialog>
    </>
  );
};

const DeliverableDialog = ({ deal, deliverable, onClose }: { deal: DealDetail; deliverable: DeliverableRow | null; onClose: () => void }) => {
  const { workspace, user } = useWorkspace();
  const [title, setTitle] = useState(deliverable?.title ?? '');
  const [format, setFormat] = useState<string | null>(deliverable?.format ?? null);
  const [projectId, setProjectId] = useState<string | null>(deliverable?.project?.id ?? (deal.projects.length === 1 ? deal.projects[0]!.id : null));
  const [accountId, setAccountId] = useState<string | null>(deliverable?.account?.id ?? null);
  const [dueAt, setDueAt] = useState(toLocalInput(deliverable?.dueAt ?? null));
  const [criteria, setCriteria] = useState(deliverable?.acceptanceCriteria ?? '');
  const [contentItemId, setContentItemId] = useState<string | null>(deliverable?.contentItem?.id ?? null);
  const [amount, setAmount] = useState(deliverable?.agreedAmount?.amount ?? '');
  const currency = deliverable?.agreedAmount?.currency ?? deal.amount?.currency ?? workspace.baseCurrency;
  const [error, setError] = useState<string | null>(null);
  const create = useApiMutation(dealEndpoints.createDeliverable, { invalidate: ['deals.'], silentErrors: true, successMessage: 'Deliverable added' });
  const update = useApiMutation(dealEndpoints.updateDeliverable, { invalidate: ['deals.'], silentErrors: true, successMessage: 'Deliverable saved' });
  const amountValid = !amount || /^\d+(\.\d{1,3})?$/.test(amount.trim());
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      dirty={title !== (deliverable?.title ?? '')}
      title={deliverable ? `Edit ${deliverable.title}` : 'Add deliverable'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={title.trim().length < 2 || !amountValid}
            loading={create.isPending || update.isPending}
            onClick={async () => {
              setError(null);
              const body = {
                title: title.trim(),
                format: (format as never) ?? null,
                projectId,
                accountId,
                dueAt: dueAt ? new Date(dueAt).toISOString() : null,
                acceptanceCriteria: criteria.trim() || null,
                contentItemId,
                ...(deal.permissions.editAmounts ? { agreedAmount: amount.trim() ? { amount: amount.trim(), currency } : null } : {}),
              };
              try {
                if (deliverable) await update.run({ params: { workspaceId: workspace.id, deliverableId: deliverable.id }, body }, { ifMatch: deliverable.rowVersion });
                else await create.run({ params: { workspaceId: workspace.id, dealId: deal.id }, body });
                onClose();
              } catch (e) {
                setError(isApiError(e) ? (e.code === 'VERSION_CONFLICT' ? 'This record changed while you were editing it. Compare changes before saving.' : (e.fieldErrors[0]?.message ?? e.message)) : 'The deliverable could not be saved.');
              }
            }}
          >
            {deliverable ? 'Save' : 'Add Deliverable'}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {error ? <Banner tone="danger" className="sm:col-span-2">{error}</Banner> : null}
        <Field label="Title" required className="sm:col-span-2">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
        </Field>
        <Field label="Format">
          <Select value={format} onChange={setFormat} clearable options={CONTENT_FORMATS.map((f) => ({ value: f, label: label('contentFormat', f) }))} />
        </Field>
        <Field label="Project">
          <Select
            value={projectId}
            onChange={(v) => {
              setProjectId(v);
              setAccountId(null);
              setContentItemId(null);
            }}
            clearable
            options={deal.projects.map((p) => ({ value: p.id, label: p.name }))}
          />
        </Field>
        <Field label="Account" helper="Account of the chosen project where it will be published.">
          <EntitySelect type="account" filters={projectId ? { projectId } : undefined} value={accountId} onChange={setAccountId} clearable disabled={!projectId} />
        </Field>
        <Field label="Due">
          <DateTimeInput value={dueAt} onChange={(e) => setDueAt(e.target.value)} timezone={user.timezone} />
        </Field>
        <Field label="Linked content" className="sm:col-span-2">
          <EntitySelect type="content_item" filters={projectId ? { projectId } : undefined} value={contentItemId} onChange={setContentItemId} clearable disabled={!projectId} />
        </Field>
        <Field label="Acceptance criteria" className="sm:col-span-2">
          <Textarea value={criteria} onChange={(e) => setCriteria(e.target.value)} maxLength={LIMITS.noteMax} />
        </Field>
        {deal.permissions.editAmounts ? (
          <Field label="Agreed amount" error={amountValid ? null : 'Enter an amount like 250.00.'} helper="A plan, not revenue.">
            <AmountInput value={amount} onChange={(e) => setAmount(e.target.value)} currency={currency} />
          </Field>
        ) : null}
      </div>
    </Dialog>
  );
};

const StageDialog = ({ deal, target, onClose }: { deal: DealDetail; target: DealDetail['stage'] | null; onClose: () => void }) => {
  const { workspace } = useWorkspace();
  const [reason, setReason] = useState('');
  const [outcome, setOutcome] = useState('');
  const [error, setError] = useState<string | null>(null);
  const transition = useApiMutation(dealEndpoints.transition, { invalidate: ['deals.', 'partners.'], silentErrors: true });
  if (!target) return null;
  const needsReason = target === 'lost' || target === 'cancelled' || deal.stage === 'lost';
  const withOutcome = target === 'won' || target === 'fulfilled';
  return (
    <ConfirmDialog
      open={!!target}
      onOpenChange={(o) => {
        if (!o) {
          setReason('');
          setOutcome('');
          setError(null);
          onClose();
        }
      }}
      title={`${STAGE_ACTION[target] ?? 'Move stage'}?`}
      body={
        target === 'won'
          ? 'Won does not mean paid: no income or payment is recorded. Finance records them separately when they happen.'
          : target === 'fulfilled'
            ? 'Every deliverable must be accepted or cancelled.'
            : 'The stage change is recorded in the deal history.'
      }
      confirmLabel={STAGE_ACTION[target] ?? 'Confirm'}
      destructive={target === 'lost' || target === 'cancelled'}
      loading={transition.isPending}
      confirmDisabled={needsReason && reason.trim().length < 3}
      onConfirm={async () => {
        setError(null);
        try {
          await transition.run(
            { params: { workspaceId: workspace.id, dealId: deal.id }, body: { targetStage: target, reason: reason.trim() || undefined, outcome: withOutcome && outcome.trim() ? outcome.trim() : undefined } },
            { ifMatch: deal.rowVersion },
          );
          toast.success(`Deal moved to ${label('dealStage', target)}`);
          setReason('');
          setOutcome('');
          onClose();
        } catch (e) {
          setError(
            isApiError(e)
              ? e.code === 'VERSION_CONFLICT'
                ? 'This record changed while you were editing it. Compare changes before saving.'
                : Array.isArray(e.details?.items)
                  ? `${e.message} ${(e.details!.items as { label: string; count: number }[]).map((i) => `${i.label}: ${i.count}`).join(', ')}`
                  : e.message
              : 'The stage could not be changed.',
          );
        }
      }}
    >
      {error ? <Banner tone="danger">{error}</Banner> : null}
      {needsReason ? (
        <Field label="Reason" required>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} />
        </Field>
      ) : null}
      {withOutcome ? (
        <Field label="Outcome" helper="Optional summary of the agreed terms or result.">
          <Textarea value={outcome} onChange={(e) => setOutcome(e.target.value)} maxLength={2000} />
        </Field>
      ) : null}
    </ConfirmDialog>
  );
};

const CampaignDialog = ({ deal, open, onOpenChange }: { deal: DealDetail; open: boolean; onOpenChange: (o: boolean) => void }) => {
  const { workspace } = useWorkspace();
  const [name, setName] = useState(deal.title);
  const [objective, setObjective] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [owner, setOwner] = useState<string | null>(deal.owner.membershipId);
  const [error, setError] = useState<string | null>(null);
  const create = useApiMutation(dealEndpoints.createCampaign, { invalidate: ['deals.', 'campaigns.'], silentErrors: true, successMessage: 'Campaign created and linked' });
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      dirty={!!objective}
      title="Create campaign for this deal"
      description="A planned campaign for the deal’s partner and projects. No results or budgets are created."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={name.trim().length < 2 || objective.trim().length < 3 || !start || !end}
            loading={create.isPending}
            onClick={async () => {
              setError(null);
              try {
                await create.run({ params: { workspaceId: workspace.id, dealId: deal.id }, body: { name: name.trim(), objective: objective.trim(), startDate: start, endDate: end, ownerMembershipId: owner ?? undefined } }, { ifMatch: deal.rowVersion });
                onOpenChange(false);
              } catch (e) {
                setError(isApiError(e) ? (e.fieldErrors[0]?.message ?? e.message) : 'The campaign could not be created.');
              }
            }}
          >
            Create Campaign
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {error ? <Banner tone="danger" className="sm:col-span-2">{error}</Banner> : null}
        <Field label="Name" required className="sm:col-span-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
        </Field>
        <Field label="Objective" required className="sm:col-span-2">
          <Textarea value={objective} onChange={(e) => setObjective(e.target.value)} maxLength={2000} />
        </Field>
        <Field label="Start date" required>
          <DateInput value={start} onChange={(e) => setStart(e.target.value)} />
        </Field>
        <Field label="End date" required>
          <DateInput value={end} onChange={(e) => setEnd(e.target.value)} />
        </Field>
        <Field label="Owner" className="sm:col-span-2">
          <MemberSelect value={owner} onChange={setOwner} />
        </Field>
      </div>
    </Dialog>
  );
};

/** Documents: contracts are private attachments (restricted media); no e-signature is offered. */
const DocumentsPanel = ({ deal }: { deal: DealDetail }) => {
  const { workspace } = useWorkspace();
  const qc = useQueryClient();
  const remove = useApiMutation(mediaEndpoints.removeLink, { invalidate: ['deals.get'], successMessage: 'Attachment link removed' });
  const [busy, setBusy] = useState<string | null>(null);
  const [removing, setRemoving] = useState<{ linkId: string; name: string } | null>(null);
  return (
    <Panel title="Documents" description="Contracts are stored as private, restricted attachments. Signing happens outside Castlane.">
      <div className="flex flex-col gap-3">
        {deal.documents.length === 0 ? <p className="text-[13px] text-fg-2">No documents attached.</p> : null}
        <ul className="flex flex-col divide-y divide-line">
          {deal.documents.map((doc) => (
            <li key={doc.linkId} className="flex flex-wrap items-center justify-between gap-2 py-2 text-[13px]">
              <span className="flex min-w-0 items-center gap-2">
                <FileText size={16} aria-hidden className="shrink-0 text-fg-2" />
                <span className="truncate">{doc.name}</span>
                {doc.restricted ? <Badge>Restricted</Badge> : null}
                {doc.status && doc.status !== 'available' ? <StatusBadge status={doc.status} /> : null}
              </span>
              <span className="flex gap-1">
                {doc.canDownload ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={busy === doc.assetId}
                    onClick={async () => {
                      setBusy(doc.assetId);
                      try {
                        const r = await api.call(mediaEndpoints.download, { params: { workspaceId: workspace.id, assetId: doc.assetId }, body: {} });
                        window.location.assign(r.url);
                      } catch (e) {
                        toast.error(isApiError(e) ? e.message : 'The document could not be downloaded.');
                      } finally {
                        setBusy(null);
                      }
                    }}
                  >
                    Download
                  </Button>
                ) : null}
                {deal.permissions.update ? (
                  <Button size="sm" variant="ghost" onClick={() => setRemoving({ linkId: doc.linkId, name: doc.name })}>
                    Remove Attachment Link
                  </Button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
        {deal.permissions.uploadDocuments && deal.projects[0] ? (
          <FileUploader
            workspaceId={workspace.id}
            purpose="document"
            projectId={deal.projects[0].id}
            sensitivity="restricted"
            target={{ entityType: 'deal', entityId: deal.id, role: 'contract' }}
            accept="application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/jpeg,image/png"
            label="Upload Contract"
            hint="PDF or DOCX. Stored as restricted media."
            compact
            onUploaded={() => void qc.invalidateQueries({ queryKey: [dealEndpoints.get.id] })}
          />
        ) : null}
      </div>
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title="Remove attachment link?"
        body={`${removing?.name ?? ''} is no longer attached to this deal. The file itself is kept in the library.`}
        confirmLabel="Remove Attachment Link"
        destructive
        loading={remove.isPending}
        onConfirm={async () => {
          if (!removing) return;
          try {
            await remove.run({ params: { workspaceId: workspace.id, linkId: removing.linkId }, body: {} });
            setRemoving(null);
          } catch {
            /* toast shown */
          }
        }}
      />
    </Panel>
  );
};
