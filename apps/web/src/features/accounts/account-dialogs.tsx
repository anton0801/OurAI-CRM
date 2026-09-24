'use client';
import { useEffect, useState } from 'react';
import { accountEndpoints, type AccountDetail, type ImpactItem } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { RESPONSIBILITIES } from '@castlane/domain';
import { Banner, Button, ConfirmDialog, Dialog, Field, Select, Spinner, Textarea, toast } from '@castlane/ui';
import { EntitySelect } from '@/components/common/entity-select';
import { MemberSelect } from '@/components/common/pickers';
import { useApiMutation, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useWorkspace } from '@/lib/workspace-context';
import { ARCHIVE_EXPLANATION } from './labels';

export const ImpactList = ({ items }: { items: ImpactItem[] }) =>
  items.length ? (
    <ul className="flex flex-col gap-1 rounded-[8px] bg-surface-2 p-3 text-[13px]">
      {items.map((i) => (
        <li key={i.kind} className={i.blocking ? 'text-danger' : 'text-fg-2'}>
          <span className="font-medium">{i.blocking ? 'Blocking' : 'Note'}:</span> {i.label} — {i.count}
          {i.resolution ? ` (${i.resolution})` : ''}
        </li>
      ))}
    </ul>
  ) : null;

/** Add Member / Assign Team: member + duty (+ optional supervisor). */
export const AssignMemberDialog = ({ open, onOpenChange, accountId }: { open: boolean; onOpenChange: (o: boolean) => void; accountId: string }) => {
  const { workspace } = useWorkspace();
  const [member, setMember] = useState<string | null>(null);
  const [duty, setDuty] = useState<string | null>(null);
  const [supervisor, setSupervisor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const assign = useApiMutation(accountEndpoints.assign, { invalidate: ['accounts.'], successMessage: 'Member assigned', silentErrors: true });
  const reset = () => {
    setMember(null);
    setDuty(null);
    setSupervisor(null);
    setError(null);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
      dirty={!!member || !!duty}
      title="Assign member"
      size="small"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!member || !duty}
            loading={assign.isPending}
            onClick={async () => {
              setError(null);
              try {
                await assign.run({ params: { workspaceId: workspace.id, accountId }, body: { membershipId: member!, duty: duty as never, supervisorMembershipId: supervisor } });
                reset();
                onOpenChange(false);
              } catch (e) {
                setError(isApiError(e) ? e.message : 'The member could not be assigned.');
              }
            }}
          >
            Assign
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <Field label="Member" required>
          <MemberSelect value={member} onChange={setMember} />
        </Field>
        <Field label="Duty" required>
          <Select value={duty} onChange={setDuty} options={RESPONSIBILITIES.map((r) => ({ value: r, label: label('responsibility', r) }))} />
        </Field>
        <Field label="Supervisor">
          <MemberSelect value={supervisor} onChange={setSupervisor} clearable />
        </Field>
        <p className="text-[12px] text-fg-2">The assignment limits what the member’s role covers; it grants no finance, OFM contact or restricted-media access.</p>
      </div>
    </Dialog>
  );
};

const TRANSITION_TEXT: Record<string, { title: string; confirm: string; body: string; reason?: 'required' | 'optional'; reasonLabel?: string }> = {
  active: { title: 'Activate account?', confirm: 'Activate', body: 'The account can be used for planning publications again.', reason: 'optional' },
  paused: { title: 'Pause account?', confirm: 'Pause', body: 'Planning on a paused account shows a warning. Existing plans stay.', reason: 'optional' },
  restricted: {
    title: 'Mark account as restricted?',
    confirm: 'Mark Restricted',
    body: 'New publications cannot be planned on a restricted account until a lead resolves the restriction.',
    reason: 'required',
    reasonLabel: 'What did the platform restrict?',
  },
  archived: { title: 'Archive account?', confirm: 'Archive', body: ARCHIVE_EXPLANATION, reason: 'optional' },
};

/** Status change with reason (restriction reason / resolution required) and archive obligations. */
export const TransitionDialog = ({ account, target, onClose }: { account: AccountDetail; target: AccountDetail['status'] | null; onClose: () => void }) => {
  const { workspace } = useWorkspace();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [blockers, setBlockers] = useState<ImpactItem[] | null>(null);
  const transition = useApiMutation(accountEndpoints.transition, { invalidate: ['accounts.'], silentErrors: true });
  const preview = useApiQuery(accountEndpoints.archivePreview, { params: { workspaceId: workspace.id, accountId: account.id } }, { enabled: target === 'archived' });
  useEffect(() => {
    setReason('');
    setError(null);
    setBlockers(null);
  }, [target]);
  if (!target) return null;
  const resolving = account.status === 'restricted' && target === 'active';
  const text = resolving
    ? { title: 'Resolve restriction?', confirm: 'Resolve Restriction', body: 'The account becomes active again.', reason: 'required' as const, reasonLabel: 'How was the restriction resolved?' }
    : (TRANSITION_TEXT[target] ?? { title: 'Change status?', confirm: 'Confirm', body: '' });
  const reasonRequired = text.reason === 'required';
  const blocking = (preview.data?.items ?? []).some((i) => i.blocking);
  return (
    <ConfirmDialog
      open={!!target}
      onOpenChange={(o) => !o && onClose()}
      title={text.title}
      body={text.body}
      confirmLabel={text.confirm}
      destructive={target === 'archived' || target === 'restricted'}
      loading={transition.isPending}
      confirmDisabled={(reasonRequired && reason.trim().length < 3) || (target === 'archived' && (preview.isLoading || blocking))}
      onConfirm={async () => {
        setError(null);
        try {
          await transition.run({ params: { workspaceId: workspace.id, accountId: account.id }, body: { targetState: target, reason: reason.trim() || undefined } }, { ifMatch: account.rowVersion });
          toast.success(`Account is now ${label('accountStatus', target).toLowerCase()}`);
          onClose();
        } catch (e) {
          if (isApiError(e) && Array.isArray(e.details?.items)) setBlockers(e.details!.items as ImpactItem[]);
          else if (isApiError(e) && e.code === 'VERSION_CONFLICT') setError('This record changed while you were editing it. Close and reopen to see the latest version.');
          else setError(isApiError(e) ? e.message : 'The status could not be changed.');
        }
      }}
    >
      {target === 'archived' ? preview.isLoading ? <Spinner label="Checking open obligations" /> : <ImpactList items={preview.data?.items ?? []} /> : null}
      {blockers ? <ImpactList items={blockers} /> : null}
      {error ? <Banner tone="danger">{error}</Banner> : null}
      {text.reason ? (
        <Field label={text.reasonLabel ?? 'Reason'} required={reasonRequired}>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} />
        </Field>
      ) : null}
    </ConfirmDialog>
  );
};

/** Transfer to another project: preview (blocking obligations, effects) → confirm with the impact token. */
export const TransferDialog = ({ account, open, onOpenChange }: { account: AccountDetail; open: boolean; onOpenChange: (o: boolean) => void }) => {
  const { workspace } = useWorkspace();
  const [target, setTarget] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const preview = useApiQuery(
    accountEndpoints.transferPreview,
    { params: { workspaceId: workspace.id, accountId: account.id }, query: { targetProjectId: target ?? '' } },
    { enabled: open && !!target, retry: false },
  );
  const transfer = useApiMutation(accountEndpoints.transfer, { invalidate: ['accounts.', 'projects.'], silentErrors: true, successMessage: 'Account moved to the new project' });
  const close = () => {
    setTarget(null);
    setReason('');
    setError(null);
    onOpenChange(false);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => (o ? onOpenChange(true) : close())}
      dirty={!!target || !!reason}
      title="Transfer account to another project"
      description="The account history stays in one place. Existing publications, tasks, metrics and finance keep their original project; new work uses the new project."
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!preview.data?.impactToken || reason.trim().length < 3}
            loading={transfer.isPending}
            onClick={async () => {
              setError(null);
              try {
                await transfer.run(
                  { params: { workspaceId: workspace.id, accountId: account.id }, body: { targetProjectId: target!, impactToken: preview.data!.impactToken!, reason: reason.trim() } },
                  { ifMatch: account.rowVersion },
                );
                close();
              } catch (e) {
                if (isApiError(e) && Array.isArray(e.details?.items)) setError('New obligations appeared. Review the preview again.');
                else setError(isApiError(e) ? e.message : 'The account could not be transferred.');
                void preview.refetch();
              }
            }}
          >
            Transfer Account
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="New project" required error={preview.error && preview.error.status === 422 ? preview.error.message : null}>
          <EntitySelect type="project" value={target} onChange={setTarget} />
        </Field>
        {preview.isFetching ? <Spinner label="Checking the impact" /> : null}
        {preview.data ? (
          <>
            {preview.data.blocked ? <Banner tone="danger">Resolve the blocking items before the account can move.</Banner> : null}
            <ImpactList items={preview.data.items} />
            {!preview.data.items.length ? <p className="text-[13px] text-fg-2">No open obligations. The move can be completed.</p> : null}
          </>
        ) : null}
        {preview.error && preview.error.status !== 422 ? <Banner tone="danger">{preview.error.message}</Banner> : null}
        <Field label="Reason" required>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} />
        </Field>
        {error ? <Banner tone="danger">{error}</Banner> : null}
      </div>
    </Dialog>
  );
};

