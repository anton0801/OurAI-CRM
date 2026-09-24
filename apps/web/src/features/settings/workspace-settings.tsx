'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { EnvelopeSimple, Warning } from '@phosphor-icons/react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  HIDEABLE_MODULES,
  SETTINGS_BOUNDS,
  settingsEndpoints,
  type SettingsImpact,
  type WorkspaceSettingsPatch,
  type WorkspaceSettingsView,
} from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { SUPPORTED_CURRENCIES, WEEKDAYS } from '@castlane/domain';
import {
  Badge,
  Banner,
  Button,
  Checkbox,
  ConfirmDialog,
  DescriptionList,
  Dialog,
  Field,
  Input,
  MultiSelect,
  PageHeader,
  Panel,
  Select,
  Switch,
  formatBytes,
  formatDateTime,
  humanize,
} from '@castlane/ui';
import { ConflictDialog } from '@/components/common/conflict';
import { QueryState } from '@/components/common/query-state';
import { FileUploader } from '@/components/media/file-uploader';
import { useApiMutation, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUnsavedChangesGuard } from '@/lib/unsaved';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';
import '@/features/team/labels';
import { reportError, useRecentAuth } from '@/features/team/recent-auth';
import { timeZoneList } from '@/lib/timezones';

type View = WorkspaceSettingsView;
type GroupKey = 'workingTime' | 'metrics' | 'files' | 'retention' | 'security' | 'notifications' | 'modules';
type General = { name: string; timezone: string; baseCurrency: string; weekStartsOn: 'monday' | 'sunday'; logoAssetId: string | null };
type Draft = { general: General } & Pick<View, 'workingTime' | 'metrics' | 'retention' | 'security' | 'notifications' | 'modules'> & { files: { quotaBytes: string } };

const GROUPS: GroupKey[] = ['workingTime', 'metrics', 'files', 'retention', 'security', 'notifications', 'modules'];
const GB = 1024 ** 3;

const zones = timeZoneList;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const draftOf = (v: View): Draft => ({
  general: { name: v.general.name, timezone: v.general.timezone, baseCurrency: v.general.baseCurrency, weekStartsOn: v.general.weekStartsOn, logoAssetId: v.general.logoAssetId },
  workingTime: structuredClone(v.workingTime),
  metrics: { ...v.metrics },
  files: { quotaBytes: v.files.quotaBytes },
  retention: { ...v.retention },
  security: { ...v.security, mfaRequiredRoleKeys: [...v.security.mfaRequiredRoleKeys] },
  notifications: { ...v.notifications },
  modules: { hidden: [...v.modules.hidden] },
});

/** Only changed groups are sent; General sends only changed fields. */
const patchOf = (v: View, d: Draft): WorkspaceSettingsPatch => {
  const p: WorkspaceSettingsPatch = {};
  const g: NonNullable<WorkspaceSettingsPatch['general']> = {};
  if (d.general.name.trim() !== v.general.name) g.name = d.general.name.trim();
  if (d.general.timezone !== v.general.timezone) g.timezone = d.general.timezone;
  if (d.general.baseCurrency !== v.general.baseCurrency) g.baseCurrency = d.general.baseCurrency;
  if (d.general.weekStartsOn !== v.general.weekStartsOn) g.weekStartsOn = d.general.weekStartsOn;
  if (d.general.logoAssetId !== v.general.logoAssetId) g.logoAssetId = d.general.logoAssetId;
  if (Object.keys(g).length) p.general = g;
  for (const k of GROUPS) {
    const current = k === 'files' ? { quotaBytes: v.files.quotaBytes } : v[k];
    if (!same(d[k], current)) (p as Record<string, unknown>)[k] = d[k];
  }
  return p;
};

const intError = (n: number, b: { min: number; max: number }) => (Number.isInteger(n) && n >= b.min && n <= b.max ? null : `Enter a whole number from ${b.min} to ${b.max}.`);

const localErrors = (d: Draft): Record<string, string> => {
  const e: Record<string, string> = {};
  const add = (k: string, m: string | null) => {
    if (m) e[k] = m;
  };
  if (d.general.name.trim().length < 2 || d.general.name.trim().length > 80) e['general.name'] = 'Use 2–80 characters.';
  add('security.sessionIdleHours', intError(d.security.sessionIdleHours, SETTINGS_BOUNDS.sessionIdleHours));
  add('security.sessionAbsoluteDays', intError(d.security.sessionAbsoluteDays, SETTINGS_BOUNDS.sessionAbsoluteDays));
  for (const [k, b] of Object.entries(SETTINGS_BOUNDS.retention)) add(`retention.${k}`, intError(d.retention[k as keyof Draft['retention']], b));
  const q = Number(d.files.quotaBytes);
  if (!/^\d+$/.test(d.files.quotaBytes) || q < SETTINGS_BOUNDS.fileQuotaBytes.min || q > SETTINGS_BOUNDS.fileQuotaBytes.max) e['files.quotaBytes'] = 'Enter 1 to 102,400 GB.';
  if (d.workingTime.workingDays.length === 0) e['workingTime.workingDays'] = 'Choose at least one working day.';
  if (d.workingTime.workingHours.start >= d.workingTime.workingHours.end) e['workingTime.workingHours'] = 'The working day must end after it starts.';
  return e;
};

const NumberField = ({ label: l, value, onChange, error, helper, disabled, unit }: { label: string; value: number; onChange: (n: number) => void; error?: string; helper?: string; disabled?: boolean; unit?: string }) => (
  <Field label={unit ? `${l} (${unit})` : l} error={error} helper={helper}>
    <Input type="number" inputMode="numeric" step={1} value={Number.isNaN(value) ? '' : String(value)} onChange={(e) => onChange(e.target.value === '' ? Number.NaN : Number(e.target.value))} disabled={disabled} />
  </Field>
);

const Group = ({
  title,
  description,
  changed,
  onRestore,
  canEdit,
  children,
}: {
  title: string;
  description?: string;
  changed: boolean;
  onRestore?: () => void;
  canEdit: boolean;
  children: ReactNode;
}) => (
  <Panel
    title={title}
    description={description}
    actions={
      <>
        {changed ? <Badge tone="info">Unsaved</Badge> : null}
        {onRestore && canEdit ? (
          <Button size="sm" variant="ghost" onClick={onRestore}>
            Restore Defaults
          </Button>
        ) : null}
      </>
    }
    bodyClassName="flex flex-col gap-4 p-4"
  >
    {children}
  </Panel>
);

/** S67 Workspace Settings: grouped settings saved together after an impact preview (If-Match). */
export const WorkspaceSettingsScreen = () => {
  const { workspace } = useWorkspace();
  const q = useApiQuery(settingsEndpoints.workspace, { params: { workspaceId: workspace.id } });
  return <QueryState query={q}>{q.data ? <SettingsForm view={q.data} refetch={() => q.refetch()} /> : null}</QueryState>;
};

const SettingsForm = ({ view, refetch }: { view: View; refetch: () => Promise<{ data?: View }> }) => {
  const { workspace } = useWorkspace();
  const can = useCan();
  const wsPath = useWsPath();
  const router = useRouter();
  const { guard, dialog } = useRecentAuth();
  // `base` is the version the draft was built on: patches and If-Match use it, so a concurrent
  // save by someone else is reported as a conflict instead of being silently reverted.
  const [base, setBase] = useState<View>(view);
  const [draft, setDraft] = useState<Draft>(() => draftOf(view));
  const [impact, setImpact] = useState<SettingsImpact | null>(null);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const zoneOptions = useMemo(() => zones().map((z) => ({ value: z, label: z })), []);
  const perms = view.permissions;
  const patch = patchOf(base, draft);
  const changedKeys = Object.keys(patch);
  const dirty = changedKeys.length > 0;
  const errors = { ...localErrors(draft), ...serverErrors };
  const hasLocalErrors = Object.keys(localErrors(draft)).length > 0;
  useUnsavedChangesGuard(dirty);
  useEffect(() => {
    // Newer settings arrived (live refresh): adopt them when nothing is being edited.
    if (view.rowVersion !== base.rowVersion && !dirty) {
      setBase(view);
      setDraft(draftOf(view));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);
  /** Keep the member's own edits and re-apply them on top of the newest version. */
  const rebase = (latest: View) => {
    const mine = patchOf(base, draft);
    const next = draftOf(latest);
    if (mine.general) next.general = { ...next.general, ...mine.general } as General;
    for (const k of GROUPS) if (k in mine) (next as Record<string, unknown>)[k] = (mine as Record<string, unknown>)[k];
    setBase(latest);
    setDraft(next);
  };

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    setDraft((d) => ({ ...d, [k]: v }));
    setServerErrors({});
  };
  const restore = (k: GroupKey) => set(k, structuredClone(view.defaults[k]) as Draft[typeof k]);
  const changed = (k: GroupKey) => k in patch;

  const preview = useApiMutation(settingsEndpoints.previewWorkspace, { silentErrors: true });
  const update = useApiMutation(settingsEndpoints.updateWorkspace, { invalidate: ['settings.'], successMessage: 'Settings saved', silentErrors: true });

  const onServerError = (e: unknown) => {
    if (isApiError(e) && e.code === 'VERSION_CONFLICT') {
      setImpact(null);
      setConflict(true);
      return;
    }
    if (isApiError(e) && e.fieldErrors.length) {
      setImpact(null);
      setServerErrors(Object.fromEntries(e.fieldErrors.map((f) => [f.field.replace(/^body\./, ''), f.message])));
      setError('Some settings need attention.');
      return;
    }
    if (isApiError(e)) setError(e.message);
    else reportError(e);
  };

  const review = async () => {
    setError(null);
    try {
      setImpact(await preview.run({ params: { workspaceId: workspace.id }, body: patch }));
    } catch (e) {
      onServerError(e);
    }
  };

  const save = async () => {
    try {
      const saved = await guard(() => update.run({ params: { workspaceId: workspace.id }, body: patch }, { ifMatch: base.rowVersion }));
      setImpact(null);
      setBase(saved);
      setDraft(draftOf(saved));
      setError(null);
      // Name, time zone and navigation visibility live in the server-rendered shell.
      router.refresh();
    } catch (e) {
      onServerError(e);
    }
  };

  const mfaRoleOptions = view.roles.map((r) => ({ value: r.key, label: r.name, description: r.alwaysRequiresMfa ? 'Always requires two-factor' : undefined }));
  const quotaGb = Number(draft.files.quotaBytes) / GB;

  return (
    <div className="flex flex-col gap-5 pb-24">
      <PageHeader
        crumbs={[{ label: 'Settings', href: wsPath('/settings') }, { label: 'Workspace Settings' }]}
        title="Workspace Settings"
        description="Shared working rules. Every change is previewed, saved together and audited. Changing the time zone never rewrites stored timestamps."
        actions={
          <>
            {can('directions.read') ? (
              <Link href={wsPath('/directions')} className="text-[13px] font-semibold text-primary hover:underline">
                Manage Directions
              </Link>
            ) : null}
            {can('backups.status.read') ? (
              <Link href={wsPath('/operations/health?tab=system')} className="text-[13px] font-semibold text-primary hover:underline">
                Open Backup Status
              </Link>
            ) : null}
          </>
        }
      />
      {!perms.update ? <Banner tone="info">You can view these settings. Changing them needs the workspace settings permission.</Banner> : null}
      {error ? <Banner tone="danger">{error}</Banner> : null}

      <Panel title="General" actions={'general' in patch ? <Badge tone="info">Unsaved</Badge> : undefined} bodyClassName="grid grid-cols-1 gap-4 p-4 md:grid-cols-2">
        <Field label="Workspace Name" required error={errors['general.name']}>
          <Input value={draft.general.name} maxLength={80} onChange={(e) => set('general', { ...draft.general, name: e.target.value })} disabled={!perms.update} />
        </Field>
        <Field label="Time Zone" required helper="Used for reports, deadlines and working hours. Existing timestamps are not changed." error={errors['general.timezone']}>
          <Select value={draft.general.timezone} onChange={(v) => v && set('general', { ...draft.general, timezone: v })} options={zoneOptions} searchable disabled={!perms.update} />
        </Field>
        <Field
          label="Base Currency"
          required
          helper={view.general.baseCurrencyLockReason ?? (perms.changeCurrency ? 'Only the Owner can change it, and only before financial records exist.' : 'Only the Owner can change the base currency.')}
          error={errors['general.baseCurrency']}
        >
          <Select
            value={draft.general.baseCurrency}
            onChange={(v) => v && set('general', { ...draft.general, baseCurrency: v })}
            options={SUPPORTED_CURRENCIES.map((c) => ({ value: c, label: c }))}
            searchable
            disabled={!perms.changeCurrency}
          />
        </Field>
        <Field label="Week Starts On" error={errors['general.weekStartsOn']}>
          <Select
            value={draft.general.weekStartsOn}
            onChange={(v) => v && set('general', { ...draft.general, weekStartsOn: v as 'monday' | 'sunday' })}
            options={[
              { value: 'monday', label: 'Monday' },
              { value: 'sunday', label: 'Sunday' },
            ]}
            disabled={!perms.update}
          />
        </Field>
        <div className="flex flex-col gap-2 md:col-span-2">
          <span className="text-[13px] font-medium text-fg">Logo</span>
          <div className="flex flex-wrap items-center gap-4">
            {draft.general.logoAssetId && draft.general.logoAssetId === base.general.logoAssetId && base.general.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={`${base.general.logoUrl}?size=64`} alt={`${base.general.name} logo`} width={64} height={64} className="h-16 w-16 rounded-[12px] border border-line object-cover" />
            ) : draft.general.logoAssetId ? (
              <Badge tone="info">New logo ready — save to apply</Badge>
            ) : (
              <span className="flex h-16 w-16 items-center justify-center rounded-[12px] border border-dashed border-line text-[12px] text-fg-2">No logo</span>
            )}
            {perms.update && draft.general.logoAssetId ? (
              <Button size="sm" variant="ghost" onClick={() => set('general', { ...draft.general, logoAssetId: null })}>
                Remove Logo
              </Button>
            ) : null}
          </div>
          {perms.update && can('assets.upload') ? (
            <FileUploader
              workspaceId={workspace.id}
              purpose="logo"
              accept="image/png,image/jpeg,image/webp"
              multiple={false}
              compact
              label="Upload Logo"
              hint="PNG, JPG or WebP. Shown at 64×64. The file is checked before it can be used."
              onUploaded={(item) => {
                if (item.assetId) set('general', { ...draft.general, logoAssetId: item.assetId });
              }}
            />
          ) : null}
          {errors['general.logoAssetId'] ? <p className="text-[12px] text-danger">{errors['general.logoAssetId']}</p> : null}
        </div>
      </Panel>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <Group title="Working Time" description="Working days and hours used by schedules, reminders and workload." changed={changed('workingTime')} onRestore={() => restore('workingTime')} canEdit={perms.update}>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-[13px] font-medium text-fg">Working Days</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {WEEKDAYS.map((d) => (
                <Checkbox
                  key={d}
                  label={humanize(d)}
                  checked={draft.workingTime.workingDays.includes(d)}
                  disabled={!perms.update}
                  onCheckedChange={(on) =>
                    set('workingTime', {
                      ...draft.workingTime,
                      workingDays: WEEKDAYS.filter((x) => (x === d ? on : draft.workingTime.workingDays.includes(x))),
                    })
                  }
                />
              ))}
            </div>
            {errors['workingTime.workingDays'] ? <p className="text-[12px] text-danger">{errors['workingTime.workingDays']}</p> : null}
          </fieldset>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Day Starts" error={errors['workingTime.workingHours']}>
              <Input type="time" value={draft.workingTime.workingHours.start} onChange={(e) => set('workingTime', { ...draft.workingTime, workingHours: { ...draft.workingTime.workingHours, start: e.target.value } })} disabled={!perms.update} />
            </Field>
            <Field label="Day Ends">
              <Input type="time" value={draft.workingTime.workingHours.end} onChange={(e) => set('workingTime', { ...draft.workingTime, workingHours: { ...draft.workingTime.workingHours, end: e.target.value } })} disabled={!perms.update} />
            </Field>
          </div>
        </Group>

        <Group title="Metric Cadences" description="How often account metrics are expected." changed={changed('metrics')} onRestore={() => restore('metrics')} canEdit={perms.update}>
          <Field label="Default Account Cadence">
            <Select
              value={draft.metrics.accountDefaultCadence}
              onChange={(v) => v && set('metrics', { ...draft.metrics, accountDefaultCadence: v as Draft['metrics']['accountDefaultCadence'] })}
              options={[
                { value: 'daily', label: 'Daily' },
                { value: 'weekly', label: 'Weekly' },
                { value: 'monthly', label: 'Monthly' },
              ]}
              disabled={!perms.update}
            />
          </Field>
          <Switch checked={draft.metrics.followerSnapshotDaily} onCheckedChange={(v) => set('metrics', { ...draft.metrics, followerSnapshotDaily: v })} label="Daily follower snapshot" description="Expect a follower count every day in addition to the cadence." disabled={!perms.update} />
        </Group>

        <Group title="Files" description="Lowering the quota never deletes files; new uploads stop when it is reached." changed={changed('files')} onRestore={perms.manageQuota ? () => restore('files') : undefined} canEdit={perms.update}>
          <DescriptionList
            columns={2}
            items={[
              { label: 'Used', value: formatBytes(Number(view.files.usedBytes)) },
              { label: 'Reserved by uploads in progress', value: formatBytes(Number(view.files.reservedBytes)) },
            ]}
          />
          <Field label="Quota (GB)" error={errors['files.quotaBytes']} helper={perms.manageQuota ? '1 GB to 100 TB.' : 'Only the Owner can change the quota.'}>
            <Input
              type="number"
              inputMode="numeric"
              step={1}
              min={1}
              value={Number.isFinite(quotaGb) ? String(Math.round(quotaGb * 100) / 100) : ''}
              onChange={(e) => {
                const gb = Number(e.target.value);
                set('files', { quotaBytes: e.target.value === '' || !Number.isFinite(gb) ? '' : String(Math.round(gb * GB)) });
              }}
              disabled={!perms.manageQuota}
            />
          </Field>
        </Group>

        <Group title="Retention" description="How long records stay before automatic clean-up." changed={changed('retention')} onRestore={perms.manageRetention ? () => restore('retention') : undefined} canEdit={perms.update}>
          {!perms.manageRetention ? <p className="text-[12px] text-fg-2">Changing retention needs the retention permission.</p> : null}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <NumberField label="Trash" unit="days" value={draft.retention.trashDays} onChange={(n) => set('retention', { ...draft.retention, trashDays: n })} error={errors['retention.trashDays']} disabled={!perms.manageRetention} />
            <NumberField label="Audit Log" unit="months" value={draft.retention.auditMonths} onChange={(n) => set('retention', { ...draft.retention, auditMonths: n })} error={errors['retention.auditMonths']} disabled={!perms.manageRetention} />
            <NumberField label="Financial Records" unit="years" value={draft.retention.financialYears} onChange={(n) => set('retention', { ...draft.retention, financialYears: n })} error={errors['retention.financialYears']} disabled={!perms.manageRetention} />
            <NumberField label="Archived OFM Notes" unit="days" value={draft.retention.ofmArchivedNotesDays} onChange={(n) => set('retention', { ...draft.retention, ofmArchivedNotesDays: n })} error={errors['retention.ofmArchivedNotesDays']} disabled={!perms.manageRetention} />
            <NumberField label="Export Files" unit="days" value={draft.retention.exportDays} onChange={(n) => set('retention', { ...draft.retention, exportDays: n })} error={errors['retention.exportDays']} disabled={!perms.manageRetention} />
          </div>
        </Group>

        <Group title="Security" description="Sessions can be made stricter than 12 hours idle / 7 days absolute, never looser." changed={changed('security')} onRestore={perms.manageSecurity ? () => restore('security') : undefined} canEdit={perms.update}>
          {!perms.manageSecurity ? <p className="text-[12px] text-fg-2">Changing the security policy needs the access management permission.</p> : null}
          <Switch
            checked={draft.security.mfaRequiredForAll}
            onCheckedChange={(v) => set('security', { ...draft.security, mfaRequiredForAll: v })}
            label="Require two-factor for everyone"
            description="Members without it are asked to set it up at their next sign-in."
            disabled={!perms.manageSecurity}
          />
          <Field label="Also Require Two-Factor For Roles" helper="Owner, Admin and finance approvers always need two-factor.">
            <MultiSelect
              value={draft.security.mfaRequiredRoleKeys}
              onChange={(v) => set('security', { ...draft.security, mfaRequiredRoleKeys: v })}
              options={mfaRoleOptions.filter((o) => !view.roles.find((r) => r.key === o.value)?.alwaysRequiresMfa)}
              disabled={!perms.manageSecurity || draft.security.mfaRequiredForAll}
              searchable
            />
          </Field>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <NumberField
              label="Idle Timeout"
              unit="hours"
              value={draft.security.sessionIdleHours}
              onChange={(n) => set('security', { ...draft.security, sessionIdleHours: n })}
              error={errors['security.sessionIdleHours']}
              helper={`${SETTINGS_BOUNDS.sessionIdleHours.min}–${SETTINGS_BOUNDS.sessionIdleHours.max}`}
              disabled={!perms.manageSecurity}
            />
            <NumberField
              label="Maximum Session"
              unit="days"
              value={draft.security.sessionAbsoluteDays}
              onChange={(n) => set('security', { ...draft.security, sessionAbsoluteDays: n })}
              error={errors['security.sessionAbsoluteDays']}
              helper={`${SETTINGS_BOUNDS.sessionAbsoluteDays.min}–${SETTINGS_BOUNDS.sessionAbsoluteDays.max}`}
              disabled={!perms.manageSecurity}
            />
          </div>
        </Group>

        <Group title="Notification Defaults" description="Starting preferences for people who join; members can change their own." changed={changed('notifications')} onRestore={() => restore('notifications')} canEdit={perms.update}>
          {(
            [
              ['mentions', 'Mentions'],
              ['assignments', 'Assignments'],
              ['reviewRequests', 'Review requests'],
              ['dueReminders', 'Due date reminders'],
              ['emailImmediate', 'Email immediately'],
              ['dailyDigest', 'Daily digest email'],
            ] as const
          ).map(([k, l]) => (
            <Switch key={k} checked={draft.notifications[k]} onCheckedChange={(v) => set('notifications', { ...draft.notifications, [k]: v })} label={l} disabled={!perms.update} />
          ))}
          <div className="grid grid-cols-2 gap-4">
            <Field label="Quiet Hours Start" error={errors['notifications.quietHoursStart']}>
              <Input type="time" value={draft.notifications.quietHoursStart} onChange={(e) => set('notifications', { ...draft.notifications, quietHoursStart: e.target.value })} disabled={!perms.update} />
            </Field>
            <Field label="Quiet Hours End" error={errors['notifications.quietHoursEnd']}>
              <Input type="time" value={draft.notifications.quietHoursEnd} onChange={(e) => set('notifications', { ...draft.notifications, quietHoursEnd: e.target.value })} disabled={!perms.update} />
            </Field>
          </div>
        </Group>

        <Group title="Module Visibility" description="Hidden modules disappear from navigation; their data and permissions stay unchanged." changed={changed('modules')} onRestore={() => restore('modules')} canEdit={perms.update}>
          <div className="grid grid-cols-2 gap-2">
            {HIDEABLE_MODULES.map((m) => (
              <Checkbox
                key={m}
                label={label('module', m)}
                checked={!draft.modules.hidden.includes(m)}
                disabled={!perms.update}
                onCheckedChange={(visible) => set('modules', { hidden: HIDEABLE_MODULES.filter((x) => (x === m ? !visible : draft.modules.hidden.includes(x))) })}
              />
            ))}
          </div>
        </Group>

        <MailPanel view={view} />
      </div>

      {dirty ? (
        <div className="sticky bottom-0 z-10 -mx-4 flex flex-col gap-2 border-t border-line bg-surface px-4 py-3 md:-mx-7 md:flex-row md:items-center md:justify-between md:px-7">
          <p className="text-[13px] text-fg-2">
            Unsaved changes: {changedKeys.map((k) => (k === 'general' ? 'General' : humanize(k))).join(', ')}.
          </p>
          <div className="flex gap-2">
            <Button
              onClick={() => {
                setBase(view);
                setDraft(draftOf(view));
                setServerErrors({});
                setError(null);
              }}
            >
              Discard Changes
            </Button>
            <Button variant="primary" onClick={() => void review()} loading={preview.isPending} disabled={hasLocalErrors || !perms.update}>
              Review and Save
            </Button>
          </div>
        </div>
      ) : null}

      <Dialog
        open={!!impact}
        onOpenChange={(o) => !o && setImpact(null)}
        title="Save workspace settings?"
        description={impact?.requiresRecentAuth ? 'Security changes need you to confirm your password.' : undefined}
        footer={
          <>
            <Button onClick={() => setImpact(null)} disabled={update.isPending}>
              Keep Editing
            </Button>
            <Button variant="primary" onClick={() => void save()} loading={update.isPending} disabled={!!impact?.blocked.length}>
              Save Settings
            </Button>
          </>
        }
      >
        {impact ? (
          <div className="flex flex-col gap-3">
            {impact.blocked.map((b) => (
              <Banner key={b.field} tone="danger">
                {b.message}
              </Banner>
            ))}
            {impact.impacts.length ? (
              <ul className="flex flex-col gap-2">
                {impact.impacts.map((i, n) => (
                  <li key={n} className="flex items-start gap-2 text-[13px]">
                    {i.severity === 'warning' ? <Warning size={16} className="mt-0.5 shrink-0 text-warning" aria-hidden /> : <span aria-hidden className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-fg-2" />}
                    <span>
                      <span className="font-medium">{i.group === 'general' ? 'General' : humanize(i.group)}:</span> {i.message}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-fg-2">No side effects beyond the changed values.</p>
            )}
          </div>
        ) : null}
      </Dialog>
      <ConflictDialog
        open={conflict}
        onOpenChange={(o) => {
          setConflict(o);
          // Keep editing: re-apply the member's changes on top of the newer version, then review again.
          if (!o) void refetch().then((r) => r.data && rebase(r.data));
        }}
        onReload={() => {
          setConflict(false);
          void refetch().then((r) => {
            if (!r.data) return;
            setBase(r.data);
            setDraft(draftOf(r.data));
          });
        }}
      />
      {dialog}
    </div>
  );
};

/**
 * Mail: transport status, the saved SMTP server (Owner; the password is write-only — entered masked,
 * never returned) and Test Mail to Self.
 */
const MailPanel = ({ view }: { view: View }) => {
  const { workspace, user } = useWorkspace();
  const [messageId, setMessageId] = useState<string | null>(null);
  const send = useApiMutation(settingsEndpoints.testMail, { silentErrors: true });
  const [error, setError] = useState<string | null>(null);
  const status = useApiQuery(
    settingsEndpoints.mailTest,
    { params: { workspaceId: workspace.id, messageId: messageId ?? '' } },
    { enabled: !!messageId, refetchInterval: (q) => (!q.state.data || q.state.data.status === 'queued' ? 2000 : false) },
  );
  useEffect(() => setError(null), [messageId]);
  const last = status.data ?? (view.mail.lastTest ? { status: view.mail.lastTest.status, error: view.mail.lastTest.error, sentAt: view.mail.lastTest.at } : null);
  return (
    <Panel title="Mail" description="Outgoing mail for invitations, security alerts and notifications." bodyClassName="flex flex-col gap-4 p-4">
      <DescriptionList
        columns={2}
        items={[
          { label: 'Transport', value: view.mail.transport === 'smtp' ? 'SMTP' : 'Development sink (not delivered)' },
          { label: 'Status', value: view.mail.configured ? <Badge tone="success">Configured</Badge> : <Badge tone="warning">Not configured</Badge> },
          { label: 'Server', value: view.mail.source === 'settings' ? 'Saved in these settings' : view.mail.source === 'environment' ? 'Server environment (SMTP_* variables)' : 'None' },
          { label: 'From', value: view.mail.from },
          {
            label: 'Last Test',
            value: last ? (
              <span className="flex flex-col">
                <span>
                  {last.status === 'sent' ? 'Delivered to the mail server' : last.status === 'failed' ? 'Failed' : 'Queued'}
                  {last.sentAt ? ` · ${formatDateTime(last.sentAt, user.timezone)}` : ''}
                </span>
                {last.error ? <span className="text-[12px] text-danger">{last.error}</span> : null}
              </span>
            ) : null,
          },
        ]}
      />
      {view.mail.transport === 'dev_sink' ? (
        <p className="text-[12px] text-fg-2">This installation uses the development mail sink: nothing is delivered, even with a saved server.</p>
      ) : null}
      {view.mail.canEdit ? <MailServerForm view={view} /> : <p className="text-[12px] text-fg-2">Only the Owner can change the mail server. Its password is never shown.</p>}
      {error ? <Banner tone="danger">{error}</Banner> : null}
      {view.permissions.testMail ? (
        <div>
          <Button
            icon={<EnvelopeSimple size={14} />}
            loading={send.isPending || (!!messageId && status.data?.status === 'queued')}
            onClick={async () => {
              setError(null);
              try {
                const r = await send.run({ params: { workspaceId: workspace.id } });
                setMessageId(r.messageId);
              } catch (e) {
                setError(isApiError(e) ? e.message : 'The test message could not be queued.');
              }
            }}
          >
            Test Mail to Self
          </Button>
        </div>
      ) : null}
    </Panel>
  );
};

const blankServer = { host: '', port: '587', secure: false, username: '', password: '', clearPassword: false, from: '' };

/** SMTP server form (Owner, recent authentication). The saved password is never loaded into the page. */
const MailServerForm = ({ view }: { view: View }) => {
  const { workspace, user } = useWorkspace();
  const saved = view.mail.saved;
  const initial = () => (saved ? { host: saved.host, port: String(saved.port), secure: saved.secure, username: saved.username ?? '', password: '', clearPassword: false, from: saved.from } : blankServer);
  const [v, setV] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirmRemove, setConfirmRemove] = useState(false);
  useEffect(() => setV(initial()), [saved?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  const { guard, dialog } = useRecentAuth();
  const save = useApiMutation(settingsEndpoints.saveMailServer, { invalidate: ['settings.workspace'], successMessage: 'Mail server saved', silentErrors: true });
  const remove = useApiMutation(settingsEndpoints.removeMailServer, { invalidate: ['settings.workspace'], successMessage: 'Saved mail server removed', silentErrors: true });
  const set = (patch: Partial<typeof v>) => setV((x) => ({ ...x, ...patch }));
  const submit = async () => {
    const port = Number(v.port);
    const local: Record<string, string> = {};
    if (!v.host.trim()) local.host = 'Enter the SMTP host.';
    if (!Number.isInteger(port) || port < 1 || port > 65535) local.port = 'Use a port between 1 and 65535.';
    if (!v.from.trim()) local.from = 'Enter the sender address.';
    setErrors(local);
    if (Object.keys(local).length) return;
    try {
      await guard(() =>
        save.run({
          params: { workspaceId: workspace.id },
          body: { host: v.host.trim(), port, secure: v.secure, username: v.username.trim() || null, from: v.from.trim(), ...(v.password ? { password: v.password } : {}), ...(v.clearPassword ? { clearPassword: true } : {}) },
        }),
      );
      set({ password: '', clearPassword: false });
    } catch (e) {
      if (isApiError(e) && e.fieldErrors.length) setErrors(Object.fromEntries(e.fieldErrors.map((f) => [f.field, f.message])));
      else reportError(e);
    }
  };
  return (
    <form
      className="flex flex-col gap-4 rounded-[12px] border border-line p-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      aria-label="SMTP server"
    >
      <div className="flex flex-col gap-1">
        <h3 className="text-[14px] font-semibold text-fg">SMTP server</h3>
        <p className="text-[12px] text-fg-2">
          {saved ? `Saved ${formatDateTime(saved.updatedAt, user.timezone)}. It is used instead of the server environment.` : 'Optional: enter the server here instead of the SMTP_* variables of the deployment.'} The password is stored encrypted and is
          never shown again.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-[2fr_1fr]">
        <Field label="Host" required error={errors.host}>
          <Input value={v.host} onChange={(e) => set({ host: e.target.value })} placeholder="smtp.example.com" autoComplete="off" spellCheck={false} />
        </Field>
        <Field label="Port" required error={errors.port}>
          <Input value={v.port} onChange={(e) => set({ port: e.target.value })} inputMode="numeric" />
        </Field>
        <Field label="Username" error={errors.username}>
          <Input value={v.username} onChange={(e) => set({ username: e.target.value })} autoComplete="off" spellCheck={false} />
        </Field>
        <Field label="Password" error={errors.password} helper={saved?.secretSaved ? 'A password is saved. Leave empty to keep it.' : 'Write-only: it is never shown after saving.'}>
          <Input
            type="password"
            value={v.password}
            onChange={(e) => set({ password: e.target.value, clearPassword: false })}
            placeholder={saved?.secretSaved ? '•••••••• (saved)' : ''}
            autoComplete="new-password"
            disabled={v.clearPassword}
          />
        </Field>
        <Field label="From" required error={errors.from} helper="An address, or a name with an address.">
          <Input value={v.from} onChange={(e) => set({ from: e.target.value })} placeholder="Castlane <no-reply@example.com>" />
        </Field>
        <div className="flex flex-col justify-end gap-2 pb-1">
          <Checkbox checked={v.secure} onCheckedChange={(c) => set({ secure: c })} label="Use TLS from the start (port 465)" description="Otherwise STARTTLS is used when the server offers it." />
          {saved?.secretSaved ? <Checkbox checked={v.clearPassword} onCheckedChange={(c) => set({ clearPassword: c, password: '' })} label="Remove the saved password" /> : null}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" loading={save.isPending}>
          Save Mail Server
        </Button>
        {saved ? (
          <Button type="button" variant="danger-secondary" onClick={() => setConfirmRemove(true)}>
            Remove Saved Server
          </Button>
        ) : null}
      </div>
      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title="Remove the saved mail server?"
        body={view.mail.transport === 'smtp' ? 'Mail then uses the server environment (SMTP_* variables) if it is set; otherwise mail cannot be delivered until a server is saved again.' : 'The saved server and its password are deleted.'}
        confirmLabel="Remove"
        destructive
        onConfirm={async () => {
          try {
            await guard(() => remove.run({ params: { workspaceId: workspace.id } }));
            setConfirmRemove(false);
          } catch (e) {
            reportError(e);
          }
        }}
      />
      {dialog}
    </form>
  );
};
