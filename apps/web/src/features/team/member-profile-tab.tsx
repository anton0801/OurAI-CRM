'use client';
import Link from 'next/link';
import { Plus } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { teamEndpoints, type MemberDetail } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { RESPONSIBILITIES } from '@castlane/domain';
import { Avatar, Badge, Banner, Button, ConfirmDialog, DataTable, DescriptionList, Dialog, Drawer, Field, Input, Panel, Select, formatDate } from '@castlane/ui';
import { ConflictDialog } from '@/components/common/conflict';
import { changedFields, pickChanged, useEditBase } from '@/lib/edit-base';
import { EntitySelect } from '@/components/common/entity-select';
import { DirectionSelect, MemberSelect } from '@/components/common/pickers';
import { useApiMutation } from '@/lib/hooks';
import { useWorkspace, useWsPath } from '@/lib/workspace-context';
import { dutyLabel } from './labels';

type Duty = MemberDetail['responsibilityAssignments'][number];

export const MemberProfileTab = ({ m }: { m: MemberDetail }) => {
  const { workspace, user } = useWorkspace();
  const wsPath = useWsPath();
  const [adding, setAdding] = useState(false);
  const [ending, setEnding] = useState<Duty | null>(null);
  const end = useApiMutation(teamEndpoints.endResponsibility, { invalidate: ['team.'], successMessage: 'Duty ended' });
  const current = m.responsibilityAssignments.filter((d) => !d.validTo || new Date(d.validTo) > new Date());
  const past = m.responsibilityAssignments.filter((d) => d.validTo && new Date(d.validTo) <= new Date());
  const cols = (historical: boolean) => [
    { key: 'duty', header: 'Responsibility', sticky: true, minWidth: 180, cell: (d: Duty) => dutyLabel(d.duty) },
    { key: 'scope', header: 'Scope', minWidth: 200, cell: (d: Duty) => d.scopeLabel },
    { key: 'from', header: 'Since', minWidth: 120, cell: (d: Duty) => formatDate(d.validFrom, user.timezone) },
    ...(historical ? [{ key: 'to', header: 'Until', minWidth: 120, cell: (d: Duty) => formatDate(d.validTo, user.timezone) }] : []),
    ...(!historical && m.permissions.update
      ? [
          {
            key: 'actions',
            header: <span className="sr-only">Actions</span>,
            align: 'right' as const,
            minWidth: 110,
            cell: (d: Duty) => (
              <Button size="sm" variant="ghost" className="font-sans" onClick={() => setEnding(d)}>
                End Duty
              </Button>
            ),
          },
        ]
      : []),
  ];
  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Panel title="Profile">
        <DescriptionList
          items={[
            { label: 'Email', value: m.email },
            { label: 'Title', value: m.title },
            {
              label: 'Manager',
              value: m.manager ? (
                <Link href={wsPath(`/team/${m.manager.membershipId}`)} className="inline-flex items-center gap-2 hover:underline">
                  <Avatar name={m.manager.displayName} src={m.manager.avatarUrl} size={24} decorative />
                  {m.manager.displayName}
                </Link>
              ) : null,
            },
            {
              label: 'Direct Reports',
              value: m.reports.length ? (
                <span className="flex flex-wrap gap-x-3 gap-y-1">
                  {m.reports.map((r) => (
                    <Link key={r.membershipId} href={wsPath(`/team/${r.membershipId}`)} className="hover:underline">
                      {r.displayName}
                    </Link>
                  ))}
                </span>
              ) : null,
            },
            { label: 'Joined', value: formatDate(m.joinedAt, user.timezone) },
            { label: 'Time Zone', value: m.timezone ?? `Workspace default (${workspace.timezone})` },
            { label: 'Skills', value: m.skills.length ? <span className="flex flex-wrap gap-1">{m.skills.map((s) => <Badge key={s}>{s}</Badge>)}</span> : null },
            { label: 'Directions', value: m.directions.length ? m.directions.map((d) => d.name).join(', ') : null },
            { label: 'Roles', value: m.roles.length ? m.roles.map((r) => `${r.roleName} (${r.scopeLabel})`).join('; ') : 'No role' },
            { label: 'Restored', value: m.restoredAt ? formatDate(m.restoredAt, user.timezone) : null, hidden: !m.restoredAt },
          ]}
        />
      </Panel>
      <Panel
        title="Responsibilities"
        description="Work duties. They describe who does what and never grant permissions."
        actions={
          m.permissions.update && m.status === 'active' ? (
            <Button size="sm" icon={<Plus size={14} />} onClick={() => setAdding(true)}>
              Add Duty
            </Button>
          ) : undefined
        }
        bodyClassName="flex flex-col gap-3 p-4"
      >
        {current.length ? <DataTable caption="Current duties" rows={current} columns={cols(false)} getRowId={(d) => d.id} density="compact" /> : <p className="text-[13px] text-fg-2">No duties assigned.</p>}
        {past.length ? (
          <>
            <h3 className="text-[13px] font-semibold text-fg">Past duties</h3>
            <DataTable caption="Past duties" rows={past} columns={cols(true)} getRowId={(d) => d.id} density="compact" />
          </>
        ) : null}
      </Panel>
      <AddDutyDialog m={m} open={adding} onOpenChange={setAdding} />
      <ConfirmDialog
        open={!!ending}
        onOpenChange={(o) => !o && setEnding(null)}
        title="End this duty?"
        body={`${ending ? dutyLabel(ending.duty) : ''} (${ending?.scopeLabel ?? ''}) ends now. The history is kept.`}
        confirmLabel="End Duty"
        loading={end.isPending}
        onConfirm={async () => {
          if (!ending) return;
          await end.run({ params: { workspaceId: workspace.id, responsibilityId: ending.id }, body: {} }, { ifMatch: ending.rowVersion });
          setEnding(null);
        }}
      />
    </div>
  );
};

const AddDutyDialog = ({ m, open, onOpenChange }: { m: MemberDetail; open: boolean; onOpenChange: (o: boolean) => void }) => {
  const { workspace } = useWorkspace();
  const [duty, setDuty] = useState<string | null>(null);
  const [scopeType, setScopeType] = useState<'workspace' | 'direction' | 'project' | 'account'>('workspace');
  const [scopeId, setScopeId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const add = useApiMutation(teamEndpoints.addResponsibility, { invalidate: ['team.'], successMessage: 'Duty added', silentErrors: true });
  const reset = () => {
    setDuty(null);
    setScopeType('workspace');
    setScopeId(null);
    setError(null);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
      dirty={!!duty}
      title="Add duty"
      size="small"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!duty || (scopeType !== 'workspace' && !scopeId)}
            loading={add.isPending}
            onClick={async () => {
              try {
                await add.run({ params: { workspaceId: workspace.id, membershipId: m.membershipId }, body: { duty: duty as never, scopeType, scopeId: scopeType === 'workspace' ? null : scopeId } });
                reset();
                onOpenChange(false);
              } catch (e) {
                setError(isApiError(e) ? e.message : 'The duty could not be added.');
              }
            }}
          >
            Add Duty
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <Field label="Responsibility" required>
          <Select value={duty} onChange={setDuty} options={RESPONSIBILITIES.map((r) => ({ value: r, label: dutyLabel(r) }))} />
        </Field>
        <Field label="Where" required>
          <Select
            value={scopeType}
            onChange={(v) => {
              setScopeType((v ?? 'workspace') as typeof scopeType);
              setScopeId(null);
            }}
            options={[
              { value: 'workspace', label: 'Whole workspace' },
              { value: 'direction', label: 'One direction' },
              { value: 'project', label: 'One project' },
              { value: 'account', label: 'One account' },
            ]}
          />
        </Field>
        {scopeType === 'direction' ? (
          <Field label="Direction" required>
            <DirectionSelect value={scopeId} onChange={setScopeId} />
          </Field>
        ) : scopeType === 'project' ? (
          <Field label="Project" required>
            <EntitySelect type="project" value={scopeId} onChange={setScopeId} />
          </Field>
        ) : scopeType === 'account' ? (
          <Field label="Account" required>
            <EntitySelect type="account" value={scopeId} onChange={setScopeId} />
          </Field>
        ) : null}
      </div>
    </Dialog>
  );
};

/** Edit title, manager and skills (If-Match; conflicts keep the user's input). */
export const EditProfileDrawer = ({ m, open, onOpenChange }: { m: MemberDetail; open: boolean; onOpenChange: (o: boolean) => void }) => {
  const { workspace } = useWorkspace();
  const [title, setTitle] = useState(m.title ?? '');
  const [manager, setManager] = useState<string | null>(m.manager?.membershipId ?? null);
  const [skills, setSkills] = useState(m.skills.join(', '));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const fill = (x: MemberDetail) => {
    setTitle(x.title ?? '');
    setManager(x.manager?.membershipId ?? null);
    setSkills(x.skills.join(', '));
  };
  // The member as the drawer opened: a concurrent change surfaces as a conflict instead of being
  // overwritten, and only the fields changed here are sent (T162).
  const edit = useEditBase(m, { open, key: m.membershipId, onReload: fill });
  const start = edit.start ?? m;
  const update = useApiMutation(teamEndpoints.update, { invalidate: ['team.'], successMessage: 'Profile saved', silentErrors: true });
  useEffect(() => {
    if (!open) return;
    fill(m);
    setErrors({});
    setError(null);
    // Only when the drawer opens; live refreshes of the member must not wipe what is being typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, m.membershipId]);
  const skillList = skills
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const dirty = title !== (start.title ?? '') || manager !== (start.manager?.membershipId ?? null) || skillList.join(',') !== start.skills.join(',');
  return (
    <>
      <Drawer
        open={open}
        onOpenChange={onOpenChange}
        dirty={dirty}
        title={`Edit ${m.displayName}`}
        description="Changing the manager never rewrites historical authorship."
        footer={
          <>
            <Button onClick={() => onOpenChange(false)} disabled={update.isPending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={update.isPending}
              disabled={!dirty}
              onClick={async () => {
                setErrors({});
                setError(null);
                const bad = skillList.find((s) => s.length < 2 || s.length > 40);
                if (bad) return setErrors({ skills: 'Each skill needs 2–40 characters.' });
                if (skillList.length > 30) return setErrors({ skills: 'Use at most 30 skills.' });
                try {
                  const body = { title: title.trim() || null, managerMembershipId: manager, skills: skillList };
                  const before = { title: start.title?.trim() || null, managerMembershipId: start.manager?.membershipId ?? null, skills: start.skills };
                  await update.run({ params: { workspaceId: workspace.id, membershipId: m.membershipId }, body: pickChanged(body, changedFields(before, body)) }, { ifMatch: edit.version });
                  onOpenChange(false);
                } catch (e) {
                  if (edit.catchConflict(e)) return;
                  if (isApiError(e) && e.fieldErrors.length) setErrors(Object.fromEntries(e.fieldErrors.map((f) => [f.field, f.message])));
                  else setError(isApiError(e) ? e.message : 'The profile could not be saved.');
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
          <Field label="Title" error={errors.title}>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
          </Field>
          <Field label="Manager" error={errors.managerMembershipId}>
            <MemberSelect value={manager} onChange={setManager} clearable />
          </Field>
          <Field label="Skills" helper="Comma-separated, up to 30." error={errors.skills}>
            <Input value={skills} onChange={(e) => setSkills(e.target.value)} />
          </Field>
        </div>
      </Drawer>
      <ConflictDialog {...edit.conflictDialog} />
    </>
  );
};
