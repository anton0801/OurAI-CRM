'use client';
import { useState } from 'react';
import { timeEndpoints, type TimeSheetView } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { LIMITS } from '@castlane/domain';
import { Banner, Button, ConfirmDialog, DataTable, Drawer, EmptyState, Field, MultiSelect, Panel, StatusBadge, Textarea, Toolbar, formatDate, formatDateTime, type Column } from '@castlane/ui';
import { MemberSelect } from '@/components/common/pickers';
import { QueryState } from '@/components/common/query-state';
import { useApiInfinite, useApiMutation, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';
import { useWorkspace } from '@/lib/workspace-context';
import { Person, formatSeconds } from '../tasks/format';
import { TIME_INVALIDATE } from './entry-form';
import { EntryTable } from './entry-table';

const SheetDrawer = ({ sheetId, onClose }: { sheetId: string | null; onClose: () => void }) => {
  const { workspace, user } = useWorkspace();
  const [returning, setReturning] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const q = useApiQuery(timeEndpoints.sheet, { params: { workspaceId: workspace.id, sheetId: sheetId ?? '' } }, { enabled: !!sheetId });
  const approve = useApiMutation(timeEndpoints.approveSheet, { invalidate: TIME_INVALIDATE, successMessage: 'Time sheet approved', silentErrors: true });
  const ret = useApiMutation(timeEndpoints.returnSheet, { invalidate: TIME_INVALIDATE, successMessage: 'Time sheet returned', silentErrors: true });
  const s = q.data;
  const decidable = !!s && s.state === 'submitted' && s.canDecide;
  const blocked = !!s && (s.overlapCount > 0 || s.changedSinceSubmission.length > 0);
  const fail = (e: unknown) => {
    setError(isApiError(e) ? e.message : 'The time sheet was not changed.');
    void q.refetch();
  };
  return (
    <Drawer
      open={!!sheetId}
      onOpenChange={(o) => {
        if (!o) {
          setError(null);
          onClose();
        }
      }}
      width={760}
      title={s ? `${s.member.displayName} · week of ${formatDate(s.weekStart)}` : 'Time sheet'}
      description={s ? `${label('sheetState', s.state)} · ${formatSeconds(s.totalSeconds)} in ${s.entryCount} entries` : undefined}
      footer={
        decidable ? (
          <>
            <Button onClick={() => { setReason(''); setReturning(true); }}>Return…</Button>
            <Button
              variant="primary"
              disabled={blocked}
              loading={approve.isPending}
              onClick={async () => {
                setError(null);
                try {
                  await approve.run({ params: { workspaceId: workspace.id, sheetId: s!.id }, body: {} }, { ifMatch: s!.rowVersion });
                  onClose();
                } catch (e) {
                  fail(e);
                }
              }}
            >
              Approve Week
            </Button>
          </>
        ) : undefined
      }
    >
      <QueryState query={q}>
        {s ? (
          <div className="flex flex-col gap-4">
            {error ? <Banner tone="danger">{error}</Banner> : null}
            {s.overlapCount > 0 ? <Banner tone="warning">{s.overlapCount} entr{s.overlapCount === 1 ? 'y overlaps' : 'ies overlap'} other time. Return the week so the member can fix it; overlapping time cannot be approved.</Banner> : null}
            {s.changedSinceSubmission.length ? <Banner tone="warning">{s.changedSinceSubmission.length} entr{s.changedSinceSubmission.length === 1 ? 'y has' : 'ies have'} changed since submission. Return the week for a fresh submission.</Banner> : null}
            {!s.canDecide && s.state === 'submitted' ? <Banner tone="info">You can see this sheet but cannot decide on it: you need time approval rights for every project in it.</Banner> : null}
            <p className="text-[13px] text-fg-2">
              Submitted {formatDateTime(s.submittedAt, user.timezone)}
              {s.approver ? ` · designated approver ${s.approver.displayName}` : ''}
              {s.decidedBy ? ` · decided by ${s.decidedBy.displayName} ${formatDateTime(s.decidedAt, user.timezone)}` : ''}
              {s.reason ? ` · ${s.reason}` : ''}
            </p>
            <EntryTable entries={s.entries} caption="Entries in this time sheet" />
          </div>
        ) : null}
      </QueryState>
      <ConfirmDialog
        open={returning}
        onOpenChange={setReturning}
        title="Return this week?"
        body="The entries become editable again for the member. The history is kept."
        confirmLabel="Return Week"
        loading={ret.isPending}
        confirmDisabled={reason.trim().length < 3}
        onConfirm={async () => {
          setError(null);
          try {
            await ret.run({ params: { workspaceId: workspace.id, sheetId: s!.id }, body: { reason: reason.trim() } }, { ifMatch: s!.rowVersion });
            setReturning(false);
            onClose();
          } catch (e) {
            setReturning(false);
            fail(e);
          }
        }}
      >
        <Field label="Reason" required>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={LIMITS.reasonMax} className="min-h-[72px]" />
        </Field>
      </ConfirmDialog>
    </Drawer>
  );
};

/** Approvals (S30): submitted weeks to approve or return, and running timers you may close. */
export const ApprovalsView = () => {
  const { workspace, user, membershipId } = useWorkspace();
  const { state, set, list } = useUrlState<'sheetState' | 'sheetMember' | 'sheet'>({ sheetState: 'submitted' });
  const states = list('sheetState') as TimeSheetView['state'][];
  const sheets = useApiInfinite(timeEndpoints.sheets, { params: { workspaceId: workspace.id }, query: { state: states, membershipId: state.sheetMember || undefined } });
  const running = useApiInfinite(timeEndpoints.list, { params: { workspaceId: workspace.id }, query: { state: ['running'] } });
  const others = running.items.filter((e) => e.member.membershipId !== membershipId && e.permissions.close);
  const columns: Column<TimeSheetView>[] = [
    { key: 'member', header: 'Member', sticky: true, minWidth: 190, cell: (s) => <Person member={s.member} /> },
    { key: 'week', header: 'Week', minWidth: 130, cell: (s) => formatDate(s.weekStart) },
    { key: 'total', header: 'Total', minWidth: 90, align: 'right', cell: (s) => <span className="font-mono tabular-nums">{formatSeconds(s.totalSeconds)}</span> },
    { key: 'entries', header: 'Entries', minWidth: 80, align: 'right', cell: (s) => s.entryCount },
    { key: 'overlaps', header: 'Overlaps', minWidth: 90, align: 'right', cell: (s) => (s.overlapCount ? <span className="text-warning">{s.overlapCount}</span> : '0') },
    { key: 'state', header: 'State', minWidth: 120, cell: (s) => <StatusBadge status={s.state} label={label('sheetState', s.state)} /> },
    { key: 'submitted', header: 'Submitted', minWidth: 150, cell: (s) => formatDateTime(s.submittedAt, user.timezone) },
    { key: 'approver', header: 'Approver', minWidth: 160, cell: (s) => <Person member={s.approver} empty="Any approver in scope" /> },
  ];
  return (
    <div className="flex flex-col gap-4">
      {others.length ? (
        <Panel title="Running timers" description="Close a forgotten timer with the actual end; the entry then needs review.">
          <EntryTable entries={others} caption="Running timers of other members" showMember />
        </Panel>
      ) : null}
      <Toolbar>
        <div className="w-[190px]">
          <MultiSelect aria-label="Sheet state" placeholder="State" value={states} onChange={(v) => set({ sheetState: v.join(',') || null })} options={(['submitted', 'approved', 'returned'] as const).map((s) => ({ value: s, label: label('sheetState', s) }))} />
        </div>
        <div className="w-[190px]">
          <MemberSelect value={state.sheetMember} onChange={(v) => set({ sheetMember: v })} clearable placeholder="Member" />
        </div>
      </Toolbar>
      <QueryState query={sheets}>
        {sheets.items.length === 0 && !sheets.isFetching ? (
          <EmptyState title="No time sheets to show" description="Submitted weeks of members you may approve appear here." />
        ) : (
          <DataTable
            caption="Time sheets"
            rows={sheets.items}
            columns={columns}
            getRowId={(s) => s.id}
            density={user.density}
            onRowClick={(s) => set({ sheet: s.id })}
            hasMore={sheets.hasNextPage}
            loadingMore={sheets.isFetchingNextPage}
            onLoadMore={() => void sheets.fetchNextPage()}
          />
        )}
      </QueryState>
      <SheetDrawer sheetId={state.sheet ?? null} onClose={() => set({ sheet: null })} />
    </div>
  );
};
