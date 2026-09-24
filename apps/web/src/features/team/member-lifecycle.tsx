'use client';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { teamEndpoints, type DeactivationPreview, type MemberDetail, type ResolutionInput } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { Badge, Banner, Button, Checkbox, Dialog, Drawer, Field, Skeleton, Textarea, formatDateTime, toast } from '@castlane/ui';
import { MemberSelect } from '@/components/common/pickers';
import { QueryState } from '@/components/common/query-state';
import { useApiMutation, useApiQuery } from '@/lib/hooks';
import { useWorkspace } from '@/lib/workspace-context';
import { GrantEditor, draftComplete, toGrantInput, type GrantDraft } from './grant-editor';
import { reportError, useRecentAuth } from './recent-auth';

type Props = { m: MemberDetail; open: boolean; onOpenChange: (o: boolean) => void };

const ReasonDialog = ({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  destructive,
  optional,
  loading,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  optional?: boolean;
  loading: boolean;
  onConfirm: (reason: string) => Promise<void>;
}) => {
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (!open) setReason('');
  }, [open]);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="small"
      title={title}
      description={description}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)} disabled={loading}>
            Cancel
          </Button>
          <Button variant={destructive ? 'danger' : 'primary'} loading={loading} disabled={!optional && reason.trim().length < 3} onClick={() => void onConfirm(reason.trim())}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <Field label="Reason" required={!optional} helper="Recorded in the audit log.">
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} />
      </Field>
    </Dialog>
  );
};

export const SuspendDialog = ({ m, open, onOpenChange }: Props) => {
  const { workspace } = useWorkspace();
  const { guard, dialog } = useRecentAuth();
  const suspend = useApiMutation(teamEndpoints.suspend, { invalidate: ['team.'], silentErrors: true });
  return (
    <>
      <ReasonDialog
        open={open}
        onOpenChange={onOpenChange}
        title={`Suspend ${m.displayName}?`}
        description="Workspace access stops immediately, including open tabs. Roles and assignments are kept so you can reactivate later."
        confirmLabel="Suspend"
        destructive
        loading={suspend.isPending}
        onConfirm={async (reason) => {
          try {
            await guard(() => suspend.run({ params: { workspaceId: workspace.id, membershipId: m.membershipId }, body: { reason } }, { ifMatch: m.rowVersion }));
            toast.success('Member suspended');
            onOpenChange(false);
          } catch (e) {
            reportError(e);
          }
        }}
      />
      {dialog}
    </>
  );
};

export const ReactivateDialog = ({ m, open, onOpenChange }: Props) => {
  const { workspace } = useWorkspace();
  const { guard, dialog } = useRecentAuth();
  const reactivate = useApiMutation(teamEndpoints.reactivate, { invalidate: ['team.'], silentErrors: true });
  return (
    <>
      <ReasonDialog
        open={open}
        onOpenChange={onOpenChange}
        title={`Reactivate ${m.displayName}?`}
        description="The suspension ends and the member’s existing roles apply again."
        confirmLabel="Reactivate"
        optional
        loading={reactivate.isPending}
        onConfirm={async (reason) => {
          try {
            await guard(() => reactivate.run({ params: { workspaceId: workspace.id, membershipId: m.membershipId }, body: { reason: reason || undefined } }, { ifMatch: m.rowVersion }));
            toast.success('Member reactivated');
            onOpenChange(false);
          } catch (e) {
            reportError(e);
          }
        }}
      />
      {dialog}
    </>
  );
};

export const RevokeSessionsDialog = ({ m, open, onOpenChange }: Props) => {
  const { workspace } = useWorkspace();
  const revoke = useApiMutation(teamEndpoints.revokeSessions, { invalidate: ['team.'], silentErrors: true });
  return (
    <ReasonDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Sign ${m.displayName} out everywhere?`}
      description="Every active session ends now; the member must sign in again. They receive a security e-mail."
      confirmLabel="Revoke Sessions"
      destructive
      loading={revoke.isPending}
      onConfirm={async (reason) => {
        try {
          const r = await revoke.run({ params: { workspaceId: workspace.id, membershipId: m.membershipId }, body: { reason } });
          toast.success(r.revoked ? `${r.revoked} session${r.revoked === 1 ? '' : 's'} signed out` : 'No active sessions');
          onOpenChange(false);
        } catch (e) {
          reportError(e);
        }
      }}
    />
  );
};

type Groups = DeactivationPreview['groups'];

/** Successor pickers per item with "apply to all" (shared by deactivation and Transfer Work). */
const WorkItems = ({
  groups,
  successors,
  setSuccessor,
  selectable,
  selected,
  setSelected,
  problems,
}: {
  groups: Groups;
  successors: Record<string, string | null>;
  setSuccessor: (key: string, v: string | null) => void;
  selectable?: boolean;
  selected?: Set<string>;
  setSelected?: (s: Set<string>) => void;
  problems?: Map<string, string>;
}) => {
  const { user } = useWorkspace();
  const [bulk, setBulk] = useState<string | null>(null);
  const keys = groups.flatMap((g) => g.items.map((i) => `${g.kind}:${i.entityId}`));
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-2 rounded-[8px] bg-surface-2 p-3">
        <Field label="Successor for all items" className="min-w-[220px] flex-1">
          <MemberSelect value={bulk} onChange={setBulk} clearable />
        </Field>
        <Button
          disabled={!bulk}
          onClick={() => {
            for (const k of selectable ? keys.filter((x) => selected?.has(x)) : keys) setSuccessor(k, bulk);
          }}
        >
          Apply to {selectable ? 'Selected' : 'All'}
        </Button>
      </div>
      {groups.map((g) => (
        <section key={g.kind} className="flex flex-col gap-2">
          <h3 className="text-[14px] font-semibold text-fg">
            {g.label} <span className="font-normal text-fg-2">({g.items.length})</span>
          </h3>
          <p className="text-[12px] text-fg-2">Without a successor: {g.unassignedBehaviour}</p>
          <ul className="flex flex-col divide-y divide-line rounded-[8px] border border-line">
            {g.items.map((i) => {
              const key = `${g.kind}:${i.entityId}`;
              const problem = problems?.get(key);
              return (
                <li key={key} className="grid grid-cols-1 items-center gap-2 px-3 py-2 md:grid-cols-[minmax(0,1fr)_260px]">
                  <div className="flex min-w-0 items-start gap-2">
                    {selectable ? (
                      <Checkbox
                        aria-label={`Select ${i.title}`}
                        checked={!!selected?.has(key)}
                        onCheckedChange={(v) => {
                          const next = new Set(selected);
                          if (v) next.add(key);
                          else next.delete(key);
                          setSelected?.(next);
                        }}
                      />
                    ) : null}
                    <span className="flex min-w-0 flex-col">
                      {i.href ? (
                        <Link href={i.href} className="truncate font-medium text-fg hover:underline" target="_blank" rel="noopener noreferrer">
                          {i.title}
                        </Link>
                      ) : (
                        <span className="truncate font-medium text-fg">{i.title}</span>
                      )}
                      <span className="flex flex-wrap gap-1 text-[12px] text-fg-2">
                        {i.dueAt ? <span>Due {formatDateTime(i.dueAt, user.timezone)}</span> : null}
                        {i.requiresSuccessor ? <Badge tone="warning">Successor required</Badge> : null}
                      </span>
                      {problem ? <span className="text-[12px] text-danger">{problem}</span> : null}
                    </span>
                  </div>
                  <MemberSelect aria-label={`Successor for ${i.title}`} value={successors[key] ?? null} onChange={(v) => setSuccessor(key, v)} clearable placeholder={i.requiresSuccessor ? 'Choose a successor' : 'Unassigned'} />
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
};

const toResolutions = (groups: Groups, successors: Record<string, string | null>, only?: Set<string>): ResolutionInput[] =>
  groups.flatMap((g) =>
    g.items
      .map((i) => ({ kind: g.kind, entityId: i.entityId, successorMembershipId: successors[`${g.kind}:${i.entityId}`] ?? null }))
      .filter((r) => (only ? only.has(`${r.kind}:${r.entityId}`) : true)),
  );

/**
 * F12 / T019: impact preview with successors per item or in bulk, then one confirmed transaction
 * (transfer → revoke roles → end assignments → revoke sessions). The preview token binds the plan.
 */
export const DeactivateDrawer = ({ m, open, onOpenChange }: Props) => {
  const { workspace } = useWorkspace();
  const { guard, dialog } = useRecentAuth();
  const [successors, setSuccessors] = useState<Record<string, string | null>>({});
  const [reason, setReason] = useState('');
  const [stale, setStale] = useState(false);
  const [preview, setPreview] = useState<DeactivationPreview | null>(null);
  const previewMut = useApiMutation(teamEndpoints.deactivationPreview, { silentErrors: true });
  const deactivate = useApiMutation(teamEndpoints.deactivate, { invalidate: ['team.', 'projects.', 'directions.'], silentErrors: true });
  const seq = useRef(0);
  const refresh = useCallback(
    async (s: Record<string, string | null>, groups?: Groups) => {
      const id = ++seq.current;
      const resolutions = groups ? toResolutions(groups, s).filter((r) => r.successorMembershipId) : [];
      try {
        const p = await previewMut.run({ params: { workspaceId: workspace.id, membershipId: m.membershipId }, body: { resolutions } });
        if (id === seq.current) setPreview(p);
      } catch (e) {
        reportError(e, 'The impact preview could not be loaded.');
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workspace.id, m.membershipId],
  );
  useEffect(() => {
    if (open) void refresh({});
  }, [open, refresh]);
  const problems = useMemo(() => {
    const map = new Map<string, string>();
    for (const x of preview?.missingSuccessors ?? []) map.set(`${x.kind}:${x.entityId}`, 'Choose a successor for this item.');
    for (const x of preview?.invalidSuccessors ?? []) map.set(`${x.kind}:${x.entityId}`, x.message);
    return map;
  }, [preview]);
  const setSuccessor = (key: string, v: string | null) => {
    const next = { ...successors, [key]: v };
    setSuccessors(next);
    setStale(false);
    void refresh(next, preview?.groups);
  };
  const total = preview?.groups.reduce((n, g) => n + g.items.length, 0) ?? 0;
  const canConfirm = !!preview?.impactToken && reason.trim().length >= 3 && !previewMut.isPending;
  return (
    <>
      <Drawer
        open={open}
        onOpenChange={onOpenChange}
        width={760}
        dirty={reason.length > 0 || Object.keys(successors).length > 0}
        title={`Deactivate ${m.displayName}`}
        description="Review open work, choose successors, then confirm. Their history keeps its author."
        footer={
          <>
            <Button onClick={() => onOpenChange(false)} disabled={deactivate.isPending}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={!canConfirm}
              loading={deactivate.isPending}
              onClick={async () => {
                if (!preview?.impactToken) return;
                const resolutions = toResolutions(preview.groups, successors).filter((r) => r.successorMembershipId);
                try {
                  await guard(() =>
                    deactivate.run(
                      { params: { workspaceId: workspace.id, membershipId: m.membershipId }, body: { impactToken: preview.impactToken!, resolutions, reason: reason.trim() } },
                      { ifMatch: preview.rowVersion },
                    ),
                  );
                  toast.success(`${m.displayName} was deactivated`, 'Sessions were signed out and open work was handed over.');
                  onOpenChange(false);
                } catch (e) {
                  if (isApiError(e) && (e.code === 'INVALID_STATE' || e.code === 'VALIDATION_FAILED') && /preview|changed|successor/i.test(e.message)) {
                    setStale(true);
                    void refresh(successors, preview.groups);
                  } else reportError(e);
                }
              }}
            >
              Deactivate Member
            </Button>
          </>
        }
      >
        {!preview ? (
          <div className="flex flex-col gap-3" role="status" aria-label="Loading impact preview">
            <Skeleton className="h-6 w-1/2" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            {preview.blocked ? <Banner tone="danger">{preview.blocked}</Banner> : null}
            {stale ? <Banner tone="warning">Some responsibilities changed after the preview. Review the updated list, then confirm again.</Banner> : null}
            <section className="flex flex-col gap-2">
              <h3 className="text-[14px] font-semibold text-fg">What happens</h3>
              <ul className="grid grid-cols-1 gap-1 text-[13px] sm:grid-cols-2">
                {preview.effects.map((e) => (
                  <li key={e.kind} className="flex justify-between gap-2 rounded-[6px] bg-surface-2 px-3 py-1.5">
                    <span>{e.label}</span>
                    <span className="font-mono tabular-nums">{e.count}</span>
                  </li>
                ))}
              </ul>
            </section>
            {total > 0 ? (
              <WorkItems groups={preview.groups} successors={successors} setSuccessor={setSuccessor} problems={problems} />
            ) : (
              <p className="text-[13px] text-fg-2">No open responsibilities were found for this member.</p>
            )}
            <Field label="Reason" required helper="Recorded in the audit log.">
              <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} />
            </Field>
            {preview.impactToken ? <p className="text-[12px] text-fg-2">This preview is valid until {formatDateTime(preview.expiresAt, undefined)}.</p> : null}
          </div>
        )}
      </Drawer>
      {dialog}
    </>
  );
};

export const TransferWorkDrawer = ({ m, open, onOpenChange }: Props) => {
  const { workspace } = useWorkspace();
  const q = useApiQuery(teamEndpoints.openWork, { params: { workspaceId: workspace.id, membershipId: m.membershipId } }, { enabled: open });
  const [successors, setSuccessors] = useState<Record<string, string | null>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const transfer = useApiMutation(teamEndpoints.transferWork, { invalidate: ['team.', 'projects.', 'directions.'], silentErrors: true });
  const groups = q.data?.groups ?? [];
  const chosen = toResolutions(groups, successors, selected);
  const ready = chosen.length > 0 && chosen.every((r) => r.successorMembershipId);
  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      width={760}
      dirty={selected.size > 0}
      title={`Transfer work from ${m.displayName}`}
      description="Hand selected items to other members. The member stays active."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!ready}
            loading={transfer.isPending}
            onClick={async () => {
              try {
                const r = await transfer.run({ params: { workspaceId: workspace.id, membershipId: m.membershipId }, body: { resolutions: chosen } });
                toast.success(`${r.transferred} item${r.transferred === 1 ? '' : 's'} transferred`);
                onOpenChange(false);
              } catch (e) {
                reportError(e);
              }
            }}
          >
            Transfer {chosen.length || ''} Item{chosen.length === 1 ? '' : 's'}
          </Button>
        </>
      }
    >
      <QueryState query={q}>
        {groups.length === 0 ? (
          <p className="text-[13px] text-fg-2">No open responsibilities to transfer.</p>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-[13px] text-fg-2">Select items and choose who takes them over. Every selected item needs a successor.</p>
            <WorkItems groups={groups} successors={successors} setSuccessor={(k, v) => setSuccessors({ ...successors, [k]: v })} selectable selected={selected} setSelected={setSelected} />
          </div>
        )}
      </QueryState>
    </Drawer>
  );
};

/** T020: previous grants are listed; sensitive ones stay unselected unless chosen explicitly. */
export const RestoreDialog = ({ m, open, onOpenChange }: Props) => {
  const { workspace } = useWorkspace();
  const { guard, dialog } = useRecentAuth();
  const q = useApiQuery(teamEndpoints.restorePreview, { params: { workspaceId: workspace.id, membershipId: m.membershipId } }, { enabled: open });
  const [picked, setPicked] = useState<Set<number> | null>(null);
  const [extra, setExtra] = useState<GrantDraft[]>([]);
  const [reason, setReason] = useState('');
  const restore = useApiMutation(teamEndpoints.restore, { invalidate: ['team.'], silentErrors: true });
  const prev = q.data?.previousGrants ?? [];
  const selected = picked ?? new Set(prev.map((g, i) => (!g.sensitive && g.grantable ? i : -1)).filter((i) => i >= 0));
  const grants = [...prev.filter((_, i) => selected.has(i)).map((g) => ({ roleId: g.roleId, scopeType: g.scopeType, scopeId: g.scopeId })), ...extra.filter(draftComplete).map(toGrantInput)];
  return (
    <>
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
        title={`Restore ${m.displayName}`}
        description="Restoring re-activates the membership. Sensitive access is never restored silently — select it explicitly if it is still needed."
        footer={
          <>
            <Button onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={reason.trim().length < 3 || !q.data}
              loading={restore.isPending}
              onClick={async () => {
                try {
                  await guard(() => restore.run({ params: { workspaceId: workspace.id, membershipId: m.membershipId }, body: { reason: reason.trim(), grants } }, { ifMatch: q.data!.rowVersion }));
                  toast.success(`${m.displayName} was restored`, grants.length ? `${grants.length} role grant${grants.length === 1 ? '' : 's'} applied.` : 'No roles yet — grant access from the Access tab.');
                  onOpenChange(false);
                } catch (e) {
                  reportError(e);
                }
              }}
            >
              Restore Member
            </Button>
          </>
        }
      >
        <QueryState query={q}>
          <div className="flex flex-col gap-4">
            <section className="flex flex-col gap-2">
              <h3 className="text-[14px] font-semibold text-fg">Access before deactivation</h3>
              {prev.length === 0 ? <p className="text-[13px] text-fg-2">No role grants were removed at deactivation.</p> : null}
              <ul className="flex flex-col gap-2">
                {prev.map((g, i) => (
                  <li key={`${g.roleId}-${g.scopeId ?? g.scopeType}`} className="rounded-[8px] border border-line p-3">
                    <Checkbox
                      checked={selected.has(i)}
                      disabled={!g.grantable}
                      onCheckedChange={(v) => {
                        const next = new Set(selected);
                        if (v) next.add(i);
                        else next.delete(i);
                        setPicked(next);
                      }}
                      label={
                        <span className="flex flex-wrap items-center gap-1">
                          {g.roleName} · {g.scopeLabel}
                          {g.sensitive ? <Badge tone="warning">Sensitive</Badge> : null}
                        </span>
                      }
                      description={g.note ?? undefined}
                    />
                  </li>
                ))}
              </ul>
            </section>
            <section className="flex flex-col gap-2">
              <h3 className="text-[14px] font-semibold text-fg">Additional roles</h3>
              {extra.length ? (
                <GrantEditor value={extra} onChange={setExtra} />
              ) : (
                <div>
                  <Button size="sm" onClick={() => setExtra([{ key: 'x0', roleId: null, scopeType: 'workspace', scopeId: null }])}>
                    Add a Role
                  </Button>
                </div>
              )}
            </section>
            <Field label="Reason" required helper="Recorded in the audit log.">
              <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} />
            </Field>
          </div>
        </QueryState>
      </Dialog>
      {dialog}
    </>
  );
};
