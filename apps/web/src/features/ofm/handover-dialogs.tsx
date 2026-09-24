'use client';
import { DotsThree, Plus } from '@phosphor-icons/react';
import { useState, type ReactNode } from 'react';
import { ofmEndpoints as E, type OfmHandoverDetail, type OfmShiftDetail } from '@castlane/api-contracts';
import { TASK_PRIORITIES } from '@castlane/domain';
import {
  Badge,
  Banner,
  Button,
  Checkbox,
  DateTimeInput,
  DescriptionList,
  Dialog,
  Drawer,
  Field,
  IconButton,
  Input,
  Menu,
  Select,
  StatusBadge,
  Textarea,
  formatDateTime,
} from '@castlane/ui';
import { MemberSelect } from '@/components/common/pickers';
import { QueryState } from '@/components/common/query-state';
import { useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useWorkspace, useWsPath } from '@/lib/workspace-context';
import { AccountChip, MemberChip, ReasonDialog, errorMessage, fmtRange, fromLocalInput, runAction, useOfmMutation } from './common';

type Item = OfmHandoverDetail['items'][number];

const ItemLine = ({ item, actions }: { item: Item; actions?: ReactNode }) => {
  const { user } = useWorkspace();
  const wsPath = useWsPath();
  return (
    <li className="flex flex-col gap-1 px-3 py-2 text-[13px] md:flex-row md:items-start md:justify-between">
      <div className="min-w-0">
        <p className="font-medium text-fg">{item.title}</p>
        {item.businessExplanation ? <p className="whitespace-pre-wrap text-fg-2">{item.businessExplanation}</p> : null}
        <p className="flex flex-wrap gap-x-3 text-[12px] text-fg-2">
          {item.dueAt ? <span>Due {formatDateTime(item.dueAt, user.timezone)}</span> : null}
          {item.task ? (
            <a className="hover:underline" href={wsPath(`/tasks/${item.task.id}`)}>
              Task: {item.task.title} ({label('taskStatus', item.task.status)})
            </a>
          ) : null}
          {item.operation ? (
            <a className="hover:underline" href={wsPath(`/ofm/operations?open=${item.operation.id}`)}>
              Operation: {item.operation.title} ({label('operationStatus', item.operation.status)})
            </a>
          ) : null}
          {item.carriedFromItemId ? <span>Carried over</span> : null}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        <Badge tone={item.priority === 'urgent' ? 'danger' : item.priority === 'high' ? 'warning' : 'neutral'}>{label('priority', item.priority)}</Badge>
        <StatusBadge status={item.state === 'resolved' ? 'completed' : item.state === 'accepted' ? 'active' : 'pending'} label={label('handoverItemState', item.state)} />
        {actions}
      </div>
    </li>
  );
};

// ——— Acknowledge ———

/** Acknowledge receipt and accept selected items. Nothing is resolved, completed or copied. */
export const AcknowledgeHandoverDialog = ({ handoverId, onClose, onDone }: { handoverId: string; onClose: () => void; onDone?: (h: OfmHandoverDetail) => void }) => {
  const { workspace, user } = useWorkspace();
  const q = useApiQuery(E.getHandover, { params: { workspaceId: workspace.id, handoverId } });
  const [accepted, setAccepted] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const m = useOfmMutation(E.acknowledgeHandover, { successMessage: 'Handover acknowledged', also: ['myWork.'] });
  const h = q.data;
  const open = h?.items.filter((i) => i.state === 'open') ?? [];
  const chosen = accepted ?? open.map((i) => i.id);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Acknowledge Handover"
      description="Acknowledging confirms you read it and take over the accepted items. It does not resolve or complete anything."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!h || !h.permissions.acknowledge}
            loading={m.isPending}
            onClick={async () => {
              if (!h) return;
              setError(null);
              try {
                const res = await m.run({ params: { workspaceId: workspace.id, handoverId: h.id }, body: { acceptedItemIds: chosen } }, { ifMatch: h.rowVersion });
                onDone?.(res);
                onClose();
              } catch (e) {
                setError(errorMessage(e));
              }
            }}
          >
            Acknowledge Handover
          </Button>
        </>
      }
    >
      <QueryState query={q}>
        {h ? (
          <div className="flex flex-col gap-4">
            {error ? <Banner tone="danger">{error}</Banner> : null}
            {!h.permissions.acknowledge ? <Banner tone="warning">Only the recipient can acknowledge this handover.</Banner> : null}
            <DescriptionList
              items={[
                { label: 'From', value: <MemberChip member={h.fromShift.member} /> },
                { label: 'From Shift', value: fmtRange(h.fromShift.scheduledStart, h.fromShift.scheduledEnd, user.timezone) },
                { label: 'Account', value: <AccountChip account={h.account} /> },
                { label: 'Submitted', value: h.submittedAt ? formatDateTime(h.submittedAt, user.timezone) : null },
              ]}
            />
            <section>
              <h3 className="mb-1 text-[14px] font-semibold text-fg">Summary</h3>
              <p className="whitespace-pre-wrap text-[14px] leading-[22px] text-fg">{h.summary}</p>
            </section>
            {h.noOpenItems && !h.items.length ? <Banner tone="info">The sender confirmed there are no open items.</Banner> : null}
            {open.length ? (
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 text-[14px] font-semibold text-fg">Items to accept</legend>
                {open.map((i) => (
                  <Checkbox
                    key={i.id}
                    label={i.title}
                    description={[label('priority', i.priority), i.dueAt ? `due ${formatDateTime(i.dueAt, user.timezone)}` : null, i.task ? 'linked task' : null, i.operation ? 'linked operation' : null].filter(Boolean).join(' · ')}
                    checked={chosen.includes(i.id)}
                    onCheckedChange={(c) => setAccepted(c ? [...chosen, i.id] : chosen.filter((x) => x !== i.id))}
                  />
                ))}
              </fieldset>
            ) : null}
          </div>
        ) : null}
      </QueryState>
    </Dialog>
  );
};

// ——— Composer (outgoing handover of a shift) ———

const NewItemForm = ({ onAdd, pending }: { onAdd: (v: { title: string; businessExplanation: string | null; priority: (typeof TASK_PRIORITIES)[number]; dueAt: string | null }) => Promise<unknown>; pending: boolean }) => {
  const { user } = useWorkspace();
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [priority, setPriority] = useState<(typeof TASK_PRIORITIES)[number]>('normal');
  const [due, setDue] = useState('');
  return (
    <form
      className="flex flex-col gap-3 rounded-[12px] border border-dashed border-line p-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (title.trim().length < 3) return;
        const ok = await runAction(() => onAdd({ title: title.trim(), businessExplanation: text.trim() || null, priority, dueAt: due ? fromLocalInput(due, user.timezone) : null }));
        if (ok) {
          setTitle('');
          setText('');
          setDue('');
          setPriority('normal');
        }
      }}
    >
      <Field label="New Item" required helper="At least 3 characters.">
        <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="What must the next person handle?" />
      </Field>
      <Field label="Explanation">
        <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} maxLength={2000} />
      </Field>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Priority">
          <Select value={priority} onChange={(p) => p && setPriority(p)} options={TASK_PRIORITIES.map((p) => ({ value: p, label: label('priority', p) }))} />
        </Field>
        <Field label="Due">
          <DateTimeInput timezone={user.timezone} value={due} onChange={(e) => setDue(e.target.value)} />
        </Field>
      </div>
      <div>
        <Button type="submit" size="sm" icon={<Plus size={14} />} loading={pending} disabled={title.trim().length < 3}>
          Add Item
        </Button>
      </div>
    </form>
  );
};

/** Outgoing handover of a shift: create the draft, add items (new or open matters by reference), submit. */
export const HandoverComposer = ({ shift }: { shift: OfmShiftDetail }) => {
  const { workspace, user } = useWorkspace();
  const out = shift.outgoingHandover;
  const [summary, setSummary] = useState('');
  const [recipient, setRecipient] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const create = useOfmMutation(E.createHandover, { successMessage: 'Handover draft created' });
  const detail = useApiQuery(E.getHandover, { params: { workspaceId: workspace.id, handoverId: out?.id ?? '' } }, { enabled: !!out });
  const candidates = useApiQuery(E.handoverCandidates, { params: { workspaceId: workspace.id, shiftId: shift.id } }, { enabled: !!out && out.state === 'draft' });
  const addItem = useOfmMutation(E.addHandoverItem, { successMessage: 'Item added' });
  const removeItem = useOfmMutation(E.removeHandoverItem, { successMessage: 'Item removed' });
  const submit = useOfmMutation(E.submitHandover, { successMessage: 'Handover submitted', also: ['myWork.'] });
  const [submitting, setSubmitting] = useState(false);
  const h = detail.data;

  if (!out) {
    if (!shift.permissions.writeHandover) return <p className="text-[13px] text-fg-2">No handover was written from this shift.</p>;
    return (
      <div className="flex flex-col gap-3">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <Field label="Summary" required helper="What happened and what the next person must know. At least 3 characters.">
          <Textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={3} maxLength={20000} />
        </Field>
        <Field label="Recipient" helper="Optional. Default: the member of the next shift on this account, otherwise the supervisor.">
          <MemberSelect value={recipient} onChange={setRecipient} clearable />
        </Field>
        <div>
          <Button
            variant="primary"
            loading={create.isPending}
            disabled={summary.trim().length < 3}
            onClick={async () => {
              setError(null);
              try {
                await create.run({ params: { workspaceId: workspace.id }, body: { fromShiftId: shift.id, summary: summary.trim(), recipientMembershipId: recipient } });
                setSummary('');
              } catch (e) {
                setError(errorMessage(e));
              }
            }}
          >
            Create Handover Draft
          </Button>
        </div>
      </div>
    );
  }
  return (
    <QueryState query={detail}>
      {h ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={h.state === 'acknowledged' ? 'approved' : h.state === 'submitted' ? 'pending' : 'draft'} label={label('handoverState', h.state)} />
            {h.recipient ? (
              <span className="inline-flex items-center gap-1 text-[13px] text-fg-2">
                To <MemberChip member={h.recipient} />
              </span>
            ) : null}
            {h.acknowledgedAt ? <span className="text-[13px] text-fg-2">Acknowledged {formatDateTime(h.acknowledgedAt, user.timezone)}</span> : null}
          </div>
          <p className="whitespace-pre-wrap text-[14px] leading-[22px] text-fg">{h.summary}</p>
          {h.items.length ? (
            <ul className="flex flex-col divide-y divide-line rounded-[12px] border border-line">
              {h.items.map((i) => (
                <ItemLine
                  key={i.id}
                  item={i}
                  actions={
                    h.permissions.edit ? (
                      <Button size="sm" variant="ghost" onClick={() => void runAction(() => removeItem.run({ params: { workspaceId: workspace.id, handoverId: h.id, itemId: i.id } }))}>
                        Remove
                      </Button>
                    ) : null
                  }
                />
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-fg-2">{h.noOpenItems ? 'No open items (confirmed).' : 'No items yet.'}</p>
          )}
          {h.permissions.edit ? (
            <>
              {candidates.data && (candidates.data.carriedItems.length || candidates.data.operations.length) ? (
                <section className="flex flex-col gap-2">
                  <h4 className="text-[13px] font-semibold text-fg">Open matters to hand over</h4>
                  <ul className="flex flex-col divide-y divide-line rounded-[12px] border border-line">
                    {candidates.data.carriedItems.map((c) => (
                      <li key={c.id} className="flex items-center justify-between gap-2 px-3 py-2 text-[13px]">
                        <span className="min-w-0 truncate">{c.title} · accepted earlier</span>
                        <Button
                          size="sm"
                          onClick={() =>
                            void runAction(() =>
                              addItem.run({ params: { workspaceId: workspace.id, handoverId: h.id }, body: { title: c.title, businessExplanation: c.businessExplanation, priority: c.priority, dueAt: c.dueAt, taskId: c.task?.id ?? null, operationId: c.operation?.id ?? null, carriedFromItemId: c.id } }),
                            )
                          }
                        >
                          Carry Over
                        </Button>
                      </li>
                    ))}
                    {candidates.data.operations.map((o) => (
                      <li key={o.id} className="flex items-center justify-between gap-2 px-3 py-2 text-[13px]">
                        <span className="min-w-0 truncate">
                          {o.title} · {label('operationStatus', o.status)}
                        </span>
                        <Button
                          size="sm"
                          onClick={() => void runAction(() => addItem.run({ params: { workspaceId: workspace.id, handoverId: h.id }, body: { title: o.title, priority: o.priority, dueAt: o.dueAt, operationId: o.id } }))}
                        >
                          Add
                        </Button>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              <NewItemForm pending={addItem.isPending} onAdd={(v) => addItem.run({ params: { workspaceId: workspace.id, handoverId: h.id }, body: v })} />
              <div>
                <Button variant="primary" onClick={() => setSubmitting(true)}>
                  Submit Handover
                </Button>
              </div>
            </>
          ) : null}
          {submitting ? (
            <SubmitHandoverDialog
              h={h}
              onClose={() => setSubmitting(false)}
              run={(recipientId) => submit.run({ params: { workspaceId: workspace.id, handoverId: h.id }, body: { recipientMembershipId: recipientId } }, { ifMatch: h.rowVersion })}
            />
          ) : null}
        </div>
      ) : null}
    </QueryState>
  );
};

const SubmitHandoverDialog = ({ h, onClose, run }: { h: OfmHandoverDetail; onClose: () => void; run: (recipient: string | null) => Promise<unknown> }) => {
  const [recipient, setRecipient] = useState<string | null>(h.recipient?.membershipId ?? null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="small"
      title="Submit handover?"
      description={`${h.items.length} item(s). Items stay linked to their tasks and operations — nothing is copied.`}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={pending}
            onClick={async () => {
              setPending(true);
              setError(null);
              try {
                await run(recipient);
                onClose();
              } catch (e) {
                setError(errorMessage(e));
              } finally {
                setPending(false);
              }
            }}
          >
            Submit Handover
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        {!h.items.length ? <Banner tone="info">This handover has no items. The report must then confirm No Open Items.</Banner> : null}
        <Field label="Recipient" helper="Empty: the next shift’s member on this account, otherwise the supervisor.">
          <MemberSelect value={recipient} onChange={setRecipient} clearable />
        </Field>
      </div>
    </Dialog>
  );
};

// ——— Handover detail (desk) ———

export const HandoverDetailDrawer = ({ id, onClose }: { id: string; onClose: () => void }) => {
  const { workspace, user } = useWorkspace();
  const wsPath = useWsPath();
  const q = useApiQuery(E.getHandover, { params: { workspaceId: workspace.id, handoverId: id } });
  const [ack, setAck] = useState(false);
  const [reroute, setReroute] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [resolving, setResolving] = useState<Item | null>(null);
  const [converting, setConverting] = useState<Item | null>(null);
  const resolve = useOfmMutation(E.resolveHandoverItem, { successMessage: 'Item resolved' });
  const submit = useOfmMutation(E.submitHandover, { successMessage: 'Handover submitted', also: ['myWork.'] });
  const h = q.data;
  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      title="Handover"
      width={760}
      headerActions={
        h && h.permissions.assignRecipient ? (
          <Menu label="Handover actions" trigger={<IconButton label="Handover actions" icon={<DotsThree size={18} weight="bold" />} />} items={[{ label: 'Assign Recipient', onSelect: () => setReroute(true) }]} />
        ) : null
      }
      footer={
        h && (h.permissions.acknowledge || h.permissions.submit) ? (
          <>
            {h.permissions.submit ? (
              <Button variant="primary" onClick={() => setSubmitting(true)}>
                Submit
              </Button>
            ) : null}
            {h.permissions.acknowledge ? (
              <Button variant="primary" onClick={() => setAck(true)}>
                Acknowledge
              </Button>
            ) : null}
          </>
        ) : undefined
      }
    >
      <QueryState query={q}>
        {h ? (
          <div className="flex flex-col gap-5">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={h.state === 'acknowledged' ? 'approved' : h.state === 'submitted' ? 'pending' : 'draft'} label={label('handoverState', h.state)} />
              <span className="text-[13px] text-fg-2">
                {h.itemCounts.open} open · {h.itemCounts.accepted} accepted · {h.itemCounts.resolved} resolved
              </span>
            </div>
            <DescriptionList
              items={[
                { label: 'From', value: <MemberChip member={h.fromShift.member} size={28} /> },
                { label: 'From Shift', value: <a className="hover:underline" href={wsPath(`/ofm/shifts/${h.fromShift.id}`)}>{fmtRange(h.fromShift.scheduledStart, h.fromShift.scheduledEnd, user.timezone)}</a> },
                { label: 'To', value: <MemberChip member={h.recipient} size={28} /> },
                { label: 'To Shift', value: h.toShift ? <a className="hover:underline" href={wsPath(`/ofm/shifts/${h.toShift.id}`)}>{formatDateTime(h.toShift.scheduledStart, user.timezone)}</a> : null },
                { label: 'Account', value: <AccountChip account={h.account} /> },
                { label: 'Submitted', value: h.submittedAt ? formatDateTime(h.submittedAt, user.timezone) : null },
                { label: 'Acknowledged', value: h.acknowledgedAt ? `${formatDateTime(h.acknowledgedAt, user.timezone)}${h.acknowledgedBy ? ` by ${h.acknowledgedBy.displayName}` : ''}` : null },
              ]}
            />
            <section>
              <h3 className="mb-1 text-[14px] font-semibold text-fg">Summary</h3>
              <p className="whitespace-pre-wrap text-[14px] leading-[22px] text-fg">{h.summary}</p>
            </section>
            <section>
              <h3 className="mb-2 text-[14px] font-semibold text-fg">Items</h3>
              {h.items.length ? (
                <ul className="flex flex-col divide-y divide-line rounded-[12px] border border-line">
                  {h.items.map((i) => (
                    <ItemLine
                      key={i.id}
                      item={i}
                      actions={
                        (h.permissions.resolveItems && i.state !== 'resolved') || (h.permissions.convertToTask && !i.task && i.state !== 'resolved') ? (
                          <Menu
                            label="Item actions"
                            trigger={<IconButton label="Item actions" icon={<DotsThree size={16} weight="bold" />} />}
                            items={[
                              { label: 'Resolve Item', onSelect: () => setResolving(i), hidden: !h.permissions.resolveItems },
                              { label: 'Convert Item to Task', onSelect: () => setConverting(i), hidden: !h.permissions.convertToTask || !!i.task },
                            ]}
                          />
                        ) : null
                      }
                    />
                  ))}
                </ul>
              ) : (
                <p className="text-[13px] text-fg-2">{h.noOpenItems ? 'No open items (confirmed by the sender).' : 'No items.'}</p>
              )}
            </section>
          </div>
        ) : null}
      </QueryState>
      {h && ack ? <AcknowledgeHandoverDialog handoverId={h.id} onClose={() => setAck(false)} /> : null}
      {h && reroute ? <AssignRecipientDialog h={h} onClose={() => setReroute(false)} /> : null}
      {h && submitting ? (
        <SubmitHandoverDialog
          h={h}
          onClose={() => setSubmitting(false)}
          run={(recipientId) => submit.run({ params: { workspaceId: workspace.id, handoverId: h.id }, body: { recipientMembershipId: recipientId } }, { ifMatch: h.rowVersion })}
        />
      ) : null}
      <ReasonDialog
        open={!!resolving}
        onOpenChange={(o) => !o && setResolving(null)}
        title="Resolve item?"
        body="Marks only this handover item resolved. Linked tasks and operations keep their own status."
        confirmLabel="Resolve Item"
        reasonLabel="Note"
        required={false}
        onConfirm={(note) => resolve.run({ params: { workspaceId: workspace.id, itemId: resolving!.id }, body: { note: note || undefined } }, { ifMatch: resolving!.rowVersion })}
      />
      {h && converting ? <ConvertItemDialog item={converting} projectId={h.account.projectId} onClose={() => setConverting(null)} /> : null}
    </Drawer>
  );
};

const AssignRecipientDialog = ({ h, onClose }: { h: OfmHandoverDetail; onClose: () => void }) => {
  const { workspace } = useWorkspace();
  const [recipient, setRecipient] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const m = useOfmMutation(E.assignHandoverRecipient, { successMessage: 'Recipient changed', also: ['myWork.'] });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="small"
      title="Assign Recipient"
      description="Route this unacknowledged handover to another member. They are notified."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!recipient}
            loading={m.isPending}
            onClick={async () => {
              setError(null);
              try {
                await m.run({ params: { workspaceId: workspace.id, handoverId: h.id }, body: { recipientMembershipId: recipient!, reason: reason.trim().length >= 3 ? reason.trim() : undefined } }, { ifMatch: h.rowVersion });
                onClose();
              } catch (e) {
                setError(errorMessage(e));
              }
            }}
          >
            Assign Recipient
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <Field label="Recipient" required>
          <MemberSelect value={recipient} onChange={setRecipient} />
        </Field>
        <Field label="Reason">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} />
        </Field>
      </div>
    </Dialog>
  );
};

const ConvertItemDialog = ({ item, projectId, onClose }: { item: Item; projectId: string; onClose: () => void }) => {
  const { workspace, user } = useWorkspace();
  const [title, setTitle] = useState(item.title);
  const [assignee, setAssignee] = useState<string | null>(null);
  const [due, setDue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const m = useOfmMutation(E.convertHandoverItem, { successMessage: 'Task created and linked', also: ['tasks.', 'myWork.'] });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="small"
      title="Convert Item to Task"
      description="Creates one task and links it by ID. Later handovers reference the same task."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={title.trim().length < 3}
            loading={m.isPending}
            onClick={async () => {
              setError(null);
              try {
                await m.run(
                  { params: { workspaceId: workspace.id, itemId: item.id }, body: { title: title.trim(), assigneeMembershipId: assignee, dueAt: due ? fromLocalInput(due, user.timezone) : (item.dueAt ?? null) } },
                  { ifMatch: item.rowVersion },
                );
                onClose();
              } catch (e) {
                setError(errorMessage(e));
              }
            }}
          >
            Create Task
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <Field label="Title" required>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
        </Field>
        <Field label="Assignee" helper="Empty: you.">
          <MemberSelect value={assignee} onChange={setAssignee} projectId={projectId} permission="tasks.read" clearable />
        </Field>
        <Field label="Due">
          <DateTimeInput timezone={user.timezone} value={due} onChange={(e) => setDue(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
};

/** Incoming handover card shown in the Shift Workspace before start. */
export const IncomingHandovers = ({ shift, onAcknowledged }: { shift: OfmShiftDetail; onAcknowledged?: (id: string) => void }) => {
  const { user } = useWorkspace();
  const [ack, setAck] = useState<string | null>(null);
  if (!shift.incomingHandovers.length) return <p className="text-[13px] text-fg-2">No previous handover for this shift.</p>;
  return (
    <ul className="flex flex-col gap-3">
      {shift.incomingHandovers.map((h) => (
        <li key={h.id} className="flex flex-col gap-2 rounded-[12px] border border-line p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="inline-flex items-center gap-2 text-[13px] text-fg-2">
              <MemberChip member={h.fromShift.member} size={28} /> · {fmtRange(h.fromShift.scheduledStart, h.fromShift.scheduledEnd, user.timezone)}
            </span>
            <StatusBadge status={h.state === 'acknowledged' ? 'approved' : 'pending'} label={label('handoverState', h.state)} />
          </div>
          <p className="line-clamp-4 whitespace-pre-wrap text-[14px] leading-[22px] text-fg">{h.summary}</p>
          <p className="text-[12px] text-fg-2">
            {h.itemCounts.open} open · {h.itemCounts.accepted} accepted · {h.itemCounts.resolved} resolved
            {h.highestPriority ? ` · highest priority ${label('priority', h.highestPriority)}` : ''}
          </p>
          {h.state === 'submitted' && h.recipient?.membershipId === shift.member.membershipId && shift.permissions.start ? (
            <div>
              <Button variant="primary" size="sm" onClick={() => setAck(h.id)}>
                Acknowledge Handover
              </Button>
            </div>
          ) : null}
        </li>
      ))}
      {ack ? <AcknowledgeHandoverDialog handoverId={ack} onClose={() => setAck(null)} onDone={(h) => onAcknowledged?.(h.id)} /> : null}
    </ul>
  );
};

