'use client';
import { ArrowsLeftRight, DotsThree, PencilSimple } from '@phosphor-icons/react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { projectEndpoints, type ProjectDetail } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import {
  Avatar,
  Badge,
  Banner,
  Button,
  ConfirmDialog,
  Field,
  IconButton,
  Menu,
  PageHeader,
  StatusBadge,
  TabPanel,
  Tabs,
  Textarea,
  toast,
  type MenuItem,
} from '@castlane/ui';
import { DirectionSelect } from '@/components/common/pickers';
import { QueryState } from '@/components/common/query-state';
import { useApiMutation, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { PROJECT_TABS } from '@/lib/project-tabs';
import { useUrlState } from '@/lib/url-state';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';
import '@/features/slots';

type Transition = { target: ProjectDetail['status']; label: string; needsReason?: boolean; destructive?: boolean };

const transitionsFor = (p: ProjectDetail): Transition[] => {
  switch (p.status) {
    case 'draft':
      return [{ target: 'active', label: 'Activate' }, { target: 'archived', label: 'Archive Draft', destructive: true, needsReason: true }];
    case 'active':
      return [{ target: 'paused', label: 'Pause', needsReason: true }, { target: 'completed', label: 'Complete' }];
    case 'paused':
      return [{ target: 'active', label: 'Resume' }, { target: 'completed', label: 'Complete' }];
    case 'completed':
      return [{ target: 'active', label: 'Reopen', needsReason: true }, { target: 'archived', label: 'Archive', destructive: true }];
    case 'archived':
      return [{ target: 'completed', label: 'Restore to Completed', needsReason: true }];
  }
};

/** S15 Project Workspace. Tabs come from the module registry and use the same records as module pages. */
export const ProjectWorkspace = ({ projectId }: { projectId: string }) => {
  const { workspace } = useWorkspace();
  const can = useCan();
  const wsPath = useWsPath();
  const router = useRouter();
  const { state, set } = useUrlState<'tab'>({ tab: 'overview' });
  const q = useApiQuery(projectEndpoints.get, { params: { workspaceId: workspace.id, projectId } });
  const [pending, setPending] = useState<Transition | null>(null);
  const [reason, setReason] = useState('');
  const [transferOpen, setTransferOpen] = useState(false);
  const [targetDirection, setTargetDirection] = useState<string | null>(null);
  const [blockers, setBlockers] = useState<{ label: string; count: number; resolution?: string }[] | null>(null);
  const transition = useApiMutation(projectEndpoints.transition, { invalidate: ['projects.'], silentErrors: true });
  const transfer = useApiMutation(projectEndpoints.transferDirection, { invalidate: ['projects.'], successMessage: 'Project moved to the new direction' });
  const preview = useApiQuery(projectEndpoints.archivePreview, { params: { workspaceId: workspace.id, projectId } }, { enabled: !!pending && (pending.target === 'completed' || pending.target === 'archived') });

  return (
    <QueryState query={q}>
      {q.data ? (
        (() => {
          const p = q.data;
          const tabs = PROJECT_TABS.filter((t) => !t.visible || t.visible(p, can));
          const active = tabs.find((t) => t.key === state.tab) ?? tabs[0];
          const moves = transitionsFor(p);
          const menu: MenuItem[] = [
            ...moves.map((m) => ({ label: m.label, destructive: m.destructive, onSelect: () => { setReason(''); setBlockers(null); setPending(m); }, hidden: m.target === 'archived' ? !p.permissions.archive : !p.permissions.update })),
            { label: 'Transfer Direction', icon: <ArrowsLeftRight size={14} />, onSelect: () => setTransferOpen(true), hidden: !p.permissions.update, separatorBefore: true },
          ];
          return (
            <div className="flex flex-col gap-5">
              <PageHeader
                crumbs={[{ label: 'Projects', href: wsPath('/projects') }, { label: p.name }]}
                title={
                  <span className="flex items-center gap-3">
                    {p.coverUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={p.coverUrl} alt="" width={72} height={72} className="hidden h-[72px] w-[72px] rounded-[12px] object-cover sm:block" />
                    ) : null}
                    <span>{p.name}</span>
                  </span>
                }
                meta={
                  <>
                    <StatusBadge status={p.status} />
                    <Badge>{label('projectType', p.type)}</Badge>
                    <Badge>{p.direction.name}</Badge>
                    {p.ofmEnabled ? <Badge tone="info">OFM</Badge> : null}
                    <span className="flex items-center gap-1.5 text-[13px] text-fg-2">
                      <Avatar name={p.owner.displayName} src={p.owner.avatarUrl} size={24} decorative /> {p.owner.displayName}
                    </span>
                  </>
                }
                actions={
                  <>
                    {p.permissions.update ? (
                      <Button icon={<PencilSimple size={14} />} onClick={() => router.push(wsPath(`/projects/${p.id}/edit`))}>
                        Edit
                      </Button>
                    ) : null}
                    {menu.some((m) => !m.hidden) ? <Menu label="More actions" trigger={<IconButton label="More actions" icon={<DotsThree size={18} weight="bold" />} variant="secondary" />} items={menu} /> : null}
                  </>
                }
              />
              {p.status === 'archived' ? <Banner tone="info">Archived records remain available in historical reports. New production work cannot be added.</Banner> : null}
              <Tabs label="Project sections" value={active?.key ?? 'overview'} onValueChange={(v) => set({ tab: v })} items={tabs.map((t) => ({ value: t.key, label: t.label }))}>
                {tabs.map((t) => (
                  <TabPanel key={t.key} value={t.key}>
                    {t.key === active?.key ? <t.component project={p} /> : null}
                  </TabPanel>
                ))}
              </Tabs>
              <ConfirmDialog
                open={!!pending}
                onOpenChange={(o) => !o && setPending(null)}
                title={pending ? `${pending.label} project?` : ''}
                confirmLabel={pending?.label ?? 'Confirm'}
                destructive={pending?.destructive}
                loading={transition.isPending}
                confirmDisabled={(pending?.needsReason && reason.trim().length < 3) || (preview.data?.items.some((i) => i.blocking) ?? false)}
                body={
                  pending?.target === 'archived'
                    ? 'Archived records remain available in historical reports. Finance corrections and historical metrics can still be recorded by authorised members.'
                    : pending?.target === 'completed'
                      ? 'Completing requires that no blocking work remains.'
                      : 'The status change is recorded in the project history.'
                }
                onConfirm={async () => {
                  if (!pending) return;
                  try {
                    await transition.run({ params: { workspaceId: workspace.id, projectId: p.id }, body: { targetState: pending.target, reason: reason.trim() || undefined } }, { ifMatch: p.rowVersion });
                    toast.success(`Project is now ${pending.target}`);
                    setPending(null);
                  } catch (e) {
                    if (isApiError(e) && Array.isArray(e.details?.items)) setBlockers(e.details!.items as never);
                    else toast.error(isApiError(e) ? e.message : 'The status could not be changed.');
                  }
                }}
              >
                {preview.data && preview.data.items.length ? (
                  <ul className="flex flex-col gap-1 rounded-[8px] bg-surface-2 p-3 text-[13px]">
                    {preview.data.items.map((i) => (
                      <li key={i.kind} className={i.blocking ? 'text-danger' : 'text-fg-2'}>
                        {i.blocking ? 'Blocking' : 'Note'}: {i.label} — {i.count}
                        {i.resolution ? ` (${i.resolution})` : ''}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {blockers ? (
                  <Banner tone="danger">
                    {blockers.map((b) => `${b.label}: ${b.count}`).join(' · ')}
                  </Banner>
                ) : null}
                {pending?.needsReason ? (
                  <Field label="Reason" required>
                    <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} />
                  </Field>
                ) : null}
              </ConfirmDialog>
              <ConfirmDialog
                open={transferOpen}
                onOpenChange={setTransferOpen}
                title="Transfer to another direction"
                body="Access that depends on the direction changes immediately. Historical production reports keep the direction at the time of each event."
                confirmLabel="Transfer"
                loading={transfer.isPending}
                confirmDisabled={!targetDirection || targetDirection === p.direction.id || reason.trim().length < 3}
                onConfirm={async () => {
                  await transfer.run({ params: { workspaceId: workspace.id, projectId: p.id }, body: { directionId: targetDirection!, reason } }, { ifMatch: p.rowVersion });
                  setTransferOpen(false);
                  setReason('');
                }}
              >
                <Field label="New direction" required>
                  <DirectionSelect value={targetDirection} onChange={setTargetDirection} />
                </Field>
                <Field label="Reason" required>
                  <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} />
                </Field>
              </ConfirmDialog>
            </div>
          );
        })()
      ) : null}
    </QueryState>
  );
};
