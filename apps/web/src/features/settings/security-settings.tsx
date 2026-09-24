'use client';
import { useRouter } from 'next/navigation';
import { Desktop, ShieldCheck } from '@phosphor-icons/react';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { authEndpoints, settingsEndpoints, type ProfileView } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { Badge, Banner, Button, ConfirmDialog, Dialog, Field, Input, Panel, formatDateTime, formatRelative } from '@castlane/ui';
import { QueryState } from '@/components/common/query-state';
import { api, setCsrfToken } from '@/lib/api';
import { useApiMutation, useApiQuery } from '@/lib/hooks';
import { useWorkspace } from '@/lib/workspace-context';
import { reportError, useRecentAuth } from '@/features/team/recent-auth';

/** Short, readable device name from a user agent string. */
const deviceName = (ua: string | null) => {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : 'Unknown OS';
  return `${browser} on ${os}`;
};

const RecoveryCodes = ({ codes, onDone }: { codes: string[]; onDone: () => void }) => (
  <Dialog
    open
    onOpenChange={(o) => !o && onDone()}
    size="small"
    title="Save your recovery codes"
    description="Each code works once if you lose your authenticator. They are shown only now; earlier codes no longer work."
    footer={
      <>
        <Button onClick={() => void navigator.clipboard?.writeText(codes.join('\n'))}>Copy Codes</Button>
        <Button variant="primary" onClick={onDone}>
          I Saved the Codes
        </Button>
      </>
    }
  >
    <ul className="grid grid-cols-2 gap-2 rounded-[8px] bg-surface-2 p-3 font-mono text-[14px] text-fg">
      {codes.map((c) => (
        <li key={c}>{c}</li>
      ))}
    </ul>
  </Dialog>
);

export const SecurityTab = ({ p }: { p: ProfileView }) => (
  <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
    <PasswordPanel p={p} />
    <TwoFactorPanel p={p} />
    <div className="xl:col-span-2">
      <SessionsPanel />
    </div>
  </div>
);

const PasswordPanel = ({ p }: { p: ProfileView }) => {
  const { user } = useWorkspace();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const change = useApiMutation(authEndpoints.changePassword, { invalidate: ['settings.', 'auth.sessions'], successMessage: 'Password changed. Other sessions were signed out.', silentErrors: true });
  const mismatch = confirm.length > 0 && confirm !== next;
  return (
    <Panel title="Password" description={p.user.passwordChangedAt ? `Last changed ${formatDateTime(p.user.passwordChangedAt, user.timezone)}.` : undefined}>
      <form
        className="flex flex-col gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          try {
            await change.run({ body: { currentPassword: current, newPassword: next } });
            setCurrent('');
            setNext('');
            setConfirm('');
          } catch (err) {
            setError(isApiError(err) ? (err.fieldErrors[0]?.message ?? err.message) : 'The password could not be changed.');
          }
        }}
      >
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <Field label="Current Password" required>
          <Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </Field>
        <Field label="New Password" required helper="12–128 characters. Passphrases and password managers welcome.">
          <Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} minLength={12} maxLength={128} />
        </Field>
        <Field label="Confirm New Password" required error={mismatch ? 'The passwords do not match.' : null}>
          <Input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>
        <div>
          <Button type="submit" variant="primary" loading={change.isPending} disabled={!current || next.length < 12 || next !== confirm}>
            Change Password
          </Button>
        </div>
      </form>
    </Panel>
  );
};

const TwoFactorPanel = ({ p }: { p: ProfileView }) => {
  const router = useRouter();
  const { guard, dialog } = useRecentAuth();
  const [setup, setSetup] = useState<{ challengeId: string; secret: string; qrSvg: string } | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [pending, setPending] = useState<'start' | 'confirm' | 'regenerate' | 'disable' | null>(null);
  const refresh = async () => {
    // Enabling two-factor replaces the session: pick up the new session's CSRF token.
    try {
      const me = await api.call(authEndpoints.me, {});
      setCsrfToken(me.csrfToken);
    } catch {
      /* the next page load provides it */
    }
    router.refresh();
  };
  const qc = useQueryClient();
  return (
    <Panel
      title="Two-Factor Authentication"
      actions={p.user.mfaEnabled ? <Badge tone="success">On</Badge> : <Badge tone={p.user.mfaRequired ? 'warning' : 'neutral'}>Off</Badge>}
      bodyClassName="flex flex-col gap-4 p-4"
    >
      {error && !setup ? <Banner tone="danger">{error}</Banner> : null}
      {p.user.mfaEnabled ? (
        <>
          <p className="text-[13px] text-fg-2">
            Sign-ins and critical changes ask for a code from your authenticator app.{' '}
            {p.user.recoveryCodesRemaining !== null ? `${p.user.recoveryCodesRemaining} unused recovery code(s) left.` : ''}
          </p>
          {p.user.recoveryCodesRemaining !== null && p.user.recoveryCodesRemaining <= 3 ? <Banner tone="warning">You are running out of recovery codes. Generate new ones.</Banner> : null}
          <div className="flex flex-wrap gap-2">
            <Button
              loading={pending === 'regenerate'}
              onClick={async () => {
                setPending('regenerate');
                setError(null);
                try {
                  const r = await guard(() => api.call(authEndpoints.regenerateRecoveryCodes, {}));
                  setCodes(r.recoveryCodes);
                } catch (e) {
                  if (isApiError(e)) setError(e.message);
                  else reportError(e);
                } finally {
                  setPending(null);
                }
              }}
            >
              Regenerate Recovery Codes
            </Button>
            {p.user.mfaRequired ? null : (
              <Button variant="ghost" onClick={() => setConfirmDisable(true)}>
                Turn Off Two-Factor
              </Button>
            )}
          </div>
          {p.user.mfaRequired ? <p className="text-[12px] text-fg-2">Your role or a workspace policy requires two-factor authentication, so it cannot be turned off.</p> : null}
        </>
      ) : setup ? (
        <div className="flex flex-col gap-4">
          <p className="text-[13px] text-fg-2">Scan the QR code with an authenticator app, then enter the 6-digit code it shows.</p>
          <div className="flex flex-col items-start gap-3 md:flex-row">
            <div className="h-[192px] w-[192px] shrink-0 rounded-[8px] bg-white p-1" aria-label="QR code for your authenticator app" role="img" dangerouslySetInnerHTML={{ __html: setup.qrSvg }} />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <p className="text-[12px] font-[550] text-fg">Or enter this key manually</p>
              <code className="break-all rounded-[8px] bg-surface-2 px-2 py-1.5 font-mono text-[13px] text-fg">{setup.secret}</code>
              <div>
                <Button size="sm" onClick={() => void navigator.clipboard?.writeText(setup.secret)}>
                  Copy Key
                </Button>
              </div>
            </div>
          </div>
          <form
            className="flex flex-col gap-3"
            onSubmit={async (e) => {
              e.preventDefault();
              setPending('confirm');
              setError(null);
              try {
                const r = await api.call(authEndpoints.mfaSetupConfirm, { body: { challengeId: setup.challengeId, code: code.trim() } });
                setSetup(null);
                setCode('');
                setCodes(r.recoveryCodes);
                await refresh();
              } catch (err) {
                setError(isApiError(err) ? (err.fieldErrors[0]?.message ?? err.message) : 'The code could not be verified.');
              } finally {
                setPending(null);
              }
            }}
          >
            {error ? <Banner tone="danger">{error}</Banner> : null}
            <Field label="Verification Code" required>
              <Input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={6} className="max-w-[160px]" />
            </Field>
            <div className="flex gap-2">
              <Button onClick={() => setSetup(null)}>Cancel</Button>
              <Button type="submit" variant="primary" loading={pending === 'confirm'} disabled={code.trim().length !== 6}>
                Verify and Turn On
              </Button>
            </div>
          </form>
        </div>
      ) : (
        <>
          <p className="text-[13px] text-fg-2">
            {p.user.mfaRequired ? 'Your role or a workspace policy requires two-factor authentication.' : 'Protect your account with a code from an authenticator app.'}
          </p>
          <div>
            <Button
              variant="primary"
              icon={<ShieldCheck size={14} />}
              loading={pending === 'start'}
              onClick={async () => {
                setPending('start');
                setError(null);
                try {
                  const r = await guard(() => api.call(authEndpoints.mfaSetupStart, { body: {} }));
                  setSetup({ challengeId: r.challengeId, secret: r.secret, qrSvg: r.qrSvg });
                } catch (e) {
                  if (isApiError(e)) setError(e.message);
                  else reportError(e);
                } finally {
                  setPending(null);
                }
              }}
            >
              Set Up Two-Factor
            </Button>
          </div>
        </>
      )}
      {codes ? (
        <RecoveryCodes
          codes={codes}
          onDone={() => {
            setCodes(null);
            void qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0] ?? '').startsWith('settings.') });
            router.refresh();
          }}
        />
      ) : null}
      <ConfirmDialog
        open={confirmDisable}
        onOpenChange={setConfirmDisable}
        title="Turn off two-factor authentication?"
        body="Sign-ins will only need your password, and your recovery codes stop working."
        confirmLabel="Turn Off"
        destructive
        loading={pending === 'disable'}
        onConfirm={async () => {
          setPending('disable');
          try {
            await guard(() => api.call(settingsEndpoints.disableMfa, {}));
            setConfirmDisable(false);
            window.location.reload();
          } catch (e) {
            reportError(e);
          } finally {
            setPending(null);
          }
        }}
      />
      {dialog}
    </Panel>
  );
};

const SessionsPanel = () => {
  const { user } = useWorkspace();
  const q = useApiQuery(authEndpoints.sessions, {});
  const [revokeOthers, setRevokeOthers] = useState(false);
  const revoke = useApiMutation(authEndpoints.revokeSession, { invalidate: ['auth.sessions'], successMessage: 'Session signed out' });
  const others = useApiMutation(authEndpoints.revokeOtherSessions, { invalidate: ['auth.sessions'], successMessage: (r) => `${r.revoked} other session(s) signed out` });
  const otherCount = (q.data ?? []).filter((s) => !s.current).length;
  return (
    <Panel
      title="Active Sessions"
      description="Devices signed in to your account. Signing out takes effect on their next request."
      actions={
        otherCount ? (
          <Button size="sm" variant="danger" onClick={() => setRevokeOthers(true)}>
            Sign Out Other Sessions
          </Button>
        ) : undefined
      }
    >
      <QueryState query={q}>
        <ul className="flex flex-col divide-y divide-line">
          {(q.data ?? []).map((s) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="flex min-w-0 items-center gap-3">
                <Desktop size={20} className="shrink-0 text-fg-2" aria-hidden />
                <div className="flex min-w-0 flex-col">
                  <span className="flex items-center gap-2 text-[14px] font-medium text-fg">
                    {deviceName(s.userAgent)}
                    {s.current ? <Badge tone="primary">This device</Badge> : null}
                  </span>
                  <span className="text-[12px] text-fg-2">
                    Signed in {formatDateTime(s.createdAt, user.timezone)} · last active <time dateTime={s.lastSeenAt} title={formatDateTime(s.lastSeenAt, user.timezone)}>{formatRelative(s.lastSeenAt)}</time>
                  </span>
                </div>
              </div>
              {!s.current ? (
                <Button size="sm" variant="ghost" loading={revoke.isPending && revoke.variables?.input.params?.sessionId === s.id} onClick={() => void revoke.run({ params: { sessionId: s.id } }).catch(() => undefined)}>
                  Sign Out
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      </QueryState>
      <ConfirmDialog
        open={revokeOthers}
        onOpenChange={setRevokeOthers}
        title="Sign out other sessions?"
        body={`${otherCount} other session(s) will be signed out. This device stays signed in.`}
        confirmLabel="Sign Out Others"
        destructive
        loading={others.isPending}
        onConfirm={async () => {
          try {
            await others.run({});
            setRevokeOthers(false);
          } catch {
            /* toast shown */
          }
        }}
      />
    </Panel>
  );
};
