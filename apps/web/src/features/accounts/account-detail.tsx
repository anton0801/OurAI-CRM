'use client';
import { ArrowSquareOut, DotsThree, PencilSimple, UserPlus } from '@phosphor-icons/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { accountEndpoints, type AccountAssignment, type AccountDetail } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { isSafeUrl } from '@castlane/domain';
import {
  Avatar,
  Badge,
  Banner,
  Button,
  ConfirmDialog,
  DataTable,
  DescriptionList,
  Dialog,
  EmptyState,
  Field,
  IconButton,
  Menu,
  PageHeader,
  Panel,
  StatusBadge,
  TabPanel,
  Tabs,
  Textarea,
  formatDate,
  formatDateTime,
  toast,
  type MenuItem,
} from '@castlane/ui';
import { MemberSelect } from '@/components/common/pickers';
import { QueryState } from '@/components/common/query-state';
import { useApiInfinite, useApiMutation, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { ACCOUNT_TABS } from '@/lib/slots';
import { useUrlState } from '@/lib/url-state';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';
import '@/features/slots';
import { AssignMemberDialog, TransferDialog, TransitionDialog } from './account-dialogs';
import { ARCHIVE_EXPLANATION, NO_INTEGRATION_NOTE } from './labels';
import { ExternalLink, PlatformLabel, accountTitle } from './platform';

const ACTION_LABEL: Record<string, string> = { active: 'Activate', paused: 'Pause', restricted: 'Mark Restricted', archived: 'Archive' };

/** S20 Account Detail: lifecycle, identity history, team and activity plus other modules' tabs. */
export const AccountDetailScreen = ({ accountId }: { accountId: string }) => {
  const { workspace } = useWorkspace();
  const wsPath = useWsPath();
  const router = useRouter();
  const can = useCan();
  const { state, set } = useUrlState<'tab'>({ tab: 'overview' });
  const q = useApiQuery(accountEndpoints.get, { params: { workspaceId: workspace.id, accountId } });
  const [target, setTarget] = useState<AccountDetail['status'] | null>(null);
  const [transferOpen, setTransferOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const restore = useApiMutation(accountEndpoints.restore, { invalidate: ['accounts.'], successMessage: 'Account restored' });

  return (
    <QueryState query={q}>
      {q.data
        ? (() => {
            const a = q.data;
            const archived = a.status === 'archived';
            const slotProps = { accountId: a.id, projectId: a.project.id };
            const extraTabs = ACCOUNT_TABS.items.filter((t) => !t.visible || t.visible(slotProps, can));
            const tabs = [
              { key: 'overview', label: 'Overview' },
              ...extraTabs.filter((t) => t.order < 50).map((t) => ({ key: t.key, label: t.label })),
              { key: 'team', label: 'Team' },
              { key: 'history', label: 'Identity & Status' },
              ...extraTabs.filter((t) => t.order >= 50).map((t) => ({ key: t.key, label: t.label })),
              { key: 'activity', label: 'Activity' },
            ];
            const active = tabs.find((t) => t.key === state.tab)?.key ?? 'overview';
            const menu: MenuItem[] = [
              ...a.allowedTransitions.map((t) => ({
                label: a.status === 'restricted' && t === 'active' ? 'Resolve Restriction' : a.status === 'paused' && t === 'active' ? 'Resume' : ACTION_LABEL[t] ?? t,
                destructive: t === 'archived',
                separatorBefore: t === 'archived',
                onSelect: () => setTarget(t),
              })),
              { label: 'Restore from Archive', onSelect: () => setRestoreOpen(true), hidden: !archived || !a.permissions.archive },
              { label: 'Transfer to Project', onSelect: () => setTransferOpen(true), hidden: !a.permissions.transfer, separatorBefore: true },
              { label: 'Assign Team', onSelect: () => setAssignOpen(true), hidden: !a.permissions.assign },
              { label: 'New Publication', href: wsPath(`/publications/new?accountId=${a.id}`), hidden: !a.permissions.createPublication, separatorBefore: true },
              { label: 'Add Metrics', href: wsPath(`/metrics/new?accountId=${a.id}`), hidden: !a.permissions.addMetrics },
            ];
            return (
              <div className="flex flex-col gap-5">
                <PageHeader
                  crumbs={[{ label: 'Accounts', href: wsPath('/accounts') }, { label: accountTitle(a) }]}
                  title={
                    <span className="flex items-center gap-3">
                      <Avatar name={accountTitle(a).replace('@', '')} src={a.avatarUrl ? a.avatarUrl.replace('size=64', 'size=128') : null} size={64} decorative />
                      <span className="min-w-0 break-words">{accountTitle(a)}</span>
                    </span>
                  }
                  meta={
                    <>
                      <StatusBadge status={a.status} label={label('accountStatus', a.status)} />
                      <PlatformLabel platform={a.platform} />
                      <Link href={wsPath(`/projects/${a.project.id}`)} className="text-[13px] text-fg-2 hover:underline">
                        {a.project.name}
                      </Link>
                      <span className="flex items-center gap-1.5 text-[13px] text-fg-2">
                        <Avatar name={a.owner.displayName} src={a.owner.avatarUrl} size={24} decorative /> {a.owner.displayName}
                      </span>
                      {a.tags.map((t) => (
                        <Badge key={t}>{t}</Badge>
                      ))}
                    </>
                  }
                  actions={
                    <>
                      {isSafeUrl(a.canonicalUrl) ? (
                        <a
                          href={a.canonicalUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex h-11 items-center gap-2 rounded-[8px] border border-line bg-surface px-[14px] text-[13px] font-semibold text-fg hover:bg-surface-2 md:h-9"
                        >
                          <ArrowSquareOut size={14} aria-hidden /> Open Account<span className="sr-only"> (opens in a new tab)</span>
                        </a>
                      ) : null}
                      {a.permissions.update ? (
                        <Button icon={<PencilSimple size={14} />} onClick={() => router.push(wsPath(`/accounts/${a.id}/edit`))}>
                          Edit
                        </Button>
                      ) : null}
                      {menu.some((m) => !m.hidden) ? <Menu label="More actions" trigger={<IconButton label="More actions" icon={<DotsThree size={18} weight="bold" />} variant="secondary" />} items={menu} /> : null}
                    </>
                  }
                />
                {archived ? <Banner tone="info">{ARCHIVE_EXPLANATION}</Banner> : null}
                {a.status === 'restricted' ? (
                  <Banner tone="warning">
                    Restricted{a.statusReason ? `: ${a.statusReason}` : ''}. New publications cannot be planned until a lead resolves the restriction.
                  </Banner>
                ) : null}
                {a.status === 'paused' ? <Banner tone="warning">Paused{a.statusReason ? `: ${a.statusReason}` : ''}. Planning on this account shows a warning.</Banner> : null}
                <Tabs label="Account sections" value={active} onValueChange={(v) => set({ tab: v })} items={tabs.map((t) => ({ value: t.key, label: t.label }))}>
                  <TabPanel value="overview">{active === 'overview' ? <OverviewTab account={a} /> : null}</TabPanel>
                  <TabPanel value="team">{active === 'team' ? <TeamTab account={a} onAssign={() => setAssignOpen(true)} /> : null}</TabPanel>
                  <TabPanel value="history">{active === 'history' ? <HistoryTab accountId={a.id} /> : null}</TabPanel>
                  <TabPanel value="activity">{active === 'activity' ? <ActivityTab accountId={a.id} /> : null}</TabPanel>
                  {extraTabs.map((t) => (
                    <TabPanel key={t.key} value={t.key}>
                      {active === t.key ? <t.component {...slotProps} /> : null}
                    </TabPanel>
                  ))}
                </Tabs>
                <TransitionDialog account={a} target={target} onClose={() => setTarget(null)} />
                <TransferDialog account={a} open={transferOpen} onOpenChange={setTransferOpen} />
                <AssignMemberDialog open={assignOpen} onOpenChange={setAssignOpen} accountId={a.id} />
                <ConfirmDialog
                  open={restoreOpen}
                  onOpenChange={setRestoreOpen}
                  title="Restore account?"
                  body="The account returns to the status it had before archiving. Restoring fails if another active account now uses the same profile link."
                  confirmLabel="Restore"
                  loading={restore.isPending}
                  onConfirm={async () => {
                    try {
                      await restore.run({ params: { workspaceId: workspace.id, accountId: a.id }, body: {} }, { ifMatch: a.rowVersion });
                      setRestoreOpen(false);
                    } catch {
                      /* error toast shown by the mutation */
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

const OverviewTab = ({ account: a }: { account: AccountDetail }) => {
  const { user } = useWorkspace();
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <Panel title="Account" className="lg:col-span-2">
        <DescriptionList
          items={[
            { label: 'Profile link', value: <ExternalLink href={a.canonicalUrl} /> },
            { label: 'Original link', value: a.originalUrl !== a.canonicalUrl ? <span className="break-all text-fg-2">{a.originalUrl}</span> : null, hidden: a.originalUrl === a.canonicalUrl },
            { label: 'Display name', value: a.displayName },
            { label: 'Language', value: a.language },
            { label: 'Markets', value: a.markets.join(', ') || null },
            { label: 'Metrics cadence', value: `${label('metricsCadence', a.metricsCadence)} at ${a.metricsTime}` },
            { label: 'Caption limit', value: a.captionMaxLength },
            { label: 'Purpose', value: a.purpose },
          ]}
        />
        {a.notes ? <p className="mt-4 whitespace-pre-wrap text-[14px] leading-[22px] text-fg-2">{a.notes}</p> : null}
        <p className="mt-4 text-[12px] text-fg-2">{NO_INTEGRATION_NOTE}</p>
      </Panel>
      <Panel title="Recorded results">
        <DescriptionList
          columns={1}
          items={[
            { label: 'Last metrics recorded', value: a.lastMetricsAt ? formatDateTime(a.lastMetricsAt, user.timezone) : <span className="text-fg-muted">No data recorded for this period.</span> },
            { label: 'Next publication', value: a.nextPublicationAt ? formatDateTime(a.nextPublicationAt, user.timezone) : <span className="text-fg-muted">None planned</span> },
            { label: 'Missing checkpoints', value: a.missingCheckpoints },
          ]}
        />
      </Panel>
      <Panel title="Team" className="lg:col-span-3">
        {a.assignments.length === 0 ? (
          <p className="text-[14px] text-fg-2">Only the owner is responsible for this account. Assign team members on the Team tab.</p>
        ) : (
          <ul className="flex flex-wrap gap-3">
            {a.assignments.map((m) => (
              <li key={m.id} className="flex items-center gap-2 rounded-[8px] border border-line px-3 py-2 text-[13px]">
                <Avatar name={m.member.displayName} src={m.member.avatarUrl} size={24} decorative />
                <span>{m.member.displayName}</span>
                <span className="text-fg-2">· {label('responsibility', m.duty)}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
};

const TeamTab = ({ account, onAssign }: { account: AccountDetail; onAssign: () => void }) => {
  const { workspace } = useWorkspace();
  const all = useApiQuery(accountEndpoints.assignments, { params: { workspaceId: workspace.id, accountId: account.id }, query: { includeEnded: true } });
  const [ending, setEnding] = useState<AccountAssignment | null>(null);
  const [reason, setReason] = useState('');
  const [editing, setEditing] = useState<AccountAssignment | null>(null);
  const [supervisor, setSupervisor] = useState<string | null>(null);
  const end = useApiMutation(accountEndpoints.endAssignment, { invalidate: ['accounts.'], successMessage: 'Assignment ended' });
  const update = useApiMutation(accountEndpoints.updateAssignment, { invalidate: ['accounts.'], successMessage: 'Supervisor updated', silentErrors: true });
  const rows = all.data ?? [];
  const current = rows.filter((r) => !r.validTo);
  const history = rows.filter((r) => r.validTo);
  const columns = (historical: boolean) => [
    {
      key: 'member',
      header: 'Member',
      sticky: true,
      minWidth: 200,
      cell: (r: AccountAssignment) => (
        <span className="flex items-center gap-2">
          <Avatar name={r.member.displayName} src={r.member.avatarUrl} size={24} decorative />
          {r.member.displayName}
          {r.member.former ? <Badge>Former member</Badge> : null}
        </span>
      ),
    },
    { key: 'duty', header: 'Duty', minWidth: 150, cell: (r: AccountAssignment) => label('responsibility', r.duty) },
    { key: 'supervisor', header: 'Supervisor', minWidth: 150, cell: (r: AccountAssignment) => r.supervisor?.displayName ?? '—' },
    { key: 'from', header: 'Since', minWidth: 120, cell: (r: AccountAssignment) => formatDate(r.validFrom) },
    ...(historical
      ? [
          { key: 'to', header: 'Until', minWidth: 120, cell: (r: AccountAssignment) => formatDate(r.validTo) },
          { key: 'why', header: 'Reason', minWidth: 160, cell: (r: AccountAssignment) => r.endedReason ?? '—' },
        ]
      : account.permissions.assign
        ? [
            {
              key: 'actions',
              header: <span className="sr-only">Actions</span>,
              minWidth: 220,
              align: 'right' as const,
              cell: (r: AccountAssignment) => (
                <span className="flex justify-end gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setSupervisor(r.supervisor?.membershipId ?? null);
                      setEditing(r);
                    }}
                  >
                    Change Supervisor
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEnding(r)}>
                    End
                  </Button>
                </span>
              ),
            },
          ]
        : []),
  ];
  return (
    <QueryState query={all}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[13px] text-fg-2">Account assignments limit what roles cover; they never grant finance, OFM contact or restricted-media access by themselves.</p>
          {account.permissions.assign ? (
            <Button icon={<UserPlus size={14} />} onClick={onAssign}>
              Assign Team
            </Button>
          ) : null}
        </div>
        <DataTable
          caption="Current assignments"
          rows={current}
          columns={columns(false)}
          getRowId={(r) => r.id}
          empty={<EmptyState title="No one is assigned" description="Only the owner is responsible for this account." action={account.permissions.assign ? <Button onClick={onAssign}>Assign Team</Button> : undefined} />}
        />
        {history.length ? (
          <>
            <h3 className="mt-2 text-[14px] font-semibold text-fg">Assignment history</h3>
            <DataTable caption="Assignment history" rows={history} columns={columns(true)} getRowId={(r) => r.id} density="compact" />
          </>
        ) : null}
      </div>
      <ConfirmDialog
        open={!!ending}
        onOpenChange={(o) => {
          if (!o) {
            setEnding(null);
            setReason('');
          }
        }}
        title="End assignment?"
        body={`${ending?.member.displayName ?? ''} loses access that depends on this assignment immediately. Their past work keeps its author.`}
        confirmLabel="End Assignment"
        destructive
        loading={end.isPending}
        onConfirm={async () => {
          if (!ending) return;
          try {
            await end.run({ params: { workspaceId: workspace.id, accountId: account.id, assignmentId: ending.id }, body: { reason: reason.trim() || undefined } });
            setEnding(null);
            setReason('');
          } catch {
            /* toast shown */
          }
        }}
      >
        <Field label="Reason">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} />
        </Field>
      </ConfirmDialog>
      <Dialog
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        title="Change supervisor"
        size="small"
        footer={
          <>
            <Button onClick={() => setEditing(null)}>Cancel</Button>
            <Button
              variant="primary"
              loading={update.isPending}
              onClick={async () => {
                if (!editing) return;
                try {
                  await update.run({ params: { workspaceId: workspace.id, accountId: account.id, assignmentId: editing.id }, body: { supervisorMembershipId: supervisor } }, { ifMatch: editing.rowVersion });
                  setEditing(null);
                } catch (e) {
                  toast.error(isApiError(e) && e.code === 'VERSION_CONFLICT' ? 'This record changed while you were editing it. Compare changes before saving.' : isApiError(e) ? e.message : 'Could not save.');
                }
              }}
            >
              Save
            </Button>
          </>
        }
      >
        <Field label="Supervisor">
          <MemberSelect value={supervisor} onChange={setSupervisor} clearable />
        </Field>
      </Dialog>
    </QueryState>
  );
};

const HistoryTab = ({ accountId }: { accountId: string }) => {
  const { workspace, user } = useWorkspace();
  const q = useApiQuery(accountEndpoints.history, { params: { workspaceId: workspace.id, accountId } });
  return (
    <QueryState query={q}>
      {q.data ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Panel title="Handle and link history" description="Renames keep the previous identity; publications stay attached to this account.">
            {q.data.identity.length === 0 ? (
              <p className="text-[14px] text-fg-2">The handle and link have not changed since the account was added.</p>
            ) : (
              <ol className="flex flex-col divide-y divide-line">
                {q.data.identity.map((h) => (
                  <li key={h.id} className="flex flex-col gap-0.5 py-2 text-[13px]">
                    <span className="text-fg-2">{formatDateTime(h.effectiveAt, user.timezone)}{h.actorName ? ` · ${h.actorName}` : ''}</span>
                    {h.oldHandle !== h.newHandle ? (
                      <span>
                        Handle: {h.oldHandle ? `@${h.oldHandle}` : '—'} → {h.newHandle ? `@${h.newHandle}` : '—'}
                      </span>
                    ) : null}
                    {h.oldUrl ? (
                      <span className="break-all">
                        Link: {h.oldUrl} → {h.newUrl}
                      </span>
                    ) : null}
                    {h.reason ? <span className="text-fg-2">Reason: {h.reason}</span> : null}
                  </li>
                ))}
              </ol>
            )}
          </Panel>
          <Panel title="Status history">
            <ol className="flex flex-col divide-y divide-line">
              {q.data.status.map((s) => (
                <li key={s.id} className="flex flex-col gap-0.5 py-2 text-[13px]">
                  <span className="flex items-center gap-2">
                    {s.fromStatus ? <StatusBadge status={s.fromStatus} label={label('accountStatus', s.fromStatus)} /> : <span className="text-fg-2">Created as</span>}
                    {s.fromStatus ? <span aria-hidden>→</span> : null}
                    <StatusBadge status={s.toStatus} label={label('accountStatus', s.toStatus)} />
                  </span>
                  <span className="text-fg-2">{formatDateTime(s.occurredAt, user.timezone)}{s.actorName ? ` · ${s.actorName}` : ''}</span>
                  {s.reason ? <span>{s.reason}</span> : null}
                </li>
              ))}
            </ol>
          </Panel>
          {q.data.transfers.length ? (
            <Panel title="Project transfers" className="lg:col-span-2">
              <ol className="flex flex-col divide-y divide-line">
                {q.data.transfers.map((t) => (
                  <li key={t.id} className="flex flex-col gap-0.5 py-2 text-[13px]">
                    <span>
                      {t.fromProject?.name ?? 'Another project'} → {t.toProject?.name ?? 'Another project'}
                    </span>
                    <span className="text-fg-2">{formatDateTime(t.transferredAt, user.timezone)}{t.actorName ? ` · ${t.actorName}` : ''}</span>
                    <span>{t.reason}</span>
                  </li>
                ))}
              </ol>
            </Panel>
          ) : null}
        </div>
      ) : null}
    </QueryState>
  );
};

export const humanAction = (action: string) =>
  action
    .replace(/^[a-z_]+\./, '')
    .split('_')
    .join(' ')
    .replace(/^./, (c) => c.toUpperCase());

const ActivityTab = ({ accountId }: { accountId: string }) => {
  const { workspace, user } = useWorkspace();
  const q = useApiInfinite(accountEndpoints.activity, { params: { workspaceId: workspace.id, accountId }, query: {} });
  return (
    <QueryState query={q}>
      {q.items.length === 0 ? (
        <EmptyState title="No activity yet" description="Changes to this account appear here." />
      ) : (
        <div className="flex flex-col gap-3">
          <ol className="flex flex-col divide-y divide-line rounded-[12px] border border-line bg-surface">
            {q.items.map((e) => (
              <li key={e.id} className="flex flex-col gap-0.5 px-4 py-3 text-[13px]">
                <span className="text-fg">
                  {humanAction(e.action)}
                  {e.actorName ? <span className="text-fg-2"> · {e.actorName}</span> : null}
                </span>
                <span className="text-fg-2">{formatDateTime(e.occurredAt, user.timezone)}</span>
                {e.changes.length ? (
                  <span className="text-fg-2">
                    {e.changes.map((c) => `${c.field}: ${String(c.from ?? '—')} → ${String(c.to ?? '—')}`).join(' · ')}
                  </span>
                ) : null}
                {e.reason ? <span>{e.reason}</span> : null}
              </li>
            ))}
          </ol>
          {q.hasNextPage ? (
            <div className="flex justify-center">
              <Button onClick={() => void q.fetchNextPage()} loading={q.isFetchingNextPage}>
                Load More
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </QueryState>
  );
};
