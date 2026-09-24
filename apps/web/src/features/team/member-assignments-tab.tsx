'use client';
import Link from 'next/link';
import { Briefcase } from '@phosphor-icons/react';
import { useState } from 'react';
import { projectEndpoints, teamEndpoints, type MemberDetail } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { RESPONSIBILITIES } from '@castlane/domain';
import { Badge, Banner, Button, DataTable, Dialog, EmptyState, Field, Panel, Select, StatusBadge, formatDate } from '@castlane/ui';
import { EntitySelect } from '@/components/common/entity-select';
import { QueryState } from '@/components/common/query-state';
import { useApiMutation, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useWorkspace, useWsPath } from '@/lib/workspace-context';
import { dutyLabel } from './labels';

/** Projects and accounts the member works on (read-only links; only records the viewer may read). */
export const MemberAssignmentsTab = ({ m, onAssign }: { m: MemberDetail; onAssign: () => void }) => {
  const { workspace, user } = useWorkspace();
  const wsPath = useWsPath();
  const q = useApiQuery(teamEndpoints.assignments, { params: { workspaceId: workspace.id, membershipId: m.membershipId } });
  return (
    <QueryState query={q}>
      {q.data ? (
        <div className="flex flex-col gap-5">
          <Panel
            title="Projects"
            description="Project assignments limit what roles cover; they never grant finance, OFM contact or restricted-media access by themselves."
            actions={
              m.permissions.assignProject ? (
                <Button size="sm" onClick={onAssign}>
                  Assign Project
                </Button>
              ) : undefined
            }
            bodyClassName="p-4"
          >
            {q.data.projects.length ? (
              <DataTable
                caption="Project assignments"
                density="compact"
                rows={q.data.projects}
                getRowId={(r) => r.id}
                columns={[
                  {
                    key: 'project',
                    header: 'Project',
                    sticky: true,
                    minWidth: 200,
                    cell: (r) => (
                      <span className="flex items-center gap-2">
                        <Link href={wsPath(`/projects/${r.project.id}`)} className="font-medium hover:underline">
                          {r.project.name}
                        </Link>
                        {r.isOwner ? <Badge tone="primary">Owner</Badge> : null}
                      </span>
                    ),
                  },
                  { key: 'type', header: 'Type', minWidth: 100, cell: (r) => label('projectType', r.project.type) },
                  { key: 'status', header: 'Status', minWidth: 110, cell: (r) => <StatusBadge status={r.project.status} /> },
                  { key: 'duty', header: 'Responsibility', minWidth: 150, cell: (r) => (r.responsibility ? dutyLabel(r.responsibility) : '—') },
                  { key: 'from', header: 'Since', minWidth: 110, cell: (r) => formatDate(r.validFrom, user.timezone) },
                  { key: 'to', header: 'Until', minWidth: 110, cell: (r) => (r.validTo ? formatDate(r.validTo, user.timezone) : <span className="text-fg-2">Current</span>) },
                ]}
              />
            ) : (
              <EmptyState icon={<Briefcase size={24} />} title="No project assignments you can see" className="py-8" />
            )}
          </Panel>
          <Panel title="Accounts" bodyClassName="p-4">
            {q.data.accounts.length ? (
              <DataTable
                caption="Account assignments"
                density="compact"
                rows={q.data.accounts}
                getRowId={(r) => r.id}
                columns={[
                  {
                    key: 'account',
                    header: 'Account',
                    sticky: true,
                    minWidth: 200,
                    cell: (r) => (
                      <Link href={wsPath(`/accounts/${r.account.id}`)} className="font-medium hover:underline">
                        {r.account.label}
                      </Link>
                    ),
                  },
                  { key: 'platform', header: 'Platform', minWidth: 110, cell: (r) => label('platform', r.account.platform) },
                  { key: 'duty', header: 'Duty', minWidth: 150, cell: (r) => dutyLabel(r.duty) },
                  { key: 'from', header: 'Since', minWidth: 110, cell: (r) => formatDate(r.validFrom, user.timezone) },
                  { key: 'to', header: 'Until', minWidth: 110, cell: (r) => (r.validTo ? formatDate(r.validTo, user.timezone) : <span className="text-fg-2">Current</span>) },
                ]}
              />
            ) : (
              <p className="text-[13px] text-fg-2">No account assignments you can see.</p>
            )}
          </Panel>
        </div>
      ) : null}
    </QueryState>
  );
};

/** Assign the member to a project team (Projects module command). */
export const AssignProjectDialog = ({ m, open, onOpenChange }: { m: MemberDetail; open: boolean; onOpenChange: (o: boolean) => void }) => {
  const { workspace } = useWorkspace();
  const [projectId, setProjectId] = useState<string | null>(null);
  const [duty, setDuty] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const add = useApiMutation(projectEndpoints.addMember, { invalidate: ['team.', 'projects.'], successMessage: 'Member added to the project', silentErrors: true });
  const close = () => {
    setProjectId(null);
    setDuty(null);
    setError(null);
    onOpenChange(false);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => (o ? onOpenChange(o) : close())}
      size="small"
      dirty={!!projectId}
      title={`Assign ${m.displayName} to a project`}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!projectId}
            loading={add.isPending}
            onClick={async () => {
              try {
                await add.run({ params: { workspaceId: workspace.id, projectId: projectId! }, body: { membershipId: m.membershipId, responsibility: (duty as never) ?? null } });
                close();
              } catch (e) {
                setError(isApiError(e) ? e.message : 'The assignment could not be saved.');
              }
            }}
          >
            Assign Project
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <Field label="Project" required helper="Only projects where you manage the team can be saved.">
          <EntitySelect type="project" value={projectId} onChange={setProjectId} />
        </Field>
        <Field label="Responsibility">
          <Select value={duty} onChange={setDuty} clearable options={RESPONSIBILITIES.map((r) => ({ value: r, label: dutyLabel(r) }))} />
        </Field>
      </div>
    </Dialog>
  );
};
