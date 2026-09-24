'use client';
import { useRouter } from 'next/navigation';
import { UploadSimple } from '@phosphor-icons/react';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { mediaEndpoints, settingsEndpoints, type NotificationPrefs, type ProfileView } from '@castlane/api-contracts';
import { isApiError, newIdempotencyKey } from '@castlane/api-client';
import {
  Avatar,
  Badge,
  Banner,
  Button,
  DescriptionList,
  Dialog,
  Field,
  Input,
  PageHeader,
  Panel,
  RadioGroup,
  Select,
  Switch,
  TabPanel,
  Tabs,
  formatDate,
  formatDateTime,
  humanize,
} from '@castlane/ui';
import { ConflictDialog } from '@/components/common/conflict';
import { QueryState } from '@/components/common/query-state';
import { api } from '@/lib/api';
import { useApiMutation, useApiQuery } from '@/lib/hooks';
import { useUnsavedChangesGuard } from '@/lib/unsaved';
import { useUrlState } from '@/lib/url-state';
import { useWorkspace, useWsPath } from '@/lib/workspace-context';
import { reportError, useRecentAuth } from '@/features/team/recent-auth';
import { SecurityTab } from './security-settings';
import { timeZoneList } from '@/lib/timezones';

const TABS = ['profile', 'notifications', 'security', 'data'] as const;
const WORKSPACE_TZ = '__workspace';
const AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

const zones = timeZoneList;

/** Apply the theme without a reload (same mechanism as the shell: data-theme + stored preference). */
export const applyTheme = (t: 'system' | 'light' | 'dark') => {
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem('castlane.theme', t);
  } catch {
    /* storage unavailable: the server preference still applies on the next page load */
  }
};

/** S68 Personal Settings / Security. */
export const ProfileSettingsScreen = () => {
  const { workspace } = useWorkspace();
  const wsPath = useWsPath();
  const { state, set } = useUrlState<'tab'>({ tab: 'profile' });
  const tab = (TABS as readonly string[]).includes(state.tab ?? '') ? state.tab! : 'profile';
  const q = useApiQuery(settingsEndpoints.me, { params: { workspaceId: workspace.id } });
  useEffect(() => {
    // Deep links such as /settings/profile#notifications.
    const h = window.location.hash.replace('#', '');
    if ((TABS as readonly string[]).includes(h)) set({ tab: h });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        crumbs={[{ label: 'Settings', href: wsPath('/settings') }, { label: 'Personal Settings' }]}
        title="Personal Settings"
        description="Your profile, preferences and account security. Roles are managed by your workspace administrators."
      />
      <QueryState query={q}>
        {q.data ? (
          <Tabs
            label="Personal settings sections"
            value={tab}
            onValueChange={(v) => set({ tab: v })}
            items={[
              { value: 'profile', label: 'Profile' },
              { value: 'notifications', label: 'Notifications' },
              { value: 'security', label: 'Security' },
              { value: 'data', label: 'Your Data' },
            ]}
          >
            <TabPanel value="profile">{tab === 'profile' ? <ProfileTab p={q.data} /> : null}</TabPanel>
            <TabPanel value="notifications">{tab === 'notifications' ? <NotificationsTab p={q.data} /> : null}</TabPanel>
            <TabPanel value="security">{tab === 'security' ? <SecurityTab p={q.data} /> : null}</TabPanel>
            <TabPanel value="data">{tab === 'data' ? <DataTab /> : null}</TabPanel>
          </Tabs>
        ) : null}
      </QueryState>
    </div>
  );
};

const ProfileTab = ({ p }: { p: ProfileView }) => {
  const { workspace } = useWorkspace();
  const qc = useQueryClient();
  const router = useRouter();
  const [displayName, setDisplayName] = useState(p.user.displayName);
  const [timezone, setTimezone] = useState(p.preferences.timezone ?? WORKSPACE_TZ);
  const [theme, setTheme] = useState(p.preferences.theme);
  const [density, setDensity] = useState(p.preferences.density);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [conflict, setConflict] = useState(false);
  const zoneOptions = useMemo(() => [{ value: WORKSPACE_TZ, label: `Workspace default (${workspace.timezone})` }, ...zones().map((z) => ({ value: z, label: z }))], [workspace.timezone]);
  const reset = () => {
    setDisplayName(p.user.displayName);
    setTimezone(p.preferences.timezone ?? WORKSPACE_TZ);
    setTheme(p.preferences.theme);
    setDensity(p.preferences.density);
    setErrors({});
  };
  const tz = timezone === WORKSPACE_TZ ? null : timezone;
  const dirty = displayName.trim() !== p.user.displayName || tz !== p.preferences.timezone || theme !== p.preferences.theme || density !== p.preferences.density;
  useUnsavedChangesGuard(dirty);
  const update = useApiMutation(settingsEndpoints.updateMe, { invalidate: ['settings.', 'team.'], successMessage: 'Profile saved', silentErrors: true });
  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Panel title="Profile" bodyClassName="flex flex-col gap-4 p-4">
        <AvatarEditor p={p} />
        <Field label="Display Name" required error={errors.displayName}>
          <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={80} autoComplete="name" />
        </Field>
        <Field label="Time Zone" helper="Dates and deadlines are shown in this time zone." error={errors.timezone}>
          <Select value={timezone} onChange={(v) => setTimezone(v ?? WORKSPACE_TZ)} options={zoneOptions} searchable />
        </Field>
      </Panel>
      <Panel title="Appearance" bodyClassName="flex flex-col gap-5 p-4">
        <RadioGroup
          label="Theme"
          orientation="horizontal"
          value={theme}
          onValueChange={setTheme}
          options={[
            { value: 'system', label: 'System' },
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ]}
        />
        <RadioGroup
          label="Density"
          orientation="horizontal"
          value={density}
          onValueChange={setDensity}
          options={[
            { value: 'comfortable', label: 'Comfortable' },
            { value: 'compact', label: 'Compact', description: 'Tighter tables and lists.' },
          ]}
        />
        <EmailPanel p={p} />
      </Panel>
      <div className="flex justify-end gap-2 xl:col-span-2">
        <Button onClick={reset} disabled={!dirty || update.isPending}>
          Discard Changes
        </Button>
        <Button
          variant="primary"
          disabled={!dirty || displayName.trim().length < 2}
          loading={update.isPending}
          onClick={async () => {
            setErrors({});
            try {
              await update.run(
                {
                  params: { workspaceId: workspace.id },
                  body: {
                    ...(displayName.trim() !== p.user.displayName ? { displayName: displayName.trim() } : {}),
                    ...(tz !== p.preferences.timezone ? { timezone: tz } : {}),
                    ...(theme !== p.preferences.theme ? { theme } : {}),
                    ...(density !== p.preferences.density ? { density } : {}),
                  },
                },
                { ifMatch: p.rowVersion },
              );
              if (theme !== p.preferences.theme) applyTheme(theme);
              // Shell (name, density, time zone) is rendered from the session on the server.
              router.refresh();
            } catch (e) {
              if (isApiError(e) && e.code === 'VERSION_CONFLICT') setConflict(true);
              else if (isApiError(e) && e.fieldErrors.length) setErrors(Object.fromEntries(e.fieldErrors.map((f) => [f.field.replace(/^body\./, ''), f.message])));
              else reportError(e);
            }
          }}
        >
          Save Changes
        </Button>
      </div>
      <ConflictDialog
        open={conflict}
        onOpenChange={(o) => {
          setConflict(o);
          // Keep editing: load the newer version; only fields you changed are sent again.
          if (!o) void qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0] ?? '') === 'settings.me' });
        }}
        onReload={() => window.location.reload()}
      />
    </div>
  );
};

/** Avatar through the checked media pipeline: reserve → upload parts → complete → wait for checks → use. */
const AvatarEditor = ({ p }: { p: ProfileView }) => {
  const { workspace } = useWorkspace();
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<{ phase: 'idle' | 'uploading' | 'checking' | 'saving'; error?: string }>({ phase: 'idle' });
  const update = useApiMutation(settingsEndpoints.updateMe, { invalidate: ['settings.', 'team.'], silentErrors: true });
  const params = { workspaceId: workspace.id };

  const upload = async (file: File) => {
    if (!(AVATAR_TYPES as readonly string[]).includes(file.type)) return setState({ phase: 'idle', error: 'Use a JPG, PNG or WebP image.' });
    if (file.size > 10 * 1024 * 1024) return setState({ phase: 'idle', error: 'The image must be 10 MB or smaller.' });
    try {
      setState({ phase: 'uploading' });
      const init = await api.call(
        settingsEndpoints.avatarUpload,
        { params, body: { filename: file.name, mimeType: file.type as (typeof AVATAR_TYPES)[number], byteSize: file.size } },
        { idempotencyKey: newIdempotencyKey() },
      );
      const parts: { partNumber: number; etag: string }[] = [];
      for (const part of init.parts) {
        const blob = file.slice((part.partNumber - 1) * init.partSize, part.partNumber * init.partSize);
        const res = await fetch(part.url, { method: 'PUT', body: blob, headers: part.headers, credentials: 'same-origin' });
        if (!res.ok) throw new Error(`The upload failed (${res.status}). Try again.`);
        parts.push({ partNumber: part.partNumber, etag: res.headers.get('etag') ?? '' });
      }
      await api.call(mediaEndpoints.completeUpload, { params: { ...params, uploadId: init.uploadId }, body: { parts } }, { idempotencyKey: init.uploadId });
      setState({ phase: 'checking' });
      for (let i = 0; i < 90; i++) {
        await new Promise((r) => setTimeout(r, i < 10 ? 1000 : 2000));
        const s = await api.call(settingsEndpoints.avatarStatus, { params: { ...params, assetId: init.assetId } });
        if (s.status === 'available') {
          setState({ phase: 'saving' });
          const fresh = await api.call(settingsEndpoints.me, { params });
          await update.run({ params, body: { avatarAssetId: init.assetId } }, { ifMatch: fresh.rowVersion });
          setState({ phase: 'idle' });
          router.refresh();
          return;
        }
        if (s.status === 'rejected' || s.status === 'failed') return setState({ phase: 'idle', error: s.rejectionReason ?? 'The image was rejected.' });
      }
      setState({ phase: 'idle', error: 'The image is still being checked. Try again in a minute.' });
    } catch (e) {
      setState({ phase: 'idle', error: isApiError(e) ? e.message : (e as Error).message });
    }
  };

  const busy = state.phase !== 'idle';
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-4">
        <Avatar name={p.user.displayName} src={p.user.avatarUrl ? `${p.user.avatarUrl}?size=128` : null} size={80} />
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <Button size="sm" icon={<UploadSimple size={14} />} loading={busy} onClick={() => input.current?.click()}>
              {p.user.avatarUrl ? 'Replace Avatar' : 'Upload Avatar'}
            </Button>
            {p.user.avatarUrl ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={async () => {
                  try {
                    await update.run({ params, body: { avatarAssetId: null } }, { ifMatch: p.rowVersion });
                    router.refresh();
                  } catch (e) {
                    reportError(e);
                  }
                }}
              >
                Remove
              </Button>
            ) : null}
          </div>
          <p className="text-[12px] text-fg-2" aria-live="polite">
            {state.phase === 'uploading' ? 'Uploading…' : state.phase === 'checking' ? 'Checking the image…' : state.phase === 'saving' ? 'Saving…' : 'JPG, PNG or WebP, up to 10 MB.'}
          </p>
        </div>
      </div>
      {state.error ? <p className="text-[12px] text-danger">{state.error}</p> : null}
      <input
        ref={input}
        type="file"
        accept={AVATAR_TYPES.join(',')}
        className="sr-only"
        aria-label="Choose an avatar image"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void upload(f);
        }}
      />
    </div>
  );
};

/** E-mail change: recent authentication, then a confirmation link to the new address (60 minutes). */
const EmailPanel = ({ p }: { p: ProfileView }) => {
  const { workspace, user } = useWorkspace();
  const { guard, dialog } = useRecentAuth();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const change = useApiMutation(settingsEndpoints.emailChange, { invalidate: ['settings.'], silentErrors: true });
  const cancel = useApiMutation(settingsEndpoints.cancelEmailChange, { invalidate: ['settings.'], successMessage: 'E-mail change cancelled' });
  return (
    <div className="flex flex-col gap-2 border-t border-line pt-4">
      <span className="text-[13px] font-medium text-fg">E-mail</span>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[14px] text-fg">{p.user.email}</span>
        <Button size="sm" onClick={() => setOpen(true)}>
          Change E-mail
        </Button>
      </div>
      {p.pendingEmailChange ? (
        <Banner
          tone="info"
          action={
            <Button size="sm" variant="ghost" loading={cancel.isPending} onClick={() => void cancel.run({ params: { workspaceId: workspace.id } }).catch(() => undefined)}>
              Cancel Change
            </Button>
          }
        >
          Waiting for confirmation from {p.pendingEmailChange.newEmail} (link valid until {formatDateTime(p.pendingEmailChange.expiresAt, user.timezone)}). Until then you sign in with your current address.
        </Banner>
      ) : null}
      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) {
            setEmail('');
            setError(null);
          }
        }}
        size="small"
        title="Change e-mail"
        description="We send a confirmation link to the new address. Your current address is notified too."
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              loading={change.isPending}
              disabled={!/^\S+@\S+\.\S+$/.test(email.trim())}
              onClick={async () => {
                setError(null);
                try {
                  await guard(() => change.run({ params: { workspaceId: workspace.id }, body: { newEmail: email.trim() } }));
                  setOpen(false);
                  setEmail('');
                } catch (e) {
                  if (isApiError(e)) setError(e.fieldErrors[0]?.message ?? e.message);
                  else reportError(e);
                }
              }}
            >
              Send Confirmation
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {error ? <Banner tone="danger">{error}</Banner> : null}
          <Field label="New E-mail" required>
            <Input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={254} />
          </Field>
        </div>
      </Dialog>
      {dialog}
    </div>
  );
};

const NOTIFICATION_ROWS: { key: keyof NotificationPrefs; label: string; description: string }[] = [
  { key: 'mentions', label: 'Mentions', description: 'Someone mentions you in a comment.' },
  { key: 'assignments', label: 'Assignments', description: 'A task, review or duty is assigned to you.' },
  { key: 'reviewRequests', label: 'Review requests', description: 'Content waits for your review.' },
  { key: 'dueReminders', label: 'Due date reminders', description: 'Your work is due soon or overdue.' },
  { key: 'emailImmediate', label: 'Email immediately', description: 'Also send important notifications by e-mail right away.' },
  { key: 'dailyDigest', label: 'Daily digest', description: 'One e-mail a day with what is waiting for you.' },
];

const NotificationsTab = ({ p }: { p: ProfileView }) => {
  const { workspace } = useWorkspace();
  const qc = useQueryClient();
  const [prefs, setPrefs] = useState<NotificationPrefs>(p.preferences.notifications);
  const [start, setStart] = useState(p.preferences.quietHoursStart);
  const [end, setEnd] = useState(p.preferences.quietHoursEnd);
  const [conflict, setConflict] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const dirty = JSON.stringify(prefs) !== JSON.stringify(p.preferences.notifications) || start !== p.preferences.quietHoursStart || end !== p.preferences.quietHoursEnd;
  useUnsavedChangesGuard(dirty);
  const update = useApiMutation(settingsEndpoints.updateMe, { invalidate: ['settings.'], successMessage: 'Notification preferences saved', silentErrors: true });
  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Panel title="What to notify you about" description="Security alerts (sign-ins, access changes) are always sent." bodyClassName="flex flex-col gap-4 p-4">
        {NOTIFICATION_ROWS.map((r) => (
          <Switch key={r.key} checked={prefs[r.key]} onCheckedChange={(v) => setPrefs({ ...prefs, [r.key]: v })} label={r.label} description={r.description} />
        ))}
      </Panel>
      <Panel title="Quiet Hours" description="No e-mail or push during these hours (your time zone). Items stay in your Inbox." bodyClassName="grid grid-cols-2 gap-4 p-4">
        <Field label="From" error={errors.quietHoursStart}>
          <Input type="time" value={start} onChange={(e) => setStart(e.target.value)} />
        </Field>
        <Field label="Until" error={errors.quietHoursEnd}>
          <Input type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
        </Field>
      </Panel>
      <div className="flex justify-end gap-2 xl:col-span-2">
        <Button
          disabled={!dirty}
          onClick={() => {
            setPrefs(p.preferences.notifications);
            setStart(p.preferences.quietHoursStart);
            setEnd(p.preferences.quietHoursEnd);
          }}
        >
          Discard Changes
        </Button>
        <Button
          variant="primary"
          disabled={!dirty}
          loading={update.isPending}
          onClick={async () => {
            setErrors({});
            try {
              await update.run({ params: { workspaceId: workspace.id }, body: { notifications: prefs, quietHoursStart: start, quietHoursEnd: end } }, { ifMatch: p.rowVersion });
            } catch (e) {
              if (isApiError(e) && e.code === 'VERSION_CONFLICT') setConflict(true);
              else if (isApiError(e) && e.fieldErrors.length) setErrors(Object.fromEntries(e.fieldErrors.map((f) => [f.field.replace(/^body\./, ''), f.message])));
              else reportError(e);
            }
          }}
        >
          Save Preferences
        </Button>
      </div>
      <ConflictDialog
        open={conflict}
        onOpenChange={(o) => {
          setConflict(o);
          // Keep editing: load the newer version; only fields you changed are sent again.
          if (!o) void qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0] ?? '') === 'settings.me' });
        }}
        onReload={() => window.location.reload()}
      />
    </div>
  );
};

const DataTab = () => {
  const { workspace, user } = useWorkspace();
  const q = useApiQuery(settingsEndpoints.personalData, { params: { workspaceId: workspace.id } });
  const d = q.data;
  return (
    <QueryState query={q}>
      {d ? (
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
          <Panel title="Account">
            <DescriptionList
              columns={2}
              items={[
                { label: 'E-mail', value: d.account.email },
                { label: 'Display Name', value: d.account.displayName },
                { label: 'Created', value: formatDate(d.account.createdAt, user.timezone) },
                { label: 'Password Changed', value: d.account.passwordChangedAt ? formatDateTime(d.account.passwordChangedAt, user.timezone) : 'Never' },
                { label: 'Two-Factor Since', value: d.account.mfaEnabledAt ? formatDateTime(d.account.mfaEnabledAt, user.timezone) : 'Not enabled' },
                { label: 'Avatar Stored', value: d.account.avatarStored ? 'Yes' : 'No' },
                { label: 'Active Sessions', value: d.sessions.active },
                { label: 'Notifications', value: `${d.notifications.total} (${d.notifications.unread} unread)` },
              ]}
            />
          </Panel>
          <Panel title="Workspace Memberships">
            <ul className="flex flex-col divide-y divide-line">
              {d.memberships.map((m, i) => (
                <li key={i} className="flex flex-col gap-0.5 py-2">
                  <span className="flex items-center gap-2 text-[14px] font-medium text-fg">
                    {m.workspaceName} <Badge>{humanize(m.status)}</Badge>
                  </span>
                  <span className="text-[12px] text-fg-2">
                    Joined {formatDate(m.joinedAt, user.timezone)}
                    {m.title ? ` · ${m.title}` : ''}
                    {m.roles.length ? ` · ${m.roles.join(', ')}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </Panel>
          <Panel title="Preferences">
            <DescriptionList columns={2} items={Object.entries(d.preferences).map(([k, v]) => ({ label: humanize(k), value: typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? '—') }))} />
          </Panel>
          <Panel title="Recent Security Events">
            {d.securityEvents.length ? (
              <ul className="flex flex-col divide-y divide-line">
                {d.securityEvents.map((e, i) => (
                  <li key={i} className="flex items-center justify-between gap-2 py-2 text-[13px]">
                    <span>{humanize(e.action.replace(/\./g, '_'))}</span>
                    <time dateTime={e.occurredAt} className="text-fg-2">
                      {formatDateTime(e.occurredAt, user.timezone)}
                    </time>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-fg-2">No security events recorded.</p>
            )}
          </Panel>
        </div>
      ) : null}
    </QueryState>
  );
};
