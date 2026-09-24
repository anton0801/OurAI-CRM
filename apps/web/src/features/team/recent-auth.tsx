'use client';
import { useCallback, useRef, useState, type ReactNode } from 'react';
import { authEndpoints, settingsEndpoints } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { Banner, Button, Dialog, Field, Input, toast } from '@castlane/ui';
import { api } from '@/lib/api';
import { useApiQuery } from '@/lib/hooks';
import { useWorkspace } from '@/lib/workspace-context';

export class RecentAuthCancelled extends Error {
  constructor() {
    super('Confirmation cancelled.');
  }
}

export const isCancelled = (e: unknown) => e instanceof RecentAuthCancelled;

/** Standard error report for guarded actions (cancellations and field errors stay quiet). */
export const reportError = (e: unknown, fallback = 'The change could not be saved.') => {
  if (isCancelled(e)) return;
  if (isApiError(e)) {
    if (e.network) toast.error('You are offline', 'Changes are not being saved. Retry when the connection is back.');
    else if (e.code === 'VERSION_CONFLICT') toast.error('This record changed while you had it open.', 'The latest version has been loaded. Review it and try again.');
    else toast.error(e.message);
    return;
  }
  toast.error(fallback);
};

/**
 * Permission, security and ownership changes need a password (and TOTP, when enabled) confirmed
 * within 15 minutes (§23.1). `guard(fn)` runs the action; on RECENT_AUTH_REQUIRED it asks the member
 * to confirm and retries once.
 */
export const useRecentAuth = (): { guard: <T>(fn: () => Promise<T>) => Promise<T>; dialog: ReactNode } => {
  const { workspace } = useWorkspace();
  const waiter = useRef<{ resolve: () => void; reject: (e: unknown) => void } | null>(null);
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const me = useApiQuery(settingsEndpoints.me, { params: { workspaceId: workspace.id } }, { enabled: open, staleTime: 60_000 });
  const mfa = me.data?.user.mfaEnabled ?? false;

  const guard = useCallback(async <T,>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (!isApiError(e) || e.code !== 'RECENT_AUTH_REQUIRED') throw e;
      await new Promise<void>((resolve, reject) => {
        waiter.current = { resolve, reject };
        setError(null);
        setOpen(true);
      });
      return fn();
    }
  }, []);

  const close = (confirmed: boolean) => {
    setOpen(false);
    setPassword('');
    setCode('');
    const w = waiter.current;
    waiter.current = null;
    if (confirmed) w?.resolve();
    else w?.reject(new RecentAuthCancelled());
  };

  const dialog = (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close(false)}
      size="small"
      title="Confirm it’s you"
      description="Access, security and ownership changes need a recent confirmation (valid for 15 minutes)."
      footer={
        <>
          <Button onClick={() => close(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="recent-auth-form"
            loading={pending}
            disabled={!password || (mfa && code.trim().length !== 6)}
          >
            Confirm
          </Button>
        </>
      }
    >
      <form
        id="recent-auth-form"
        className="flex flex-col gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setPending(true);
          setError(null);
          try {
            await api.call(authEndpoints.reauthenticate, { body: { password, code: mfa ? code.trim() : undefined } });
            close(true);
          } catch (err) {
            setError(isApiError(err) ? (err.fieldErrors[0]?.message ?? err.message) : 'Could not confirm. Try again.');
          } finally {
            setPending(false);
          }
        }}
      >
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <Field label="Password" required>
          <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
        </Field>
        {mfa ? (
          <Field label="Verification Code" required helper="The 6-digit code from your authenticator app.">
            <Input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} />
          </Field>
        ) : null}
      </form>
    </Dialog>
  );
  return { guard, dialog };
};
