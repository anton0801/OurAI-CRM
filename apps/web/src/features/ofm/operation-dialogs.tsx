'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { DotsThree, Plus, Trash } from '@phosphor-icons/react';
import { useEffect, useMemo, useState } from 'react';
import { Controller, useFieldArray, useForm } from 'react-hook-form';
import { z } from 'zod';
import { ofmEndpoints as E, type OfmOperationDetail, type OfmOperationSummary, type OfmSaleCandidate } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { INTERACTION_TYPES, OPERATION_TYPES, SUPPORTED_CURRENCIES, TASK_PRIORITIES } from '@castlane/domain';
import {
  AmountInput,
  Badge,
  Banner,
  Button,
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
  Switch,
  Textarea,
  formatDateTime,
  formatMoney,
  formatPercent,
  toast,
} from '@castlane/ui';
import { ConflictDialog } from '@/components/common/conflict';
import { changedFields, pickChanged, useEditBase } from '@/lib/edit-base';
import { EntitySelect, MultiEntitySelect } from '@/components/common/entity-select';
import { MemberSelect } from '@/components/common/pickers';
import { QueryState } from '@/components/common/query-state';
import { useDebounced } from '@/components/common/use-debounced';
import { applyFieldErrors, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useWorkspace, useWsPath } from '@/lib/workspace-context';
import { AccountChip, MemberChip, errorMessage, fromLocalInput, runAction, toLocalInput, useOfmMutation } from './common';
import { OfmAccountSelect, projectOfAccount, useOfmModels } from './pickers';

export const ContactRefText = ({ contact }: { contact: OfmOperationSummary['contact'] }) =>
  !contact ? <span className="text-fg-muted">No contact</span> : contact.restricted ? <span className="text-fg-2">Linked contact (restricted)</span> : <span>{contact.alias}</span>;

// ——— Create / edit operation ———

const opSchema = z.object({
  type: z.enum(OPERATION_TYPES),
  accountId: z.string().uuid('Choose an account.'),
  contactId: z.string().optional(),
  ownerMembershipId: z.string().uuid('Choose an owner.'),
  title: z.string().trim().min(3, 'At least 3 characters.').max(200),
  details: z.string().max(20000).optional(),
  dueAt: z.string().optional(),
  priority: z.enum(TASK_PRIORITIES),
  promisedDeliverable: z.string().max(500).optional(),
  evidenceAssetIds: z.array(z.string().uuid()).max(20),
});
type OpValues = z.infer<typeof opSchema>;

export const OperationDrawer = ({
  operation,
  preset,
  onClose,
}: {
  operation?: OfmOperationDetail;
  preset?: { accountId?: string; contactId?: string; shiftId?: string; type?: OpValues['type'] };
  onClose: (id?: string) => void;
}) => {
  const { workspace, user, membershipId } = useWorkspace();
  const models = useOfmModels();
  const valuesOf = (operation: OfmOperationDetail): OpValues => ({
    type: operation.type,
    accountId: operation.account.id,
    contactId: operation.contact?.id ?? '',
    ownerMembershipId: operation.owner.membershipId,
    title: operation.title,
    details: operation.details ?? '',
    dueAt: toLocalInput(operation.dueAt, user.timezone),
    priority: operation.priority,
    promisedDeliverable: operation.promisedDeliverable ?? '',
    evidenceAssetIds: operation.evidenceAssetIds,
  });
  const form = useForm<OpValues>({
    resolver: zodResolver(opSchema),
    defaultValues: operation
      ? {
          type: operation.type,
          accountId: operation.account.id,
          contactId: operation.contact?.id ?? '',
          ownerMembershipId: operation.owner.membershipId,
          title: operation.title,
          details: operation.details ?? '',
          dueAt: toLocalInput(operation.dueAt, user.timezone),
          priority: operation.priority,
          promisedDeliverable: operation.promisedDeliverable ?? '',
          evidenceAssetIds: operation.evidenceAssetIds,
        }
      : {
          type: preset?.type ?? 'follow_up',
          accountId: preset?.accountId ?? '',
          contactId: preset?.contactId ?? '',
          ownerMembershipId: membershipId,
          title: '',
          details: '',
          dueAt: '',
          priority: 'normal',
          promisedDeliverable: '',
          evidenceAssetIds: [],
        },
  });
  const [error, setError] = useState<string | null>(null);
  // Edits apply to the operation as it was opened; only changed fields are sent (T162).
  const edit = useEditBase(operation, { onReload: (x) => form.reset(valuesOf(x)) });
  const create = useOfmMutation(E.createOperation, { successMessage: 'Operation created' });
  const update = useOfmMutation(E.updateOperation, { successMessage: 'Operation updated' });
  const accountId = form.watch('accountId');
  const projectId = projectOfAccount(models.data, accountId);
  const errs = form.formState.errors;
  const submit = form.handleSubmit(async (v) => {
    setError(null);
    const commonOf = (v: OpValues) => ({
      title: v.title.trim(),
      details: v.details?.trim() ? v.details : null,
      dueAt: v.dueAt ? fromLocalInput(v.dueAt, user.timezone) : null,
      priority: v.priority,
      ownerMembershipId: v.ownerMembershipId,
      contactId: v.contactId || null,
      promisedDeliverable: v.promisedDeliverable?.trim() ? v.promisedDeliverable.trim() : null,
      evidenceAssetIds: v.evidenceAssetIds,
    });
    const common = commonOf(v);
    try {
      if (operation) {
        const before = commonOf(valuesOf(edit.start ?? operation));
        await update.run({ params: { workspaceId: workspace.id, operationId: operation.id }, body: pickChanged(common, changedFields(before, common)) }, { ifMatch: edit.version });
        onClose(operation.id);
      } else {
        const res = await create.run({ params: { workspaceId: workspace.id }, body: { ...common, type: v.type, accountId: v.accountId, shiftId: preset?.shiftId ?? null } });
        onClose(res.id);
      }
    } catch (e) {
      if (edit.catchConflict(e)) return;
      if (!applyFieldErrors(e, form.setError as never)) setError(errorMessage(e, 'The operation could not be saved.'));
    }
  });
  const pending = create.isPending || update.isPending;
  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      title={operation ? 'Edit Operation' : 'Create Operation'}
      description="Business state only — completing an operation never means a payment happened."
      dirty={form.formState.isDirty && !pending}
      footer={
        <>
          <Button onClick={() => onClose()} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" loading={pending} onClick={() => void submit()}>
            {operation ? 'Save Changes' : 'Create'}
          </Button>
        </>
      }
    >
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Type" required>
            <Controller
              control={form.control}
              name="type"
              render={({ field }) => <Select disabled={!!operation} value={field.value} onChange={(t) => t && field.onChange(t)} options={OPERATION_TYPES.map((t) => ({ value: t, label: label('operationType', t) }))} />}
            />
          </Field>
          <Field label="Priority" required>
            <Controller control={form.control} name="priority" render={({ field }) => <Select value={field.value} onChange={(p) => p && field.onChange(p)} options={TASK_PRIORITIES.map((p) => ({ value: p, label: label('priority', p) }))} />} />
          </Field>
        </div>
        <Field label="Account" required error={errs.accountId?.message}>
          <Controller
            control={form.control}
            name="accountId"
            render={({ field }) => (
              <OfmAccountSelect
                disabled={!!operation}
                value={field.value}
                onChange={(a) => {
                  field.onChange(a ?? '');
                  form.setValue('contactId', '');
                }}
              />
            )}
          />
        </Field>
        <Field label="Title" required error={errs.title?.message}>
          <Input {...form.register('title')} maxLength={200} />
        </Field>
        <Field label="Contact" helper="Optional. Contacts belong to one account.">
          <Controller
            control={form.control}
            name="contactId"
            render={({ field }) => <EntitySelect type="ofm_contact" filters={{ accountId: accountId || undefined }} disabled={!accountId} value={field.value || null} onChange={(c) => field.onChange(c ?? '')} clearable />}
          />
        </Field>
        <Field label="Owner" required error={errs.ownerMembershipId?.message}>
          <Controller control={form.control} name="ownerMembershipId" render={({ field }) => <MemberSelect value={field.value} onChange={(m) => field.onChange(m ?? '')} />} />
        </Field>
        <Field label="Due">
          <DateTimeInput timezone={user.timezone} {...form.register('dueAt')} />
        </Field>
        <Field label="Details" helper="Business facts only. No passwords, card numbers or intimate profiles." error={errs.details?.message}>
          <Textarea {...form.register('details')} rows={4} maxLength={20000} />
        </Field>
        <Field label="Promised Deliverable" error={errs.promisedDeliverable?.message}>
          <Input {...form.register('promisedDeliverable')} maxLength={500} />
        </Field>
        <Field label="Evidence" helper="Existing library assets of the model.">
          <Controller
            control={form.control}
            name="evidenceAssetIds"
            render={({ field }) => <MultiEntitySelect type="asset" filters={{ projectId: projectId ?? undefined }} disabled={!projectId} value={field.value} onChange={field.onChange} max={20} />}
          />
        </Field>
      </form>
      <ConflictDialog {...edit.conflictDialog} />
    </Drawer>
  );
};

// ——— Operation detail with transitions ———

type Target = OfmOperationSummary['status'];
const transitionLabel = (from: Target, to: Target) =>
  to === 'in_progress' ? (from === 'waiting' ? 'Resume' : 'Start') : to === 'open' ? 'Back to Open' : to === 'waiting' ? 'Wait' : to === 'completed' ? 'Complete' : 'Cancel Operation';

export const OperationDetailDrawer = ({ id, onClose, onRegisterSale }: { id: string; onClose: () => void; onRegisterSale?: (op: OfmOperationDetail) => void }) => {
  const { workspace, user } = useWorkspace();
  const wsPath = useWsPath();
  const q = useApiQuery(E.getOperation, { params: { workspaceId: workspace.id, operationId: id } });
  const [editing, setEditing] = useState(false);
  const [target, setTarget] = useState<Target | null>(null);
  const [brief, setBrief] = useState(false);
  const [linking, setLinking] = useState(false);
  const transition = useOfmMutation(E.transitionOperation, { also: ['tasks.', 'myWork.'] });
  const link = useOfmMutation(E.linkContent, { successMessage: 'Content unlinked' });
  const op = q.data;
  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      title={op ? op.title : 'Operation'}
      width={760}
      headerActions={
        op ? (
          <Menu
            label="Operation actions"
            trigger={<IconButton label="Operation actions" icon={<DotsThree size={18} weight="bold" />} />}
            items={[
              { label: 'Edit', onSelect: () => setEditing(true), hidden: !op.permissions.update },
              { label: 'Create Content Brief', onSelect: () => setBrief(true), hidden: !op.permissions.createContentBrief || op.type !== 'content_request' || !!op.task },
              { label: op.contentItemId ? 'Change Linked Content' : 'Link Content', onSelect: () => setLinking(true), hidden: !op.permissions.linkContent },
              {
                label: 'Unlink Content',
                hidden: !op.permissions.linkContent || !op.contentItemId,
                onSelect: () => void runAction(() => link.run({ params: { workspaceId: workspace.id, operationId: op.id }, body: { contentItemId: null } }, { ifMatch: op.rowVersion })),
              },
              { label: 'Register Sale Candidate', onSelect: () => onRegisterSale?.(op), hidden: !op.permissions.registerSale || !onRegisterSale },
            ]}
          />
        ) : null
      }
      footer={
        op && op.permissions.transition && op.allowedTransitions.length ? (
          <div className="flex flex-wrap justify-end gap-2">
            {op.allowedTransitions.map((t) => (
              <Button key={t} variant={t === 'completed' ? 'primary' : t === 'cancelled' ? 'danger-secondary' : 'secondary'} onClick={() => setTarget(t)} loading={transition.isPending && target === t}>
                {transitionLabel(op.status, t)}
              </Button>
            ))}
          </div>
        ) : undefined
      }
    >
      <QueryState query={q}>
        {op ? (
          <div className="flex flex-col gap-5">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={op.status === 'in_progress' ? 'active' : op.status} label={label('operationStatus', op.status)} />
              <Badge>{label('operationType', op.type)}</Badge>
              <Badge tone={op.priority === 'urgent' ? 'danger' : op.priority === 'high' ? 'warning' : 'neutral'}>{label('priority', op.priority)}</Badge>
              {op.overdue ? <Badge tone="danger">Overdue</Badge> : null}
            </div>
            <DescriptionList
              items={[
                { label: 'Account', value: <AccountChip account={op.account} /> },
                { label: 'Model', value: op.project.name },
                { label: 'Contact', value: op.contact && !op.contact.restricted ? <a className="hover:underline" href={wsPath(`/ofm/contacts/${op.contact.id}`)}>{op.contact.alias}</a> : <ContactRefText contact={op.contact} /> },
                { label: 'Owner', value: <MemberChip member={op.owner} /> },
                { label: 'Due', value: op.dueAt ? formatDateTime(op.dueAt, user.timezone) : null },
                { label: 'Shift', value: op.shift ? <a className="hover:underline" href={wsPath(`/ofm/shifts/${op.shift.id}`)}>{formatDateTime(op.shift.scheduledStart, user.timezone)}</a> : null },
                { label: 'Waiting For', value: op.waitingFor, hidden: !op.waitingFor },
                { label: 'Next Check', value: op.nextCheckAt ? formatDateTime(op.nextCheckAt, user.timezone) : null, hidden: !op.nextCheckAt },
                { label: 'Promised Deliverable', value: op.promisedDeliverable },
                { label: 'Linked Task', value: op.task ? <a className="hover:underline" href={wsPath(`/tasks/${op.task.id}`)}>{op.task.title}</a> : null },
                { label: 'Linked Content', value: op.contentItemId ? <a className="hover:underline" href={wsPath(`/content/${op.contentItemId}`)}>Open content item</a> : null },
                { label: 'Evidence', value: op.evidenceAssetIds.length ? `${op.evidenceAssetIds.length} asset(s)` : null },
                { label: 'Outcome', value: op.outcome, hidden: !op.outcome },
                { label: 'Cancel Reason', value: op.cancelReason, hidden: !op.cancelReason },
                { label: 'Created', value: `${formatDateTime(op.createdAt, user.timezone)}${op.createdBy ? ` by ${op.createdBy.displayName}` : ''}` },
              ]}
            />
            {op.details ? (
              <section>
                <h3 className="mb-1 text-[14px] font-semibold text-fg">Details</h3>
                <p className="whitespace-pre-wrap text-[14px] leading-[22px] text-fg">{op.details}</p>
              </section>
            ) : null}
          </div>
        ) : null}
      </QueryState>
      {op && editing ? <OperationDrawer operation={op} onClose={() => setEditing(false)} /> : null}
      {op && target ? <TransitionDialog op={op} target={target} onClose={() => setTarget(null)} run={transition.run} /> : null}
      {op && brief ? <ContentBriefDialog op={op} onClose={() => setBrief(false)} /> : null}
      {op && linking ? <LinkContentDialog op={op} onClose={() => setLinking(false)} /> : null}
    </Drawer>
  );
};

const TransitionDialog = ({
  op,
  target,
  onClose,
  run,
}: {
  op: OfmOperationDetail;
  target: Target;
  onClose: () => void;
  run: ReturnType<typeof useOfmMutation<typeof E.transitionOperation>>['run'];
}) => {
  const { workspace, user } = useWorkspace();
  const [text, setText] = useState('');
  const [waitingFor, setWaitingFor] = useState('');
  const [nextCheck, setNextCheck] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The version shown when the dialog opened (T162).
  const edit = useEditBase(op);
  const simple = target === 'in_progress' || target === 'open';
  const valid =
    simple ||
    (target === 'completed' && text.trim().length >= 3) ||
    (target === 'cancelled' && text.trim().length >= 3) ||
    (target === 'waiting' && waitingFor.trim().length >= 2 && !!nextCheck);
  const go = async () => {
    setPending(true);
    setError(null);
    try {
      await run(
        {
          params: { workspaceId: workspace.id, operationId: op.id },
          body: {
            targetState: target,
            outcome: target === 'completed' ? text.trim() : undefined,
            reason: target === 'cancelled' ? text.trim() : undefined,
            waitingFor: target === 'waiting' ? waitingFor.trim() : undefined,
            nextCheckAt: target === 'waiting' ? (fromLocalInput(nextCheck, user.timezone) ?? undefined) : undefined,
          },
        },
        { ifMatch: edit.version },
      );
      toast.success(`Operation: ${label('operationStatus', target)}`);
      onClose();
    } catch (e) {
      if (!edit.catchConflict(e)) setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  };
  useEffect(() => {
    if (simple) void go();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (simple) return null;
  return (
    <>
      <Dialog
        open
        onOpenChange={(o) => !o && onClose()}
        size="small"
        title={target === 'completed' ? 'Complete operation' : target === 'cancelled' ? 'Cancel operation?' : 'Wait for something'}
        description={target === 'completed' ? 'Record the outcome. Completion does not mean a payment was made.' : undefined}
        dirty={(text + waitingFor).length > 0 && !pending}
        footer={
          <>
            <Button onClick={onClose} disabled={pending}>
              Back
            </Button>
            <Button variant={target === 'cancelled' ? 'danger' : 'primary'} disabled={!valid} loading={pending} onClick={() => void go()}>
              {transitionLabel(op.status, target)}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {error ? <Banner tone="danger">{error}</Banner> : null}
          {target === 'waiting' ? (
            <>
              <Field label="Waiting For" required>
                <Input value={waitingFor} onChange={(e) => setWaitingFor(e.target.value)} maxLength={500} />
              </Field>
              <Field label="Next Check At" required>
                <DateTimeInput timezone={user.timezone} value={nextCheck} onChange={(e) => setNextCheck(e.target.value)} />
              </Field>
            </>
          ) : (
            <Field label={target === 'completed' ? 'Outcome' : 'Reason'} required helper="At least 3 characters.">
              <Textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} />
            </Field>
          )}
        </div>
      </Dialog>
      <ConflictDialog {...edit.conflictDialog} />
    </>
  );
};

const ContentBriefDialog = ({ op, onClose }: { op: OfmOperationDetail; onClose: () => void }) => {
  const { workspace, user } = useWorkspace();
  const [creator, setCreator] = useState<string | null>(null);
  const [title, setTitle] = useState(op.title);
  const [brief, setBrief] = useState(op.promisedDeliverable ?? '');
  const [due, setDue] = useState(toLocalInput(op.dueAt, user.timezone));
  const [error, setError] = useState<string | null>(null);
  // The version shown when the dialog opened (T162).
  const edit = useEditBase(op);
  const m = useOfmMutation(E.createContentBrief, { successMessage: 'Brief sent to the creator as a task', also: ['tasks.', 'myWork.'] });
  return (
    <>
      <Dialog
        open
        onOpenChange={(o) => !o && onClose()}
        title="Create Content Brief"
        description="The creator receives a task with this brief only — contact notes and history are never shared."
        dirty
        footer={
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!creator || title.trim().length < 3 || brief.trim().length < 3}
              loading={m.isPending}
              onClick={async () => {
                setError(null);
                try {
                  await m.run(
                    { params: { workspaceId: workspace.id, operationId: op.id }, body: { creatorMembershipId: creator!, title: title.trim(), brief: brief.trim(), dueAt: due ? fromLocalInput(due, user.timezone) : null } },
                    { ifMatch: edit.version },
                  );
                  onClose();
                } catch (e) {
                  if (!edit.catchConflict(e)) setError(errorMessage(e));
                }
              }}
            >
              Create Brief
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {error ? <Banner tone="danger">{error}</Banner> : null}
          <Field label="Creator" required>
            <MemberSelect value={creator} onChange={setCreator} projectId={op.project.id} permission="tasks.read" />
          </Field>
          <Field label="Task Title" required>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
          </Field>
          <Field label="Brief" required helper="What to make. Do not include contact aliases, notes or conversation history.">
            <Textarea value={brief} onChange={(e) => setBrief(e.target.value)} rows={5} maxLength={4000} />
          </Field>
          <Field label="Due">
            <DateTimeInput timezone={user.timezone} value={due} onChange={(e) => setDue(e.target.value)} />
          </Field>
        </div>
      </Dialog>
      <ConflictDialog {...edit.conflictDialog} />
    </>
  );
};

const LinkContentDialog = ({ op, onClose }: { op: OfmOperationDetail; onClose: () => void }) => {
  const { workspace } = useWorkspace();
  const [item, setItem] = useState<string | null>(op.contentItemId);
  const [error, setError] = useState<string | null>(null);
  // The version shown when the dialog opened (T162).
  const edit = useEditBase(op);
  const m = useOfmMutation(E.linkContent, { successMessage: 'Content linked' });
  return (
    <>
      <Dialog
        open
        onOpenChange={(o) => !o && onClose()}
        size="small"
        title="Link Content"
        description="Link the content item delivered for this request."
        footer={
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!item}
              loading={m.isPending}
              onClick={async () => {
                setError(null);
                try {
                  await m.run({ params: { workspaceId: workspace.id, operationId: op.id }, body: { contentItemId: item } }, { ifMatch: edit.version });
                  onClose();
                } catch (e) {
                  if (!edit.catchConflict(e)) setError(errorMessage(e));
                }
              }}
            >
              Link Content
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {error ? <Banner tone="danger">{error}</Banner> : null}
          <Field label="Content Item" required>
            <EntitySelect type="content_item" filters={{ projectId: op.project.id }} value={item} onChange={setItem} />
          </Field>
        </div>
      </Dialog>
      <ConflictDialog {...edit.conflictDialog} />
    </>
  );
};

// ——— Sale candidates ———

const amountRe = /^-?\d{1,15}(\.\d{1,6})?$/;
const optAmount = z
  .string()
  .trim()
  .refine((v) => !v || amountRe.test(v), 'Enter a decimal number.');
const saleSchema = z
  .object({
    accountId: z.string().uuid('Choose an account.'),
    sourceNamespace: z.string().trim().min(1, 'Name the source (e.g. the platform).').max(80),
    manualReference: z.boolean(),
    sourceTransactionId: z.string().trim().max(200),
    occurredAt: z.string().min(1, 'When did the sale happen?'),
    currency: z.string().length(3, 'Choose a currency.'),
    gross: optAmount,
    refund: optAmount,
    fee: optAmount,
    net: optAmount,
    contactId: z.string().optional(),
    shiftId: z.string().optional(),
    sourceNote: z.string().max(2000).optional(),
    evidenceAssetIds: z.array(z.string().uuid()).max(20),
    allocations: z.array(z.object({ membershipId: z.string().uuid('Choose a member.'), sharePercent: z.string().regex(/^\d{1,3}(\.\d{1,2})?$/, 'Percent, e.g. 50') })).max(10),
  })
  .refine((v) => v.manualReference || v.sourceTransactionId.length > 0, { path: ['sourceTransactionId'], message: 'Enter the source transaction ID or use a manual reference.' })
  .refine((v) => !v.manualReference || v.evidenceAssetIds.length > 0, { path: ['evidenceAssetIds'], message: 'A manual reference needs evidence.' })
  .refine((v) => !!(v.gross || v.net), { path: ['gross'], message: 'Enter the gross or net amount.' })
  .refine((v) => v.allocations.reduce((s, a) => s + Number(a.sharePercent || 0), 0) <= 100, { path: ['allocations'], message: 'Claimed shares cannot exceed 100 %.' });
type SaleValues = z.infer<typeof saleSchema>;

/**
 * Register Sale Candidate: one record per source transaction. Duplicates are detected before
 * saving; attribution to members is only what is claimed here — never inferred from shift timing.
 */
export const SaleCandidateDrawer = ({ preset, onClose }: { preset?: { accountId?: string; shiftId?: string; operationId?: string; contactId?: string }; onClose: () => void }) => {
  const { workspace, user } = useWorkspace();
  const models = useOfmModels();
  const form = useForm<SaleValues>({
    resolver: zodResolver(saleSchema),
    defaultValues: {
      accountId: preset?.accountId ?? '',
      sourceNamespace: '',
      manualReference: false,
      sourceTransactionId: '',
      occurredAt: toLocalInput(new Date().toISOString(), user.timezone),
      currency: workspace.baseCurrency,
      gross: '',
      refund: '',
      fee: '',
      net: '',
      contactId: preset?.contactId ?? '',
      shiftId: preset?.shiftId ?? '',
      sourceNote: '',
      evidenceAssetIds: [],
      allocations: [],
    },
  });
  const alloc = useFieldArray({ control: form.control, name: 'allocations' });
  const [error, setError] = useState<string | null>(null);
  const create = useOfmMutation(E.createSaleCandidate, { successMessage: 'Sale candidate registered — Pending Verification', also: ['finance.'] });
  const v = form.watch();
  const account = useMemo(() => (models.data ?? []).flatMap((m) => m.accounts).find((a) => a.id === v.accountId), [models.data, v.accountId]);
  useEffect(() => {
    if (account && !form.getValues('sourceNamespace')) form.setValue('sourceNamespace', account.platform);
  }, [account, form]);
  const projectId = projectOfAccount(models.data, v.accountId);
  const dupInput = useDebounced(v.manualReference ? null : v.sourceNamespace.trim() && v.sourceTransactionId.trim() ? { sourceNamespace: v.sourceNamespace.trim(), sourceTransactionId: v.sourceTransactionId.trim() } : null, 400);
  const dup = useApiQuery(E.checkSaleDuplicate, { params: { workspaceId: workspace.id }, query: dupInput ?? { sourceNamespace: '', sourceTransactionId: '' } }, { enabled: !!dupInput });
  const claimed = v.allocations.reduce((s, a) => s + (Number(a.sharePercent) || 0), 0);
  const errs = form.formState.errors;
  const submit = form.handleSubmit(async (x) => {
    setError(null);
    try {
      await create.run({
        params: { workspaceId: workspace.id },
        body: {
          accountId: x.accountId,
          sourceNamespace: x.sourceNamespace.trim(),
          sourceTransactionId: x.manualReference ? undefined : x.sourceTransactionId.trim(),
          manualReference: x.manualReference,
          occurredAt: fromLocalInput(x.occurredAt, user.timezone)!,
          currency: x.currency,
          gross: x.gross || null,
          refund: x.refund || null,
          fee: x.fee || null,
          net: x.net || null,
          contactId: x.contactId || null,
          shiftId: x.shiftId || null,
          operationId: preset?.operationId ?? null,
          sourceNote: x.sourceNote?.trim() ? x.sourceNote.trim() : null,
          evidenceAssetIds: x.evidenceAssetIds,
          claimedAllocations: x.allocations.map((a) => ({ membershipId: a.membershipId, sharePercent: a.sharePercent })),
        },
      });
      onClose();
    } catch (e) {
      if (!applyFieldErrors(e, form.setError as never)) setError(errorMessage(e, 'The sale candidate could not be registered.'));
    }
  });
  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      title="Register Sale Candidate"
      description="Stays Pending Verification until Finance verifies or rejects it. It never counts as revenue by itself."
      width={760}
      dirty={form.formState.isDirty && !create.isPending}
      footer={
        <>
          <Button onClick={onClose} disabled={create.isPending}>
            Cancel
          </Button>
          <Button variant="primary" loading={create.isPending} disabled={!!dup.data?.duplicate} onClick={() => void submit()}>
            Register
          </Button>
        </>
      }
    >
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <Field label="Account" required error={errs.accountId?.message}>
          <Controller control={form.control} name="accountId" render={({ field }) => <OfmAccountSelect value={field.value} onChange={(a) => field.onChange(a ?? '')} />} />
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Source" required error={errs.sourceNamespace?.message} helper="Where the transaction is recorded, e.g. the platform.">
            <Input {...form.register('sourceNamespace')} maxLength={80} />
          </Field>
          <Field label="Source Transaction ID" required={!v.manualReference} error={errs.sourceTransactionId?.message}>
            <Input {...form.register('sourceTransactionId')} maxLength={200} disabled={v.manualReference} />
          </Field>
        </div>
        <Controller
          control={form.control}
          name="manualReference"
          render={({ field }) => <Switch label="No transaction ID — use a manual reference" description="Castlane generates a reference; evidence is required." checked={field.value} onCheckedChange={field.onChange} />}
        />
        {dup.data?.duplicate ? (
          <Banner tone="danger">
            This source transaction is already registered{dup.data.candidate ? ` (${label('saleState', dup.data.candidate.state)})` : ''}
            {dup.data.recordedInFinance ? ' and recorded in Finance' : ''}. Duplicates are not allowed.
          </Banner>
        ) : dup.data?.recordedInFinance ? (
          <Banner tone="warning">Finance already recorded this source transaction.</Banner>
        ) : null}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Occurred At" required error={errs.occurredAt?.message}>
            <DateTimeInput timezone={user.timezone} {...form.register('occurredAt')} />
          </Field>
          <Field label="Currency" required error={errs.currency?.message}>
            <Controller control={form.control} name="currency" render={({ field }) => <Select value={field.value} onChange={(c) => c && field.onChange(c)} options={SUPPORTED_CURRENCIES.map((c) => ({ value: c, label: c }))} searchable />} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          {(['gross', 'refund', 'fee', 'net'] as const).map((k) => (
            <Field key={k} label={k === 'gross' ? 'Gross' : k === 'refund' ? 'Refund' : k === 'fee' ? 'Fee' : 'Net'} error={errs[k]?.message}>
              <AmountInput currency={v.currency} {...form.register(k)} />
            </Field>
          ))}
        </div>
        <Field label="Contact" helper="Optional; only contacts of this account.">
          <Controller
            control={form.control}
            name="contactId"
            render={({ field }) => <EntitySelect type="ofm_contact" filters={{ accountId: v.accountId || undefined }} disabled={!v.accountId} value={field.value || null} onChange={(c) => field.onChange(c ?? '')} clearable />}
          />
        </Field>
        <Field label="Shift" helper="Optional. Linking a shift does not attribute the sale to its member.">
          <Controller
            control={form.control}
            name="shiftId"
            render={({ field }) => <EntitySelect type="shift" filters={{ accountId: v.accountId || undefined }} disabled={!v.accountId} value={field.value || null} onChange={(s) => field.onChange(s ?? '')} clearable />}
          />
        </Field>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-[13px] font-[550] text-fg">Claimed Attribution</legend>
          <p className="text-[12px] text-fg-2">Only explicit claims. Whatever is not claimed stays Unassigned ({Math.max(0, 100 - claimed).toFixed(2)} %).</p>
          {alloc.fields.map((f, i) => (
            <div key={f.id} className="grid grid-cols-[1fr_110px_auto] items-start gap-2">
              <Controller
                control={form.control}
                name={`allocations.${i}.membershipId`}
                render={({ field }) => <MemberSelect aria-label={`Member ${i + 1}`} value={field.value} onChange={(m) => field.onChange(m ?? '')} />}
              />
              <Input aria-label={`Share ${i + 1} (percent)`} inputMode="decimal" {...form.register(`allocations.${i}.sharePercent`)} />
              <IconButton label="Remove claim" icon={<Trash size={16} />} onClick={() => alloc.remove(i)} />
            </div>
          ))}
          {errs.allocations?.message ? <p className="text-[12px] text-danger">{errs.allocations.message}</p> : null}
          {alloc.fields.length < 10 ? (
            <div>
              <Button size="sm" icon={<Plus size={14} />} onClick={() => alloc.append({ membershipId: '', sharePercent: '' })}>
                Add Claim
              </Button>
            </div>
          ) : null}
        </fieldset>
        <Field label="Evidence" error={errs.evidenceAssetIds?.message} helper="Screenshots or exports stored in the model’s library.">
          <Controller
            control={form.control}
            name="evidenceAssetIds"
            render={({ field }) => <MultiEntitySelect type="asset" filters={{ projectId: projectId ?? undefined }} disabled={!projectId} value={field.value} onChange={field.onChange} max={20} />}
          />
        </Field>
        <Field label="Source Note" helper="No card numbers or payment credentials.">
          <Textarea {...form.register('sourceNote')} maxLength={2000} />
        </Field>
      </form>
    </Drawer>
  );
};

export const SaleCandidateList = ({ items, empty }: { items: OfmSaleCandidate[]; empty: string }) => {
  const { user } = useWorkspace();
  if (!items.length) return <p className="text-[13px] text-fg-2">{empty}</p>;
  return (
    <ul className="flex flex-col divide-y divide-line rounded-[12px] border border-line">
      {items.map((c) => (
        <li key={c.id} className="flex flex-col gap-1 px-3 py-2 text-[13px] md:flex-row md:items-center md:justify-between">
          <div className="min-w-0">
            <p className="truncate font-medium text-fg">
              {c.sourceNamespace} · {c.sourceTransactionId}
            </p>
            <p className="text-fg-2">
              {formatDateTime(c.occurredAt, user.timezone)} · {c.account.label}
              {c.contact ? (c.contact.restricted ? ' · linked contact' : ` · ${c.contact.alias}`) : ''}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            {c.money ? <span className="font-mono tabular-nums">{formatMoney(c.money.net ?? c.money.gross, c.currency)}</span> : null}
            <Badge tone={c.attributionStatus === 'full' ? 'success' : c.attributionStatus === 'partial' ? 'info' : 'neutral'}>
              {label('attribution', c.attributionStatus)}
              {c.attributionStatus !== 'full' ? ` · ${formatPercent(c.unassignedPercent, 0)} unassigned` : ''}
            </Badge>
            <StatusBadge status={c.state === 'verified' ? 'approved' : c.state === 'rejected' ? 'rejected' : 'pending'} label={label('saleState', c.state)} />
          </div>
        </li>
      ))}
    </ul>
  );
};

// ——— Interactions ———

export const InteractionDialog = ({ contactId, accountId, shiftId, onClose }: { contactId?: string; accountId?: string; shiftId?: string; onClose: () => void }) => {
  const { workspace, user } = useWorkspace();
  const [contact, setContact] = useState<string | null>(contactId ?? null);
  const [type, setType] = useState<(typeof INTERACTION_TYPES)[number]>('message_summary');
  const [when, setWhen] = useState(toLocalInput(new Date().toISOString(), user.timezone));
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const m = useOfmMutation(E.createInteraction, { successMessage: 'Interaction logged' });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Log Interaction"
      description="A manual business record — not a platform inbox. No passwords, card data or intimate details."
      dirty={note.length > 0 && !m.isPending}
      footer={
        <>
          <Button onClick={onClose} disabled={m.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!contact || !note.trim() || !when}
            loading={m.isPending}
            onClick={async () => {
              setError(null);
              try {
                await m.run({ params: { workspaceId: workspace.id }, body: { contactId: contact!, type, occurredAt: fromLocalInput(when, user.timezone)!, businessNote: note.trim(), shiftId: shiftId ?? null } });
                onClose();
              } catch (e) {
                setError(errorMessage(e));
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
        {contactId ? null : (
          <Field label="Contact" required>
            <EntitySelect type="ofm_contact" filters={{ accountId }} value={contact} onChange={setContact} />
          </Field>
        )}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Type" required>
            <Select value={type} onChange={(t) => t && setType(t)} options={INTERACTION_TYPES.map((t) => ({ value: t, label: label('interactionType', t) }))} />
          </Field>
          <Field label="Occurred At" required>
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

/** Operation row used in shift and contact workspaces. */
export const OperationRow = ({ op, onOpen }: { op: OfmOperationSummary; onOpen: () => void }) => {
  const { user } = useWorkspace();
  return (
    <li className="flex flex-col gap-1 px-3 py-2 text-[13px] md:flex-row md:items-center md:justify-between">
      <button type="button" onClick={onOpen} className="min-w-0 text-left hover:underline focus-visible:outline-2 focus-visible:outline-[var(--c-focus)]">
        <span className="font-medium text-fg">{op.title}</span>
        <span className="block text-fg-2">
          {label('operationType', op.type)} · {op.owner.displayName}
          {op.dueAt ? ` · due ${formatDateTime(op.dueAt, user.timezone)}` : ''}
        </span>
      </button>
      <span className="flex shrink-0 flex-wrap items-center gap-1.5">
        {op.overdue ? <Badge tone="danger">Overdue</Badge> : null}
        <StatusBadge status={op.status === 'in_progress' ? 'active' : op.status} label={label('operationStatus', op.status)} />
      </span>
    </li>
  );
};

