'use client';
import { DotsThree, PencilSimple } from '@phosphor-icons/react';
import { useState } from 'react';
import { teamEndpoints, type MemberDetail } from '@castlane/api-contracts';
import { Avatar, Badge, Banner, Button, IconButton, Menu, PageHeader, StatusBadge, TabPanel, Tabs, formatDate, type MenuItem } from '@castlane/ui';
import { QueryState } from '@/components/common/query-state';
import { useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { MEMBER_TABS } from '@/lib/slots';
import { useUrlState } from '@/lib/url-state';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';
import '@/features/slots';
import { MemberAccessTab } from './member-access-tab';
import { MemberActivityTab } from './member-activity-tab';
import { AssignProjectDialog, MemberAssignmentsTab } from './member-assignments-tab';
import { EditProfileDrawer, MemberProfileTab } from './member-profile-tab';
import { DeactivateDrawer, ReactivateDialog, RestoreDialog, RevokeSessionsDialog, SuspendDialog, TransferWorkDrawer } from './member-lifecycle';

type Dialogs = 'edit' | 'suspend' | 'reactivate' | 'sessions' | 'deactivate' | 'restore' | 'transfer' | 'assign' | null;

/** S62 Member Workspace: profile & duties, access (Explain Access), assignments, activity + module tabs. */
export const MemberWorkspace = ({ memberId }: { memberId: string }) => {
  const { workspace } = useWorkspace();
  const can = useCan();
  const wsPath = useWsPath();
  const { state, set } = useUrlState<'tab'>({ tab: 'profile' });
  const q = useApiQuery(teamEndpoints.get, { params: { workspaceId: workspace.id, membershipId: memberId } });
  const [dialog, setDialog] = useState<Dialogs>(null);
  return (
    <QueryState query={q}>
      {q.data ? <Loaded m={q.data} tab={state.tab ?? 'profile'} onTab={(t) => set({ tab: t })} dialog={dialog} setDialog={setDialog} can={can} wsPath={wsPath} /> : null}
    </QueryState>
  );
};

const Loaded = ({
  m,
  tab,
  onTab,
  dialog,
  setDialog,
  can,
  wsPath,
}: {
  m: MemberDetail;
  tab: string;
  onTab: (t: string) => void;
  dialog: Dialogs;
  setDialog: (d: Dialogs) => void;
  can: (p: string | string[]) => boolean;
  wsPath: (p: string) => string;
}) => {
  const { user } = useWorkspace();
  const slotProps = { membershipId: m.membershipId };
  const own = [
    { value: 'profile', label: 'Profile' },
    { value: 'access', label: 'Access', hidden: !m.permissions.viewAccess },
    { value: 'assignments', label: 'Assignments' },
    { value: 'activity', label: 'Activity', hidden: !m.permissions.viewActivity },
  ];
  const extra = MEMBER_TABS.items.filter((t) => !t.visible || t.visible(slotProps, can));
  const tabs = [...own.filter((t) => !t.hidden), ...extra.map((t) => ({ value: t.key, label: t.label }))];
  const active = tabs.find((t) => t.value === tab)?.value ?? 'profile';
  const p = m.permissions;
  const menu: MenuItem[] = [
    { label: 'Assign Project', onSelect: () => setDialog('assign'), hidden: !p.assignProject },
    { label: 'Transfer Work', onSelect: () => setDialog('transfer'), hidden: !p.transferWork },
    { label: 'Revoke Sessions', onSelect: () => setDialog('sessions'), hidden: !p.revokeSessions, separatorBefore: true },
    { label: 'Suspend', onSelect: () => setDialog('suspend'), hidden: !p.suspend || m.status !== 'active' },
    { label: 'Reactivate', onSelect: () => setDialog('reactivate'), hidden: !p.suspend || m.status !== 'suspended' },
    { label: 'Deactivate…', destructive: true, onSelect: () => setDialog('deactivate'), hidden: !p.deactivate, separatorBefore: true },
    { label: 'Restore Member', onSelect: () => setDialog('restore'), hidden: !p.restore },
  ];
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        crumbs={[...(can('members.read') ? [{ label: 'Team', href: wsPath('/team') }] : []), { label: m.displayName }]}
        title={
          <span className="flex items-center gap-3">
            <Avatar name={m.displayName} src={m.avatarUrl} size={64} className="hidden sm:inline-flex" decorative />
            <span>{m.displayName}</span>
          </span>
        }
        meta={
          <>
            <StatusBadge status={m.status} label={label('membershipStatus', m.status)} />
            {m.isOwner ? <Badge tone="primary">Workspace Owner</Badge> : null}
            {m.title ? <span className="text-[13px] text-fg-2">{m.title}</span> : null}
            {m.isSelf ? <Badge tone="info">You</Badge> : null}
          </>
        }
        actions={
          <>
            {p.update ? (
              <Button icon={<PencilSimple size={14} />} onClick={() => setDialog('edit')}>
                Edit Profile
              </Button>
            ) : null}
            {menu.some((i) => !i.hidden) ? <Menu label="More member actions" trigger={<IconButton label="More member actions" icon={<DotsThree size={18} weight="bold" />} variant="secondary" />} items={menu} /> : null}
          </>
        }
      />
      {m.status === 'suspended' ? <Banner tone="warning">Suspended since {formatDate(m.suspendedAt, user.timezone)}. Workspace access is blocked; roles are kept for reactivation.</Banner> : null}
      {m.status === 'deactivated' ? (
        <Banner tone="info">
          Deactivated {formatDate(m.deactivatedAt, user.timezone)}
          {m.deactivatedBy ? ` by ${m.deactivatedBy.displayName}` : ''}. Their past work keeps its author. Restoring does not bring back sensitive access automatically.
        </Banner>
      ) : null}
      <Tabs label="Member sections" value={active} onValueChange={onTab} items={tabs}>
        <TabPanel value="profile">{active === 'profile' ? <MemberProfileTab m={m} /> : null}</TabPanel>
        {m.permissions.viewAccess ? <TabPanel value="access">{active === 'access' ? <MemberAccessTab m={m} /> : null}</TabPanel> : null}
        <TabPanel value="assignments">{active === 'assignments' ? <MemberAssignmentsTab m={m} onAssign={() => setDialog('assign')} /> : null}</TabPanel>
        {m.permissions.viewActivity ? <TabPanel value="activity">{active === 'activity' ? <MemberActivityTab m={m} /> : null}</TabPanel> : null}
        {extra.map((t) => (
          <TabPanel key={t.key} value={t.key}>
            {active === t.key ? <t.component {...slotProps} /> : null}
          </TabPanel>
        ))}
      </Tabs>
      <EditProfileDrawer m={m} open={dialog === 'edit'} onOpenChange={(o) => setDialog(o ? 'edit' : null)} />
      <SuspendDialog m={m} open={dialog === 'suspend'} onOpenChange={(o) => setDialog(o ? 'suspend' : null)} />
      <ReactivateDialog m={m} open={dialog === 'reactivate'} onOpenChange={(o) => setDialog(o ? 'reactivate' : null)} />
      <RevokeSessionsDialog m={m} open={dialog === 'sessions'} onOpenChange={(o) => setDialog(o ? 'sessions' : null)} />
      {dialog === 'deactivate' ? <DeactivateDrawer m={m} open onOpenChange={(o) => setDialog(o ? 'deactivate' : null)} /> : null}
      {dialog === 'restore' ? <RestoreDialog m={m} open onOpenChange={(o) => setDialog(o ? 'restore' : null)} /> : null}
      {dialog === 'transfer' ? <TransferWorkDrawer m={m} open onOpenChange={(o) => setDialog(o ? 'transfer' : null)} /> : null}
      <AssignProjectDialog m={m} open={dialog === 'assign'} onOpenChange={(o) => setDialog(o ? 'assign' : null)} />
    </div>
  );
};
