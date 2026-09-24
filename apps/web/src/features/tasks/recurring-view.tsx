'use client';
import { Pause, Play, Plus, Repeat } from '@phosphor-icons/react';
import { useEffect, useMemo, useState } from 'react';
import { recurrenceEndpoints, type RecurrenceRuleView } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { LIMITS, MONTH_DAY_POLICIES, RECURRENCE_CADENCES, RECURRENCE_MODES, TASK_PRIORITIES } from '@castlane/domain';
import {
  Badge,
  Banner,
  Button,
  Checkbox,
  ConfirmDialog,
  DataTable,
  DateInput,
  Drawer,
  EmptyState,
  Field,
  Input,
  Menu,
  IconButton,
  MultiSelect,
  RadioGroup,
  Select,
  StatusBadge,
  Textarea,
  formatDate,
  formatDateTime,
  type Column,
} from '@castlane/ui';
import { EntitySelect } from '@/components/common/entity-select';
import { MemberSelect } from '@/components/common/pickers';
import { QueryState } from '@/components/common/query-state';
import { useDebounced } from '@/components/common/use-debounced';
import { useApiMutation, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useCan, useWorkspace } from '@/lib/workspace-context';
import { DotsThree } from '@phosphor-icons/react';
import { timezones, todayIn } from './format';

const WEEKDAYS = [
  { value: '1', label: 'Monday' },
  { value: '2', label: 'Tuesday' },
  { value: '3', label: 'Wednesday' },
  { value: '4', label: 'Thursday' },
  { value: '5', label: 'Friday' },
  { value: '6', label: 'Saturday' },
  { value: '7', label: 'Sunday' },
];

const INVALIDATE = ['recurrences.', 'tasks.', 'myWork.', 'workload.'];

interface RuleDraft {
  projectId: string | null;
  title: string;
  description: string;
  assignee: string | null;
  reviewer: string | null;
  priority: string;
  estimate: string;
  cadence: RecurrenceRuleView['cadence'];
  intervalCount: string;
  weekdays: string[];
  monthDay: string;
  monthDayPolicy: RecurrenceRuleView['monthDayPolicy'];
  localTime: string;
  timezone: string;
  mode: RecurrenceRuleView['mode'];
  startsOn: string;
  endsOn: string;
  horizonDays: string;
  backfillLimit: string;
}

const draftOf = (r: RecurrenceRuleView | null, tz: string, projectId?: string): RuleDraft =>
  r
    ? {
        projectId: r.project.id,
        title: r.template.title,
        description: r.template.description ?? '',
        assignee: r.template.assignee?.membershipId ?? null,
        reviewer: r.template.reviewer?.membershipId ?? null,
        priority: r.template.priority ?? 'normal',
        estimate: r.template.estimateMinutes ? String(r.template.estimateMinutes) : '',
        cadence: r.cadence,
        intervalCount: String(r.intervalCount),
        weekdays: r.weekdays.map(String),
        monthDay: r.monthDay ? String(r.monthDay) : '',
        monthDayPolicy: r.monthDayPolicy,
        localTime: r.localTime,
        timezone: r.timezone,
        mode: r.mode,
        startsOn: r.startsOn,
        endsOn: r.endsOn ?? '',
        horizonDays: String(r.horizonDays),
        backfillLimit: String(r.backfillLimit),
      }
    : {
        projectId: projectId ?? null,
        title: '',
        description: '',
        assignee: null,
        reviewer: null,
        priority: 'normal',
        estimate: '',
        cadence: 'weekly',
        intervalCount: '1',
        weekdays: [],
        monthDay: '',
        monthDayPolicy: 'last_day_of_month',
        localTime: '09:00',
        timezone: tz,
        mode: 'fixed_schedule',
        startsOn: todayIn(tz),
        endsOn: '',
        horizonDays: '30',
        backfillLimit: '0',
      };

const schedule = (d: RuleDraft) => ({
  cadence: d.cadence,
  intervalCount: Math.max(1, Number(d.intervalCount) || 1),
  weekdays: d.cadence === 'weekly' ? d.weekdays.map(Number) : [],
  monthDay: d.cadence === 'monthly' && d.monthDay ? Number(d.monthDay) : null,
  monthDayPolicy: d.monthDayPolicy,
  localTime: d.localTime,
  timezone: d.timezone,
  mode: d.mode,
  startsOn: d.startsOn,
  endsOn: d.endsOn || null,
  horizonDays: Math.min(30, Math.max(1, Number(d.horizonDays) || 30)),
  backfillLimit: Math.min(30, Math.max(0, Number(d.backfillLimit) || 0)),
});

const template = (d: RuleDraft) => ({
  title: d.title.trim(),
  description: d.description.trim() || null,
  assigneeMembershipId: d.assignee,
  reviewerMembershipId: d.reviewer,
  priority: d.priority as 'normal',
  estimateMinutes: d.estimate ? Number(d.estimate) : null,
});

/** Create or edit a recurring rule with a live calendar preview; edits show the diff on future instances first. */
const RuleDrawer = ({ open, onOpenChange, rule, projectId }: { open: boolean; onOpenChange: (o: boolean) => void; rule: RecurrenceRuleView | null; projectId?: string }) => {
  const { workspace, user } = useWorkspace();
  const [d, setD] = useState<RuleDraft>(draftOf(rule, user.timezone, projectId));
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (open) {
      setD(draftOf(rule, user.timezone, projectId));
      setError(null);
      setDirty(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const upd = (p: Partial<RuleDraft>) => {
    setD((x) => ({ ...x, ...p }));
    setDirty(true);
  };
  const sched = schedule(d);
  const debounced = useDebounced(JSON.stringify(sched), 400);
  const previewMut = useApiMutation(recurrenceEndpoints.preview, { silentErrors: true });
  useEffect(() => {
    if (!open || !d.startsOn || !/^\d\d:\d\d$/.test(d.localTime)) return;
    void previewMut.run({ params: { workspaceId: workspace.id }, body: JSON.parse(debounced) }).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced, open]);
  const diff = useApiMutation(recurrenceEndpoints.changePreview, { silentErrors: true });
  const create = useApiMutation(recurrenceEndpoints.create, { invalidate: INVALIDATE, successMessage: 'Recurring task created', silentErrors: true });
  const update = useApiMutation(recurrenceEndpoints.update, { invalidate: INVALIDATE, successMessage: 'Recurring task updated', silentErrors: true });
  const tzOptions = useMemo(() => timezones().map((z) => ({ value: z, label: z })), []);
  const valid = d.projectId && d.title.trim().length >= 3 && d.startsOn && /^\d\d:\d\d$/.test(d.localTime);
  const submit = async () => {
    setError(null);
    try {
      if (rule) {
        if (!diff.data) {
          await diff.run({ params: { workspaceId: workspace.id, ruleId: rule.id }, body: { ...sched, template: template(d) } });
          return;
        }
        await update.run({ params: { workspaceId: workspace.id, ruleId: rule.id }, body: { ...sched, template: template(d) } }, { ifMatch: rule.rowVersion });
      } else await create.run({ params: { workspaceId: workspace.id }, body: { ...sched, projectId: d.projectId!, template: template(d) } });
      onOpenChange(false);
    } catch (e) {
      setError(isApiError(e) ? (e.fieldErrors[0]?.message ?? e.message) : 'The rule was not saved.');
    }
  };
  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      width={760}
      dirty={dirty}
      title={rule ? 'Edit Recurring Task' : 'New Recurring Task'}
      description="Occurrences are created as tasks up to the horizon ahead; each date is created once."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={!valid} loading={create.isPending || update.isPending || diff.isPending} onClick={() => void submit()}>
            {rule ? (diff.data ? 'Apply Changes' : 'Review Changes') : 'Create'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        {diff.data ? (
          <Banner tone="info">
            Future not-started tasks: {diff.data.updated.length} updated, {diff.data.cancelled.length} cancelled, {diff.data.created.length} new. {diff.data.startedUnaffected} started task(s) stay unchanged.
          </Banner>
        ) : null}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Project" required>
            <EntitySelect type="project" value={d.projectId} onChange={(v) => upd({ projectId: v })} disabled={!!rule || !!projectId} />
          </Field>
          <Field label="Task title" required>
            <Input value={d.title} onChange={(e) => { upd({ title: e.target.value }); diff.reset(); }} maxLength={200} />
          </Field>
          <Field label="Assignee">
            <MemberSelect value={d.assignee} onChange={(v) => { upd({ assignee: v }); diff.reset(); }} projectId={d.projectId ?? undefined} permission="tasks.read" clearable placeholder="Unassigned" />
          </Field>
          <Field label="Reviewer">
            <MemberSelect value={d.reviewer} onChange={(v) => { upd({ reviewer: v }); diff.reset(); }} projectId={d.projectId ?? undefined} permission="tasks.read" clearable placeholder="No review" />
          </Field>
          <Field label="Priority">
            <Select value={d.priority} onChange={(v) => { upd({ priority: v ?? 'normal' }); diff.reset(); }} options={TASK_PRIORITIES.map((p) => ({ value: p, label: label('taskPriority', p) }))} />
          </Field>
          <Field label="Estimate (minutes)" helper="Leave empty when unknown.">
            <Input value={d.estimate} onChange={(e) => { upd({ estimate: e.target.value.replace(/\D/g, '') }); diff.reset(); }} inputMode="numeric" />
          </Field>
        </div>
        <Field label="Description">
          <Textarea value={d.description} onChange={(e) => { upd({ description: e.target.value }); diff.reset(); }} maxLength={LIMITS.noteMax} className="min-h-[72px]" />
        </Field>
        <fieldset className="flex flex-col gap-4 rounded-[12px] border border-line p-4">
          <legend className="px-1 text-[12px] font-[550] text-fg">Schedule</legend>
          <RadioGroup
            label="Mode"
            orientation="horizontal"
            value={d.mode}
            onValueChange={(v) => { upd({ mode: v }); diff.reset(); }}
            options={RECURRENCE_MODES.map((m) => ({ value: m, label: label('recurrenceMode', m), description: m === 'fixed_schedule' ? 'On a calendar, whatever happens' : 'Next one after the previous is closed' }))}
          />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <Field label="Repeats">
              <Select value={d.cadence} onChange={(v) => { upd({ cadence: (v as RuleDraft['cadence']) ?? 'weekly' }); diff.reset(); }} options={RECURRENCE_CADENCES.map((c) => ({ value: c, label: label('cadence', c) }))} />
            </Field>
            <Field label="Every" helper={d.cadence === 'daily' ? 'days' : d.cadence === 'weekly' ? 'weeks' : 'months'}>
              <Input value={d.intervalCount} onChange={(e) => { upd({ intervalCount: e.target.value.replace(/\D/g, '') }); diff.reset(); }} inputMode="numeric" />
            </Field>
            <Field label="Due at (local time)" helper={d.timezone}>
              <Input type="time" value={d.localTime} onChange={(e) => { upd({ localTime: e.target.value }); diff.reset(); }} />
            </Field>
            {d.cadence === 'weekly' ? (
              <Field label="On" className="md:col-span-2">
                <MultiSelect value={d.weekdays} onChange={(v) => { upd({ weekdays: v }); diff.reset(); }} options={WEEKDAYS} placeholder="Weekday of the start date" />
              </Field>
            ) : null}
            {d.cadence === 'monthly' ? (
              <>
                <Field label="Day of month">
                  <Input value={d.monthDay} onChange={(e) => { upd({ monthDay: e.target.value.replace(/\D/g, '') }); diff.reset(); }} inputMode="numeric" placeholder="Day of the start date" />
                </Field>
                <Field label="When the month is shorter">
                  <Select value={d.monthDayPolicy} onChange={(v) => { upd({ monthDayPolicy: (v as RuleDraft['monthDayPolicy']) ?? 'last_day_of_month' }); diff.reset(); }} options={MONTH_DAY_POLICIES.map((p) => ({ value: p, label: label('monthDayPolicy', p) }))} />
                </Field>
              </>
            ) : null}
            <Field label="Time zone">
              <Select value={d.timezone} onChange={(v) => { upd({ timezone: v ?? user.timezone }); diff.reset(); }} options={tzOptions} searchable />
            </Field>
            <Field label="Starts on" required>
              <DateInput value={d.startsOn} onChange={(e) => { upd({ startsOn: e.target.value }); diff.reset(); }} />
            </Field>
            <Field label="Ends on">
              <DateInput value={d.endsOn} onChange={(e) => { upd({ endsOn: e.target.value }); diff.reset(); }} />
            </Field>
            {d.mode === 'fixed_schedule' ? (
              <>
                <Field label="Create ahead (days)" helper="1–30">
                  <Input value={d.horizonDays} onChange={(e) => { upd({ horizonDays: e.target.value.replace(/\D/g, '') }); diff.reset(); }} inputMode="numeric" />
                </Field>
                <Field label="After an outage, create up to" helper="0 = one overdue task plus the list of missed dates">
                  <Input value={d.backfillLimit} onChange={(e) => { upd({ backfillLimit: e.target.value.replace(/\D/g, '') }); diff.reset(); }} inputMode="numeric" />
                </Field>
              </>
            ) : null}
          </div>
        </fieldset>
        <div>
          <h3 className="text-[12px] font-[550] text-fg-2">Next occurrences</h3>
          {previewMut.data ? (
            <ul className="mt-1 grid grid-cols-1 gap-1 text-[13px] sm:grid-cols-2">
              {previewMut.data.occurrences.slice(0, 8).map((o) => (
                <li key={o.key} className="text-fg">
                  {formatDateTime(o.scheduledFor, user.timezone)}
                  {o.clampedToMonthEnd ? <Badge className="ml-2">Last day of month</Badge> : null}
                  {o.dstShifted ? <Badge className="ml-2" tone="warning">Shifted by DST</Badge> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-[13px] text-fg-2">{previewMut.isError ? 'Check the schedule fields.' : 'Calculating…'}</p>
          )}
        </div>
      </div>
    </Drawer>
  );
};

/** Recurring task rules (in the Tasks screen and the project Tasks tab). */
export const RecurringView = ({ projectId }: { projectId?: string }) => {
  const { workspace, user } = useWorkspace();
  const can = useCan();
  const q = useApiQuery(recurrenceEndpoints.list, { params: { workspaceId: workspace.id }, query: { projectId } });
  const [editing, setEditing] = useState<RecurrenceRuleView | null>(null);
  const [open, setOpen] = useState(false);
  const [archiving, setArchiving] = useState<RecurrenceRuleView | null>(null);
  const [cancelFuture, setCancelFuture] = useState(false);
  const setActive = useApiMutation(recurrenceEndpoints.setActive, { invalidate: INVALIDATE, successMessage: (r) => (r.active ? 'Recurring task resumed' : 'Recurring task paused') });
  const archive = useApiMutation(recurrenceEndpoints.archive, { invalidate: INVALIDATE, successMessage: 'Recurring task archived' });
  const cadenceText = (r: RecurrenceRuleView) => {
    const every = r.intervalCount > 1 ? `Every ${r.intervalCount} ${r.cadence === 'daily' ? 'days' : r.cadence === 'weekly' ? 'weeks' : 'months'}` : label('cadence', r.cadence);
    const on = r.cadence === 'weekly' && r.weekdays.length ? ` on ${r.weekdays.map((w) => WEEKDAYS[w - 1]!.label.slice(0, 3)).join(', ')}` : r.cadence === 'monthly' && r.monthDay ? ` on day ${r.monthDay}` : '';
    return `${every}${on} at ${r.localTime} (${r.timezone})`;
  };
  const columns: Column<RecurrenceRuleView>[] = [
    { key: 'title', header: 'Task', sticky: true, minWidth: 220, cell: (r) => <span className="font-medium">{r.template.title}</span> },
    { key: 'project', header: 'Project', minWidth: 150, hidden: !!projectId, cell: (r) => r.project.name },
    { key: 'schedule', header: 'Schedule', minWidth: 260, cell: (r) => <span>{cadenceText(r)}{r.mode === 'after_completion' ? ' · after completion' : ''}</span> },
    { key: 'assignee', header: 'Assignee', minWidth: 140, cell: (r) => r.template.assignee?.displayName ?? <span className="text-fg-muted">Unassigned</span> },
    { key: 'next', header: 'Next', minWidth: 160, cell: (r) => (r.nextOccurrenceAt ? formatDateTime(r.nextOccurrenceAt, user.timezone) : <span className="text-fg-muted">—</span>) },
    { key: 'state', header: 'State', minWidth: 100, cell: (r) => <StatusBadge status={r.archivedAt ? 'archived' : r.active ? 'active' : 'paused'} /> },
    { key: 'ends', header: 'Ends', minWidth: 110, cell: (r) => (r.endsOn ? formatDate(r.endsOn) : 'Never') },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      headerLabel: 'Actions',
      minWidth: 60,
      align: 'right',
      cell: (r) =>
        r.canManage ? (
          <Menu
            label={`Actions for ${r.template.title}`}
            trigger={<IconButton label={`Actions for ${r.template.title}`} icon={<DotsThree size={18} weight="bold" />} />}
            items={[
              { label: 'Edit', onSelect: () => { setEditing(r); setOpen(true); } },
              { label: r.active ? 'Pause' : 'Resume', icon: r.active ? <Pause size={14} /> : <Play size={14} />, onSelect: () => void setActive.run({ params: { workspaceId: workspace.id, ruleId: r.id }, body: { active: !r.active } }, { ifMatch: r.rowVersion }) },
              { label: 'Archive Rule', destructive: true, separatorBefore: true, onSelect: () => setArchiving(r) },
            ]}
          />
        ) : null,
    },
  ];
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-[760px] text-[13px] text-fg-2">Recurring tasks are created ahead on their schedule. A missed period never floods the list: one overdue task lists the missed dates.</p>
        {can('tasks.create') ? (
          <Button icon={<Plus size={14} />} onClick={() => { setEditing(null); setOpen(true); }}>
            New Recurring Task
          </Button>
        ) : null}
      </div>
      <QueryState query={q}>
        {q.data && q.data.length === 0 ? (
          <EmptyState icon={<Repeat size={28} />} title="No recurring tasks" description="Set up routine work once — daily checks, weekly plans, monthly reports." action={can('tasks.create') ? <Button variant="primary" onClick={() => { setEditing(null); setOpen(true); }}>New Recurring Task</Button> : undefined} />
        ) : (
          <DataTable caption="Recurring tasks" rows={q.data ?? []} columns={columns} getRowId={(r) => r.id} density={user.density} />
        )}
      </QueryState>
      <RuleDrawer open={open} onOpenChange={setOpen} rule={editing} projectId={projectId} />
      <ConfirmDialog
        open={!!archiving}
        onOpenChange={(o) => !o && setArchiving(null)}
        title="Archive recurring task?"
        body="No new occurrences are created. Tasks already created stay unless you cancel the future ones that have not started."
        confirmLabel="Archive Rule"
        destructive
        loading={archive.isPending}
        onConfirm={async () => {
          await archive.run({ params: { workspaceId: workspace.id, ruleId: archiving!.id }, body: { cancelFutureInstances: cancelFuture } }, { ifMatch: archiving!.rowVersion });
          setArchiving(null);
          setCancelFuture(false);
        }}
      >
        <Checkbox checked={cancelFuture} onCheckedChange={setCancelFuture} label="Cancel future tasks that have not started" />
      </ConfirmDialog>
    </div>
  );
};
