'use client';
import { DotsThree } from '@phosphor-icons/react';
import { useState } from 'react';
import { workloadEndpoints, type AbsenceView } from '@castlane/api-contracts';
import { LIMITS } from '@castlane/domain';
import { ConfirmDialog, DataTable, Field, IconButton, Menu, Panel, StatusBadge, Textarea, formatDate, type Column, type MenuItem } from '@castlane/ui';
import { QueryState } from '@/components/common/query-state';
import { useApiMutation, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useWorkspace } from '@/lib/workspace-context';
import { Person } from '../tasks/format';
import { AbsenceDialog, WORKLOAD_INVALIDATE } from './workload-dialogs';

type Pending = { kind: 'approve' | 'reject' | 'cancel'; absence: AbsenceView } | null;

/** Absences in a period, with Approve / Reject for requests and Cancel (history is kept). */
export const AbsencesPanel = ({ from, to, membershipId, title = 'Absences' }: { from?: string; to?: string; membershipId?: string; title?: string }) => {
  const { workspace, user } = useWorkspace();
  const q = useApiQuery(workloadEndpoints.absences, { params: { workspaceId: workspace.id }, query: { from, to, membershipId, state: ['requested', 'approved'] } });
  const [pending, setPending] = useState<Pending>(null);
  const [edit, setEdit] = useState<AbsenceView | null>(null);
  const [reason, setReason] = useState('');
  const decide = useApiMutation(workloadEndpoints.decideAbsence, { invalidate: WORKLOAD_INVALIDATE, successMessage: (a) => `Absence ${label('absenceState', a.state).toLowerCase()}` });
  const cancel = useApiMutation(workloadEndpoints.cancelAbsence, { invalidate: WORKLOAD_INVALIDATE, successMessage: 'Absence cancelled' });
  const columns: Column<AbsenceView>[] = [
    { key: 'member', header: 'Member', sticky: true, minWidth: 180, cell: (a) => <Person member={a.member} /> },
    { key: 'dates', header: 'Dates', minWidth: 190, cell: (a) => `${formatDate(a.startDate)} – ${formatDate(a.endDate)}` },
    { key: 'category', header: 'Category', minWidth: 130, cell: (a) => label('absenceCategory', a.category) },
    { key: 'state', header: 'State', minWidth: 120, cell: (a) => <StatusBadge status={a.state} label={label('absenceState', a.state)} /> },
    { key: 'reason', header: 'Private reason', minWidth: 180, cell: (a) => (a.privateReason === undefined ? <span className="text-fg-muted">Private</span> : (a.privateReason ?? <span className="text-fg-muted">—</span>)) },
    {
      key: 'actions',
      header: '',
      headerLabel: 'Actions',
      minWidth: 56,
      align: 'right',
      cell: (a) => {
        const items: MenuItem[] = [
          { label: 'Approve', onSelect: () => { setReason(''); setPending({ kind: 'approve', absence: a }); }, hidden: !a.canDecide },
          { label: 'Reject…', onSelect: () => { setReason(''); setPending({ kind: 'reject', absence: a }); }, hidden: !a.canDecide },
          { label: 'Edit', onSelect: () => setEdit(a), hidden: !a.canEdit },
          { label: 'Cancel Absence…', destructive: true, separatorBefore: true, onSelect: () => { setReason(''); setPending({ kind: 'cancel', absence: a }); }, hidden: !a.canEdit },
        ];
        return items.some((i) => !i.hidden) ? <Menu label="Absence actions" trigger={<IconButton label={`Actions for ${a.member.displayName}’s absence`} icon={<DotsThree size={16} weight="bold" />} />} items={items} /> : null;
      },
    },
  ];
  const p = pending;
  return (
    <Panel title={title} description="Approved absences reduce available capacity. Nothing scheduled is moved or cancelled automatically.">
      <QueryState query={q}>
        {q.data && q.data.length === 0 ? (
          <p className="text-[13px] text-fg-2">No requested or approved absences in this period.</p>
        ) : (
          <DataTable caption="Absences" rows={q.data ?? []} columns={columns} getRowId={(a) => a.id} density={user.density} />
        )}
      </QueryState>
      <AbsenceDialog open={!!edit} onOpenChange={(o) => !o && setEdit(null)} absence={edit ?? undefined} />
      <ConfirmDialog
        open={!!p}
        onOpenChange={(o) => !o && setPending(null)}
        title={p?.kind === 'approve' ? 'Approve absence?' : p?.kind === 'reject' ? 'Reject absence?' : 'Cancel absence?'}
        body={p ? `${p.absence.member.displayName}, ${formatDate(p.absence.startDate)} – ${formatDate(p.absence.endDate)}.` : ''}
        confirmLabel={p?.kind === 'approve' ? 'Approve' : p?.kind === 'reject' ? 'Reject' : 'Cancel Absence'}
        destructive={p?.kind !== 'approve'}
        loading={decide.isPending || cancel.isPending}
        confirmDisabled={p?.kind === 'reject' && reason.trim().length < 3}
        onConfirm={async () => {
          if (!p) return;
          if (p.kind === 'cancel') await cancel.run({ params: { workspaceId: workspace.id, absenceId: p.absence.id }, body: { reason: reason.trim() || undefined } }, { ifMatch: p.absence.rowVersion });
          else await decide.run({ params: { workspaceId: workspace.id, absenceId: p.absence.id }, body: { decision: p.kind, reason: reason.trim() || undefined } }, { ifMatch: p.absence.rowVersion });
          setPending(null);
        }}
      >
        <Field label="Reason" required={p?.kind === 'reject'}>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={LIMITS.reasonMax} className="min-h-[72px]" />
        </Field>
      </ConfirmDialog>
    </Panel>
  );
};
