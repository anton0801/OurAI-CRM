'use client';
import { UserPlus } from '@phosphor-icons/react';
import { useState } from 'react';
import { projectEndpoints, type ProjectDetail } from '@castlane/api-contracts';
import { RESPONSIBILITIES } from '@castlane/domain';
import { Avatar, Badge, Button, ConfirmDialog, DataTable, Dialog, Field, Select, formatDate, humanize } from '@castlane/ui';
import { MemberSelect } from '@/components/common/pickers';
import { useApiMutation } from '@/lib/hooks';
import { useWorkspace } from '@/lib/workspace-context';

type Row = ProjectDetail['team'][number];

export const ProjectTeamTab = ({ project }: { project: ProjectDetail }) => {
  const { workspace } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [member, setMember] = useState<string | null>(null);
  const [duty, setDuty] = useState<string | null>(null);
  const [ending, setEnding] = useState<Row | null>(null);
  const add = useApiMutation(projectEndpoints.addMember, { invalidate: ['projects.get'], successMessage: 'Member added to the project' });
  const end = useApiMutation(projectEndpoints.endMember, { invalidate: ['projects.get'], successMessage: 'Assignment ended' });
  const current = project.team.filter((t) => !t.validTo);
  const history = project.team.filter((t) => t.validTo);
  const columns = (historical: boolean) => [
    {
      key: 'member',
      header: 'Member',
      sticky: true,
      minWidth: 200,
      cell: (r: Row) => (
        <span className="flex items-center gap-2">
          <Avatar name={r.member.displayName} src={r.member.avatarUrl} size={24} decorative />
          {r.member.displayName}
          {r.member.membershipId === project.owner.membershipId ? <Badge tone="primary">Owner</Badge> : null}
        </span>
      ),
    },
    { key: 'duty', header: 'Responsibility', minWidth: 160, cell: (r: Row) => (r.responsibility ? humanize(r.responsibility) : '—') },
    { key: 'from', header: 'Since', minWidth: 120, cell: (r: Row) => formatDate(r.validFrom) },
    ...(historical ? [{ key: 'to', header: 'Until', minWidth: 120, cell: (r: Row) => formatDate(r.validTo) }] : []),
    ...(!historical && project.permissions.manageTeam
      ? [
          {
            key: 'actions',
            header: <span className="sr-only">Actions</span>,
            minWidth: 110,
            align: 'right' as const,
            cell: (r: Row) =>
              r.member.membershipId === project.owner.membershipId ? null : (
                <Button size="sm" variant="ghost" onClick={() => setEnding(r)}>
                  End Assignment
                </Button>
              ),
          },
        ]
      : []),
  ];
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-[13px] text-fg-2">Project assignments limit what roles cover; they never grant finance, OFM contact or restricted-media access by themselves.</p>
        {project.permissions.manageTeam ? (
          <Button icon={<UserPlus size={14} />} onClick={() => setOpen(true)}>
            Add Member
          </Button>
        ) : null}
      </div>
      <DataTable caption="Current team" rows={current} columns={columns(false)} getRowId={(r) => r.id} />
      {history.length ? (
        <>
          <h3 className="mt-2 text-[14px] font-semibold text-fg">Team history</h3>
          <DataTable caption="Team history" rows={history} columns={columns(true)} getRowId={(r) => r.id} density="compact" />
        </>
      ) : null}
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Add member to project"
        size="small"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!member}
              loading={add.isPending}
              onClick={async () => {
                await add.run({ params: { workspaceId: workspace.id, projectId: project.id }, body: { membershipId: member!, responsibility: (duty as never) ?? null } });
                setOpen(false);
                setMember(null);
                setDuty(null);
              }}
            >
              Add Member
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="Member" required>
            <MemberSelect value={member} onChange={setMember} />
          </Field>
          <Field label="Responsibility">
            <Select value={duty} onChange={setDuty} clearable options={RESPONSIBILITIES.map((r) => ({ value: r, label: humanize(r) }))} />
          </Field>
        </div>
      </Dialog>
      <ConfirmDialog
        open={!!ending}
        onOpenChange={(o) => !o && setEnding(null)}
        title="End project assignment?"
        body={`${ending?.member.displayName ?? ''} loses access that depends on this assignment immediately. Their past work keeps its author.`}
        confirmLabel="End Assignment"
        destructive
        loading={end.isPending}
        onConfirm={async () => {
          if (!ending) return;
          await end.run({ params: { workspaceId: workspace.id, projectId: project.id, projectMemberId: ending.id }, body: {} });
          setEnding(null);
        }}
      />
    </div>
  );
};
