'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CalendarPlus, GearSix, UserPlus, Warning } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { ofmEndpoints as E, type OfmOverview, type OfmProfileRow } from '@castlane/api-contracts';
import { CONTACT_STAGES, DateTime } from '@castlane/domain';
import {
  Avatar,
  Banner,
  Button,
  Dialog,
  EmptyState,
  Field,
  Input,
  KpiStrip,
  PageHeader,
  PermissionDenied,
  Panel,
  Select,
  Switch,
  formatDateTime,
  formatMoney,
} from '@castlane/ui';
import { ConflictDialog } from '@/components/common/conflict';
import { MemberSelect } from '@/components/common/pickers';
import { QueryState } from '@/components/common/query-state';
import { useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';
import { isApiError } from '@castlane/api-client';
import { AccountChip, MemberChip, OfmNav, TIME_ZONE_NOTE, errorMessage, useOfmMutation } from './common';
import { OfmModelSelect } from './pickers';

const PERIODS = [
  { value: '1', label: 'Last 24 hours' },
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
];

const ATTENTION_HREF: Record<OfmOverview['attention'][number]['entityType'], (id: string) => string> = {
  shift: (id) => `/ofm/shifts/${id}`,
  handover: (id) => `/ofm/handovers?open=${id}`,
  quality_review: (id) => `/ofm/quality?open=${id}`,
  operation: (id) => `/ofm/operations?open=${id}`,
  swap: () => `/ofm/shifts?view=list`,
};

/** S40 OFM Overview: KPIs from real records within scope; unknown values are labelled, never zero. */
export const OfmOverviewScreen = () => {
  const { workspace, user } = useWorkspace();
  const can = useCan();
  const wsPath = useWsPath();
  const router = useRouter();
  const { state, set } = useUrlState<'days' | 'projectId'>({ days: '7' });
  const [now] = useState(() => new Date());
  const days = Number(state.days ?? '7');
  const query = { projectId: state.projectId, from: new Date(now.getTime() - days * 86_400_000).toISOString(), to: now.toISOString() };
  const overview = can('ofm.overview.read');
  const q = useApiQuery(E.overview, { params: { workspaceId: workspace.id }, query }, { enabled: overview });
  // Members who only work their own shifts land on their schedule instead of a denied overview.
  useEffect(() => {
    if (!overview && can(['shifts.read.own', 'shifts.read.scope'])) router.replace(wsPath('/ofm/shifts'));
  }, [overview, can, router, wsPath]);
  const [editing, setEditing] = useState<OfmProfileRow | null>(null);
  if (!overview) return can(['shifts.read.own', 'shifts.read.scope']) ? null : <PermissionDenied />;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="OFM"
        description="Operations of the models your team serves: assignments, shifts, handovers, contacts and quality. Active means a CRM shift timer is running, not that anyone is online on a platform."
        actions={
          <>
            {can('shifts.schedule') ? (
              <Button variant="primary" icon={<CalendarPlus size={14} />} onClick={() => router.push(wsPath('/ofm/shifts?schedule=1'))}>
                Schedule Shift
              </Button>
            ) : null}
            {can('ofm.assignments.manage') ? (
              <Button icon={<UserPlus size={14} />} onClick={() => router.push(wsPath('/ofm/assignments?create=1'))}>
                Assign Manager
              </Button>
            ) : null}
          </>
        }
      />
      <OfmNav />
      <div className="flex flex-wrap items-center gap-2">
        <div className="w-[180px]">
          <Select aria-label="Period" value={state.days ?? '7'} onChange={(v) => set({ days: v })} options={PERIODS} />
        </div>
        <div className="w-[220px]">
          <OfmModelSelect aria-label="Model" placeholder="All models" value={state.projectId} onChange={(v) => set({ projectId: v })} clearable />
        </div>
      </div>
      <QueryState query={q}>
        {q.data ? (
          <>
            <KpiStrip
              items={[
                { label: 'Assigned Models', value: q.data.kpis.assignedModels, hint: 'Models with OFM in your scope' },
                { label: 'Active Shifts', value: q.data.kpis.activeShifts, hint: 'CRM timers running now', href: wsPath('/ofm/shifts?view=list&range=all&state=active,paused') },
                {
                  label: 'Missing Handover',
                  value: q.data.kpis.missingHandover.requiredShifts ? q.data.kpis.missingHandover.count : 'Not applicable',
                  hint: `${q.data.kpis.missingHandover.requiredShifts} ended shift(s) required a handover`,
                  href: wsPath('/ofm/handovers?box=unacknowledged'),
                },
                { label: 'Reports to Review', value: q.data.kpis.reportsToReview, href: wsPath('/ofm/shifts?view=list&range=all&reportState=submitted') },
              ]}
            />
            <KpiStrip
              items={[
                { label: 'Open Follow-ups', value: q.data.kpis.openFollowUps, href: wsPath('/ofm/operations?type=follow_up&status=open,in_progress,waiting') },
                {
                  label: 'Net Shift Hours',
                  value: q.data.kpis.netHours.value ?? 'No data recorded',
                  hint: `${q.data.kpis.netHours.endedShifts} ended · ${q.data.kpis.netHours.pendingShifts} pending (no end yet)`,
                },
                {
                  label: 'Handover Completion',
                  value: q.data.kpis.handoverCompletion.percent === null ? 'Not applicable' : `${q.data.kpis.handoverCompletion.percent}%`,
                  hint: `${q.data.kpis.handoverCompletion.acknowledged} of ${q.data.kpis.handoverCompletion.required} acknowledged`,
                },
                {
                  label: 'Quality Score',
                  value: q.data.kpis.quality.average === null ? 'No Score' : `${q.data.kpis.quality.average}%`,
                  hint: `${q.data.kpis.quality.sample} scored review(s)${q.data.kpis.quality.noScore ? ` · ${q.data.kpis.quality.noScore} without score` : ''}`,
                  href: wsPath('/ofm/quality'),
                },
              ]}
            />
            {q.data.revenue ? (
              <Panel title="Revenue" description={q.data.revenue.source}>
                <div className="flex flex-wrap gap-8">
                  <div>
                    <p className="text-[12px] font-[550] text-fg-2">Confirmed (posted)</p>
                    {q.data.revenue.confirmed.length ? (
                      q.data.revenue.confirmed.map((m) => (
                        <p key={m.currency} className="font-mono text-[20px] tabular-nums text-fg">
                          {formatMoney(m.amount, m.currency)}
                        </p>
                      ))
                    ) : (
                      <p className="text-[14px] text-fg-2">No data recorded for this period.</p>
                    )}
                  </div>
                  <div>
                    <p className="text-[12px] font-[550] text-fg-2">Pending Verification ({q.data.revenue.pendingVerification.count})</p>
                    {q.data.revenue.pendingVerification.amounts.map((m) => (
                      <p key={m.currency} className="font-mono text-[16px] tabular-nums text-fg-2">
                        {formatMoney(m.amount, m.currency)}
                      </p>
                    ))}
                  </div>
                </div>
              </Panel>
            ) : null}
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
              <Panel title="Models" className="xl:col-span-7" bodyClassName="p-0">
                {q.data.models.length === 0 ? (
                  <div className="p-4">
                    <EmptyState
                      title="No OFM models in your scope"
                      description={
                        can('projects.update')
                          ? 'Enable OFM on a Model or Influencer project to start assigning managers and scheduling shifts.'
                          : 'OFM models appear here once you are assigned to one. Ask your supervisor for access.'
                      }
                      action={can('projects.update') ? <Button onClick={() => router.push(wsPath('/projects?type=model,influencer'))}>Open Projects</Button> : undefined}
                    />
                  </div>
                ) : (
                  <ul className="divide-y divide-line">
                    {q.data.models.map((m) => (
                      <li key={m.projectId} className="flex flex-col gap-3 p-4 md:flex-row md:items-center">
                        <div className="flex min-w-0 flex-1 items-center gap-3">
                          <Avatar name={m.project.name} src={m.project.coverUrl} size={40} decorative />
                          <div className="min-w-0">
                            <Link href={wsPath(`/projects/${m.projectId}?tab=operations`)} className="font-semibold text-fg hover:underline">
                              {m.project.name}
                            </Link>
                            <p className="truncate text-[12px] text-fg-2">
                              {m.accounts.length} account(s) · {m.managers.length} manager(s) · {m.activeShifts} active · {m.scheduledNext7Days} scheduled next 7 days
                            </p>
                            <div className="mt-1 flex flex-wrap gap-2 text-[12px] text-fg-2">
                              {m.accounts.slice(0, 4).map((a) => (
                                <AccountChip key={a.id} account={a} />
                              ))}
                            </div>
                          </div>
                        </div>
                        <div className="flex shrink-0 flex-wrap items-center gap-2">
                          <span className="text-[12px] text-fg-2">
                            Supervisor: <MemberChip member={m.supervisor} />
                          </span>
                          <Button size="sm" onClick={() => router.push(wsPath(`/projects/${m.projectId}?tab=operations`))}>
                            Open Model Operations
                          </Button>
                          {m.permissions.update ? (
                            <Button size="sm" variant="ghost" icon={<GearSix size={14} />} onClick={() => setEditing(m)} aria-label={`OFM settings for ${m.project.name}`}>
                              Settings
                            </Button>
                          ) : null}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>
              <Panel title="Needs Attention" className="xl:col-span-5" bodyClassName="p-0">
                {q.data.attention.length === 0 ? (
                  <p className="p-4 text-[14px] text-fg-2">Nothing needs attention in your scope right now.</p>
                ) : (
                  <ul className="divide-y divide-line">
                    {q.data.attention.map((a) => (
                      <li key={`${a.kind}-${a.entityId}`}>
                        <Link href={wsPath(ATTENTION_HREF[a.entityType](a.entityId))} className="flex items-start gap-3 px-4 py-3 hover:bg-surface-2">
                          <Warning size={16} className="mt-0.5 shrink-0 text-warning" aria-hidden />
                          <span className="min-w-0 flex-1">
                            <span className="block text-[14px] text-fg">{a.title}</span>
                            <span className="block text-[12px] text-fg-2">
                              {a.member ? `${a.member.displayName} · ` : ''}
                              {a.at ? formatDateTime(a.at, user.timezone) : ''}
                            </span>
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>
            </div>
            <p className="text-[12px] text-fg-muted">
              {TIME_ZONE_NOTE} Period {DateTime.fromISO(q.data.period.from).setZone(user.timezone).toFormat('d LLL HH:mm')} – {DateTime.fromISO(q.data.period.to).setZone(user.timezone).toFormat('d LLL HH:mm')} ({user.timezone}).
            </p>
          </>
        ) : null}
      </QueryState>
      {editing ? <ProfileDialog profile={editing} onClose={() => setEditing(null)} /> : null}
    </div>
  );
};

/** OFM profile settings of one model: supervisor, handover default and contact stage labels. */
export const ProfileDialog = ({ profile, onClose }: { profile: OfmProfileRow; onClose: () => void }) => {
  const { workspace } = useWorkspace();
  const [supervisor, setSupervisor] = useState<string | null>(profile.supervisor?.membershipId ?? null);
  const [handover, setHandover] = useState(profile.settings.handoverRequired);
  const [labels, setLabels] = useState<Record<string, string>>(profile.settings.contactStageLabels);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const m = useOfmMutation(E.updateProfile, { successMessage: 'OFM settings saved', silentErrors: true });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`OFM settings · ${profile.project.name}`}
      description="The model stays one project; these settings only shape its OFM operations."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={m.isPending}
            onClick={async () => {
              setError(null);
              try {
                await m.run(
                  {
                    params: { workspaceId: workspace.id, projectId: profile.projectId },
                    body: {
                      supervisorMembershipId: supervisor,
                      handoverRequired: handover,
                      contactStageLabels: Object.fromEntries(Object.entries(labels).filter(([, v]) => v.trim().length >= 2).map(([k, v]) => [k, v.trim()])),
                    },
                  },
                  { ifMatch: profile.rowVersion },
                );
                onClose();
              } catch (e) {
                if (isApiError(e) && e.code === 'VERSION_CONFLICT') setConflict(true);
                else setError(errorMessage(e));
              }
            }}
          >
            Save Settings
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <Field label="OFM Supervisor" helper="Receives reports to review, handovers without a next shift and alerts.">
          <MemberSelect value={supervisor} onChange={setSupervisor} clearable projectId={profile.projectId} permission="shifts.approve" />
        </Field>
        <Switch label="Handover required by default" description="New assignments require a handover or an explicit No Open Items at report submission." checked={handover} onCheckedChange={setHandover} />
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-[12px] font-[550] text-fg">Contact stage labels</legend>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {CONTACT_STAGES.map((s) => (
              <Field key={s} label={label('contactStage', s)}>
                <Input value={labels[s] ?? ''} maxLength={40} onChange={(e) => setLabels((x) => ({ ...x, [s]: e.target.value }))} />
              </Field>
            ))}
          </div>
        </fieldset>
      </div>
      <ConflictDialog open={conflict} onOpenChange={setConflict} onReload={() => window.location.reload()} />
    </Dialog>
  );
};
