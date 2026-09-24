'use client';
import Link from 'next/link';
import { ArrowDown, ArrowUp, Compass, DotsThree, Plus } from '@phosphor-icons/react';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { directionAdminEndpoints, directionEndpoints, type DirectionDetail, type DirectionRow, type LeadImpact } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import {
  Avatar,
  Banner,
  Button,
  Checkbox,
  ConfirmDialog,
  DataTable,
  DescriptionList,
  Dialog,
  Drawer,
  EmptyState,
  Field,
  IconButton,
  Input,
  Menu,
  PageHeader,
  Skeleton,
  StatusBadge,
  Switch,
  Textarea,
  Toolbar,
  formatDate,
  type Column,
} from '@castlane/ui';
import { ConflictDialog } from '@/components/common/conflict';
import { MemberSelect } from '@/components/common/pickers';
import { QueryState } from '@/components/common/query-state';
import { useApiMutation, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';
import '@/features/team/labels';
import { reportError, useRecentAuth } from '@/features/team/recent-auth';

type Keys = 'open' | 'archived';

/** S12 Directions: business directions with lead, scoped counts, order and archive/restore. */
export const DirectionsScreen = () => {
  const { workspace } = useWorkspace();
  const can = useCan();
  const wsPath = useWsPath();
  const { state, set } = useUrlState<Keys>({});
  const includeArchived = state.archived === '1';
  const q = useApiQuery(directionEndpoints.list, { params: { workspaceId: workspace.id }, query: { includeArchived: includeArchived || undefined } });
  const manage = can('directions.manage');
  const [creating, setCreating] = useState(false);
  const reorder = useApiMutation(directionAdminEndpoints.reorder, { invalidate: ['directions.'], silentErrors: true });
  const rows = q.data ?? [];
  const active = rows.filter((d) => d.status === 'active');
  const move = async (d: DirectionRow, delta: -1 | 1) => {
    const ids = active.map((x) => x.id);
    const i = ids.indexOf(d.id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    try {
      await reorder.run({ params: { workspaceId: workspace.id }, body: { orderedIds: ids } });
    } catch (e) {
      reportError(e, 'The order could not be saved.');
    }
  };
  const columns: Column<DirectionRow>[] = [
    {
      key: 'name',
      header: 'Name',
      sticky: true,
      minWidth: 220,
      cell: (d) => (
        <span className="flex flex-col">
          <span className="font-medium text-fg">{d.name}</span>
          {d.description ? <span className="line-clamp-1 text-[12px] text-fg-2">{d.description}</span> : null}
        </span>
      ),
    },
    {
      key: 'lead',
      header: 'Lead',
      minWidth: 180,
      cell: (d) =>
        d.lead ? (
          <span className="inline-flex items-center gap-2">
            <Avatar name={d.lead.displayName} src={d.lead.avatarUrl} size={28} decorative />
            {d.lead.displayName}
          </span>
        ) : (
          <span className="text-fg-2">No lead</span>
        ),
    },
    { key: 'projects', header: 'Active Projects', align: 'right', minWidth: 130, cell: (d) => d.activeProjects },
    { key: 'tasks', header: 'Open Tasks', align: 'right', minWidth: 110, cell: (d) => d.openTasks },
    { key: 'updated', header: 'Updated', minWidth: 120, cell: (d) => formatDate(d.updatedAt, workspace.timezone) },
    { key: 'status', header: 'Status', minWidth: 110, cell: (d) => <StatusBadge status={d.status} label={label('directionStatus', d.status)} /> },
    {
      key: 'order',
      header: <span className="sr-only">Order</span>,
      headerLabel: 'Order',
      align: 'right',
      minWidth: 96,
      hidden: !manage,
      cell: (d) =>
        d.status === 'active' ? (
          <span className="inline-flex gap-1" onClick={(e) => e.stopPropagation()}>
            <IconButton label={`Move ${d.name} up`} icon={<ArrowUp size={14} />} variant="ghost" disabled={active[0]?.id === d.id || reorder.isPending} onClick={() => void move(d, -1)} />
            <IconButton label={`Move ${d.name} down`} icon={<ArrowDown size={14} />} variant="ghost" disabled={active[active.length - 1]?.id === d.id || reorder.isPending} onClick={() => void move(d, 1)} />
          </span>
        ) : null,
    },
  ];
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Directions"
        description="Business directions group projects. A lead manages people and priorities; access comes from roles granted for the direction."
        actions={
          manage ? (
            <Button variant="primary" icon={<Plus size={14} weight="bold" />} onClick={() => setCreating(true)}>
              New Direction
            </Button>
          ) : undefined
        }
      />
      <Toolbar>
        <Switch checked={includeArchived} onCheckedChange={(v) => set({ archived: v ? '1' : null })} label="Show archived directions" />
      </Toolbar>
      <QueryState query={q}>
        <DataTable
          caption="Directions"
          rows={rows}
          columns={columns}
          getRowId={(d) => d.id}
          onRowClick={(d) => set({ open: d.id })}
          selectedRowId={state.open ?? null}
          rowClassName={(d) => (d.status === 'archived' ? 'opacity-70' : undefined)}
          empty={
            <EmptyState
              icon={<Compass size={24} />}
              title="No directions yet"
              description={manage ? 'Create the first direction to group projects.' : 'Directions you can see appear here.'}
              action={manage ? <Button onClick={() => setCreating(true)}>New Direction</Button> : undefined}
            />
          }
        />
      </QueryState>
      <DirectionDrawer directionId={state.open ?? null} onClose={() => set({ open: null })} projectsHref={(id) => wsPath(`/projects?directionId=${id}`)} />
      <DirectionFormDialog open={creating} onOpenChange={setCreating} direction={null} onSaved={(id) => set({ open: id })} />
    </div>
  );
};

const DirectionFormDialog = ({
  open,
  onOpenChange,
  direction,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  direction: DirectionDetail | null;
  onSaved?: (id: string) => void;
}) => {
  const { workspace } = useWorkspace();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<number | null>(null);
  const create = useApiMutation(directionEndpoints.create, { invalidate: ['directions.'], successMessage: 'Direction created', silentErrors: true });
  const update = useApiMutation(directionEndpoints.update, { invalidate: ['directions.'], successMessage: 'Direction saved', silentErrors: true });
  const [version, setVersion] = useState(direction?.rowVersion ?? 0);
  useEffect(() => {
    if (!open) return;
    setName(direction?.name ?? '');
    setDescription(direction?.description ?? '');
    setVersion(direction?.rowVersion ?? 0);
    setErrors({});
    setError(null);
    // Only when the dialog opens; live refreshes must not wipe what is being typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, direction?.id]);
  const dirty = name !== (direction?.name ?? '') || description !== (direction?.description ?? '');
  return (
    <>
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
        dirty={dirty}
        title={direction ? `Edit ${direction.name}` : 'New Direction'}
        footer={
          <>
            <Button onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={name.trim().length < 2 || !dirty}
              loading={create.isPending || update.isPending}
              onClick={async () => {
                setErrors({});
                setError(null);
                try {
                  if (direction) {
                    await update.run(
                      { params: { workspaceId: workspace.id, directionId: direction.id }, body: { name: name.trim(), description: description.trim() || null } },
                      { ifMatch: version },
                    );
                    onOpenChange(false);
                  } else {
                    const d = await create.run({ params: { workspaceId: workspace.id }, body: { name: name.trim(), description: description.trim() || null } });
                    onOpenChange(false);
                    onSaved?.(d.id);
                  }
                } catch (e) {
                  if (isApiError(e) && e.code === 'VERSION_CONFLICT') setConflict(e.currentVersion ?? version);
                  else if (isApiError(e) && e.fieldErrors.length) setErrors(Object.fromEntries(e.fieldErrors.map((f) => [f.field.replace(/^body\./, ''), f.message])));
                  else setError(isApiError(e) ? e.message : 'The direction could not be saved.');
                }
              }}
            >
              {direction ? 'Save Changes' : 'Create Direction'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {error ? <Banner tone="danger">{error}</Banner> : null}
          <Field label="Name" required error={errors.name} helper="Unique among active directions.">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus />
          </Field>
          <Field label="Description" error={errors.description}>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={4000} />
          </Field>
        </div>
      </Dialog>
      <ConflictDialog
        open={conflict !== null}
        onOpenChange={(o) => {
          if (!o && conflict !== null) setVersion(conflict);
          if (!o) setConflict(null);
        }}
        onReload={() => window.location.reload()}
      />
    </>
  );
};

const DirectionDrawer = ({ directionId, onClose, projectsHref }: { directionId: string | null; onClose: () => void; projectsHref: (id: string) => string }) => {
  const { workspace } = useWorkspace();
  const wsPath = useWsPath();
  const q = useApiQuery(directionAdminEndpoints.get, { params: { workspaceId: workspace.id, directionId: directionId ?? '' } }, { enabled: !!directionId });
  const d = q.data;
  const [dialog, setDialog] = useState<'edit' | 'lead' | 'archive' | 'restore' | null>(null);
  const [reason, setReason] = useState('');
  const archive = useApiMutation(directionEndpoints.archive, { invalidate: ['directions.', 'projects.'], successMessage: 'Direction archived' });
  const restore = useApiMutation(directionAdminEndpoints.restore, { invalidate: ['directions.', 'projects.'], successMessage: 'Direction restored' });
  const manage = d?.permissions.manage ?? false;
  return (
    <>
      <Drawer
        open={!!directionId}
        onOpenChange={(o) => !o && onClose()}
        width={760}
        title={d?.name ?? 'Direction'}
        description={d ? (d.status === 'archived' ? 'Archived direction' : 'Active direction') : undefined}
        headerActions={
          d && manage ? (
            <Menu
              label="Direction actions"
              trigger={<IconButton label="Direction actions" icon={<DotsThree size={18} weight="bold" />} variant="ghost" />}
              items={[
                { label: 'Edit', hidden: d.status !== 'active', onSelect: () => setDialog('edit') },
                { label: 'Assign Lead', hidden: d.status !== 'active', onSelect: () => setDialog('lead') },
                { label: 'Archive', hidden: d.status !== 'active', destructive: true, onSelect: () => setDialog('archive') },
                { label: 'Restore', hidden: d.status !== 'archived', onSelect: () => setDialog('restore') },
              ]}
            />
          ) : undefined
        }
        footer={
          d ? (
            <>
              <Link href={projectsHref(d.id)} className="inline-flex h-11 items-center rounded-[8px] px-3 text-[13px] font-semibold text-primary hover:underline md:h-9">
                Open Projects
              </Link>
              {manage && d.status === 'active' ? (
                <Button variant="primary" onClick={() => setDialog('lead')}>
                  Assign Lead
                </Button>
              ) : null}
            </>
          ) : undefined
        }
      >
        {!d ? (
          q.error ? (
            <Banner tone="danger">{q.error.status === 404 ? 'This direction does not exist or is not visible to you.' : q.error.message}</Banner>
          ) : (
            <div className="flex flex-col gap-3" role="status" aria-label="Loading">
              <Skeleton className="h-8 w-1/2" />
              <Skeleton className="h-40 w-full" />
            </div>
          )
        ) : (
          <div className="flex flex-col gap-5">
            {d.status === 'archived' ? <Banner tone="warning">Archived{d.archiveReason ? `: ${d.archiveReason}` : ''}. Restore it to assign a lead or add projects.</Banner> : null}
            {d.lead && !d.leadHasDirectionRole ? (
              <Banner tone="info">
                {d.lead.displayName} leads this direction but holds no Direction Lead role for it, so the lead title alone grants no access.
                {d.permissions.manageAccess ? ' Use Assign Lead to grant it.' : ''}
              </Banner>
            ) : null}
            <DescriptionList
              columns={2}
              items={[
                {
                  label: 'Lead',
                  value: d.lead ? (
                    <Link href={wsPath(`/team/${d.lead.membershipId}`)} className="inline-flex items-center gap-2 hover:underline">
                      <Avatar name={d.lead.displayName} src={d.lead.avatarUrl} size={28} decorative />
                      {d.lead.displayName}
                    </Link>
                  ) : (
                    'No lead'
                  ),
                },
                { label: 'Status', value: <StatusBadge status={d.status} label={label('directionStatus', d.status)} /> },
                { label: 'Active Projects', value: d.activeProjects },
                { label: 'Open Tasks', value: d.openTasks },
                { label: 'Updated', value: formatDate(d.updatedAt, workspace.timezone) },
                { label: 'Description', value: d.description },
              ]}
            />
            <section className="flex flex-col gap-2">
              <h3 className="text-[16px] font-semibold text-fg">Projects you can see</h3>
              {d.projects.length ? (
                <ul className="flex flex-col divide-y divide-line rounded-[12px] border border-line">
                  {d.projects.map((p) => (
                    <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
                      <Link href={wsPath(`/projects/${p.id}`)} className="font-medium hover:underline">
                        {p.name}
                      </Link>
                      <span className="flex items-center gap-2 text-[12px] text-fg-2">
                        {label('projectType', p.type)} · {p.owner.displayName}
                        <StatusBadge status={p.status} />
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[13px] text-fg-2">No projects you can see.</p>
              )}
            </section>
          </div>
        )}
      </Drawer>
      {d ? (
        <>
          <DirectionFormDialog open={dialog === 'edit'} onOpenChange={(o) => setDialog(o ? 'edit' : null)} direction={d} />
          {dialog === 'lead' ? <AssignLeadDialog d={d} onClose={() => setDialog(null)} /> : null}
          <ConfirmDialog
            open={dialog === 'archive'}
            onOpenChange={(o) => {
              if (!o) {
                setDialog(null);
                setReason('');
              }
            }}
            title={`Archive ${d.name}?`}
            destructive
            body={
              d.activeProjects > 0
                ? `${d.activeProjects} active project(s) remain. Move or archive them first; archiving is refused until then.`
                : 'The direction disappears from pickers. History and archived projects keep their link to it; you can restore it later.'
            }
            confirmDisabled={d.activeProjects > 0}
            confirmLabel="Archive Direction"
            loading={archive.isPending}
            onConfirm={async () => {
              try {
                await archive.run({ params: { workspaceId: workspace.id, directionId: d.id }, body: { reason: reason.trim() || undefined } }, { ifMatch: d.rowVersion });
                setDialog(null);
                setReason('');
              } catch {
                /* toast shown */
              }
            }}
          >
            <Field label="Reason">
              <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
            </Field>
          </ConfirmDialog>
          <ConfirmDialog
            open={dialog === 'restore'}
            onOpenChange={(o) => !o && setDialog(null)}
            title={`Restore ${d.name}?`}
            body="The direction becomes active again. Its name must be unique among active directions."
            confirmLabel="Restore Direction"
            loading={restore.isPending}
            onConfirm={async () => {
              try {
                await restore.run({ params: { workspaceId: workspace.id, directionId: d.id } }, { ifMatch: d.rowVersion });
                setDialog(null);
              } catch {
                /* toast shown */
              }
            }}
          />
        </>
      ) : null}
    </>
  );
};

/** Lead change with its access impact shown first (grant/revoke the Direction Lead role explicitly). */
const AssignLeadDialog = ({ d, onClose }: { d: DirectionDetail; onClose: () => void }) => {
  const { workspace } = useWorkspace();
  const qc = useQueryClient();
  const { guard, dialog } = useRecentAuth();
  const [lead, setLead] = useState<string | null>(d.lead?.membershipId ?? null);
  const [impact, setImpact] = useState<LeadImpact | null>(null);
  const [grantRole, setGrantRole] = useState(false);
  const [revokePrevious, setRevokePrevious] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const preview = useApiMutation(directionAdminEndpoints.leadImpact, { silentErrors: true });
  const assign = useApiMutation(directionAdminEndpoints.assignLead, { invalidate: ['directions.', 'team.', 'projects.'], successMessage: 'Lead updated', silentErrors: true });
  useEffect(() => {
    let cancelled = false;
    setImpact(null);
    setError(null);
    preview
      .run({ params: { workspaceId: workspace.id, directionId: d.id }, body: { leadMembershipId: lead } })
      .then((r) => {
        if (cancelled) return;
        setImpact(r);
        setGrantRole(!!r.proposedAccess?.roleWouldBeGranted && r.proposedAccess.canGrant);
        setRevokePrevious(false);
      })
      .catch((e) => !cancelled && setError(isApiError(e) ? e.message : 'The impact could not be calculated.'));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lead]);
  const unchanged = lead === (d.lead?.membershipId ?? null) && !grantRole;
  return (
    <>
      <Dialog
        open
        onOpenChange={(o) => !o && onClose()}
        title={`Lead of ${d.name}`}
        description="The lead title alone grants no access. Choose explicitly whether to grant or revoke the Direction Lead role."
        footer={
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!impact || unchanged}
              loading={assign.isPending}
              onClick={async () => {
                setError(null);
                try {
                  await guard(() =>
                    assign.run(
                      { params: { workspaceId: workspace.id, directionId: d.id }, body: { leadMembershipId: lead, grantLeadRole: grantRole, revokePreviousLeadRole: revokePrevious } },
                      { ifMatch: d.rowVersion },
                    ),
                  );
                  onClose();
                } catch (e) {
                  if (isApiError(e) && e.code === 'VERSION_CONFLICT') setConflict(true);
                  else if (isApiError(e)) setError(e.fieldErrors[0]?.message ?? e.message);
                  else reportError(e);
                }
              }}
            >
              Apply
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {error ? <Banner tone="danger">{error}</Banner> : null}
          <Field label="Lead" helper="Leave empty to remove the lead.">
            <MemberSelect value={lead} onChange={setLead} clearable placeholder="No lead" />
          </Field>
          {preview.isPending && !impact ? <Skeleton className="h-24 w-full" /> : null}
          {impact ? (
            <div className="flex flex-col gap-3 rounded-[12px] border border-line p-4">
              <p className="text-[13px] text-fg">
                {impact.current?.displayName ?? 'No lead'} → <span className="font-semibold">{impact.proposed?.displayName ?? 'No lead'}</span> · {impact.projects.active} active of{' '}
                {impact.projects.total} project(s)
              </p>
              {impact.proposedAccess ? (
                <p className="text-[13px] text-fg-2">
                  {impact.proposed?.displayName} {impact.proposedAccess.hasDirectionLeadRole ? 'already holds the Direction Lead role here' : 'holds no Direction Lead role here'} and can read{' '}
                  {impact.proposedAccess.readableProjects} project(s) of this direction today.
                </p>
              ) : null}
              {impact.proposedAccess?.roleWouldBeGranted ? (
                <Checkbox
                  checked={grantRole}
                  disabled={!impact.proposedAccess.canGrant}
                  onCheckedChange={setGrantRole}
                  label={`Grant ${impact.proposedAccess.roleWouldBeGranted.roleName} for ${d.name}`}
                  description={
                    impact.proposedAccess.canGrant
                      ? `${impact.proposedAccess.roleWouldBeGranted.permissions} permissions within this direction only.`
                      : 'You cannot grant this role; ask someone who manages access.'
                  }
                />
              ) : null}
              {impact.previousAccess?.grantId ? (
                <Checkbox
                  checked={revokePrevious}
                  disabled={!impact.previousAccess.canRevoke}
                  onCheckedChange={setRevokePrevious}
                  label={`Revoke ${impact.previousAccess.roleName ?? 'the Direction Lead role'} from ${impact.current?.displayName ?? 'the previous lead'}`}
                  description={impact.previousAccess.canRevoke ? 'Their open sessions lose it on the next request.' : 'You cannot revoke this grant.'}
                />
              ) : null}
              {impact.notes.map((n, i) => (
                <p key={i} className="text-[12px] text-fg-2">
                  {n}
                </p>
              ))}
            </div>
          ) : null}
        </div>
      </Dialog>
      <ConflictDialog
        open={conflict}
        onOpenChange={(o) => {
          setConflict(o);
          if (!o) void qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0] ?? '').startsWith('directions.') });
        }}
        onReload={() => window.location.reload()}
      />
      {dialog}
    </>
  );
};
