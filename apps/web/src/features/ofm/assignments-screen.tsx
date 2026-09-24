'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { DotsThree, UserPlus } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { ofmEndpoints as E, type OfmAssignmentDetail, type OfmAssignmentRow } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { COVERAGE_LANES, RESPONSIBILITIES } from '@castlane/domain';
import {
  Badge,
  Banner,
  Button,
  DataTable,
  DateTimeInput,
  DescriptionList,
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
  Select,
  StatusBadge,
  Switch,
  Toolbar,
  formatDateTime,
  type Column,
} from '@castlane/ui';
import { ConflictDialog } from '@/components/common/conflict';
import { changedFields, pickChanged, useEditBase } from '@/lib/edit-base';
import { MemberSelect } from '@/components/common/pickers';
import { QueryState } from '@/components/common/query-state';
import { applyFieldErrors, useApiInfinite, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';
import { useCan, useWorkspace } from '@/lib/workspace-context';
import { AccountChip, MemberChip, OfmNav, ReasonDialog, errorMessage, fmtRange, fromLocalInput, toLocalInput, useOfmMutation } from './common';
import { OfmAccountSelect, OfmModelSelect, projectOfAccount, useOfmModels } from './pickers';

type Filters = 'projectId' | 'accountId' | 'membershipId' | 'status' | 'open' | 'create';

/** S41 OFM Assignments: who covers which account, when, in which lane — with history and impact preview. */
export const AssignmentsScreen = () => {
  const { workspace, user } = useWorkspace();
  const can = useCan();
  const { state, set, list } = useUrlState<Filters>({ status: 'current,upcoming' });
  const status = (state.status === 'all' ? [] : list('status')) as OfmAssignmentRow['status'][];
  const query = { projectId: state.projectId, accountId: state.accountId, membershipId: state.membershipId, status, sort: 'validFrom' as const, direction: 'desc' as const };
  const data = useApiInfinite(E.listAssignments, { params: { workspaceId: workspace.id }, query });
  const filtered = !!(state.projectId || state.accountId || state.membershipId);
  const manage = can('ofm.assignments.manage');

  const columns: Column<OfmAssignmentRow>[] = [
    { key: 'member', header: 'Member', sticky: true, minWidth: 190, cell: (r) => <MemberChip member={r.member} /> },
    { key: 'account', header: 'Account', minWidth: 180, cell: (r) => <AccountChip account={r.account} /> },
    { key: 'model', header: 'Model', minWidth: 140, cell: (r) => r.project.name },
    { key: 'duty', header: 'Responsibility', minWidth: 150, cell: (r) => label('responsibility', r.responsibility) },
    { key: 'lane', header: 'Coverage Lane', minWidth: 130, cell: (r) => (r.coverageLane === 'custom' ? (r.coverageLaneLabel ?? 'Custom') : label('coverageLane', r.coverageLane)) },
    { key: 'from', header: 'Valid From', minWidth: 160, cell: (r) => formatDateTime(r.validFrom, user.timezone) },
    { key: 'to', header: 'Valid To', minWidth: 160, cell: (r) => (r.validTo ? formatDateTime(r.validTo, user.timezone) : <span className="text-fg-muted">Open-ended</span>) },
    { key: 'supervisor', header: 'Supervisor', minWidth: 160, cell: (r) => <MemberChip member={r.supervisor} /> },
    { key: 'handover', header: 'Handover', minWidth: 110, cell: (r) => (r.handoverRequired ? 'Required' : 'Optional') },
    { key: 'status', header: 'Status', minWidth: 110, cell: (r) => <StatusBadge status={r.status === 'current' ? 'active' : r.status === 'upcoming' ? 'scheduled' : 'archived'} label={label('assignmentStatus', r.status)} /> },
  ];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="OFM Assignments"
        crumbs={[{ label: 'OFM', href: `/w/${workspace.id}/ofm` }, { label: 'Assignments' }]}
        description="Managers assigned to model accounts for a period and coverage lane. An assignment never grants finance access by itself."
        actions={
          manage ? (
            <Button variant="primary" icon={<UserPlus size={14} />} onClick={() => set({ create: '1' })}>
              Add Assignment
            </Button>
          ) : undefined
        }
      />
      <OfmNav />
      <Toolbar>
        <div className="w-full sm:w-[200px]">
          <OfmModelSelect aria-label="Model" placeholder="All models" value={state.projectId} onChange={(v) => set({ projectId: v, accountId: null })} clearable />
        </div>
        <div className="w-full sm:w-[200px]">
          <OfmAccountSelect aria-label="Account" placeholder="All accounts" projectId={state.projectId} value={state.accountId} onChange={(v) => set({ accountId: v })} clearable />
        </div>
        <div className="w-full sm:w-[200px]">
          <MemberSelect aria-label="Member" placeholder="All members" value={state.membershipId} onChange={(v) => set({ membershipId: v })} clearable />
        </div>
        <div className="w-full sm:w-[220px]">
          <MultiSelect
            aria-label="Status"
            placeholder="Any status"
            value={status}
            onChange={(v) => set({ status: v.join(',') || 'all' })}
            options={(['current', 'upcoming', 'ended'] as const).map((s) => ({ value: s, label: label('assignmentStatus', s) }))}
          />
        </div>
      </Toolbar>
      <QueryState query={data}>
        {data.items.length === 0 && !data.isFetching ? (
          filtered ? (
            <NoResults onClear={() => set({ projectId: null, accountId: null, membershipId: null })} />
          ) : (
            <EmptyState
              icon={<UserPlus size={28} />}
              title="No assignments yet"
              description={manage ? 'Assign managers to model accounts before scheduling shifts.' : 'You have no OFM assignments. Your supervisor assigns you to accounts.'}
              action={manage ? <Button variant="primary" onClick={() => set({ create: '1' })}>Add Assignment</Button> : undefined}
            />
          )
        ) : (
          <DataTable
            caption="OFM assignments"
            rows={data.items}
            columns={columns}
            getRowId={(r) => r.id}
            density={user.density}
            onRowClick={(r) => set({ open: r.id })}
            hasMore={data.hasNextPage}
            loadingMore={data.isFetchingNextPage}
            onLoadMore={() => void data.fetchNextPage()}
          />
        )}
      </QueryState>
      {state.create === '1' ? <AssignmentDrawer onClose={() => set({ create: null })} /> : null}
      {state.open ? <AssignmentDetailDrawer id={state.open} onClose={() => set({ open: null })} /> : null}
    </div>
  );
};

const schema = z
  .object({
    projectId: z.string().uuid('Choose a model.'),
    accountId: z.string().uuid('Choose an account.'),
    membershipId: z.string().uuid('Choose a member.'),
    responsibility: z.enum(RESPONSIBILITIES),
    coverageLane: z.enum(COVERAGE_LANES),
    coverageLaneLabel: z.string().max(40).optional(),
    validFrom: z.string().min(1, 'Choose when the assignment starts.'),
    validTo: z.string().optional(),
    supervisorMembershipId: z.string().optional(),
    handoverRequired: z.boolean(),
  })
  .refine((v) => v.coverageLane !== 'custom' || (v.coverageLaneLabel?.trim().length ?? 0) >= 2, { path: ['coverageLaneLabel'], message: 'Name the custom lane.' });
type FormValues = z.infer<typeof schema>;

/** Add Assignment drawer with a live access impact preview. */
export const AssignmentDrawer = ({ onClose, preset }: { onClose: () => void; preset?: { projectId?: string; accountId?: string; membershipId?: string } }) => {
  const { workspace, user } = useWorkspace();
  const models = useOfmModels();
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      projectId: preset?.projectId ?? '',
      accountId: preset?.accountId ?? '',
      membershipId: preset?.membershipId ?? '',
      responsibility: 'ofm_operations',
      coverageLane: 'primary',
      validFrom: toLocalInput(new Date().toISOString(), user.timezone),
      handoverRequired: true,
    },
  });
  const [error, setError] = useState<string | null>(null);
  const create = useOfmMutation(E.createAssignment, { successMessage: 'Assignment added', silentErrors: true });
  const projectId = form.watch('projectId');
  const accountId = form.watch('accountId');
  const memberId = form.watch('membershipId');
  const lane = form.watch('coverageLane');
  useEffect(() => {
    if (accountId && !projectId) form.setValue('projectId', projectOfAccount(models.data, accountId) ?? '');
  }, [accountId, projectId, models.data, form]);
  const impact = useApiQuery(
    E.assignmentImpact,
    { params: { workspaceId: workspace.id }, query: { membershipId: memberId, accountId, action: 'create' } },
    { enabled: !!memberId && !!accountId },
  );
  const submit = form.handleSubmit(async (v) => {
    setError(null);
    try {
      await create.run({
        params: { workspaceId: workspace.id },
        body: {
          accountId: v.accountId,
          membershipId: v.membershipId,
          responsibility: v.responsibility,
          coverageLane: v.coverageLane,
          coverageLaneLabel: v.coverageLane === 'custom' ? v.coverageLaneLabel?.trim() : null,
          validFrom: fromLocalInput(v.validFrom, user.timezone)!,
          validTo: v.validTo ? fromLocalInput(v.validTo, user.timezone) : null,
          supervisorMembershipId: v.supervisorMembershipId || null,
          handoverRequired: v.handoverRequired,
        },
      });
      onClose();
    } catch (e) {
      if (!applyFieldErrors(e, form.setError as never)) setError(errorMessage(e, 'The assignment could not be saved.'));
    }
  });
  const errs = form.formState.errors;
  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      title="Add Assignment"
      description="The member gets access to the account’s OFM work only."
      dirty={form.formState.isDirty && !create.isPending}
      footer={
        <>
          <Button onClick={onClose} disabled={create.isPending}>
            Cancel
          </Button>
          <Button variant="primary" loading={create.isPending} onClick={() => void submit()}>
            Add Assignment
          </Button>
        </>
      }
    >
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <Field label="Model" required error={errs.projectId?.message}>
          <Controller control={form.control} name="projectId" render={({ field }) => <OfmModelSelect value={field.value} onChange={(v) => { field.onChange(v ?? ''); form.setValue('accountId', ''); }} />} />
        </Field>
        <Field label="Account" required error={errs.accountId?.message}>
          <Controller control={form.control} name="accountId" render={({ field }) => <OfmAccountSelect projectId={projectId || undefined} value={field.value} onChange={(v) => field.onChange(v ?? '')} />} />
        </Field>
        <Field label="Member" required error={errs.membershipId?.message}>
          <Controller control={form.control} name="membershipId" render={({ field }) => <MemberSelect value={field.value} onChange={(v) => field.onChange(v ?? '')} />} />
        </Field>
        <Field label="Responsibility" required error={errs.responsibility?.message}>
          <Controller
            control={form.control}
            name="responsibility"
            render={({ field }) => <Select value={field.value} onChange={(v) => field.onChange(v ?? 'ofm_operations')} options={RESPONSIBILITIES.map((r) => ({ value: r, label: label('responsibility', r) }))} />}
          />
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Coverage Lane" required helper="Several managers can cover one account in different lanes.">
            <Controller control={form.control} name="coverageLane" render={({ field }) => <Select value={field.value} onChange={(v) => field.onChange(v ?? 'primary')} options={COVERAGE_LANES.map((l) => ({ value: l, label: label('coverageLane', l) }))} />} />
          </Field>
          {lane === 'custom' ? (
            <Field label="Lane Name" required error={errs.coverageLaneLabel?.message}>
              <Input {...form.register('coverageLaneLabel')} maxLength={40} />
            </Field>
          ) : null}
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Valid From" required error={errs.validFrom?.message}>
            <DateTimeInput timezone={user.timezone} {...form.register('validFrom')} />
          </Field>
          <Field label="Valid To" helper="Optional. Shifts cannot be scheduled beyond it." error={errs.validTo?.message}>
            <DateTimeInput timezone={user.timezone} {...form.register('validTo')} />
          </Field>
        </div>
        <Field label="Supervisor" helper="Defaults to the model’s OFM supervisor.">
          <Controller control={form.control} name="supervisorMembershipId" render={({ field }) => <MemberSelect value={field.value} onChange={(v) => field.onChange(v ?? '')} clearable />} />
        </Field>
        <Controller
          control={form.control}
          name="handoverRequired"
          render={({ field }) => <Switch label="Handover Required" description="Reports need handover items or an explicit No Open Items." checked={field.value} onCheckedChange={field.onChange} />}
        />
        {impact.data ? (
          <Banner tone="info">
            <p className="font-semibold">Access impact</p>
            <ul className="mt-1 list-disc pl-5">
              <li>{impact.data.gainsAccountAccess ? `${impact.data.member.displayName} will see OFM work of ${impact.data.account.label}.` : 'No new account visibility.'}</li>
              {impact.data.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </Banner>
        ) : null}
      </form>
    </Drawer>
  );
};

const AssignmentDetailDrawer = ({ id, onClose }: { id: string; onClose: () => void }) => {
  const { workspace, user } = useWorkspace();
  const q = useApiQuery(E.getAssignment, { params: { workspaceId: workspace.id, assignmentId: id } });
  const [editing, setEditing] = useState(false);
  const [ending, setEnding] = useState(false);
  const [transfer, setTransfer] = useState(false);
  const end = useOfmMutation(E.endAssignment, { successMessage: 'Assignment ended', silentErrors: true });
  const a = q.data;
  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      title="Assignment"
      width={760}
      headerActions={
        a && (a.permissions.update || a.permissions.transfer || a.permissions.end) ? (
          <Menu
            label="Assignment actions"
            trigger={<IconButton label="Assignment actions" icon={<DotsThree size={18} weight="bold" />} />}
            items={[
              { label: 'Edit', onSelect: () => setEditing(true), hidden: !a.permissions.update },
              { label: 'Transfer', onSelect: () => setTransfer(true), hidden: !a.permissions.transfer },
              { label: 'End Assignment', destructive: true, onSelect: () => setEnding(true), hidden: !a.permissions.end, separatorBefore: true },
            ]}
          />
        ) : null
      }
    >
      <QueryState query={q}>
        {a ? (
          <div className="flex flex-col gap-5">
            <DescriptionList
              items={[
                { label: 'Member', value: <MemberChip member={a.member} /> },
                { label: 'Account', value: <AccountChip account={a.account} /> },
                { label: 'Model', value: a.project.name },
                { label: 'Responsibility', value: label('responsibility', a.responsibility) },
                { label: 'Coverage Lane', value: a.coverageLane === 'custom' ? a.coverageLaneLabel : label('coverageLane', a.coverageLane) },
                { label: 'Status', value: label('assignmentStatus', a.status) },
                { label: 'Valid From', value: formatDateTime(a.validFrom, user.timezone) },
                { label: 'Valid To', value: a.validTo ? formatDateTime(a.validTo, user.timezone) : 'Open-ended' },
                { label: 'Supervisor', value: <MemberChip member={a.supervisor} /> },
                { label: 'Handover', value: a.handoverRequired ? 'Required' : 'Optional' },
                { label: 'Ended', value: a.endedAt ? `${formatDateTime(a.endedAt, user.timezone)} — ${a.endedReason ?? ''}` : null, hidden: !a.endedAt },
              ]}
            />
            <section>
              <h3 className="mb-2 text-[14px] font-semibold text-fg">Upcoming Shifts</h3>
              {a.upcomingShifts.length ? (
                <ul className="flex flex-col divide-y divide-line rounded-[12px] border border-line">
                  {a.upcomingShifts.map((s) => (
                    <li key={s.id} className="flex items-center justify-between gap-2 px-3 py-2 text-[13px]">
                      <a className="hover:underline" href={`/w/${workspace.id}/ofm/shifts/${s.id}`}>
                        {fmtRange(s.scheduledStart, s.scheduledEnd, user.timezone)}
                      </a>
                      <StatusBadge status={s.state} label={label('shiftState', s.state)} />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[13px] text-fg-2">No upcoming shifts on this account.</p>
              )}
            </section>
            <section>
              <h3 className="mb-2 text-[14px] font-semibold text-fg">Account Assignment History</h3>
              {a.history.length ? (
                <ul className="flex flex-col divide-y divide-line rounded-[12px] border border-line">
                  {a.history.map((h) => (
                    <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-[13px]">
                      <MemberChip member={h.member} />
                      <span className="text-fg-2">
                        {formatDateTime(h.validFrom, user.timezone)} – {h.validTo ? formatDateTime(h.validTo, user.timezone) : 'open'}
                      </span>
                      <Badge>{label('assignmentStatus', h.status)}</Badge>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[13px] text-fg-2">No other assignments on this account.</p>
              )}
            </section>
          </div>
        ) : null}
      </QueryState>
      {a && editing ? <EditAssignmentDialog a={a} onClose={() => setEditing(false)} /> : null}
      {a && transfer ? <TransferDialog a={a} onClose={() => setTransfer(false)} /> : null}
      {a ? (
        <ReasonDialog
          open={ending}
          onOpenChange={setEnding}
          title="End assignment?"
          body={`${a.member.displayName} loses OFM access to ${a.account.label} now. History and past shifts stay. Scheduled shifts after the end must be cancelled or moved first.`}
          confirmLabel="End Assignment"
          destructive
          record={a}
          onConfirm={(reason, ifMatch) => end.run({ params: { workspaceId: workspace.id, assignmentId: a.id }, body: { reason } }, { ifMatch })}
        />
      ) : null}
    </Drawer>
  );
};

const EditAssignmentDialog = ({ a, onClose }: { a: OfmAssignmentDetail; onClose: () => void }) => {
  const { workspace, user } = useWorkspace();
  const [validTo, setValidTo] = useState(toLocalInput(a.validTo, user.timezone));
  const [supervisor, setSupervisor] = useState<string | null>(a.supervisor?.membershipId ?? null);
  const [handover, setHandover] = useState(a.handoverRequired);
  const [error, setError] = useState<string | null>(null);
  // Edits apply to the assignment as the dialog opened; only changed fields are sent (T162).
  const edit = useEditBase(a, {
    onReload: (x) => {
      setValidTo(toLocalInput(x.validTo, user.timezone));
      setSupervisor(x.supervisor?.membershipId ?? null);
      setHandover(x.handoverRequired);
    },
  });
  const m = useOfmMutation(E.updateAssignment, { successMessage: 'Assignment updated', silentErrors: true });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Edit assignment"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={m.isPending}
            onClick={async () => {
              setError(null);
              try {
                const s = edit.start ?? a;
                const body = { validTo: validTo ? fromLocalInput(validTo, user.timezone) : null, supervisorMembershipId: supervisor, handoverRequired: handover };
                const shownTo = toLocalInput(s.validTo, user.timezone);
                const before = { validTo: shownTo ? fromLocalInput(shownTo, user.timezone) : null, supervisorMembershipId: s.supervisor?.membershipId ?? null, handoverRequired: s.handoverRequired };
                await m.run({ params: { workspaceId: workspace.id, assignmentId: a.id }, body: pickChanged(body, changedFields(before, body)) }, { ifMatch: edit.version });
                onClose();
              } catch (e) {
                if (!edit.catchConflict(e)) setError(errorMessage(e));
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
        <Field label="Valid To" helper="Shortening is blocked while scheduled shifts fall outside.">
          <DateTimeInput timezone={user.timezone} value={validTo} onChange={(e) => setValidTo(e.target.value)} />
        </Field>
        <Field label="Supervisor">
          <MemberSelect value={supervisor} onChange={setSupervisor} clearable />
        </Field>
        <Switch label="Handover Required" checked={handover} onCheckedChange={setHandover} />
      </div>
      <ConflictDialog {...edit.conflictDialog} />
    </Dialog>
  );
};

const TransferDialog = ({ a, onClose }: { a: OfmAssignmentDetail; onClose: () => void }) => {
  const { workspace, user } = useWorkspace();
  const [to, setTo] = useState<string | null>(null);
  const [when, setWhen] = useState('');
  const [reason, setReason] = useState('');
  const [move, setMove] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // The version shown when the dialog opened (T162).
  const edit = useEditBase(a);
  const m = useOfmMutation(E.transferAssignment, { successMessage: 'Assignment transferred', silentErrors: true });
  const impact = useApiQuery(
    E.assignmentImpact,
    { params: { workspaceId: workspace.id }, query: { membershipId: a.member.membershipId, accountId: a.account.id, assignmentId: a.id, action: 'transfer', validTo: when ? (fromLocalInput(when, user.timezone) ?? undefined) : undefined } },
  );
  return (
    <>
      <Dialog
        open
        onOpenChange={(o) => !o && onClose()}
        title="Transfer assignment"
        description="The current assignment ends at the effective time and a new one starts for the successor with the same lane."
        footer={
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!to || reason.trim().length < 3}
              loading={m.isPending}
              onClick={async () => {
                setError(null);
                try {
                  await m.run(
                    { params: { workspaceId: workspace.id, assignmentId: a.id }, body: { toMembershipId: to!, reason: reason.trim(), effectiveAt: when ? (fromLocalInput(when, user.timezone) ?? undefined) : undefined, moveFutureShifts: move } },
                    { ifMatch: edit.version },
                  );
                  onClose();
                } catch (e) {
                  if (!edit.catchConflict(e)) setError(errorMessage(e));
                }
              }}
            >
              Transfer
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {error ? <Banner tone="danger">{error}</Banner> : null}
          <Field label="New member" required>
            <MemberSelect value={to} onChange={setTo} />
          </Field>
          <Field label="Effective at" helper="Leave empty for now.">
            <DateTimeInput timezone={user.timezone} value={when} onChange={(e) => setWhen(e.target.value)} />
          </Field>
          <Switch label="Move future scheduled shifts" description="Each shift is re-checked against the successor’s assignments and schedule." checked={move} onCheckedChange={setMove} />
          {impact.data?.shiftsOutsideInterval.length ? (
            <Banner tone="warning">{impact.data.shiftsOutsideInterval.length} scheduled shift(s) are affected.</Banner>
          ) : null}
          <Field label="Reason" required>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} />
          </Field>
        </div>
      </Dialog>
      <ConflictDialog {...edit.conflictDialog} />
    </>
  );
};
